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
const { normalizeEpisodeBlueprint } = require('../src/services/redrawEpisodeBlueprintService');
const { resolveBlueprintDialogueSources } = require('../src/services/redrawSourceDialogueService');
const localization = require('../src/services/localizationService');
const { buildExecutionPlan } = require('../src/services/redrawExecutionPlanService');
const { previewVersionExecutionPlan } = require('../src/services/redrawExecutionPlanPreviewService');
const routes = require('../src/routes/redraw');

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const now = '2026-09-05T10:00:00.000Z';
const log = { info() {}, warn() {}, error() {} };
const ref = 'evidence-audio-1';
let schema;

// Standalone fixture: importing another test file would register its tests again.
function blueprintFixture() {
  const statement = (id) => ({ id, text: '她收到一封信。', evidence_refs: [ref], confidence: 0.9 });
  const turn = (id, start, end, text) => ({ id, speaker_id: 'character-1', speaker_kind: 'character',
    off_screen: false, start_ms: start, end_ms: end, source_text: text, source_language: 'zh-CN',
    emotion: '平静', evidence_refs: [ref], confidence: 0.9, review_status: 'approved' });
  const shot = (id, index, start, end, dialogue) => ({ id, index, start_ms: start, end_ms: end,
    composition: '她站在门口。', camera_movement: '定机位', opening_state: '她看见信。',
    continuous_action: '她打开信。', ending_state: '她读完信。', visible_character_ids: ['character-1'],
    dialogue: [dialogue], text_regions: [], audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
    confidence: { character_mapping: 0.9, speaker_mapping: 0.9, text_regions: 0.9, shot_boundary: 0.9 }, evidence_refs: [ref] });
  return {
    schema_version: 'episode-blueprint-v1', source: { asset_id: 1, sha256: hash('source'), duration_ms: 12000,
      width: 1080, height: 1920, fps: 25, video_codec: 'h264', audio_codec: 'aac', audio_sample_rate_hz: 48000, audio_channels: 2 },
    evidence_manifest: { items: [{ id: ref, kind: 'audio_transcript', asset_id: 2, sha256: hash('asr'), tool: 'fixture-asr', tool_version: '1' }] },
    story: { summary: '她收到一封信。', beats: ['她打开信。'], evidence_refs: [ref], confidence: 0.9 },
    characters: [{ id: 'character-1', source_name: '乔安', display_name: '乔安', relationship: '收信人',
      relationships: [], face_track_ids: [], evidence_refs: [ref], confidence: 0.9, review_status: 'approved' }],
    scenes: [{ id: 'scene-1', location: '门口', time: '白天', source_ranges: [{ start_ms: 0, end_ms: 12000 }], evidence_refs: [ref], confidence: 0.9 }],
    props: [{ id: 'prop-1', name: '信', evidence_ranges: [{ start_ms: 0, end_ms: 12000 }], evidence_refs: [ref], confidence: 0.9 }],
    shots: [shot('shot-1', 1, 0, 3000, turn('dialogue-1', 500, 1800, '我收到信了。')),
      shot('shot-2', 2, 3000, 12000, turn('dialogue-2', 3000, 4700, '不要打开那封信。'))],
    causal_chain: [{ id: 'cause-1', cause: '她收到信。', effect: '她打开信。', evidence_refs: [ref], confidence: 0.9 }],
    locked_facts: [statement('fact-1')], reversals: [statement('reversal-1')],
    episode_hook: { text: '谁写的信？', evidence_refs: [ref], confidence: 0.9 }, review: { status: 'approved', reviewer: 'reviewer-1' },
  };
}

