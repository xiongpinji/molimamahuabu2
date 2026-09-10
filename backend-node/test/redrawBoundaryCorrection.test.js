'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const assets = require('../src/services/assetService');
const workflow = require('../src/services/redrawBlueprintWorkflowService');
const { normalizeEpisodeBlueprint } = require('../src/services/redrawEpisodeBlueprintService');
const localization = require('../src/services/localizationService');
const { previewVersionExecutionPlan } = require('../src/services/redrawExecutionPlanPreviewService');
const routes = require('../src/routes/redraw');

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const now = '2026-09-06T04:00:00.000Z';
const log = { info() {}, warn() {}, error() {} };
const ref = 'boundary-original-asr';
let schema;

function blueprintFixture() {
  const evidence = () => ({ evidence_refs: [ref], confidence: 0.8 });
  const turn = (id, start, end, text) => ({ id, speaker_id: 'character-1', speaker_kind: 'character', off_screen: false,
    start_ms: start, end_ms: end, source_text: text, source_language: 'zh-CN', emotion: '平静',
    ...evidence(), review_status: 'approved' });
  const shot = (index, start, end, dialogue) => ({ id: `shot-${index}`, index, start_ms: start, end_ms: end,
    composition: '窗边的中景', camera_movement: '固定', opening_state: '她拿着包。', continuous_action: '她整理背包。',
    ending_state: '她背起包。', visible_character_ids: ['character-1'], dialogue, text_regions: [],
    audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
    confidence: { character_mapping: 0.8, speaker_mapping: 0.8, text_regions: 0.8, shot_boundary: 0.8 }, evidence_refs: [ref] });
  return {
    schema_version: 'episode-blueprint-v1', source: { asset_id: 1, sha256: hash('boundary-source-fixture'), duration_ms: 12000,
      width: 1280, height: 720, fps: 25, video_codec: 'h264', audio_codec: 'aac', audio_sample_rate_hz: 48000, audio_channels: 2 },
    evidence_manifest: { items: [{ id: ref, kind: 'audio_transcript', asset_id: 2, sha256: hash('asr'), tool: 'local-fixture', tool_version: '1' }] },
    story: { summary: '她和同伴一起出发。', beats: ['她背起包。'], ...evidence() },
    characters: [{ id: 'character-1', source_name: '林雨', display_name: '林雨', relationship: '同行者',
      relationships: [], face_track_ids: [], ...evidence(), review_status: 'approved' }],
    scenes: [{ id: 'scene-1', location: '门口', time: '早晨', source_ranges: [{ start_ms: 0, end_ms: 12000 }], ...evidence() }],
    props: [{ id: 'prop-1', name: '背包', evidence_ranges: [{ start_ms: 0, end_ms: 12000 }], ...evidence() }],
    shots: [shot(1, 0, 5000, [turn('line-1', 500, 2400, '别丢了。')]),
      shot(2, 5000, 9000, [turn('line-2', 5000, 6800, '我们走吧。'), turn('line-shift', 8900, 9000, '等等我。')]),
      shot(3, 9000, 12000, [turn('line-3', 10000, 11000, '来了。')])],
    causal_chain: [{ id: 'cause-1', cause: '他们准备好了。', effect: '他们出发。', ...evidence() }],
    locked_facts: [{ id: 'fact-1', text: '他们一起出发。', ...evidence() }],
    reversals: [{ id: 'reversal-1', text: '门外有人。', ...evidence() }],
    episode_hook: { text: '来者是谁？', ...evidence() }, review: { status: 'approved', reviewer: 'initial-reviewer' },
  };
}

