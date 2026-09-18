'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfig = require('../src/services/aiConfigService');
const creditLedger = require('../src/services/creditLedgerService');
const modelPrice = require('../src/services/modelPriceService');
const providerRouteStability = require('../src/services/providerRouteStabilityService');
const providerTaskReconciliation = require('../src/services/providerTaskReconciliationService');
const providerAssetUrl = require('../src/services/providerAssetUrlService');
const videoClient = require('../src/services/videoClient');
const videoService = require('../src/services/videoService');
const wan3Client = require('../src/services/toapisWan3VideoClient');

const WAN3_MODEL = 'wan3.0-video';
const WAN3_CONTRACT = 'toapis-wan3-video-real-verification-v1';
const log = { info() {}, warn() {}, error() {} };

function createWan3EvidenceRoot() {
  const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wan3-video-service-evidence-'));
  const root = path.join(allowedRoot, 'external-models-v1');
  const publicDir = path.join(root, 'public', 'toapis');
  fs.mkdirSync(publicDir, { recursive: true, mode: 0o755 });
  const file = 'toapis-wan3-video-verification.json';
  const outputFile = 'wan3-video.mp4';
  fs.writeFileSync(path.join(publicDir, outputFile), 'wan3\n', { mode: 0o644 });
  if (process.platform !== 'win32') {
    for (const directory of [allowedRoot, root, path.join(root, 'public'), publicDir]) {
      fs.chmodSync(directory, 0o755);
    }
  }
  const evidence = { allowedRoot, root, roots: { allowedRoot, root }, sha256: null };
  evidence.install = (config) => {
    const apiKey = String(config.api_key || '');
    const configFingerprint = crypto.createHash('sha256').update(JSON.stringify({
      id: String(config.id),
      provider: 'toapis_wan3',
      model: WAN3_MODEL,
      base_url: 'https://toapis.cn',
      api_key: apiKey,
    })).digest('hex');
    const bytes = Buffer.from(JSON.stringify({
      contract_version: WAN3_CONTRACT,
      results: [{
        source_config_id: 16,
        target_config_id: config.id,
        config_id: config.id,
        credential_fingerprint: crypto.createHash('sha256').update(apiKey).digest('hex'),
        config_fingerprint: configFingerprint,
        artifact: { output_file: outputFile },
      }],
    }));
    evidence.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(root, file), bytes, { mode: 0o644 });
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
      contract_version: 'external-model-release-evidence-manifest-v1',
      evidence: {
        [WAN3_CONTRACT]: { file, sha256: evidence.sha256 },
      },
    }), { mode: 0o644 });
    return evidence.sha256;
  };
  return evidence;
}

function setup(t) {
  const evidence = createWan3EvidenceRoot();
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO dramas (title, style, status, metadata, created_at, updated_at) VALUES (?, 'realistic', 'draft', ?, ?, ?)")
    .run('Wan3 视频服务测试', JSON.stringify({ aspect_ratio: '16:9' }), now, now);
  db.prepare("INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, '第一集', ?, ?)")
    .run(now, now);
  db.prepare("INSERT INTO storyboards (episode_id, storyboard_number, title, created_at, updated_at) VALUES (1, 1, '第一镜', ?, ?)")
    .run(now, now);
  modelPrice.set(db, WAN3_MODEL, 10, {
    category: 'video',
    cost_unit: 'second',
    resolution_prices: {
      '480p': { credits: 10, cost_micros_per_second: 50000 },
    },
  });
  t.after(() => {
    db.close();
    fs.rmSync(evidence.allowedRoot, { recursive: true, force: true });
  });
  return { db, evidence, now };
}

function verifiedCapabilities(evidence, overrides = {}) {
  return {
    durations: [2],
    resolutions: ['480p'],
    ratios: ['16:9'],
    audio_values: [false],
    maxReferences: 0,
    maxVideoReferences: 0,
    maxAudioReferences: 0,
    supportsFirstFrame: false,
    supportsLastFrame: false,
    supportsImageReference: false,
    supportsVideoReference: false,
    supportsAudioReference: false,
    supportsAudio: false,
    evidence_contract: WAN3_CONTRACT,
    evidence_sha256: evidence.sha256,
    ...overrides,
  };
}

function configureWan3(db, evidence, options = {}) {
  const apiKey = options.apiKey === undefined ? 'sk-test-wan3' : options.apiKey;
  const config = aiConfig.createConfig(db, log, {
    service_type: 'video',
    provider: options.provider || 'toapis_wan3',
    api_protocol: options.apiProtocol || 'toapis_wan3_video',
    name: options.name || 'ToAPIs Wan 3.0',
    base_url: 'https://toapis.cn',
    api_key: apiKey,
    model: [WAN3_MODEL],
    default_model: WAN3_MODEL,
    is_active: options.isActive !== false,
    is_default: true,
    settings: {},
  });
  if (!evidence.sha256) evidence.install(config);
  const capabilities = verifiedCapabilities(evidence, options.capabilities);
  aiConfig.updateConfig(db, log, config.id, {
    settings: {
      canvas_capabilities_by_model: {
        [WAN3_MODEL]: {
          ...capabilities,
          aspectRatios: capabilities.ratios,
        },
      },
    },
  });
  aiConfig.recordVerification(db, config.id, {
    status: options.verificationStatus || 'verified',
    capabilities: { [WAN3_MODEL]: capabilities },
  });
  return aiConfig.getConfig(db, config.id);
}