function harness(t, { create = true, originalText } = {}) {
  if (!schema) {
    const seed = new Database(':memory:'); runMigrationsAndEnsure(seed); schema = seed.serialize(); seed.close();
  }
  const db = new Database(schema);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-dialogue-correction-'));
  t.after(() => { db.close(); fs.rmSync(storageRoot, { recursive: true, force: true }); });
  const ctx = { db, storageRoot, tenantId: 'tenant-a', userId: 'user-a' };
  const raw = blueprintFixture();
  fs.writeFileSync(path.join(storageRoot, 'source.mp4'), 'source');
  const source = assets.create(db, log, { name: 'source', type: 'video', category: 'redraw_source', local_path: 'source.mp4',
    metadata: { tenant_id: ctx.tenantId, user_id: ctx.userId } });
  raw.source.asset_id = source.id;
  const evidence = { schema_version: 'redraw-source-audio-evidence-v1', task_id: 'local-asr-1',
    work_id: 1, tenant_id: ctx.tenantId, user_id: ctx.userId, source_asset_id: source.id, source_video_sha256: raw.source.sha256,
    audio_sha256: hash('audio'), transcript_sha256: hash('transcript'), source_language: 'zh-CN', language_probability: 0.99,
    dialogue_mode: 'spoken', created_at: now,
    segments: raw.shots.map((shot, i) => ({ id: shot.dialogue[0].id, start_ms: i === 1 ? 2500 : 500,
      end_ms: shot.dialogue[0].end_ms, source_text: i === 1 && originalText !== undefined ? originalText : shot.dialogue[0].source_text,
      speaker_cluster_id: 'speaker-cluster-1' })) };
  const evidencePath = path.join(storageRoot, 'evidence.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  const evidenceSha = hash(fs.readFileSync(evidencePath));
  const audioAsset = assets.create(db, log, { name: 'original ASR', type: 'json', category: 'redraw_source_audio_evidence',
    local_path: 'evidence.json', file_size: fs.statSync(evidencePath).size,
    metadata: { ...evidence, segments: undefined, evidence_sha256: evidenceSha } });
  Object.assign(raw.evidence_manifest.items[0], { asset_id: audioAsset.id, sha256: evidenceSha });
  db.prepare(`INSERT INTO redraw_projects (id,tenant_id,user_id,title,status,created_at,updated_at)
    VALUES (1,'tenant-a','user-a','fixture','draft',?,?)`).run(now, now);
  db.prepare(`INSERT INTO redraw_works
    (id,project_id,tenant_id,user_id,title,source_asset_id,source_fingerprint,duration_ms,current_version,current_step,status,created_at,updated_at)
    VALUES (1,1,'tenant-a','user-a','fixture',?,?,12000,1,1,'needs_attention',?,?)`).run(source.id, raw.source.sha256, now, now);
  const record = create ? workflow.createOrSaveDraft(ctx, { workId: 1, blueprint: raw }) : null;
  return { ctx, db, raw, record, evidencePath, evidenceSha, evidence, audioAsset };
}

function corrected(h, index = 1, { start = 2200, end = 6500, text = '请不要打开这封信。' } = {}) {
  const blueprint = structuredClone(h.record?.blueprint || h.raw);
  const shot = blueprint.shots[index]; const turn = shot.dialogue[0]; const original = h.evidence.segments[index];
  turn.source_correction = { evidence_ref: ref, evidence_sha256: h.evidenceSha,
    original_source_text: original.source_text.trim(), original_start_ms: original.start_ms, original_end_ms: original.end_ms,
    source_start_ms: start, source_end_ms: end };
  turn.source_text = text; turn.start_ms = Math.max(start, shot.start_ms); turn.end_ms = Math.min(end, shot.end_ms);
  turn.review_status = 'needs_review'; blueprint.review = { status: 'needs_review' };
  return blueprint;
}
function resolve(h, blueprint) { return resolveBlueprintDialogueSources(h.ctx, { workId: 1, blueprint }); }
function save(h, blueprint, record = h.record, ctx = h.ctx) {
  return workflow.saveDraft(ctx, { workId: 1, blueprint, expected_updated_at: record.updated_at });
}
function lock(h, record, ctx = h.ctx) {
  return workflow.lockBlueprint(ctx, { workId: 1, expected_updated_at: record.updated_at, expected_blueprint_hash: record.blueprint_hash });
}
function approve(blueprint) {
  const next = structuredClone(blueprint);
  next.characters.forEach((item) => { item.review_status = 'approved'; });
  next.shots.forEach((shot) => shot.dialogue.forEach((turn) => { turn.review_status = 'approved'; }));
  next.review = { status: 'approved', reviewer: 'local-reviewer' }; return next;
}
function assertZeroWrite(h, action, code = 'REDRAW_BLUEPRINT_CORRECTION_INVALID') {
  const before = h.db.serialize(); assert.throws(action, { code }); assert.deepEqual(h.db.serialize(), before);
}
function unrelatedSnapshot(h) {
  const allowed = ['redraw_episode_blueprints', 'redraw_versions', 'redraw_works', 'redraw_shots'];
  return h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().filter(({ name }) => !allowed.includes(name)).map(({ name }) => [name, h.db.prepare(`SELECT * FROM "${name}"`).all()]);
}

for (const [label, index, start, end] of [['ordinary', 0, 600, 2100], ['cross-shot', 1, 2200, 6500]]) {
  test(`explicit ${label} text and whole-time correction resolves without changing original evidence`, (t) => {
    const h = harness(t); const before = h.db.serialize(); const draft = corrected(h, index, { start, end });
    const normalized = normalizeEpisodeBlueprint(draft);
    assert.deepEqual(normalized.shots[index].dialogue[0].source_correction, draft.shots[index].dialogue[0].source_correction);
    assert.notEqual(normalized.blueprint_hash, h.record.blueprint_hash);
    const result = resolve(h, normalized)[index]; const original = h.evidence.segments[index];
    assert.deepEqual(result, { dialogue_id: original.id, shot_id: `shot-${index + 1}`, status: 'resolved',
      reason: 'SOURCE_DIALOGUE_MANUAL_CORRECTION_RESOLVED', source_origin: 'manual_correction',
      original_source_text: original.source_text, original_start_ms: original.start_ms, original_end_ms: original.end_ms,
      source_start_ms: start, source_end_ms: end, source_text: '请不要打开这封信。', source_language: 'zh-CN',
      projection_start_ms: draft.shots[index].dialogue[0].start_ms, projection_end_ms: draft.shots[index].dialogue[0].end_ms,
      cross_shot: index === 1, evidence_ref: ref, evidence_sha256: h.evidenceSha });
    assert.deepEqual(h.db.serialize(), before); assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
  });
}

test('correction saves, reads back, requires renewed approval and locks without business side effects', (t) => {
  const h = harness(t); const before = unrelatedSnapshot(h); const saved = save(h, corrected(h));
  assert.deepEqual(workflow.getCurrentBlueprint(h.ctx, { workId: 1 }), saved);
  assertZeroWrite(h, () => lock(h, saved), 'BLUEPRINT_SPEAKER_REVIEW_REQUIRED');
  const onlyOverall = structuredClone(saved.blueprint); onlyOverall.review = { status: 'approved', reviewer: 'reviewer' };
  const notReviewed = save(h, onlyOverall, saved);
  assertZeroWrite(h, () => lock(h, notReviewed), 'BLUEPRINT_SPEAKER_REVIEW_REQUIRED');
  const approved = save(h, approve(notReviewed.blueprint), notReviewed); const locked = lock(h, approved);
  assert.equal(locked.status, 'locked'); assert.equal(resolve(h, locked.blueprint)[1].source_origin, 'manual_correction');
  const persisted = h.db.prepare('SELECT source_dialogue_json FROM redraw_shots WHERE shot_index=2').get();
  assert.equal(JSON.parse(persisted.source_dialogue_json)[0].source_text, '请不要打开这封信。');
  assert.deepEqual(unrelatedSnapshot(h), before); assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
  assertZeroWrite(h, () => save(h, locked.blueprint, locked), 'REDRAW_BLUEPRINT_LOCKED');
  assertZeroWrite(h, () => lock(h, locked), 'REDRAW_BLUEPRINT_LOCKED');
});

const bindingCases = [
  ['original text', (b) => { b.shots[1].dialogue[0].source_correction.original_source_text = '伪造识别稿'; }],
  ['original start', (b) => { b.shots[1].dialogue[0].source_correction.original_start_ms += 1; }],
  ['original end', (b) => { b.shots[1].dialogue[0].source_correction.original_end_ms += 1; }],
  ['dialogue ID', (b) => { b.shots[1].dialogue[0].id = 'forged-dialogue'; }],
  ['language', (b) => { b.shots[1].dialogue[0].source_language = 'en-US'; }],
  ['source ID', (b) => { b.source.asset_id += 100; }],
  ['source hash', (b) => { b.source.sha256 = hash('foreign'); }],
  ['manifest hash', (b) => { b.evidence_manifest.items[0].sha256 = hash('foreign'); b.shots[1].dialogue[0].source_correction.evidence_sha256 = hash('foreign'); }],
];
for (const [label, mutate] of bindingCases) {
  test(`correction rejects forged ${label} with zero save/create writes`, (t) => {
    const h = harness(t); const draft = corrected(h); mutate(draft);
    assert.equal(resolve(h, draft)[1].status, 'unresolved');
    assertZeroWrite(h, () => save(h, draft));
    assertZeroWrite(h, () => workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint: draft }));
  });
}

