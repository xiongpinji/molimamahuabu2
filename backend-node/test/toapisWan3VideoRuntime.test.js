'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  callVideoApi,
  getDefaultVideoConfig,
  inferVideoProtocol,
  pollVideoTask,
  queryVideoTaskStatusOnce,
  resolveVideoProtocol,
} = require('../src/services/videoClient');

const MODEL = 'wan3.0-video';
const CONTRACT = 'toapis-wan3-video-real-verification-v1';
const log = { info() {}, warn() {}, error() {} };

function createEvidenceFixture() {
  const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wan3-runtime-evidence-'));
  const root = path.join(allowedRoot, 'external-models-v1');
  const publicDir = path.join(root, 'public', 'toapis');
  fs.mkdirSync(publicDir, { recursive: true, mode: 0o755 });
  const evidence = Buffer.from(JSON.stringify({
    contract_version: CONTRACT,
    results: [{ artifact: { output_file: 'wan3-runtime.mp4' } }],
  }));
  const sha256 = crypto.createHash('sha256').update(evidence).digest('hex');
  fs.writeFileSync(path.join(root, 'toapis-wan3-video-verification.json'), evidence, { mode: 0o644 });
  fs.writeFileSync(path.join(publicDir, 'wan3-runtime.mp4'), 'verified\n', { mode: 0o644 });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    contract_version: 'external-model-release-evidence-manifest-v1',
    evidence: {
      [CONTRACT]: { file: 'toapis-wan3-video-verification.json', sha256 },
    },
  }), { mode: 0o644 });
  return {
    roots: { allowedRoot, root },
    capabilities: {
      durations: [2],
      resolutions: ['480p'],
      aspectRatios: ['16:9'],
      supportsFirstFrame: false,
      supportsLastFrame: false,
      supportsImageReference: true,
      supportsVideoReference: false,
      supportsAudioReference: false,
      supportsAudio: false,
      maxReferences: 2,
      maxVideoReferences: 0,
      maxAudioReferences: 0,
      evidence_contract: CONTRACT,
      evidence_sha256: sha256,
    },
  };
}

const fixture = createEvidenceFixture();
test.after(() => fs.rmSync(fixture.roots.allowedRoot, { recursive: true, force: true }));

function makeConfig(overrides = {}) {
  return {
    id: 301,
    service_type: 'video',
    provider: 'toapis',
    api_protocol: 'toapis_wan3_video',
    name: 'ToAPIs Wan 3.0',
    base_url: 'https://toapis.xyz',
    api_key: 'wan-key',
    model: JSON.stringify([MODEL]),
    default_model: MODEL,
    logical_model_id: null,
    is_active: 1,
    is_default: 1,
    priority: 0,
    verification_status: 'verified',
    verified_capabilities: JSON.stringify({ [MODEL]: fixture.capabilities }),
    settings: '{}',
    deleted_at: null,
    ...overrides,
  };
}

function makePrice() {
  return {
    model: MODEL,
    display_name: 'Wan 3.0 Video',
    public_note: '',
    category: 'video',
    credits: 1,
    status: 'enabled',
    billing_unit: 'second',
    cost_unit: 'second',
    cost_micros_per_unit: 0,
    input_cost_micros_per_1k: 0,
    output_cost_micros_per_1k: 0,
    updated_at: '2026-08-29T00:00:00.000Z',
    resolution_prices: {
      '480p': { credits: 10, cost_micros_per_second: 50000 },
    },
  };
}

const MODEL_PRICE_COLUMNS = [
  'model', 'credits', 'display_name', 'public_note', 'category', 'status',
  'billing_unit', 'cost_unit', 'cost_micros_per_unit',
  'input_cost_micros_per_1k', 'output_cost_micros_per_1k', 'updated_at',
  'pricing_mode',
].map((name) => ({ name }));
const MODEL_PRICE_SCHEMA_SQL = `CREATE TABLE model_credit_prices (
  model TEXT PRIMARY KEY,
  pricing_mode TEXT NOT NULL DEFAULT 'paid',
  credits INTEGER NOT NULL CHECK (
    (pricing_mode = 'paid' AND credits > 0)
    OR (pricing_mode = 'free' AND credits = 0)
  )
)`;

