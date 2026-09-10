const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const assetService = require('../src/services/assetService');
const creditLedger = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const taskService = require('../src/services/taskService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { stableStringify } = require('../src/services/redrawAnalysisService');
const { normalizeEpisodeBlueprint } = require('../src/services/redrawEpisodeBlueprintService');
const sourceAudio = require('../src/services/redrawSourceAudioEvidenceService');
const redraw = require('../src/services/redrawOrchestrator');

// Synthetic bytes and Worker receipts only: no real recognition, provider,
// network, FFmpeg, default database, UI acceptance or production claim.
const log = { info() {}, warn() {}, error() {} };
const SCHEMA = 'redraw-source-audio-seam-candidate-v1';
const REVIEW = 'SOURCE_AUDIO_SEAM_REVIEW_REQUIRED';
const STALE = 'REDRAW_ANALYSIS_TASK_STALE';
const DURATION_MS = 2100000;
const INTERNAL_TASK_ID = '11111111-1111-4111-8111-111111111111';
const WINDOW_PLAN = [
  { window_id: 'aw000001', index: 0, analysis_range_ms: { start_ms: 0, end_ms: 1530000 },
    commit_range_ms: { start_ms: 0, end_ms: 1500000 } },
  { window_id: 'aw000002', index: 1, analysis_range_ms: { start_ms: 1470000, end_ms: DURATION_MS },
    commit_range_ms: { start_ms: 1500000, end_ms: DURATION_MS } },
];
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const clone = (value) => structuredClone(value);

function workerReceipt(request, index, mixedLanguage = false) {
  const raw = {
    audio_sha256: request.audioSha256,
    transcript_sha256: hash(`independent synthetic raw transcript ${index}`),
    source_language: mixedLanguage && index === 1 ? 'zh' : 'en',
    language_probability: index === 0 ? 0.98 : 0.87,
    segments: [{ start: index === 0 ? 1499.0004 : 29.0004,
      end: index === 0 ? 1502.0006 : 32.0006,
      text: index === 0 ? '  Keep the complete original sentence. \n' : '  不同原文 — keep this full alternative. \n',
      speaker_cluster_id: 'speaker-cluster-1' }],
  };
  return {
    requestId: request.requestId, audioSha256: raw.audio_sha256,
    transcriptSha256: raw.transcript_sha256, sourceLanguage: raw.source_language,
    languageProbability: raw.language_probability,
    segments: raw.segments.map((segment) => ({ startMs: Math.round(segment.start * 1000),
      endMs: Math.round(segment.end * 1000), text: segment.text.trim(), speakerClusterId: segment.speaker_cluster_id })),
    rawSourceEvidence: raw,
  };
}

function expectedWindows(requests, replies) {
  return WINDOW_PLAN.map((plan, index) => ({ ...clone(plan),
    request_id: requests[index].requestId, audio_sha256: requests[index].audioSha256,
    transcript_sha256: replies[index].transcriptSha256, worker_status: 'completed',
    segment_count: replies[index].rawSourceEvidence.segments.length,
    raw_source_evidence: clone(replies[index].rawSourceEvidence) }));
}

function resumedBlueprint(input, audioContext) {
  const audio = input.audioEvidence;
  const manifest = input.evidenceAssets.find(item => item.kind === 'audio_transcript');
  assert.ok(manifest, 'the resumed pipeline must bind the registered audio evidence asset');
  const segment = audio.segments[0];
  const ref = manifest.id;
  return normalizeEpisodeBlueprint({
    schema_version: 'episode-blueprint-v1',
    source: input.source,
    evidence_manifest: { items: input.evidenceAssets },
    story: { summary: 'A complete retained source sentence crosses the window seam.',
      beats: ['The retained sentence continues without cropping.'], evidence_refs: [ref], confidence: 0.9 },
    characters: [{ id: 'character-1', source_name: 'Speaker', display_name: 'Speaker',
      relationship: 'protagonist', relationships: [], face_track_ids: [], evidence_refs: [ref],
      confidence: 0.9, review_status: 'needs_review' }],
    scenes: [{ id: 'scene-1', location: 'Source scene', time: 'continuous',
      source_ranges: [{ start_ms: 0, end_ms: DURATION_MS }], evidence_refs: [ref], confidence: 0.9 }],
    props: [{ id: 'prop-1', name: 'Source prop', evidence_ranges: [{ start_ms: 0, end_ms: DURATION_MS }],
      evidence_refs: [ref], confidence: 0.8 }],
    shots: [{ id: 'shot-1', index: 1, start_ms: 0, end_ms: DURATION_MS,
      composition: 'The source composition remains reviewable.', camera_movement: 'continuous',
      opening_state: 'The sentence begins.', continuous_action: 'The full sentence crosses the seam.',
      ending_state: 'The sentence ends.', visible_character_ids: [],
      dialogue: [{ id: segment.id, speaker_id: segment.speaker_cluster_id, speaker_kind: 'voice_cluster',
        off_screen: true, start_ms: segment.start_ms, end_ms: segment.end_ms,
        source_text: segment.source_text, source_language: audio.source_language,
        emotion: 'source', evidence_refs: [ref], confidence: 0.9, review_status: 'needs_review' }],
      text_regions: [], audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
      confidence: { character_mapping: 0.9, speaker_mapping: 0.9, text_regions: 0.9, shot_boundary: 0.9 },
      evidence_refs: [ref] }],
    causal_chain: [{ id: 'causal-1', cause: 'The sentence begins.', effect: 'The sentence completes.',
      evidence_refs: [ref], confidence: 0.9 }],
    locked_facts: [{ id: 'fact-1', text: 'The complete sentence is retained.', evidence_refs: [ref], confidence: 0.9 }],
    reversals: [{ id: 'reversal-1', text: 'The seam requires review.', evidence_refs: [ref], confidence: 0.8 }],
    episode_hook: { text: 'What follows the retained sentence?', evidence_refs: [ref], confidence: 0.9 },
    review: { status: 'needs_review' },
  }, audioContext);
}

function assertDiagnostic(diagnostic, audioSha256, windows, reason) {
  assert.ok(diagnostic, 'the actual aggregate conflict must retain its diagnostic');
  assert.equal(diagnostic.schema_version, SCHEMA);
  assert.equal(diagnostic.status, 'needs_review');
  assert.equal(diagnostic.reason, reason);
  assert.equal(diagnostic.audio_duration_ms, DURATION_MS);
  assert.equal(diagnostic.audio_sha256, audioSha256);
  assert.deepEqual(diagnostic.windows, windows, 'all windows, original times/text and receipt hashes remain intact');
  for (const field of ['success', 'segments', 'selected', 'default', 'selection', 'selected_source_binding_index',
    'result_asset_id', 'evidence_asset', 'dialogue_mode', 'transcript_sha256', 'task_id']) {
    assert.equal(Object.hasOwn(diagnostic, field), false, `a review candidate must not expose ${field}`);
  }
}

for (const mixedLanguage of [false, true]) {
  test(`aggregate ${mixedLanguage ? 'language' : 'seam'} conflict emits only a versioned, full-raw review diagnostic`, () => {
    const requests = WINDOW_PLAN.map((plan) => ({ requestId: `synthetic-${plan.window_id}`, audioSha256: hash(plan.window_id) }));
    const replies = requests.map((request, index) => workerReceipt(request, index, mixedLanguage));
    const input = { audioDurationMs: DURATION_MS, audioSha256: 'a'.repeat(64),
      windows: WINDOW_PLAN.map((plan, index) => ({ ...clone(plan), request_id: requests[index].requestId,
        audio_sha256: requests[index].audioSha256, workerEvidence: replies[index] })) };
    const before = clone(input);
    let diagnostic;
    assert.throws(() => sourceAudio.aggregateSourceAudioWindows(input), (error) => {
      diagnostic = error.diagnostic;
      return error.code === REVIEW;
    });
    assertDiagnostic(diagnostic, input.audioSha256, expectedWindows(requests, replies), mixedLanguage ? 'language_conflict' : 'seam_conflict');
    assert.deepEqual(Object.keys(diagnostic).sort(), ['audio_duration_ms', 'audio_sha256', 'reason', 'schema_version', 'status', 'windows']);
    diagnostic.windows[0].analysis_range_ms.end_ms = 1;
    diagnostic.windows[0].raw_source_evidence.segments[0].text = 'mutated returned copy';
    assert.deepEqual(input, before, 'the diagnostic must be a deep copy, not shared or normalized Worker JSON');
  });
}

test('accepted complete-segment decision persists resume_pending on the same task and held reservation', { timeout: 30000 }, async (t) => {
  const fixture = createFixture(t);
  const candidate = assertStoredCandidate(fixture, await fixture.start());
  const before = snapshot(fixture);
  const work = fixture.work();
  const task = fixture.task();
  assert.equal(typeof sourceAudio.recordSourceAudioSeamDecision, 'function');
  const context = {
    db: fixture.db, storageRoot: fixture.storageRoot, tenantId: 'tenant-1', userId: 'user-1',
    now: () => '2026-09-09T00:01:00.000Z',
  };
  const request = {
    workId: 1, analysisTaskId: task.id, candidateSha256: candidate.candidate_sha256,
    expectedWorkUpdatedAt: work.updated_at, expectedTaskUpdatedAt: task.updated_at,
    decisions: [{ seam_ms: 1500000, left_window_id: 'aw000001', right_window_id: 'aw000002',
      selected_window_id: 'aw000001' }],
  };
  const handlers = require('../src/routes/redraw')(fixture.db, log, {
    cfg: { storage: { local_path: fixture.storageRoot } },
    referenceArtifactTempRoot: path.join(fixture.root, 'reference-imports'),
  });
  const res = { statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  await handlers.recordSourceAudioSeamDecision({ params: { id: '1' }, tenant: { id: 'tenant-1' },
    user: { id: 'user-1' }, body: {
      analysis_task_id: request.analysisTaskId, candidate_sha256: request.candidateSha256,
      expected_work_updated_at: request.expectedWorkUpdatedAt,
      expected_task_updated_at: request.expectedTaskUpdatedAt, decisions: request.decisions,
    } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const result = res.body.data;
  const afterWork = fixture.work();
  const afterTask = fixture.task();
  assert.equal(result.status, 'resume_pending');
  assert.equal(result.work_id, 1);
  assert.equal(result.analysis_task_id, task.id);
  assert.equal(result.candidate_sha256, candidate.candidate_sha256);
  assert.equal(afterWork.status, 'needs_attention');
  assert.equal(afterTask.status, 'needs_attention');
  assert.equal(afterTask.completed_at, null);
  assert.equal(afterWork.task_id, work.task_id, 'never create or replace the analysis task');
  assert.equal(afterWork.credit_reservation_id, work.credit_reservation_id);
  assert.equal(afterTask.credit_reservation_id, task.credit_reservation_id);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM async_tasks').get().n, before.async_tasks.length);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM tenant_usage_reservations').get().n,
    before.tenant_usage_reservations.length);
  assert.equal(fixture.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
  const stored = JSON.parse(afterTask.result);
  assert.deepEqual(Object.keys(stored).sort(), ['source_audio_evidence', 'status']);
  assert.equal(stored.status, 'resume_pending');
  assert.equal(stored.source_audio_evidence.work_id, 1);
  assert.equal(stored.source_audio_evidence.task_id, candidate.source_audio_task_id);
  assert.equal(stored.source_audio_evidence.manual_seam_review.candidate_sha256, candidate.candidate_sha256);
  assert.equal(stored.source_audio_evidence.segments[0].source_text, '  Keep the complete original sentence. \n');
  assert.ok(Number.isSafeInteger(stored.source_audio_evidence.result_asset_id));
  assert.match(stored.source_audio_evidence.evidence_sha256, /^[a-f0-9]{64}$/);
  const evidenceAsset = fixture.db.prepare('SELECT * FROM assets WHERE id = ?')
    .get(stored.source_audio_evidence.result_asset_id);
  assert.equal(evidenceAsset.category, 'redraw_source_audio_evidence');
  assert.equal(evidenceAsset.deleted_at, null);
  const evidencePath = path.join(fixture.storageRoot, evidenceAsset.local_path);
  assert.equal(fs.statSync(evidencePath).isFile(), true);
  assert.equal(hash(fs.readFileSync(evidencePath)), stored.source_audio_evidence.evidence_sha256);
  const persistedCore = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const expectedCore = {
    ...sourceAudio.resolveSourceAudioSeamDecision({
      schema_version: 'redraw-source-audio-seam-candidate-v1', status: 'needs_review',
      audio_duration_ms: persistedCore.audio_duration_ms, audio_sha256: persistedCore.audio_sha256,
      reason: persistedCore.manual_seam_review.candidate_reason, windows: persistedCore.windows,
    }, {
      candidate_sha256: persistedCore.manual_seam_review.candidate_sha256,
      decisions: persistedCore.manual_seam_review.decisions,
    }),
    task_id: persistedCore.task_id, work_id: persistedCore.work_id, tenant_id: persistedCore.tenant_id,
    user_id: persistedCore.user_id, source_asset_id: persistedCore.source_asset_id,
    source_video_sha256: persistedCore.source_video_sha256, created_at: persistedCore.created_at,
  };
  assert.deepEqual(persistedCore, expectedCore, 'serialized core must equal an independent manual-decision rebuild');
  assert.deepEqual(sourceAudio.validatePersistedSourceAudioV2(persistedCore), persistedCore);
  assert.deepEqual(sourceAudio.validatePersistedSourceAudioV2(stored.source_audio_evidence),
    stored.source_audio_evidence, 'the persisted resume payload must be independently reproducible');
  const pendingReview = await sourceAudio.getSourceAudioSeamReview(context, { workId: 1 });
  assert.deepEqual(pendingReview, {
    schema_version: 'redraw-source-audio-seam-review-v1', status: 'resume_pending',
    work_id: 1, analysis_task_id: task.id, source_asset_id: fixture.source.id,
    source_fingerprint: fixture.sourceSha256,
    expected_work_updated_at: result.expected_work_updated_at,
    expected_task_updated_at: result.expected_task_updated_at,
    candidate_sha256: candidate.candidate_sha256,
    reason: 'seam_conflict', decisions: request.decisions,
  }, 'a reload can continue the already-persisted decision without another decision write');
  assert.equal(fixture.nativeCalls, 0);
  assert.equal(fixture.fusionCalls, 0);
  assert.equal(fixture.workerCalls.length, 2, 'decision persistence never invokes ASR again');
  const accepted = snapshot(fixture);
  assert.deepEqual(await sourceAudio.recordSourceAudioSeamDecision(context, request), result,
    'a response-loss repeat returns the same accepted result');
  assert.deepEqual(snapshot(fixture), accepted, 'an exact repeat performs no second write');
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE category = 'redraw_source_audio_evidence'").get().n, 1,
    'an exact repeat never registers a second evidence asset');
  await assert.rejects(() => sourceAudio.recordSourceAudioSeamDecision(context, {
    ...request, decisions: [{ ...request.decisions[0], selected_window_id: 'aw000002' }],
  }), { code: 'SOURCE_AUDIO_SEAM_DECISION_STALE' });
  assert.deepEqual(snapshot(fixture), accepted, 'a changed decision cannot replace an accepted choice');

  assert.equal(typeof redraw.claimSourceAudioSeamResume, 'function');
  const claim = redraw.claimSourceAudioSeamResume(fixture.db, {
    workId: 1, analysisTaskId: task.id, tenantId: 'tenant-1', userId: 'user-1',
    candidateSha256: candidate.candidate_sha256,
    expectedWorkUpdatedAt: result.expected_work_updated_at,
    expectedTaskUpdatedAt: result.expected_task_updated_at,
    now: '2026-09-09T00:02:00.000Z',
  });
  assert.equal(claim.status, 'processing');
  assert.equal(claim.work.id, 1);
  assert.equal(claim.task.id, task.id);
  assert.equal(claim.audioEvidence.manual_seam_review.candidate_sha256, candidate.candidate_sha256);
  assert.equal(fixture.work().status, 'analyzing');
  assert.equal(fixture.task().status, 'processing');
  assert.equal(fixture.task().result, afterTask.result, 'claim does not discard the durable resume payload');
  assert.equal(fixture.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM async_tasks').get().n, before.async_tasks.length);
  assert.equal(fixture.workerCalls.length, 2);
  assert.equal(fixture.nativeCalls, 0);
  assert.equal(fixture.fusionCalls, 0);
  assert.throws(() => redraw.claimSourceAudioSeamResume(fixture.db, {
    workId: 1, analysisTaskId: task.id, tenantId: 'tenant-1', userId: 'user-1',
    candidateSha256: candidate.candidate_sha256,
    expectedWorkUpdatedAt: result.expected_work_updated_at,
    expectedTaskUpdatedAt: result.expected_task_updated_at,
    now: '2026-09-09T00:02:00.000Z',
  }), { code: 'REDRAW_SOURCE_AUDIO_RESUME_STALE' });
});

test('confirmed seam resumes the original analysis task without another source-audio recognition', { timeout: 30000 }, async (t) => {
  const fixture = createFixture(t, { resumePipeline: true });
  const candidate = assertStoredCandidate(fixture, await fixture.start());
  const work = fixture.work();
  const task = fixture.task();
  const recorded = await sourceAudio.recordSourceAudioSeamDecision({
    db: fixture.db, storageRoot: fixture.storageRoot, tenantId: 'tenant-1', userId: 'user-1',
    now: () => '2026-09-09T00:01:00.000Z',
  }, {
    workId: 1, analysisTaskId: task.id, candidateSha256: candidate.candidate_sha256,
    expectedWorkUpdatedAt: work.updated_at, expectedTaskUpdatedAt: task.updated_at,
    decisions: [{ seam_ms: 1500000, left_window_id: 'aw000001', right_window_id: 'aw000002',
      selected_window_id: 'aw000001' }],
  });
  const beforeTaskCount = fixture.db.prepare('SELECT COUNT(*) AS n FROM async_tasks').get().n;
  const beforeReservationCount = fixture.db.prepare('SELECT COUNT(*) AS n FROM tenant_usage_reservations').get().n;

  assert.equal(typeof redraw.resumeSourceAudioSeamAnalysis, 'function');
  const result = await redraw.resumeSourceAudioSeamAnalysis(fixture.db, log, {
    workId: 1, analysisTaskId: task.id, tenantId: 'tenant-1', userId: 'user-1',
    candidateSha256: candidate.candidate_sha256,
    expectedWorkUpdatedAt: recorded.expected_work_updated_at,
    expectedTaskUpdatedAt: recorded.expected_task_updated_at,
    now: '2026-09-09T00:02:00.000Z',
  }, fixture.options);

  assert.equal(result.status, 'completed');
  assert.equal(result.analysis_task_id, task.id);
  assert.equal(result.work_id, 1);
  assert.equal(result.review_status, 'needs_review');
  assert.match(result.blueprint_hash, /^[a-f0-9]{64}$/);
  assert.equal(fixture.task().id, task.id);
  assert.equal(fixture.task().status, 'completed');
  assert.equal(fixture.work().status, 'needs_attention');
  assert.equal(fixture.work().current_step, 1);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM async_tasks').get().n, beforeTaskCount);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM tenant_usage_reservations').get().n, beforeReservationCount);
  assert.equal(fixture.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'confirmed');
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM redraw_episode_blueprints').get().n, 1);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM redraw_versions').get().n, 1);
  assert.equal(fixture.workerCalls.length, 2, 'resume consumes the persisted decision instead of invoking ASR again');
  assert.equal(fixture.nativeCalls, 1);
  assert.equal(fixture.fusionCalls, 1);
  const blueprint = JSON.parse(fixture.db.prepare('SELECT blueprint_json FROM redraw_episode_blueprints').get().blueprint_json);
  assert.equal(blueprint.shots[0].dialogue[0].source_text, 'Keep the complete original sentence.');
  assert.equal(blueprint.shots[0].dialogue[0].start_ms, 1499000.4);
  assert.equal(blueprint.shots[0].dialogue[0].end_ms, 1502000.6);
});

