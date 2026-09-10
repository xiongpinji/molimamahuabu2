const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const assetService = require('../src/services/assetService');
const credits = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const packs = require('../src/services/redrawShotProductionPackService');
const dialogue = require('../src/services/redrawDialogueService');
const orchestration = require('../src/services/redrawDialogueOrchestrator');
const { generateShot } = require('../src/services/redrawGenerationService');

const owner = { tenantId: 'tenant-a', userId: 'user-a' };
const now = '2026-09-05T12:00:00.000Z';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const log = { info() {}, warn() {}, error() {} };
const CROSS_SHOT = 'REDRAW_CROSS_SHOT_DIALOGUE_PLAN_REQUIRED';
const INVALID_SOURCE = 'SOURCE_DIALOGUE_EVIDENCE_INVALID';
let schema;

function fixture(t, { crossShot = false, legacy = false } = {}) {
  if (!schema) {
    const seed = new Database(':memory:');
    runMigrationsAndEnsure(seed);
    schema = seed.serialize();
    seed.close();
  }
  const db = new Database(schema);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-dialogue-guards-'));
  t.after(() => { db.close(); fs.rmSync(storageRoot, { recursive: true, force: true }); });
  const sourceSha = hash('original-video');
  const evidence = {
    schema_version: 'redraw-source-audio-evidence-v1', task_id: 'task-source-1',
    tenant_id: owner.tenantId, user_id: owner.userId, work_id: 1, source_asset_id: 1,
    source_video_sha256: sourceSha, audio_sha256: hash('original-audio'), transcript_sha256: hash('transcript'),
    source_language: 'zh', language_probability: 0.99, dialogue_mode: 'spoken', created_at: now,
    segments: [{ id: 'line-1', start_ms: crossShot ? 2500 : 3200, end_ms: 4500,
      source_text: '不要打开那封信。', speaker_cluster_id: 'speaker-cluster-1' }],
  };
  const evidencePath = path.join(storageRoot, 'source-evidence.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  const evidenceSha = hash(fs.readFileSync(evidencePath));
  db.prepare(`INSERT INTO redraw_projects (id, tenant_id, user_id, title, created_at, updated_at)
    VALUES (1, ?, ?, 'dialogue guard', ?, ?)`).run(owner.tenantId, owner.userId, now, now);
  db.prepare(`INSERT INTO redraw_works (id, project_id, tenant_id, user_id, title, source_asset_id,
    source_fingerprint, duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (1, 1, ?, ?, 'dialogue guard', 1, ?, 12000, 1, 2, 'asset_review', ?, ?)`)
    .run(owner.tenantId, owner.userId, sourceSha, now, now);
  if (!legacy) assetService.create(db, log, {
    name: 'source evidence', type: 'json', category: 'redraw_source_audio_evidence',
    local_path: 'source-evidence.json', file_size: fs.statSync(evidencePath).size,
    metadata: { schema_version: evidence.schema_version, tenant_id: owner.tenantId, user_id: owner.userId,
      work_id: 1, source_asset_id: 1, source_video_sha256: sourceSha, audio_sha256: evidence.audio_sha256,
      transcript_sha256: evidence.transcript_sha256, evidence_sha256: evidenceSha },
  });
  const turn = { id: 'line-1', speaker_id: 'speaker-cluster-1', speaker_kind: 'off_screen',
    source_text: evidence.segments[0].source_text, source_language: 'zh',
    start_ms: Math.max(3000, evidence.segments[0].start_ms), end_ms: 4500,
    emotion: '', evidence_refs: legacy ? [] : ['audio-1'] };
  const blueprint = {
    schema_version: 'episode-blueprint-v1', blueprint_hash: 'b'.repeat(64), review: { status: 'locked' },
    source: { asset_id: 1, sha256: sourceSha, duration_ms: 12000 },
    evidence_manifest: { items: legacy ? [] : [{ id: 'audio-1', kind: 'audio_transcript',
      asset_id: 1, sha256: evidenceSha, tool: 'source-audio-evidence', tool_version: '1' }] },
    characters: [{ id: 'speaker-cluster-1', source_name: '旁白' }],
    shots: [
      { id: 'shot-1', index: 1, start_ms: 0, end_ms: 3000, dialogue: [], text_regions: [], audio_contract: {} },
      { id: 'shot-2', index: 2, start_ms: 3000, end_ms: 12000, dialogue: [turn], text_regions: [], audio_contract: {} },
    ],
  };
  const localized = { schema_version: 'episode-localization-v1', blueprint_hash: blueprint.blueprint_hash,
    localization_hash: 'c'.repeat(64), locale: 'en-US', market: 'US', review: { status: 'locked' },
    character_name_map: { 'speaker-cluster-1': 'Narrator' }, text_region_map: [],
    cultural_adaptations: [], glossary: [], locked_terms: [], dialogue_map: [{ ...turn,
      source_dialogue_id: turn.id, shot_id: 'shot-2', target_text: 'Wait.', estimated_duration_ms: 300 }] };
  db.prepare(`INSERT INTO redraw_versions (id, work_id, tenant_id, user_id, version, locale, market,
    status, blueprint_hash, localization_hash, localization_review_json, style_snapshot_json, created_at, updated_at)
    VALUES (10, 1, ?, ?, 1, 'en-US', 'US', 'asset_review', ?, ?, ?, '{}', ?, ?)`)
    .run(owner.tenantId, owner.userId, blueprint.blueprint_hash, localized.localization_hash, JSON.stringify(localized), now, now);
  db.prepare(`INSERT INTO redraw_episode_blueprints (work_id, tenant_id, user_id, revision, status,
    blueprint_json, blueprint_hash, created_at, updated_at) VALUES (1, ?, ?, 1, 'locked', ?, ?, ?, ?)`)
    .run(owner.tenantId, owner.userId, JSON.stringify(blueprint), blueprint.blueprint_hash, now, now);
  const oldPacks = packs.compileEpisodeProductionPacks({ blueprint, localization: localized });
  for (const [index, pack] of oldPacks.entries()) {
    db.prepare(`INSERT INTO redraw_shots (id, work_id, shot_id, version_id, tenant_id, user_id, batch_index,
      shot_index, start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json, compiled_prompt_json,
      preparation_snapshot_json, references_json, draft_json, created_at, updated_at)
      VALUES (?, 1, ?, 10, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '{}', ?, ?)`)
      .run(100 + index, pack.shot_id, owner.tenantId, owner.userId, index + 1, pack.start_ms, pack.end_ms,
        pack.duration_ms, JSON.stringify(blueprint.shots[index].dialogue),
        JSON.stringify(index ? [{ ...turn, target_text: 'Wait.', estimated_duration_ms: 300 }] : []),
        JSON.stringify(pack), JSON.stringify({ blueprint_hash: pack.blueprint_hash,
          localization_hash: pack.localization_hash, production_pack_hash: pack.production_pack_hash }), now, now);
  }
  credits.setTenantAccountBalance(db, owner.tenantId, 100);
  prices.set(db, 'speech-2.8-turbo', 4, { category: 'audio', billingUnit: 'request' });
  db.prepare(`INSERT INTO ai_service_configs (id, service_type, provider, name, model, default_model,
    is_active, created_at, updated_at) VALUES (41, 'tts', 'minimax', 'TTS fixture', ?, 'speech-2.8-turbo', 1, ?, ?)`)
    .run(JSON.stringify(['speech-2.8-turbo']), now, now);
  fs.writeFileSync(path.join(storageRoot, 'voice.mp3'), 'voice-fixture');
  db.prepare(`INSERT INTO assets (id, name, type, category, local_path, mime_type, duration, created_at, updated_at)
    VALUES (501, 'voice', 'audio', 'voice', 'voice.mp3', 'audio/mpeg', 1.2, ?, ?)`).run(now, now);
  const voice = { source: 'offline-worker', locale: 'en-US', market: 'US', locale_pack: 'en-US@fixture',
    audio_sha256: 'a'.repeat(64), transcript_sha256: 'b'.repeat(64), model_manifest_sha256: 'c'.repeat(64),
    calibration_manifest_sha256: 'd'.repeat(64), asr_model_revision: 'asr-fixture', accent_model_revision: 'accent-fixture',
    metrics: { word_error_rate: 0, accent_confidence: 0.99 }, completed_at: now, provider: 'minimax',
    model: 'speech-2.8-turbo', ai_service_config_id: 41, config_updated_at: now, voice_id: 'voice-one',
    task_id: 'verified-voice', terminal_status: 'completed', audio_asset_id: 501, duration_ms: 1200,
    real_generation_verified: true, language_verified: true, detected_locale: 'en-US', is_cloned: false, authorization_asset_id: null };
  db.prepare(`INSERT INTO redraw_assets (version_id, tenant_id, user_id, kind, source_ref_json,
    localized_name, asset_id, approval_status, status, created_at, updated_at)
    VALUES (10, ?, ?, 'character', ?, 'Narrator', 501, 'approved', 'generated', ?, ?)`)
    .run(owner.tenantId, owner.userId, JSON.stringify({ source_ref: { character_id: 'speaker-cluster-1' },
      snapshot: { voice_snapshot: voice } }), now, now);
  const ctx = { db, ...owner, storageRoot, versionId: 10,
    canReadAudioAsset: (asset) => fs.existsSync(path.join(storageRoot, asset.local_path)),
    localeRegistry: { assertEvidenceTrusted: (value) => value },
    localeVerifier: { assertReady: () => ({ id: 'en-US@fixture', model_manifest_sha256: voice.model_manifest_sha256,
      calibration_manifest_sha256: voice.calibration_manifest_sha256 }) } };
  const shot = () => ({ ...db.prepare('SELECT * FROM redraw_shots WHERE id = 101').get(),
    version_blueprint_hash: blueprint.blueprint_hash, version_localization_hash: localized.localization_hash });
  return { ctx, db, storageRoot, evidencePath, blueprint, shot };
}

function noPaidWork(h) {
  for (const table of ['async_tasks', 'tenant_usage_reservations', 'video_generations']) {
    assert.equal(h.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
  }
  assert.deepEqual(h.db.prepare('SELECT available, held, spent FROM tenant_credit_accounts WHERE tenant_id = ?')
    .get(owner.tenantId), { available: 100, held: 0, spent: 0 });
}

for (const [label, options, mutate, code] of [
  ['cross-shot sentence', { crossShot: true }, () => {}, CROSS_SHOT],
  ['changed evidence bytes', {}, (h) => fs.appendFileSync(h.evidencePath, ' '), INVALID_SOURCE],
  ['missing evidence bytes', {}, (h) => fs.unlinkSync(h.evidencePath), INVALID_SOURCE],
]) {
  test(`production pack compile and old pack generation reject ${label}`, async (t) => {
    const h = fixture(t, options); mutate(h);
    const before = h.db.prepare('SELECT compiled_prompt_json FROM redraw_shots ORDER BY id').all();
    assert.throws(() => packs.compileVersionProductionPacks(h.db, owner, 10, h.ctx), { code });
    assert.throws(() => packs.writeVersionProductionPacks(h.db, owner, 10, h.ctx), { code });
    assert.deepEqual(h.db.prepare('SELECT compiled_prompt_json FROM redraw_shots ORDER BY id').all(), before);
    assert.throws(() => packs.assertShotProductionPackCurrent(h.db, owner, h.shot(), h.ctx), { code });
    await assert.rejects(generateShot(h.ctx, { shotId: 101 }), { code });
    noPaidWork(h);
  });

  test(`dialogue quote and start reject ${label} without tasks, fees or provider work`, async (t) => {
    const h = fixture(t, options); mutate(h);
    let providers = 0;
    const deps = { ...h.ctx, synthesizeSegment: async () => { providers += 1; throw new Error('unexpected provider'); } };
    const plan = dialogue.buildDialoguePlan(h.db, h.ctx);
    assert.equal(plan.status, 'needs_rewrite');
    assert.equal(plan.issues[0].reason, code);
    assert.deepEqual(plan.segments, []);
    const quote = orchestration.quoteDialogue(h.db, h.ctx);
    assert.equal(quote.priced, false);
    assert.equal(quote.total_credits, 0);
    assert.equal(quote.issues[0].reason, code);
    assert.throws(() => orchestration.startDialogue(h.db, log, h.ctx,
      { quoteHash: quote.quote_hash, idempotencyKey: 'guard-tts' }, deps), (error) => (
      error.code === 'REDRAW_DIALOGUE_PLAN_NOT_READY' && error.message === plan.issues[0].message
    ));
    await assert.rejects(dialogue.synthesizeDialogueForVersion({ ...h.ctx, ...deps },
      { quoteHash: quote.quote_hash, idempotencyKey: 'guard-tts-direct' }), { code: 'REDRAW_DIALOGUE_PLAN_NOT_READY' });
    assert.equal(providers, 0);
    noPaidWork(h);
  });
}

test('verified same-shot evidence and actual manual legacy remain usable without a new schema', (t) => {
  for (const legacy of [false, true]) {
    const h = fixture(t, { legacy });
    assert.equal(packs.compileVersionProductionPacks(h.db, owner, 10, h.ctx).length, 2);
    assert.equal(packs.writeVersionProductionPacks(h.db, owner, 10, h.ctx).length, 2);
    assert.equal(packs.assertShotProductionPackCurrent(h.db, owner, h.shot(), h.ctx).shot_id, 'shot-2');
    assert.equal(dialogue.buildDialoguePlan(h.db, h.ctx).status, 'ready');
    assert.equal(orchestration.quoteDialogue(h.db, h.ctx).priced, true);
    noPaidWork(h);
  }
});

test('evidence drift after a successful dialogue quote blocks start before any work', (t) => {
  const h = fixture(t);
  const quote = orchestration.quoteDialogue(h.db, h.ctx);
  assert.equal(quote.priced, true);
  fs.appendFileSync(h.evidencePath, ' ');
  let providers = 0;
  assert.throws(() => orchestration.startDialogue(h.db, log, h.ctx,
    { quoteHash: quote.quote_hash, idempotencyKey: 'drift-tts' }, { ...h.ctx,
      synthesizeSegment: async () => { providers += 1; } }), { code: 'REDRAW_DIALOGUE_PLAN_NOT_READY' });
  assert.equal(providers, 0);
  noPaidWork(h);
});

test('scheduled dialogue rechecks changed source evidence before reserving or invoking provider', async (t) => {
  const h = fixture(t);
  const quote = orchestration.quoteDialogue(h.db, h.ctx);
  let runJob;
  let providers = 0;
  let completeJob;
  const completion = new Promise((resolve, reject) => { completeJob = { resolve, reject }; });
  const start = orchestration.startDialogue(h.db, log, h.ctx,
    { quoteHash: quote.quote_hash, idempotencyKey: 'queued-drift' }, {
      ...h.ctx,
      schedule(job) { runJob = job; return completion; },
      synthesizeSegment: async () => { providers += 1; throw new Error('unexpected provider'); },
    });
  fs.appendFileSync(h.evidencePath, ' ');
  runJob().then(completeJob.resolve, completeJob.reject);
  await assert.rejects(start.completion, (error) => error.code === 'REDRAW_DIALOGUE_PLAN_NOT_READY'
    && error.issues[0].reason === INVALID_SOURCE);
  assert.equal(providers, 0);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
  assert.equal(h.db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(start.task_id).status, 'failed');
});

test('scheduled same-shot dialogue retains storage root through provider dispatch', async (t) => {
  const h = fixture(t);
  const quote = orchestration.quoteDialogue(h.db, h.ctx);
  let providers = 0;
  const start = orchestration.startDialogue(h.db, log, h.ctx,
    { quoteHash: quote.quote_hash, idempotencyKey: 'queued-verified' }, {
      ...h.ctx,
      schedule: (job) => Promise.resolve().then(job),
      synthesizeSegment: async () => { providers += 1; throw new Error('fixture provider refused before external work'); },
    });
  await assert.rejects(start.completion, /fixture provider refused/);
  assert.equal(providers, 1);
  assert.deepEqual(h.db.prepare('SELECT available, held, spent FROM tenant_credit_accounts WHERE tenant_id = ?')
    .get(owner.tenantId), { available: 100, held: 0, spent: 0 });
});
