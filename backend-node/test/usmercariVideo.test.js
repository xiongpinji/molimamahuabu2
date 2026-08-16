const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  USMERCARI_MODELS,
  normalizeUsmercariBaseUrl,
  resolveUsmercariApiKey,
  validateUsmercariVideoOptions,
  buildUsmercariVideoBody,
  mediaUploadPayload,
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
      resolution: '1440p',
      image_url: 'https://cdn.example/first.png',
    }), {
      model: 'MiniMax H3',
      prompt: '电影感森林晨雾',
      duration: 5,
      metadata: {
        aspect_ratio: '16:9',
        resolution: '1440p',
        image_url: 'https://cdn.example/first.png',
      },
    });
    assert.throws(() => buildUsmercariVideoBody({ model: 'unknown', prompt: 'x' }), /未经真实生成验证/);
    assert.doesNotThrow(() => buildUsmercariVideoBody({ model: 'MiniMax H3', prompt: 'x', duration: 6 }));
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
      model: 'MiniMax H3', prompt: 'x', image_id: 'img-1', end_image_id: 'img-2',
      audio_reference_id: 'audio-1',
    }).metadata, {
      aspect_ratio: '16:9', resolution: '1440p', image_id: 'img-1', end_image_id: 'img-2',
      audio_reference_id: 'audio-1',
    });
  });

  it('validates material constraints before any paid generation submit', () => {
    assert.throws(() => validateUsmercariVideoOptions({
      model: 'MiniMax H3', first_frame_url: 'first', reference_urls: ['ref'],
    }), /首尾帧模式与多参考图模式互斥/);
    assert.throws(() => validateUsmercariVideoOptions({
      model: 'MiniMax H3', reference_video_urls: ['video'],
    }), /不支持参考视频/);
    assert.doesNotThrow(() => validateUsmercariVideoOptions({
      model: 'MiniMax H3', reference_audio_urls: ['audio'],
    }));
    assert.doesNotThrow(() => validateUsmercariVideoOptions({
      model: 'MiniMax H3', first_frame_url: 'image', reference_audio_urls: ['audio'],
    }), 'MiniMax H3 应支持参考图和参考音频');
    for (const model of ['seedance-2.0-fast', 'seedance-2.0-mini']) {
      assert.doesNotThrow(() => validateUsmercariVideoOptions({
        model,
        first_frame_url: 'image',
        reference_video_urls: ['video'],
        reference_audio_urls: ['audio'],
      }), `${model} 应支持参考图、参考视频和参考音频`);
    }
  });

  it('converts data URI media into the documented upload payload without network access', async () => {
    assert.deepEqual(await mediaUploadPayload('audio', 'data:audio/mpeg;base64,YXVkaW8='), {
      data: 'data:audio/mpeg;base64,YXVkaW8=',
      extension: 'mp3',
    });
  });

  it('reads an authenticated same-origin static URL from local storage before fetching', async () => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'usmercari-static-'));
    const relativePath = path.join('projects', '65', 'images', 'frame.png');
    const localPath = path.join(storageRoot, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, Buffer.from('local-frame'));
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls += 1;
      throw new Error('authenticated static URL must not be fetched anonymously');
    };

    try {
      assert.deepEqual(await mediaUploadPayload(
        'image',
        'https://molimama.vip/static/projects/65/images/frame.png',
        {
          storage_local_path: storageRoot,
          files_base_url: 'https://molimama.vip/static',
        },
      ), {
        data: `data:image/png;base64,${Buffer.from('local-frame').toString('base64')}`,
        extension: 'png',
      });
      assert.equal(fetchCalls, 0);
    } finally {
      fs.rmSync(storageRoot, { recursive: true, force: true });
    }
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
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '480p',
    });

    assert.equal(calls, 1);
    assert.equal(request.url, 'https://ai.usmercari.com/cpa-file/submit/video');
    assert.equal(request.options.headers.Authorization, 'Bearer secret');
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