const structureCases = [
  ['null', (turn) => { turn.source_correction = null; }],
  ['array', (turn) => { turn.source_correction = []; }],
  ['unknown field', (turn) => { turn.source_correction.note = 'extra'; }],
  ['inherited field', (turn) => { Object.setPrototypeOf(turn.source_correction, { injected: true }); }],
  ['dangerous field', (turn) => { Object.defineProperty(turn.source_correction, '__proto__', { value: {}, enumerable: true }); }],
  ['hidden unknown field', (turn) => { Object.defineProperty(turn.source_correction, 'hidden', { value: 1 }); }],
  ['symbol field', (turn) => { turn.source_correction[Symbol('hidden')] = 1; }],
  ['missing field', (turn) => { delete turn.source_correction.original_source_text; }],
  ['invalid sha', (turn) => { turn.source_correction.evidence_sha256 = 'not-sha'; }],
  ['unbound sha', (turn) => { turn.source_correction.evidence_sha256 = hash('wrong'); }],
  ['foreign ref', (turn) => { turn.source_correction.evidence_ref = 'other-ref'; }],
  ['fractional time', (turn) => { turn.source_correction.source_start_ms = 2200.5; }],
  ['negative time', (turn) => { turn.source_correction.original_start_ms = -1; }],
  ['unsafe time', (turn) => { turn.source_correction.source_end_ms = Number.MAX_SAFE_INTEGER + 1; }],
  ['zero interval', (turn) => { turn.source_correction.source_end_ms = 2200; }],
  ['original zero interval', (turn) => { turn.source_correction.original_end_ms = 2500; }],
  ['past duration', (turn) => { turn.source_correction.source_end_ms = 12001; }],
  ['original past duration', (turn) => { turn.source_correction.original_end_ms = 12001; }],
  ['no intersection', (turn) => { turn.source_correction.source_start_ms = 0; turn.source_correction.source_end_ms = 3000; }],
  ['projection mismatch', (turn) => { turn.start_ms += 1; }],
  ['empty effective text', (turn) => { turn.source_text = ' '; }],
  ['long effective text', (turn) => { turn.source_text = '文'.repeat(501); }],
];
for (const [label, mutate] of structureCases) {
  test(`correction schema and resolver reject ${label}`, (t) => {
    const h = harness(t); const draft = corrected(h); mutate(draft.shots[1].dialogue[0]);
    assert.throws(() => normalizeEpisodeBlueprint(draft));
    assert.equal(resolve(h, draft)[1].status, 'unresolved');
    const bytes = h.db.serialize(); assert.throws(() => save(h, draft)); assert.deepEqual(h.db.serialize(), bytes);
  });
}