function writeSparseWav(file) {
  const dataSize = DURATION_MS * 32;
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

function snapshot(fixture, tables = ['redraw_works', 'async_tasks', 'assets', 'redraw_versions',
  'redraw_episode_blueprints', 'redraw_workflow_events', 'tenant_usage_reservations', 'tenant_credit_ledger', 'tenant_credit_accounts']) {
  return Object.fromEntries(tables.map((table) => [table, fixture.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

function billingSnapshot(fixture) {
  return snapshot(fixture, ['tenant_usage_reservations', 'tenant_credit_ledger', 'tenant_credit_accounts']);
}

function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-seam-candidate-'));
  const ownedRoot = fs.realpathSync.native(root);
  const storageRoot = path.join(root, 'storage');
  const privateAudioRoot = path.join(root, 'private-audio');
  fs.mkdirSync(storageRoot); fs.mkdirSync(privateAudioRoot, { mode: 0o700 });
  const sourcePath = path.join(storageRoot, 'source.mp4');
  const sourceBytes = Buffer.from('LOCAL SYNTHETIC SOURCE VIDEO - G2 SEAM CANDIDATE');
  fs.writeFileSync(sourcePath, sourceBytes);
  const db = new Database(':memory:', {
    nativeBinding: path.resolve(__dirname, '../node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
  });
  runMigrationsAndEnsure(db);
  t.after(() => {
    db.close();
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    assert.equal(fs.realpathSync.native(root), ownedRoot);
    assert.equal(path.dirname(ownedRoot), fs.realpathSync.native(os.tmpdir()));
    assert.match(path.basename(ownedRoot), /^g2-seam-candidate-/);
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  });
  const now = '2026-09-09T00:00:00.000Z';
  // In-memory fixture-only readiness row; never real model capability evidence.
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
    VALUES (1, 'tenant-1', 'user-1', 'G2 seam candidate fixture', 'draft', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO redraw_works
    (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, status, current_step, created_at, updated_at)
    VALUES (1, 1, 'tenant-1', 'user-1', 'G2 seam candidate fixture', ?, ?, ?, 'draft', 1, ?, ?)`)
    .run(source.id, hash(sourceBytes), DURATION_MS, now, now);
  const fixture = { root, db, source, sourcePath, storageRoot, privateAudioRoot, sourceSha256: hash(sourceBytes),
    workerCalls: [], workerReplies: [], nativeCalls: 0, fusionCalls: 0, extractionCalls: 0, fullWavReads: 0,
    work() { return db.prepare('SELECT * FROM redraw_works WHERE id = 1').get(); },
    task() { return db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(fixture.work().task_id); },
    cancel() { assert.equal(taskService.cancelTask(db, log, fixture.work().task_id, 'G2 seam cancellation').ok, true); },
  };
  const fsApi = Object.create(fs);
  fsApi.createReadStream = (file, ...args) => {
    const stream = fs.createReadStream(file, ...args);
    if (file === fixture.fullWavPath && ++fixture.fullWavReads === 2) {
      stream.once('end', () => {
        assert.equal(fixture.workerCalls.length, 2, 'source revalidation race occurs only after both windows finished');
        options.afterFullWav?.(fixture);
      });
    }
    return stream;
  };
  const ids = [INTERNAL_TASK_ID, '22222222-2222-4222-8222-222222222222'];
  fixture.options = {
    analysisContext: {
      db, log, fs: fsApi, storageRoot, privateAudioRoot, assetService,
      ffmpegPath: 'synthetic-audio-extractor', now: () => now,
      idFactory: () => { assert.ok(ids.length, 'no second source-audio submission'); return ids.shift(); },
      assertAnalysisTaskCurrent: () => { throw new Error('untrusted context guard must be replaced'); },
      execFile: async (command, args, execOptions) => {
        fixture.extractionCalls += 1;
        fixture.heldBilling = billingSnapshot(fixture);
        assert.equal(command, 'synthetic-audio-extractor');
        assert.equal(execOptions.shell, false);
        assert.equal(execOptions.windowsHide, true);
        assert.equal(path.dirname(args[5]), path.dirname(args.at(-1)), 'extract only the task-owned source snapshot');
        assert.deepEqual(fs.readFileSync(args[5]), sourceBytes);
        fixture.fullWavPath = args.at(-1);
        writeSparseWav(fixture.fullWavPath);
        fixture.audioSha256 = hash(fs.readFileSync(fixture.fullWavPath));
      },
      workerClient: { async analyzeSourceAudio(input) {
        fixture.workerCalls.push(input);
        assert.equal(input.preserveSourceEvidence, true);
        assert.ok(fs.statSync(input.audioPath).size < 67108864);
        assert.equal(input.privateAudioRoot, privateAudioRoot);
        if (options.workerError) throw Object.assign(new Error('synthetic Worker failure'), { code: options.workerError });
        const reply = workerReceipt(input, fixture.workerCalls.length - 1, options.mixedLanguage);
        fixture.workerReplies.push(reply);
        return reply;
      } },
    },
    sourceAudioEvidenceService: { async analyzeSourceAudio(context, input) {
      fixture.audioContext = context;
      fixture.audioInput = input;
      if (options.codeOnly) throw Object.assign(new Error('synthetic same-code error without diagnostic'), { code: REVIEW });
      try { return await sourceAudio.analyzeSourceAudio(context, input); }
      catch (error) {
        fixture.audioError = error;
        fixture.phase = 'audio-error';
        options.editDiagnostic?.(error, fixture);
        options.afterDiagnostic?.(fixture);
        throw error;
      }
    } },
    nativeSourceAnalysisService: { async analyzeNativeSource(_context, _request, audioEvidence) {
      fixture.nativeCalls += 1;
      if (options.resumePipeline) {
        assert.equal(audioEvidence.manual_seam_review.candidate_reason, 'seam_conflict');
        return { status: 'completed', provider_task_id: 'local-native-resume-only',
          source: { asset_id: fixture.source.id, sha256: fixture.sourceSha256, duration_ms: DURATION_MS,
            width: 1080, height: 1920, fps: 25, video_codec: 'h264', audio_codec: 'aac',
            audio_sample_rate_hz: 48000, audio_channels: 2 }, facts: {} };
      }
      throw new Error('Native must not run for an unconfirmed source-audio conflict');
    } },
    evidenceFusionService: { async fuseEpisodeEvidence(input, audioContext) {
      fixture.fusionCalls += 1;
      if (options.resumePipeline) return resumedBlueprint(input, audioContext);
      throw new Error('Fusion must not run for an unconfirmed source-audio conflict');
    } },
  };
  if (options.transactionRace) {
    const transaction = db.transaction.bind(db);
    db.transaction = (callback) => {
      const actual = transaction((...args) => {
        if (fixture.phase === 'audio-error' && options.transactionRace === 'after-BEGIN' && !fixture.raceReached) {
          fixture.raceReached = true;
          assert.equal(db.inTransaction, true, 'inject stale state inside the real SQLite transaction');
          fixture.before = snapshot(fixture);
          if (options.transactionChange) options.transactionChange(fixture);
          else fixture.cancel();
        }
        return callback(...args);
      });
      const invoke = (run) => (...args) => {
        if (fixture.phase === 'audio-error' && options.transactionRace === 'before-BEGIN' && !fixture.raceReached) {
          fixture.raceReached = true;
          assert.equal(db.inTransaction, false, 'inject stale state just before the real SQLite transaction');
          if (options.transactionChange) options.transactionChange(fixture);
          else fixture.cancel();
          fixture.before = snapshot(fixture);
        }
        return run(...args);
      };
      return Object.assign(invoke(actual), {
        deferred: invoke(actual.deferred), immediate: invoke(actual.immediate), exclusive: invoke(actual.exclusive),
      });
    };
  }
  fixture.start = () => redraw.startAnalysis(db, log, { workId: 1, userId: 'user-1', tenantId: 'tenant-1' }, fixture.options)
    .then((result) => ({ result }), (error) => ({ error }));
  return fixture;
}

function assertNoSuccess(fixture) {
  assert.equal(fixture.nativeCalls, 0);
  assert.equal(fixture.fusionCalls, 0);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE category != 'redraw_source'").get().n, 0);
  for (const table of ['redraw_versions', 'redraw_episode_blueprints', 'redraw_workflow_events']) {
    assert.equal(fixture.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `no successful ${table} row`);
  }
  assert.deepEqual(fs.readdirSync(fixture.privateAudioRoot), [], 'private source snapshot and every WAV must be removed');
  assert.equal(fs.existsSync(path.join(fixture.storageRoot, 'redraw-source-audio-evidence')), false, 'no success evidence artifact directory');
}

function assertNoCandidate(fixture) {
  const result = fixture.task()?.result;
  assert.equal(Object.hasOwn(result ? JSON.parse(result) : {}, 'source_audio_seam_review'), false);
  assertNoSuccess(fixture);
}

function assertStoredCandidate(fixture, outcome, mixedLanguage = false) {
  assert.equal(outcome.error?.code, REVIEW, outcome.error?.stack || 'analysis returned without the original conflict');
  assert.equal(outcome.error, fixture.audioError, 'persisting a candidate must not replace or swallow the original error');
  const task = fixture.task();
  assert.equal(task.status, 'needs_attention');
  assert.equal(fixture.work().status, 'needs_attention');
  assert.equal(task.completed_at, null);
  assert.ok(task.result, 'the real async task must retain the review candidate');
  const result = JSON.parse(task.result);
  assert.deepEqual(Object.keys(result).sort(), ['source_audio_seam_review', 'status']);
  assert.equal(result.status, 'needs_review');
  const candidate = result.source_audio_seam_review;
  assertDiagnostic(candidate, fixture.audioSha256, expectedWindows(fixture.workerCalls, fixture.workerReplies),
    mixedLanguage ? 'language_conflict' : 'seam_conflict');
  assert.equal(candidate.work_id, 1);
  assert.equal(candidate.tenant_id, 'tenant-1');
  assert.equal(candidate.user_id, 'user-1');
  assert.equal(candidate.source_asset_id, fixture.source.id);
  assert.equal(candidate.source_video_sha256, fixture.sourceSha256, 'bind to the real source snapshot, not the audio hash');
  assert.equal(candidate.source_audio_task_id, INTERNAL_TASK_ID);
  assert.equal(candidate.analysis_task_id, task.id, 'only the actual async task id is the candidate analysis id');
  assert.notEqual(candidate.analysis_task_id, candidate.source_audio_task_id);
  const { candidate_sha256: candidateSha256, ...unsigned } = candidate;
  assert.equal(candidateSha256, hash(stableStringify(unsigned)), 'hash every candidate field except candidate_sha256 itself');
  assert.deepEqual(fixture.audioInput, { workId: 1, sourceAssetId: fixture.source.id, tenantId: 'tenant-1', userId: 'user-1' });
  assert.equal(fixture.extractionCalls, 1);
  assert.equal(fixture.workerCalls.length, 2);
  assert.equal(fixture.fullWavReads, 2, 'initial and final full-WAV SHA verification completed');
  assert.deepEqual(billingSnapshot(fixture), fixture.heldBilling, 'review does not settle, refund, re-reserve or rewrite billing');
  assert.equal(fixture.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
  assertNoSuccess(fixture);
  return candidate;
}

for (const mixedLanguage of [false, true]) {
  test(`real 35-minute ${mixedLanguage ? 'mixed-language' : 'seam'} conflict persists a task-owned candidate and keeps credit held`, { timeout: 30000 }, async (t) => {
    const fixture = createFixture(t, { mixedLanguage });
    const outcome = await fixture.start();
    const candidate = assertStoredCandidate(fixture, outcome, mixedLanguage);
    const saved = fixture.task().result;
    fixture.workerReplies[0].rawSourceEvidence.segments[0].text = 'caller changed Worker receipt';
    outcome.error.diagnostic.windows[1].raw_source_evidence.segments[0].end = 0;
    candidate.windows[0].commit_range_ms.end_ms = 1;
    assert.equal(fixture.task().result, saved, 'persisted raw diagnostics do not share later mutable caller objects');
  });
}

test('starting an unresolved seam candidate again creates no task, reservation, extraction or Worker call', { timeout: 30000 }, async (t) => {
  const fixture = createFixture(t);
  assertStoredCandidate(fixture, await fixture.start());
  const before = snapshot(fixture);
  const second = await fixture.start();
  assert.equal(second.error?.code, 'REDRAW_ANALYSIS_RESULT_UNKNOWN');
  assert.deepEqual(snapshot(fixture), before);
  assert.equal(fixture.extractionCalls, 1);
  assert.equal(fixture.workerCalls.length, 2);
  assertNoSuccess(fixture);
});

for (const [column, value] of [['tenant_id', 'tenant-2'], ['user_id', 'user-2'], ['source_asset_id', 99],
  ['source_fingerprint', 'c'.repeat(64)], ['task_id', 'replacement-task']]) {
  test(`completed seam receipt cannot persist after work ${column} changes`, { timeout: 30000 }, async (t) => {
    const fixture = createFixture(t, { afterDiagnostic(f) {
      f.originalTaskId = f.work().task_id;
      f.db.prepare(`UPDATE redraw_works SET ${column} = ? WHERE id = 1`).run(value);
      f.before = snapshot(f);
    } });
    const outcome = await fixture.start();
    assert.equal(fixture.audioError.code, REVIEW, 'the original full-window aggregate conflict was reached');
    assert.equal(outcome.error?.code, STALE);
    assert.deepEqual(snapshot(fixture), fixture.before, 'no candidate, asset, task/work or billing overwrite after a stale continuation');
    const result = fixture.db.prepare('SELECT result FROM async_tasks WHERE id = ?').get(fixture.originalTaskId).result;
    assert.equal(Object.hasOwn(result ? JSON.parse(result) : {}, 'source_audio_seam_review'), false);
    assertNoSuccess(fixture);
  });
}

for (const transactionRace of ['before-BEGIN', 'after-BEGIN']) {
  test(`seam candidate guard rejects stale state ${transactionRace} without any committed write`, { timeout: 30000 }, async (t) => {
    const fixture = createFixture(t, { transactionRace });
    const outcome = await fixture.start();
    assert.equal(fixture.raceReached, true, 'the actual error-persistence transaction was reached');
    assert.equal(fixture.audioError.code, REVIEW);
    assert.equal(outcome.error?.code, STALE);
    assert.deepEqual(snapshot(fixture), fixture.before, 'the real transaction either rejects before BEGIN or rolls back all inner writes');
    assert.equal(fixture.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
    assertNoCandidate(fixture);
  });
}

for (const [name, change, expectedCode] of [
  ['asset owner', (f) => f.db.prepare('UPDATE assets SET metadata = ? WHERE id = ?')
    .run(JSON.stringify({ tenant_id: 'tenant-1', user_id: 'user-2' }), f.source.id), 'SOURCE_AUDIO_SOURCE_ASSET_INVALID'],
  ['asset hash', (f) => f.db.prepare('UPDATE assets SET metadata = ? WHERE id = ?')
    .run(JSON.stringify({ tenant_id: 'tenant-1', user_id: 'user-1', sha256: 'c'.repeat(64) }), f.source.id), 'SOURCE_AUDIO_SOURCE_ASSET_HASH_INVALID'],
  ['source path', (f) => {
    fs.copyFileSync(f.sourcePath, path.join(f.storageRoot, 'moved-source.mp4'));
    f.db.prepare('UPDATE assets SET local_path = ? WHERE id = ?').run('moved-source.mp4', f.source.id);
  }, 'SOURCE_AUDIO_SOURCE_SNAPSHOT_FAILED'],
  ['source file stat', (f) => fs.appendFileSync(f.sourcePath, ' MUTATED'), 'SOURCE_AUDIO_SOURCE_SNAPSHOT_FAILED'],
]) {
  test(`conflict revalidates ${name} after final full-WAV verification before exposing a bound candidate`, { timeout: 30000 }, async (t) => {
    const fixture = createFixture(t, { afterFullWav: change });
    const outcome = await fixture.start();
    assert.equal(fixture.fullWavReads, 2);
    assert.equal(fixture.workerCalls.length, 2);
    assert.equal(outcome.error?.code, expectedCode, outcome.error?.stack);
    assert.equal(Object.hasOwn(outcome.error || {}, 'diagnostic'), false, 'stale source evidence must not escape as a bound review diagnostic');
    assertNoCandidate(fixture);
  });
}

for (const transactionRace of ['before-BEGIN', 'after-BEGIN']) {
  for (const [name, metadata, expectedCode] of [
    ['owner', { tenant_id: 'tenant-1', user_id: 'user-2' }, 'SOURCE_AUDIO_SOURCE_ASSET_INVALID'],
    ['valid SHA', { tenant_id: 'tenant-1', user_id: 'user-1', sha256: 'c'.repeat(64) }, 'SOURCE_AUDIO_SOURCE_ASSET_HASH_INVALID'],
  ]) {
    test(`an issued candidate cannot persist after source asset ${name} changes ${transactionRace}`, { timeout: 30000 }, async (t) => {
      const fixture = createFixture(t, { transactionRace, transactionChange(f) {
        assert.equal(f.audioError.code, REVIEW, 'SourceAudio already issued the full-window conflict');
        assert.equal(f.audioError.diagnostic.schema_version, SCHEMA);
        f.db.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), f.source.id);
      } });
      const outcome = await fixture.start();
      assert.equal(fixture.raceReached, true);
      assert.equal(outcome.error?.code, expectedCode, outcome.error?.stack);
      assert.deepEqual(snapshot(fixture), fixture.before, 'no candidate or settlement can commit against a changed source asset');
      assert.equal(fixture.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, 'held');
      assertNoCandidate(fixture);
    });
  }
}

for (const [name, change] of [
  ['missing schema', (diagnostic) => { delete diagnostic.schema_version; }],
  ['wrong schema', (diagnostic) => { diagnostic.schema_version = 'redraw-source-audio-evidence-v2'; }],
  ['wrong owner', (diagnostic) => { diagnostic.user_id = 'user-2'; }],
  ['wrong source id', (diagnostic) => { diagnostic.source_asset_id = 99; }],
  ['wrong source hash', (diagnostic) => { diagnostic.source_video_sha256 = 'c'.repeat(64); }],
  ['malformed audio hash', (diagnostic) => { diagnostic.audio_sha256 = 'not-a-sha256'; }],
  ['missing internal task id', (diagnostic) => { delete diagnostic.source_audio_task_id; }],
  ['incomplete windows', (diagnostic) => { diagnostic.windows.pop(); }],
]) {
  test(`a ${name} diagnostic is never saved as a human-review candidate`, { timeout: 30000 }, async (t) => {
    const fixture = createFixture(t, { editDiagnostic(error) { change(error.diagnostic); } });
    const outcome = await fixture.start();
    assert.ok(outcome.error);
    assert.equal(fixture.workerCalls.length, 2, 'use a real aggregate conflict, then corrupt its claimed binding');
    assertNoCandidate(fixture);
    assert.notEqual(fixture.task().status, 'completed');
    assert.notEqual(fixture.work().status, 'completed');
  });
}

test('the seam error code alone cannot manufacture a review candidate', { timeout: 30000 }, async (t) => {
  const fixture = createFixture(t, { codeOnly: true });
  const outcome = await fixture.start();
  assert.equal(outcome.error?.code, REVIEW);
  assert.equal(fixture.workerCalls.length, 0);
  assert.equal(fixture.extractionCalls, 0);
  assertNoCandidate(fixture);
  assert.notEqual(fixture.task().status, 'completed');
});

for (const workerError of ['SYNTHETIC_EXPLICIT_FAILURE', 'REDRAW_LOCALE_VERIFIER_TIMEOUT']) {
  test(`current ${workerError} retains its existing failure and credit semantics without a seam candidate`, { timeout: 30000 }, async (t) => {
    const fixture = createFixture(t, { workerError });
    const outcome = await fixture.start();
    const unknown = workerError === 'REDRAW_LOCALE_VERIFIER_TIMEOUT';
    assert.equal(outcome.error?.code, unknown ? 'SOURCE_AUDIO_RESULT_UNKNOWN' : 'SOURCE_AUDIO_ANALYSIS_FAILED');
    assert.equal(fixture.task().status, unknown ? 'needs_attention' : 'failed');
    assert.equal(fixture.work().status, unknown ? 'needs_attention' : 'failed');
    assert.equal(fixture.db.prepare('SELECT status FROM tenant_usage_reservations').get().status, unknown ? 'held' : 'refunded');
    if (unknown) assert.deepEqual(billingSnapshot(fixture), fixture.heldBilling);
    assert.equal(fixture.workerCalls.length, 1);
    assertNoCandidate(fixture);
  });
}
