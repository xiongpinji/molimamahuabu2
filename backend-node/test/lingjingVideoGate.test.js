'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evidenceRoots, withExternalModelEvidence } = require('./helpers/externalModelEvidenceFixture');
const {
  getDefaultVideoConfig,
  inferVideoProtocol,
  resolveVideoProtocol,
  callVideoApi,
  pollVideoTask,
} = require('../src/services/videoClient');

function makeConfig(overrides = {}) {
  return {
    id: 91,
    service_type: 'video',
    provider: 'lingjing',
    api_protocol: 'lingjing_open',
    base_url: 'https://seed.alimyun.xyz/api/open/v1',
    api_key: 'secret-key',
    model: JSON.stringify(['lingjing-video-v1']),
    default_model: 'lingjing-video-v1',
    is_active: 1,
    is_default: 0,
    verification_status: 'verified',
    verified_capabilities: JSON.stringify({
      'lingjing-video-v1': withExternalModelEvidence('lingjing-video-v1', {
        durations: [4, 5, 6, 8, 10, 11, 15],
        resolutions: [],
        aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
        supportsImageReference: true,
        supportsFirstFrame: false,
        supportsLastFrame: false,
        supportsVideoReference: false,
        supportsAudioReference: false,
        supportsAudio: false,
        maxReferences: 9,
        maxVideoReferences: 0,
        maxAudioReferences: 0,
      }),
    }),
    updated_at: '2026-08-10T00:00:00.000Z',
    ...overrides,
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

function makeDb(configs) {
  const rows = Array.isArray(configs) ? configs : [configs];
  const price = {
    model: 'lingjing-video-v1',
    display_name: '灵境 Seedance 2.0 Fast（9 图参考）',
    public_note: '',
    category: 'video',
    credits: 69,
    status: 'enabled',
    billing_unit: 'second',
    cost_unit: 'second',
    cost_micros_per_unit: 180000,
    input_cost_micros_per_1k: 0,
    output_cost_micros_per_1k: 0,
    updated_at: '2026-08-10T00:00:00.000Z',
  };
  return {
    exec() {},
    prepare(sql) {
      return {
        all() {
          if (/PRAGMA table_info\(model_credit_prices\)/i.test(sql)) return MODEL_PRICE_COLUMNS;
          if (/PRAGMA table_info/i.test(sql)) return [];
          if (/FROM ai_service_configs/i.test(sql)) return rows;
          if (/FROM model_resolution_prices|FROM model_image_resolution_prices/i.test(sql)) return [];
          if (/FROM model_credit_prices/i.test(sql)) return [price];
          return [];
        },
        get(...args) {
          if (/SELECT sql FROM sqlite_master/i.test(sql) && /name = 'model_credit_prices'/i.test(sql)) {
            return { sql: MODEL_PRICE_SCHEMA_SQL };
          }
          if (/FROM sqlite_master/i.test(sql)) {
            return String(args[0] || '') === 'model_credit_prices' ? { exists: 1 } : undefined;
          }
          if (/FROM ai_service_configs/i.test(sql)) return rows.find((row) => Number(row.id) === Number(args[0])) || rows[0];
          if (/FROM model_credit_prices/i.test(sql)) return String(args[0] || '').toLowerCase() === price.model ? price : undefined;
          return undefined;
        },
        run() { return { changes: 0 }; },
      };
    },
  };
}

test('Lingjing public model resolves only the exact dedicated protocol and trusted evidence', () => {
  assert.equal(inferVideoProtocol('lingjing'), 'lingjing_open');
  assert.equal(resolveVideoProtocol(makeConfig()), 'lingjing_open');
  assert.equal(resolveVideoProtocol(makeConfig({ provider: 'custom', api_protocol: 'lingjing_open' })), 'lingjing_open');

  const generic = makeConfig({
    id: 1,
    provider: 'xai',
    api_protocol: 'xai',
    base_url: 'https://seed.alimyun.xyz/api/open/v1',
    is_default: 1,
  });
  const strict = makeConfig({ id: 2 });
  assert.equal(getDefaultVideoConfig(makeDb([generic, strict]), 'lingjing-video-v1', evidenceRoots).id, 2);
  assert.equal(getDefaultVideoConfig(makeDb(generic), 'lingjing-video-v1', evidenceRoots), null);
  assert.equal(getDefaultVideoConfig(makeDb(makeConfig({ verification_status: 'pending' })), 'lingjing-video-v1', evidenceRoots), null);
});

test('Lingjing final submit gate uploads one image and sends relay body without resolution', async () => {
  const calls = [];
  const db = makeDb(makeConfig());
  const result = await callVideoApi(db, { info() {}, warn() {}, error() {} }, {
    model: 'lingjing-video-v1',
    prompt: '一只卡通小猫缓慢走过雨后森林',
    duration: 4,
    aspect_ratio: '16:9',
    resolution: '720p',
    reference_urls: [`data:image/png;base64,${Buffer.from('not-a-real-person').toString('base64')}`],
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/uploads')) return {
        ok: true, status: 200, text: async () => JSON.stringify({ path: 'uploads/reference.png' }),
      };
      return {
        ok: true, status: 200, text: async () => JSON.stringify({ id: 'task-1', status: 'pending' }),
      };
    },
  }, { evidenceRoots });

  assert.deepEqual(result, { task_id: 'task-1', status: 'pending' });
  assert.equal(calls.length, 2);
  const submitted = JSON.parse(calls[1].options.body);
  assert.equal(submitted.model_key, 'relay');
  assert.equal(typeof submitted.request_id, 'string');
  assert.ok(submitted.request_id.length >= 16);
  assert.equal('resolution' in submitted, false);
  assert.deepEqual(submitted.reference_images, ['uploads/reference.png']);
});

