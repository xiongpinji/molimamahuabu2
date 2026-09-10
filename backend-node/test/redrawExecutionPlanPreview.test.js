'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { fixtureBlueprint } = require('./redrawEpisodeBlueprint.test');
const { normalizeEpisodeBlueprint } = require('../src/services/redrawEpisodeBlueprintService');
const { episodeLocalizationHash } = require('../src/services/localizationService');
const { registerSourceDialogueEvidence } = require('./helpers/localizationSourceEvidence');
const routes = require('../src/routes/redraw');
const preview = require('../src/services/redrawExecutionPlanPreviewService');

const owner = { tenantId: 'tenant-a', userId: 'user-a' };
const now = '2026-09-05T12:00:00.000Z';
let schema;

function fixture(t, { corruptBlueprint = false } = {}) {
  if (!schema) {
    const seed = new Database(':memory:');
    runMigrationsAndEnsure(seed);
    schema = seed.serialize(); seed.close();
  }
  const queries = [];
  const db = new Database(schema, { verbose: (sql) => queries.push(sql) });
  t.after(() => db.close());
  db.prepare(`INSERT INTO redraw_projects (id, tenant_id, user_id, title, created_at, updated_at)
    VALUES (1, 'tenant-a', 'user-a', 'preview', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO redraw_works (id, project_id, tenant_id, user_id, title, current_version,
    source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (1, 1, 'tenant-a', 'user-a', 'preview', 1, 91, 'fixture', 12000, ?, ?)`).run(now, now);
  let blueprint = fixtureBlueprint();
  blueprint.review = { status: 'locked', reviewer: 'user-a' };
  blueprint.shots[0].dialogue = [];
  blueprint.shots[0].audio_contract.dialogue_mode = 'silent';
  blueprint.shots[1].end_ms = 12000;
  blueprint.shots[1].dialogue[0].start_ms = 2500;
  // Keep the complete sentence in evidence; only the blueprint projection begins at the cut.
  const media = blueprint.source;
  const visualEvidence = blueprint.evidence_manifest.items.filter((item) => item.kind === 'visual');
  const evidence = registerSourceDialogueEvidence(t, db, blueprint);
  blueprint.source = { ...media, ...blueprint.source };
  blueprint.evidence_manifest.items = [...visualEvidence, ...blueprint.evidence_manifest.items.map((item) => ({
    ...item, tool: 'source-audio-evidence', tool_version: '1',
  }))];
  blueprint.shots[1].dialogue[0].start_ms = 3000;
  blueprint = normalizeEpisodeBlueprint(blueprint);
  const storedBlueprint = structuredClone(blueprint);
  if (corruptBlueprint) storedBlueprint.story.summary = 'changed';
  db.prepare(`INSERT INTO redraw_episode_blueprints (work_id, tenant_id, user_id, revision, status,
    blueprint_json, blueprint_hash, created_at, updated_at)
    VALUES (1, 'tenant-a', 'user-a', 1, 'locked', ?, ?, ?, ?)`)
    .run(JSON.stringify(storedBlueprint), blueprint.blueprint_hash, now, now);
  const turn = blueprint.shots[1].dialogue[0];
  const localization = { schema_version: 'episode-localization-v1', blueprint_hash: blueprint.blueprint_hash,
    locale: 'en-US', market: 'US', character_name_map: { 'character-qiao-an': 'Joanna' },
    dialogue_map: [{ source_dialogue_id: turn.id, shot_id: 'shot-2', target_text: 'Wait for me.',
      estimated_duration_ms: 1000 }], text_region_map: [], cultural_adaptations: [], glossary: [],
    locked_terms: [], review: { status: 'review', updated_at: now } };
  localization.localization_hash = episodeLocalizationHash(localization);
  db.prepare(`INSERT INTO redraw_versions (id, work_id, tenant_id, user_id, version, locale, market,
    status, blueprint_hash, localization_hash, localization_review_json, created_at, updated_at)
    VALUES (10, 1, 'tenant-a', 'user-a', 1, 'source', '', 'needs_review', ?, ?, ?, ?, ?)`)
    .run(blueprint.blueprint_hash, localization.localization_hash, JSON.stringify(localization), now, now);
  const model = 'fumin-seedance-2.0-mini';
  const videoEvidence = { config_id: 41, config_updated_at: now, provider: 'fumin', model,
    task_id: 'local-video-fixture', terminal_status: 'completed', artifact_id: 700 };
  const settings = { unrelated_secret: 'MUST_NOT_READ', redraw_locale_capabilities: [{
    locale: 'en-US', market: 'US', status: 'verified', evidence: { video: videoEvidence } }] };
  const capabilities = { [model]: { durations: [5, 6, 15, 99], resolutions: ['480p', '720p'],
    aspectRatios: ['9:16'], supportsAudio: true, supportsImageReference: true,
    supportsVideoReference: true, supportsAudioReference: true,
    maxReferences: 9, maxVideoReferences: 3, maxAudioReferences: 3 } };
  db.prepare(`INSERT INTO ai_service_configs (id, service_type, provider, api_protocol, name, model,
    default_model, api_key, is_active, verification_status, settings, verified_capabilities, created_at, updated_at)
    VALUES (41, 'video', 'fumin', 'fumin_video', 'fixture', ?, ?, 'NEVER_READ_KEY', 1, 'verified', ?, ?, ?, ?)`)
    .run(JSON.stringify([model]), model, JSON.stringify(settings), JSON.stringify(capabilities), now, now);
  const tts = { config_id: 42, config_updated_at: now, provider: 'minimax', model: 'speech-fixture',
    task_id: 'local-audio-fixture', terminal_status: 'completed', artifact_id: 701 };
  db.prepare(`INSERT INTO ai_service_configs (id, service_type, provider, name, model, default_model,
    is_active, verification_status, settings, created_at, updated_at)
    VALUES (42, 'tts', 'minimax', 'fixture-tts', ?, 'speech-fixture', 1, 'verified', ?, ?, ?)`)
    .run(JSON.stringify(['speech-fixture']), JSON.stringify({ redraw_locale_capabilities: [{
      locale: 'en-US', market: 'US', status: 'verified', evidence: { tts } }] }), now, now);
  const ctx = { db, ...owner, storageRoot: evidence.storageRoot, canReadArtifact: (id) => [700, 701].includes(Number(id)) };
  const res = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } });
  const req = (who = owner) => ({ params: { id: '10' }, tenant: { id: who.tenantId }, user: { id: who.userId }, query: {} });
  const handler = routes(db, { warn() {}, error() {} }, { cfg: { storage: { local_path: evidence.storageRoot } },
    uploadLimits: { storageRoot: evidence.storageRoot }, canReadArtifact: ctx.canReadArtifact });
  queries.length = 0;
  return { db, ctx, blueprint, localization, evidence, capabilities, settings, queries, handler, req, res };
}

