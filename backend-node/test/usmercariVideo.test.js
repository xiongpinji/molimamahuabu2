const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const {
  USMERCARI_MODELS,
  USMERCARI_VIDEO_DURATIONS,
  normalizeUsmercariBaseUrl,
  resolveUsmercariApiKey,
  validateUsmercariVideoOptions,
  buildUsmercariVideoBody,
  mediaUploadPayload,
  uploadUsmercariMedia,
  buildUsmercariFetchUrl,
  parseUsmercariFetchPayload,
  callUsmercariVideoApi,
} = require('../src/services/usmercariVideoClient');
const { callVideoApi, pollVideoTask } = require('../src/services/videoClient');
const { hasConnectionCredential, testConnection, toPublicConfig } = require('../src/services/aiConfigService');

const log = { info() {}, warn() {}, error() {} };
const originalFetch = global.fetch;
const originalApiKey = process.env.USMERCARI_API_KEY;

afterEach(() => {
  global.fetch = originalFetch;
  if (originalApiKey == null) delete process.env.USMERCARI_API_KEY;
  else process.env.USMERCARI_API_KEY = originalApiKey;
});

describe('USMercari async video protocol', () => {
  it('contains all three models that passed real generation verification', () => {
    assert.deepEqual(Object.keys(USMERCARI_MODELS), [
      'MiniMax H3',
      'seedance-2.0-fast',
      'seedance-2.0-mini',
    ]);
  });

  it('exposes the supplier-confirmed per-model media limits', () => {
    assert.deepEqual(USMERCARI_VIDEO_DURATIONS, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    assert.deepEqual(USMERCARI_MODELS['MiniMax H3'], {
      maxImages: 5, maxVideos: 0, maxAudio: 3, resolutions: ['480p'],
    });
    assert.deepEqual(USMERCARI_MODELS['seedance-2.0-fast'], {
      maxImages: 9, maxVideos: 3, maxAudio: 3, resolutions: ['480p', '720p'],
    });
    assert.deepEqual(USMERCARI_MODELS['seedance-2.0-mini'], {
      maxImages: 9, maxVideos: 3, maxAudio: 3, resolutions: ['480p', '720p'],
    });
  });

  it('normalizes the API base and resolves the server-side key', () => {
    assert.equal(normalizeUsmercariBaseUrl('https://ai.usmercari.com/v1/'), 'https://ai.usmercari.com');
    assert.equal(
      normalizeUsmercariBaseUrl('https://ai.usmercari.com/cpa-file/submit/video'),
      'https://ai.usmercari.com',
    );
    process.env.USMERCARI_API_KEY = 'env-secret';
    assert.equal(resolveUsmercariApiKey({ api_key: 'db-secret' }), 'env-secret');
    assert.equal(hasConnectionCredential({ provider: 'usmercari' }), true);
    assert.equal(toPublicConfig({ provider: 'usmercari', api_key: '' }).has_api_key, true);
  });

  it('places duration at the official top level and reference fields inside metadata', () => {
    assert.deepEqual(buildUsmercariVideoBody({
      model: 'MiniMax H3',
      prompt: '电影感森林晨雾',
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '480p',
      image_url: 'https://cdn.example/first.png',
    }), {
      model: 'MiniMax H3',
      prompt: '电影感森林晨雾',
      duration: 5,
      metadata: {
        aspect_ratio: '16:9',
        resolution: '480p',
        image_url: 'https://cdn.example/first.png',
      },
    });
    assert.throws(() => buildUsmercariVideoBody({ model: 'unknown', prompt: 'x' }), /未经真实生成验证/);
    for (const model of Object.keys(USMERCARI_MODELS)) {
      for (const duration of [4, 15]) {
        assert.equal(buildUsmercariVideoBody({ model, prompt: 'x', duration }).duration, duration);
      }
      for (const duration of [3, 16]) {
        assert.throws(
          () => buildUsmercariVideoBody({ model, prompt: 'x', duration }),
          /4 到 15 秒/,
        );
      }
    }
    assert.equal(buildUsmercariVideoBody({
      model: 'seedance-2.0-fast', prompt: 'x', duration: 5, resolution: '720p',
    }).metadata.resolution, '720p');
    assert.equal(buildUsmercariVideoBody({
      model: 'seedance-2.0-mini', prompt: 'x', duration: 5, resolution: '720p',
    }).metadata.resolution, '720p');
    assert.throws(() => buildUsmercariVideoBody({
      model: 'seedance-2.0-fast', prompt: 'x', duration: 5, resolution: '1080p',
    }), /不支持 1080p/);
    assert.throws(() => buildUsmercariVideoBody({
      model: 'seedance-2.0-mini', prompt: 'x', duration: 5, resolution: '1080p',
    }), /不支持 1080p/);
    assert.deepEqual(buildUsmercariVideoBody({
      model: 'seedance-2.0-fast', prompt: 'x', image_id: 'img-1', end_image_id: 'img-2',
      video_reference_id: 'video-1', audio_reference_id: 'audio-1',
    }).metadata, {
      aspect_ratio: '16:9', resolution: '480p', image_id: 'img-1', end_image_id: 'img-2',
      video_reference_id: 'video-1', audio_reference_id: 'audio-1',
    });
    assert.throws(() => buildUsmercariVideoBody({
      model: 'MiniMax H3', prompt: 'x', video_reference_id: 'video-1',
    }), /不支持参考视频/);
  });

  it('validates material constraints before any paid generation submit', () => {
    assert.throws(() => validateUsmercariVideoOptions({
      model: 'MiniMax H3', first_frame_url: 'first', last_frame_url: 'last', reference_urls: ['ref'],
    }), /首尾帧模式与多参考图模式互斥/);
    assert.throws(() => validateUsmercariVideoOptions({
      model: 'MiniMax H3', image_id: 'first-id', end_image_id: 'last-id', image_ids: ['ref-id'],
    }), /首尾帧模式与多参考图模式互斥/);
    assert.throws(() => validateUsmercariVideoOptions({
      model: 'MiniMax H3', reference_video_urls: ['video'], reference_urls: ['ref'],
    }), /不支持参考视频/);
    assert.doesNotThrow(() => validateUsmercariVideoOptions({
      model: 'MiniMax H3', reference_audio_urls: ['audio-1', 'audio-2', 'audio-3'], reference_urls: ['ref'],
    }));
    assert.throws(() => validateUsmercariVideoOptions({
      model: 'seedance-2.0-fast', first_frame_url: 'first', last_frame_url: 'last',
      reference_urls: Array.from({ length: 8 }, (_, index) => `ref-${index}`),
    }), /首尾帧模式与多参考图模式互斥/);
    assert.throws(() => validateUsmercariVideoOptions({
      model: 'seedance-2.0-fast', first_frame_url: 'first',
      reference_video_urls: ['v1', 'v2', 'v3', 'v4'],
    }), /最多支持 3 个参考视频/);
    assert.throws(() => validateUsmercariVideoOptions({
      model: 'seedance-2.0-fast', first_frame_url: 'first',
      reference_audio_urls: ['a1', 'a2', 'a3', 'a4'],
    }), /最多支持 3 个参考音频/);
    for (const model of Object.keys(USMERCARI_MODELS)) {
      const options = {
        model, first_frame_url: 'image', last_frame_url: 'last',
        reference_audio_urls: ['audio'],
      };
      if (model !== 'MiniMax H3') options.reference_video_urls = ['video'];
      assert.doesNotThrow(() => validateUsmercariVideoOptions(options), `${model} 应支持已确认的多媒体参考`);
    }
  });

  it('converts data URI media into the documented upload payload without network access', async () => {
    assert.deepEqual(await mediaUploadPayload('audio', 'data:audio/mpeg;base64,YXVkaW8='), {
      data: 'data:audio/mpeg;base64,YXVkaW8=',
      extension: 'mp3',
    });
  });

  it('compresses an oversized reference image below the supplier upload limit', async () => {
    const oversized = await sharp({
      create: {
        width: 4096,
        height: 2304,
        channels: 3,
        background: { r: 72, g: 108, b: 144 },
      },
    }).tiff({ compression: 'none' }).toBuffer();
    assert.ok(oversized.length > 25 * 1024 * 1024);

    const payload = await mediaUploadPayload(
      'image',
      `data:image/tiff;base64,${oversized.toString('base64')}`,
    );
    const compressed = Buffer.from(payload.data.split(',')[1], 'base64');

    assert.equal(payload.extension, 'jpg');
    assert.match(payload.data, /^data:image\/jpeg;base64,/);
    assert.ok(compressed.length <= 25 * 1024 * 1024);
    assert.deepEqual(await sharp(compressed).metadata().then(({ width, height, format }) => ({ width, height, format })), {
      width: 4096,
      height: 2304,
      format: 'jpeg',
    });
  });

  it('retries one transient gateway failure for the free media upload only', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 502,
          text: async () => '<!DOCTYPE html><html><body>Bad gateway</body></html>',
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'media-after-retry' }),
      };
    };

    const id = await uploadUsmercariMedia(
      { api_key: 'secret' },
      'image',
      'data:image/png;base64,aW1hZ2U=',
    );

    assert.equal(id, 'media-after-retry');
    assert.equal(calls, 2);
  });

  it('keeps a persistent gateway HTML page out of the user-facing error', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return {
        ok: false,
        status: 502,
        text: async () => '<!DOCTYPE html><html><body>Bad gateway</body></html>',
      };
    };

    await assert.rejects(
      uploadUsmercariMedia(
        { api_key: 'secret' },
        'image',
        'data:image/png;base64,aW1hZ2U=',
      ),
      (error) => {
        assert.match(error.message, /已重试 1 次.*中转站媒体上传网关暂时不可用/);
        assert.doesNotMatch(error.message, /DOCTYPE|<html/);
        return true;
      },
    );
    assert.equal(calls, 2);
  });

  it('submits once with bearer auth and never retries an interrupted submit', async () => {
    let request;
    let calls = 0;
    global.fetch = async (url, options) => {
      calls += 1;
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'queued', task_id: 'task-usm-1' }),
      };
    };
    const submitted = await callUsmercariVideoApi({
      base_url: 'https://ai.usmercari.com/v1',
      api_key: 'secret',
    }, log, {
      model: 'seedance-2.0-fast',
      prompt: 'test',
      duration: 4,
      aspect_ratio: '16:9',
      resolution: '480p',
    });

    assert.equal(calls, 1);
    assert.equal(request.url, 'https://ai.usmercari.com/cpa-file/submit/video');
    assert.equal(request.options.headers.Authorization, 'Bearer secret');
    assert.equal(request.body.duration, 4);
    assert.deepEqual(submitted, { task_id: 'task-usm-1', status: 'queued' });

    global.fetch = async () => { throw new Error('socket closed'); };
    const interrupted = await callUsmercariVideoApi({ api_key: 'secret' }, log, {
      model: 'seedance-2.0-mini', prompt: 'test', duration: 5,
    });
    assert.equal(interrupted.indeterminate, true);
    assert.match(interrupted.error, /不得自动重试/);
  });

  it('parses processing, failure and relative success results', () => {
    assert.equal(buildUsmercariFetchUrl('https://ai.usmercari.com/v1/'), 'https://ai.usmercari.com/cpa-file/fetch');
    assert.deepEqual(parseUsmercariFetchPayload({ data: [{ task_id: 't1', status: 'IN_PROGRESS' }] }, 't1'), {
      state: 'processing', progress: null,
    });
    assert.deepEqual(parseUsmercariFetchPayload({ data: [{ task_id: 't1', status: 'FAILURE', fail_reason: 'blocked' }] }, 't1'), {
      state: 'failed', error: 'blocked',
    });
    assert.deepEqual(parseUsmercariFetchPayload({
      data: [{
        task_id: 't1',
        status: 'SUCCESS',
        progress: '100%',
        data: { items: [{ data: [{ url: '/leo-files/result.mp4' }] }] },
      }],
    }, 't1', 'https://ai.usmercari.com'), {
      state: 'completed',
      videoUrl: 'https://ai.usmercari.com/leo-files/result.mp4',
      progress: 100,
    });
    assert.deepEqual(parseUsmercariFetchPayload({
      data: [{
        taskId: 't2',
        status: 'SUCCESS',
        data: { url: '/leo-files/result-v2.mp4' },
      }],
    }, 't2', 'https://chat-ai.mercarimx.com/v1'), {
      state: 'completed',
      videoUrl: 'https://chat-ai.mercarimx.com/leo-files/result-v2.mp4',
      progress: null,
    });
  });

  it('uploads and maps first-frame, reference-video and reference-audio before submit', async () => {
    const requests = [];
    global.fetch = async (url, options) => {
      const request = { url: String(url), options, body: options?.body ? JSON.parse(options.body) : null };
      requests.push(request);
      if (request.url.endsWith('/v1/media/upload/image')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'media-image' }) };
      }
      if (request.url.endsWith('/v1/media/upload/video')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'media-video' }) };
      }
      if (request.url.endsWith('/v1/media/upload/audio')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'media-audio' }) };
      }
      if (request.url.endsWith('/cpa-file/submit/video')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'queued', task_id: 'task-routed' }) };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 'success',
          data: [{
            task_id: 'task-routed', status: 'SUCCESS', progress: '100%',
            data: { items: [{ data: [{ url: '/leo-files/routed.mp4' }] }] },
          }],
        }),
      };
    };
    const row = {
      id: 31,
      service_type: 'video',
      provider: 'usmercari',
      api_protocol: 'usmercari_media',
      base_url: 'https://ai.usmercari.com',
      api_key: 'secret',
      model: JSON.stringify(['MiniMax H3', 'seedance-2.0-fast', 'seedance-2.0-mini']),
      default_model: 'MiniMax H3',
      is_default: false,
      is_active: true,
    };
    const db = {
      prepare(sql) {
        return { all: () => sql.includes('SELECT * FROM ai_service_configs') ? [row] : [] };
      },
    };

    const submitted = await callVideoApi(db, log, {
      model: 'seedance-2.0-fast', prompt: 'test', duration: 5, aspect_ratio: '16:9', resolution: '480p',
      first_frame_url: 'data:image/png;base64,aW1hZ2U=',
      reference_video_urls: ['data:video/mp4;base64,dmlkZW8='],
      reference_audio_urls: ['data:audio/mpeg;base64,YXVkaW8='],
    });
    const completed = await pollVideoTask(null, log, 1, submitted.task_id, row, 1, 0);

    assert.deepEqual(submitted, { task_id: 'task-routed', status: 'queued' });
    const submit = requests.find((request) => request.url.endsWith('/cpa-file/submit/video'));
    assert.deepEqual(submit.body, {
      model: 'seedance-2.0-fast', prompt: 'test', duration: 5,
      metadata: {
        aspect_ratio: '16:9', resolution: '480p', image_id: 'media-image',
        video_reference_ids: ['media-video'], audio_reference_ids: ['media-audio'],
      },
    });
    const poll = requests.find((request) => request.url.endsWith('/cpa-file/fetch'));
    assert.equal(poll.options.method, 'POST');
    assert.deepEqual(poll.body, { ids: ['task-routed'] });
    assert.deepEqual(completed, { video_url: 'https://ai.usmercari.com/leo-files/routed.mp4' });
  });
});

describe('USMercari read-only connectivity probe', () => {
  it('lists models and never submits a billable generation', async () => {
    process.env.USMERCARI_API_KEY = 'env-secret';
    let request;
    global.fetch = async (url, options) => {
      request = { url: String(url), options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: Object.keys(USMERCARI_MODELS).map((id) => ({ id })) }),
      };
    };

    await testConnection({
      provider: 'usmercari',
      service_type: 'video',
      api_protocol: 'usmercari_media',
      base_url: 'https://ai.usmercari.com',
      api_key: '',
      model: Object.keys(USMERCARI_MODELS),
    });

    assert.equal(request.url, 'https://ai.usmercari.com/v1/models');
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.headers.Authorization, 'Bearer env-secret');
  });
});