function makeDb(configs, prices = [makePrice()]) {
  const rows = Array.isArray(configs) ? configs : [configs];
  return {
    exec() {},
    prepare(sql) {
      return {
        all(...args) {
          if (/PRAGMA table_info\(model_credit_prices\)/i.test(sql)) return MODEL_PRICE_COLUMNS;
          if (/PRAGMA table_info/i.test(sql)) return [];
          if (/FROM ai_service_configs/i.test(sql)) return rows;
          if (/FROM model_resolution_prices/i.test(sql)) {
            const model = String(args[0] || '').toLowerCase();
            const price = prices.find((item) => item.model.toLowerCase() === model);
            return Object.entries(price?.resolution_prices || {}).map(([resolution, tier]) => ({
              resolution,
              ...tier,
            }));
          }
          if (/FROM model_image_resolution_prices/i.test(sql)) return [];
          if (/FROM model_credit_prices/i.test(sql)) {
            return prices.map(({ resolution_prices, ...price }) => price);
          }
          return [];
        },
        get(...args) {
          if (/SELECT sql FROM sqlite_master/i.test(sql) && /name = 'model_credit_prices'/i.test(sql)) {
            return { sql: MODEL_PRICE_SCHEMA_SQL };
          }
          if (/FROM sqlite_master/i.test(sql)) {
            return String(args[0] || '') === 'model_credit_prices' ? { exists: 1 } : undefined;
          }
          if (/FROM ai_service_configs/i.test(sql)) {
            const requestedId = Number(args[0]);
            return Number.isSafeInteger(requestedId)
              ? rows.find((item) => item.id === requestedId)
              : rows[0];
          }
          if (/FROM model_credit_prices/i.test(sql)) {
            const model = String(args[0] || '').toLowerCase();
            const price = prices.find((item) => item.model.toLowerCase() === model);
            if (!price) return undefined;
            const { resolution_prices, ...row } = price;
            return row;
          }
          return undefined;
        },
        run() { return { changes: 0 }; },
      };
    },
  };
}

test('Wan 3.0 uses an independent protocol without changing legacy ToAPIs resolution', () => {
  assert.equal(inferVideoProtocol('toapis_wan3_video'), 'toapis_wan3_video');
  assert.equal(resolveVideoProtocol(makeConfig()), 'toapis_wan3_video');
  assert.equal(resolveVideoProtocol(makeConfig({ api_protocol: 'toapis_video' })), 'toapis_video');
  assert.equal(resolveVideoProtocol(makeConfig({ provider: 'toapis', api_protocol: '' })), 'toapis_video');
});

test('Wan 3.0 strict selection requires its exact protocol, dedicated credential and trusted evidence binding', (t) => {
  const previousLegacyKey = process.env.TOAPIS_API_KEY;
  const previousWanKey = process.env.TOAPIS_WAN3_API_KEY;
  process.env.TOAPIS_API_KEY = 'legacy-global-key-must-not-qualify-wan';
  delete process.env.TOAPIS_WAN3_API_KEY;
  t.after(() => {
    if (previousLegacyKey == null) delete process.env.TOAPIS_API_KEY;
    else process.env.TOAPIS_API_KEY = previousLegacyKey;
    if (previousWanKey == null) delete process.env.TOAPIS_WAN3_API_KEY;
    else process.env.TOAPIS_WAN3_API_KEY = previousWanKey;
  });
  const generic = makeConfig({
    id: 302,
    provider: 'openai',
    api_protocol: 'openai',
    base_url: 'https://example.invalid',
  });
  const legacyToapis = makeConfig({ id: 303, api_protocol: 'toapis_video' });
  assert.equal(getDefaultVideoConfig(makeDb([generic, legacyToapis]), MODEL, fixture.roots), null);

  const stale = makeConfig({
    id: 304,
    verified_capabilities: JSON.stringify({
      [MODEL]: { ...fixture.capabilities, evidence_sha256: '0'.repeat(64) },
    }),
  });
  assert.equal(getDefaultVideoConfig(makeDb(stale), MODEL, fixture.roots), null);
  assert.equal(getDefaultVideoConfig(makeDb(makeConfig({ api_key: '' })), MODEL, fixture.roots), null);
  assert.equal(getDefaultVideoConfig(makeDb(makeConfig()), MODEL, fixture.roots).id, 301);
});

test('Wan 3.0 runtime submit is gated by evidence capabilities and exact resolution price', async () => {
  const calls = [];
  const submitted = await callVideoApi(makeDb(makeConfig()), log, {
    model: MODEL,
    prompt: '保持两张参考图中的角色一致',
    duration: 2,
    resolution: '480p',
    aspect_ratio: '16:9',
    reference_urls: [
      'https://cdn.example.com/reference-1.png',
      'https://cdn.example.com/reference-2.png',
    ],
    generate_audio: false,
    video_gen_id: 301,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ task_id: 'wan-runtime-task', status: 'queued' }),
      };
    },
  }, { evidenceRoots: fixture.roots });

  assert.deepEqual(submitted, { task_id: 'wan-runtime-task', status: 'queued' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://toapis.xyz/v1/videos/generations');
  assert.deepEqual(calls[0].body.reference_images, [
    'https://cdn.example.com/reference-1.png',
    'https://cdn.example.com/reference-2.png',
  ]);
  assert.equal(calls[0].body.client_business_id, 'video-301');
  assert.equal(calls[0].body.audio, false);
});

