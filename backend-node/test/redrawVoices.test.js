const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  assignVoice,
  listProductionVoices,
  validateTtsBatch,
} = require('../src/services/redrawVoiceService');

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
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

function addVoiceEvidence(db, versionId, id, evidence, now) {
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     asset_id, version_number, approval_status, status, created_at, updated_at)
    VALUES (?, ?, 'tenant-a', 'user-a', 'voice', ?, ?, ?, 1, 'pending', 'generated', ?, ?)`).run(
    id,
    versionId,
    JSON.stringify({ source_ref: { voice_id: evidence.voice_id }, evidence }),
    evidence.voice_id,
    evidence.audio_asset_id,
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
    locale: 'fr-FR',
    market: 'FR',
    provider: 'verified-tts',
    model: 'voice-model-1',
    voice_id: voiceId,
    task_id: `tts-${voiceId}`,
    terminal_status: 'completed',
    audio_asset_id: audioAssetId,
    duration_ms: 1200,
    real_generation_verified: true,
    language_verified: true,
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
  addAudioAsset(state.db, 502, 'verified.mp3', now);
  addAudioAsset(state.db, 503, 'missing.mp3', now);
  addVoiceEvidence(state.db, state.versionId, 602, verifiedVoice(502), now);
  addVoiceEvidence(state.db, state.versionId, 603, verifiedVoice(503, 'en-male-1'), now);

  const canReadAudio = (asset) => fs.existsSync(path.join(root, asset.local_path));
  assert.deepEqual(listProductionVoices(state.db, {
    locale: 'fr-FR', market: 'FR', tenantId: 'tenant-b', userId: 'user-b',
  }, canReadAudio), []);
  const voices = listProductionVoices(state.db, {
    locale: 'fr-FR', market: 'FR', tenantId: 'tenant-a', userId: 'user-a',
  }, canReadAudio);
  assert.equal(voices.length, 1);
  assert.equal(voices[0].voice_id, 'fr-female-1');
  assert.equal(voices[0].audio_asset_id, 502);
  fs.rmSync(root, { recursive: true, force: true });
  state.db.close();
});

test('角色在同一本地化版本固定音色快照', () => {
  const state = setup();
  const now = new Date().toISOString();
  addAudioAsset(state.db, 801, 'voice-801.mp3', now);
  addAudioAsset(state.db, 802, 'voice-802.mp3', now);
  addCharacterAsset(state.db, state.versionId, 701, now);
  const selected = assignVoice(state.db, 701, verifiedVoice(801));
  assert.equal(selected.conflict, false);
  assert.equal(selected.snapshot.voice_id, 'fr-female-1');
  assert.equal(state.db.prepare('SELECT voice_asset_id FROM redraw_assets WHERE id = 701').get().voice_asset_id, 801);
  assert.equal(state.db.prepare('SELECT approval_status FROM redraw_assets WHERE id = 701').get().approval_status, 'pending');
  assert.equal(assignVoice(state.db, 701, verifiedVoice(802, 'fr-male-1')).conflict, true);
  assert.equal(assignVoice(state.db, 701, verifiedVoice(801)).conflict, false);
  state.db.close();
});

test('批量 TTS 前重新检查语言、说话人和台词时长', () => {
  const state = setup();
  const now = new Date().toISOString();
  addAudioAsset(state.db, 811, 'voice-811.mp3', now);
  addCharacterAsset(state.db, state.versionId, 711, now);
  assignVoice(state.db, 711, verifiedVoice(811));
  const validTurn = {
    speaker_id: 'c-1',
    localized_text: 'Ne regarde pas en arriere',
    start_ms: 0,
    end_ms: 2000,
    estimated_duration_ms: 1800,
  };

  const valid = validateTtsBatch(state.db, state.versionId, [validTurn]);
  assert.equal(valid.ok, true);
  assert.equal(valid.requests[0].voice_id, 'fr-female-1');
  assert.equal(valid.requests[0].character_asset_id, 711);

  const tooLong = validateTtsBatch(state.db, state.versionId, [{ ...validTurn, estimated_duration_ms: 2100 }]);
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.issues[0].reason, 'dialogue_duration_exceeded');
  const unknownSpeaker = validateTtsBatch(state.db, state.versionId, [{ ...validTurn, speaker_id: 'c-2' }]);
  assert.equal(unknownSpeaker.ok, false);
  assert.equal(unknownSpeaker.issues[0].reason, 'speaker_voice_missing');

  state.db.prepare("UPDATE redraw_versions SET locale = 'en-US' WHERE id = ?").run(state.versionId);
  const localeMismatch = validateTtsBatch(state.db, state.versionId, [validTurn]);
  assert.equal(localeMismatch.ok, false);
  assert.equal(localeMismatch.issues[0].reason, 'voice_locale_mismatch');

  state.db.prepare("UPDATE redraw_versions SET locale = 'fr-FR' WHERE id = ?").run(state.versionId);
  const characterRow = state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = 711').get();
  const payload = JSON.parse(characterRow.source_ref_json);
  payload.snapshot.voice_snapshot.terminal_status = 'processing';
  state.db.prepare('UPDATE redraw_assets SET source_ref_json = ? WHERE id = 711').run(JSON.stringify(payload));
  const evidenceInvalid = validateTtsBatch(state.db, state.versionId, [validTurn]);
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
  assert.deepEqual(listProductionVoices(state.db, { locale: 'fr-FR' }, () => true), []);
  assert.throws(() => assignVoice(state.db, 702, clone), /授权/);
  state.db.close();
});