function harness(t, { noAsr = false, silence = null, orphanSpeech = false } = {}) {
  if (!schema) {
    const seed = new Database(':memory:'); runMigrationsAndEnsure(seed); schema = seed.serialize(); seed.close();
  }
  const db = new Database(schema);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-boundary-'));
  t.after(() => {
    db.close();
    assert.equal(path.dirname(storageRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(storageRoot).startsWith('redraw-boundary-'));
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  const ctx = { db, storageRoot, tenantId: 'tenant-a', userId: 'user-a' };
  const raw = JSON.parse(JSON.stringify(blueprintFixture()));
  // These bytes test source binding, not actual video decoding or provider quality.
  fs.writeFileSync(path.join(storageRoot, 'source.mp4'), 'boundary-source-fixture');
  const source = assets.create(db, log, { name: 'local source', type: 'video', category: 'redraw_source',
    local_path: 'source.mp4', metadata: { tenant_id: ctx.tenantId, user_id: ctx.userId } });
  raw.source.asset_id = source.id;
  const evidence = { schema_version: 'redraw-source-audio-evidence-v1', task_id: 'local-asr-only', work_id: 1,
    tenant_id: ctx.tenantId, user_id: ctx.userId, source_asset_id: source.id, source_video_sha256: raw.source.sha256,
    audio_sha256: hash('audio'), transcript_sha256: hash('transcript'), source_language: 'zh-CN', language_probability: 0.98,
    dialogue_mode: 'spoken', created_at: now, segments: raw.shots.flatMap((shot) => shot.dialogue).map((turn) => ({
      id: turn.id, start_ms: turn.id === 'line-2' ? 4600 : turn.start_ms,
      end_ms: turn.id === 'line-shift' ? 9800 : turn.end_ms,
      source_text: turn.source_text, speaker_cluster_id: 'speaker-cluster-1',
    })) };
  if (silence) {
    for (const shot of silence === 'spoken_gap' ? raw.shots.slice(2) : raw.shots) {
      shot.dialogue = []; shot.audio_contract.dialogue_mode = 'silent';
    }
    if (silence === 'spoken_gap') {
      raw.shots[1].dialogue.pop();
      evidence.segments = evidence.segments.filter((turn) => ['line-1', 'line-2'].includes(turn.id));
    } else {
      Object.assign(evidence, { dialogue_mode: 'silent', segments: [], source_language: null,
        language_probability: null, transcript_sha256: hash('[]') });
      if (silence === 'no_audio') evidence.audio_sha256 = null;
      if (['vad', 'invalid_vad', 'short_vad'].includes(silence)) {
        evidence.no_speech_evidence = { method: 'faster-whisper-vad', audio_duration_ms: 12000, speech_duration_ms: 0 };
        if (silence === 'invalid_vad') evidence.no_speech_evidence.speech_duration_ms = 10;
        if (silence === 'short_vad') evidence.no_speech_evidence.audio_duration_ms = 4000;
      }
    }
  }
  if (orphanSpeech) evidence.segments.push({ id: 'unassigned-line', start_ms: 9200, end_ms: 9300,
    source_text: '还在这里。', speaker_cluster_id: 'speaker-cluster-1' });
  const evidencePath = path.join(storageRoot, 'original-asr.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  const evidenceSha = hash(fs.readFileSync(evidencePath));
  let evidenceAsset;
  if (noAsr) {
    Object.assign(raw.evidence_manifest.items[0], { kind: 'subtitle', asset_id: source.id, sha256: raw.source.sha256 });
  } else {
    evidenceAsset = assets.create(db, log, { name: 'original ASR', type: 'json', category: 'redraw_source_audio_evidence',
      local_path: 'original-asr.json', file_size: fs.statSync(evidencePath).size,
      metadata: { ...evidence, segments: undefined, evidence_sha256: evidenceSha } });
    Object.assign(raw.evidence_manifest.items[0], { asset_id: evidenceAsset.id, sha256: evidenceSha });
  }
  db.prepare(`INSERT INTO redraw_projects (id,tenant_id,user_id,title,status,created_at,updated_at)
    VALUES (1,'tenant-a','user-a','boundary','draft',?,?)`).run(now, now);
  db.prepare(`INSERT INTO redraw_works
    (id,project_id,tenant_id,user_id,title,source_asset_id,source_fingerprint,duration_ms,current_version,current_step,status,created_at,updated_at)
    VALUES (1,1,'tenant-a','user-a','boundary',?,?,12000,1,1,'needs_attention',?,?)`).run(source.id, raw.source.sha256, now, now);
  workflow.createOrSaveDraft(ctx, { workId: 1, blueprint: raw });
  const handler = routes(db, log, { cfg: { storage: { local_path: storageRoot } }, uploadLimits: { storageRoot } });
  return { db, ctx, handler, evidencePath, evidenceSha, evidenceAsset };
}

function call(h, method, body, userId = 'user-a') {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  h.handler[method]({ params: { id: '1' }, tenant: { id: 'tenant-a' }, user: { id: userId }, query: {}, body }, res);
  return res;
}
function read(h) {
  const res = call(h, 'getBlueprint'); assert.equal(res.statusCode, 200, JSON.stringify(res.body)); return res.body.data;
}
function save(h, record, blueprint) {
  return call(h, 'saveBlueprint', { expected_updated_at: record.updated_at, blueprint });
}
function saved(h, record, blueprint) {
  const res = save(h, record, blueprint); assert.equal(res.statusCode, 200, JSON.stringify(res.body)); return res.body.data;
}
function lock(h, record) {
  return call(h, 'lockBlueprint', { expected_updated_at: record.updated_at, expected_blueprint_hash: record.blueprint_hash });
}
function approve(h, record) {
  const draft = structuredClone(record.blueprint);
  for (const shot of draft.shots) for (const turn of shot.dialogue) turn.review_status = 'approved';
  draft.review = { status: 'approved', reviewer: 'boundary-reviewer' };
  return saved(h, record, draft);
}
function moveBoundary(record) {
  const draft = structuredClone(record.blueprint);
  draft.shots[0].end_ms = 5500;
  draft.shots[1].start_ms = 5500;
  if (draft.shots[1].dialogue.length > 0) draft.shots[1].dialogue[0].start_ms = 5500;
  return draft;
}
function reassignWithoutBoundary(record, start = 4600) {
  const draft = structuredClone(record.blueprint), moved = draft.shots[1].dialogue.shift();
  moved.start_ms = start; moved.end_ms = 5000;
  draft.shots[0].dialogue.push(moved);
  return draft;
}
function businesses(h) {
  const allowed = ['redraw_episode_blueprints', 'redraw_versions', 'redraw_works', 'redraw_shots'];
  return h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .filter(({ name }) => !allowed.includes(name)).map(({ name }) => [name, h.db.prepare(`SELECT * FROM "${name}"`).all()]);
}
function rejectedWithoutWrites(h, operation, expectedStatus = 400) {
  const dbBefore = h.db.serialize(), evidenceBefore = fs.readFileSync(h.evidencePath);
  const result = operation();
  assert.equal(result.statusCode, expectedStatus, JSON.stringify(result.body));
  if (expectedStatus === 400) {
    assert.equal(result.body.error.code, 'REDRAW_BLUEPRINT_CORRECTION_INVALID');
    assert.equal(result.body.error.message, '母本蓝图请求无效');
  }
  assert.equal(JSON.stringify(result.body).includes(h.ctx.storageRoot), false);
  assert.equal(JSON.stringify(result.body).includes('original-asr.json'), false);
  assert.deepEqual(h.db.serialize(), dbBefore, 'denied request must not change any database table');
  assert.deepEqual(fs.readFileSync(h.evidencePath), evidenceBefore, 'original ASR must remain byte-identical');
  return result;
}

test('ordinary ASR turn with a wrong clipped projection cannot be saved after an adjacent boundary change', (t) => {
  const h = harness(t), current = read(h), draft = moveBoundary(current);
  draft.shots[1].dialogue[0].start_ms = 5700;
  rejectedWithoutWrites(h, () => save(h, current, draft));
});

test('valid adjacent boundary correction is server-marked, retains whole original sentences and locks real rows', (t) => {
  const h = harness(t), current = read(h), before = businesses(h);
  const result = saved(h, current, moveBoundary(current));
  assert.deepEqual(result.blueprint.shots.map((shot) => shot.manual_boundary), [true, true, undefined]);
  assert.notEqual(result.blueprint_hash, current.blueprint_hash);
  assert.deepEqual(result.blueprint.source, current.blueprint.source);
  assert.deepEqual(result.blueprint.scenes, current.blueprint.scenes);
  assert.deepEqual(result.blueprint.shots.map((shot) => shot.text_regions), current.blueprint.shots.map((shot) => shot.text_regions));
  const full = result.source_dialogue.find((turn) => turn.dialogue_id === 'line-2');
  assert.equal(full.status, 'resolved'); assert.equal(full.source_start_ms, 4600); assert.equal(full.source_end_ms, 6800);
  assert.equal(full.projection_start_ms, 5500); assert.equal(full.source_text, '我们走吧。');
  const locked = lock(h, approve(h, result)); assert.equal(locked.statusCode, 200, JSON.stringify(locked.body));
  const rows = h.db.prepare('SELECT shot_id,start_ms,end_ms FROM redraw_shots ORDER BY shot_index').all();
  assert.deepEqual(rows, [{ shot_id: 'shot-1', start_ms: 0, end_ms: 5500 },
    { shot_id: 'shot-2', start_ms: 5500, end_ms: 9000 }, { shot_id: 'shot-3', start_ms: 9000, end_ms: 12000 }]);
  assert.deepEqual(businesses(h), before); assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
});

for (const operation of ['same-hash save', 'lock']) {
  test(`a previously corrected boundary rejects ${operation} after original ASR file drift with zero writes`, (t) => {
    const h = harness(t), current = read(h), record = approve(h, saved(h, current, moveBoundary(current)));
    fs.appendFileSync(h.evidencePath, ' ');
    rejectedWithoutWrites(h, () => operation === 'lock' ? lock(h, record) : save(h, record, record.blueprint));
  });
}

test('omitted persisted manual boundary flags are restored before hashing and cannot downgrade later save checks', (t) => {
  const h = harness(t), current = read(h), record = saved(h, current, moveBoundary(current));
  const draft = structuredClone(record.blueprint);
  for (const shot of draft.shots) delete shot.manual_boundary;
  const result = saved(h, record, draft);
  assert.deepEqual(result.blueprint.shots.map((shot) => shot.manual_boundary), [true, true, undefined]);
  assert.equal(result.blueprint_hash, record.blueprint_hash); assert.equal(result.updated_at, record.updated_at);
  draft.shots[1].dialogue[0].start_ms = 5700;
  rejectedWithoutWrites(h, () => save(h, result, draft));
});

for (const mutation of ['delete turn', 'rename turn', 'delete affected shot']) {
  test(`persisted boundary provenance rejects ${mutation} instead of losing the affected original turn IDs`, (t) => {
    const h = harness(t), current = read(h), record = saved(h, current, moveBoundary(current));
    const draft = structuredClone(record.blueprint);
    if (mutation === 'delete turn') draft.shots[1].dialogue.shift();
    if (mutation === 'rename turn') draft.shots[1].dialogue[0].id = 'renamed-line';
    if (mutation === 'delete affected shot') {
      draft.shots.shift(); draft.shots[0].start_ms = 0;
      draft.shots.forEach((shot, index) => { shot.index = index + 1; });
    }
    rejectedWithoutWrites(h, () => save(h, record, draft));
  });
}

test('moving an affected turn to another shot extends the durable review scope and validates the new projection', (t) => {
  const h = harness(t), current = read(h), record = saved(h, current, moveBoundary(current));
  const draft = structuredClone(record.blueprint), moved = draft.shots[1].dialogue.pop();
  moved.start_ms = 9000; moved.end_ms = 9800; draft.shots[2].dialogue.unshift(moved);
  const result = saved(h, record, draft);
  assert.deepEqual(result.blueprint.shots.map((shot) => shot.manual_boundary), [true, true, true]);
  const invalid = structuredClone(result.blueprint);
  delete invalid.shots[2].manual_boundary; invalid.shots[2].dialogue[0].start_ms = 9200;
  rejectedWithoutWrites(h, () => save(h, result, invalid));
});

test('a wrong affected turn projection cannot escape by moving to an originally unmarked shot', (t) => {
  const h = harness(t), current = read(h), record = saved(h, current, moveBoundary(current));
  const draft = structuredClone(record.blueprint), moved = draft.shots[1].dialogue.pop();
  moved.start_ms = 9200; moved.end_ms = 9800; draft.shots[2].dialogue.unshift(moved);
  rejectedWithoutWrites(h, () => save(h, record, draft));
});

test('same-source new revisions inherit the current boundary provenance even when client flags are omitted', (t) => {
  const h = harness(t), current = read(h), record = saved(h, current, moveBoundary(current));
  assert.equal(lock(h, approve(h, record)).statusCode, 200);
  const draft = structuredClone(record.blueprint);
  for (const shot of draft.shots) delete shot.manual_boundary;
  draft.story.summary = '他们一起踏上了旅程。';
  const next = workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint: draft });
  assert.equal(next.revision, record.revision + 1);
  assert.deepEqual(next.blueprint.shots.map((shot) => shot.manual_boundary), [true, true, undefined]);
  fs.appendFileSync(h.evidencePath, ' ');
  const snapshot = h.db.serialize();
  assert.throws(() => workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint: draft }));
  assert.deepEqual(h.db.serialize(), snapshot);
});

