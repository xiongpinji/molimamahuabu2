const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  FUMIN_MODELS,
  normalizeFuminBaseUrl,
  buildFuminCreateUrl,
  buildFuminQueryUrl,
  resolveFuminModel,
  buildFuminVideoBody,
  parseFuminSubmitResponse,
  parseFuminStatusPayload,
  callFuminVideoApi,
} = require('../src/services/fuminVideoClient');
const { providerCapabilities } = require('../src/services/canvasModelCatalogService');
const { testConnection } = require('../src/services/aiConfigService');
const { validateFuminModelKeyIsolation } = require('../src/services/aiConfigService');
const { callVideoApi, pollVideoTask } = require('../src/services/videoClient');

const log = { info() {}, warn() {}, error() {} };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe('fumin Seedance video protocol', () => {
  it('keeps app aliases separate while mapping to verified upstream ids', () => {
    assert.deepEqual(FUMIN_MODELS, {
      'fumin-seedance-2.0-fast': 'seedance-2.0-fast',
      'fumin-seedance-2.0-mini': 'seedance-2.0-mini',
    });
    assert.equal(resolveFuminModel('fumin-seedance-2.0-fast'), 'seedance-2.0-fast');
    assert.equal(resolveFuminModel('seedance-2.0-mini'), 'seedance-2.0-mini');
  });

  it('normalizes the base URL and builds the documented v3 task paths', () => {
    assert.equal(normalizeFuminBaseUrl('https://fumin.ai/api/v3/'), 'https://fumin.ai');
    assert.equal(buildFuminCreateUrl({ base_url: 'https://fumin.ai' }), 'https://fumin.ai/api/v3/contents/generations/tasks');
    assert.equal(buildFuminCreateUrl({ base_url: 'https://fumin.ai', endpoint: '/api/v3/contents/generations/tasks' }), 'https://fumin.ai/api/v3/contents/generations/tasks');
    assert.equal(buildFuminQueryUrl({ base_url: 'https://fumin.ai' }, 'task-1'), 'https://fumin.ai/api/v3/contents/generations/tasks/task-1');
  });

  it('builds the OpenAI-compatible mixed media body within the declared Seedance limits', () => {
    const body = buildFuminVideoBody({
      model: 'fumin-seedance-2.0-fast',
      prompt: '自然地转身微笑',
      duration: 15,
      aspect_ratio: '16:9',
      resolution: '480p',
      image_url: 'https://cdn.example/first.jpg',
      reference_urls: Array.from({ length: 8 }, (_, index) => `https://cdn.example/image-${index + 1}.jpg`),
      reference_video_urls: Array.from({ length: 3 }, (_, index) => `https://cdn.example/video-${index + 1}.mp4`),
      reference_audio_urls: Array.from({ length: 3 }, (_, index) => `https://cdn.example/audio-${index + 1}.mp3`),
    });
    assert.deepEqual(body, {
      model: 'seedance-2.0-fast',
      content: [
        { type: 'text', text: '自然地转身微笑' },
        { type: 'image_url', image_url: { url: 'https://cdn.example/first.jpg' } },
        ...Array.from({ length: 8 }, (_, index) => ({
          type: 'image_url', image_url: { url: `https://cdn.example/image-${index + 1}.jpg` },
        })),
        ...Array.from({ length: 3 }, (_, index) => ({
          type: 'video_url', video_url: { url: `https://cdn.example/video-${index + 1}.mp4` }, role: 'reference_video',
        })),
        ...Array.from({ length: 3 }, (_, index) => ({
          type: 'audio_url', audio_url: { url: `https://cdn.example/audio-${index + 1}.mp3` }, role: 'reference_audio',
        })),
      ],
      ratio: '16:9',
      duration: 15,
      resolution: '480p',
      watermark: false,
    });
  });

  it('parses queued, succeeded and failed task shapes', () => {
    assert.deepEqual(parseFuminSubmitResponse({ id: 'task-1', status: 'queued' }), {
      task_id: 'task-1', status: 'queued',
    });
    assert.deepEqual(parseFuminStatusPayload({ status: 'processing' }), {
      state: 'processing',
    });
    assert.deepEqual(parseFuminStatusPayload({
      status: 'succeeded',
      content: { video_url: 'https://cdn.example/result.mp4' },
    }), {
      state: 'completed', videoUrl: 'https://cdn.example/result.mp4',
    });
    assert.deepEqual(parseFuminStatusPayload({ status: 'failed', error: { message: 'blocked' } }), {
      state: 'failed', error: 'blocked',
    });
  });

  it('submits once with bearer auth and marks an interrupted submit indeterminate', async () => {
    let calls = 0;
    let request;
    global.fetch = async (url, options) => {
      calls += 1;
      request = { url: String(url), options, body: JSON.parse(options.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'task-fumin-1', status: 'queued' }) };
    };
    const submitted = await callFuminVideoApi({ base_url: 'https://fumin.ai', api_key: 'secret' }, log, {
      model: 'fumin-seedance-2.0-mini', prompt: 'test', duration: 5, aspect_ratio: '16:9', resolution: '480p',
    });
    assert.equal(calls, 1);
    assert.equal(request.url, 'https://fumin.ai/api/v3/contents/generations/tasks');
    assert.equal(request.options.headers.Authorization, 'Bearer secret');
    assert.equal(request.body.model, 'seedance-2.0-mini');
    assert.deepEqual(submitted, { task_id: 'task-fumin-1', status: 'queued' });

    global.fetch = async () => { throw new Error('socket closed'); };
    const interrupted = await callFuminVideoApi({ base_url: 'https://fumin.ai', api_key: 'secret' }, log, {
      model: 'fumin-seedance-2.0-fast', prompt: 'test', duration: 5,
    });
    assert.equal(interrupted.indeterminate, true);
    assert.match(interrupted.error, /不得自动重试/);
  });

  it('routes the shared video service to fumin and polls its content.video_url result', async () => {
    const requests = [];
    global.fetch = async (url, options) => {
      const request = { url: String(url), options, body: options?.body ? JSON.parse(options.body) : null };
      requests.push(request);
      if (request.url.endsWith('/api/v3/contents/generations/tasks')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'task-route-1', status: 'queued' }) };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'succeeded', content: { video_url: 'https://cdn.example/fumin.mp4' } }),
      };
    };
    const row = {
      id: 44,
      service_type: 'video',
      provider: 'fumin',
      api_protocol: 'fumin_video',
      base_url: 'https://fumin.ai',
      api_key: 'secret',
      model: JSON.stringify(['fumin-seedance-2.0-fast', 'fumin-seedance-2.0-mini']),
      default_model: 'fumin-seedance-2.0-fast',
      endpoint: '/api/v3/contents/generations/tasks',
      query_endpoint: '/api/v3/contents/generations/tasks/{taskId}',
      is_default: false,
      is_active: true,
    };
    const db = {
      prepare(sql) {
        return { all: () => sql.includes('SELECT * FROM ai_service_configs') ? [row] : [] };
      },
    };
    const submitted = await callVideoApi(db, log, {
      model: 'fumin-seedance-2.0-fast',
      prompt: 'test',
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '480p',
      image_url: 'data:image/png;base64,aW1hZ2U=',
      reference_video_urls: ['https://cdn.example/reference.mp4'],
      reference_audio_urls: ['https://cdn.example/reference.mp3'],
    });
    const completed = await pollVideoTask(null, log, 44, submitted.task_id, row, 1, 0);
    assert.deepEqual(submitted, { task_id: 'task-route-1', status: 'queued' });
    assert.deepEqual(completed, { video_url: 'https://cdn.example/fumin.mp4' });
    assert.equal(requests[0].body.model, 'seedance-2.0-fast');
    assert.equal(requests[0].body.content[1].image_url.url, 'data:image/png;base64,aW1hZ2U=');
    assert.deepEqual(requests[0].body.content.slice(2), [
      { type: 'video_url', video_url: { url: 'https://cdn.example/reference.mp4' }, role: 'reference_video' },
      { type: 'audio_url', audio_url: { url: 'https://cdn.example/reference.mp3' }, role: 'reference_audio' },
    ]);
    assert.equal(requests[1].url, 'https://fumin.ai/api/v3/contents/generations/tasks/task-route-1');
  });
});