for (const onTurn of [false, true]) {
  test(`correction ${onTurn ? 'property' : 'field'} accessor is rejected without evaluating it`, (t) => {
    const h = harness(t); const draft = corrected(h); const turn = draft.shots[1].dialogue[0]; let reads = 0;
    Object.defineProperty(onTurn ? turn : turn.source_correction, onTurn ? 'source_correction' : 'source_start_ms',
      { enumerable: true, get() { reads += 1; return 2200; } });
    assert.throws(() => normalizeEpisodeBlueprint(draft)); assert.equal(reads, 0);
    assert.equal(resolve(h, draft)[1].status, 'unresolved'); assert.equal(reads, 0);
    assert.throws(() => save(h, draft)); assert.equal(reads, 0);
  });
}

test('correction ref must identify audio evidence even when a subtitle ref is present', (t) => {
  const h = harness(t); const draft = corrected(h); draft.evidence_manifest.items[0].kind = 'subtitle';
  assert.throws(() => normalizeEpisodeBlueprint(draft)); assert.equal(resolve(h, draft)[1].status, 'unresolved');
});

test('original ASR text anchor matches existing trimmed DTO while preserving evidence bytes', (t) => {
  const h = harness(t, { originalText: '  不要打开那封信。  ' }); const draft = corrected(h);
  const saved = save(h, draft); assert.equal(saved.blueprint.shots[1].dialogue[0].source_correction.original_source_text, '不要打开那封信。');
  assert.equal(resolve(h, saved.blueprint)[1].original_source_text, '不要打开那封信。');
  assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
  draft.shots[1].dialogue[0].source_correction.original_source_text = '不要打开那封信！';
  assertZeroWrite(h, () => save(h, draft, saved));
});

for (const [label, drift] of [
  ['file hash drift', (h) => fs.appendFileSync(h.evidencePath, ' ')],
  ['file deletion', (h) => fs.unlinkSync(h.evidencePath)],
  ['soft-deleted asset', (h) => h.db.prepare('UPDATE assets SET deleted_at=? WHERE id=?').run(now, h.audioAsset.id)],
  ['asset owner drift', (h) => { const metadata = structuredClone(h.audioAsset.metadata); metadata.user_id = 'foreign'; h.db.prepare('UPDATE assets SET metadata=? WHERE id=?').run(JSON.stringify(metadata), h.audioAsset.id); }],
]) {
  test(`${label} blocks repeated same-hash save/create and lock before any write`, (t) => {
    const h = harness(t); const saved = save(h, approve(corrected(h))); drift(h);
    assertZeroWrite(h, () => save(h, saved.blueprint, saved));
    assertZeroWrite(h, () => workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint: saved.blueprint }));
    assertZeroWrite(h, () => lock(h, saved));
    assert.equal(resolve(h, saved.blueprint)[1].status, 'unresolved');
  });
}

test('missing storageRoot rejects corrected create/save/lock but leaves legacy calls compatible', (t) => {
  const h = harness(t); const rawCtx = { db: h.db, tenant_id: 'tenant-a', user_id: 'user-a' };
  assert.deepEqual(workflow.createOrSaveDraft(rawCtx, { workId: 1, blueprint: h.raw }), h.record);
  assert.deepEqual(save(h, h.record.blueprint, h.record, rawCtx), h.record);
  const draft = corrected(h); assertZeroWrite(h, () => save(h, draft, h.record, rawCtx));
  assertZeroWrite(h, () => workflow.createOrSaveDraft(rawCtx, { workId: 1, blueprint: draft }));
  const saved = save(h, approve(draft)); assertZeroWrite(h, () => lock(h, saved, rawCtx));
});

test('corrected first draft can be created only with valid owned evidence', (t) => {
  const h = harness(t, { create: false }); const draft = corrected(h);
  const record = workflow.createOrSaveDraft(h.ctx, { workId: 1, blueprint: draft });
  assert.equal(record.revision, 1); assert.equal(resolve(h, record.blueprint)[1].status, 'resolved');
});

