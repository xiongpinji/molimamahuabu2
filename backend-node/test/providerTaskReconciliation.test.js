const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');
const creditLedgerService = require('../src/services/creditLedgerService');
const generationCostLedgerService = require('../src/services/generationCostLedgerService');
const providerRouteCostService = require('../src/services/providerRouteCostService');
const providerRouteStabilityService = require('../src/services/providerRouteStabilityService');
const storageLayout = require('../src/services/storageLayout');
const videoService = require('../src/services/videoService');
const { MINIMAL_MP4 } = require('./fixtures/media');

let reconciliation;
try {
  reconciliation = require('../src/services/providerTaskReconciliationService');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND'
      || !String(error.message).includes('providerTaskReconciliationService')) throw error;
  reconciliation = {};
}

const NOW = '2026-08-22T00:00:00.000Z';
const ARTIFACT_URL = 'https://artifact.example/video.mp4';
const VIDEO_ID = 7001;
const TASK_ID = 'task-reconcile';
const ROUTE_ID = 'route-reconcile';
const PROVIDER_TASK_ID = 'provider-task-reconcile';
const LATE_NOW = '2026-08-22T00:02:01.000Z';
const SNAPSHOT_TABLES = [
  'dramas',
  'video_generations',
  'async_tasks',
  'generation_route_requests',
  'generation_route_attempts',
  'credit_accounts',
  'usage_reservations',
  'credit_ledger',
  'tenant_credit_accounts',
  'tenant_usage_reservations',
  'tenant_credit_ledger',
  'generation_cost_records',
  'provider_stability_events',
  'audit_events',
];

function recordingLog() {
  const entries = [];
  return {
    entries,
    info(message, details) { entries.push({ level: 'info', message, details }); },
    warn(message, details) { entries.push({ level: 'warn', message, details }); },
    error(message, details) { entries.push({ level: 'error', message, details }); },
  };
}

function databaseSnapshot(db) {
  const snapshot = {};
  for (const table of SNAPSHOT_TABLES) {
    snapshot[table] = db.prepare(`SELECT * FROM ${table}`).all()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return JSON.stringify(snapshot);
}

function getReservation(db, reservationId) {
  return db.prepare('SELECT * FROM usage_reservations WHERE id = ?').get(reservationId);
}

function getTenantReservation(db, reservationId) {
  return db.prepare('SELECT * FROM tenant_usage_reservations WHERE id = ?').get(reservationId);
}

function getVideo(db) {
  return db.prepare('SELECT * FROM video_generations WHERE id = ?').get(VIDEO_ID);
}

function getRoute(db) {
  return db.prepare('SELECT * FROM generation_route_requests WHERE id = ?').get(ROUTE_ID);
}

function countSafeEvents(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM provider_stability_events WHERE request_id = ?')
    .get(ROUTE_ID).count;
}

function countAuditEvents(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE resource_id = ?')
    .get(String(VIDEO_ID)).count;
}

function getAttempt(db) {
  return db.prepare(`SELECT * FROM generation_route_attempts
    WHERE request_id = ? ORDER BY attempt_no DESC LIMIT 1`).get(ROUTE_ID);
}

function getTask(db) {
  return db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(TASK_ID);
}

function countReconciledSafeEvents(db) {
  return db.prepare(`SELECT COUNT(*) AS count FROM provider_stability_events
    WHERE request_id = ? AND event_type = 'provider_task_reconciled'`).get(ROUTE_ID).count;
}

function countReconciledAuditEvents(db) {
  return db.prepare(`SELECT COUNT(*) AS count FROM audit_events
    WHERE resource_id = ? AND event_type = 'generation.video.reconciled'`)
    .get(String(VIDEO_ID)).count;
}

function assertSafeResult(result) {
  assert.deepEqual(Object.keys(result).sort(), [
    'checked_at',
    'credit_state',
    'error_category',
    'reconcilable',
    'reconciled',
    'request_id',
    'task_state',
  ]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /provider-task-reconcile|artifact\.example|test-key|toapis|seedance|config_fingerprint|api_key|base_url/,
  );
}

async function assertStaticNotReconcilable(state) {
  let queryCount = 0;
  await assert.rejects(
    reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, {
      now: NOW,
      queryTaskStatusOnce: async () => {
        queryCount += 1;
        return { state: 'processing' };
      },
    }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_TASK_NOT_RECONCILABLE');
      assert.equal(error.message, '该普通生成请求当前不可对账');
      return true;
    },
  );
  assert.equal(queryCount, 0);
  assert.equal(countReconciledSafeEvents(state.db), 0);
  assert.equal(countReconciledAuditEvents(state.db), 0);
}

