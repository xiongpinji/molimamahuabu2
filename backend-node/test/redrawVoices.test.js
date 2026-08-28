const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const credits = require('../src/services/creditLedgerService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  createAssetAttempt,
  finalizeAssetAttempt,
} = require('../src/services/redrawAssetService');
const {
  assignVoice,
  evidenceFromPayload,
  listProductionVoices,
  validateTtsBatch,
} = require('../src/services/redrawVoiceService');

const TTS_CONFIG_ID = 41;
const TTS_CONFIG_UPDATED_AT = '2026-08-08T00:00:00.000Z';
const MODEL_MANIFEST_SHA256 = 'a'.repeat(64);
const CALIBRATION_MANIFEST_SHA256 = 'b'.repeat(64);
const AUDIO_SHA256 = 'c'.repeat(64);
const TRANSCRIPT_SHA256 = 'd'.repeat(64);
const LOCAL_BINARY_SHA256 = 'e'.repeat(64);
const LOCAL_MANIFEST_SHA256 = 'f'.repeat(64);
const LOCAL_APPROVED_TEXT_SHA256 = '1'.repeat(64);
const LOCAL_EVIDENCE_SHA256 = '2'.repeat(64);

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ai_service_configs
    (id, service_type, provider, name, model, default_model, is_active, created_at, updated_at)
    VALUES (?, 'tts', 'verified-tts', 'verified voice config', ?, 'voice-model-1', 1, ?, ?)`)
    .run(TTS_CONFIG_ID, JSON.stringify(['voice-model-1']), TTS_CONFIG_UPDATED_AT, TTS_CONFIG_UPDATED_AT);
  db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '音色测试项目', ?, ?)`).run(now, now);
  const projectId = db.prepare('SELECT id FROM redraw_projects LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', '音色测试作品', 1, 'voice-source', 15000, ?, ?)`).run(projectId, now, now);
  const workId = db.prepare('SELECT id FROM redraw_works LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, source_facts_json, facts_hash, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, 'fr-FR', 'FR', '{}', 'facts-voice', 'asset_review', ?, ?)`).run(workId, now, now);
  const versionId = db.prepare('SELECT id FROM redraw_versions LIMIT 1').get().id;
  return { db, versionId };
}

function addAudioAsset(db, id, localPath, now) {
  db.prepare(`INSERT INTO assets
    (id, name, type, category, local_path, mime_type, duration, created_at, updated_at)
    VALUES (?, '音色样音', 'audio', 'voice', ?, 'audio/mpeg', 1200, ?, ?)`).run(id, localPath, now, now);
}

function addVoiceEvidence(db, versionId, id, evidence, now, options = {}) {
  const status = options.status || 'generated';
  const voiceAssetId = options.voiceAssetId ?? evidence.audio_asset_id;
  const voiceId = evidence.voice_id || evidence.profile || `voice-${id}`;
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     voice_asset_id, version_number, approval_status, status, created_at, updated_at)
    VALUES (?, ?, 'tenant-a', 'user-a', 'voice', ?, ?, ?, 1, 'pending', ?, ?, ?)`).run(
    id,
    versionId,
    JSON.stringify({ source_ref: { voice_id: voiceId }, snapshot: { evidence } }),
    voiceId,
    voiceAssetId,
    status,
    now,
    now,
  );
}

function addCharacterAsset(db, versionId, id, now) {
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     asset_id, version_number, approval_status, status, created_at, updated_at)
    VALUES (?, ?, 'tenant-a', 'user-a', 'character', ?, '角色', ?, 1, 'pending', 'generated', ?, ?)`).run(
    id,
    versionId,
    JSON.stringify({ source_ref: { character_id: 'c-1' }, snapshot: {} }),
    id + 1000,
    now,
    now,
  );
}

function verifiedVoice(audioAssetId, voiceId = 'fr-female-1') {
  return {
    source: 'offline-worker',
    locale: 'fr-FR',
    market: 'FR',
    locale_pack: 'fr-FR@fixture',
    audio_sha256: AUDIO_SHA256,
    transcript_sha256: TRANSCRIPT_SHA256,
    model_manifest_sha256: MODEL_MANIFEST_SHA256,
    calibration_manifest_sha256: CALIBRATION_MANIFEST_SHA256,
    asr_model_revision: 'asr-fr-20260808',
    accent_model_revision: 'accent-fr-20260808',
    metrics: { word_error_rate: 0, accent_confidence: 0.99 },
    completed_at: '2026-08-08T00:00:01.000Z',
    provider: 'verified-tts',
    model: 'voice-model-1',
    ai_service_config_id: TTS_CONFIG_ID,
    config_updated_at: TTS_CONFIG_UPDATED_AT,
    voice_id: voiceId,
    task_id: `tts-${voiceId}`,
    terminal_status: 'completed',
    audio_asset_id: audioAssetId,
    duration_ms: 1200,
    real_generation_verified: true,
    language_verified: true,
    detected_locale: 'fr-FR',
  };
}

