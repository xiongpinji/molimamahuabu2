'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { fixture } = require('./redrawExecutionPlanPreview.test');
const preview = require('../src/services/redrawExecutionPlanPreviewService');
const { stableStringify } = require('../src/services/redrawEpisodeFactsService');
const readiness = require('../src/services/redrawSelectedCapabilityReadinessService');
const aiConfig = require('../src/services/aiConfigService');
const videoClient = require('../src/services/videoClient');
const ttsSelection = require('../src/services/ttsConfigSelectionService');
const { withExternalModelEvidence, evidenceRoots } = require('./helpers/externalModelEvidenceFixture');

const hash = (value) => createHash('sha256').update(stableStringify(value)).digest('hex');
const rehash = (value) => { delete value.capability_hash; value.capability_hash = hash(value); return value; };

function setup(t, { provider = 'fumin', audio = 'replace', ttsProvider = 'minimax', ttsType = 'tts' } = {}) {
  const h = fixture(t);
  h.ctx.env = { FUMIN_API_KEY: '', TOAPIS_API_KEY: '', OPENAI_API_KEY: 'synthetic-ignored-openai-env' };
  h.db.prepare("UPDATE ai_service_configs SET api_key = 'synthetic-video-key', base_url = 'https://video.synthetic.invalid' WHERE id = 41").run();
  h.db.prepare("UPDATE ai_service_configs SET api_key = 'synthetic-tts-key', base_url = 'https://tts.synthetic.invalid/v1', provider = ?, service_type = ? WHERE id = 42").run(ttsProvider, ttsType);
  const ttsSettings = JSON.parse(h.db.prepare('SELECT settings FROM ai_service_configs WHERE id = 42').get().settings);
  ttsSettings.redraw_locale_capabilities[0].evidence.tts.provider = ttsProvider;
  h.db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = 42').run(JSON.stringify(ttsSettings));
  if (provider !== 'fumin') {
    const isToapis = provider === 'toapis';
    const model = isToapis ? 'seedance-2-mini' : 'xuan-seedance-2.5';
    const parameters = { ...h.capabilities['fumin-seedance-2.0-mini'] };
    const caps = { [model]: withExternalModelEvidence(model, parameters) };
    h.settings.redraw_locale_capabilities[0].evidence.video.provider = provider;
    h.settings.redraw_locale_capabilities[0].evidence.video.model = model;
    h.settings.real_generation_verified_models = [model];
    h.db.prepare('UPDATE ai_service_configs SET provider = ?, api_protocol = ?, model = ?, default_model = ?, base_url = ?, settings = ?, verified_capabilities = ? WHERE id = 41')
      .run(provider, isToapis ? 'toapis_video' : 'feituo_open', JSON.stringify([model]), model,
        isToapis ? 'https://toapis.cn' : 'https://feituo.synthetic.invalid', JSON.stringify(h.settings), JSON.stringify(caps));
    h.ctx.externalModelEvidenceRoots = evidenceRoots;
  }
  if (audio === 'native') {
    const row = h.db.prepare('SELECT provider, api_protocol, default_model, updated_at FROM ai_service_configs WHERE id = 41').get();
    h.settings.redraw_locale_capabilities.push({ locale: 'en', language: 'en', market: '', target_locale: null,
      status: 'verified', evidence: { native_dialogue_audio: {
        contract: 'redraw-native-dialogue-audio-v1', config_id: 41, config_updated_at: row.updated_at,
        provider: row.provider, protocol: row.api_protocol, model: row.default_model,
        provider_task_id: 'synthetic-native-task', terminal_status: 'completed', artifact_id: 700, artifact_sha256: 'a'.repeat(64),
        media: { video_stream: true, audio_stream: true },
        locale_verification: { language: 'en', language_verified: true, locale_verified: false },
        human_review: { status: 'passed', speaker_order: 'passed', lip_sync: 'passed', extra_dialogue: 'passed' },
      } } });
    h.db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = 41').run(JSON.stringify(h.settings));
  }
  h.selected = preview.previewVersionExecutionPlan(h.ctx, 10).capability;
  assert.ok(h.selected, 'fixture must have a real preview-selected capability');
  if (audio === 'not_required') {
    h.selected = rehash({ ...h.selected, audio_mode: 'not_required', audio_verification: { mode: 'not_required', locale_verified: false } });
  }
  h.queries.length = 0;
  return h;
}

