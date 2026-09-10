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
const { resolveBlueprintDialogueSources } = require('../src/services/redrawSourceDialogueService');
const { fixtureBlueprint } = require('./redrawEpisodeBlueprint.test');

const reviewPromise = import(pathToFileURL(path.join(__dirname,
  '../../frontweb/src/utils/redrawBlueprintReviewState.js')).href);
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const now = '2026-09-05T10:00:00.000Z';
const log = { info() {}, warn() {}, error() {} };
let schema;

function harness(t) {
  if (!schema) {
    const seed = new Database(':memory:');
    runMigrationsAndEnsure(seed);
    schema = seed.serialize();
    seed.close();
  }
  const db = new Database(schema);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-speaker-correction-'));
  t.after(() => { db.close(); fs.rmSync(storageRoot, { recursive: true, force: true }); });
  const ctx = { db, storageRoot, tenantId: 'tenant-a', userId: 'user-a' };
  const raw = fixtureBlueprint();
  raw.source.duration_ms = 12000;
  raw.shots[1].end_ms = 12000;
  raw.scenes[0].source_ranges[0].end_ms = 12000;
  fs.writeFileSync(path.join(storageRoot, 'source.mp4'), 'local-source-fixture');
  const source = assets.create(db, log, {
    name: 'source', type: 'video', category: 'redraw_source', local_path: 'source.mp4',
    metadata: { tenant_id: ctx.tenantId, user_id: ctx.userId },
  });
  raw.source.asset_id = source.id;
  raw.source.sha256 = hash('local-source-fixture');
  // Keep a cross-cut original sentence; the blueprint holds its shot-local projection.
  raw.shots[1].dialogue[0].start_ms = 3000;
  const evidence = {
    schema_version: 'redraw-source-audio-evidence-v1', task_id: 'local-evidence-1',
    work_id: 1, tenant_id: ctx.tenantId, user_id: ctx.userId,
    source_asset_id: source.id, source_video_sha256: raw.source.sha256,
    audio_sha256: hash('original-audio'), transcript_sha256: hash('original-transcript'),
    source_language: 'zh-CN', language_probability: 0.99, dialogue_mode: 'spoken', created_at: now,
    segments: raw.shots.flatMap((shot) => shot.dialogue).map((turn, index) => ({
      id: turn.id, start_ms: index === 1 ? 2500 : turn.start_ms, end_ms: turn.end_ms,
      source_text: turn.source_text, speaker_cluster_id: 'speaker-cluster-1',
    })),
  };
  const evidencePath = path.join(storageRoot, 'evidence.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  const evidenceSha = hash(fs.readFileSync(evidencePath));
  const audioAsset = assets.create(db, log, {
    name: 'original ASR', type: 'json', category: 'redraw_source_audio_evidence', local_path: 'evidence.json',
    file_size: fs.statSync(evidencePath).size,
    metadata: { ...evidence, segments: undefined, evidence_sha256: evidenceSha },
  });
  Object.assign(raw.evidence_manifest.items[0], { asset_id: audioAsset.id, sha256: evidenceSha });
  db.prepare(`INSERT INTO redraw_projects (id,tenant_id,user_id,title,status,created_at,updated_at)
    VALUES (1,'tenant-a','user-a','new upload','draft',?,?)`).run(now, now);
  db.prepare(`INSERT INTO redraw_works
    (id,project_id,tenant_id,user_id,title,source_asset_id,source_fingerprint,duration_ms,
     current_version,current_step,status,created_at,updated_at)
    VALUES (1,1,'tenant-a','user-a','new upload',?,?,12000,1,1,'needs_attention',?,?)`)
    .run(source.id, raw.source.sha256, now, now);
  const record = workflow.createOrSaveDraft(ctx, { workId: 1, blueprint: raw });
  return { ctx, db, record, evidencePath, evidenceSha };
}

function resolve(h, blueprint) {
  return resolveBlueprintDialogueSources(h.ctx, { workId: 1, blueprint });
}
function lock(h, record) {
  return workflow.lockBlueprint(h.ctx, { workId: 1, expected_updated_at: record.updated_at,
    expected_blueprint_hash: record.blueprint_hash });
}
function unrelatedSnapshot(h) {
  // All other tables include original assets, queues, provider tasks and credit ledgers.
  const allowed = ['redraw_episode_blueprints', 'redraw_versions', 'redraw_works', 'redraw_shots'];
  return h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().filter(({ name }) => !allowed.includes(name))
    .map(({ name }) => [name, h.db.prepare(`SELECT * FROM "${name}"`).all()]);
}
async function reviewer() {
  const review = await reviewPromise;
  assert.equal(typeof review.assignDialogueSpeakers, 'function', 'selected speaker correction must exist');
  assert.equal(typeof review.createOffScreenCharacterForDialogues, 'function', 'name-only off-screen correction must exist');
  return review;
}
function approveAll(review, blueprint) {
  let next = blueprint;
  for (const character of next.characters) next = review.approveCharacterReview(next, character.id);
  for (const shot of next.shots) for (const turn of shot.dialogue) next = review.approveDialogueReview(next, turn.id);
  return review.approveBlueprintReview(next, 'local-reviewer');
}

test('speaker correction fixture uses owned immutable ASR including a complete cross-shot interval', (t) => {
  const h = harness(t);
  const sources = resolve(h, h.record.blueprint);
  assert.ok(sources.every((turn) => turn.status === 'resolved'), JSON.stringify(sources));
  assert.equal(sources[1].source_start_ms, 2500);
  assert.equal(sources[1].projection_start_ms, 3000);
  assert.equal(sources[1].cross_shot, true);
  assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
});

test('selected speaker edits save/reload/review/lock with original cross-shot ASR and zero business side effects', async (t) => {
  const review = await reviewer();
  const h = harness(t);
  const before = unrelatedSnapshot(h);
  const original = JSON.stringify(h.record.blueprint);
  const sourceBefore = resolve(h, h.record.blueprint);
  assert.ok(sourceBefore.every((turn) => turn.status === 'resolved'), JSON.stringify(sourceBefore));
  assert.equal(sourceBefore[1].source_start_ms, 2500);
  let draft = review.assignDialogueSpeakers(h.record.blueprint, ['dialogue-1'], {
    character_id: 'character-qiao-an', off_screen: false,
  });
  assert.equal(JSON.stringify(h.record.blueprint), original);
  assert.deepEqual(draft.shots[1], h.record.blueprint.shots[1]);
  assert.deepEqual(resolve(h, draft), sourceBefore);
  const saved = workflow.saveDraft(h.ctx, { workId: 1,
    ...review.buildBlueprintSavePayload({ ...h.record, blueprint: draft }) });
  assert.notEqual(saved.blueprint_hash, h.record.blueprint_hash);
  assert.equal(saved.blueprint.shots[0].dialogue[0].review_status, 'needs_review');
  assert.equal(saved.blueprint.review.status, 'needs_review');
  assert.throws(() => lock(h, saved), /REVIEW|审核/);
  const loaded = workflow.getCurrentBlueprint(h.ctx, { workId: 1 });
  assert.deepEqual(loaded, saved);
  draft = approveAll(review, loaded.blueprint);
  const approved = workflow.saveDraft(h.ctx, { workId: 1,
    ...review.buildBlueprintSavePayload({ ...loaded, blueprint: draft }) });
  const locked = lock(h, approved);
  assert.equal(locked.status, 'locked');
  assert.deepEqual(resolve(h, locked.blueprint), sourceBefore);
  const persisted = h.db.prepare('SELECT source_dialogue_json FROM redraw_shots ORDER BY shot_index').all();
  assert.equal(JSON.parse(persisted[0].source_dialogue_json)[0].speaker_id, 'character-qiao-an');
  assert.equal(JSON.parse(persisted[1].source_dialogue_json)[0].speaker_id, 'narrator');
  assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
  assert.deepEqual(unrelatedSnapshot(h), before);
  assert.throws(() => workflow.saveDraft(h.ctx, { workId: 1,
    ...review.buildBlueprintSavePayload(locked) }), { code: 'REDRAW_BLUEPRINT_LOCKED' });
});

test('name-only off-screen creation remaps an already mapped line and persists only after renewed review', async (t) => {
  const review = await reviewer(); const h = harness(t);
  const before = unrelatedSnapshot(h);
  let draft = review.createOffScreenCharacterForDialogues(h.record.blueprint, ['dialogue-2'], { name: '来电者' });
  const role = draft.characters.find((item) => item.display_name === '来电者');
  assert.ok(role); assert.equal(role.review_status, 'needs_review');
  assert.deepEqual(role.face_track_ids, []);
  assert.deepEqual(draft.shots[0], h.record.blueprint.shots[0]);
  draft = review.assignDialogueSpeakers(draft, ['dialogue-1'], { character_id: 'character-qiao-an', off_screen: false });
  const saved = workflow.saveDraft(h.ctx, { workId: 1,
    ...review.buildBlueprintSavePayload({ ...h.record, blueprint: draft }) });
  assert.throws(() => lock(h, saved), /REVIEW|审核/);
  const reviewed = workflow.saveDraft(h.ctx, { workId: 1,
    ...review.buildBlueprintSavePayload({ ...saved, blueprint: approveAll(review, saved.blueprint) }) });
  const locked = lock(h, reviewed);
  assert.equal(locked.blueprint.shots[1].dialogue[0].speaker_id, role.id);
  assert.equal(locked.blueprint.shots[1].dialogue[0].speaker_kind, 'off_screen');
  assert.ok(resolve(h, locked.blueprint).every((turn) => turn.status === 'resolved'));
  assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
  assert.deepEqual(unrelatedSnapshot(h), before);
});

test('speaker corrections retain owner scope and stale CAS rejection without modifying original evidence', async (t) => {
  const review = await reviewer(); const h = harness(t);
  const draft = review.assignDialogueSpeakers(h.record.blueprint, ['dialogue-1'], {
    character_id: 'character-qiao-an', off_screen: false,
  });
  const input = { workId: 1, ...review.buildBlueprintSavePayload({ ...h.record, blueprint: draft }) };
  for (const foreign of [{ userId: 'foreign' }, { tenantId: 'foreign' }]) {
    const bytes = h.db.serialize();
    assert.throws(() => workflow.saveDraft({ ...h.ctx, ...foreign }, input), { code: 'REDRAW_BLUEPRINT_NOT_FOUND' });
    assert.deepEqual(h.db.serialize(), bytes);
  }
  workflow.saveDraft(h.ctx, input);
  const bytes = h.db.serialize();
  assert.throws(() => workflow.saveDraft(h.ctx, input), { code: 'REDRAW_BLUEPRINT_CAS_CONFLICT' });
  assert.deepEqual(h.db.serialize(), bytes);
  assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
});

for (const [label, mutate] of [
  ['source text', (turn) => { turn.source_text = '手工篡改的识别文本'; }],
  ['projection', (turn) => { turn.start_ms += 1; }],
]) {
  test(`speaker correction cannot bless changed ${label} as verified source evidence`, async (t) => {
    const review = await reviewer(); const h = harness(t);
    const draft = review.assignDialogueSpeakers(h.record.blueprint, ['dialogue-1'], {
      character_id: 'character-qiao-an', off_screen: false,
    });
    mutate(draft.shots[0].dialogue[0]);
    const saved = workflow.saveDraft(h.ctx, { workId: 1,
      ...review.buildBlueprintSavePayload({ ...h.record, blueprint: draft }) });
    const sources = resolve(h, saved.blueprint);
    assert.equal(sources[0].status, 'unresolved');
    assert.equal(sources[1].status, 'resolved');
    assert.equal(hash(fs.readFileSync(h.evidencePath)), h.evidenceSha);
  });
}