function localOfflineVoice(state, audioAssetId, voiceAssetId, registrationId, overrides = {}) {
  return {
    source: 'local_offline_tts',
    contract_version: 'local-offline-tts-v1',
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    version_id: state.versionId,
    voice_redraw_asset_id: voiceAssetId,
    source_character_key: 'c-1',
    locale: 'fr-FR',
    market: 'FR',
    profile: 'fr-role-1',
    engine: 'eSpeak NG',
    engine_version: '1.52.0',
    binary_sha256: LOCAL_BINARY_SHA256,
    manifest_sha256: LOCAL_MANIFEST_SHA256,
    audio_asset_id: audioAssetId,
    audio_sha256: AUDIO_SHA256,
    duration_ms: 1200,
    approved_text_sha256: LOCAL_APPROVED_TEXT_SHA256,
    locale_pack: 'fr-FR@fixture',
    transcript_sha256: TRANSCRIPT_SHA256,
    model_manifest_sha256: MODEL_MANIFEST_SHA256,
    calibration_manifest_sha256: CALIBRATION_MANIFEST_SHA256,
    metrics: { word_error_rate: 0, character_error_rate: 0, critical_tokens_match: true },
    language_verified: true,
    detected_locale: 'fr-FR',
    registration_id: registrationId,
    registration_status: 'completed',
    completed_at: '2026-08-08T00:00:01.000Z',
    ...overrides,
  };
}