function sideEffects(db) {
  return {
    tasks: db.prepare('SELECT COUNT(*) AS count FROM async_tasks').get().count,
    videos: db.prepare('SELECT COUNT(*) AS count FROM video_generations').get().count,
    reservations: db.prepare('SELECT COUNT(*) AS count FROM usage_reservations').get().count,
  };
}

function validRequest(overrides = {}) {
  return {
    drama_id: 1,
    storyboard_id: 1,
    model: WAN3_MODEL,
    prompt: '一个安静的城市早晨镜头',
    duration: 2,
    resolution: '480p',
    aspect_ratio: '16:9',
    generate_audio: false,
    ...overrides,
  };
}

function createWan3(db, evidence, request = {}, options = {}) {
  return videoService.create(db, log, validRequest(request), {
    evidenceRoots: evidence.roots,
    schedule() {},
    ...options,
  });
}

function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('等待 Wan3 恢复分支超时'));
      setTimeout(check, 10);
    };
    check();
  });
}

test('Wan3 accepts only the independent toapis_wan3_video protocol and exact trusted evidence', (t) => {
  for (const invalid of [
    { apiProtocol: 'toapis_video' },
    { provider: 'toapis' },
    { capabilities: { evidence_sha256: '0'.repeat(64) } },
  ]) {
    const { db, evidence } = setup(t);
    configureWan3(db, evidence, invalid);
    assert.throws(
      () => createWan3(db, evidence),
      (error) => error.code === 'MODEL_NOT_VERIFIED',
    );
    assert.deepEqual(sideEffects(db), { tasks: 0, videos: 0, reservations: 0 });
  }
});

test('Wan3 dedicated verified config is selected and pinned before scheduling', (t) => {
  const { db, evidence } = setup(t);
  const config = configureWan3(db, evidence);
  let scheduled = 0;
  const created = videoService.create(db, log, validRequest(), {
    evidenceRoots: evidence.roots,
    schedule() { scheduled += 1; },
  });
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(created.id);
  const pinned = JSON.parse(row.source_conditioning_json).video_capability;
  assert.equal(row.ai_service_config_id, config.id);
  assert.equal(pinned.config_id, config.id);
  assert.equal(pinned.protocol, 'toapis_wan3_video');
  assert.equal(pinned.model, WAN3_MODEL);
  assert.equal(scheduled, 1);
});

test('Wan3 blocks every capability not covered by the paid evidence before side effects', (t) => {
  const cases = [
    [{ duration: 3 }, 'INVALID_VIDEO_DURATION'],
    [{ resolution: '720p' }, 'MODEL_RESOLUTION_PRICE_REQUIRED'],
    [{ aspect_ratio: '9:16' }, 'MODEL_NOT_VERIFIED'],
    [{ generate_audio: true }, 'MODEL_NOT_VERIFIED'],
    [{ reference_image_urls: ['https://cdn.example/ref.png'] }, 'UNSUPPORTED_VIDEO_REFERENCE'],
  ];
  for (const [request, code] of cases) {
    const { db, evidence } = setup(t);
    configureWan3(db, evidence);
    assert.throws(() => createWan3(db, evidence, request), (error) => error.code === code);
    assert.deepEqual(sideEffects(db), { tasks: 0, videos: 0, reservations: 0 });
  }
});

