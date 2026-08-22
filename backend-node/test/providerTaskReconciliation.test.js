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
const storageLayout = require('../src/services/storageLayout');
const videoService = require('../src/services/videoService');
const { MINIMAL_MP4 } = require('./fixtures/media');

const NOW = '2026-08-22T00:00:00.000Z';
const ARTIFACT_URL = 'https://artifact.example/video.mp4';
const VIDEO_ID = 7001;
const TASK_ID = 'task-reconcile';
const ROUTE_ID = 'route-reconcile';
const PROVIDER_TASK_ID = 'provider-task-reconcile';
const SNAPSHOT_TABLES = [
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

function setupReconciliationFixture(t) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  generationCostLedgerService.ensureSchema(db);
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-reconciled-video-'));
  const log = recordingLog();
  t.after(() => {
    db.close();
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

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
    provider: 'toapis',
    api_protocol: 'toapis_video',
    name: '对账测试线路',
    base_url: 'https://artifact.example/v1',
    api_key: 'test-key',
    model: ['seedance-2-fast'],
    default_model: 'seedance-2-fast',
    logical_model_id: 'logical-video',
    settings: { canvas_capabilities: { durations: [5], resolutions: ['480p'] } },
  });
  const config = aiConfigService.getConfig(db, createdConfig.id);

  db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, message, resource_id, user_id, model, provider_task_id,
     created_at, updated_at)
    VALUES (?, 'video_generation', 'needs_attention', 90, '等待人工对账', ?,
      'user-reconcile', 'logical-video', ?, ?, ?)`)
    .run(TASK_ID, String(VIDEO_ID), PROVIDER_TASK_ID, NOW, NOW);
  db.prepare(`INSERT INTO video_generations
    (id, drama_id, storyboard_id, provider, prompt, model, duration, aspect_ratio, resolution,
     status, task_id, provider_task_id, config_id, user_id, created_at, updated_at)
    VALUES (?, 1, 1, 'toapis', 'fixture prompt', 'seedance-2-fast', 5, '16:9', '480p',
      'needs_attention', ?, ?, ?, 'user-reconcile', ?, ?)`)
    .run(VIDEO_ID, TASK_ID, PROVIDER_TASK_ID, config.id, NOW, NOW);

  creditLedgerService.setAccountBalance(db, 'user-reconcile', 100);
  const reservation = creditLedgerService.reserve(db, {
    operationKey: 'video-reconcile-7001',
    userId: 'user-reconcile',
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
    (id, idempotency_key, service_type, business_type, business_id, user_id,
     logical_model_id, capability_fingerprint, candidate_config_ids, state,
     credit_reservation_id, final_config_id, created_at, updated_at)
    VALUES (?, 'video-reconcile-7001', 'video', 'video_generation', ?, 'user-reconcile',
      'logical-video', ?, ?, 'needs_attention', ?, ?, ?, ?)`)
    .run(
      ROUTE_ID,
      String(VIDEO_ID),
      'b'.repeat(64),
      JSON.stringify([config.id]),
      reservation.id,
      config.id,
      NOW,
      NOW,
    );
  db.prepare(`INSERT INTO generation_route_attempts
    (request_id, attempt_no, config_id, provider, upstream_model, state,
     config_fingerprint, query_protocol, started_at, finished_at)
    VALUES (?, 1, ?, 'toapis', 'seedance-2-fast', 'accepted', ?, 'toapis_video', ?, ?)`)
    .run(ROUTE_ID, config.id, 'a'.repeat(64), NOW, NOW);
  db.prepare(`UPDATE generation_route_attempts SET provider_task_id = ?
    WHERE request_id = ? AND attempt_no = 1`)
    .run(PROVIDER_TASK_ID, ROUTE_ID);
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
    reservation,
    storagePath,
    projectSubdir,
  };
}

async function fixtureVideoFetch(url, requestOptions) {
  assert.equal(url, ARTIFACT_URL);
  assert.equal(Object.hasOwn(requestOptions, 'fetchImpl'), false);
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

test('prepareReconciledVideoArtifact removes staged video and partial frames when extraction throws', async (t) => {
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
        extractBoundaryFramesImpl(storagePath, localPath, videoGenId) {
          const framePath = path.join(
            path.dirname(path.join(storagePath, localPath)),
            `vg_${videoGenId}_first.jpg`,
          );
          fs.writeFileSync(framePath, 'partial-frame');
          throw new Error('frame provider-body-secret');
        },
      },
    ),
    assertSafeArtifactError,
  );

  assert.deepEqual(listFiles(state.storagePath), []);
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