test('owner and CAS guards retain precedence and zero writes for correction operations', (t) => {
  const h = harness(t); const draft = corrected(h);
  for (const foreign of [{ userId: 'foreign' }, { tenantId: 'foreign' }]) {
    const ctx = { ...h.ctx, ...foreign };
    assertZeroWrite(h, () => save(h, draft, h.record, ctx), 'REDRAW_BLUEPRINT_NOT_FOUND');
    assertZeroWrite(h, () => workflow.createOrSaveDraft(ctx, { workId: 1, blueprint: draft }), 'REDRAW_BLUEPRINT_NOT_FOUND');
    assertZeroWrite(h, () => lock(h, h.record, ctx), 'REDRAW_BLUEPRINT_NOT_FOUND');
    assert.ok(resolveBlueprintDialogueSources(ctx, { workId: 1, blueprint: draft }).every((item) => item.status === 'unresolved'));
  }
  const saved = save(h, approve(draft)); fs.unlinkSync(h.evidencePath);
  assertZeroWrite(h, () => save(h, saved.blueprint), 'REDRAW_BLUEPRINT_CAS_CONFLICT');
  assertZeroWrite(h, () => lock(h, h.record), 'REDRAW_BLUEPRINT_CAS_CONFLICT');
});

for (const [label, mutate] of [['text', (turn) => { turn.source_text = '没有修订声明的改文'; }],
  ['projection', (turn) => { turn.start_ms += 1; }]]) {
  test(`legacy ${label} changes without correction remain unresolved and unchanged DTO stays identical`, (t) => {
    const h = harness(t); const original = resolve(h, h.record.blueprint); const draft = structuredClone(h.record.blueprint);
    mutate(draft.shots[1].dialogue[0]); const saved = save(h, draft);
    assert.equal(resolve(h, saved.blueprint)[1].status, 'unresolved'); assert.deepEqual(resolve(h, saved.blueprint)[0], original[0]);
    assert.equal(Object.hasOwn(original[0], 'source_origin'), false); assert.equal(Object.hasOwn(original[0], 'original_source_text'), false);
  });
}

test('changing only the complete interval changes hashes even when the whole-shot projection stays identical', (t) => {
  const h = harness(t);
  const first = normalizeEpisodeBlueprint(corrected(h, 0, { start: 0, end: 3500, text: '我收到信了。' }));
  const next = normalizeEpisodeBlueprint(corrected(h, 0, { start: 0, end: 4000, text: '我收到信了。' }));
  assert.equal(first.shots[0].dialogue[0].start_ms, next.shots[0].dialogue[0].start_ms);
  assert.equal(first.shots[0].dialogue[0].end_ms, next.shots[0].dialogue[0].end_ms);
  assert.notEqual(first.blueprint_hash, next.blueprint_hash);
  const a = resolve(h, first); const b = resolve(h, next);
  assert.equal(a[0].source_end_ms, 3500); assert.equal(b[0].source_end_ms, 4000);
  assert.notEqual(hash(JSON.stringify(a)), hash(JSON.stringify(b)));
});

function localizedFixture(h, blueprint) {
  const sourceDialogue = localization.resolveLocalizationSourceDialogue(h.db, h.ctx, 1, blueprint, h.ctx.storageRoot);
  const raw = { blueprint_hash: blueprint.blueprint_hash, locale: 'en-US', market: 'US', name_map: { 'character-1': 'Joanna' },
    dialogue: blueprint.shots.map((shot, i) => ({ shot_id: shot.id, turns: [{ id: shot.dialogue[0].id,
      target_text: i === 0 ? 'The letter arrived.' : shot.dialogue[0].source_correction
        ? 'Please do not open the sealed letter until I come back home.' : 'Wait for me.' }] })),
    text_map: {}, culture_map: [], glossary: [], locked_terms: [] };
  const options = { locale: 'en-US', market: 'US', blueprintHash: blueprint.blueprint_hash, sourceDialogue,
    // Only the unrelated language worker is replaced; source evidence always uses the real read-only resolver.
    validateTargetText: ({ text }) => /^[a-zA-Z .]+$/.test(text) };
  return { raw, options, localized: localization.normalizeLocalizationResultV2(raw, blueprint, options), sourceDialogue };
}