test('a speaking legacy draft without complete original ASR cannot change its shot boundary', (t) => {
  const h = harness(t, { noAsr: true }), current = read(h);
  assert.ok(current.source_dialogue.every((source) => source.status === 'not_available'));
  rejectedWithoutWrites(h, () => save(h, current, moveBoundary(current)));
});

test('ordinary legacy edits without ASR or boundary changes keep the existing save policy', (t) => {
  const h = harness(t, { noAsr: true }), current = read(h), draft = structuredClone(current.blueprint);
  draft.shots[1].dialogue[0].source_text = '现在出发。';
  const result = saved(h, current, draft);
  assert.equal(result.blueprint.shots[1].dialogue[0].source_text, '现在出发。');
  assert.ok(result.blueprint.shots.every((shot) => !Object.hasOwn(shot, 'manual_boundary')));
  assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
});

test('boundary correction retains owner, stale CAS and locked guards without denied-request writes', (t) => {
  const h = harness(t), current = read(h), draft = moveBoundary(current);
  const foreign = rejectedWithoutWrites(h, () => call(h, 'saveBlueprint', {
    expected_updated_at: current.updated_at, blueprint: draft,
  }, 'foreign-user'), 404);
  assert.equal(foreign.statusCode, 404);
  const record = saved(h, current, draft);
  assert.equal(rejectedWithoutWrites(h, () => save(h, current, draft), 409).statusCode, 409);
  const locked = lock(h, approve(h, record)); assert.equal(locked.statusCode, 200);
  rejectedWithoutWrites(h, () => save(h, locked.body.data, locked.body.data.blueprint), 409);
});