describe('fumin catalog and read-only connectivity', () => {
  it('requires separate config rows so FAST and MINI cannot share one key', () => {
    assert.doesNotThrow(() => validateFuminModelKeyIsolation({
      provider: 'fumin', serviceType: 'video', model: ['fumin-seedance-2.0-fast'],
    }));
    assert.throws(() => validateFuminModelKeyIsolation({
      provider: 'fumin', serviceType: 'video', model: ['fumin-seedance-2.0-fast', 'fumin-seedance-2.0-mini'],
    }), { code: 'INVALID_FUMIN_MODEL_KEY_ISOLATION' });
    assert.throws(() => validateFuminModelKeyIsolation({
      provider: 'fumin', serviceType: 'video', model: ['unverified-model'],
    }), { code: 'INVALID_FUMIN_MODEL' });
  });

  it('exposes the declared fumin Seedance media and duration limits', () => {
    assert.deepEqual(providerCapabilities('fumin', 'fumin-seedance-2.0-fast'), {
      durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      aspectRatios: ['16:9'],
      resolutions: ['480p'],
      maxReferences: 9,
      maxVideoReferences: 3,
      maxAudioReferences: 3,
      supportsImageReference: true,
      supportsVideoReference: true,
      supportsAudioReference: true,
      supportsAudio: true,
    });
    assert.deepEqual(providerCapabilities('fumin', 'fumin-seedance-2.0-mini'), {
      durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      aspectRatios: ['16:9'],
      resolutions: ['480p'],
      maxReferences: 9,
      maxVideoReferences: 3,
      maxAudioReferences: 3,
      supportsImageReference: true,
      supportsVideoReference: true,
      supportsAudioReference: true,
      supportsAudio: true,
    });
  });

  it('checks the fumin model list without submitting a billable generation', async () => {
    let request;
    global.fetch = async (url, options) => {
      request = { url: String(url), options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: 'seedance-2.0-fast' }, { id: 'seedance-2.0-mini' }] }),
      };
    };
    await testConnection({
      provider: 'fumin',
      service_type: 'video',
      api_protocol: 'fumin_video',
      base_url: 'https://fumin.ai',
      api_key: 'secret',
      model: ['fumin-seedance-2.0-fast', 'fumin-seedance-2.0-mini'],
    });
    assert.equal(request.url, 'https://fumin.ai/v1/models');
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.headers.Authorization, 'Bearer secret');
  });

  it('rejects requests outside the declared duration and media reference limits before submit', () => {
    assert.doesNotThrow(() => buildFuminVideoBody({ model: 'fumin-seedance-2.0-fast', duration: 10 }));
    assert.doesNotThrow(() => buildFuminVideoBody({
      model: 'fumin-seedance-2.0-fast',
      reference_urls: Array.from({ length: 9 }, (_, index) => `https://cdn.example/image-${index}.jpg`),
      reference_video_urls: Array.from({ length: 3 }, (_, index) => `https://cdn.example/video-${index}.mp4`),
      reference_audio_urls: Array.from({ length: 3 }, (_, index) => `https://cdn.example/audio-${index}.mp3`),
    }));
    assert.throws(() => buildFuminVideoBody({ model: 'fumin-seedance-2.0-fast', duration: 16 }), /5 到 15 秒/);
    assert.throws(() => buildFuminVideoBody({ model: 'fumin-seedance-2.0-fast', duration: 0 }), /5 到 15 秒/);
    assert.throws(() => buildFuminVideoBody({ model: 'fumin-seedance-2.0-fast', aspect_ratio: '9:16' }), /16:9/);
    assert.throws(() => buildFuminVideoBody({ model: 'fumin-seedance-2.0-fast', resolution: '720p' }), /720P/);
    assert.throws(() => buildFuminVideoBody({
      model: 'fumin-seedance-2.0-fast',
      reference_urls: Array.from({ length: 10 }, (_, index) => `https://cdn.example/image-${index}.jpg`),
    }), /9 张/);
    assert.throws(() => buildFuminVideoBody({
      model: 'fumin-seedance-2.0-fast',
      reference_video_urls: Array.from({ length: 4 }, (_, index) => `https://cdn.example/video-${index}.mp4`),
    }), /3 个视频/);
    assert.throws(() => buildFuminVideoBody({
      model: 'fumin-seedance-2.0-fast',
      reference_audio_urls: Array.from({ length: 4 }, (_, index) => `https://cdn.example/audio-${index}.mp3`),
    }), /3 个音频/);
  });

  it('does not reject a verified model omitted from the provider directory', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ id: 'seedance-2.0-fast' }] }),
    });
    await testConnection({
      provider: 'fumin',
      service_type: 'video',
      api_protocol: 'fumin_video',
      base_url: 'https://fumin.ai',
      api_key: 'secret',
      model: ['fumin-seedance-2.0-mini'],
    });
  });
});
