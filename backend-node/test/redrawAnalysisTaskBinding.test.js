const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const Database = require('better-sqlite3');

// Only the media-process boundary is replaced. These bytes are not real media
// or supplier/recognition acceptance evidence. No process is started by this file.
let activeMedia;
const originalExecFile = childProcess.execFile;
let nativeAnalysis;
try {
  childProcess.execFile = (command, args, options, callback) => {
    assert.ok(activeMedia, 'media calls require this test\'s active fixture');
    const media = activeMedia;
    assert.equal(options.windowsHide, true);
    assert.ok(Array.isArray(args));
    if (command === 'ffprobe') {
      assert.deepEqual(args.slice(0, -1), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams']);
      assert.equal(args.at(-1), media.sourcePath);
    } else {
      assert.equal(command, 'ffmpeg', 'unlisted child command must never execute');
      assert.deepEqual(args.slice(0, 5), ['-hide_banner', '-loglevel', 'error', '-y', '-ss']);
      assert.equal(args[9], media.sourcePath);
      assert.equal(args[10], '-vf');
      assert.deepEqual(args.slice(12, 14), ['-frames:v', '1']);
      assert.equal(args.length, 15);
      assert.match(path.basename(args.at(-1)), /^contact-sheet-w\d+-(full|lower_third)-\d+\.jpg$/);
      assert.equal(path.dirname(path.dirname(args.at(-1))), fs.realpathSync.native(os.tmpdir()));
      media.sheetPaths.push(args.at(-1));
    }
    Promise.resolve().then(async () => {
      await media.waitAt(command === 'ffprobe' ? 'probe' : 'sheet');
      if (command === 'ffmpeg') fs.writeFileSync(args.at(-1), 'LOCAL SYNTHETIC CONTACT SHEET');
      callback(null, command === 'ffprobe' ? JSON.stringify({
        format: { duration: String(media.durationMs / 1000) },
        streams: [{ codec_type: 'video', duration: String(media.durationMs / 1000),
          width: 320, height: 180, avg_frame_rate: '12/1', codec_name: 'h264' },
        ...(media.hasAudio ? [{ codec_type: 'audio', codec_name: 'aac', sample_rate: '16000', channels: 1 }] : [])],
      }) : '', '');
    }).catch((error) => callback(error, '', 'synthetic media boundary failure'));
    return new EventEmitter();
  };
  // This is the unmodified product module; it captures only the controlled execFile.
  const modulePath = require.resolve('../src/services/redrawNativeSourceAnalysisService');
  delete require.cache[modulePath];
  nativeAnalysis = require(modulePath);
  delete require.cache[modulePath];
} finally {
  childProcess.execFile = originalExecFile;
}

const assetService = require('../src/services/assetService');
const creditLedger = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const taskService = require('../src/services/taskService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const sourceAudio = require('../src/services/redrawSourceAudioEvidenceService');
const fusion = require('../src/services/redrawEvidenceFusionService');
const redraw = require('../src/services/redrawOrchestrator');
const log = { info() {}, warn() {}, error() {} };
const STALE = 'REDRAW_ANALYSIS_TASK_STALE';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function facts(durationMs) {
  return {
    schema_version: '2.0', duration_ms: durationMs, story: ['Synthetic test pattern'],
    characters: [{ id: 'c1', display_name: 'Synthetic marker', relationships: [] }],
    scenes: [{ id: 's1', location: 'Synthetic room', time: 'Day',
      source_ranges: [{ start_ms: 0, end_ms: durationMs }] }],
    props: [{ id: 'p1', name: 'Synthetic pattern', evidence_ranges: [{ start_ms: 0, end_ms: durationMs }] }],
    shots: [{ id: 'shot1', index: 1, start_ms: 0, end_ms: durationMs,
      composition: 'Synthetic pattern', camera_movement: 'Static', opening_state: 'Pattern visible',
      continuous_action: 'Pattern persists', ending_state: 'Pattern visible',
      visible_character_ids: ['c1'], dialogue: [], text_regions: [],
      audio_contract: { dialogue_mode: 'silent', ambient_audio: 'preserve_or_rebuild' },
      confidence: { character_mapping: 0.9, speaker_mapping: 0, text_regions: 0.9, shot_boundary: 0.9 } }],
    causal_chain: ['Pattern persists'], locked_facts: ['Pattern visible'],
    reversals: ['No reversal claimed'], episode_hook: 'Synthetic fixture ends',
  };
}

function writeWav(file, durationMs) {
  const dataSize = durationMs * 32;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(dataSize + 36, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(dataSize, 40);
  const fd = fs.openSync(file, 'r+');
  try { fs.writeSync(fd, header); fs.ftruncateSync(fd, dataSize + 44); }
  finally { fs.closeSync(fd); }
}

function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-analysis-binding-'));
  const ownedRoot = fs.realpathSync.native(root);
  const storageRoot = path.join(root, 'storage');
  const privateAudioRoot = path.join(root, 'private-audio');
  fs.mkdirSync(storageRoot); fs.mkdirSync(privateAudioRoot, { mode: 0o700 });
  const sourcePath = path.join(storageRoot, 'source.mp4');
  fs.writeFileSync(sourcePath, 'LOCAL SYNTHETIC SOURCE VIDEO');
  const db = new Database(':memory:', {
    nativeBinding: path.resolve(__dirname, '../node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
  });
  runMigrationsAndEnsure(db);
  t.after(() => {
    db.close();
    if (activeMedia?.root === root) activeMedia = null;
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    assert.equal(fs.realpathSync.native(root), ownedRoot);
    assert.equal(path.dirname(ownedRoot), fs.realpathSync.native(os.tmpdir()));
    assert.match(path.basename(ownedRoot), /^g2-analysis-binding-/);
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  });
  const now = '2026-09-09T00:00:00.000Z';
  // Fixture-only capability evidence, never a production/provider-readiness claim.
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, model, default_model, is_active, is_default, settings, created_at, updated_at)
    VALUES ('video_understanding', 'synthetic-local-double', 'TEST ONLY', 'GPT-5.5', 'GPT-5.5', 1, 1, ?, ?, ?)`)
    .run(JSON.stringify({ test_only: true, real_generation_verified: true,
      evidence: { provider_task_id: 'LOCAL-DOUBLE-ONLY', result_asset_id: 'LOCAL-DOUBLE-ONLY',
        result_asset_readable: true, completed_at: now } }), now, now);
  prices.set(db, 'GPT-5.5', 6);
  creditLedger.setTenantAccountBalance(db, 'tenant-1', 100);
  const source = assetService.create(db, log, {
    name: 'source.mp4', type: 'video', category: 'redraw_source', local_path: 'source.mp4',
    mime_type: 'video/mp4', metadata: { tenant_id: 'tenant-1', user_id: 'user-1' },
  });
  db.prepare(`INSERT INTO redraw_projects (id, tenant_id, user_id, title, status, created_at, updated_at)
    VALUES (1, 'tenant-1', 'user-1', 'G2 binding fixture', 'draft', ?, ?)`).run(now, now);
  const durationMs = options.longAudio ? 2100000 : 25000;
  db.prepare(`INSERT INTO redraw_works
    (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, status, current_step, created_at, updated_at)
    VALUES (1, 1, 'tenant-1', 'user-1', 'G2 binding fixture', ?, ?, ?, 'draft', 1, ?, ?)`)
    .run(source.id, hash(fs.readFileSync(sourcePath)), durationMs, now, now);
  const entered = deferred(), release = deferred(), visits = {};
  const fixture = { root, db, source, sourcePath, storageRoot, privateAudioRoot, durationMs, hasAudio: !options.silent,
    entered, release, sheetPaths: [], workerCalls: [], visionCalls: [], audioContexts: [], nativeContexts: [], fusionCalls: 0,
    async waitAt(stage) {
      visits[stage] = (visits[stage] || 0) + 1;
      if (options.pause === stage && visits[stage] === (options.pauseIndex || 1)) {
        entered.resolve();
        await release.promise;
      }
    },
    work() { return db.prepare('SELECT * FROM redraw_works WHERE id = 1').get(); },
    task() { return db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(fixture.taskId || fixture.work().task_id); },
    cancel() {
      fixture.taskId = fixture.work().task_id;
      assert.equal(taskService.cancelTask(db, log, fixture.taskId, 'G2 explicit user cancellation').ok, true);
    },
  };
  activeMedia = fixture;
  const ctx = {
    db, log, storageRoot, privateAudioRoot, assetService, ffmpegPath: 'synthetic-audio-extractor',
    assertAnalysisTaskCurrent: () => { throw new Error('untrusted analysisContext guard must be overwritten'); },
    now: () => {
      if (options.cancelAtAudioCommit) { fixture.cancel(); fixture.before = snapshot(fixture); }
      return now;
    },
    execFile: async (command, args, execOptions) => {
      assert.equal(command, 'synthetic-audio-extractor');
      assert.equal(execOptions.shell, false);
      await fixture.waitAt('extract');
      if (options.silent) throw Object.assign(new Error('no stream'), { stderr: 'Output file #0 does not contain any stream' });
      writeWav(args.at(-1), options.longAudio ? durationMs : 1000);
    },
    workerClient: { async analyzeSourceAudio(input) {
      fixture.workerCalls.push(input);
      await fixture.waitAt('worker');
      if (options.workerError) throw Object.assign(new Error('synthetic Worker failure'), { code: options.workerError });
      const startMs = input.preserveSourceEvidence && fixture.workerCalls.length === 2 ? 61000 : 100;
      const response = { requestId: input.requestId, audioSha256: input.audioSha256,
        transcriptSha256: hash(`synthetic transcript ${fixture.workerCalls.length}`), sourceLanguage: 'en', languageProbability: 0.99,
        segments: [{ startMs, endMs: startMs + 100, text: 'Synthetic dialogue', speakerClusterId: 'speaker-cluster-1' }] };
      if (input.preserveSourceEvidence) response.rawSourceEvidence = {
        audio_sha256: response.audioSha256, transcript_sha256: response.transcriptSha256,
        source_language: 'en', language_probability: 0.99,
        segments: [{ start: startMs / 1000, end: (startMs + 100) / 1000,
          text: 'Synthetic dialogue', speaker_cluster_id: 'speaker-cluster-1' }],
      };
      return response;
    } },
    visionDetailed: async (payload) => {
      fixture.visionCalls.push(payload);
      await fixture.waitAt('vision');
      const measured = payload.userPrompt.match(/duration_ms=(\d+)/);
      assert.ok(measured);
      return { text: JSON.stringify({ source_facts: facts(Number(measured[1])) }),
        provider_task_id: options.missingProviderId ? null : `local-vision-${fixture.visionCalls.length}`,
        model: 'GPT-5.5', usage: { total_tokens: 10 }, raw_hash: 'a'.repeat(64) };
    },
  };
  fixture.options = {
    analysisContext: ctx,
    sourceAudioEvidenceService: { async analyzeSourceAudio(context, input) {
      fixture.phase = 'audio';
      fixture.audioContexts.push({ context, input });
      const result = await sourceAudio.analyzeSourceAudio(context,
        options.audioInput ? options.audioInput(input, fixture) : input);
      fixture.audioResult = result;
      await fixture.waitAt('after-audio');
      return result;
    } },
    nativeSourceAnalysisService: { async analyzeNativeSource(context, input, evidence) {
      fixture.phase = 'native';
      fixture.nativeContexts.push({ context, input });
      return nativeAnalysis.analyzeNativeSource(context,
        options.nativeInput ? options.nativeInput(input, fixture) : input, evidence);
    } },
    evidenceFusionService: { async fuseEpisodeEvidence(input) {
      fixture.phase = 'fusion';
      fixture.fusionCalls += 1;
      const result = fusion.fuseEpisodeEvidence(input);
      await fixture.waitAt('fusion');
      return result;
    } },
  };
  if (options.cancelBeforeCommit) {
    const transaction = db.transaction.bind(db);
    db.transaction = (callback) => {
      const actual = transaction(callback);
      const invoke = (run) => (...args) => {
        if (fixture.phase === options.cancelBeforeCommit && !fixture.before) {
          assert.equal(db.inTransaction, false, 'cancel immediately before the real BEGIN/callback');
          fixture.cancel();
          fixture.before = snapshot(fixture);
        }
        return run(...args);
      };
      return Object.assign(invoke(actual), {
        deferred: invoke(actual.deferred), immediate: invoke(actual.immediate), exclusive: invoke(actual.exclusive),
      });
    };
  }
  fixture.start = (input = {}) => redraw.startAnalysis(db, log,
    { workId: 1, userId: 'user-1', tenantId: 'tenant-1', ...input }, fixture.options)
    .then((result) => ({ result }), (error) => ({ error }));
  return fixture;
}

function snapshot(fixture) {
  const { db } = fixture;
  return Object.fromEntries(['redraw_works', 'async_tasks', 'assets', 'redraw_versions',
    'redraw_episode_blueprints', 'redraw_workflow_events', 'tenant_usage_reservations', 'tenant_credit_ledger',
    'tenant_credit_accounts'].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

async function paused(fixture) {
  const outcome = fixture.start();
  await Promise.race([fixture.entered.promise, outcome.then(({ error }) => {
    throw error || new Error('analysis completed without reaching the selected await');
  })]);
  fixture.taskId = fixture.work().task_id;
  return { outcome };
}

function assertStale(outcome, fixture, before) {
  assert.equal(outcome.error?.code, STALE,
    `a stale task must retain its own non-provider error code\n${outcome.error?.stack || 'analysis returned without error'}`);
  assert.deepEqual(snapshot(fixture), before, 'late continuation must not write assets, task/work, version, event or billing rows');
  assert.ok(fixture.sheetPaths.every((file) => !fs.existsSync(file)), 'temporary Native sheets are cleaned');
  assert.deepEqual(fs.readdirSync(fixture.privateAudioRoot), [], 'private source-audio files are cleaned');
}

for (const options of [
  { pause: 'extract' }, { pause: 'extract', silent: true }, { pause: 'worker' },
  { pause: 'worker', longAudio: true }, { pause: 'after-audio' }, { pause: 'after-audio', longAudio: true },
  { pause: 'probe' }, { pause: 'sheet' },
  { pause: 'vision' }, { pause: 'vision', missingProviderId: true }, { pause: 'fusion' },
]) {
  test(`cancelled analysis rejects late ${options.pause}${options.silent ? ' no-audio' : ''}${options.longAudio ? ' long-audio' : ''}${options.missingProviderId ? ' missing-id receipt' : ''}`, { timeout: 15000 }, async (t) => {
    const fixture = createFixture(t, options);
    const { outcome } = await paused(fixture);
    if (options.pause === 'after-audio' && options.longAudio) {
      assert.equal(fixture.audioResult.schema_version, 'redraw-source-audio-evidence-v2');
      assert.equal(fixture.audioResult.windows.length, 2);
      assert.equal(fixture.audioResult.coverage.full_coverage, true);
      assert.ok(fixture.audioResult.windows.every((window) => window.worker_status === 'completed'));
      const asset = fixture.db.prepare('SELECT * FROM assets WHERE id = ?').get(fixture.audioResult.result_asset_id);
      assert.equal(asset.category, 'redraw_source_audio_evidence');
      const bytes = fs.readFileSync(path.join(fixture.storageRoot, asset.local_path));
      assert.equal(hash(bytes), fixture.audioResult.evidence_sha256);
      assert.equal(JSON.parse(bytes).windows.length, 2);
    }
    fixture.cancel();
    const before = snapshot(fixture);
    fixture.release.resolve();
    assertStale(await outcome, fixture, before);
    assert.equal(fixture.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
    const expectedWorkers = options.pause === 'extract' ? 0
      : options.pause === 'after-audio' && options.longAudio ? 2 : 1;
    const expectedVision = options.pause === 'fusion' ? 2 : options.pause === 'vision' ? 1 : 0;
    assert.equal(fixture.workerCalls.length, expectedWorkers, 'cancelled stage never starts another Worker request');
    assert.equal(fixture.visionCalls.length, expectedVision, 'cancelled stage never starts another vision request');
    assert.equal(fixture.fusionCalls, options.pause === 'fusion' ? 1 : 0, 'cancelled stage never enters fusion');
    if (options.pause === 'vision') {
      assert.equal(fixture.visionCalls.length, 1, 'no next visual window');
      const receiptDir = path.join(fixture.storageRoot, 'redraw-analysis', fixture.taskId);
      const names = fs.readdirSync(receiptDir).filter((name) => /^source-analysis-receipt-/.test(name));
      assert.equal(names.length, 1);
      const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, names[0]), 'utf8'));
      assert.equal(receipt.windows.length, 1);
      assert.equal(receipt.windows[0].provider_task_id, options.missingProviderId ? null : 'local-vision-1');
      assert.deepEqual(receipt.windows[0].usage, { total_tokens: 10 });
      assert.equal(receipt.windows[0].raw_hash, 'a'.repeat(64));
      assert.notEqual(receipt.windows[0].status, 'completed');
      assert.equal(receipt.error_code, STALE);
      assert.equal(fs.existsSync(path.join(receiptDir, 'source-analysis.json')), false);
    }
  });
}

test('long-audio final transaction preserves cancellation guard code and writes no evidence', { timeout: 15000 }, async (t) => {
  const fixture = createFixture(t, { longAudio: true, cancelAtAudioCommit: true });
  const outcome = await fixture.start();
  assert.ok(fixture.before, 'all audio windows reached final evidence construction');
  assert.equal(fixture.workerCalls.length, 2);
  assertStale(outcome, fixture, fixture.before);
  assert.equal(fixture.visionCalls.length, 0);
  assert.equal(fixture.fusionCalls, 0);
});

for (const options of [
  { cancelBeforeCommit: 'audio' }, { cancelBeforeCommit: 'audio', silent: true },
  { cancelBeforeCommit: 'audio', longAudio: true }, { cancelBeforeCommit: 'native' },
]) {
  test(`cancellation immediately before ${options.cancelBeforeCommit} transaction callback rejects ${options.silent ? 'silent' : options.longAudio ? 'long' : 'short'} evidence`, { timeout: 15000 }, async (t) => {
    const fixture = createFixture(t, options);
    const outcome = await fixture.start();
    assert.ok(fixture.before, 'the real evidence persistence transaction was reached');
    assertStale(outcome, fixture, fixture.before);
    assert.equal(fixture.visionCalls.length, options.cancelBeforeCommit === 'native' ? 2 : 0);
    assert.equal(fixture.fusionCalls, 0);
    assert.equal(fixture.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
  });
}

for (const binding of ['userId', 'tenantId', 'sourceAssetId']) {
  test(`wrong creation ${binding} rejects before reservation or task/work changes`, { timeout: 15000 }, async (t) => {
    const fixture = createFixture(t);
    let value = binding === 'userId' ? 'user-2' : 'tenant-2';
    if (binding === 'sourceAssetId') {
      fs.writeFileSync(path.join(fixture.storageRoot, 'other-source.mp4'), 'LOCAL OTHER SOURCE VIDEO');
      value = assetService.create(fixture.db, log, {
        name: 'other-source.mp4', type: 'video', category: 'redraw_source', local_path: 'other-source.mp4',
        mime_type: 'video/mp4', metadata: { tenant_id: 'tenant-1', user_id: 'user-1' },
      }).id;
    }
    const before = snapshot(fixture);
    assertStale(await fixture.start({ [binding]: value }), fixture, before);
    assert.equal(fixture.workerCalls.length, 0);
    assert.equal(fixture.visionCalls.length, 0);
    assert.equal(fixture.fusionCalls, 0);
  });
}

const bindingChanges = [
  ['async_tasks', 'id', 'moved-task'], ['redraw_works', 'id', 2],
  ['async_tasks', 'type', 'different_type'], ['async_tasks', 'resource_id', 'different_work'],
  ['async_tasks', 'tenant_id', 'tenant-2'], ['async_tasks', 'user_id', 'user-2'],
  ['async_tasks', 'status', 'pending'], ['async_tasks', 'deleted_at', '2026-09-09T01:00:00Z'],
  ['async_tasks', 'model', 'different-model'], ['async_tasks', 'credit_reservation_id', 'different-reservation'],
  ['redraw_works', 'tenant_id', 'tenant-2'], ['redraw_works', 'user_id', 'user-2'],
  ['redraw_works', 'status', 'draft'], ['redraw_works', 'task_id', 'replacement-task'],
  ['redraw_works', 'source_asset_id', 99], ['redraw_works', 'source_fingerprint', 'c'.repeat(64)],
  ['redraw_works', 'deleted_at', '2026-09-09T01:00:00Z'],
];
for (const [table, column, value] of bindingChanges) {
  test(`late audio cannot write after ${table}.${column} changes`, { timeout: 15000 }, async (t) => {
    const fixture = createFixture(t, { pause: 'worker' });
    const { outcome } = await paused(fixture);
    fixture.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`)
      .run(value, table === 'async_tasks' ? fixture.taskId : 1);
    const before = snapshot(fixture);
    fixture.release.resolve();
    assertStale(await outcome, fixture, before);
  });
}