test('Lingjing final submit gate fails before supplier fetch for stale evidence or unsupported inputs', async () => {
  for (const [config, request, expectedCode] of [
    [makeConfig({ verification_status: 'pending' }), {}, 'MODEL_NOT_VERIFIED'],
    [makeConfig({ verified_capabilities: JSON.stringify({
      'lingjing-video-v1': { evidence_contract: 'lingjing-video-real-verification-v1', evidence_sha256: '0'.repeat(64) },
    }) }), {}, 'MODEL_NOT_VERIFIED'],
    [makeConfig(), { reference_video_urls: ['https://example.com/ref.mp4'] }, 'VIDEO_REFERENCE_NOT_VERIFIED'],
    [makeConfig(), { reference_audio_urls: ['https://example.com/ref.mp3'] }, 'VIDEO_REFERENCE_NOT_VERIFIED'],
    [makeConfig(), { first_frame_url: 'https://example.com/first.png' }, 'VIDEO_REFERENCE_NOT_VERIFIED'],
  ]) {
    let fetchCalls = 0;
    await assert.rejects(() => callVideoApi(makeDb(config), { info() {}, warn() {}, error() {} }, {
      model: 'lingjing-video-v1',
      prompt: 'animate',
      duration: 4,
      aspect_ratio: '16:9',
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
      ...request,
    }, { evidenceRoots }), (error) => error.code === expectedCode);
    assert.equal(fetchCalls, 0);
  }
});

test('Lingjing polling uses the dedicated status endpoint and fixed authenticated download endpoint', async () => {
  const calls = [];
  const result = await pollVideoTask(
    makeDb(makeConfig()),
    { info() {}, warn() {}, error() {} },
    7,
    'task/with-space',
    makeConfig(),
    1,
    0,
    {
      fetchImpl: async (url) => {
        calls.push(String(url));
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'task/with-space', status: 'completed' }) };
      },
    },
  );
  assert.deepEqual(calls, ['https://seed.alimyun.xyz/api/open/v1/videos/task%2Fwith-space']);
  assert.deepEqual(result, {
    video_url: 'https://seed.alimyun.xyz/api/open/v1/videos/task%2Fwith-space/download',
  });
});