test('Wan3 processing uses the independent adapter and preserves an accepted task for reconciliation', async (t) => {
  const { db, evidence } = setup(t);
  configureWan3(db, evidence);
  creditLedger.setAccountBalance(db, 'user-1', 100);
  let scheduled;
  let wanPosts = 0;
  let wanGets = 0;
  let legacyPosts = 0;
  const originalWanCall = wan3Client.callToapisWan3VideoApi;
  const originalWanFetch = wan3Client.fetchToapisWan3Task;
  const originalLegacyCall = videoClient.callVideoApi;
  wan3Client.callToapisWan3VideoApi = async (_config, _log, options) => {
    wanPosts += 1;
    assert.equal(options.model, WAN3_MODEL);
    assert.equal(options.duration, 2);
    assert.equal(options.resolution, '480p');
    assert.equal(options.generate_audio, false);
    assert.ok(Number(options.video_gen_id) > 0);
    return { task_id: 'wan-task-accepted', status: 'processing' };
  };
  wan3Client.fetchToapisWan3Task = async (_config, taskId) => {
    wanGets += 1;
    assert.equal(taskId, 'wan-task-accepted');
    return { state: 'processing', retryable: true };
  };
  videoClient.callVideoApi = async () => {
    legacyPosts += 1;
    return { error: 'legacy adapter must not run' };
  };
  t.after(() => {
    wan3Client.callToapisWan3VideoApi = originalWanCall;
    wan3Client.fetchToapisWan3Task = originalWanFetch;
    videoClient.callVideoApi = originalLegacyCall;
  });

  const created = videoService.create(db, log, validRequest(), {
    billingEnabled: true,
    userId: 'user-1',
    evidenceRoots: evidence.roots,
    schedule(callback) { scheduled = callback; },
  });
  await scheduled({
    evidenceRoots: evidence.roots,
    wan3PollMaxAttempts: 1,
    wan3PollIntervalMs: 0,
  });

  const row = db.prepare('SELECT status, provider_task_id, error_msg, credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(wanPosts, 1);
  assert.equal(wanGets, 1, row.error_msg);
  assert.equal(legacyPosts, 0);
  assert.equal(row.status, 'needs_attention');
  assert.equal(row.provider_task_id, 'wan-task-accepted');
  assert.match(row.error_msg, /仍可能处理中|最终状态未知/);
  assert.equal(creditLedger.getReservation(db, row.credit_reservation_id).status, 'held');
});

test('Wan3 processing signs platform reference images before direct adapter submission', async (t) => {
  const previousBaseUrl = process.env.STORAGE_BASE_URL;
  const previousSecret = process.env.PLATFORM_JWT_SECRET;
  process.env.STORAGE_BASE_URL = 'https://molimama.vip/static';
  process.env.PLATFORM_JWT_SECRET = 'wan3-provider-asset-signature-secret-at-least-32-characters';
  t.after(() => {
    if (previousBaseUrl == null) delete process.env.STORAGE_BASE_URL;
    else process.env.STORAGE_BASE_URL = previousBaseUrl;
    if (previousSecret == null) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = previousSecret;
  });

  const { db, evidence, now } = setup(t);
  configureWan3(db, evidence, {
    capabilities: { maxReferences: 2, supportsImageReference: true },
  });
  for (const name of ['reference-1.png', 'reference-2.png']) {
    const relativePath = `projects/0001/assets/${name}`;
    db.prepare(`INSERT INTO assets
      (drama_id, name, type, url, local_path, metadata, created_at, updated_at)
      VALUES (1, ?, 'image', ?, ?, '{}', ?, ?)`)
      .run(name, `/static/${relativePath}`, relativePath, now, now);
  }

  let scheduled;
  let submittedOptions;
  const originalWanCall = wan3Client.callToapisWan3VideoApi;
  wan3Client.callToapisWan3VideoApi = async (_config, _log, options) => {
    submittedOptions = options;
    return {
      error: 'capture-only',
      route_meta: {
        phase: 'validation', requestBodySent: false,
        providerCode: 'INVALID_ARGUMENT', explicitlyRejected: true,
      },
    };
  };
  t.after(() => { wan3Client.callToapisWan3VideoApi = originalWanCall; });

  const created = videoService.create(db, log, validRequest({
    reference_image_urls: [
      '/static/projects/0001/assets/reference-1.png',
      '/static/projects/0001/assets/reference-2.png',
    ],
  }), {
    evidenceRoots: evidence.roots,
    schedule(callback) { scheduled = callback; },
  });
  await scheduled({ evidenceRoots: evidence.roots });

  assert.equal(submittedOptions.video_gen_id, created.id);
  assert.equal(submittedOptions.reference_urls.length, 2);
  for (const signedValue of submittedOptions.reference_urls) {
    const signed = new URL(signedValue);
    assert.equal(signed.origin, 'https://molimama.vip');
    assert.ok(signed.searchParams.get(providerAssetUrl.EXPIRES_PARAM));
    assert.ok(signed.searchParams.get(providerAssetUrl.SIGNATURE_PARAM));
    assert.equal(providerAssetUrl.verifyProviderAssetRequest({
      pathname: signed.pathname,
      expires: signed.searchParams.get(providerAssetUrl.EXPIRES_PARAM),
      signature: signed.searchParams.get(providerAssetUrl.SIGNATURE_PARAM),
      secret: process.env.PLATFORM_JWT_SECRET,
    }), true);
  }
  const persisted = db.prepare(`SELECT reference_image_urls, request_snapshot
    FROM video_generations WHERE id = ?`).get(created.id);
  const canonicalReferences = [
    'https://molimama.vip/static/projects/0001/assets/reference-1.png',
    'https://molimama.vip/static/projects/0001/assets/reference-2.png',
  ];
  assert.deepEqual(JSON.parse(persisted.reference_image_urls), canonicalReferences);
  assert.deepEqual(JSON.parse(persisted.request_snapshot).reference_image_urls, canonicalReferences);
});

test('Wan3 accepted unknown task is publicly reconciled once and refunds only terminal failure', async (t) => {
  const { db, evidence } = setup(t);
  const config = configureWan3(db, evidence);
  creditLedger.setAccountBalance(db, 'user-1', 100);
  let scheduled;
  let wanPosts = 0;
  let wanGets = 0;
  const originalWanCall = wan3Client.callToapisWan3VideoApi;
  const originalWanFetch = wan3Client.fetchToapisWan3Task;
  wan3Client.callToapisWan3VideoApi = async () => {
    wanPosts += 1;
    return { task_id: 'wan-task-public-reconcile', status: 'processing' };
  };
  wan3Client.fetchToapisWan3Task = async (_config, taskId) => {
    wanGets += 1;
    assert.equal(taskId, 'wan-task-public-reconcile');
    if (wanGets === 1) return { state: 'processing', retryable: true };
    return {
      state: 'failed',
      terminalFailure: true,
      error: '供应商明确终态失败',
    };
  };
  t.after(() => {
    wan3Client.callToapisWan3VideoApi = originalWanCall;
    wan3Client.fetchToapisWan3Task = originalWanFetch;
  });

  const created = videoService.create(db, log, validRequest(), {
    billingEnabled: true,
    userId: 'user-1',
    evidenceRoots: evidence.roots,
    schedule(callback) { scheduled = callback; },
  });
  await scheduled({
    evidenceRoots: evidence.roots,
    wan3PollMaxAttempts: 1,
    wan3PollIntervalMs: 0,
  });

  const heldVideo = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(created.id);
  const route = db.prepare(`SELECT * FROM generation_route_requests
    WHERE business_type = 'video_generation' AND business_id = ?`).get(String(created.id));
  assert.ok(route, heldVideo.error_msg);
  assert.equal(route.state, 'needs_attention');
  assert.equal(route.credit_reservation_id, heldVideo.credit_reservation_id);
  const attempt = db.prepare(`SELECT * FROM generation_route_attempts
    WHERE request_id = ? ORDER BY attempt_no DESC LIMIT 1`).get(route.id);
  assert.equal(attempt.state, 'needs_attention');
  assert.equal(attempt.config_id, config.id);
  assert.equal(attempt.provider_task_id, 'wan-task-public-reconcile');
  assert.equal(attempt.query_protocol, 'toapis_wan3_video');
  assert.match(attempt.config_fingerprint, /^[a-f0-9]{64}$/);
  const task = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(created.task_id);
  assert.equal(task.user_id, 'user-1');
  assert.equal(task.credit_reservation_id, heldVideo.credit_reservation_id);

  const first = await providerTaskReconciliation.reconcileRequest(db, log, route.id);
  const second = await providerTaskReconciliation.reconcileRequest(db, log, route.id);

  assert.equal(wanPosts, 1);
  assert.equal(wanGets, 2);
  assert.equal(first.task_state, 'failed');
  assert.equal(first.credit_state, 'refunded');
  assert.equal(first.reconciled, true);
  assert.deepEqual(second, first);
  assert.equal(db.prepare('SELECT status FROM video_generations WHERE id = ?').get(created.id).status, 'failed');
  assert.equal(db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(created.task_id).status, 'failed');
  assert.equal(db.prepare('SELECT state FROM generation_route_requests WHERE id = ?').get(route.id).state, 'failed');
  assert.equal(db.prepare(`SELECT state FROM generation_route_attempts
    WHERE request_id = ? AND attempt_no = ?`).get(route.id, attempt.attempt_no).state, 'failed');
  assert.equal(creditLedger.getReservation(db, heldVideo.credit_reservation_id).status, 'refunded');
  assert.deepEqual(creditLedger.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 100, held: 0, spent: 0,
  });
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM credit_ledger
    WHERE reservation_id = ? AND event_type = 'refund'`).get(heldVideo.credit_reservation_id).count, 1);
});

test('Wan3 persists an accepted receipt even when route health changes after submission', async (t) => {
  const { db, evidence } = setup(t);
  const config = configureWan3(db, evidence);
  creditLedger.setAccountBalance(db, 'user-1', 100);
  let scheduled;
  let wanPosts = 0;
  const originalWanCall = wan3Client.callToapisWan3VideoApi;
  const originalWanFetch = wan3Client.fetchToapisWan3Task;
  wan3Client.callToapisWan3VideoApi = async () => {
    wanPosts += 1;
    db.prepare(`INSERT INTO provider_route_health
      (config_id, state, consecutive_failures, updated_at)
      VALUES (?, 'disabled', 0, ?)`)
      .run(config.id, new Date().toISOString());
    return { task_id: 'wan-task-health-changed', status: 'processing' };
  };
  wan3Client.fetchToapisWan3Task = async () => ({ state: 'processing', retryable: true });
  t.after(() => {
    wan3Client.callToapisWan3VideoApi = originalWanCall;
    wan3Client.fetchToapisWan3Task = originalWanFetch;
  });

  const created = videoService.create(db, log, validRequest(), {
    billingEnabled: true,
    userId: 'user-1',
    evidenceRoots: evidence.roots,
    schedule(callback) { scheduled = callback; },
  });
  await scheduled({
    evidenceRoots: evidence.roots,
    wan3PollMaxAttempts: 1,
    wan3PollIntervalMs: 0,
  });

  const video = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(created.id);
  const route = db.prepare(`SELECT * FROM generation_route_requests
    WHERE business_type = 'video_generation' AND business_id = ?`).get(String(created.id));
  assert.equal(wanPosts, 1);
  assert.equal(video.status, 'needs_attention');
  assert.ok(route, video.error_msg);
  assert.equal(route.state, 'needs_attention');
  const attempt = db.prepare(`SELECT * FROM generation_route_attempts
    WHERE request_id = ? ORDER BY attempt_no DESC LIMIT 1`).get(route.id);
  assert.equal(attempt.provider_task_id, 'wan-task-health-changed');
  assert.equal(attempt.query_protocol, 'toapis_wan3_video');
  assert.equal(attempt.state, 'needs_attention');
  assert.equal(creditLedger.getReservation(db, video.credit_reservation_id).status, 'held');
});

test('Wan3 first-poll terminal failure atomically fails route and refunds once', async (t) => {
  const { db, evidence } = setup(t);
  configureWan3(db, evidence);
  creditLedger.setAccountBalance(db, 'user-1', 100);
  let scheduled;
  const originalWanCall = wan3Client.callToapisWan3VideoApi;
  const originalWanFetch = wan3Client.fetchToapisWan3Task;
  wan3Client.callToapisWan3VideoApi = async () => ({
    task_id: 'wan-task-first-poll-failed',
    status: 'processing',
  });
  wan3Client.fetchToapisWan3Task = async () => ({
    state: 'failed',
    terminalFailure: true,
    error: '供应商明确终态失败',
  });
  t.after(() => {
    wan3Client.callToapisWan3VideoApi = originalWanCall;
    wan3Client.fetchToapisWan3Task = originalWanFetch;
  });

  const created = videoService.create(db, log, validRequest(), {
    billingEnabled: true,
    userId: 'user-1',
    evidenceRoots: evidence.roots,
    schedule(callback) { scheduled = callback; },
  });
  await scheduled({
    evidenceRoots: evidence.roots,
    wan3PollMaxAttempts: 1,
    wan3PollIntervalMs: 0,
  });

  const video = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(created.id);
  const task = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(created.task_id);
  const route = db.prepare(`SELECT * FROM generation_route_requests
    WHERE business_type = 'video_generation' AND business_id = ?`).get(String(created.id));
  const attempt = db.prepare(`SELECT * FROM generation_route_attempts
    WHERE request_id = ? ORDER BY attempt_no DESC LIMIT 1`).get(route.id);
  assert.equal(video.status, 'failed');
  assert.equal(task.status, 'failed');
  assert.equal(route.state, 'failed');
  assert.equal(attempt.state, 'failed');
  assert.equal(attempt.provider_task_id, 'wan-task-first-poll-failed');
  assert.equal(creditLedger.getReservation(db, video.credit_reservation_id).status, 'refunded');
  assert.deepEqual(creditLedger.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 100, held: 0, spent: 0,
  });
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM credit_ledger
    WHERE reservation_id = ? AND event_type = 'refund'`).get(video.credit_reservation_id).count, 1);
});