test('progress-only changes keep the trusted guard current and complete the real pipeline', { timeout: 15000 }, async (t) => {
  const fixture = createFixture(t, { pause: 'worker' });
  const { outcome } = await paused(fixture);
  fixture.db.prepare('UPDATE async_tasks SET progress = 30, updated_at = ? WHERE id = ?').run('later', fixture.taskId);
  fixture.db.prepare('UPDATE redraw_works SET updated_at = ? WHERE id = 1').run('later');
  fixture.release.resolve();
  const completed = await outcome;
  assert.ifError(completed.error);
  assert.equal(completed.result.status, 'completed');
  const audio = fixture.audioContexts[0], native = fixture.nativeContexts[0];
  assert.equal(typeof audio.context.assertAnalysisTaskCurrent, 'function');
  assert.notEqual(audio.context.assertAnalysisTaskCurrent, fixture.options.analysisContext.assertAnalysisTaskCurrent);
  assert.equal(audio.context.assertAnalysisTaskCurrent, native.context.assertAnalysisTaskCurrent);
  assert.deepEqual(Object.keys(audio.input).sort(), ['sourceAssetId', 'tenantId', 'userId', 'workId']);
  const evidence = fixture.db.prepare("SELECT local_path FROM assets WHERE category = 'redraw_source_audio_evidence'").get();
  const payload = JSON.parse(fs.readFileSync(path.join(fixture.storageRoot, evidence.local_path), 'utf8'));
  assert.notEqual(payload.task_id, fixture.taskId, 'internal source-audio UUID remains independent of the real task id');
  assert.equal(fixture.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'confirmed');
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM redraw_episode_blueprints').get().n, 1);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM redraw_workflow_events').get().n, 1);
});