function setupReconciliationFixture(t, options = {}) {
  const db = new Database(options.databasePath || ':memory:');
  runMigrationsAndEnsure(db);
  generationCostLedgerService.ensureSchema(db);
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-reconciled-video-'));
  const log = recordingLog();
  const userId = options.userId || 'user-reconcile';
  const tenantId = options.tenantId || null;
  const provider = options.provider || 'toapis';
  const configProtocol = options.configProtocol || 'toapis_video';
  const baseUrl = options.baseUrl || 'https://artifact.example/v1';
  const upstreamModel = options.upstreamModel || 'seedance-2-fast';
  if (options.cleanup !== false) {
    t.after(() => {
      db.close();
      fs.rmSync(storagePath, { recursive: true, force: true });
    });
  }

  db.prepare(`INSERT INTO dramas
    (id, title, style, status, metadata, created_at, updated_at)
    VALUES (1, '对账剧', 'realistic', 'draft', NULL, ?, ?)`)
    .run(NOW, NOW);
  db.prepare(`INSERT INTO episodes
    (id, drama_id, episode_number, title, created_at, updated_at)
    VALUES (1, 1, 1, '第一集', ?, ?)`)
    .run(NOW, NOW);
  db.prepare(`INSERT INTO storyboards
    (id, episode_id, storyboard_number, title, created_at, updated_at)
    VALUES (1, 1, 1, '第一镜', ?, ?)`)
    .run(NOW, NOW);

  const createdConfig = aiConfigService.createConfig(db, log, {
    service_type: 'video',
    provider,
    api_protocol: configProtocol,
    name: '对账测试线路',
    base_url: baseUrl,
    api_key: 'test-key',
    model: [upstreamModel],
    default_model: upstreamModel,
    logical_model_id: 'logical-video',
    settings: { canvas_capabilities: { durations: [5], resolutions: ['480p'] } },
  });
  const config = aiConfigService.getConfig(db, createdConfig.id);
  providerRouteCostService.setRouteCost(db, config.id, {
    cost_unit: 'second',
    micros_per_unit: 1000,
  }, { now: NOW });

  db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, message, resource_id, user_id, tenant_id, model, provider_task_id,
     created_at, updated_at)
    VALUES (?, 'video_generation', 'needs_attention', 90, '等待人工对账', ?,
      ?, ?, 'logical-video', ?, ?, ?)`)
    .run(TASK_ID, String(VIDEO_ID), userId, tenantId, PROVIDER_TASK_ID, NOW, NOW);
  db.prepare(`INSERT INTO video_generations
    (id, drama_id, storyboard_id, provider, prompt, model, duration, aspect_ratio, resolution,
     status, task_id, provider_task_id, config_id, user_id, tenant_id, created_at, updated_at)
    VALUES (?, 1, 1, ?, 'fixture prompt', ?, 5, '16:9', '480p',
      'needs_attention', ?, ?, ?, ?, ?, ?, ?)`)
    .run(VIDEO_ID, provider, upstreamModel, TASK_ID, PROVIDER_TASK_ID, config.id, userId, tenantId, NOW, NOW);

  if (tenantId) creditLedgerService.setTenantAccountBalance(db, tenantId, 100);
  else creditLedgerService.setAccountBalance(db, userId, 100);
  const reservation = creditLedgerService.reserve(db, {
    operationKey: 'video-reconcile-7001',
    userId,
    ...(tenantId ? { tenantId, actorUserId: userId } : {}),
    model: 'logical-video',
    resourceType: 'video',
    resourceId: String(VIDEO_ID),
    amount: 5,
  });
  db.prepare('UPDATE video_generations SET credit_reservation_id = ? WHERE id = ?')
    .run(reservation.id, VIDEO_ID);
  db.prepare('UPDATE async_tasks SET credit_reservation_id = ? WHERE id = ?')
    .run(reservation.id, TASK_ID);

  db.prepare(`INSERT INTO generation_route_requests
    (id, idempotency_key, service_type, business_type, business_id, tenant_id, user_id,
     logical_model_id, capability_fingerprint, candidate_config_ids, state,
     credit_reservation_id, final_config_id, created_at, updated_at)
    VALUES (?, 'video-reconcile-7001', 'video', 'video_generation', ?, ?, ?,
      'logical-video', ?, ?, 'needs_attention', ?, ?, ?, ?)`)
    .run(
      ROUTE_ID,
      String(VIDEO_ID),
      tenantId,
      userId,
      'b'.repeat(64),
      JSON.stringify([config.id]),
      reservation.id,
      config.id,
      NOW,
      NOW,
    );
  const receipt = providerRouteStabilityService.buildAttemptReceipt(db, {
    configId: config.id,
    serviceType: 'video',
    upstreamModel,
    queryProtocol: configProtocol,
  });
  db.prepare(`INSERT INTO generation_route_attempts
    (request_id, attempt_no, config_id, provider, upstream_model, state,
      config_fingerprint, query_protocol, started_at, finished_at)
    VALUES (?, 1, ?, ?, ?, 'needs_attention', ?, ?, ?, ?)`)
    .run(
      ROUTE_ID,
      options.attemptConfigId === undefined ? config.id : options.attemptConfigId,
      provider,
      upstreamModel,
      options.configFingerprint === undefined ? receipt.configFingerprint : options.configFingerprint,
      options.queryProtocol === undefined ? configProtocol : options.queryProtocol,
      NOW,
      NOW,
    );
  if (options.bindProviderTask !== false) {
    db.prepare(`UPDATE generation_route_attempts SET provider_task_id = ?
      WHERE request_id = ? AND attempt_no = 1`)
      .run(PROVIDER_TASK_ID, ROUTE_ID);
  }
  db.prepare(`INSERT INTO generation_cost_records
    (reservation_id, model, resolution, cost_unit, quantity, cost_micros, usage_source,
     config_id, cost_source, created_at, updated_at)
    VALUES (?, 'logical-video', '480p', 'unavailable', 0, 0, 'unknown', ?, 'unknown', ?, ?)`)
    .run(reservation.id, config.id, NOW, NOW);
  db.prepare(`INSERT INTO provider_stability_events
    (severity, event_type, request_id, user_ref, logical_model_id, config_id,
     task_state, credit_state, safe_details, created_at)
    VALUES ('warning', 'provider_task_unknown', ?, 'user-reconcile', 'logical-video', ?,
      'needs_attention', 'held', '{}', ?)`)
    .run(ROUTE_ID, config.id, NOW);
  db.prepare(`INSERT INTO audit_events
    (id, user_id, event_type, resource_type, resource_id, outcome, code, created_at)
    VALUES ('audit-reconcile', 'user-reconcile', 'generation.video.needs_attention',
      'video', ?, 'unknown', 'PROVIDER_TASK_UNKNOWN', ?)`)
    .run(String(VIDEO_ID), NOW);

  const drama = db.prepare('SELECT id, title, created_at, metadata FROM dramas WHERE id = 1').get();
  const projectSubdir = storageLayout.buildProjectRelativeDir(drama);
  return {
    db,
    log,
    config,
    video: getVideo(db),
    route: getRoute(db),
    attempt: getAttempt(db),
    task: getTask(db),
    reservation,
    storagePath,
    projectSubdir,
  };
}

function addSameIdUserReservation(db, reservationId, userId) {
  creditLedgerService.setAccountBalance(db, userId, 100);
  const held = creditLedgerService.reserve(db, {
    operationKey: 'video-reconcile-user-collision',
    userId,
    model: 'logical-video',
    resourceType: 'video',
    resourceId: String(VIDEO_ID),
    amount: 7,
  });
  db.prepare('UPDATE usage_reservations SET id = ? WHERE id = ?').run(reservationId, held.id);
  db.prepare('UPDATE credit_ledger SET reservation_id = ? WHERE reservation_id = ?')
    .run(reservationId, held.id);
}

function addSameIdTenantReservation(db, reservationId, tenantId, actorUserId) {
  creditLedgerService.setTenantAccountBalance(db, tenantId, 100);
  const held = creditLedgerService.reserve(db, {
    operationKey: 'video-reconcile-tenant-collision',
    tenantId,
    actorUserId,
    model: 'logical-video',
    resourceType: 'video',
    resourceId: String(VIDEO_ID),
    amount: 7,
  });
  db.prepare('UPDATE tenant_usage_reservations SET id = ? WHERE id = ?').run(reservationId, held.id);
  db.prepare('UPDATE tenant_credit_ledger SET reservation_id = ? WHERE reservation_id = ?')
    .run(reservationId, held.id);
}

async function fixtureVideoFetch(url, requestOptions) {
  assert.equal(url, ARTIFACT_URL);
  assert.equal(Object.hasOwn(requestOptions, 'fetchImpl'), false);
  assert.equal(Object.hasOwn(requestOptions, 'safetyRoot'), false);
  assert.equal(Object.hasOwn(requestOptions, 'requireContainedOutput'), false);
  assert.deepEqual(requestOptions.headers, { Authorization: 'Bearer test-key' });
  return {
    ok: true,
    status: 200,
    async arrayBuffer() { return MINIMAL_MP4; },
  };
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).replace(/\\/g, '/'));
    }
  };
  visit(root);
  return files.sort();
}

function assertSafeArtifactError(error) {
  assert.equal(error.code, 'PROVIDER_TASK_ARTIFACT_UNREADABLE');
  assert.equal(error.message, '视频产物不可读取');
  assert.doesNotMatch(String(error.stack || ''), /artifact\.example|test-key|provider-body-secret/);
  return true;
}

test('prepareReconciledVideoArtifact and discardReconciledVideoArtifact are exported', () => {
  assert.equal(typeof videoService.prepareReconciledVideoArtifact, 'function');
  assert.equal(typeof videoService.discardReconciledVideoArtifact, 'function');
});

test('prepareReconciledVideoArtifact validates and stages a readable video without database writes', async (t) => {
  const state = setupReconciliationFixture(t);
  const before = databaseSnapshot(state.db);

  const prepared = await videoService.prepareReconciledVideoArtifact(
    state.db,
    state.log,
    state.video,
    ARTIFACT_URL,
    state.config,
    { storagePath: state.storagePath, fetchImpl: fixtureVideoFetch },
  );

  assert.match(prepared.localPath, /^projects\/[^/]+\/videos\/vg_/);
  assert.equal(path.isAbsolute(prepared.localPath), false);
  assert.equal(fs.statSync(path.join(state.storagePath, prepared.localPath)).size, MINIMAL_MP4.length);
  assert.equal(prepared.storagePath, state.storagePath);
  assert.equal(prepared.videoUrl, ARTIFACT_URL);
  assert.deepEqual(Object.keys(prepared.boundaryFrames).sort(), [
    'output_first_frame_url',
    'output_last_frame_url',
  ]);
  assert.equal(getReservation(state.db, state.reservation.id).status, 'held');
  assert.equal(getVideo(state.db).status, 'needs_attention');
  assert.equal(getRoute(state.db).state, 'needs_attention');
  assert.equal(countSafeEvents(state.db), 1);
  assert.equal(countAuditEvents(state.db), 1);
  assert.equal(databaseSnapshot(state.db), before);

  videoService.discardReconciledVideoArtifact(prepared);
  assert.equal(fs.existsSync(path.join(state.storagePath, prepared.localPath)), false);
});

test('prepareReconciledVideoArtifact rejects non-2xx without reading or logging provider content', async (t) => {
  const state = setupReconciliationFixture(t);
  const before = databaseSnapshot(state.db);
  let bodyRead = false;

  await assert.rejects(
    videoService.prepareReconciledVideoArtifact(
      state.db,
      state.log,
      state.video,
      ARTIFACT_URL,
      state.config,
      {
        storagePath: state.storagePath,
        fetchImpl: async () => ({
          ok: false,
          status: 503,
          async arrayBuffer() {
            bodyRead = true;
            throw new Error('provider-body-secret');
          },
        }),
      },
    ),
    assertSafeArtifactError,
  );

  assert.equal(bodyRead, false);
  assert.equal(databaseSnapshot(state.db), before);
  assert.deepEqual(listFiles(state.storagePath), []);
  const logged = JSON.stringify(state.log.entries);
  assert.doesNotMatch(logged, /artifact\.example|provider-body-secret|test-key/);
});

test('prepareReconciledVideoArtifact rejects a fake MP4 without database writes', async (t) => {
  const state = setupReconciliationFixture(t);
  const before = databaseSnapshot(state.db);

  await assert.rejects(
    videoService.prepareReconciledVideoArtifact(
      state.db,
      state.log,
      state.video,
      ARTIFACT_URL,
      state.config,
      {
        storagePath: state.storagePath,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          async arrayBuffer() { return Buffer.from('<html>provider-body-secret</html>'); },
        }),
      },
    ),
    assertSafeArtifactError,
  );

  assert.equal(databaseSnapshot(state.db), before);
  assert.deepEqual(listFiles(state.storagePath), []);
  assert.doesNotMatch(JSON.stringify(state.log.entries), /artifact\.example|provider-body-secret|test-key/);
});

test('prepareReconciledVideoArtifact reports a safe file-write failure without database writes', async (t) => {
  const state = setupReconciliationFixture(t);
  const before = databaseSnapshot(state.db);
  const videosPath = path.join(state.storagePath, state.projectSubdir, 'videos');
  fs.mkdirSync(path.dirname(videosPath), { recursive: true });
  fs.writeFileSync(videosPath, 'blocking-file');

  await assert.rejects(
    videoService.prepareReconciledVideoArtifact(
      state.db,
      state.log,
      state.video,
      ARTIFACT_URL,
      state.config,
      { storagePath: state.storagePath, fetchImpl: fixtureVideoFetch },
    ),
    assertSafeArtifactError,
  );

  assert.equal(fs.readFileSync(videosPath, 'utf8'), 'blocking-file');
  assert.equal(databaseSnapshot(state.db), before);
  assert.doesNotMatch(JSON.stringify(state.log.entries), /artifact\.example|test-key/);
});

test('prepareReconciledVideoArtifact rejects a storage parent link before fetch or external writes', async (t) => {
  const state = setupReconciliationFixture(t);
  const beforeDb = databaseSnapshot(state.db);
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-prepare-link-outside-'));
  const markerPath = path.join(outsidePath, 'marker.txt');
  const projectsLink = path.join(state.storagePath, 'projects');
  fs.writeFileSync(markerPath, 'outside-marker');
  fs.symlinkSync(outsidePath, projectsLink, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.rmSync(outsidePath, { recursive: true, force: true }));
  const beforeOutside = listFiles(outsidePath);
  let fetchCalls = 0;

  const outcome = await videoService.prepareReconciledVideoArtifact(
    state.db,
    state.log,
    state.video,
    ARTIFACT_URL,
    state.config,
    {
      storagePath: state.storagePath,
      fetchImpl: async (...args) => {
        fetchCalls += 1;
        return fixtureVideoFetch(...args);
      },
    },
  ).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

  assert.deepEqual({
    rejected: Boolean(outcome.error),
    fetchCalls,
    outsideFiles: listFiles(outsidePath),
    marker: fs.readFileSync(markerPath, 'utf8'),
  }, {
    rejected: true,
    fetchCalls: 0,
    outsideFiles: beforeOutside,
    marker: 'outside-marker',
  });
  assertSafeArtifactError(outcome.error);
  assert.equal(databaseSnapshot(state.db), beforeDb);
});

test('prepareReconciledVideoArtifact removes the staged video when normalize throws', async (t) => {
  const state = setupReconciliationFixture(t);
  const before = databaseSnapshot(state.db);

  await assert.rejects(
    videoService.prepareReconciledVideoArtifact(
      state.db,
      state.log,
      state.video,
      ARTIFACT_URL,
      state.config,
      {
        storagePath: state.storagePath,
        fetchImpl: fixtureVideoFetch,
        normalizeImpl() { throw new Error('normalize provider-body-secret'); },
      },
    ),
    assertSafeArtifactError,
  );

  assert.deepEqual(listFiles(state.storagePath), []);
  assert.equal(databaseSnapshot(state.db), before);
  assert.doesNotMatch(JSON.stringify(state.log.entries), /provider-body-secret/);
});

test('prepareReconciledVideoArtifact uses unique staging frames and preserves old fixed frames on extraction failure', async (t) => {
  const state = setupReconciliationFixture(t);
  const before = databaseSnapshot(state.db);
  const videosPath = path.join(state.storagePath, state.projectSubdir, 'videos');
  const oldFirstPath = path.join(videosPath, `vg_${state.video.id}_first.jpg`);
  const oldLastPath = path.join(videosPath, `vg_${state.video.id}_last.jpg`);
  fs.mkdirSync(videosPath, { recursive: true });
  fs.writeFileSync(oldFirstPath, 'old-first-frame');
  fs.writeFileSync(oldLastPath, 'old-last-frame');
  let stagingFrameId = null;
  let stagedFirstPath = null;

  await assert.rejects(
    videoService.prepareReconciledVideoArtifact(
      state.db,
      state.log,
      state.video,
      ARTIFACT_URL,
      state.config,
      {
        storagePath: state.storagePath,
        fetchImpl: fixtureVideoFetch,
        extractBoundaryFramesImpl(storagePath, localPath, videoGenId) {
          stagingFrameId = videoGenId;
          stagedFirstPath = path.join(
            path.dirname(path.join(storagePath, localPath)),
            `vg_${videoGenId}_first.jpg`,
          );
          fs.writeFileSync(stagedFirstPath, 'partial-frame');
          throw new Error('frame provider-body-secret');
        },
      },
    ),
    assertSafeArtifactError,
  );

  assert.deepEqual({
    stagingFrameIsUnique: String(stagingFrameId) !== String(state.video.id),
    oldFirst: fs.existsSync(oldFirstPath) ? fs.readFileSync(oldFirstPath, 'utf8') : null,
    oldLast: fs.existsSync(oldLastPath) ? fs.readFileSync(oldLastPath, 'utf8') : null,
    stagedFirstExists: stagedFirstPath ? fs.existsSync(stagedFirstPath) : null,
    files: listFiles(state.storagePath),
  }, {
    stagingFrameIsUnique: true,
    oldFirst: 'old-first-frame',
    oldLast: 'old-last-frame',
    stagedFirstExists: false,
    files: [
      `${state.projectSubdir}/videos/vg_${state.video.id}_first.jpg`,
      `${state.projectSubdir}/videos/vg_${state.video.id}_last.jpg`,
    ],
  });
  assert.equal(databaseSnapshot(state.db), before);
  assert.doesNotMatch(JSON.stringify(state.log.entries), /provider-body-secret/);
});

test('discardReconciledVideoArtifact deletes only this staged video and boundary frames idempotently', (t) => {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-discard-video-'));
  t.after(() => fs.rmSync(storagePath, { recursive: true, force: true }));
  const relativeDir = 'projects/0001_20260822_demo/videos';
  const localPath = `${relativeDir}/vg_7001_deadbeef.mp4`;
  const firstFrame = `${relativeDir}/vg_7001_first.jpg`;
  const lastFrame = `${relativeDir}/vg_7001_last.jpg`;
  for (const relative of [localPath, firstFrame, lastFrame]) {
    const absolute = path.join(storagePath, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, relative);
  }

  const prepared = {
    storagePath,
    localPath,
    boundaryFrames: {
      output_first_frame_url: `/static/${firstFrame}`,
      output_last_frame_url: `/static/${lastFrame}`,
    },
  };
  videoService.discardReconciledVideoArtifact(prepared);
  videoService.discardReconciledVideoArtifact(prepared);

  assert.equal(fs.existsSync(path.join(storagePath, localPath)), false);
  assert.equal(fs.existsSync(path.join(storagePath, firstFrame)), false);
  assert.equal(fs.existsSync(path.join(storagePath, lastFrame)), false);
});

test('discardReconciledVideoArtifact rejects absolute, parent escape, and storage-root targets', (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-discard-escape-'));
  const storagePath = path.join(basePath, 'storage');
  const outsidePath = path.join(basePath, 'outside.mp4');
  const insidePath = path.join(storagePath, 'keep.mp4');
  fs.mkdirSync(storagePath);
  fs.writeFileSync(outsidePath, 'outside');
  fs.writeFileSync(insidePath, 'inside');
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));

  videoService.discardReconciledVideoArtifact({
    storagePath,
    localPath: '.',
    boundaryFrames: {
      output_first_frame_url: outsidePath,
      output_last_frame_url: '/static/../outside.mp4',
    },
  });

  assert.equal(fs.existsSync(storagePath), true);
  assert.equal(fs.readFileSync(insidePath, 'utf8'), 'inside');
  assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'outside');
});

test('discardReconciledVideoArtifact does not follow a storage child link outside the root', (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-discard-link-'));
  const storagePath = path.join(basePath, 'storage');
  const outsideDir = path.join(basePath, 'outside');
  const outsideVideo = path.join(outsideDir, 'video.mp4');
  const outsideFrame = path.join(outsideDir, 'frame.jpg');
  const linkPath = path.join(storagePath, 'linked');
  fs.mkdirSync(storagePath);
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(outsideVideo, 'outside-video');
  fs.writeFileSync(outsideFrame, 'outside-frame');
  fs.symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));

  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  videoService.discardReconciledVideoArtifact({
    storagePath,
    localPath: 'linked/video.mp4',
    boundaryFrames: {
      output_first_frame_url: '/static/linked/frame.jpg',
      output_last_frame_url: null,
    },
  });

  assert.equal(fs.readFileSync(outsideVideo, 'utf8'), 'outside-video');
  assert.equal(fs.readFileSync(outsideFrame, 'utf8'), 'outside-frame');
});

test('provider task reconciliation exports fixed lease, debounce, and transaction apply boundaries', () => {
  assert.equal(reconciliation.RECONCILE_LEASE_MS, 120_000);
  assert.equal(reconciliation.RECONCILE_DEBOUNCE_MS, 60_000);
  assert.equal(typeof reconciliation.reconcileRequest, 'function');
  assert.equal(typeof videoService.applyReconciledVideoSuccess, 'function');
  assert.equal(typeof videoService.applyReconciledVideoFailure, 'function');
});

test('reconcileRequest performs one query and confirms readable success atomically', async (t) => {
  const state = setupReconciliationFixture(t);
  let queryCount = 0;

  const result = await reconciliation.reconcileRequest(state.db, state.log, state.route.id, {
    now: NOW,
    storagePath: state.storagePath,
    queryTaskStatusOnce: async () => {
      queryCount += 1;
      return { state: 'succeeded', artifactUrl: ARTIFACT_URL };
    },
    fetchImpl: fixtureVideoFetch,
  });
  const repeated = await reconciliation.reconcileRequest(state.db, state.log, state.route.id, {
    now: NOW,
    queryTaskStatusOnce: async () => {
      queryCount += 1;
      return { state: 'failed', category: 'provider_task_failed' };
    },
  });

  assert.equal(queryCount, 1);
  assert.deepEqual(result, {
    request_id: state.route.id,
    task_state: 'completed',
    error_category: null,
    reconciled: true,
    reconcilable: false,
    credit_state: 'confirmed',
    checked_at: NOW,
  });
  assert.deepEqual(repeated, result);
  assertSafeResult(result);
  assert.equal(getReservation(state.db, state.reservation.id).status, 'confirmed');
  const video = getVideo(state.db);
  assert.equal(video.status, 'completed');
  assert.match(video.video_url, /^\/static\//);
  assert.equal(fs.statSync(path.join(state.storagePath, video.local_path)).size, MINIMAL_MP4.length);
  assert.equal(getTask(state.db).status, 'completed');
  assert.equal(getRoute(state.db).state, 'succeeded');
  assert.equal(getAttempt(state.db).state, 'succeeded');
  assert.equal(getAttempt(state.db).reconcile_claim_token, null);
  assert.equal(countReconciledSafeEvents(state.db), 1);
  assert.equal(countReconciledAuditEvents(state.db), 1);
  const event = state.db.prepare(`SELECT * FROM provider_stability_events
    WHERE request_id = ? AND event_type = 'provider_task_reconciled'`).get(ROUTE_ID);
  assert.doesNotMatch(
    JSON.stringify(event),
    /provider-task-reconcile|artifact\.example|test-key|config_fingerprint|api_key|base_url/,
  );
  const cost = state.db.prepare('SELECT * FROM generation_cost_records WHERE reservation_id = ?')
    .get(state.reservation.id);
  assert.equal(cost.cost_source, 'provider_route');
  assert.equal(cost.cost_micros, 5000);
});

test('tenant reconciliation settles only the tenant reservation when a held user reservation has the same id', async (t) => {
  const cases = [
    ['success', { state: 'succeeded', artifactUrl: ARTIFACT_URL }, 'confirmed', fixtureVideoFetch],
    ['failure', { state: 'failed', category: 'provider_task_failed' }, 'refunded', null],
  ];
  for (const [name, outcome, expectedStatus, fetchImpl] of cases) {
    await t.test(name, async (subtest) => {
      const state = setupReconciliationFixture(subtest, {
        tenantId: 'tenant-reconcile',
        userId: 'tenant-actor',
      });
      addSameIdUserReservation(state.db, state.reservation.id, 'tenant-actor');
      const userAccountBefore = creditLedgerService.getAccount(state.db, 'tenant-actor');
      const userLedgerBefore = state.db.prepare('SELECT * FROM credit_ledger ORDER BY created_at, id').all();
      let queryCount = 0;

      const result = await reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, {
        now: NOW,
        storagePath: state.storagePath,
        queryTaskStatusOnce: async () => {
          queryCount += 1;
          return outcome;
        },
        ...(fetchImpl ? { fetchImpl } : {}),
      });

      assert.equal(queryCount, 1);
      assert.equal(result.credit_state, expectedStatus);
      assert.equal(getTenantReservation(state.db, state.reservation.id).status, expectedStatus);
      assert.equal(getReservation(state.db, state.reservation.id).status, 'held');
      assert.deepEqual(creditLedgerService.getAccount(state.db, 'tenant-actor'), userAccountBefore);
      assert.deepEqual(
        state.db.prepare('SELECT * FROM credit_ledger ORDER BY created_at, id').all(),
        userLedgerBefore,
      );
      assert.deepEqual(
        creditLedgerService.getTenantAccount(state.db, 'tenant-reconcile'),
        expectedStatus === 'confirmed'
          ? { tenant_id: 'tenant-reconcile', available: 95, held: 0, spent: 5 }
          : { tenant_id: 'tenant-reconcile', available: 100, held: 0, spent: 0 },
      );
      assert.equal(
        state.db.prepare(`SELECT COUNT(*) AS count FROM tenant_credit_ledger
          WHERE reservation_id = ? AND event_type = ?`).get(
          state.reservation.id,
          expectedStatus === 'confirmed' ? 'confirm' : 'refund',
        ).count,
        1,
      );
    });
  }
});

test('user reconciliation settles only its user reservation when a held tenant reservation has the same id', async (t) => {
  const state = setupReconciliationFixture(t);
  addSameIdTenantReservation(state.db, state.reservation.id, 'tenant-collision', 'user-reconcile');
  const tenantAccountBefore = creditLedgerService.getTenantAccount(state.db, 'tenant-collision');
  const tenantLedgerBefore = state.db.prepare(
    'SELECT * FROM tenant_credit_ledger ORDER BY created_at, id'
  ).all();
  let queryCount = 0;

  const result = await reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, {
    now: NOW,
    storagePath: state.storagePath,
    queryTaskStatusOnce: async () => {
      queryCount += 1;
      return { state: 'succeeded', artifactUrl: ARTIFACT_URL };
    },
    fetchImpl: fixtureVideoFetch,
  });

  assert.equal(queryCount, 1);
  assert.equal(result.credit_state, 'confirmed');
  assert.equal(getReservation(state.db, state.reservation.id).status, 'confirmed');
  assert.equal(getTenantReservation(state.db, state.reservation.id).status, 'held');
  assert.deepEqual(creditLedgerService.getTenantAccount(state.db, 'tenant-collision'), tenantAccountBefore);
  assert.deepEqual(
    state.db.prepare('SELECT * FROM tenant_credit_ledger ORDER BY created_at, id').all(),
    tenantLedgerBefore,
  );
});

test('reconcileRequest rejects every static evidence and identity blocker before query', async (t) => {
  const cases = [
    ['missing provider task id', { bindProviderTask: false }, () => {}],
    ['missing config fingerprint', { configFingerprint: null }, () => {}],
    ['missing query protocol', { queryProtocol: null }, () => {}],
    ['invalid config id', { attemptConfigId: 0 }, () => {}],
    ['missing attempt', {}, (state) => state.db.prepare(
      'DELETE FROM generation_route_attempts WHERE request_id = ?'
    ).run(ROUTE_ID)],
    ['image service', {}, (state) => state.db.prepare(
      "UPDATE generation_route_requests SET service_type = 'image' WHERE id = ?"
    ).run(ROUTE_ID)],
    ['non-video business type', {}, (state) => state.db.prepare(
      "UPDATE generation_route_requests SET business_type = 'image_generation' WHERE id = ?"
    ).run(ROUTE_ID)],
    ['route not needs_attention', {}, (state) => state.db.prepare(
      "UPDATE generation_route_requests SET state = 'running' WHERE id = ?"
    ).run(ROUTE_ID)],
    ['attempt not needs_attention', {}, (state) => state.db.prepare(
      "UPDATE generation_route_attempts SET state = 'accepted' WHERE request_id = ?"
    ).run(ROUTE_ID)],
    ['video not needs_attention', {}, (state) => state.db.prepare(
      "UPDATE video_generations SET status = 'processing' WHERE id = ?"
    ).run(VIDEO_ID)],
    ['task not needs_attention', {}, (state) => state.db.prepare(
      "UPDATE async_tasks SET status = 'processing' WHERE id = ?"
    ).run(TASK_ID)],
    ['task is not video generation', {}, (state) => state.db.prepare(
      "UPDATE async_tasks SET type = 'image_generation' WHERE id = ?"
    ).run(TASK_ID)],
    ['business record missing', {}, (state) => state.db.prepare(
      'UPDATE video_generations SET deleted_at = ? WHERE id = ?'
    ).run(NOW, VIDEO_ID)],
    ['task record missing', {}, (state) => state.db.prepare(
      "UPDATE video_generations SET task_id = 'missing-task' WHERE id = ?"
    ).run(VIDEO_ID)],
    ['reservation missing', {}, (state) => state.db.prepare(
      'UPDATE generation_route_requests SET credit_reservation_id = NULL WHERE id = ?'
    ).run(ROUTE_ID)],
    ['route owner missing', {}, (state) => state.db.prepare(
      'UPDATE generation_route_requests SET user_id = NULL WHERE id = ?'
    ).run(ROUTE_ID)],
    ['reservation not held', {}, (state) => creditLedgerService.confirm(
      state.db,
      state.reservation.id,
    )],
    ['reservation resource type is not video', {}, (state) => state.db.prepare(
      "UPDATE usage_reservations SET resource_type = 'image' WHERE id = ?"
    ).run(state.reservation.id)],
    ['reservation belongs to another video', {}, (state) => state.db.prepare(
      "UPDATE usage_reservations SET resource_id = '7002' WHERE id = ?"
    ).run(state.reservation.id)],
    ['reservation user differs from route', {}, (state) => state.db.prepare(
      "UPDATE usage_reservations SET user_id = 'other-user' WHERE id = ?"
    ).run(state.reservation.id)],
    ['video user differs from route', {}, (state) => state.db.prepare(
      "UPDATE video_generations SET user_id = 'other-user' WHERE id = ?"
    ).run(VIDEO_ID)],
    ['task user differs from route', {}, (state) => state.db.prepare(
      "UPDATE async_tasks SET user_id = 'other-user' WHERE id = ?"
    ).run(TASK_ID)],
    ['current config missing', {}, (state) => state.db.prepare(
      'UPDATE ai_service_configs SET deleted_at = ? WHERE id = ?'
    ).run(NOW, state.config.id)],
    ['video task receipt mismatch', {}, (state) => state.db.prepare(
      "UPDATE video_generations SET provider_task_id = 'different-task' WHERE id = ?"
    ).run(VIDEO_ID)],
    ['async task reservation mismatch', {}, (state) => state.db.prepare(
      "UPDATE async_tasks SET credit_reservation_id = 'different-reservation' WHERE id = ?"
    ).run(TASK_ID)],
  ];

  for (const [name, fixtureOptions, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const state = setupReconciliationFixture(subtest, fixtureOptions);
      mutate(state);
      await assertStaticNotReconcilable(state);
    });
  }
});

test('tenant reconciliation requires reservation, video, and task tenant identity before query', async (t) => {
  const cases = [
    ['reservation tenant', (state) => state.db.prepare(
      "UPDATE tenant_usage_reservations SET tenant_id = 'other-tenant' WHERE id = ?"
    ).run(state.reservation.id)],
    ['video tenant', (state) => state.db.prepare(
      "UPDATE video_generations SET tenant_id = 'other-tenant' WHERE id = ?"
    ).run(VIDEO_ID)],
    ['task tenant', (state) => state.db.prepare(
      "UPDATE async_tasks SET tenant_id = 'other-tenant' WHERE id = ?"
    ).run(TASK_ID)],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const state = setupReconciliationFixture(subtest, {
        tenantId: 'tenant-reconcile',
        userId: 'tenant-actor',
      });
      mutate(state);
      await assertStaticNotReconcilable(state);
    });
  }
});

test('reconcileRequest blocks current key, base URL, protocol, provider, model, and capability drift before query', async (t) => {
  const cases = [
    ['key', 'UPDATE ai_service_configs SET api_key = ? WHERE id = ?', ['rotated-key']],
    ['credential', 'UPDATE ai_service_configs SET api_key = ? WHERE id = ?', ['']],
    ['base URL', 'UPDATE ai_service_configs SET base_url = ? WHERE id = ?', ['https://changed.example/v1']],
    ['protocol', 'UPDATE ai_service_configs SET api_protocol = ? WHERE id = ?', ['feituo_video']],
    ['provider', 'UPDATE ai_service_configs SET provider = ? WHERE id = ?', ['feituo']],
    [
      'model',
      'UPDATE ai_service_configs SET model = ?, default_model = ? WHERE id = ?',
      [JSON.stringify(['another-model']), 'another-model'],
    ],
    [
      'capability',
      'UPDATE ai_service_configs SET settings = ? WHERE id = ?',
      [JSON.stringify({ canvas_capabilities: { durations: [10], resolutions: ['720p'] } })],
    ],
  ];

  for (const [name, sql, params] of cases) {
    await t.test(name, async (subtest) => {
      const state = setupReconciliationFixture(subtest);
      state.db.prepare(sql).run(...params, state.config.id);
      await assertStaticNotReconcilable(state);
    });
  }
});

test('reconcileRequest preserves invalid-id and missing-route coded errors without query', async (t) => {
  const state = setupReconciliationFixture(t);
  let queryCount = 0;
  const options = {
    queryTaskStatusOnce: async () => {
      queryCount += 1;
      return { state: 'processing' };
    },
  };
  await assert.rejects(
    reconciliation.reconcileRequest(state.db, state.log, 'bad request id!', options),
    (error) => error.code === 'PROVIDER_TASK_REQUEST_INVALID',
  );
  await assert.rejects(
    reconciliation.reconcileRequest(state.db, state.log, 'route-missing', options),
    (error) => error.code === 'PROVIDER_TASK_REQUEST_NOT_FOUND',
  );
  assert.equal(queryCount, 0);
});

test('reconcileRequest uses the immutable attempt receipt without requiring a duplicate task receipt', async (t) => {
  const state = setupReconciliationFixture(t);
  state.db.prepare('UPDATE async_tasks SET provider_task_id = NULL WHERE id = ?').run(TASK_ID);
  let queryCount = 0;

  const result = await reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, {
    now: NOW,
    queryTaskStatusOnce: async () => {
      queryCount += 1;
      return { state: 'processing' };
    },
  });

  assert.equal(queryCount, 1);
  assert.equal(result.task_state, 'needs_attention');
  assert.equal(result.credit_state, 'held');
  assert.equal(result.error_category, 'result_unknown');
});

test('terminal safe reconciliation DTO suppresses unsafe legacy fields', async (t) => {
  const state = setupReconciliationFixture(t);
  state.db.prepare(`UPDATE generation_route_requests SET state = 'succeeded' WHERE id = ?`)
    .run(ROUTE_ID);
  state.db.prepare(`UPDATE generation_route_attempts SET error_category = ? WHERE request_id = ?`)
    .run('https://secret.example/?api_key=leaked', ROUTE_ID);

  const result = await reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, {
    now: NOW,
    queryTaskStatusOnce: async () => assert.fail('query must not run'),
  });

  assert.equal(result.error_category, null);
  assert.doesNotMatch(JSON.stringify(result), /secret|api_key|https?:\/\//i);

  state.db.prepare(`UPDATE video_generations SET status = ? WHERE id = ?`)
    .run('https://secret.example/task', VIDEO_ID);
  state.db.prepare(`UPDATE generation_route_attempts SET reconcile_checked_at = ? WHERE request_id = ?`)
    .run('https://secret.example/checked', ROUTE_ID);
  const unsafeState = await reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, { now: NOW });
  assert.equal(unsafeState.task_state, null);
  assert.equal(unsafeState.checked_at, null);
  assert.doesNotMatch(JSON.stringify(unsafeState), /secret|https?:\/\//i);

  state.db.prepare(`UPDATE video_generations SET status = 'needs_attention' WHERE id = ?`).run(VIDEO_ID);
  state.db.prepare(`UPDATE generation_route_attempts SET error_category = ? WHERE request_id = ?`)
    .run('submission_unknown', ROUTE_ID);
  const safeLegacy = await reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, { now: NOW });
  assert.equal(safeLegacy.error_category, 'submission_unknown');
});

test('reconcileRequest permits only one query across two database connections', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-reconcile-concurrent-'));
  const databasePath = path.join(root, 'reconcile.sqlite');
  const state = setupReconciliationFixture(t, { databasePath, cleanup: false });
  const secondDb = new Database(databasePath);
  let releaseQuery;
  let queryCount = 0;
  t.after(() => {
    secondDb.close();
    state.db.close();
    fs.rmSync(state.storagePath, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  const first = reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, {
    now: NOW,
    storagePath: state.storagePath,
    queryTaskStatusOnce: async () => {
      queryCount += 1;
      return new Promise((resolve) => { releaseQuery = resolve; });
    },
    fetchImpl: fixtureVideoFetch,
  });
  await Promise.resolve();
  const second = await reconciliation.reconcileRequest(secondDb, state.log, ROUTE_ID, {
    now: NOW,
    queryTaskStatusOnce: async () => {
      queryCount += 1;
      return { state: 'processing' };
    },
  });
  assert.equal(second.reconcilable, false);
  releaseQuery({ state: 'succeeded', artifactUrl: ARTIFACT_URL });
  const firstResult = await first;

  assert.equal(queryCount, 1);
  assert.equal(firstResult.task_state, 'completed');
  assert.equal(countReconciledSafeEvents(state.db), 1);
});

test('reconcileRequest honors a live 120 second lease and 60 second debounce', async (t) => {
  const cases = [
    ['live lease', (state) => state.db.prepare(`UPDATE generation_route_attempts
      SET reconcile_claim_token = 'other-claim', reconcile_lease_until = ? WHERE request_id = ?`)
      .run(LATE_NOW, ROUTE_ID)],
    ['debounce', (state) => state.db.prepare(`UPDATE generation_route_attempts
      SET reconcile_checked_at = ? WHERE request_id = ?`).run(NOW, ROUTE_ID)],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const state = setupReconciliationFixture(subtest);
      mutate(state);
      let queryCount = 0;
      const result = await reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, {
        now: NOW,
        queryTaskStatusOnce: async () => {
          queryCount += 1;
          return { state: 'processing' };
        },
      });
      assert.equal(queryCount, 0);
      assert.equal(result.reconcilable, false);
      assertSafeResult(result);
    });
  }
});

test('reconcileRequest refunds only explicit provider task failure and is terminally idempotent', async (t) => {
  const state = setupReconciliationFixture(t);
  let queryCount = 0;
  const options = {
    now: NOW,
    queryTaskStatusOnce: async () => {
      queryCount += 1;
      return { state: 'failed', category: 'provider_task_failed' };
    },
  };

  const first = await reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, options);
  const second = await reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, options);

  assert.equal(queryCount, 1);
  assert.deepEqual(first, {
    request_id: ROUTE_ID,
    task_state: 'failed',
    error_category: 'provider_task_failed',
    reconciled: true,
    reconcilable: false,
    credit_state: 'refunded',
    checked_at: NOW,
  });
  assert.deepEqual(second, first);
  assertSafeResult(first);
  assert.equal(getReservation(state.db, state.reservation.id).status, 'refunded');
  assert.equal(getVideo(state.db).status, 'failed');
  assert.equal(getTask(state.db).status, 'failed');
  assert.equal(getRoute(state.db).state, 'failed');
  assert.equal(getAttempt(state.db).state, 'failed');
  assert.equal(countReconciledSafeEvents(state.db), 1);
  assert.equal(countReconciledAuditEvents(state.db), 1);
  const cost = state.db.prepare('SELECT * FROM generation_cost_records WHERE reservation_id = ?')
    .get(state.reservation.id);
  assert.equal(cost.cost_source, 'unknown');
  assert.equal(cost.cost_micros, 0);
});

test('supported parser protocols hold credits without an artifact and refund explicit failure', async (t) => {
  const protocols = [
    {
      name: 'ToAPIs',
      provider: 'toapis',
      configProtocol: 'toapis_video',
      baseUrl: 'https://toapis.xyz',
      completedCases: ['success', 'succeeded', 'completed', 'done'].map((status) => ({
        name: status,
        payload: { status, result: { data: [] } },
      })),
      failed: {
        status: 'failed',
        error: { message: 'ToAPIs 任务完成但未返回视频地址' },
      },
    },
    {
      name: 'DJPSD legacy',
      provider: 'djpsd',
      configProtocol: 'djpsd',
      baseUrl: 'https://relay.invalid',
      completedCases: ['success', 'succeeded', 'completed'].map((status) => ({
        name: status,
        payload: { code: 200, data: { status } },
      })),
      failed: { code: 200, data: { status: 'failed', error_message: 'provider detail must stay internal' } },
    },
    {
      name: 'DJPSD OpenAPI',
      provider: 'djpsd_openapi',
      configProtocol: 'djpsd_openapi',
      baseUrl: 'https://relay.invalid/openapi',
      completedCases: [{ name: 'completed', payload: { data: { state: 'completed' } } }],
      failed: { data: { state: 'failed', message: 'provider detail must stay internal' } },
    },
    {
      name: 'Token6688',
      provider: 'token6688',
      configProtocol: 'token6688',
      baseUrl: 'https://relay.invalid/v1',
      completedCases: [{
        name: 'completed',
        payload: { status: 'completed', result: { videos: [] } },
      }],
      failed: { status: 'failed', error: { message: 'provider detail must stay internal' } },
    },
    {
      name: 'Feituo',
      provider: 'feituo',
      configProtocol: 'feituo_open',
      baseUrl: 'https://relay.invalid/v1',
      completedCases: ['success', 'succeeded', 'completed', 'done'].map((status) => ({
        name: status,
        payload: { status },
      })),
      failed: { status: 'failed', errorMessage: '飞拓任务完成但未返回视频地址' },
    },
    {
      name: 'USMercari',
      provider: 'usmercari',
      configProtocol: 'usmercari_media',
      baseUrl: 'https://relay.invalid/v1',
      completedCases: [{
        name: 'SUCCESS',
        payload: {
          data: [{ task_id: PROVIDER_TASK_ID, status: 'SUCCESS', data: { items: [] } }],
        },
      }],
      failed: {
        data: [{
          task_id: PROVIDER_TASK_ID,
          status: 'FAILURE',
          fail_reason: 'USMercari 任务完成但未返回视频地址',
        }],
      },
    },
    {
      name: 'Fumin',
      provider: 'fumin',
      configProtocol: 'fumin_video',
      baseUrl: 'https://relay.invalid/v1',
      upstreamModel: 'fumin-seedance-2.0-fast',
      completedCases: ['success', 'succeeded', 'completed', 'done'].map((status) => ({
        name: status,
        payload: { status },
      })),
      failed: { status: 'failed', error: { message: 'fumin 任务已完成但未返回视频地址' } },
    },
  ];

  for (const protocol of protocols) {
    for (const completedCase of protocol.completedCases) {
      await t.test(`${protocol.name} ${completedCase.name} without URL`, async (subtest) => {
        const state = setupReconciliationFixture(subtest, protocol);
        let queryCount = 0;
        const result = await reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, {
          now: NOW,
          queryFetchImpl: async () => {
            queryCount += 1;
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify(completedCase.payload),
            };
          },
        });

        assert.equal(queryCount, 1);
        assert.equal(result.error_category, 'artifact_unreadable');
        assert.equal(result.task_state, 'needs_attention');
        assert.equal(result.credit_state, 'held');
        assert.equal(getReservation(state.db, state.reservation.id).status, 'held');
        assert.equal(getVideo(state.db).status, 'needs_attention');
        assert.equal(getTask(state.db).status, 'needs_attention');
        assert.equal(getRoute(state.db).state, 'needs_attention');
        assert.equal(getAttempt(state.db).state, 'needs_attention');
        assert.equal(state.db.prepare(`SELECT COUNT(*) AS count FROM credit_ledger
          WHERE reservation_id = ? AND event_type = 'refund'`).get(state.reservation.id).count, 0);
        assert.equal(countReconciledSafeEvents(state.db), 0);
        assert.equal(countReconciledAuditEvents(state.db), 0);
      });
    }

    await t.test(`${protocol.name} explicit failure`, async (subtest) => {
      const state = setupReconciliationFixture(subtest, protocol);
      let queryCount = 0;
      const result = await reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, {
        now: NOW,
        queryFetchImpl: async () => {
          queryCount += 1;
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(protocol.failed),
          };
        },
      });

      assert.equal(queryCount, 1);
      assert.equal(result.error_category, 'provider_task_failed');
      assert.equal(result.task_state, 'failed');
      assert.equal(result.credit_state, 'refunded');
      assert.equal(getReservation(state.db, state.reservation.id).status, 'refunded');
      assert.equal(getVideo(state.db).status, 'failed');
      assert.equal(getTask(state.db).status, 'failed');
      assert.equal(getRoute(state.db).state, 'failed');
      assert.equal(getAttempt(state.db).state, 'failed');
      assert.equal(state.db.prepare(`SELECT COUNT(*) AS count FROM credit_ledger
        WHERE reservation_id = ? AND event_type = 'refund'`).get(state.reservation.id).count, 1);
      assert.equal(countReconciledSafeEvents(state.db), 1);
      assert.equal(countReconciledAuditEvents(state.db), 1);
      assert.doesNotMatch(JSON.stringify(result), /provider detail/);
    });
  }
});

test('reconcileRequest keeps credits held for processing, query faults, unsafe success, and unreadable artifacts', async (t) => {
  const outcomes = [
    ['processing', async () => ({ state: 'processing' }), 'result_unknown', null],
    ['timeout', async () => { const error = new Error('secret timeout'); error.name = 'TimeoutError'; throw error; }, 'result_unknown', null],
    ['401', async () => ({ state: 'query_failed', category: 'auth_unavailable' }), 'auth_unavailable', null],
    ['403', async () => ({ state: 'query_failed', category: 'forbidden_unknown' }), 'forbidden_unknown', null],
    ['404', async () => ({ state: 'unknown', category: 'result_unknown' }), 'result_unknown', null],
    ['408', async () => ({ state: 'unknown', category: 'result_unknown' }), 'result_unknown', null],
    ['429', async () => ({ state: 'query_failed', category: 'rate_limited' }), 'rate_limited', null],
    ['5xx', async () => ({ state: 'query_failed', category: 'provider_unavailable' }), 'provider_unavailable', null],
    ['non-JSON', async () => ({ state: 'query_failed', category: 'query_protocol_error' }), 'query_protocol_error', null],
    ['redirect', async () => ({ state: 'query_failed', category: 'query_protocol_error' }), 'query_protocol_error', null],
    ['success without direct artifact', async () => ({ state: 'succeeded' }), 'artifact_unreadable', null],
    [
      'unreadable artifact',
      async () => ({ state: 'succeeded', artifactUrl: ARTIFACT_URL }),
      'artifact_unreadable',
      async () => ({ ok: true, status: 200, async arrayBuffer() { return Buffer.from('not-video'); } }),
    ],
  ];

  for (const [name, queryTaskStatusOnce, category, fetchImpl] of outcomes) {
    await t.test(name, async (subtest) => {
      const state = setupReconciliationFixture(subtest);
      let queryCount = 0;
      const result = await reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, {
        now: NOW,
        storagePath: state.storagePath,
        queryTaskStatusOnce: async (...args) => {
          queryCount += 1;
          return queryTaskStatusOnce(...args);
        },
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      assert.equal(queryCount, 1);
      assert.equal(result.error_category, category);
      assert.equal(result.task_state, 'needs_attention');
      assert.equal(result.credit_state, 'held');
      assert.equal(result.reconciled, false);
      assert.equal(result.reconcilable, false);
      assert.equal(result.checked_at, NOW);
      assertSafeResult(result);
      assert.equal(getReservation(state.db, state.reservation.id).status, 'held');
      assert.equal(getVideo(state.db).status, 'needs_attention');
      assert.equal(getTask(state.db).status, 'needs_attention');
      assert.equal(getRoute(state.db).state, 'needs_attention');
      assert.equal(getAttempt(state.db).state, 'needs_attention');
      assert.equal(getAttempt(state.db).reconcile_claim_token, null);
      assert.equal(countReconciledSafeEvents(state.db), 0);
      assert.equal(countReconciledAuditEvents(state.db), 0);
      assert.deepEqual(listFiles(state.storagePath), []);
      assert.doesNotMatch(JSON.stringify(state.log.entries), /secret timeout|test-key|provider-task-reconcile/);
    });
  }
});

test('terminal write failure rolls route, media, task, credits, cost, event, and audit back', async (t) => {
  const cases = [
    ['success', { state: 'succeeded', artifactUrl: ARTIFACT_URL }, fixtureVideoFetch],
    ['failure', { state: 'failed', category: 'provider_task_failed' }, null],
  ];

  for (const [name, outcome, fetchImpl] of cases) {
    await t.test(name, async (subtest) => {
      const state = setupReconciliationFixture(subtest);
      const costBefore = state.db.prepare(
        'SELECT * FROM generation_cost_records WHERE reservation_id = ?'
      ).get(state.reservation.id);
      state.db.exec(`CREATE TRIGGER abort_reconciled_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.event_type = 'generation.video.reconciled'
        BEGIN SELECT RAISE(ABORT, 'forced terminal write failure'); END`);

      await assert.rejects(
        reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, {
          now: NOW,
          storagePath: state.storagePath,
          queryTaskStatusOnce: async () => outcome,
          ...(fetchImpl ? { fetchImpl } : {}),
        }),
        /forced terminal write failure/,
      );

      assert.equal(getReservation(state.db, state.reservation.id).status, 'held');
      assert.equal(getVideo(state.db).status, 'needs_attention');
      assert.equal(getTask(state.db).status, 'needs_attention');
      assert.equal(getRoute(state.db).state, 'needs_attention');
      assert.equal(getAttempt(state.db).state, 'needs_attention');
      assert.equal(getAttempt(state.db).reconcile_checked_at, null);
      assert.deepEqual(
        state.db.prepare('SELECT * FROM generation_cost_records WHERE reservation_id = ?')
          .get(state.reservation.id),
        costBefore,
      );
      assert.equal(countReconciledSafeEvents(state.db), 0);
      assert.equal(countReconciledAuditEvents(state.db), 0);
      assert.deepEqual(listFiles(state.storagePath), []);
    });
  }
});

test('late old claim loses CAS, discards its staged artifact, and cannot overwrite newer state', async (t) => {
  const state = setupReconciliationFixture(t);
  let resolveOldQuery;
  let queryCount = 0;
  const oldRequest = reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, {
    now: NOW,
    storagePath: state.storagePath,
    queryTaskStatusOnce: async () => {
      queryCount += 1;
      return new Promise((resolve) => { resolveOldQuery = resolve; });
    },
    fetchImpl: fixtureVideoFetch,
  });
  await Promise.resolve();

  const newer = await reconciliation.reconcileRequest(state.db, state.log, ROUTE_ID, {
    now: LATE_NOW,
    queryTaskStatusOnce: async () => {
      queryCount += 1;
      return { state: 'processing' };
    },
  });
  resolveOldQuery({ state: 'succeeded', artifactUrl: ARTIFACT_URL });
  const late = await oldRequest;

  assert.equal(queryCount, 2);
  assert.equal(newer.task_state, 'needs_attention');
  assert.equal(newer.checked_at, LATE_NOW);
  assert.deepEqual(late, newer);
  assert.equal(getReservation(state.db, state.reservation.id).status, 'held');
  assert.equal(getVideo(state.db).status, 'needs_attention');
  assert.equal(getTask(state.db).status, 'needs_attention');
  assert.equal(getRoute(state.db).state, 'needs_attention');
  assert.equal(getAttempt(state.db).state, 'needs_attention');
  assert.equal(getAttempt(state.db).reconcile_checked_at, LATE_NOW);
  assert.equal(countReconciledSafeEvents(state.db), 0);
  assert.equal(countReconciledAuditEvents(state.db), 0);
  assert.deepEqual(listFiles(state.storagePath), []);
});