function snapshot(h) {
  return h.db.serialize();
}

module.exports = { fixture };

test('preview uses saved review, complete cross-shot sentence, pinned intersection and performs zero writes', async (t) => {
  const h = fixture(t); const before = snapshot(h); h.queries.length = 0;
  const result = preview.previewVersionExecutionPlan(h.ctx, 10);
  assert.equal(result.status, 'ready'); assert.equal(result.executable, false);
  assert.equal(result.bindings.localization_review_status, 'review');
  assert.equal(result.bindings.locale, 'en-US');
  assert.deepEqual(result.capability.durations_ms, [5000, 6000, 15000]);
  assert.deepEqual(result.capability.resolutions, ['480p']);
  assert.equal(result.capability.audio_mode, 'replace');
  assert.equal(result.reference_readiness, 'not_checked');
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0].parent_shots.length, 2);
  assert.equal(result.units[0].dialogues[0].start_ms, 2500);
  assert.equal(result.units[0].dialogues[0].end_ms, 4700);
  assert.equal(result.units[0].dialogues[0].target_text, 'Wait for me.');
  assert.deepEqual(preview.previewVersionExecutionPlan(h.ctx, 10), result);
  assert.deepEqual(snapshot(h), before);
  const configQueries = h.queries.filter((q) => /FROM ai_service_configs/i.test(q));
  assert.ok(configQueries.length > 0);
  assert.ok(configQueries.every((q) => !/SELECT\s+\*|api_key|base_url|endpoint|(?:SELECT|,)\s*settings\s*(?:,|FROM)/i.test(q)));
  assert.ok(!JSON.stringify(result).includes('MUST_NOT_READ'));
  assert.ok(!JSON.stringify(result).includes('NEVER_READ_KEY'));
  assert.ok(h.queries.every((q) => !/^\s*(INSERT|UPDATE|DELETE|REPLACE|BEGIN)/i.test(q)));
});