for (const drift of ['asset owner', 'manifest hash', 'manifest removal', 'source hash']) {
  test(`a persisted manual boundary rejects ${drift} drift rather than accepting unverified original evidence`, (t) => {
    const h = harness(t), current = read(h), record = saved(h, current, moveBoundary(current));
    const draft = structuredClone(record.blueprint);
    if (drift === 'asset owner') {
      const meta = JSON.parse(h.db.prepare('SELECT metadata FROM assets WHERE id=?').get(h.evidenceAsset.id).metadata);
      meta.user_id = 'foreign-user'; h.db.prepare('UPDATE assets SET metadata=? WHERE id=?').run(JSON.stringify(meta), h.evidenceAsset.id);
    }
    if (drift === 'manifest hash') draft.evidence_manifest.items[0].sha256 = hash('forged-evidence');
    if (drift === 'manifest removal') draft.evidence_manifest.items[0].kind = 'subtitle';
    if (drift === 'source hash') draft.source.sha256 = hash('different-source');
    rejectedWithoutWrites(h, () => save(h, record, draft));
  });
}

test('manual boundary schema accepts only the optional literal true and includes it in the existing hash', () => {
  const draft = blueprintFixture(), original = normalizeEpisodeBlueprint(draft);
  draft.shots[0].manual_boundary = true;
  const marked = normalizeEpisodeBlueprint(draft);
  assert.equal(marked.shots[0].manual_boundary, true); assert.notEqual(marked.blueprint_hash, original.blueprint_hash);
  for (const value of [false, null, 0, 1, 'true', {}, []]) {
    draft.shots[0].manual_boundary = value;
    assert.throws(() => normalizeEpisodeBlueprint(draft));
  }
});

for (const silence of ['no_audio', 'vad']) {
  test(`verified ${silence} evidence permits an empty-dialogue boundary correction and lock without fabricated turns`, (t) => {
    const h = harness(t, { silence }), current = read(h), before = businesses(h);
    const result = saved(h, current, moveBoundary(current));
    assert.deepEqual(result.blueprint.shots.map((shot) => shot.manual_boundary), [true, true, undefined]);
    assert.ok(result.blueprint.shots.every((shot) => shot.dialogue.length === 0));
    assert.equal(lock(h, approve(h, result)).statusCode, 200);
    assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha); assert.deepEqual(businesses(h), before);
  });
}

