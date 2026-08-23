const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  FEITUO_MODELS,
  normalizeFeituoBaseUrl,
  buildFeituoVideoBody,
  buildFeituoStatusUrl,
  parseFeituoStatusPayload,
  callFeituoVideoApi,
} = require('../src/services/feituoVideoClient');
const { callVideoApi, pollVideoTask } = require('../src/services/videoClient');
const { testConnection } = require('../src/services/aiConfigService');
const aiConfigService = require('../src/services/aiConfigService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const modelPriceService = require('../src/services/modelPriceService');

const log = { info() {}, warn() {}, error() {} };
const originalFetch = global.fetch;
const XUAN_SEEDANCE_MODEL = 'xuan-seedance-2.5';

function setupVerifiedFeituoDb(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const capabilities = {
    [XUAN_SEEDANCE_MODEL]: {
      resolutions: ['480p', '720p'],
      durations: Array.from({ length: 27 }, (_, index) => index + 4),
      supportsFirstFrame: false,
      supportsLastFrame: false,
      supportsImageReference: true,
      supportsVideoReference: true,
      supportsAudioReference: true,
      supportsAudio: false,
      maxReferences: 30,
      maxVideoReferences: 10,
      maxAudioReferences: 10,
    },
  };
  const configId = Number(db.prepare(
    `INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
       is_active, is_default, priority, verification_status, verified_capabilities, settings,
       created_at, updated_at)
     VALUES ('video', 'feituo', 'feituo_open', '飞拓测试', 'https://feituokuajing.com',
       'test-key', ?, ?, 1, 1, 0, 'verified', ?, ?, ?, ?)`,
  ).run(
    JSON.stringify([XUAN_SEEDANCE_MODEL]),
    XUAN_SEEDANCE_MODEL,
    JSON.stringify(capabilities),
    JSON.stringify({ real_generation_verified_models: [XUAN_SEEDANCE_MODEL] }),
    now,
    now,
  ).lastInsertRowid);
  modelPriceService.set(db, XUAN_SEEDANCE_MODEL, 350, {
    category: 'video',
    status: 'enabled',
    displayName: 'Seedance 2.5（飞拓）',
    publicNote: '支持 480P、720P，按秒计费',
    billingUnit: 'second',
    costUnit: 'second',
    cost_micros_per_unit: 400000,
    resolution_prices: {
      '480p': { credits: 350, cost_micros_per_second: 400000 },
      '720p': { credits: 350, cost_micros_per_second: 400000 },
    },
  });
  return { db, config: aiConfigService.getConfig(db, configId) };
}

afterEach(() => {
  global.fetch = originalFetch;
});

describe('Feituo Open video protocol', () => {
  it('contains the legacy protocol models and the two xuan models approved for production routing', () => {
    assert.deepEqual(Object.keys(FEITUO_MODELS).sort(), [
      'sdas-lm-hailuo-h3-2k',
      'sdas-my-seedance-2.0-fast-upscaled-1080p',
      'xuan-seedance-2.5',
      'xuan-video-v1-6e7b4763634e6206',
    ]);
  });

  it('normalizes the API base without duplicating paths', () => {
    assert.equal(normalizeFeituoBaseUrl('https://feituokuajing.com/'), 'https://feituokuajing.com');
    assert.equal(
      normalizeFeituoBaseUrl('https://feituokuajing.com/api/open/v1/video/generate'),
      'https://feituokuajing.com',
    );
  });

  it('builds the documented H3 request and de-duplicates image references', () => {
    const body = buildFeituoVideoBody({
      model: 'sdas-lm-hailuo-h3-2k',
      prompt: '未来城市镜头',
      duration: 5,
      aspect_ratio: '16:9',
      image_url: 'https://cdn.example/first.png',
      first_frame_url: 'https://cdn.example/first.png',
      last_frame_url: 'https://cdn.example/last.png',
      reference_urls: ['https://cdn.example/ref.png'],
      voice_reference_url: 'https://cdn.example/voice.mp3',
    });

    assert.deepEqual(body, {
      model: 'sdas-lm-hailuo-h3-2k',
      prompt: '未来城市镜头',
      ratio: '16:9',
      duration: 5,
      imageUrls: [
        'https://cdn.example/first.png',
        'https://cdn.example/last.png',
        'https://cdn.example/ref.png',
      ],
      videoUrls: [],
      audioUrls: ['https://cdn.example/voice.mp3'],
    });
  });

  it('honors Seedance Fast material limits and rejects unsupported input', () => {
    assert.throws(() => buildFeituoVideoBody({
      model: 'sdas-my-seedance-2.0-fast-upscaled-1080p',
      prompt: 'test',
      duration: 5,
      aspect_ratio: '16:9',
      reference_video_urls: ['v1', 'v2', 'v3', 'v4'],
    }), /最多支持 3 个视频素材/);
    assert.throws(() => buildFeituoVideoBody({
      model: 'unverified-model',
      prompt: 'test',
      duration: 5,
    }), /未经真实生成验证/);
  });

  it('submits once with bearer auth and preserves jobId for polling', async () => {
    let request;
    global.fetch = async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          jobId: 'feituo-job-1',
          taskId: 'provider-task-1',
          status: 'submitted',
        }),
      };
    };

    const result = await callFeituoVideoApi({
      base_url: 'https://feituokuajing.com',
      api_key: 'secret',
    }, log, {
      model: 'sdas-lm-hailuo-h3-2k',
      prompt: 'test',
      duration: 5,
      aspect_ratio: '16:9',
    });

    assert.equal(request.url, 'https://feituokuajing.com/api/open/v1/video/generate');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers.Authorization, 'Bearer secret');
    assert.equal(request.body.model, 'sdas-lm-hailuo-h3-2k');
    assert.deepEqual(result, { task_id: 'feituo-job-1', status: 'submitted' });
  });

  it('marks an interrupted submit as indeterminate instead of retryable failure', async () => {
    global.fetch = async () => { throw new Error('socket closed'); };
    const result = await callFeituoVideoApi({
      base_url: 'https://feituokuajing.com',
      api_key: 'secret',
    }, log, {
      model: 'sdas-lm-hailuo-h3-2k',
      prompt: 'test',
      duration: 5,
    });

    assert.equal(result.indeterminate, true);
    assert.match(result.error, /不得自动重试/);
  });

  it('builds a no-cache status query and treats submitted as non-terminal', () => {
    assert.equal(
      buildFeituoStatusUrl('https://feituokuajing.com/', 'job a', 1785939000000),
      'https://feituokuajing.com/api/open/v1/video/status?jobId=job%20a&_=1785939000000',
    );
    assert.deepEqual(
      parseFeituoStatusPayload({ success: true, jobId: 'job-1', status: 'submitted' }),
      { state: 'processing' },
    );
  });

  it('prefers the public remote video and preserves provider failure detail', () => {
    assert.deepEqual(parseFeituoStatusPayload({
      success: true,
      status: 'success',
      videoUrl: '/api/video/cache/job-1',
      remoteVideoUrl: 'https://files.example/result.mp4',
    }), { state: 'completed', videoUrl: 'https://files.example/result.mp4' });
    assert.deepEqual(parseFeituoStatusPayload({
      success: false,
      status: 'failed',
      errorMessage: 'provider rejected prompt',
    }), { state: 'failed', error: 'provider rejected prompt' });
  });

  it('routes the verified xuan config through production submit and poll entry points', async (t) => {
    const { db, config } = setupVerifiedFeituoDb(t);
    const requests = [];
    global.fetch = async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ success: true, jobId: 'routed-job', status: 'submitted' }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          jobId: 'routed-job',
          status: 'success',
          remoteVideoUrl: 'https://files.example/routed.mp4',
        }),
      };
    };
    const submitted = await callVideoApi(db, log, {
      model: XUAN_SEEDANCE_MODEL,
      prompt: 'test',
      duration: 4,
      resolution: '720p',
      aspect_ratio: '16:9',
    });
    const completed = await pollVideoTask(null, log, 1, submitted.task_id, config, 1, 0);

    assert.deepEqual(submitted, { task_id: 'routed-job', status: 'submitted' });
    assert.match(requests[1].url, /^https:\/\/feituokuajing\.com\/api\/open\/v1\/video\/status\?jobId=routed-job&_\=\d+$/);
    assert.equal(requests[1].options.headers['Cache-Control'], 'no-cache');
    assert.deepEqual(completed, { video_url: 'https://files.example/routed.mp4' });
  });

  it('uploads protected short-drama references once before submitting them to verified xuan Seedance', async (t) => {
    const { db } = setupVerifiedFeituoDb(t);
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'feituo-shortdrama-'));
    t.after(() => fs.rmSync(storagePath, { recursive: true, force: true }));
    const relativePath = 'projects/0050/frames/first.jpg';
    const localPath = path.join(storagePath, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, Buffer.from('short-drama-reference'));

    const protectedUrl = `https://molimama.vip/static/${relativePath}`;
    const proxyUrl = 'https://imageproxy.zhongzhuan.chat/api/proxy/image/short-drama-ref';
    const requests = [];
    global.fetch = async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).includes('/api/upload')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ url: proxyUrl }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, jobId: 'factory-job', status: 'submitted' }),
      };
    };

    const submitted = await callVideoApi(db, log, {
      model: XUAN_SEEDANCE_MODEL,
      prompt: '@image1 延续上一镜动作',
      duration: 4,
      resolution: '720p',
      aspect_ratio: '16:9',
      image_url: protectedUrl,
      reference_urls: [protectedUrl],
      storage_local_path: storagePath,
      video_gen_id: 197,
    });

    assert.deepEqual(submitted, { task_id: 'factory-job', status: 'submitted' });
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /\/api\/upload$/);
    const providerBody = JSON.parse(requests[1].options.body);
    assert.deepEqual(providerBody.imageUrls, [proxyUrl]);
    assert.equal(providerBody.imageUrls.includes(protectedUrl), false);
  });
});

describe('Feituo read-only connectivity probe', () => {
  it('queries an unknown job and never submits a billable generation', async () => {
    let request;
    global.fetch = async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: false, status: 'not_found' }) };
    };

    await testConnection({
      provider: 'feituo',
      service_type: 'video',
      api_protocol: 'feituo_open',
      base_url: 'https://feituokuajing.com',
      api_key: 'secret',
    });

    assert.match(request.url, /^https:\/\/feituokuajing\.com\/api\/open\/v1\/video\/status\?jobId=codex-connectivity-check&_\=\d+$/);
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.headers.Authorization, 'Bearer secret');
  });
});