test('real localization and plan builder consume corrected effective text and complete sentence budget', (t) => {
  const h = harness(t); const blueprint = normalizeEpisodeBlueprint(approve(corrected(h)));
  const before = h.db.serialize(); const { raw, options, localized, sourceDialogue } = localizedFixture(h, blueprint);
  const turn = localized.dialogue_map[1];
  assert.equal(turn.source_text, '请不要打开这封信。'); assert.equal(turn.estimated_duration_ms, 3600);
  assert.ok(turn.estimated_duration_ms > turn.end_ms - turn.start_ms);
  assert.equal(turn.estimated_speech_rate, Number((Array.from(turn.target_text).length / 4.3).toFixed(2)));
  const plan = buildExecutionPlan({ duration_ms: 12000, bindings: { blueprint_hash: blueprint.blueprint_hash },
    capability: { durations_ms: [5000, 10000], max_references: { image: 0, audio: 0, video: 0 } },
    parent_shots: blueprint.shots.map((shot) => ({ id: shot.id, start_ms: shot.start_ms, end_ms: shot.end_ms,
      contract_hash: hash(JSON.stringify(shot)), required_references: [] })),
    dialogues: sourceDialogue.map((item, i) => ({ id: item.dialogue_id, source_text: item.source_text,
      start_ms: item.source_start_ms, end_ms: item.source_end_ms, evidence_ref: item.evidence_ref, evidence_sha256: item.evidence_sha256,
      target_text: localized.dialogue_map[i].target_text, estimated_duration_ms: localized.dialogue_map[i].estimated_duration_ms })) });
  assert.equal(plan.status, 'ready'); const planned = plan.units.flatMap((unit) => unit.dialogues).find((item) => item.id === 'dialogue-2');
  assert.equal(planned.source_text, turn.source_text); assert.equal(planned.start_ms, 2200); assert.equal(planned.end_ms, 6500);
  const tooLong = structuredClone(raw); tooLong.dialogue[1].turns[0].target_text = 'word '.repeat(15).trim();
  assert.throws(() => localization.normalizeLocalizationResultV2(tooLong, blueprint, options), { code: 'LOCALIZATION_DIALOGUE_DURATION_EXCEEDED' });
  fs.appendFileSync(h.evidencePath, ' ');
  assert.throws(() => localization.resolveLocalizationSourceDialogue(h.db, h.ctx, 1, blueprint, h.ctx.storageRoot),
    { code: 'LOCALIZATION_SOURCE_DIALOGUE_UNRESOLVED' });
  assert.deepEqual(h.db.serialize(), before);
});

function planCapabilities(h) {
  const model = 'fumin-seedance-2.0-mini';
  const evidence = (id, provider, name) => ({ config_id: id, config_updated_at: now, provider, model: name,
    task_id: `local-task-${id}`, terminal_status: 'completed', artifact_id: 700 + id });
  const capabilities = { [model]: { durations: [5, 15], resolutions: ['480p'], aspectRatios: ['9:16'], supportsAudio: true,
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
}

function responseFixture() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function handlers(h) {
  return routes(h.db, log, { cfg: { storage: { local_path: h.ctx.storageRoot } },
    uploadLimits: { storageRoot: h.ctx.storageRoot }, canReadArtifact: (id) => [741, 742].includes(Number(id)) });
}
function requestFixture(body, id = 1) {
  return { params: { id: String(id) }, tenant: { id: 'tenant-a' }, user: { id: 'user-a' }, query: {}, body };
}

test('real product save/lock handlers use server storageRoot and return safe correction errors', (t) => {
  const h = harness(t); const handler = handlers(h); const res = responseFixture();
  handler.saveBlueprint(requestFixture({ blueprint: corrected(h), expected_updated_at: h.record.updated_at }), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.data.source_dialogue[1].source_origin, 'manual_correction');
  let saved = workflow.getCurrentBlueprint(h.ctx, { workId: 1 });
  const denied = responseFixture(); const before = h.db.serialize();
  handler.saveBlueprint(requestFixture({ blueprint: saved.blueprint, expected_updated_at: saved.updated_at, storageRoot: h.ctx.storageRoot }), denied);
  assert.equal(denied.statusCode, 400); assert.deepEqual(h.db.serialize(), before);
  saved = save(h, approve(saved.blueprint), saved); const locked = responseFixture();
  handler.lockBlueprint(requestFixture({ expected_updated_at: saved.updated_at, expected_blueprint_hash: saved.blueprint_hash }), locked);
  assert.equal(locked.statusCode, 200); assert.equal(locked.body.data.status, 'locked');
});

test('real product handlers reject stale source bytes with safe 400 and zero writes', (t) => {
  const h = harness(t); const saved = save(h, approve(corrected(h))); const handler = handlers(h);
  fs.appendFileSync(h.evidencePath, ' '); const before = h.db.serialize();
  for (const [method, body] of [['saveBlueprint', { blueprint: saved.blueprint, expected_updated_at: saved.updated_at }],
    ['lockBlueprint', { expected_updated_at: saved.updated_at, expected_blueprint_hash: saved.blueprint_hash }]]) {
    const res = responseFixture(); handler[method](requestFixture(body), res);
    assert.equal(res.statusCode, 400); assert.equal(res.body.error.code, 'REDRAW_BLUEPRINT_CORRECTION_INVALID');
    assert.ok(!JSON.stringify(res.body).includes(h.ctx.storageRoot)); assert.deepEqual(h.db.serialize(), before);
  }
});

for (const hasCorrection of [true, false]) {
test(`normal workflow lock feeds real execution preview and handler (correction=${hasCorrection})`, (t) => {
  const h = harness(t); const saved = save(h, hasCorrection ? approve(corrected(h)) : h.record.blueprint); const locked = lock(h, saved);
  const { localized } = localizedFixture(h, locked.blueprint);
  const version = h.db.prepare('SELECT id FROM redraw_versions WHERE work_id=1 AND version=?').get(locked.revision);
  h.db.prepare('UPDATE redraw_versions SET localization_hash=?,localization_review_json=? WHERE id=?')
    .run(localized.localization_hash, JSON.stringify(localized), version.id);
  planCapabilities(h); const before = h.db.serialize();
  const ctx = { ...h.ctx, canReadArtifact: (id) => [741, 742].includes(Number(id)) };
  const plan = previewVersionExecutionPlan(ctx, version.id);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.blocking_reasons));
  const turn = plan.units.flatMap((unit) => unit.dialogues).find((item) => item.id === 'dialogue-2');
  assert.equal(turn.source_text, hasCorrection ? '请不要打开这封信。' : '不要打开那封信。');
  assert.equal(turn.start_ms, hasCorrection ? 2200 : 2500); assert.equal(turn.end_ms, hasCorrection ? 6500 : 4700);
  const res = responseFixture(); handlers(h).getExecutionPlan(requestFixture(undefined, version.id), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.data.status, 'ready'); assert.deepEqual(h.db.serialize(), before);
  assert.throws(() => h.db.prepare("UPDATE redraw_episode_blueprints SET status='draft' WHERE id=?").run(locked.id),
    { code: 'SQLITE_CONSTRAINT_TRIGGER' });
});
}