for (const silence of ['missing_vad', 'invalid_vad', 'short_vad']) {
  test(`empty dialogue with ${silence} is not sufficient evidence for a silent boundary correction`, (t) => {
    const h = harness(t, { silence }), current = read(h);
    rejectedWithoutWrites(h, () => save(h, current, moveBoundary(current)));
  });
}

test('empty dialogue without any audio evidence cannot claim a verified silent boundary correction', (t) => {
  const h = harness(t, { noAsr: true, silence: 'no_audio' }), current = read(h);
  rejectedWithoutWrites(h, () => save(h, current, moveBoundary(current)));
});

for (const entry of [
  { silence: 'no_audio', accepted: true },
  { silence: 'vad', accepted: true },
  { silence: 'missing_vad' },
  { silence: 'invalid_vad' },
  { silence: 'short_vad' },
  { silence: 'no_audio', noAsr: true },
]) {
  test(`page empty-dialogue cut delegates ${entry.noAsr ? 'missing evidence' : entry.silence} verification to the real server`, async (t) => {
    const h = harness(t, entry), current = read(h), before = structuredClone(current);
    const review = await import('../../frontweb/src/utils/redrawBlueprintReviewState.js');
    assert.equal(typeof review.applyAdjacentBoundaryCorrection, 'function', 'page cut helper must exist');
    const state = review.boundaryCorrectionForReview(current, current.blueprint, 'shot-1', 'shot-2', 5500);
    assert.equal(state.status, 'pending_server_verification');
    assert.deepEqual(state.turns, []);
    const draft = review.applyAdjacentBoundaryCorrection(current, current.blueprint, 'shot-1', 'shot-2', {
      boundary_ms: 5500, assignments: [],
    });
    assert.deepEqual(current, before);
    assert.ok(draft.shots.every((shot) => shot.dialogue.length === 0));
    assert.deepEqual(draft.evidence_manifest, current.blueprint.evidence_manifest);
    if (!entry.accepted) return rejectedWithoutWrites(h, () => save(h, current, draft));
    const unchangedBusiness = businesses(h), result = saved(h, current, draft);
    assert.equal(result.blueprint.review.status, 'needs_review');
    rejectedWithoutWrites(h, () => lock(h, result), 409);
    assert.equal(lock(h, approve(h, result)).statusCode, 200);
    assert.deepEqual(businesses(h), unchangedBusiness);
    assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
  });
}

test('a silent shot inside complete spoken evidence can change boundaries only inside a speech-free interval', (t) => {
  const h = harness(t, { silence: 'spoken_gap' }), current = read(h), draft = structuredClone(current.blueprint);
  draft.shots[1].end_ms = 9400; draft.shots[2].start_ms = 9400;
  const result = saved(h, current, draft);
  assert.deepEqual(result.blueprint.shots.map((shot) => shot.manual_boundary), [undefined, true, true]);
  assert.equal(result.blueprint.shots[2].dialogue.length, 0);
  assert.equal(lock(h, approve(h, result)).statusCode, 200);
});

test('an empty-dialogue shot cannot hide an overlapping original sentence missing from the entire blueprint', (t) => {
  const h = harness(t, { silence: 'spoken_gap', orphanSpeech: true }), current = read(h), draft = structuredClone(current.blueprint);
  draft.shots[1].end_ms = 9100; draft.shots[2].start_ms = 9100;
  rejectedWithoutWrites(h, () => save(h, current, draft));
});

for (const drift of ['file', 'owner']) {
  test(`persisted silent boundaries revalidate ${drift} binding on same-hash save and lock`, (t) => {
    const h = harness(t, { silence: 'vad' }), current = read(h), record = approve(h, saved(h, current, moveBoundary(current)));
    if (drift === 'file') fs.appendFileSync(h.evidencePath, ' ');
    else {
      const meta = JSON.parse(h.db.prepare('SELECT metadata FROM assets WHERE id=?').get(h.evidenceAsset.id).metadata);
      meta.user_id = 'foreign-user'; h.db.prepare('UPDATE assets SET metadata=? WHERE id=?').run(JSON.stringify(meta), h.evidenceAsset.id);
    }
    rejectedWithoutWrites(h, () => save(h, record, record.blueprint));
    rejectedWithoutWrites(h, () => lock(h, record));
});
}

test('a correct cut revokes overall and affected dialogue approval before the previous review can lock it', (t) => {
  const h = harness(t), current = read(h), record = saved(h, current, moveBoundary(current));
  assert.equal(record.blueprint.review.status, 'needs_review');
  assert.equal(record.blueprint.review.reviewer, undefined);
  assert.ok(record.blueprint.shots.slice(0, 2).flatMap((shot) => shot.dialogue).every((turn) => turn.review_status === 'needs_review'));
  assert.equal(record.blueprint.shots[2].dialogue[0].review_status, 'approved');
  rejectedWithoutWrites(h, () => lock(h, record), 409);
  const reviewed = approve(h, record);
  assert.equal(lock(h, reviewed).statusCode, 200);
});

