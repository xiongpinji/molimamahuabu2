const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildIcreatVideoBody,
  normalizeIcreatModel,
  callIcreatVideoApi,
  callVideoApi,
  pollVideoTask,
} = require('../src/services/videoClient');
const { testConnection } = require('../src/services/aiConfigService');

const log = { info() {}, warn() {}, error() {} };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe('iCreat Seedance video protocol', () => {
  it('normalizes the user-facing Mini model name to the documented capability code', () => {
    assert.equal(normalizeIcreatModel('Seedance 2.0 Mini'), 'bytedance/seedance-2-0-mini');
    assert.equal(normalizeIcreatModel('bytedance/seedance-2-0-fast'), 'bytedance/seedance-2-0-fast');
  });

  it('builds the documented content body with first and last frame roles', () => {
    const body = buildIcreatVideoBody({
      prompt: '母女在花园里慢慢走近镜头',
      duration: 2,
      aspect_ratio: '9:16',
      resolution: '1080p',
      first_frame_url: 'https://cdn.example/first.png',
      last_frame_url: 'https://cdn.example/last.png',
    });

    assert.deepEqual(body, {
      content: [
        { type: 'text', text: '母女在花园里慢慢走近镜头' },
        { type: 'image_url', image_url: { url: 'https://cdn.example/first.png' }, role: 'first_frame' },
        { type: 'image_url', image_url: { url: 'https://cdn.example/last.png' }, role: 'last_frame' },
      ],
      ratio: '9:16',
      resolution: '1080p',
      duration: 4,
    });
  });

  it('omits mutually exclusive reference images when first or last frame is present', () => {
    const body = buildIcreatVideoBody({
      prompt: '角色沿着雨林石径前进',
      first_frame_url: 'https://cdn.example/first.png',
      last_frame_url: 'https://cdn.example/last.png',
      reference_urls: ['https://cdn.example/character.png'],
    });

    assert.equal(body.content.find((part) => part.role === 'first_frame').need_review, undefined);
    assert.equal(body.content.find((part) => part.role === 'last_frame').need_review, undefined);
    assert.equal(body.content.some((part) => part.role === 'reference_image'), false);
  });

  it('keeps need_review on reference images in pure reference mode', () => {
    const body = buildIcreatVideoBody({
      prompt: '保持角色一致地沿着雨林石径前进',
      reference_urls: ['https://cdn.example/character.png'],
    });

    assert.equal(body.content.some((part) => part.role === 'first_frame'), false);
    assert.deepEqual(body.content.find((part) => part.role === 'reference_image'), {
      type: 'image_url',
      image_url: { url: 'https://cdn.example/character.png' },
      role: 'reference_image',
      need_review: true,
    });
  });

  it('adds a character voice as the documented reference audio content item', () => {
    const body = buildIcreatVideoBody({
      prompt: '小狐狸抬头说话',
      voice_reference_url: 'https://cdn.example/fox-voice.mp3',
    });

    assert.deepEqual(body.content.at(-1), {
      type: 'audio_url',
      audio_url: { url: 'https://cdn.example/fox-voice.mp3' },
      role: 'reference_audio',
    });
  });

  it('keeps first/last frame generation valid by omitting the mutually exclusive reference audio', () => {
    const body = buildIcreatVideoBody({
      prompt: '小狐狸沿着雨林石径走向石门',
      first_frame_url: 'https://cdn.example/first.png',
      last_frame_url: 'https://cdn.example/last.png',
      voice_reference_url: 'https://cdn.example/fox-voice.mp3',
    });

    assert.equal(body.content.some((part) => part.role === 'first_frame'), true);
    assert.equal(body.content.some((part) => part.role === 'last_frame'), true);
    assert.equal(body.content.some((part) => part.role === 'reference_audio'), false);
  });

  it('submits to the iCreat capability-code endpoint and returns the task id', async () => {
    let request;
    global.fetch = async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ taskId: 'icreat-task-1', status: 'SUBMITTED' }) };
    };

    const result = await callIcreatVideoApi({
      provider: 'icreat',
      api_protocol: 'icreat_task',
      base_url: 'https://zh.icreat.ai',
      api_key: 'secret',
      endpoint: '/v1/task/submit/{model}',
      settings: JSON.stringify({ icreat_group: 'default' }),
    }, log, { model: 'Seedance 2.0 Mini', prompt: 'test', duration: 5 });

    assert.equal(request.url, 'https://api.icreat.ai/v1/task/submit/bytedance/seedance-2-0-mini');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers.Authorization, 'Bearer secret');
    assert.equal(request.options.headers['X-ICREAT-AI-GROUP'], 'default');
    assert.equal(request.body.content[0].text, 'test');
    assert.equal(request.body.duration, 5);
    assert.deepEqual(result, { task_id: 'icreat-task-1', status: 'SUBMITTED' });
  });

  it('converts an extracted local voice file into an audio data reference', async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'icreat-voice-'));
    const relative = 'projects/demo/characters/voice/fox.mp3';
    const localFile = path.join(storage, relative);
    fs.mkdirSync(path.dirname(localFile), { recursive: true });
    fs.writeFileSync(localFile, Buffer.from('fake-mp3'));
    let request;
    global.fetch = async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ taskId: 'icreat-local-voice' }) };
    };

    try {
      await callIcreatVideoApi({
        provider: 'icreat',
        api_protocol: 'icreat_task',
        base_url: 'https://api.icreat.ai',
        api_key: 'secret',
        endpoint: '/v1/task/submit/{model}',
      }, log, {
        model: 'Seedance 2.0 Mini',
        prompt: '小狐狸说话',
        voice_reference_url: `/static/${relative}`,
        storage_local_path: storage,
      });
      const audio = request.body.content.at(-1);
      assert.equal(audio.type, 'audio_url');
      assert.match(audio.audio_url.url, /^data:audio\/mpeg;base64,/);
      assert.equal(Buffer.from(audio.audio_url.url.split(',')[1], 'base64').toString(), 'fake-mp3');
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('polls status with POST and fetches the result only after SUCCEEDED', async () => {
    const requests = [];
    global.fetch = async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      if (requests.length === 1) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'SUCCEEDED' }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify([{ type: 'Video', url: 'https://cdn.example/result.mp4' }]) };
    };

    const result = await pollVideoTask(null, log, 1, 'icreat-task-1', {
      provider: 'icreat',
      api_protocol: 'icreat_task',
      base_url: 'https://api.icreat.ai',
      api_key: 'secret',
    }, 1, 0);

    assert.equal(requests[0].url, 'https://api.icreat.ai/v1/task/query-status');
    assert.deepEqual(requests[0].body, { task_id: 'icreat-task-1' });
    assert.equal(requests[1].url, 'https://api.icreat.ai/v1/task/get-result');
    assert.deepEqual(requests[1].body, { task_id: 'icreat-task-1' });
    assert.deepEqual(result, { video_url: 'https://cdn.example/result.mp4' });
  });

  it('bounds the completed-task result fetch so recovery can retry it', async () => {
    let resultSignal;
    let requestCount = 0;
    global.fetch = async (_url, options) => {
      requestCount += 1;
      if (requestCount === 1) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'SUCCEEDED' }) };
      }
      resultSignal = options.signal;
      throw Object.assign(new Error('result fetch timed out'), { name: 'TimeoutError' });
    };

    const result = await pollVideoTask(null, log, 185, 'icreat-task-timeout', {
      provider: 'icreat',
      api_protocol: 'icreat_task',
      base_url: 'https://api.icreat.ai',
      api_key: 'secret',
    }, 1, 0);

    assert.equal(requestCount, 2);
    assert.equal(resultSignal instanceof AbortSignal, true);
    assert.equal(result.indeterminate, true);
    assert.equal(result.provider_task_id, 'icreat-task-timeout');
  });

  it('preserves the provider failure detail instead of returning only FAILED', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        status: 'FAILED',
        error_code: 'http_400',
        error_message: 'request failed with HTTP 400',
      }),
    });

    const result = await pollVideoTask(null, log, 1, 'icreat-task-failed', {
      provider: 'icreat',
      api_protocol: 'icreat_task',
      base_url: 'https://api.icreat.ai',
      api_key: 'secret',
    }, 1, 0);

    assert.equal(result.error, 'iCreat 任务失败或不存在: FAILED: request failed with HTTP 400');
  });

  it('routes an iCreat config through the production callVideoApi entry point', async () => {
    let requestedUrl = '';
    global.fetch = async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, text: async () => JSON.stringify({ taskId: 'icreat-routed-1' }) };
    };
    const row = {
      id: 9,
      service_type: 'video',
      provider: 'icreat',
      api_protocol: 'icreat_task',
      base_url: 'https://api.icreat.ai',
      api_key: 'secret',
      model: JSON.stringify(['bytedance/seedance-2-0-fast']),
      default_model: 'bytedance/seedance-2-0-fast',
      endpoint: '/v1/task/submit/{model}',
      query_endpoint: '/v1/task/query-status',
      settings: null,
      is_default: 1,
      is_active: 1,
    };
    const db = {
      prepare(sql) {
        return { all: () => sql.includes('SELECT * FROM ai_service_configs') ? [row] : [] };
      },
    };

    const result = await callVideoApi(db, log, { model: 'bytedance/seedance-2-0-fast', prompt: 'test' });

    assert.equal(requestedUrl, 'https://api.icreat.ai/v1/task/submit/bytedance/seedance-2-0-fast');
    assert.deepEqual(result, { task_id: 'icreat-routed-1', status: 'processing' });
  });

  it('automatically carries the storyboard character voice into iCreat generation', async () => {
    let request;
    global.fetch = async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ taskId: 'icreat-voice-1' }) };
    };
    const configRow = {
      id: 10,
      service_type: 'video',
      provider: 'icreat',
      api_protocol: 'icreat_task',
      base_url: 'https://api.icreat.ai',
      api_key: 'secret',
      model: JSON.stringify(['bytedance/seedance-2-0-mini']),
      default_model: 'bytedance/seedance-2-0-mini',
      endpoint: '/v1/task/submit/{model}',
      query_endpoint: '/v1/task/query-status',
      settings: null,
      is_default: 1,
      is_active: 1,
    };
    const db = {
      prepare(sql) {
        return {
          all() {
            if (sql.includes('ai_service_configs')) return [configRow];
            if (sql.includes('SELECT id, seedance2_voice_asset FROM characters')) {
              return [
                { id: 29, seedance2_voice_asset: JSON.stringify({ status: 'active', url: 'https://cdn.example/linlan-voice.mp3' }) },
                { id: 30, seedance2_voice_asset: JSON.stringify({ status: 'active', url: 'https://cdn.example/fox-voice.mp3' }) },
              ];
            }
            if (sql.includes('SELECT id, name FROM characters')) {
              return [{ id: 29, name: '林岚' }, { id: 30, name: '小狐狸' }];
            }
            return [];
          },
          get() {
            if (sql.includes('SELECT characters, dialogue FROM storyboards')) {
              return { characters: JSON.stringify([29, 30]), dialogue: '小狐狸：森林知道。 / 林岚：你怎么知道？' };
            }
            return null;
          },
          run() { return { changes: 0 }; },
        };
      },
    };

    const result = await callVideoApi(db, log, {
      model: 'Seedance 2.0 Mini',
      drama_id: 3,
      storyboard_id: 11,
      prompt: '小狐狸抬头说话',
      duration: 5,
    });

    assert.deepEqual(result, { task_id: 'icreat-voice-1', status: 'processing' });
    assert.deepEqual(request.body.content.at(-1), {
      type: 'audio_url',
      audio_url: { url: 'https://cdn.example/fox-voice.mp3' },
      role: 'reference_audio',
    });
  });
});

describe('iCreat read-only connectivity probe', () => {
  it('queries an unknown task instead of creating a billable video', async () => {
    let request;
    global.fetch = async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'NOT_FOUND' }) };
    };

    await testConnection({
      provider: 'icreat',
      service_type: 'video',
      api_protocol: 'icreat_task',
      base_url: 'https://zh.icreat.ai',
      api_key: 'secret',
    });

    assert.equal(request.url, 'https://api.icreat.ai/v1/task/query-status');
    assert.equal(request.options.method, 'POST');
    assert.deepEqual(request.body, { task_id: 'codex-connectivity-check' });
  });
});