for (const state of ['draft', 'needs_review']) {
  test(`execution preview refuses ${state} even with complete matching persisted hashes`, (t) => {
    const h = harness(t); const draft = corrected(h); const record = save(h, state === 'draft' ? approve(draft) : draft);
    const { localized } = localizedFixture(h, record.blueprint);
    const version = h.db.prepare('SELECT id FROM redraw_versions WHERE work_id=1 AND version=?').get(record.revision);
    h.db.prepare('UPDATE redraw_versions SET blueprint_hash=?,localization_hash=?,localization_review_json=? WHERE id=?')
      .run(record.blueprint_hash, localized.localization_hash, JSON.stringify(localized), version.id);
    // Invalid persisted-row fixture, never a fabricated successful lock or altered immutable row.
    if (state === 'needs_review') h.db.prepare("UPDATE redraw_episode_blueprints SET status='locked' WHERE id=?").run(record.id);
    const before = h.db.serialize(); const result = previewVersionExecutionPlan(h.ctx, version.id);
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.units, []);
    assert.deepEqual(result.blocking_reasons, [{ code: state === 'draft' ? 'BLUEPRINT_NOT_LOCKED' : 'BLUEPRINT_HASH_MISMATCH' }]);
    assert.deepEqual(h.db.serialize(), before);
  });
}

async function dialogueUiHelpers() {
  const review = await import(pathToFileURL(path.join(__dirname,
    '../../frontweb/src/utils/redrawBlueprintReviewState.js')).href);
  assert.equal(typeof review.applyDialogueSourceCorrection, 'function', 'UI source correction helper must exist');
  assert.equal(typeof review.restoreDialogueSourceCorrection, 'function', 'UI source restoration helper must exist');
  return review;
}

function readUiBlueprint(h) {
  const res = responseFixture();
  handlers(h).getBlueprint(requestFixture(undefined), res);
  assert.equal(res.statusCode, 200);
  return res.body.data;
}