test('an empty-dialogue shot may contain speech fully preserved by one resolved sentence assigned to its neighbor', (t) => {
  const h = harness(t), current = read(h), draft = structuredClone(current.blueprint);
  draft.shots[0].end_ms = 1000; draft.shots[1].start_ms = 1000;
  const turn = draft.shots[0].dialogue.pop(); turn.start_ms = 1000;
  draft.shots[0].audio_contract.dialogue_mode = 'silent';
  draft.shots[1].dialogue[0].start_ms = 4600; draft.shots[1].dialogue.unshift(turn);
  const result = saved(h, current, draft);
  assert.deepEqual(result.blueprint.shots.map((shot) => shot.manual_boundary), [true, true, undefined]);
  assert.equal(result.blueprint.shots[0].dialogue.length, 0);
  const resolved = result.source_dialogue.filter((item) => item.dialogue_id === 'line-1');
  assert.equal(resolved.length, 1); assert.equal(resolved[0].status, 'resolved');
  assert.equal(resolved[0].shot_id, 'shot-2'); assert.equal(resolved[0].source_start_ms, 500);
  assert.equal(resolved[0].source_end_ms, 2400); assert.equal(resolved[0].cross_shot, true);
  assert.equal(lock(h, approve(h, result)).statusCode, 200);
  assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
});

test('omitting flags and spoofing a different source cannot erase same-work provenance in a new revision', (t) => {
  const h = harness(t), current = read(h), record = saved(h, current, moveBoundary(current));
  const draft = structuredClone(record.blueprint);
  for (const shot of draft.shots) delete shot.manual_boundary;
  draft.source.sha256 = hash('client-only-new-source'); draft.story.summary = '另一次分析。';
  const before = h.db.serialize();
  assert.throws(() => workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint: draft }), { code: 'REDRAW_BLUEPRINT_CORRECTION_INVALID' });
  assert.deepEqual(h.db.serialize(), before); assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
});

test('a marked draft still rechecks ASR during an unrelated ordinary text save', (t) => {
  const h = harness(t), current = read(h), record = saved(h, current, moveBoundary(current));
  const draft = structuredClone(record.blueprint); draft.story.summary = '他们在门口集合。';
  fs.appendFileSync(h.evidencePath, ' ');
  rejectedWithoutWrites(h, () => save(h, record, draft));
});

test('explicit false cannot remove a persisted manual boundary marker', (t) => {
  const h = harness(t), current = read(h), record = saved(h, current, moveBoundary(current));
  const draft = structuredClone(record.blueprint); draft.shots[0].manual_boundary = false;
  rejectedWithoutWrites(h, () => save(h, record, draft));
});

test('the first cut conserves the entire affected original ID set before any marker is persisted', (t) => {
  const h = harness(t), current = read(h), draft = moveBoundary(current);
  draft.shots[1].dialogue.shift();
  rejectedWithoutWrites(h, () => save(h, current, draft));
});

test('a newly affected destination cannot delete its own original sentence while accepting a transferred one', (t) => {
  const h = harness(t), current = read(h), record = saved(h, current, moveBoundary(current));
  const draft = structuredClone(record.blueprint), moved = draft.shots[1].dialogue.pop();
  moved.start_ms = 9000; moved.end_ms = 9800; draft.shots[2].dialogue = [moved];
  rejectedWithoutWrites(h, () => save(h, record, draft));
});

