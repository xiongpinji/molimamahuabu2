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
  const bytes = Buffer.from(JSON.stringify({
    contract_version: WAN3_CONTRACT,
    results: [{ artifact: { output_file: outputFile } }],
  }));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(root, file), bytes, { mode: 0o644 });
  fs.writeFileSync(path.join(publicDir, outputFile), 'wan3\n', { mode: 0o644 });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    contract_version: 'external-model-release-evidence-manifest-v1',
    evidence: {
      [WAN3_CONTRACT]: { file, sha256 },
    },
  }), { mode: 0o644 });
  if (process.platform !== 'win32') {
    for (const directory of [allowedRoot, root, path.join(root, 'public'), publicDir]) {
      fs.chmodSync(directory, 0o755);
    }
  }
  return { allowedRoot, root, roots: { allowedRoot, root }, sha256 };
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
  const config = aiConfig.createConfig(db, log, {
    service_type: 'video',
    provider: options.provider || 'toapis',
    api_protocol: options.apiProtocol || 'toapis_wan3_video',
    name: options.name || 'ToAPIs Wan 3.0',
    base_url: 'https://toapis.xyz',
    api_key: options.apiKey === undefined ? 'sk-test-wan3' : options.apiKey,
    model: [WAN3_MODEL],
    default_model: WAN3_MODEL,
    is_active: options.isActive !== false,
    is_default: true,
  });
  aiConfig.recordVerification(db, config.id, {
    status: options.verificationStatus || 'verified',
    capabilities: {
      [WAN3_MODEL]: verifiedCapabilities(evidence, options.capabilities),
    },
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
  assert.equal(wanGets, 1);
  assert.equal(legacyPosts, 0);
  assert.equal(row.status, 'needs_attention');
  assert.equal(row.provider_task_id, 'wan-task-accepted');
  assert.match(row.error_msg, /仍可能处理中|最终状态未知/);
  assert.equal(creditLedger.getReservation(db, row.credit_reservation_id).status, 'held');
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