function saveUiBlueprint(h, record, blueprint) {
  const res = responseFixture();
  handlers(h).saveBlueprint(requestFixture({ blueprint, expected_updated_at: record.updated_at }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.data;
}

test('UI correction payload round-trips real product handlers with original anchor and renewed review', async (t) => {
  const review = await dialogueUiHelpers();
  const h = harness(t); const before = unrelatedSnapshot(h); const record = readUiBlueprint(h);
  const originalRecord = JSON.stringify(record); const original = record.source_dialogue[1];
  let draft = review.applyDialogueSourceCorrection(record, record.blueprint, 'shot-2', 'dialogue-2', {
    source_text: '请不要打开这封信。', source_start_ms: 2200, source_end_ms: 6500,
  });
  assert.equal(JSON.stringify(record), originalRecord);
  assert.equal(review.dialogueSourceForReview(record, draft, 'shot-2', 'dialogue-2').status, 'unresolved');
  draft = review.applyDialogueSourceCorrection(record, draft, 'shot-2', 'dialogue-2', {
    source_text: '等我回来再打开这封信。', source_start_ms: 2300, source_end_ms: 6400,
  });
  const saved = saveUiBlueprint(h, record, draft);
  assert.deepEqual(readUiBlueprint(h), saved);
  assert.equal(saved.source_dialogue[1].source_origin, 'manual_correction');
  assert.equal(saved.source_dialogue[1].original_source_text, original.source_text);
  assert.equal(saved.source_dialogue[1].original_start_ms, original.source_start_ms);
  assert.equal(saved.source_dialogue[1].source_start_ms, 2300);
  assert.equal(review.dialogueSourceForReview(saved, saved.blueprint, 'shot-2', 'dialogue-2').status, 'resolved');
  assertZeroWrite(h, () => lock(h, saved), 'BLUEPRINT_SPEAKER_REVIEW_REQUIRED');
  const revised = review.applyDialogueSourceCorrection(saved, saved.blueprint, 'shot-2', 'dialogue-2', {
    source_text: '等我回来，我们一起打开信。', source_start_ms: 2400, source_end_ms: 6600,
  });
  assert.equal(revised.shots[1].dialogue[0].source_correction.original_source_text, original.source_text);
  let approved = review.approveDialogueReview(revised, 'dialogue-2');
  approved = review.approveBlueprintReview(approved, 'local-reviewer');
  const ready = saveUiBlueprint(h, saved, approved); const res = responseFixture();
  handlers(h).lockBlueprint(requestFixture({ expected_updated_at: ready.updated_at,
    expected_blueprint_hash: ready.blueprint_hash }), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.data.status, 'locked');
  assert.equal(res.body.data.source_dialogue[1].source_end_ms, 6600);
  assert.deepEqual(res.body.data.blueprint.shots[0], record.blueprint.shots[0]);
  assert.deepEqual(unrelatedSnapshot(h), before);
  assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
});

test('UI correction full-time-only edit invalidates old DTO despite identical projection and changes saved hash', async (t) => {
  const review = await dialogueUiHelpers(); const h = harness(t); const record = readUiBlueprint(h);
  const first = review.applyDialogueSourceCorrection(record, record.blueprint, 'shot-1', 'dialogue-1', {
    source_text: record.blueprint.shots[0].dialogue[0].source_text, source_start_ms: 0, source_end_ms: 3500,
  });
  const saved = saveUiBlueprint(h, record, first);
  const revised = review.applyDialogueSourceCorrection(saved, saved.blueprint, 'shot-1', 'dialogue-1', {
    source_text: first.shots[0].dialogue[0].source_text, source_start_ms: 0, source_end_ms: 4000,
  });
  assert.equal(revised.shots[0].dialogue[0].start_ms, saved.blueprint.shots[0].dialogue[0].start_ms);
  assert.equal(revised.shots[0].dialogue[0].end_ms, saved.blueprint.shots[0].dialogue[0].end_ms);
  assert.equal(review.dialogueSourceForReview(saved, revised, 'shot-1', 'dialogue-1').status, 'unresolved');
  const next = saveUiBlueprint(h, saved, revised);
  assert.notEqual(next.blueprint_hash, saved.blueprint_hash);
  assert.equal(next.source_dialogue[0].source_end_ms, 4000);
  assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
});

test('UI restoration after saved correction returns original whole ASR range without editing evidence', async (t) => {
  const review = await dialogueUiHelpers(); const h = harness(t); const before = unrelatedSnapshot(h);
  const record = readUiBlueprint(h); const original = record.source_dialogue[1];
  const draft = review.applyDialogueSourceCorrection(record, record.blueprint, 'shot-2', 'dialogue-2', {
    source_text: '请先等一下。', source_start_ms: 2300, source_end_ms: 7000,
  });
  const saved = saveUiBlueprint(h, record, draft);
  const restored = review.restoreDialogueSourceCorrection(saved, saved.blueprint, 'shot-2', 'dialogue-2');
  assert.equal(Object.hasOwn(restored.shots[1].dialogue[0], 'source_correction'), false);
  assert.equal(restored.shots[1].dialogue[0].source_text, original.source_text);
  assert.equal(restored.shots[1].dialogue[0].review_status, 'needs_review');
  const reloaded = saveUiBlueprint(h, saved, restored);
  assert.equal(reloaded.source_dialogue[1].source_start_ms, 2500);
  assert.equal(reloaded.source_dialogue[1].projection_start_ms, 3000);
  assert.equal(Object.hasOwn(reloaded.source_dialogue[1], 'source_origin'), false);
  assertZeroWrite(h, () => lock(h, reloaded), 'BLUEPRINT_SPEAKER_REVIEW_REQUIRED');
  assert.deepEqual(unrelatedSnapshot(h), before);
  assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
});

test('UI correction made before evidence drift is rejected by real save handler with zero database writes', async (t) => {
  const review = await dialogueUiHelpers(); const h = harness(t); const record = readUiBlueprint(h);
  const draft = review.applyDialogueSourceCorrection(record, record.blueprint, 'shot-2', 'dialogue-2', {
    source_text: '请先等一下。', source_start_ms: 2300, source_end_ms: 7000,
  });
  fs.appendFileSync(h.evidencePath, ' '); const before = hash(h.db.serialize()); const res = responseFixture();
  handlers(h).saveBlueprint(requestFixture({ blueprint: draft, expected_updated_at: record.updated_at }), res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.error.code, 'REDRAW_BLUEPRINT_CORRECTION_INVALID');
  assert.equal(hash(h.db.serialize()), before);
});
