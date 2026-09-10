'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const assets = require('../src/services/assetService');
const workflow = require('../src/services/redrawBlueprintWorkflowService');
const { projectSourceFactsV2 } = require('../src/services/redrawEpisodeBlueprintService');
const routes = require('../src/routes/redraw');

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const now = '2026-09-05T14:00:00.000Z';
const log = { info() {}, warn() {}, error() {} };
const ref = 'visual-facts-original-asr';
const visualFields = ['composition', 'camera_movement', 'opening_state', 'continuous_action', 'ending_state', 'visible_character_ids'];
let schema;

function blueprintFixture() {
  const evidence = { evidence_refs: [ref], confidence: 0.8 };
  const character = (id, name) => ({ id, source_name: name, display_name: name, relationship: '同行者',
    relationships: [], face_track_ids: [], ...evidence, review_status: 'approved' });
  const shot = (id, index, start, end, turnStart, turnEnd, text) => ({ id, index, start_ms: start, end_ms: end,
    composition: '窗边的中景', camera_movement: '固定', opening_state: '她拿着包。',
    continuous_action: '她整理背包。', ending_state: '她背起包。', visible_character_ids: ['character-1'],
    dialogue: [{ id: `line-${index}`, speaker_id: 'character-1', speaker_kind: 'character', off_screen: false,
      start_ms: turnStart, end_ms: turnEnd, source_text: text, source_language: 'zh-CN', emotion: '平静',
      ...evidence, review_status: 'approved' }], text_regions: [],
    audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
    confidence: { character_mapping: 0.8, speaker_mapping: 0.8, text_regions: 0.8, shot_boundary: 0.8 }, evidence_refs: [ref] });
  return {
    schema_version: 'episode-blueprint-v1', source: { asset_id: 1, sha256: hash('local-source-hash-fixture'), duration_ms: 12000,
      width: 1280, height: 720, fps: 25, video_codec: 'h264', audio_codec: 'aac', audio_sample_rate_hz: 48000, audio_channels: 2 },
    evidence_manifest: { items: [{ id: ref, kind: 'audio_transcript', asset_id: 2, sha256: hash('asr'), tool: 'local-fixture', tool_version: '1' }] },
    story: { summary: '两个人出发。', beats: ['她背起包。'], ...evidence },
    characters: [character('character-1', '林雨'), character('character-2', '陈风')],
    scenes: [1, 2].map((id) => ({ id: `scene-${id}`, location: id === 1 ? '客厅' : '门口', time: '早晨',
      source_ranges: [{ start_ms: (id - 1) * 6000, end_ms: id * 6000 }], ...evidence })),
    props: [1, 2].map((id) => ({ id: `prop-${id}`, name: id === 1 ? '背包' : '门',
      evidence_ranges: [{ start_ms: 0, end_ms: 12000 }], ...evidence })),
    shots: [shot('shot-1', 1, 0, 5000, 500, 2400, '别丢了。'), shot('shot-2', 2, 5000, 12000, 5000, 6800, '我们走吧。')],
    causal_chain: [{ id: 'cause-1', cause: '他们准备好了。', effect: '他们出发。', ...evidence }],
    locked_facts: [{ id: 'fact-1', text: '他们一起出发。', ...evidence }],
    reversals: [{ id: 'reversal-1', text: '门外有人。', ...evidence }],
    episode_hook: { text: '来者是谁？', ...evidence }, review: { status: 'approved', reviewer: 'initial-reviewer' },
  };
}