function addLocalRegistration(db, evidence, overrides = {}) {
  db.prepare(`INSERT INTO redraw_local_voice_registrations
    (id, tenant_id, user_id, version_id, voice_redraw_asset_id, source_character_key,
     idempotency_hash, request_hash, target_locale, target_market, approved_text_sha256,
     profile_key, engine_manifest_sha256, status, audio_asset_id, audio_sha256,
     locale_evidence_sha256, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      evidence.registration_id,
      overrides.tenantId || evidence.tenant_id,
      overrides.userId || evidence.user_id,
      overrides.versionId || evidence.version_id,
      overrides.voiceAssetId || evidence.voice_redraw_asset_id,
      overrides.sourceCharacterKey || evidence.source_character_key,
      `idem-${evidence.registration_id}`,
      `request-${evidence.registration_id}`,
      overrides.locale || evidence.locale,
      overrides.market || evidence.market,
      overrides.approvedTextSha256 || evidence.approved_text_sha256,
      overrides.profile || evidence.profile,
      overrides.manifestSha256 || evidence.manifest_sha256,
      overrides.status || 'completed',
      overrides.audioAssetId || evidence.audio_asset_id,
      overrides.audioSha256 || evidence.audio_sha256,
      overrides.localeEvidenceSha256 || LOCAL_EVIDENCE_SHA256,
      evidence.completed_at,
      evidence.completed_at,
      overrides.completedAt || evidence.completed_at,
    );
}

function assignmentOptions(state, voiceAssetId, extra = {}) {
  return {
    tenantId: 'tenant-a',
    userId: 'user-a',
    versionId: state.versionId,
    voiceAssetId,
    canReadAsset: () => true,
    localeRegistry: trustedRegistry(),
    ...extra,
  };
}

function validationOptions() {
  return {
    tenantId: 'tenant-a',
    userId: 'user-a',
    canReadAsset: () => true,
    localeRegistry: trustedRegistry(),
    localeVerifier: readyLocaleVerifier(),
  };
}

function trustedRegistry() {
  return {
    assertReady(expected) {
      const locale = typeof expected === 'string' ? expected : expected?.locale;
      if (locale !== 'fr-FR') throw new Error('locale pack not ready');
      return {
        id: 'fr-FR@fixture',
        locale: 'fr-FR',
        model_manifest_sha256: MODEL_MANIFEST_SHA256,
        calibration_manifest_sha256: CALIBRATION_MANIFEST_SHA256,
      };
    },
    assertEvidenceTrusted(evidence) {
      if (evidence.source !== 'offline-worker'
        || evidence.locale_pack !== 'fr-FR@fixture'
        || evidence.model_manifest_sha256 !== MODEL_MANIFEST_SHA256
        || evidence.calibration_manifest_sha256 !== CALIBRATION_MANIFEST_SHA256) {
        const error = new Error('worker evidence not trusted');
        error.code = 'REDRAW_LOCALE_VERIFIER_NOT_READY';
        throw error;
      }
      return evidence;
    },
  };
}

test('complete local_offline_tts evidence enters production without provider config and exposes its source', () => {
  const state = setup();
  const now = new Date().toISOString();
  addAudioAsset(state.db, 520, 'local-voice.wav', now);
  const evidence = localOfflineVoice(state, 520, 620, 720);
  addVoiceEvidence(state.db, state.versionId, 620, evidence, now);
  addLocalRegistration(state.db, evidence);
  state.db.prepare('UPDATE ai_service_configs SET is_active = 0').run();

  const voices = listProductionVoices(state.db, {
    tenantId: 'tenant-a', userId: 'user-a', versionId: state.versionId,
    locale: 'fr-FR', market: 'FR', localeRegistry: trustedRegistry(),
  }, () => true);

  assert.equal(voices.length, 1);
  assert.equal(voices[0].verification_source, 'local_offline_tts');
  assert.equal(voices[0].provider_verified, false);
  assert.equal(voices[0].local_offline_verified, true);
  assert.equal(Object.hasOwn(voices[0], 'real_generation_verified'), false);
  state.db.close();
});

test('local_offline_tts requires one complete branch and rejects missing or mixed evidence', () => {
  const requiredCases = [
    ['registration', 'registration_id'],
    ['binary', 'binary_sha256'],
    ['manifest', 'manifest_sha256'],
    ['profile', 'profile'],
    ['audio', 'audio_sha256'],
    ['locale evidence', 'locale_pack'],
  ];
  for (const [label, field] of requiredCases) {
    const state = setup();
    const now = new Date().toISOString();
    const voiceAssetId = 621;
    const evidence = localOfflineVoice(state, 521, voiceAssetId, 721);
    const registrationEvidence = { ...evidence };
    addAudioAsset(state.db, 521, `${label}.wav`, now);
    delete evidence[field];
    addVoiceEvidence(state.db, state.versionId, voiceAssetId, evidence, now);
    addLocalRegistration(state.db, registrationEvidence);
    assert.deepEqual(listProductionVoices(state.db, {
      tenantId: 'tenant-a', userId: 'user-a', versionId: state.versionId,
      locale: 'fr-FR', market: 'FR', localeRegistry: trustedRegistry(),
    }, () => true), [], label);
    state.db.close();
  }

  const state = setup();
  const now = new Date().toISOString();
  const mixed = localOfflineVoice(state, 522, 622, 722, {
    provider: 'verified-tts',
    ai_service_config_id: TTS_CONFIG_ID,
    task_id: 'provider-task',
    real_generation_verified: true,
  });
  addAudioAsset(state.db, 522, 'mixed.wav', now);
  addVoiceEvidence(state.db, state.versionId, 622, mixed, now);
  addLocalRegistration(state.db, mixed);
  const providerMixed = {
    ...verifiedVoice(526, 'provider-with-local-half'),
    profile: 'fr-role-1',
    binary_sha256: LOCAL_BINARY_SHA256,
    registration_id: 999,
  };
  addAudioAsset(state.db, 526, 'provider-mixed.mp3', now);
  addVoiceEvidence(state.db, state.versionId, 626, providerMixed, now);
  assert.deepEqual(listProductionVoices(state.db, {
    tenantId: 'tenant-a', userId: 'user-a', versionId: state.versionId,
    locale: 'fr-FR', market: 'FR', localeRegistry: trustedRegistry(),
  }, () => true), []);
  state.db.close();
});

test('local offline assign revalidates registration, is branch-aware, and never writes provider verification', () => {
  const state = setup();
  const now = new Date().toISOString();
  addAudioAsset(state.db, 523, 'local-bind.wav', now);
  addAudioAsset(state.db, 524, 'local-other.wav', now);
  const firstEvidence = localOfflineVoice(state, 523, 623, 723);
  const otherEvidence = localOfflineVoice(state, 524, 624, 724, { profile: 'fr-role-2' });
  addVoiceEvidence(state.db, state.versionId, 623, firstEvidence, now);
  addVoiceEvidence(state.db, state.versionId, 624, otherEvidence, now);
  addLocalRegistration(state.db, firstEvidence);
  addLocalRegistration(state.db, otherEvidence);
  addCharacterAsset(state.db, state.versionId, 723, now);
  const options = assignmentOptions(state, 623);

  const first = assignVoice(state.db, 723, firstEvidence, options);
  assert.equal(first.conflict, false);
  assert.equal(first.snapshot.verification_source, 'local_offline_tts');
  assert.equal(first.snapshot.provider_verified, false);
  assert.equal(first.snapshot.local_offline_verified, true);
  assert.equal(Object.hasOwn(first.snapshot, 'real_generation_verified'), false);
  assert.equal(assignVoice(state.db, 723, firstEvidence, options).conflict, false);
  assert.equal(assignVoice(state.db, 723, otherEvidence, {
    ...assignmentOptions(state, 624),
  }).conflict, true);

  state.db.prepare("UPDATE redraw_local_voice_registrations SET status = 'needs_attention' WHERE id = 723").run();
  assert.throws(
    () => assignVoice(state.db, 723, firstEvidence, options),
    (error) => error.code === 'REDRAW_VOICE_NOT_VERIFIED',
  );
  state.db.close();
});

test('dialogue batch accepts the same complete local evidence branch without provider config', () => {
  const state = setup();
  const now = new Date().toISOString();
  addAudioAsset(state.db, 525, 'local-dialogue.wav', now);
  const evidence = localOfflineVoice(state, 525, 625, 725);
  addVoiceEvidence(state.db, state.versionId, 625, evidence, now);
  addLocalRegistration(state.db, evidence);
  addCharacterAsset(state.db, state.versionId, 725, now);
  assignVoice(state.db, 725, evidence, assignmentOptions(state, 625));
  state.db.prepare('UPDATE ai_service_configs SET is_active = 0').run();

  const result = validateTtsBatch(state.db, state.versionId, [{
    speaker_id: 'c-1', localized_text: 'Bonjour', start_ms: 0, end_ms: 2000,
    estimated_duration_ms: 1200,
  }], validationOptions());

  assert.equal(result.ok, true);
  assert.equal(result.requests[0].verification_source, 'local_offline_tts');
  assert.equal(result.requests[0].profile, 'fr-role-1');
  state.db.close();
});

function readyLocaleVerifier() {
  return {
    assertReady() {
      return {
        locale_pack: 'fr-FR@fixture',
        model_manifest_sha256: MODEL_MANIFEST_SHA256,
        calibration_manifest_sha256: CALIBRATION_MANIFEST_SHA256,
      };
    },
  };
}

test('未完成真实 TTS 的音色不进入生产目录', () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-voice-unverified-'));
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'unverified.mp3'), 'audio');
  addAudioAsset(state.db, 501, 'unverified.mp3', now);
  addVoiceEvidence(state.db, state.versionId, 601, { ...verifiedVoice(501), terminal_status: 'processing', real_generation_verified: false }, now);

  assert.deepEqual(listProductionVoices(state.db, { locale: 'fr-FR' }, (asset) => fs.existsSync(path.join(root, asset.local_path))), []);
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('生产音色必须有完整证据、匹配语言且音频可读', () => {
  const state = setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-voice-verified-'));
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'verified.mp3'), 'audio');
  fs.writeFileSync(path.join(root, 'needs-attention.mp3'), 'audio');
  fs.writeFileSync(path.join(root, 'mismatch.mp3'), 'audio');
  addAudioAsset(state.db, 502, 'verified.mp3', now);
  addAudioAsset(state.db, 503, 'missing.mp3', now);
  addAudioAsset(state.db, 504, 'needs-attention.mp3', now);
  addAudioAsset(state.db, 505, 'mismatch.mp3', now);
  addVoiceEvidence(state.db, state.versionId, 602, verifiedVoice(502), now);
  addVoiceEvidence(state.db, state.versionId, 603, verifiedVoice(503, 'en-male-1'), now);
  addVoiceEvidence(state.db, state.versionId, 604, verifiedVoice(504, 'needs-attention'), now, { status: 'needs_attention' });
  addVoiceEvidence(state.db, state.versionId, 605, verifiedVoice(505, 'mismatch'), now, { voiceAssetId: 504 });

  const canReadAudio = (asset) => fs.existsSync(path.join(root, asset.local_path));
  assert.deepEqual(listProductionVoices(state.db, {
    locale: 'fr-FR', market: 'FR', tenantId: 'tenant-b', userId: 'user-b',
    localeRegistry: trustedRegistry(),
  }, canReadAudio), []);
  const voices = listProductionVoices(state.db, {
    locale: 'fr-FR', market: 'FR', tenantId: 'tenant-a', userId: 'user-a',
    localeRegistry: trustedRegistry(),
  }, canReadAudio);
  assert.equal(voices.length, 1);
  assert.equal(voices[0].voice_id, 'fr-female-1');
  assert.equal(voices[0].audio_asset_id, 502);
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('missing offline-worker fields are rejected from production, bind, and dialogue validation', () => {
  const state = setup();
  const now = new Date().toISOString();
  addAudioAsset(state.db, 513, 'missing-worker.mp3', now);
  const evidence = verifiedVoice(513, 'missing-worker');
  delete evidence.source;
  addVoiceEvidence(state.db, state.versionId, 613, evidence, now);
  addCharacterAsset(state.db, state.versionId, 713, now);

  assert.deepEqual(listProductionVoices(state.db, {
    tenantId: 'tenant-a',
    userId: 'user-a',
    locale: 'fr-FR',
    market: 'FR',
    localeRegistry: trustedRegistry(),
  }, () => true), []);
  assert.throws(
    () => assignVoice(state.db, 713, evidence, assignmentOptions(state, 613)),
    (error) => error.code === 'REDRAW_VOICE_NOT_VERIFIED',
  );

  const payload = JSON.parse(state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = 713').get().source_ref_json);
  payload.snapshot.voice_snapshot = evidence;
  state.db.prepare('UPDATE redraw_assets SET source_ref_json = ?, voice_asset_id = ? WHERE id = 713')
    .run(JSON.stringify(payload), evidence.audio_asset_id);
  const validation = validateTtsBatch(state.db, state.versionId, [{
    speaker_id: 'c-1',
    localized_text: 'Ne regarde pas en arriere',
    start_ms: 0,
    end_ms: 2000,
    estimated_duration_ms: 1800,
  }], validationOptions());
  assert.equal(validation.ok, false);
  assert.equal(validation.issues[0].reason, 'voice_not_verified');
  state.db.close();
});

test('type audio with a non-audio MIME is rejected by list, bind, and dialogue validation', () => {
  const state = setup();
  const now = new Date().toISOString();
  const evidence = verifiedVoice(512, 'bad-mime-voice');
  addAudioAsset(state.db, 512, 'bad-mime.png', now);
  state.db.prepare("UPDATE assets SET mime_type = 'image/png' WHERE id = 512").run();
  addVoiceEvidence(state.db, state.versionId, 612, evidence, now);
  addCharacterAsset(state.db, state.versionId, 712, now);

  assert.deepEqual(listProductionVoices(state.db, {
    tenantId: 'tenant-a', userId: 'user-a', locale: 'fr-FR', market: 'FR',
    localeRegistry: trustedRegistry(),
  }, () => true), []);
  assert.throws(
    () => assignVoice(state.db, 712, evidence, assignmentOptions(state, 612)),
    (error) => error.code === 'REDRAW_VOICE_AUDIO_NOT_FOUND',
  );

  const character = state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = 712').get();
  const payload = JSON.parse(character.source_ref_json);
  payload.snapshot.voice_snapshot = evidence;
  state.db.prepare('UPDATE redraw_assets SET source_ref_json = ?, voice_asset_id = ? WHERE id = 712')
    .run(JSON.stringify(payload), evidence.audio_asset_id);
  const validation = validateTtsBatch(state.db, state.versionId, [{
    speaker_id: 'c-1',
    localized_text: 'Ne regarde pas en arriere',
    start_ms: 0,
    end_ms: 2000,
    estimated_duration_ms: 1800,
  }], validationOptions());
  assert.equal(validation.ok, false);
  assert.equal(validation.issues[0].reason, 'voice_audio_missing');
  state.db.close();
});

test('completed voice provider result rechecks exact TTS config before confirming credits', () => {
  const state = setup();
  const now = new Date().toISOString();
  credits.setTenantAccountBalance(state.db, 'tenant-a', 10);
  addAudioAsset(state.db, 514, 'stale-config.mp3', now);
  state.db.prepare('UPDATE assets SET duration = 1.2 WHERE id = 514').run();
  const sourceRef = { id: 'voice-stale-config', voice_id: 'stale-config-voice' };
  const ctx = {
    db: state.db,
    tenantId: 'tenant-a',
    userId: 'user-a',
    versionId: state.versionId,
    allowUnmaterializedDraft: true,
    creditAmount: 2,
    assetReader: { canRead: () => true },
    localeRegistry: trustedRegistry(),
  };
  const attempt = createAssetAttempt(ctx, {
    kind: 'voice',
    sourceRef,
    snapshot: {
      provider: 'verified-tts',
      model: 'voice-model-1',
      ai_service_config_id: TTS_CONFIG_ID,
      config_updated_at: TTS_CONFIG_UPDATED_AT,
    },
  });
  state.db.prepare('UPDATE ai_service_configs SET is_active = 0, updated_at = ? WHERE id = ?')
    .run('2026-08-08T00:00:02.000Z', TTS_CONFIG_ID);

  const result = finalizeAssetAttempt(ctx, attempt.id, {
    status: 'completed',
    provider_task_id: 'provider-stale-config',
    voice_asset_id: 514,
    duration: 1.2,
    voice_evidence: { ...verifiedVoice(514, 'stale-config-voice'), task_id: 'provider-stale-config' },
  });
  const stored = state.db.prepare('SELECT status, error_code, credit_reservation_id, source_ref_json FROM redraw_assets WHERE id = ?')
    .get(attempt.id);
  const snapshot = JSON.parse(stored.source_ref_json).snapshot;

  assert.equal(result.status, 'needs_attention');
  assert.equal(stored.status, 'needs_attention');
  assert.equal(stored.error_code, 'REDRAW_TTS_CONFIG_PIN_INVALID');
  assert.equal(credits.getReservation(state.db, stored.credit_reservation_id).status, 'held');
  assert.equal(snapshot.provider_completed, true);
  assert.equal(snapshot.provider_task_id, 'provider-stale-config');
  state.db.close();
});

test('completed voice provider result with active exact TTS config confirms credits', () => {
  const state = setup();
  const now = new Date().toISOString();
  credits.setTenantAccountBalance(state.db, 'tenant-a', 10);
  addAudioAsset(state.db, 515, 'active-config.mp3', now);
  state.db.prepare('UPDATE assets SET duration = 1.2 WHERE id = 515').run();
  const sourceRef = { id: 'voice-active-config', voice_id: 'active-config-voice' };
  const ctx = {
    db: state.db,
    tenantId: 'tenant-a',
    userId: 'user-a',
    versionId: state.versionId,
    allowUnmaterializedDraft: true,
    creditAmount: 2,
    assetReader: { canRead: () => true },
    localeRegistry: trustedRegistry(),
  };
  const attempt = createAssetAttempt(ctx, {
    kind: 'voice',
    sourceRef,
    snapshot: {
      provider: 'verified-tts',
      model: 'voice-model-1',
      ai_service_config_id: TTS_CONFIG_ID,
      config_updated_at: TTS_CONFIG_UPDATED_AT,
    },
  });

  const result = finalizeAssetAttempt(ctx, attempt.id, {
    status: 'completed',
    provider_task_id: 'provider-active-config',
    voice_asset_id: 515,
    duration: 1.2,
    voice_evidence: { ...verifiedVoice(515, 'active-config-voice'), task_id: 'provider-active-config' },
  });
  const stored = state.db.prepare('SELECT status, error_code, credit_reservation_id FROM redraw_assets WHERE id = ?')
    .get(attempt.id);

  assert.equal(result.status, 'generated');
  assert.equal(stored.status, 'generated');
  assert.equal(stored.error_code, null);
  assert.equal(credits.getReservation(state.db, stored.credit_reservation_id).status, 'confirmed');
  state.db.close();
});

test('音色证据读取优先使用 voice_evidence 再兼容 legacy evidence', () => {
  const preferred = verifiedVoice(901, 'preferred');
  const legacy = verifiedVoice(902, 'legacy');
  assert.equal(evidenceFromPayload({
    snapshot: {
      voice_evidence: preferred,
      evidence: legacy,
    },
  }).voice_id, 'preferred');
  assert.equal(evidenceFromPayload({
    voice_evidence: preferred,
    evidence: legacy,
  }).voice_id, 'preferred');
  assert.equal(evidenceFromPayload({
    snapshot: { evidence: legacy },
  }).voice_id, 'legacy');
});

test('legacy evidence missing detected_locale is rejected from production voices', () => {
  const state = setup();
  const now = new Date().toISOString();
  addAudioAsset(state.db, 510, 'legacy-missing-locale.mp3', now);
  const evidence = verifiedVoice(510, 'legacy-missing-locale');
  delete evidence.detected_locale;
  addVoiceEvidence(state.db, state.versionId, 610, evidence, now);
  assert.deepEqual(listProductionVoices(state.db, {
    tenantId: 'tenant-a', userId: 'user-a', locale: 'fr-FR', market: 'FR',
    localeRegistry: trustedRegistry(),
  }, () => true), []);
  state.db.close();
});

test('角色在同一本地化版本固定音色快照', () => {
  const state = setup();
  const now = new Date().toISOString();
  addAudioAsset(state.db, 801, 'voice-801.mp3', now);
  addAudioAsset(state.db, 802, 'voice-802.mp3', now);
  addVoiceEvidence(state.db, state.versionId, 681, verifiedVoice(801), now);
  addVoiceEvidence(state.db, state.versionId, 682, verifiedVoice(802, 'fr-male-1'), now);
  addCharacterAsset(state.db, state.versionId, 701, now);
  const selected = assignVoice(state.db, 701, verifiedVoice(801), assignmentOptions(state, 681));
  assert.equal(selected.conflict, false);
  assert.equal(selected.snapshot.voice_id, 'fr-female-1');
  assert.equal(state.db.prepare('SELECT voice_asset_id FROM redraw_assets WHERE id = 701').get().voice_asset_id, 801);
  assert.equal(state.db.prepare('SELECT approval_status FROM redraw_assets WHERE id = 701').get().approval_status, 'pending');
  assert.equal(assignVoice(state.db, 701, verifiedVoice(802, 'fr-male-1'), assignmentOptions(state, 682)).conflict, true);
  assert.equal(assignVoice(state.db, 701, verifiedVoice(801), assignmentOptions(state, 681)).conflict, false);
  state.db.close();
});

test('same voice and audio with a different provider task is a binding conflict, not an idempotent replay', () => {
  const state = setup();
  const now = new Date().toISOString();
  addAudioAsset(state.db, 803, 'voice-803.mp3', now);
  const firstEvidence = verifiedVoice(803, 'fr-same-voice');
  const secondEvidence = { ...firstEvidence, task_id: 'tts-different-task' };
  addVoiceEvidence(state.db, state.versionId, 683, firstEvidence, now);
  addVoiceEvidence(state.db, state.versionId, 684, secondEvidence, now);
  addCharacterAsset(state.db, state.versionId, 703, now);
  assert.equal(assignVoice(state.db, 703, firstEvidence, assignmentOptions(state, 683)).conflict, false);
  assert.equal(assignVoice(state.db, 703, secondEvidence, assignmentOptions(state, 684)).conflict, true);
  const stored = JSON.parse(state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = 703').get().source_ref_json);
  assert.equal(stored.snapshot.voice_snapshot.task_id, firstEvidence.task_id);
  state.db.close();
});

test('音色绑定在读取后发生并发更新时用 expected_updated_at 原子拒绝覆盖', () => {
  const state = setup();
  const now = new Date().toISOString();
  addAudioAsset(state.db, 804, 'voice-804.mp3', now);
  addVoiceEvidence(state.db, state.versionId, 684, verifiedVoice(804), now);
  addCharacterAsset(state.db, state.versionId, 704, now);
  let updateIntercepted = false;
  const concurrentDb = {
    prepare(sql) {
      const statement = state.db.prepare(sql);
      if (!/UPDATE redraw_assets\s+SET voice_asset_id/.test(sql)) return statement;
      return {
        run(...params) {
          updateIntercepted = true;
          state.db.prepare('UPDATE redraw_assets SET updated_at = ? WHERE id = ?')
            .run('2026-08-08T12:00:00.000Z', 704);
          return statement.run(...params);
        },
      };
    },
  };

  assert.throws(
    () => assignVoice(concurrentDb, 704, verifiedVoice(804), assignmentOptions(state, 684, { expectedUpdatedAt: now })),
    (error) => error.code === 'REDRAW_VOICE_BIND_CONFLICT',
  );
  assert.equal(updateIntercepted, true);
  const stored = state.db.prepare('SELECT voice_asset_id, source_ref_json FROM redraw_assets WHERE id = 704').get();
  assert.equal(stored.voice_asset_id, null);
  assert.equal(JSON.parse(stored.source_ref_json).snapshot.voice_snapshot, undefined);
  state.db.close();
});

test('音色绑定省略 expected_updated_at 时仍用读取到的 updated_at 原子拒绝覆盖', () => {
  const state = setup();
  const now = new Date().toISOString();
  addAudioAsset(state.db, 805, 'voice-805.mp3', now);
  addVoiceEvidence(state.db, state.versionId, 685, verifiedVoice(805), now);
  addCharacterAsset(state.db, state.versionId, 705, now);
  let updateIntercepted = false;
  const concurrentDb = {
    prepare(sql) {
      const statement = state.db.prepare(sql);
      if (!/UPDATE redraw_assets\s+SET voice_asset_id/.test(sql)) return statement;
      return {
        run(...params) {
          updateIntercepted = true;
          state.db.prepare('UPDATE redraw_assets SET updated_at = ? WHERE id = ?')
            .run('2026-08-08T12:05:00.000Z', 705);
          return statement.run(...params);
        },
      };
    },
  };

  assert.throws(
    () => assignVoice(concurrentDb, 705, verifiedVoice(805), assignmentOptions(state, 685)),
    (error) => error.code === 'REDRAW_VOICE_BIND_CONFLICT',
  );
  assert.equal(updateIntercepted, true);
  const stored = state.db.prepare('SELECT voice_asset_id, source_ref_json FROM redraw_assets WHERE id = 705').get();
  assert.equal(stored.voice_asset_id, null);
  assert.equal(JSON.parse(stored.source_ref_json).snapshot.voice_snapshot, undefined);
  state.db.close();
});

test('音色绑定同毫秒更新时仍推进 updated_at 防止第二个不同绑定命中', () => {
  const state = setup();
  const fixedNow = '2026-08-08T12:10:00.000Z';
  addAudioAsset(state.db, 806, 'voice-806.mp3', fixedNow);
  addAudioAsset(state.db, 807, 'voice-807.mp3', fixedNow);
  addVoiceEvidence(state.db, state.versionId, 686, verifiedVoice(806, 'fr-first'), fixedNow);
  addVoiceEvidence(state.db, state.versionId, 687, verifiedVoice(807, 'fr-second'), fixedNow);
  addCharacterAsset(state.db, state.versionId, 706, fixedNow);

  const first = assignVoice(state.db, 706, verifiedVoice(806, 'fr-first'), assignmentOptions(state, 686, {
    clock: () => fixedNow,
  }));
  assert.equal(first.conflict, false);
  const afterFirst = state.db.prepare('SELECT voice_asset_id, updated_at FROM redraw_assets WHERE id = 706').get();
  assert.equal(afterFirst.voice_asset_id, 806);
  assert.equal(afterFirst.updated_at, '2026-08-08T12:10:00.001Z');

  assert.throws(
    () => assignVoice(state.db, 706, verifiedVoice(807, 'fr-second'), assignmentOptions(state, 687, {
      expectedUpdatedAt: fixedNow,
      clock: () => fixedNow,
    })),
    (error) => error.code === 'REDRAW_VOICE_BIND_CONFLICT',
  );
  const stored = state.db.prepare('SELECT voice_asset_id, source_ref_json FROM redraw_assets WHERE id = 706').get();
  assert.equal(stored.voice_asset_id, 806);
  assert.equal(JSON.parse(stored.source_ref_json).snapshot.voice_snapshot.voice_id, 'fr-first');
  state.db.close();
});

test('批量 TTS 前重新检查语言、说话人和台词时长', () => {
  const state = setup();
  const now = new Date().toISOString();
  addAudioAsset(state.db, 811, 'voice-811.mp3', now);
  addVoiceEvidence(state.db, state.versionId, 691, verifiedVoice(811), now);
  addCharacterAsset(state.db, state.versionId, 711, now);
  assignVoice(state.db, 711, verifiedVoice(811), assignmentOptions(state, 691));
  const validTurn = {
    speaker_id: 'c-1',
    localized_text: 'Ne regarde pas en arriere',
    start_ms: 0,
    end_ms: 2000,
    estimated_duration_ms: 1800,
  };

  const valid = validateTtsBatch(state.db, state.versionId, [validTurn], validationOptions());
  assert.equal(valid.ok, true);
  assert.equal(valid.requests[0].voice_id, 'fr-female-1');
  assert.equal(valid.requests[0].character_asset_id, 711);

  const tooLong = validateTtsBatch(state.db, state.versionId, [{ ...validTurn, estimated_duration_ms: 2100 }], validationOptions());
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.issues[0].reason, 'dialogue_duration_exceeded');
  const unknownSpeaker = validateTtsBatch(state.db, state.versionId, [{ ...validTurn, speaker_id: 'c-2' }], validationOptions());
  assert.equal(unknownSpeaker.ok, false);
  assert.equal(unknownSpeaker.issues[0].reason, 'speaker_voice_missing');

  state.db.prepare("UPDATE redraw_versions SET locale = 'en-US' WHERE id = ?").run(state.versionId);
  const localeMismatch = validateTtsBatch(state.db, state.versionId, [validTurn], validationOptions());
  assert.equal(localeMismatch.ok, false);
  assert.equal(localeMismatch.issues[0].reason, 'voice_locale_mismatch');

  state.db.prepare("UPDATE redraw_versions SET locale = 'fr-FR' WHERE id = ?").run(state.versionId);
  const characterRow = state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = 711').get();
  const payload = JSON.parse(characterRow.source_ref_json);
  payload.snapshot.voice_snapshot.terminal_status = 'processing';
  state.db.prepare('UPDATE redraw_assets SET source_ref_json = ? WHERE id = 711').run(JSON.stringify(payload));
  const evidenceInvalid = validateTtsBatch(state.db, state.versionId, [validTurn], validationOptions());
  assert.equal(evidenceInvalid.ok, false);
  assert.equal(evidenceInvalid.issues[0].reason, 'voice_not_verified');
  state.db.close();
});

test('批量 TTS 按 v2 source_character_key 匹配角色音色并兼容 legacy speaker key', () => {
  const state = setup();
  const now = new Date().toISOString();
  addAudioAsset(state.db, 812, 'voice-812.mp3', now);
  addAudioAsset(state.db, 813, 'voice-813.mp3', now);
  addAudioAsset(state.db, 814, 'voice-814.mp3', now);
  const v2Evidence = verifiedVoice(812, 'fr-v2-source-key');
  const legacyIdEvidence = verifiedVoice(813, 'fr-legacy-id');
  const legacyNumberEvidence = verifiedVoice(814, 'fr-legacy-number');
  state.db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     asset_id, voice_asset_id, version_number, approval_status, status, created_at, updated_at)
    VALUES
      (?, ?, 'tenant-a', 'user-a', 'character', ?, 'V2 角色', 1812, 812, 1, 'pending', 'generated', ?, ?),
      (?, ?, 'tenant-a', 'user-a', 'character', ?, 'Legacy ID 角色', 1813, 813, 1, 'pending', 'generated', ?, ?),
      (?, ?, 'tenant-a', 'user-a', 'character', ?, 'Legacy number 角色', 1814, 814, 1, 'pending', 'generated', ?, ?),
      (?, ?, 'tenant-a', 'user-a', 'character', ?, 'Invalid 角色', 1815, 812, 1, 'pending', 'generated', ?, ?)`)
    .run(
      812,
      state.versionId,
      JSON.stringify({
        source_ref: {
          kind: 'character',
          source_character_key: ' c-real ',
          source_ref: { source_character_key: 'c-forged' },
          character_id: 'legacy-wrong',
          id: 'legacy-id-wrong',
        },
        snapshot: { voice_snapshot: v2Evidence },
      }),
      now,
      now,
      813,
      state.versionId,
      JSON.stringify({
        source_ref: { character_id: 'legacy-c-2' },
        snapshot: { voice_snapshot: legacyIdEvidence },
      }),
      now,
      now,
      814,
      state.versionId,
      JSON.stringify({
        source_ref: { id: 3001 },
        snapshot: { voice_snapshot: legacyNumberEvidence },
      }),
      now,
      now,
      815,
      state.versionId,
      JSON.stringify({
        source_ref: {
          kind: 'character',
          source_character_key: { value: 'object-key' },
          character_id: ['array-key'],
          id: true,
        },
        snapshot: { voice_snapshot: v2Evidence },
      }),
      now,
      now,
    );
  const turnBase = {
    localized_text: 'Ne regarde pas en arriere',
    start_ms: 0,
    end_ms: 2000,
    estimated_duration_ms: 1800,
  };

  const validation = validateTtsBatch(state.db, state.versionId, [
    { ...turnBase, speaker_id: 'c-real' },
    { ...turnBase, speaker_id: 'legacy-c-2' },
    { ...turnBase, speaker_id: 3001 },
    { ...turnBase, speaker_id: 'c-forged' },
    { ...turnBase, speaker_id: 'legacy-wrong' },
    { ...turnBase, speaker_id: 'object-key' },
    { ...turnBase, speaker_id: '[object Object]' },
    { ...turnBase, speaker_id: 'array-key' },
    { ...turnBase, speaker_id: 'true' },
    { ...turnBase, speaker_id: { value: 'c-1' } },
    { ...turnBase, speaker_id: ['c-1'] },
    { ...turnBase, speaker_id: true },
  ], validationOptions());

  assert.equal(validation.ok, false);
  assert.equal(validation.requests.length, 0);
  assert.deepEqual(validation.issues.map((issue) => issue.reason), [
    'speaker_voice_missing',
    'speaker_voice_missing',
    'speaker_voice_missing',
    'speaker_voice_missing',
    'speaker_voice_missing',
    'speaker_voice_missing',
    'speaker_voice_missing',
    'speaker_voice_missing',
    'speaker_voice_missing',
  ]);
  assert.deepEqual(validation.issues.map((issue) => issue.turn_index), [3, 4, 5, 6, 7, 8, 9, 10, 11]);

  const ready = validateTtsBatch(state.db, state.versionId, [
    { ...turnBase, speaker_id: 'c-real' },
    { ...turnBase, speaker_id: 'legacy-c-2' },
    { ...turnBase, speaker_id: 3001 },
  ], validationOptions());
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.requests.map((request) => request.voice_id), [
    'fr-v2-source-key',
    'fr-legacy-id',
    'fr-legacy-number',
  ]);
  assert.deepEqual(ready.requests.map((request) => request.character_asset_id), [812, 813, 814]);
  state.db.close();
});

test('缺少授权的克隆音色不进入生产目录且不能绑定角色', () => {
  const state = setup();
  const now = new Date().toISOString();
  addCharacterAsset(state.db, state.versionId, 702, now);
  const clone = { ...verifiedVoice(803, 'fr-clone-1'), is_cloned: true };
  addVoiceEvidence(state.db, state.versionId, 604, clone, now);
  assert.deepEqual(listProductionVoices(state.db, {
    tenantId: 'tenant-a',
    userId: 'user-a',
    locale: 'fr-FR',
    localeRegistry: trustedRegistry(),
  }, () => true), []);
  assert.throws(() => assignVoice(state.db, 702, clone, assignmentOptions(state, 604)), /授权/);
  state.db.close();
});