test('Wan3 structured rejection refunds immediately even when the message says unknown', async (t) => {
  const { db, evidence } = setup(t);
  configureWan3(db, evidence);
  creditLedger.setAccountBalance(db, 'user-1', 100);
  let scheduled;
  const originalWanCall = wan3Client.callToapisWan3VideoApi;
  wan3Client.callToapisWan3VideoApi = async () => ({
    error: '状态未知字样不应覆盖供应商明确拒绝证据',
    route_meta: {
      phase: 'submit', requestBodySent: true, httpStatus: 400,
      providerCode: 'INVALID_ARGUMENT', explicitlyRejected: true,
    },
  });
  t.after(() => { wan3Client.callToapisWan3VideoApi = originalWanCall; });

  const created = videoService.create(db, log, validRequest(), {
    billingEnabled: true,
    userId: 'user-1',
    evidenceRoots: evidence.roots,
    schedule(callback) { scheduled = callback; },
  });
  await scheduled({ evidenceRoots: evidence.roots });

  const row = db.prepare('SELECT status, credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(row.status, 'failed');
  assert.equal(creditLedger.getReservation(db, row.credit_reservation_id).status, 'refunded');
  assert.deepEqual(creditLedger.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 100, held: 0, spent: 0,
  });
});

test('Wan3 structured unknown keeps credits held even when the message says definite failure', async (t) => {
  const { db, evidence } = setup(t);
  configureWan3(db, evidence);
  creditLedger.setAccountBalance(db, 'user-1', 100);
  let scheduled;
  const originalWanCall = wan3Client.callToapisWan3VideoApi;
  wan3Client.callToapisWan3VideoApi = async () => ({
    error: '文案声称供应商明确失败',
    route_meta: {
      phase: 'submit', requestBodySent: true, httpStatus: 403,
      explicitlyRejected: false,
    },
  });
  t.after(() => { wan3Client.callToapisWan3VideoApi = originalWanCall; });

  const created = videoService.create(db, log, validRequest(), {
    billingEnabled: true,
    userId: 'user-1',
    evidenceRoots: evidence.roots,
    schedule(callback) { scheduled = callback; },
  });
  await scheduled({ evidenceRoots: evidence.roots });

  const row = db.prepare('SELECT status, credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(row.status, 'needs_attention');
  assert.equal(creditLedger.getReservation(db, row.credit_reservation_id).status, 'held');
  assert.deepEqual(creditLedger.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 80, held: 20, spent: 0,
  });
});