for (const editor of [
  { name: 'direct draft', cut: 5500 },
  { name: 'page atomic cut and reassignment', cut: 7000, page: true },
  { name: 'page corrected sentence and atomic reassignment', cut: 7000, page: true, corrected: true },
]) {
test(`a locked corrected cut from ${editor.name} is consumed by real localization normalization and the version execution preview`, async (t) => {
  const h = harness(t), current = read(h);
  const before = structuredClone(current), unchangedBusiness = businesses(h);
  let draft = moveBoundary(current);
  if (editor.page) {
    const review = await import('../../frontweb/src/utils/redrawBlueprintReviewState.js');
    assert.equal(typeof review.applyAdjacentBoundaryCorrection, 'function', 'page cut helper must exist');
    draft = editor.corrected ? review.applyDialogueSourceCorrection(current, current.blueprint, 'shot-2', 'line-2', {
      source_text: '我们一起走吧。', source_start_ms: 4500, source_end_ms: 6900,
    }) : current.blueprint;
    draft = review.applyAdjacentBoundaryCorrection(current, draft, 'shot-1', 'shot-2', {
      boundary_ms: editor.cut, assignments: [
        { dialogue_id: 'line-1', target_shot_id: 'shot-1' },
        { dialogue_id: 'line-2', target_shot_id: 'shot-1' },
        { dialogue_id: 'line-shift', target_shot_id: 'shot-2' },
      ],
    });
    assert.equal(draft.review.status, 'needs_review');
    assert.equal(draft.review.reviewer, undefined);
    assert.deepEqual(current, before, 'page helper must not mutate its source record');
    for (const key of ['source', 'scenes', 'causal_chain', 'evidence_manifest']) {
      assert.deepEqual(draft[key], current.blueprint[key]);
    }
    assert.deepEqual(draft.shots.map((shot) => shot.text_regions), current.blueprint.shots.map((shot) => shot.text_regions));
    assert.deepEqual(draft.shots[2], current.blueprint.shots[2]);
    assert.equal(draft.shots.flatMap((shot) => shot.dialogue).filter((turn) => turn.id === 'line-2').length, 1);
  }
  const pending = saved(h, current, draft);
  if (editor.page) {
    rejectedWithoutWrites(h, () => lock(h, pending), 409);
    const source = pending.source_dialogue.find((turn) => turn.dialogue_id === 'line-2');
    assert.equal(source.status, 'resolved'); assert.equal(source.shot_id, 'shot-1');
    assert.equal(source.source_start_ms, editor.corrected ? 4500 : 4600);
    assert.equal(source.source_end_ms, editor.corrected ? 6900 : 6800);
    if (editor.corrected) {
      assert.equal(source.original_start_ms, 4600); assert.equal(source.original_end_ms, 6800);
      assert.equal(source.original_source_text, '我们走吧。');
    }
    assert.deepEqual(businesses(h), unchangedBusiness);
  }
  const record = approve(h, pending);
  const locked = lock(h, record); assert.equal(locked.statusCode, 200);
  const blueprint = locked.body.data.blueprint;
  const sourceDialogue = localization.resolveLocalizationSourceDialogue(h.db, h.ctx, 1, blueprint, h.ctx.storageRoot);
  const localized = localization.normalizeLocalizationResultV2({ blueprint_hash: blueprint.blueprint_hash,
    locale: 'en-US', market: 'US', name_map: { 'character-1': 'Joanna' },
    dialogue: blueprint.shots.map((shot) => ({ shot_id: shot.id, turns: shot.dialogue.map((turn) => ({ id: turn.id, target_text: 'Go.' })) })),
    text_map: {}, culture_map: [], glossary: [], locked_terms: [],
  }, blueprint, { locale: 'en-US', market: 'US', blueprintHash: blueprint.blueprint_hash, sourceDialogue,
    // Only target-language classification is replaced; source ASR and blueprint lock remain real.
    validateTargetText: ({ text }) => /^[a-zA-Z .]+$/.test(text) });
  const version = h.db.prepare('SELECT id FROM redraw_versions WHERE work_id=1 AND version=?').get(record.revision);
  h.db.prepare('UPDATE redraw_versions SET localization_hash=?,localization_review_json=? WHERE id=?')
    .run(localized.localization_hash, JSON.stringify(localized), version.id);
  const model = 'fumin-seedance-2.0-mini';
  const evidence = (id, provider, name) => ({ config_id: id, config_updated_at: now, provider, model: name,
    task_id: `local-task-${id}`, terminal_status: 'completed', artifact_id: 700 + id });
  const capabilities = { [model]: { durations: [5, 15], resolutions: ['480p'], aspectRatios: ['16:9'], supportsAudio: true,
    supportsImageReference: true, supportsVideoReference: true, supportsAudioReference: true,
    maxReferences: 9, maxVideoReferences: 3, maxAudioReferences: 3 } };
  h.db.prepare(`INSERT INTO ai_service_configs (id,service_type,provider,api_protocol,name,model,default_model,
    is_active,verification_status,settings,verified_capabilities,created_at,updated_at)
    VALUES (41,'video','fumin','fumin_video','local-fixture',?,?,1,'verified',?,?,?,?)`)
    .run(JSON.stringify([model]), model, JSON.stringify({ redraw_locale_capabilities: [{ locale: 'en-US', market: 'US',
      status: 'verified', evidence: { video: evidence(41, 'fumin', model) } }] }), JSON.stringify(capabilities), now, now);
  h.db.prepare(`INSERT INTO ai_service_configs (id,service_type,provider,name,model,default_model,
    is_active,verification_status,settings,created_at,updated_at)
    VALUES (42,'tts','minimax','local-tts',?,'speech-fixture',1,'verified',?,?,?)`)
    .run(JSON.stringify(['speech-fixture']), JSON.stringify({ redraw_locale_capabilities: [{ locale: 'en-US', market: 'US',
      status: 'verified', evidence: { tts: evidence(42, 'minimax', 'speech-fixture') } }] }), now, now);
  const previewBefore = h.db.serialize();
  const preview = previewVersionExecutionPlan({ ...h.ctx, canReadArtifact: (id) => [741, 742].includes(Number(id)) }, version.id);
  assert.equal(preview.status, 'ready', JSON.stringify(preview.blocking_reasons));
  assert.equal(preview.executable, false);
  const planned = preview.units.flatMap((unit) => unit.dialogues);
  assert.equal(new Set(planned.map((turn) => turn.id)).size, 4); assert.equal(planned.length, 4);
  const full = planned.find((turn) => turn.id === 'line-2');
  assert.equal(full.start_ms, editor.corrected ? 4500 : 4600);
  assert.equal(full.end_ms, editor.corrected ? 6900 : 6800);
  assert.equal(full.source_text, editor.corrected ? '我们一起走吧。' : '我们走吧。');
  assert.equal(blueprint.shots[1].start_ms, editor.cut);
  assert.deepEqual(h.db.serialize(), previewBefore); assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
});
}

test('pure dialogue reassignment rejects an invalid projection before any boundary provenance exists', (t) => {
  const h = harness(t), current = read(h);
  assert.ok(current.blueprint.shots.every((shot) => !Object.hasOwn(shot, 'manual_boundary')));
  rejectedWithoutWrites(h, () => save(h, current, reassignWithoutBoundary(current, 4700)));
});