test('real product handler returns preview and denies foreign owner without config/evidence access', async (t) => {
  const h = fixture(t); const before = snapshot(h);
  const denied = h.res(); h.handler.getExecutionPlan(h.req({ ...owner, userId: 'other' }), denied);
  assert.equal(denied.statusCode, 404);
  assert.ok(!h.queries.some((q) => /FROM ai_service_configs/i.test(q)));
  const accepted = h.res(); h.handler.getExecutionPlan(h.req(), accepted);
  assert.equal(accepted.statusCode, 200); assert.equal(accepted.body.data.status, 'ready');
  assert.deepEqual(snapshot(h), before);
});

for (const [name, mutate, code] of [
  ['source evidence bytes drift', (h) => fs.appendFileSync(h.evidence.evidencePath, ' '), 'SOURCE_DIALOGUE_UNRESOLVED'],
  ['source binding drift', (h) => h.db.prepare("UPDATE redraw_works SET source_fingerprint = ?").run('f'.repeat(64)), 'SOURCE_BINDING_MISMATCH'],
  ['blueprint body drift', () => {}, 'BLUEPRINT_HASH_MISMATCH'],
  ['localization body drift', (h) => { h.localization.dialogue_map[0].target_text = 'changed'; h.db.prepare('UPDATE redraw_versions SET localization_review_json = ?').run(JSON.stringify(h.localization)); }, 'LOCALIZATION_HASH_MISMATCH'],
  ['deleted parent', (h) => h.db.prepare('UPDATE redraw_works SET deleted_at = ?').run(now), 'REDRAW_VERSION_NOT_FOUND'],
  ['missing durations', (h) => { delete h.capabilities['fumin-seedance-2.0-mini'].durations; h.db.prepare('UPDATE ai_service_configs SET verified_capabilities = ? WHERE id = 41').run(JSON.stringify(h.capabilities)); }, 'CAPABILITY_PARAMETERS_UNVERIFIED'],
  ['missing reference bound', (h) => { delete h.capabilities['fumin-seedance-2.0-mini'].maxVideoReferences; h.db.prepare('UPDATE ai_service_configs SET verified_capabilities = ? WHERE id = 41').run(JSON.stringify(h.capabilities)); }, 'CAPABILITY_PARAMETERS_UNVERIFIED'],
  ['missing ratio evidence', (h) => { delete h.capabilities['fumin-seedance-2.0-mini'].aspectRatios; h.db.prepare('UPDATE ai_service_configs SET verified_capabilities = ? WHERE id = 41').run(JSON.stringify(h.capabilities)); }, 'CAPABILITY_PARAMETERS_UNVERIFIED'],
  ['unknown adapter', (h) => h.db.prepare("UPDATE ai_service_configs SET api_protocol = 'unknown' WHERE id = 41").run(), 'ADAPTER_PLANNING_CAPABILITY_UNAVAILABLE'],
  ['WAN3 credential check not authorized', (h) => h.db.prepare("UPDATE ai_service_configs SET api_protocol = 'toapis_wan3_video' WHERE id = 41").run(), 'CREDENTIAL_BINDING_NOT_CHECKED'],
  ['locale mismatch', (h) => { h.settings.redraw_locale_capabilities[0].market = 'GB'; h.db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = 41').run(JSON.stringify(h.settings)); }, 'VIDEO_CAPABILITY_UNAVAILABLE'],
  ['config revision drift', (h) => h.db.prepare("UPDATE ai_service_configs SET updated_at = 'new' WHERE id = 41").run(), 'VIDEO_CAPABILITY_UNAVAILABLE'],
  ['paused carrier', (h) => h.db.prepare('UPDATE ai_service_configs SET canary_paused = 1 WHERE id = 41').run(), 'VIDEO_CAPABILITY_UNAVAILABLE'],
  ['no exact-region audio', (h) => h.db.prepare('UPDATE ai_service_configs SET is_active = 0 WHERE id = 42').run(), 'AUDIO_CAPABILITY_UNAVAILABLE'],
]) {
  test(`preview blocks ${name} with no partial execution or write`, (t) => {
    const h = fixture(t, { corruptBlueprint: name === 'blueprint body drift' }); mutate(h); const before = snapshot(h);
    const result = preview.previewVersionExecutionPlan(h.ctx, 10);
    assert.equal(result.status, 'blocked'); assert.equal(result.executable, false);
    assert.deepEqual(result.units, []);
    assert.ok(result.blocking_reasons.some((reason) => reason.code === code), JSON.stringify(result.blocking_reasons));
    assert.deepEqual(snapshot(h), before);
  });
}

test('review and localization edits invalidate preview hash; original source hashes remain unchanged', (t) => {
  const h = fixture(t);
  const first = preview.previewVersionExecutionPlan(h.ctx, 10);
  h.localization.review.updated_at = '2026-09-05T13:00:00.000Z';
  h.db.prepare('UPDATE redraw_versions SET localization_review_json = ?').run(JSON.stringify(h.localization));
  const second = preview.previewVersionExecutionPlan(h.ctx, 10);
  assert.equal(second.status, 'ready'); assert.notEqual(second.plan_hash, first.plan_hash);
  assert.equal(second.bindings.blueprint_hash, first.bindings.blueprint_hash);
  assert.equal(second.bindings.source_sha256, first.bindings.source_sha256);
});

test('registered HTTP route is GET only, with no generation or billing route substitution', () => {
  const source = fs.readFileSync(require.resolve('../src/routes/index'), 'utf8');
  assert.match(source, /r\.get\('\/redraw\/versions\/:id\/execution-plan', redraw\.getExecutionPlan\)/);
  assert.doesNotMatch(source, /r\.(?:post|put|patch)\('\/redraw\/versions\/:id\/execution-plan'/);
});

for (const invalidCarrier of [false, true]) {
  test(`native language evidence on pinned carrier is not promoted to region: invalidCarrier=${invalidCarrier}`, (t) => {
    const h = fixture(t);
    h.db.prepare('UPDATE ai_service_configs SET is_active = 0 WHERE id = 42').run();
    h.settings.redraw_locale_capabilities.push({ locale: 'en', language: 'en', market: '', target_locale: null,
      status: 'verified', evidence: { native_dialogue_audio: {
        contract: 'redraw-native-dialogue-audio-v1', config_id: invalidCarrier ? 999 : 41,
        config_updated_at: now, provider: 'fumin', protocol: 'fumin_video', model: 'fumin-seedance-2.0-mini',
        provider_task_id: 'native-fixture', terminal_status: 'completed', artifact_id: 700, artifact_sha256: 'a'.repeat(64),
        media: { video_stream: true, audio_stream: true },
        locale_verification: { language: 'en', language_verified: true, locale_verified: false },
        human_review: { status: 'passed', speaker_order: 'passed', lip_sync: 'passed', extra_dialogue: 'passed' },
      } } });
    h.db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = 41').run(JSON.stringify(h.settings));
    const result = preview.previewVersionExecutionPlan(h.ctx, 10);
    assert.equal(result.status, invalidCarrier ? 'blocked' : 'ready');
    if (!invalidCarrier) {
      assert.equal(result.capability.audio_mode, 'native');
      assert.equal(result.capability.audio_verification.locale_verified, false);
      assert.ok(result.execution_blockers.includes('TARGET_REGION_AUDIO_NOT_VERIFIED'));
    }
  });
}

test('preview DTO and hash do not depend on changed credentials, connection targets or environment', (t) => {
  const h = fixture(t);
  const before = preview.previewVersionExecutionPlan(h.ctx, 10);
  h.db.prepare("UPDATE ai_service_configs SET api_key = 'synthetic-new-key', base_url = 'https://new.synthetic.invalid', endpoint = '/new' WHERE id IN (41, 42)").run();
  Object.defineProperty(h.ctx, 'env', { get() { assert.fail('preview must not read credential environment'); } });
  h.queries.length = 0;
  assert.deepEqual(preview.previewVersionExecutionPlan(h.ctx, 10), before);
  assert.equal(before.capability.credential_readiness, 'not_checked');
  assert.ok(h.queries.filter((sql) => /FROM ai_service_configs/i.test(sql)).every((sql) => !/api_key|base_url|endpoint/i.test(sql)));
});
