const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
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
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     voice_asset_id, version_number, approval_status, status, created_at, updated_at)
    VALUES (?, ?, 'tenant-a', 'user-a', 'voice', ?, ?, ?, 1, 'pending', ?, ?, ?)`).run(
    id,
    versionId,
    JSON.stringify({ source_ref: { voice_id: evidence.voice_id }, snapshot: { evidence } }),
    evidence.voice_id,
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