test('valid pure dialogue reassignment marks both unchanged shots and requires a new explicit review before lock', (t) => {
  const h = harness(t), current = read(h), before = businesses(h);
  const record = saved(h, current, reassignWithoutBoundary(current));
  assert.deepEqual(record.blueprint.shots.map((shot) => [shot.start_ms, shot.end_ms]),
    current.blueprint.shots.map((shot) => [shot.start_ms, shot.end_ms]));
  assert.deepEqual(record.blueprint.shots.map((shot) => shot.manual_boundary), [true, true, undefined]);
  assert.equal(record.blueprint.review.status, 'needs_review');
  assert.equal(record.blueprint.review.reviewer, undefined);
  assert.ok(record.blueprint.shots.slice(0, 2).flatMap((shot) => shot.dialogue).every((turn) => turn.review_status === 'needs_review'));
  assert.deepEqual(record.blueprint.shots[2], current.blueprint.shots[2]);
  const full = record.source_dialogue.find((turn) => turn.dialogue_id === 'line-2');
  assert.equal(full.status, 'resolved'); assert.equal(full.shot_id, 'shot-1');
  assert.equal(full.source_start_ms, 4600); assert.equal(full.source_end_ms, 6800);
  assert.equal(full.projection_start_ms, 4600); assert.equal(full.projection_end_ms, 5000);
  rejectedWithoutWrites(h, () => lock(h, record), 409);
  assert.equal(lock(h, approve(h, record)).statusCode, 200);
  assert.deepEqual(businesses(h), before); assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
});

for (const operation of ['same-hash save', 'lock']) {
  test(`pure reassignment provenance rejects ${operation} after original ASR drift`, (t) => {
    const h = harness(t), current = read(h), record = approve(h, saved(h, current, reassignWithoutBoundary(current)));
    fs.appendFileSync(h.evidencePath, ' ');
    rejectedWithoutWrites(h, () => operation === 'lock' ? lock(h, record) : save(h, record, record.blueprint));
  });
}

test('same-source new revisions detect pure reassignment and retain its provenance on the next omitted-flag revision', (t) => {
  const h = harness(t), current = read(h);
  const reassigned = workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint: reassignWithoutBoundary(current) });
  assert.equal(reassigned.revision, current.revision + 1);
  assert.deepEqual(reassigned.blueprint.shots.map((shot) => shot.manual_boundary), [true, true, undefined]);
  assert.equal(reassigned.blueprint.review.status, 'needs_review');
  const draft = structuredClone(reassigned.blueprint);
  for (const shot of draft.shots) delete shot.manual_boundary;
  draft.story.summary = '他们又确认了一次行程。';
  const next = workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint: draft });
  assert.equal(next.revision, reassigned.revision + 1);
  assert.deepEqual(next.blueprint.shots.map((shot) => shot.manual_boundary), [true, true, undefined]);
  fs.appendFileSync(h.evidencePath, ' '); const before = h.db.serialize();
  assert.throws(() => workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint: draft }), { code: 'REDRAW_BLUEPRINT_CORRECTION_INVALID' });
  assert.deepEqual(h.db.serialize(), before);
});

test('pure reassignment cannot use missing original ASR while an ordinary unmoved legacy edit remains compatible', (t) => {
  const h = harness(t, { noAsr: true }), current = read(h);
  rejectedWithoutWrites(h, () => save(h, current, reassignWithoutBoundary(current)));
  const draft = structuredClone(current.blueprint); draft.story.summary = '普通的未切镜编辑。';
  const record = saved(h, current, draft);
  assert.ok(record.blueprint.shots.every((shot) => !Object.hasOwn(shot, 'manual_boundary')));
});

for (const mutation of ['move and rename', 'delete', 'insert', 'rename']) {
  for (const operation of ['save', 'same-source new revision']) {
    test(`an unmarked blueprint rejects original dialogue ID ${mutation} during ${operation} without any cut change`, (t) => {
      const h = harness(t), current = read(h);
      const draft = mutation === 'move and rename' ? reassignWithoutBoundary(current, 4700) : structuredClone(current.blueprint);
      if (mutation === 'move and rename') draft.shots[0].dialogue[1].id = 'renamed-line-2';
      if (mutation === 'delete') draft.shots[1].dialogue.shift();
      if (mutation === 'insert') draft.shots[1].dialogue.push({ ...structuredClone(draft.shots[1].dialogue[0]),
        id: 'inserted-line', start_ms: 7000, end_ms: 8000, source_text: '新加入的对白。' });
      if (mutation === 'rename') draft.shots[1].dialogue[0].id = 'renamed-line-2';
      assert.deepEqual(draft.shots.map((shot) => [shot.start_ms, shot.end_ms]),
        current.blueprint.shots.map((shot) => [shot.start_ms, shot.end_ms]));
      assert.ok(draft.shots.every((shot) => !Object.hasOwn(shot, 'manual_boundary')));
      if (operation === 'save') rejectedWithoutWrites(h, () => save(h, current, draft));
      else {
        const before = h.db.serialize(), evidenceBefore = fs.readFileSync(h.evidencePath);
        assert.throws(() => workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint: draft }),
          { code: 'REDRAW_BLUEPRINT_CORRECTION_INVALID' });
        assert.deepEqual(h.db.serialize(), before); assert.deepEqual(fs.readFileSync(h.evidencePath), evidenceBefore);
      }
    });
  }
}

test('duplicate dialogue IDs still fail the existing schema before any workflow write', (t) => {
  const h = harness(t), current = read(h), draft = structuredClone(current.blueprint);
  draft.shots[1].dialogue[0].id = draft.shots[0].dialogue[0].id;
  const before = h.db.serialize(), result = save(h, current, draft);
  assert.equal(result.statusCode, 400); assert.equal(result.body.error.code, 'REDRAW_BLUEPRINT_INPUT_INVALID');
  assert.deepEqual(h.db.serialize(), before); assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
});