test('Wan3 preclaimed submission never posts again and never refunds the in-flight reservation', async (t) => {
  const { db, evidence } = setup(t);
  const config = configureWan3(db, evidence);
  creditLedger.setAccountBalance(db, 'user-1', 100);
  let scheduled;
  let wanPosts = 0;
  const originalWanCall = wan3Client.callToapisWan3VideoApi;
  wan3Client.callToapisWan3VideoApi = async () => {
    wanPosts += 1;
    return { task_id: 'duplicate-must-not-run' };
  };
  t.after(() => { wan3Client.callToapisWan3VideoApi = originalWanCall; });

  const created = videoService.create(db, log, validRequest(), {
    billingEnabled: true,
    userId: 'user-1',
    evidenceRoots: evidence.roots,
    schedule(callback) { scheduled = callback; },
  });
  const video = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(created.id);
  const reservation = creditLedger.getReservation(db, video.credit_reservation_id);
  const now = new Date().toISOString();
  const route = providerRouteStability.createOrGetRouteRequest(db, {
    id: 'wan3-preclaimed-route',
    idempotencyKey: `user-1:video:${created.id}`,
    serviceType: 'video',
    businessType: 'video_generation',
    businessId: String(created.id),
    tenantId: null,
    userId: 'user-1',
    logicalModelId: config.logical_model_id || video.model,
    capabilities: {
      resolution: '480p',
      aspectRatio: '16:9',
      duration: 2,
      referenceImageCount: 0,
      referenceVideoCount: 0,
      referenceAudioCount: 0,
      requiresAudio: false,
    },
    userPriceSnapshot: { model: reservation.model, credits: reservation.amount },
    candidateConfigIds: [config.id],
    creditReservationId: video.credit_reservation_id,
    now,
  });
  providerRouteStability.startAttempt(db, {
    requestId: route.id,
    configId: config.id,
    upstreamModel: 'wan3.0-video',
    queryProtocol: 'toapis_wan3_video',
    now,
  });

  await scheduled({ evidenceRoots: evidence.roots });

  assert.equal(wanPosts, 0);
  const after = db.prepare('SELECT status, credit_reservation_id FROM video_generations WHERE id = ?')
    .get(created.id);
  assert.equal(after.status, 'needs_attention');
  assert.equal(creditLedger.getReservation(db, after.credit_reservation_id).status, 'held');
  assert.deepEqual(creditLedger.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 80, held: 20, spent: 0,
  });
});