function alternate(h, id) {
  const row = h.db.prepare('SELECT * FROM ai_service_configs WHERE id = ?').get(id);
  row.id += 100;
  const settings = JSON.parse(row.settings);
  for (const entry of settings.redraw_locale_capabilities) {
    for (const evidence of Object.values(entry.evidence || {})) evidence.config_id = row.id;
  }
  row.settings = JSON.stringify(settings);
  const keys = Object.keys(row);
  h.db.prepare(`INSERT INTO ai_service_configs (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((key) => row[key]));
  return row.id;
}

function guardedInspect(t, h, selected = h.selected) {
  for (const [service, name] of [[aiConfig, 'listConfigs'], [videoClient, 'getDefaultVideoConfig'],
    [videoClient, 'callVideoApiForConfigId'], [ttsSelection, 'selectTtsConfig']]) {
    t.mock.method(service, name, () => { assert.fail(`forbidden selector/submission: ${name}`); });
  }
  const before = h.db.serialize();
  h.queries.length = 0;
  const result = readiness.inspectSelectedCapabilityReadiness(h.ctx, selected);
  assert.deepEqual(h.db.serialize(), before, 'readiness must not write real SQLite');
  assert.ok(h.queries.every((sql) => !/^\s*(INSERT|UPDATE|DELETE|REPLACE|BEGIN|CREATE|ALTER)/i.test(sql)));
  const configReads = h.queries.filter((sql) => /FROM ai_service_configs/i.test(sql));
  assert.ok(configReads.every((sql) => /\bid\s*=\s*(41|42)\b/.test(sql)), 'only exact selected A rows may be queried');
  assert.ok(configReads.every((sql) => !/SELECT\s+\*|(?:SELECT|,)\s*settings\s*(?:,|FROM)/i.test(sql)));
  return result;
}

function assertBlocked(result, code) {
  assert.equal(result.public_readiness.status, 'blocked');
  assert.deepEqual(result.public_readiness.reason_codes, [code]);
  assert.equal(result.public_readiness.executable, false);
  assert.equal(Object.hasOwn(result, 'private_binding'), false);
}

test('exact selected video and TTS evidence produce a private identity binding, not permission to execute', (t) => {
  const h = setup(t); const result = guardedInspect(t, h);
  assert.equal(result.public_readiness.status, 'ready');
  assert.equal(result.public_readiness.executable, false);
  assert.equal(result.public_readiness.capability_hash, h.selected.capability_hash);
  assert.deepEqual(result.public_readiness.credential_presence, { video: 'present', audio: 'present' });
  assert.equal(result.private_binding.video.config_id, 41);
  assert.equal(result.private_binding.audio.config_id, 42);
  assert.equal(result.private_binding.audio.provider, 'minimax');
  assert.equal(result.private_binding.audio.model, 'speech-fixture');
  assert.match(result.private_binding.video.connection_fingerprint, /^[a-f0-9]{64}$/);
  assert.match(result.private_binding.audio.connection_fingerprint, /^[a-f0-9]{64}$/);
});

const driftCases = [
  ['missing', (h, id) => h.db.prepare('DELETE FROM ai_service_configs WHERE id = ?').run(id)],
  ['deleted', (h, id) => h.db.prepare("UPDATE ai_service_configs SET deleted_at = 'deleted' WHERE id = ?").run(id)],
  ['inactive', (h, id) => h.db.prepare('UPDATE ai_service_configs SET is_active = 0 WHERE id = ?').run(id)],
  ['paused', (h, id) => h.db.prepare('UPDATE ai_service_configs SET canary_paused = 1 WHERE id = ?').run(id)],
  ['revision', (h, id) => h.db.prepare("UPDATE ai_service_configs SET updated_at = 'drift' WHERE id = ?").run(id)],
  ['provider', (h, id) => h.db.prepare("UPDATE ai_service_configs SET provider = 'other' WHERE id = ?").run(id)],
  ['unverified', (h, id) => h.db.prepare("UPDATE ai_service_configs SET verification_status = 'unverified' WHERE id = ?").run(id)],
  ['model', (h, id) => h.db.prepare("UPDATE ai_service_configs SET model = '[\"other\"]', default_model = 'other' WHERE id = ?").run(id)],
  ['evidence', (h, id) => {
    const settings = JSON.parse(h.db.prepare('SELECT settings FROM ai_service_configs WHERE id = ?').get(id).settings);
    const kind = id === 41 ? 'video' : 'tts';
    settings.redraw_locale_capabilities[0].evidence[kind].terminal_status = 'failed';
    h.db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = ?').run(JSON.stringify(settings), id);
  }],
];
for (const id of [41, 42]) for (const [name, mutate] of driftCases) {
  test(`selected ${id === 41 ? 'video' : 'TTS'} A ${name} blocks although a verified B is available`, (t) => {
    const h = setup(t); const replacementId = alternate(h, id); mutate(h, id);
    const fresh = preview.previewVersionExecutionPlan(h.ctx, 10);
    assert.equal(fresh.status, 'ready', 'B is genuinely a usable planning candidate');
    assert.equal(id === 41 ? fresh.capability.config_id : fresh.capability.audio_verification.config_id, replacementId);
    assertBlocked(guardedInspect(t, h), 'SELECTED_CAPABILITY_STALE');
    assert.ok(h.queries.every((sql) => !/api_key|base_url|endpoint/i.test(sql)), 'metadata rejection precedes credential reads');
  });
}

for (const [name, mutate] of [
  ['raw protocol', (h) => h.db.prepare("UPDATE ai_service_configs SET api_protocol = 'openai' WHERE id = 41").run()],
  ['parameters', (h) => { h.capabilities[h.selected.model].durations = [5]; h.db.prepare('UPDATE ai_service_configs SET verified_capabilities = ? WHERE id = 41').run(JSON.stringify(h.capabilities)); }],
  ['default-model-only video membership', (h) => h.db.prepare("UPDATE ai_service_configs SET model = '[\"other\"]' WHERE id = 41").run()],
  ['unreadable artifact', (h) => { h.ctx.canReadArtifact = (id) => Number(id) === 701; }],
]) {
  test(`${name} cannot keep the old selected binding`, (t) => {
    const h = setup(t); alternate(h, 41); mutate(h);
    assertBlocked(guardedInspect(t, h), 'SELECTED_CAPABILITY_STALE');
  });
}

for (const [name, mutate] of [
  ['missing hash', (value) => { delete value.capability_hash; }],
  ['corrupt hash', (value) => { value.capability_hash = 'f'.repeat(64); }],
  ['unsafe config id', (value) => { value.config_id = '41'; rehash(value); }],
  ['injected secret', (value) => { value.api_key = 'synthetic-injected-secret'; rehash(value); }],
  ['adapter hash', (value) => { value.adapter_hash = 'e'.repeat(64); rehash(value); }],
  ['saved duration', (value) => { value.durations_ms = [1000]; rehash(value); }],
]) {
  test(`invalid saved capability ${name} is safely rejected`, (t) => {
    const h = setup(t); const selected = structuredClone(h.selected); mutate(selected);
    const result = guardedInspect(t, h, selected);
    assert.equal(result.public_readiness.status, 'blocked');
    assert.equal(Object.hasOwn(result, 'private_binding'), false);
    assert.ok(result.public_readiness.reason_codes.every((code) => ['SELECTED_CAPABILITY_INVALID', 'SELECTED_CAPABILITY_STALE'].includes(code)));
    assert.ok(!JSON.stringify(result).includes('synthetic-injected-secret'));
  });
}

for (const audio of ['native', 'not_required']) test(`${audio} selection never reads or substitutes TTS`, (t) => {
  const h = setup(t, { audio }); h.db.prepare('DELETE FROM ai_service_configs WHERE id = 42').run();
  const result = guardedInspect(t, h);
  assert.equal(result.public_readiness.status, 'ready');
  assert.equal(result.private_binding.audio, null);
  assert.equal(result.public_readiness.credential_presence.audio, 'not_required');
  assert.ok(h.queries.every((sql) => !/\bid\s*=\s*42\b/.test(sql)));
});

test('new native evidence never replaces the saved replace audio or its recovered evidence model', (t) => {
  const h = setup(t, { audio: 'native' });
  const settings = JSON.parse(h.db.prepare('SELECT settings FROM ai_service_configs WHERE id = 41').get().settings);
  const nativeEntry = settings.redraw_locale_capabilities.pop();
  h.db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = 41').run(JSON.stringify(settings));
  h.selected = preview.previewVersionExecutionPlan(h.ctx, 10).capability;
  settings.redraw_locale_capabilities.push(nativeEntry);
  h.db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = 41').run(JSON.stringify(settings));
  h.db.prepare("UPDATE ai_service_configs SET model = '[\"speech-fixture\",\"other\"]', default_model = 'other' WHERE id = 42").run();
  const result = guardedInspect(t, h);
  assert.equal(result.public_readiness.status, 'ready');
  assert.equal(result.private_binding.audio.model, 'speech-fixture', 'future execution must pin this exact evidence model');
});

test('audio carrier is blocked without silently changing its service type', (t) => {
  const h = setup(t, { ttsType: 'audio' });
  assertBlocked(guardedInspect(t, h), 'SELECTED_TTS_CARRIER_UNSUPPORTED');
});

test('OpenAI-compatible TTS permits no authorization and has no environment fallback', (t) => {
  const h = setup(t, { ttsProvider: 'openai' });
  h.db.prepare("UPDATE ai_service_configs SET api_key = '', base_url = '' WHERE id = 42").run();
  const first = guardedInspect(t, h);
  assert.equal(first.public_readiness.status, 'ready');
  assert.equal(first.public_readiness.credential_presence.audio, 'absent_optional');
  h.ctx.env.OPENAI_API_KEY = 'synthetic-unrelated-new-env';
  assert.deepEqual(guardedInspect(t, h), first);
});

test('unknown TTS provider with no base URL is blocked', (t) => {
  const h = setup(t, { ttsProvider: 'custom' });
  h.db.prepare("UPDATE ai_service_configs SET base_url = '' WHERE id = 42").run();
  assertBlocked(guardedInspect(t, h), 'SELECTED_CONNECTION_UNSUPPORTED');
});

test('Fumin config key takes priority and irrelevant environment changes do not alter the binding', (t) => {
  const h = setup(t); h.ctx.env.FUMIN_API_KEY = 'synthetic-env-first';
  const first = guardedInspect(t, h);
  h.ctx.env.FUMIN_API_KEY = 'synthetic-env-second';
  assert.deepEqual(guardedInspect(t, h), first);
  h.db.prepare("UPDATE ai_service_configs SET api_key = '' WHERE id = 41").run();
  const fallback = guardedInspect(t, h);
  assert.equal(fallback.public_readiness.status, 'ready');
  assert.notEqual(fallback.private_binding.video.connection_fingerprint, first.private_binding.video.connection_fingerprint);
  h.ctx.env.FUMIN_API_KEY = '';
  const missing = guardedInspect(t, h);
  assertBlocked(missing, 'SELECTED_CREDENTIAL_MISSING');
  assert.equal(missing.public_readiness.credential_presence.video, 'missing');
});

test('ToAPIs actual environment key priority is reflected only in its private binding', (t) => {
  const h = setup(t, { provider: 'toapis' }); h.ctx.env.TOAPIS_API_KEY = 'synthetic-env-first';
  const first = guardedInspect(t, h); assert.equal(first.public_readiness.status, 'ready');
  h.ctx.env.TOAPIS_API_KEY = 'synthetic-env-second';
  const second = guardedInspect(t, h);
  assert.deepEqual(second.public_readiness, first.public_readiness);
  assert.notEqual(second.private_binding.video.connection_fingerprint, first.private_binding.video.connection_fingerprint);
  h.db.prepare("UPDATE ai_service_configs SET api_key = 'synthetic-ignored-db-key' WHERE id = 41").run();
  assert.deepEqual(guardedInspect(t, h), second);
});

test('Feituo keeps the original config credential bytes and ignores an unrelated environment key', (t) => {
  const h = setup(t, { provider: 'feituo' });
  const first = guardedInspect(t, h); assert.equal(first.public_readiness.status, 'ready');
  h.ctx.env.FEITUO_API_KEY = 'synthetic-unused-key';
  assert.deepEqual(guardedInspect(t, h), first);
  h.db.prepare("UPDATE ai_service_configs SET api_key = ' synthetic-video-key ' WHERE id = 41").run();
  assert.notEqual(guardedInspect(t, h).private_binding.video.connection_fingerprint, first.private_binding.video.connection_fingerprint);
});

for (const [id, field] of [[41, 'base_url'], [41, 'endpoint'], [41, 'query_endpoint'], [42, 'base_url'], [42, 'api_key']]) {
  test(`effective ${id} ${field} drift changes the private fingerprint without public leakage`, (t) => {
    const h = setup(t); const first = guardedInspect(t, h);
    h.db.prepare(`UPDATE ai_service_configs SET ${field} = ? WHERE id = ?`).run(field === 'base_url' ? 'https://changed.synthetic.invalid/v1' : 'synthetic-changed-value', id);
    const second = guardedInspect(t, h);
    assert.equal(second.public_readiness.status, 'ready');
    const key = id === 41 ? 'video' : 'audio';
    assert.notEqual(second.private_binding[key].connection_fingerprint, first.private_binding[key].connection_fingerprint);
    assert.deepEqual(second.public_readiness, first.public_readiness);
    const serialized = JSON.stringify(second);
    for (const value of ['synthetic-video-key', 'synthetic-tts-key', 'synthetic-changed-value', 'synthetic.invalid', 'MUST_NOT_READ', 'settings']) assert.ok(!serialized.includes(value));
    for (const part of [second.private_binding.video, second.private_binding.audio]) assert.ok(!JSON.stringify(second.public_readiness).includes(part.connection_fingerprint));
  });
}

test('reader and connection errors do not return sensitive messages, paths or objects', (t) => {
  const h = setup(t); h.ctx.canReadArtifact = () => { throw Object.assign(new Error('synthetic-secret /private/path'), { settings: { api_key: 'synthetic-leak' } }); };
  // The shared generation-evidence validator deliberately maps reader failures to invalid evidence.
  assertBlocked(guardedInspect(t, h), 'SELECTED_CAPABILITY_STALE');
  h.ctx.canReadArtifact = () => true;
  h.db.prepare("UPDATE ai_service_configs SET base_url = 'not a URL synthetic-secret' WHERE id = 41").run();
  assertBlocked(guardedInspect(t, h), 'SELECTED_CONNECTION_UNSUPPORTED');
});

test('canonical selected WAN3 remains explicitly not checked and never reads credentials', (t) => {
  const h = setup(t);
  const selected = rehash({ ...h.selected, protocol: 'toapis_wan3_video' });
  assertBlocked(guardedInspect(t, h, selected), 'CREDENTIAL_BINDING_NOT_CHECKED');
  assert.ok(h.queries.every((sql) => !/api_key|base_url|endpoint/i.test(sql)));
});

test('database failures return only a safe code and never reflect the error object', (t) => {
  const h = setup(t);
  h.ctx.db = { prepare() { throw Object.assign(new Error('synthetic-secret /private/database-path'), { settings: 'synthetic-private-settings' }); } };
  assertBlocked(readiness.inspectSelectedCapabilityReadiness(h.ctx, h.selected), 'SELECTED_CAPABILITY_CHECK_FAILED');
});

test('MiniMax missing config credentials cannot borrow an environment key', (t) => {
  const h = setup(t); h.ctx.env.MINIMAX_API_KEY = 'synthetic-ignored-minimax-env';
  h.db.prepare("UPDATE ai_service_configs SET api_key = '' WHERE id = 42").run();
  const result = guardedInspect(t, h);
  assertBlocked(result, 'SELECTED_CREDENTIAL_MISSING');
  assert.equal(result.public_readiness.credential_presence.audio, 'missing');
});

test('a still-readable changed evidence task cannot retain the old selected evidence hash', (t) => {
  const h = setup(t); alternate(h, 41);
  h.settings.redraw_locale_capabilities[0].evidence.video.task_id = 'another-completed-task';
  h.db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = 41').run(JSON.stringify(h.settings));
  assert.equal(preview.previewVersionExecutionPlan(h.ctx, 10).status, 'ready');
  assertBlocked(guardedInspect(t, h), 'SELECTED_CAPABILITY_STALE');
});

test('ToAPIs does not bind an ignored custom endpoint or promote an untrusted proof', (t) => {
  const h = setup(t, { provider: 'toapis' }); const first = guardedInspect(t, h);
  h.db.prepare("UPDATE ai_service_configs SET endpoint = '/ignored', query_endpoint = '/also-ignored' WHERE id = 41").run();
  assert.deepEqual(guardedInspect(t, h), first);
  h.ctx.externalModelEvidenceRoots = { allowedRoot: '/nonexistent-synthetic-root', root: '/nonexistent-synthetic-root/evidence' };
  assertBlocked(guardedInspect(t, h), 'SELECTED_CAPABILITY_STALE');
});