for (const workerError of ['SYNTHETIC_EXPLICIT_FAILURE', 'REDRAW_LOCALE_VERIFIER_TIMEOUT']) {
  test(`replacement remains untouched by old ${workerError}`, { timeout: 15000 }, async (t) => {
    const fixture = createFixture(t, { pause: 'worker', workerError });
    const { outcome } = await paused(fixture);
    fixture.cancel();
    const reservation = creditLedger.reserve(fixture.db, { userId: 'user-1', tenantId: 'tenant-1', actorUserId: 'user-1',
      operationKey: 'g2-test-replacement', amount: 6, model: 'GPT-5.5', resourceType: 'redraw_analysis', resourceId: 1 });
    const replacement = taskService.createTask(fixture.db, log, 'redraw_analysis', 1);
    fixture.db.prepare(`UPDATE async_tasks SET tenant_id = 'tenant-1', user_id = 'user-1', status = 'processing',
      model = 'GPT-5.5', credit_reservation_id = ? WHERE id = ?`).run(reservation.id, replacement.id);
    fixture.db.prepare(`UPDATE redraw_works SET task_id = ?, credit_reservation_id = ?,
      provider_task_id = 'new-provider-id', status = 'analyzing' WHERE id = 1`).run(replacement.id, reservation.id);
    const before = snapshot(fixture);
    fixture.release.resolve();
    assertStale(await outcome, fixture, before);
    assert.deepEqual(fixture.db.prepare('SELECT status FROM tenant_usage_reservations ORDER BY rowid').all(),
      [{ status: 'held' }, { status: 'held' }]);
  });

  test(`current ${workerError} keeps existing failure billing policy`, { timeout: 15000 }, async (t) => {
    const fixture = createFixture(t, { workerError });
    const outcome = await fixture.start();
    const unknown = workerError === 'REDRAW_LOCALE_VERIFIER_TIMEOUT';
    assert.equal(outcome.error?.code, unknown ? 'SOURCE_AUDIO_RESULT_UNKNOWN' : 'SOURCE_AUDIO_ANALYSIS_FAILED');
    assert.equal(fixture.task().status, unknown ? 'needs_attention' : 'failed');
    assert.equal(fixture.work().status, unknown ? 'needs_attention' : 'failed');
    assert.equal(fixture.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, unknown ? 'held' : 'refunded');
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE category != 'redraw_source'").get().n, 0);
  });
}