test('Wan3 restart preserves held credits when a preclaimed submission has no provider task id', (t) => {
  const { db, evidence } = setup(t);
  const config = configureWan3(db, evidence);
  creditLedger.setAccountBalance(db, 'user-1', 100);
  const created = createWan3(db, evidence, {}, { billingEnabled: true, userId: 'user-1' });
  const video = db.prepare('SELECT * FROM video_generations WHERE id = ?').get(created.id);
  const reservation = creditLedger.getReservation(db, video.credit_reservation_id);
  const now = new Date().toISOString();
  const route = providerRouteStability.createOrGetRouteRequest(db, {
    id: 'wan3-restart-preclaimed-route',
    idempotencyKey: `user-1:video:${created.id}`,
    serviceType: 'video',
    businessType: 'video_generation',
    businessId: String(created.id),
    tenantId: null,
    userId: 'user-1',
    logicalModelId: config.logical_model_id || video.model,
    capabilities: {
      resolution: '480p', aspectRatio: '16:9', duration: 2,
      referenceImageCount: 0, referenceVideoCount: 0, referenceAudioCount: 0,
      requiresAudio: false,
    },
    userPriceSnapshot: { model: reservation.model, credits: reservation.amount },
    candidateConfigIds: [config.id],
    creditReservationId: video.credit_reservation_id,
    now,
  });
  providerRouteStability.startAttempt(db, {
    requestId: route.id,
    configId: config.id,
    upstreamModel: 'wan3.0-video',
    queryProtocol: 'toapis_wan3_video',
    now,
  });
  db.prepare("UPDATE video_generations SET status = 'processing', provider_task_id = NULL WHERE id = ?")
    .run(created.id);

  videoService.resumeProcessingVideoGenerations(db, log, { evidenceRoots: evidence.roots });

  const after = db.prepare('SELECT status, provider_task_id, credit_reservation_id FROM video_generations WHERE id = ?')
    .get(created.id);
  assert.equal(after.status, 'needs_attention');
  assert.equal(after.provider_task_id, null);
  assert.equal(creditLedger.getReservation(db, after.credit_reservation_id).status, 'held');
  assert.equal(db.prepare('SELECT state FROM generation_route_requests WHERE id = ?').get(route.id).state, 'needs_attention');
  assert.equal(db.prepare(`SELECT state FROM generation_route_attempts
    WHERE request_id = ? ORDER BY attempt_no DESC LIMIT 1`).get(route.id).state, 'needs_attention');
});