function harness(t) {
  if (!schema) {
    const seed = new Database(':memory:'); runMigrationsAndEnsure(seed); schema = seed.serialize(); seed.close();
  }
  const db = new Database(schema);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-visual-facts-'));
  t.after(() => {
    db.close();
    assert.equal(path.dirname(storageRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(storageRoot).startsWith('redraw-visual-facts-'));
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  const ctx = { db, storageRoot, tenantId: 'tenant-a', userId: 'user-a' };
  // HTTP JSON contains distinct arrays rather than the fixture's shared evidence refs.
  const raw = JSON.parse(JSON.stringify(blueprintFixture()));
  // This fixture verifies source binding, not media decoding or model output quality.
  fs.writeFileSync(path.join(storageRoot, 'source.mp4'), 'local-source-hash-fixture');
  const source = assets.create(db, log, { name: 'local source', type: 'video', category: 'redraw_source',
    local_path: 'source.mp4', metadata: { tenant_id: ctx.tenantId, user_id: ctx.userId } });
  raw.source.asset_id = source.id;
  const evidence = { schema_version: 'redraw-source-audio-evidence-v1', task_id: 'local-asr-only', work_id: 1,
    tenant_id: ctx.tenantId, user_id: ctx.userId, source_asset_id: source.id, source_video_sha256: raw.source.sha256,
    audio_sha256: hash('audio'), transcript_sha256: hash('transcript'), source_language: 'zh-CN', language_probability: 0.98,
    dialogue_mode: 'spoken', created_at: now, segments: raw.shots.map((shot, index) => ({ id: shot.dialogue[0].id,
      start_ms: index === 0 ? 500 : 4600, end_ms: shot.dialogue[0].end_ms,
      source_text: shot.dialogue[0].source_text, speaker_cluster_id: 'speaker-cluster-1' })) };
  const evidencePath = path.join(storageRoot, 'original-asr.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  const evidenceSha = hash(fs.readFileSync(evidencePath));
  const asset = assets.create(db, log, { name: 'original ASR', type: 'json', category: 'redraw_source_audio_evidence',
    local_path: 'original-asr.json', file_size: fs.statSync(evidencePath).size,
    metadata: { ...evidence, segments: undefined, evidence_sha256: evidenceSha } });
  Object.assign(raw.evidence_manifest.items[0], { asset_id: asset.id, sha256: evidenceSha });
  db.prepare(`INSERT INTO redraw_projects (id,tenant_id,user_id,title,status,created_at,updated_at)
    VALUES (1,'tenant-a','user-a','visual facts','draft',?,?)`).run(now, now);
  db.prepare(`INSERT INTO redraw_works
    (id,project_id,tenant_id,user_id,title,source_asset_id,source_fingerprint,duration_ms,current_version,current_step,status,created_at,updated_at)
    VALUES (1,1,'tenant-a','user-a','visual facts',?,?,12000,1,1,'needs_attention',?,?)`).run(source.id, raw.source.sha256, now, now);
  workflow.createOrSaveDraft(ctx, { workId: 1, blueprint: raw });
  const handler = routes(db, log, { cfg: { storage: { local_path: storageRoot } }, uploadLimits: { storageRoot } });
  return { db, ctx, handler, evidencePath, evidenceSha };
}

async function uiHelpers() {
  const ui = await import(pathToFileURL(path.join(__dirname, '../../frontweb/src/utils/redrawBlueprintReviewState.js')).href);
  for (const name of ['applyShotVisualFactCorrection', 'applySceneFactCorrection', 'applyPropFactCorrection']) {
    assert.equal(typeof ui[name], 'function', `${name} must exist before product integration can pass`);
  }
  return ui;
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
  const res = call(h, 'saveBlueprint', { expected_updated_at: record.updated_at, blueprint });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body)); return res.body.data;
}
function lock(h, record) {
  return call(h, 'lockBlueprint', { expected_updated_at: record.updated_at, expected_blueprint_hash: record.blueprint_hash });
}
function shotInput(shot, patch = {}) { return { ...Object.fromEntries(visualFields.map((key) => [key, structuredClone(shot[key])])), ...patch }; }
function unchangedBusinesses(h) {
  const allowed = ['redraw_episode_blueprints', 'redraw_versions', 'redraw_works', 'redraw_shots'];
  return h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .filter(({ name }) => !allowed.includes(name)).map(({ name }) => [name, h.db.prepare(`SELECT * FROM "${name}"`).all()]);
}

test('three actual UI fact payloads save, require renewed review and project locked facts without changing source evidence', async (t) => {
  const ui = await uiHelpers(), h = harness(t), original = read(h), before = unchangedBusinesses(h);
  let draft = ui.applyShotVisualFactCorrection(original.blueprint, 'shot-1', shotInput(original.blueprint.shots[0], {
    composition: '  门口的双人中景  ', camera_movement: '轻轻推近', opening_state: '她拎起手提袋。', continuous_action: '她递出袋子。', ending_state: '同伴接过袋子。',
  }));
  draft = ui.applySceneFactCorrection(draft, 'scene-1', { location: '站台', time: '下午' });
  draft = ui.applyPropFactCorrection(draft, 'prop-1', { name: '手提袋' });
  assert.equal(draft.review.status, 'needs_review'); assert.equal(draft.review.reviewer, undefined);
  assert.deepEqual(draft.shots[0].dialogue, original.blueprint.shots[0].dialogue);
  assert.deepEqual(draft.shots[1], original.blueprint.shots[1]);
  assert.deepEqual(draft.scenes[1], original.blueprint.scenes[1]); assert.deepEqual(draft.props[1], original.blueprint.props[1]);
  let saved = save(h, original, draft); assert.notEqual(saved.blueprint_hash, original.blueprint_hash);
  assert.equal(saved.blueprint.shots[0].composition, '门口的双人中景');
  assert.deepEqual(saved.source_dialogue, original.source_dialogue);
  assert.notEqual(lock(h, saved).statusCode, 200, 'visual edit cannot inherit overall approval');
  saved = save(h, saved, ui.approveBlueprintReview(saved.blueprint, 'visual-reviewer'));
  const locked = lock(h, saved); assert.equal(locked.statusCode, 200, JSON.stringify(locked.body));
  const projected = projectSourceFactsV2(locked.body.data.blueprint);
  assert.equal(projected.shots[0].continuous_action, '她递出袋子。');
  assert.equal(projected.scenes[0].location, '站台'); assert.equal(projected.props[0].name, '手提袋');
  assert.deepEqual(unchangedBusinesses(h), before); assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
});

test('visible-character set change requires dialogue re-review, retains whole ASR ranges and reaches real locked rows', async (t) => {
  const ui = await uiHelpers(), h = harness(t), original = read(h), before = unchangedBusinesses(h);
  const draft = ui.applyShotVisualFactCorrection(original.blueprint, 'shot-1', shotInput(original.blueprint.shots[0], {
    visible_character_ids: ['character-2', 'character-1'],
  }));
  assert.equal(draft.shots[0].dialogue[0].review_status, 'needs_review');
  assert.equal(draft.shots[1].dialogue[0].review_status, 'approved');
  assert.throws(() => ui.approveBlueprintReview(draft, 'reviewer'));
  let saved = save(h, original, draft); assert.deepEqual(saved.source_dialogue, original.source_dialogue);
  assert.notEqual(lock(h, saved).statusCode, 200);
  saved = save(h, saved, ui.approveBlueprintReview(ui.approveDialogueReview(saved.blueprint, 'line-1'), 'reviewer'));
  const result = lock(h, saved); assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.deepEqual(projectSourceFactsV2(result.body.data.blueprint).shots[0].visible_character_ids, ['character-1', 'character-2']);
  assert.equal(result.body.data.source_dialogue[1].source_start_ms, 4600, 'cross-shot whole source time survives visual editing');
  assert.deepEqual(unchangedBusinesses(h), before); assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
});

test('removing a referenced on-screen character is rejected atomically, without silently changing dialogue or writing rows', async (t) => {
  const ui = await uiHelpers(), h = harness(t), original = read(h), snapshot = structuredClone(original), db = h.db.serialize();
  assert.throws(() => ui.applyShotVisualFactCorrection(original.blueprint, 'shot-1', shotInput(original.blueprint.shots[0], { visible_character_ids: ['character-2'] })));
  assert.deepEqual(original, snapshot); assert.deepEqual(h.db.serialize(), db);
});

test('visual edits retain real owner, stale CAS and locked-record rejection with zero denied-request writes', async (t) => {
  const ui = await uiHelpers(), h = harness(t), original = read(h);
  const draft = ui.applyPropFactCorrection(original.blueprint, 'prop-1', { name: '旧手提袋' });
  let saved = save(h, original, draft), snapshot = h.db.serialize();
  const stale = call(h, 'saveBlueprint', { expected_updated_at: original.updated_at, blueprint: draft });
  assert.equal(stale.statusCode, 409); assert.deepEqual(h.db.serialize(), snapshot);
  const foreign = call(h, 'saveBlueprint', { expected_updated_at: saved.updated_at, blueprint: draft }, 'foreign-user');
  assert.equal(foreign.statusCode, 404); assert.deepEqual(h.db.serialize(), snapshot);
  saved = save(h, saved, ui.approveBlueprintReview(saved.blueprint, 'reviewer'));
  const locked = lock(h, saved); assert.equal(locked.statusCode, 200); snapshot = h.db.serialize();
  const rejected = call(h, 'saveBlueprint', { expected_updated_at: locked.body.data.updated_at, blueprint: locked.body.data.blueprint });
  assert.notEqual(rejected.statusCode, 200); assert.deepEqual(h.db.serialize(), snapshot);
});

test('scene and prop edits reject invalid fields before a product save and preserve all source bindings', async (t) => {
  const ui = await uiHelpers(), h = harness(t), original = read(h), snapshot = structuredClone(original), db = h.db.serialize();
  for (const invalid of ['', ' '.repeat(3), 'x'.repeat(201), 'http://example.invalid/media', 'Bearer private', 'bad\0text', 123]) {
    assert.throws(() => ui.applyPropFactCorrection(original.blueprint, 'prop-1', { name: invalid }));
  }
  assert.throws(() => ui.applySceneFactCorrection(original.blueprint, 'scene-1', { location: '站台', time: '下午', source_ranges: [] }));
  assert.throws(() => ui.applyPropFactCorrection(original.blueprint, 'missing', { name: '袋子' }));
  assert.deepEqual(original, snapshot); assert.deepEqual(h.db.serialize(), db);
});

test('visual facts preserve an already verified manual dialogue correction and its immutable original anchor', async (t) => {
  const ui = await uiHelpers(), h = harness(t); let record = read(h);
  const corrected = ui.applyDialogueSourceCorrection(record, record.blueprint, 'shot-1', 'line-1', {
    source_text: '请别弄丢。', source_start_ms: 400, source_end_ms: 2600,
  });
  record = save(h, record, corrected); const before = unchangedBusinesses(h);
  const draft = ui.applyShotVisualFactCorrection(record.blueprint, 'shot-1', shotInput(record.blueprint.shots[0], { composition: '侧面的中景' }));
  assert.deepEqual(draft.shots[0].dialogue, record.blueprint.shots[0].dialogue);
  const saved = save(h, record, draft);
  assert.deepEqual(saved.source_dialogue, record.source_dialogue);
  assert.equal(saved.source_dialogue[0].source_origin, 'manual_correction');
  assert.equal(saved.source_dialogue[0].original_source_text, '别丢了。');
  assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha); assert.deepEqual(unchangedBusinesses(h), before);
});