for (const failure of ['unreadable-result', 'facts-hash-conflict']) {
  for (const cancel of [false, true]) {
    test(`legacy direct-start ${failure} ${cancel ? 'cannot settle after cancellation at its error transaction' : 'retains existing billing policy'}`, { timeout: 15000 }, async (t) => {
      const fixture = createFixture(t, cancel ? { cancelBeforeCommit: 'legacy-error' } : {});
      const resultPath = 'direct-result.json';
      const returnedFacts = facts(fixture.durationMs);
      let originalVersion;
      if (failure === 'facts-hash-conflict') {
        const { normalizeSourceFacts } = require('../src/services/redrawAnalysisService');
        const original = normalizeSourceFacts(returnedFacts);
        const now = fixture.work().created_at;
        fixture.db.prepare(`INSERT INTO redraw_versions
          (work_id, tenant_id, user_id, version, locale, source_facts_json, facts_hash, status, created_at, updated_at)
          VALUES (1, 'tenant-1', 'user-1', 1, 'source', ?, ?, 'needs_attention', ?, ?)`)
          .run(JSON.stringify(original), original.facts_hash, now, now);
        originalVersion = fixture.db.prepare('SELECT * FROM redraw_versions WHERE work_id = 1').get();
        returnedFacts.locked_facts = ['A different synthetic locked fact'];
        assert.notEqual(normalizeSourceFacts(returnedFacts).facts_hash, original.facts_hash);
        fs.writeFileSync(path.join(fixture.storageRoot, resultPath), JSON.stringify(returnedFacts));
      }
      const resultAsset = assetService.create(fixture.db, log, {
        name: resultPath, type: 'json', category: 'redraw_source_analysis', local_path: resultPath,
        mime_type: 'application/json', metadata: { tenant_id: 'tenant-1', user_id: 'user-1' },
      });
      const reader = redraw.createAssetReader({ storageRoot: fixture.storageRoot });
      fixture.options = {
        provider: { async startAnalysis() {
          return { status: 'completed', provider_task_id: 'local-direct-response',
            result_asset_id: resultAsset.id, facts: returnedFacts };
        } },
        assetReader: { canRead(asset) {
          const readable = reader.canRead(asset);
          if (asset.id === resultAsset.id) {
            assert.equal(readable, failure === 'facts-hash-conflict');
            fixture.phase = 'legacy-error';
          }
          return readable;
        } },
      };
      const outcome = await fixture.start();
      if (cancel) {
        assert.ok(fixture.before, 'legacy error writes must enter a real guarded transaction');
        assertStale(outcome, fixture, fixture.before);
        assert.equal(fixture.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
      } else {
        const conflict = failure === 'facts-hash-conflict';
        assert.equal(outcome.error?.code, 'REDRAW_ANALYSIS_RESULT_INVALID', outcome.error?.stack);
        assert.equal(outcome.error.analysis_status, conflict ? 'needs_attention' : 'failed');
        assert.equal(fixture.task().status, conflict ? 'needs_attention' : 'failed');
        assert.equal(fixture.work().status, conflict ? 'needs_attention' : 'failed');
        assert.equal(fixture.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, conflict ? 'held' : 'refunded');
      }
      assert.deepEqual(fixture.db.prepare('SELECT * FROM redraw_versions WHERE work_id = 1').all(), originalVersion ? [originalVersion] : []);
      assert.equal(fixture.workerCalls.length, 0);
      assert.equal(fixture.visionCalls.length, 0);
      assert.equal(fixture.fusionCalls, 0);
    });
  }
}

for (const [name, options] of [
  ['Native task id', { nativeInput: (input) => ({ ...input, taskId: 'not-the-bound-task' }) }],
  ['Native model', { nativeInput: (input) => ({ ...input, model: 'not-the-bound-model' }) }],
  ['SourceAudio work id', { audioInput: (input, fixture) => {
    const work = fixture.work();
    const secondSourceBytes = Buffer.from('LOCAL DISTINCT SYNTHETIC SOURCE VIDEO');
    fs.writeFileSync(path.join(fixture.storageRoot, 'source-2.mp4'), secondSourceBytes);
    const secondSource = assetService.create(fixture.db, log, {
      name: 'source-2.mp4', type: 'video', category: 'redraw_source', local_path: 'source-2.mp4',
      mime_type: 'video/mp4', metadata: { tenant_id: 'tenant-1', user_id: 'user-1' },
    });
    fixture.db.prepare(`INSERT INTO redraw_works
      (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
       duration_ms, status, current_step, created_at, updated_at)
      VALUES (2, 1, 'tenant-1', 'user-1', 'other owned work', ?, ?, 25000, 'draft', 1, ?, ?)`)
      .run(secondSource.id, hash(secondSourceBytes), work.created_at, work.updated_at);
    return { ...input, workId: 2, sourceAssetId: secondSource.id };
  } }],
]) {
  test(`trusted service guard rejects mismatched actual ${name} input`, { timeout: 15000 }, async (t) => {
    const fixture = createFixture(t, options);
    const outcome = await fixture.start();
    assert.equal(outcome.error?.code, STALE, outcome.error?.stack || 'analysis returned without error');
    assert.equal(fixture.visionCalls.length, 0);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE category = 'redraw_source_analysis'").get().n, 0);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM redraw_versions').get().n, 0);
    assert.equal(fixture.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
    if (name.startsWith('SourceAudio')) {
      assert.equal(fixture.workerCalls.length, 0);
      assert.equal(fixture.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE category = 'redraw_source_audio_evidence'").get().n, 0);
      assert.equal(fixture.db.prepare('SELECT status FROM redraw_works WHERE id = 2').get().status, 'draft');
    }
  });
}