test('Wan3 indeterminate submission persists a safe recovery handle and exact request digest without retrying', async (t) => {
  const { db, evidence } = setup(t);
  const config = configureWan3(db, evidence);
  creditLedger.setAccountBalance(db, 'user-1', 100);
  let scheduled;
  let wanPosts = 0;
  let submittedOptions = null;
  const originalWanCall = wan3Client.callToapisWan3VideoApi;
  wan3Client.callToapisWan3VideoApi = async (_config, _log, options) => {
    wanPosts += 1;
    submittedOptions = options;
    return {
      indeterminate: true,
      error: '创建请求结果未知',
      route_meta: {
        phase: 'submit',
        requestBodySent: true,
        recoveryTaskId: `video-${options.video_gen_id}`,
        recoveryCode: 'TOAPIS_WAN3_TRANSPORT_INTERRUPTED',
        httpStatus: 504,
      },
    };
  };
  t.after(() => { wan3Client.callToapisWan3VideoApi = originalWanCall; });

  const created = videoService.create(db, log, validRequest(), {
    billingEnabled: true,
    userId: 'user-1',
    evidenceRoots: evidence.roots,
    schedule(callback) { scheduled = callback; },
  });
  await scheduled({ evidenceRoots: evidence.roots });

  assert.equal(wanPosts, 1);
  assert.equal(submittedOptions.client_business_id, `video-${created.id}`);
  const expectedBody = wan3Client.buildToapisWan3VideoBody(submittedOptions);
  const expectedSha = crypto.createHash('sha256')
    .update(JSON.stringify(expectedBody))
    .digest('hex');
  const video = db.prepare(`SELECT status, provider_task_id, credit_reservation_id
    FROM video_generations WHERE id = ?`).get(created.id);
  assert.equal(video.status, 'needs_attention');
  assert.equal(video.provider_task_id, null);
  assert.equal(creditLedger.getReservation(db, video.credit_reservation_id).status, 'held');

  const route = db.prepare(`SELECT * FROM generation_route_requests
    WHERE business_type = 'video_generation' AND business_id = ?`).get(String(created.id));
  assert.equal(route.state, 'needs_attention');
  assert.equal(route.credit_reservation_id, video.credit_reservation_id);
  const attempt = db.prepare(`SELECT * FROM generation_route_attempts
    WHERE request_id = ? ORDER BY attempt_no DESC LIMIT 1`).get(route.id);
  assert.equal(attempt.config_id, config.id);
  assert.equal(attempt.state, 'needs_attention');
  assert.equal(attempt.provider_task_id, null);
  assert.equal(attempt.error_category, 'submission_unknown');

  const event = db.prepare(`SELECT event_type, task_state, credit_state, safe_details
    FROM provider_stability_events WHERE request_id = ?
      AND event_type = 'submission_unknown_recovery'`).get(route.id);
  assert.equal(event.task_state, 'needs_attention');
  assert.equal(event.credit_state, 'held');
  assert.deepEqual(JSON.parse(event.safe_details), {
    httpStatus: 504,
    recoveryCode: 'TOAPIS_WAN3_TRANSPORT_INTERRUPTED',
    recoveryTaskId: `video-${created.id}`,
    requestBodySent: true,
    requestSha256: expectedSha,
  });
});