test('Wan 3.0 runtime preserves verified reference video and audio duration metadata', async () => {
  const capabilities = {
    ...fixture.capabilities,
    supportsVideoReference: true,
    supportsAudioReference: true,
    maxVideoReferences: 2,
    maxAudioReferences: 1,
  };
  const config = makeConfig({
    verified_capabilities: JSON.stringify({ [MODEL]: capabilities }),
  });
  const calls = [];
  const submitted = await callVideoApi(makeDb(config), log, {
    model: MODEL,
    prompt: '根据视频与音频参考生成',
    duration: 2,
    resolution: '480p',
    aspect_ratio: '16:9',
    reference_video_urls: [
      'https://cdn.example.com/reference-1.mp4',
      'https://cdn.example.com/reference-2.mp4',
    ],
    reference_video_durations: [7, 8],
    reference_audio_urls: ['https://cdn.example.com/reference.mp3'],
    reference_audio_durations: [15],
    generate_audio: false,
    video_gen_id: 302,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ task_id: 'wan-reference-media-task', status: 'queued' }),
      };
    },
  }, { evidenceRoots: fixture.roots });

  assert.deepEqual(submitted, { task_id: 'wan-reference-media-task', status: 'queued' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.video_list, [
    { video_url: 'https://cdn.example.com/reference-1.mp4' },
    { video_url: 'https://cdn.example.com/reference-2.mp4' },
  ]);
  assert.deepEqual(calls[0].body.audio_with_roles, [
    { url: 'https://cdn.example.com/reference.mp3', role: 'reference_audio' },
  ]);
});

test('Wan 3.0 runtime rejects reference media without duration metadata before POST', async () => {
  const capabilities = {
    ...fixture.capabilities,
    supportsVideoReference: true,
    maxVideoReferences: 1,
  };
  const config = makeConfig({
    verified_capabilities: JSON.stringify({ [MODEL]: capabilities }),
  });
  let posts = 0;
  const blocked = await callVideoApi(makeDb(config), log, {
    model: MODEL,
    prompt: '缺失参考视频时长',
    duration: 2,
    resolution: '480p',
    aspect_ratio: '16:9',
    reference_video_urls: ['https://cdn.example.com/reference.mp4'],
    generate_audio: false,
    video_gen_id: 303,
    fetchImpl: async () => {
      posts += 1;
      throw new Error('must not POST');
    },
  }, { evidenceRoots: fixture.roots });

  assert.equal(posts, 0);
  assert.match(blocked.error, /参考视频必须提供逐项可核验时长/);
});

test('Wan 3.0 blocks stale evidence, unverified capabilities and missing price before POST', async () => {
  let posts = 0;
  const fetchImpl = async () => {
    posts += 1;
    throw new Error('must not POST');
  };
  const stale = makeConfig({
    verified_capabilities: JSON.stringify({
      [MODEL]: { ...fixture.capabilities, evidence_sha256: 'f'.repeat(64) },
    }),
  });
  await assert.rejects(() => callVideoApi(makeDb(stale), log, {
    model: MODEL, prompt: 'x', duration: 2, resolution: '480p', video_gen_id: 1, fetchImpl,
  }, { evidenceRoots: fixture.roots }), /\u672a\u914d\u7f6e|\u672a\u9a8c\u8bc1/);

  const unsupported = makeConfig({
    verified_capabilities: JSON.stringify({
      [MODEL]: { ...fixture.capabilities, supportsImageReference: false },
    }),
  });
  const blockedReference = await callVideoApi(makeDb(unsupported), log, {
    model: MODEL,
    prompt: 'x', duration: 2, resolution: '480p', aspect_ratio: '16:9', video_gen_id: 2,
    reference_urls: ['https://cdn.example.com/reference.png'], fetchImpl,
  }, { evidenceRoots: fixture.roots });
  assert.match(blockedReference.error, /\u53c2\u8003\u56fe.*\u672a\u901a\u8fc7\u771f\u5b9e\u9a8c\u8bc1/);

  const missingPrice = await callVideoApi(makeDb(makeConfig(), []), log, {
    model: MODEL, prompt: 'x', duration: 2, resolution: '480p', aspect_ratio: '16:9',
    generate_audio: false, video_gen_id: 3, fetchImpl,
  }, { evidenceRoots: fixture.roots });
  assert.match(missingPrice.error, /480p.*\u79ef\u5206\u5f85\u7ba1\u7406\u5458\u914d\u7f6e/);
  assert.equal(posts, 0);
});

test('Wan 3.0 runtime poll and one-shot reconciliation use the independent task client', async () => {
  const config = makeConfig();
  const calls = [];
  const completed = await pollVideoTask(null, log, 301, 'wan-runtime-task', config, 2, 0, {
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(calls.length === 1
          ? { status: 'processing', progress: 20 }
          : { status: 'completed', result: { data: [{ url: 'https://cdn.example.com/wan.mp4' }] } }),
      };
    },
  });
  assert.deepEqual(completed, { video_url: 'https://cdn.example.com/wan.mp4' });
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.url === 'https://toapis.xyz/v1/videos/generations/wan-runtime-task'), true);
  assert.equal(calls.every((call) => call.method === 'GET'), true);

  let queries = 0;
  const reconciled = await queryVideoTaskStatusOnce(null, log, 'wan-runtime-task', config, {
    fetchImpl: async () => {
      queries += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          status: 'completed',
          result: { data: [{ url: 'https://cdn.example.com/wan.mp4' }] },
        }),
      };
    },
  });
  assert.equal(queries, 1);
  assert.deepEqual(reconciled, { state: 'succeeded', artifactUrl: 'https://cdn.example.com/wan.mp4' });
});