test('Wan3 restart recovery polls the saved provider task and never submits again', async (t) => {
  const { db, evidence } = setup(t);
  configureWan3(db, evidence);
  creditLedger.setAccountBalance(db, 'user-1', 100);
  const created = createWan3(db, evidence, {}, { billingEnabled: true, userId: 'user-1' });
  db.prepare("UPDATE video_generations SET status = 'processing', provider_task_id = ? WHERE id = ?")
    .run('wan-task-recovery', created.id);

  let wanPosts = 0;
  let wanGets = 0;
  const originalWanCall = wan3Client.callToapisWan3VideoApi;
  const originalWanFetch = wan3Client.fetchToapisWan3Task;
  wan3Client.callToapisWan3VideoApi = async () => {
    wanPosts += 1;
    return { task_id: 'duplicate-must-not-run' };
  };
  wan3Client.fetchToapisWan3Task = async (_config, taskId) => {
    wanGets += 1;
    assert.equal(taskId, 'wan-task-recovery');
    return { state: 'failed', terminalFailure: true, error: '状态未知字样不能覆盖供应商终态失败' };
  };
  t.after(() => {
    wan3Client.callToapisWan3VideoApi = originalWanCall;
    wan3Client.fetchToapisWan3Task = originalWanFetch;
  });

  videoService.resumeProcessingVideoGenerations(db, log, {
    evidenceRoots: evidence.roots,
    wan3PollMaxAttempts: 1,
    wan3PollIntervalMs: 0,
  });
  await waitFor(() => db.prepare('SELECT status FROM video_generations WHERE id = ?').get(created.id).status === 'failed');

  assert.equal(wanPosts, 0);
  assert.equal(wanGets, 1);
  const row = db.prepare('SELECT provider_task_id, credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(row.provider_task_id, 'wan-task-recovery');
  assert.equal(creditLedger.getReservation(db, row.credit_reservation_id).status, 'refunded');
});

test('Wan3 restart recovery keeps credits held when task query fails', async (t) => {
  const { db, evidence } = setup(t);
  configureWan3(db, evidence);
  creditLedger.setAccountBalance(db, 'user-1', 100);
  const created = createWan3(db, evidence, {}, { billingEnabled: true, userId: 'user-1' });
  db.prepare("UPDATE video_generations SET status = 'processing', provider_task_id = ? WHERE id = ?")
    .run('wan-task-query-failed', created.id);

  let wanPosts = 0;
  let wanGets = 0;
  const originalWanCall = wan3Client.callToapisWan3VideoApi;
  const originalWanFetch = wan3Client.fetchToapisWan3Task;
  wan3Client.callToapisWan3VideoApi = async () => {
    wanPosts += 1;
    return { task_id: 'duplicate-must-not-run' };
  };
  wan3Client.fetchToapisWan3Task = async (_config, taskId) => {
    wanGets += 1;
    assert.equal(taskId, 'wan-task-query-failed');
    return { state: 'failed', queryFailed: true, error: 'ToAPIs 查询任务失败 (502)' };
  };
  t.after(() => {
    wan3Client.callToapisWan3VideoApi = originalWanCall;
    wan3Client.fetchToapisWan3Task = originalWanFetch;
  });

  videoService.resumeProcessingVideoGenerations(db, log, {
    evidenceRoots: evidence.roots,
    wan3PollMaxAttempts: 1,
    wan3PollIntervalMs: 0,
  });
  await waitFor(() => db.prepare('SELECT status FROM video_generations WHERE id = ?').get(created.id).status === 'needs_attention');

  assert.equal(wanPosts, 0);
  assert.equal(wanGets, 1);
  const row = db.prepare('SELECT provider_task_id, credit_reservation_id FROM video_generations WHERE id = ?').get(created.id);
  assert.equal(row.provider_task_id, 'wan-task-query-failed');
  assert.equal(creditLedger.getReservation(db, row.credit_reservation_id).status, 'held');
  assert.deepEqual(creditLedger.getAccount(db, 'user-1'), {
    user_id: 'user-1', available: 80, held: 20, spent: 0,
  });
});

test('Wan3 recovery resolves the persisted config id itself and never accepts a generic selector fallback', async (t) => {
  const { db, evidence } = setup(t);
  const pinnedConfig = configureWan3(db, evidence, { name: 'Wan3 pinned route' });
  const created = createWan3(db, evidence);
  const fallbackConfig = configureWan3(db, evidence, { name: 'Wan3 fallback route' });
  db.prepare("UPDATE video_generations SET status = 'processing', provider_task_id = ? WHERE id = ?")
    .run('wan-task-pinned-config', created.id);

  let genericSelections = 0;
  let wanGets = 0;
  const originalGenericSelector = videoClient.getDefaultVideoConfig;
  const originalWanFetch = wan3Client.fetchToapisWan3Task;
  videoClient.getDefaultVideoConfig = () => {
    genericSelections += 1;
    return fallbackConfig;
  };
  wan3Client.fetchToapisWan3Task = async (config, taskId) => {
    wanGets += 1;
    assert.equal(config.id, pinnedConfig.id);
    assert.equal(taskId, 'wan-task-pinned-config');
    return { state: 'failed', terminalFailure: true, error: '供应商明确失败' };
  };
  t.after(() => {
    videoClient.getDefaultVideoConfig = originalGenericSelector;
    wan3Client.fetchToapisWan3Task = originalWanFetch;
  });

  videoService.resumeProcessingVideoGenerations(db, log, {
    evidenceRoots: evidence.roots,
    wan3PollMaxAttempts: 1,
    wan3PollIntervalMs: 0,
  });
  await waitFor(() => db.prepare('SELECT status FROM video_generations WHERE id = ?').get(created.id).status !== 'processing');

  assert.equal(genericSelections, 0);
  assert.equal(wanGets, 1);
  assert.equal(db.prepare('SELECT status FROM video_generations WHERE id = ?').get(created.id).status, 'failed');
});

test('Wan3 recovery fails closed when the persisted config id no longer exists', async (t) => {
  const { db, evidence } = setup(t);
  configureWan3(db, evidence, { name: 'Wan3 original route' });
  const created = createWan3(db, evidence);
  const fallbackConfig = configureWan3(db, evidence, { name: 'Wan3 fallback route' });
  const pinned = JSON.parse(db.prepare('SELECT source_conditioning_json FROM video_generations WHERE id = ?').get(created.id).source_conditioning_json);
  pinned.video_capability.config_id = 999999;
  db.prepare(`UPDATE video_generations
    SET status = 'processing', provider_task_id = ?, ai_service_config_id = ?, source_conditioning_json = ?
    WHERE id = ?`).run('wan-task-missing-config', 999999, JSON.stringify(pinned), created.id);

  let genericSelections = 0;
  let wanGets = 0;
  const originalGenericSelector = videoClient.getDefaultVideoConfig;
  const originalWanFetch = wan3Client.fetchToapisWan3Task;
  videoClient.getDefaultVideoConfig = () => {
    genericSelections += 1;
    return fallbackConfig;
  };
  wan3Client.fetchToapisWan3Task = async () => {
    wanGets += 1;
    return { state: 'failed', error: '不应该查询其他配置' };
  };
  t.after(() => {
    videoClient.getDefaultVideoConfig = originalGenericSelector;
    wan3Client.fetchToapisWan3Task = originalWanFetch;
  });

  videoService.resumeProcessingVideoGenerations(db, log, {
    evidenceRoots: evidence.roots,
    wan3PollMaxAttempts: 1,
    wan3PollIntervalMs: 0,
  });
  const row = await waitFor(() => {
    const current = db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(created.id);
    return current.status === 'needs_attention' ? current : null;
  });

  assert.equal(genericSelections, 0);
  assert.equal(wanGets, 0);
  assert.match(row.error_msg, /固定模型配置暂不可用|恢复固定配置/);
});
