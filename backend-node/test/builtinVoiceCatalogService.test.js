const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const service = require('../src/services/builtinVoiceCatalogService');

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at) VALUES ('音色目录测试', 'draft', ?, ?)`
  ).run(now, now).lastInsertRowid;
  const characterId = db.prepare(
    `INSERT INTO characters (drama_id, name, created_at, updated_at) VALUES (?, '小岚', ?, ?)`
  ).run(dramaId, now, now).lastInsertRowid;
  return { db, dramaId, characterId };
}

describe('builtinVoiceCatalogService', () => {
  it('lists MeloTTS catalog metadata without treating remote samples as local assets', () => {
    const voices = service.listBuiltinVoices({ storage: { local_path: fs.mkdtempSync(path.join(os.tmpdir(), 'voice-catalog-')) } });
    assert.equal(voices.length, 5);
    assert.equal(voices.every((voice) => voice.engine === 'melotts'), true);
    assert.equal(voices.every((voice) => voice.license === 'MIT'), true);
    assert.equal(voices.every((voice) => voice.can_bind === false), true);
  });

  it('binds only a generated local sample and records its provenance', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-catalog-'));
    const voiceDir = path.join(root, 'library', 'voices', 'melotts');
    fs.mkdirSync(voiceDir, { recursive: true });
    fs.writeFileSync(path.join(voiceDir, 'melotts-zh.wav'), Buffer.from('wav-fixture'));
    const { db, characterId } = createDb();
    try {
      const result = service.bindBuiltinVoice({
        db,
        cfg: { storage: { local_path: root } },
        characterId,
        voiceId: 'melotts-zh',
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.asset.source, 'builtin_melotts');
    assert.equal(result.asset.voice_id, 'ZH');
    assert.equal(result.asset.license, 'MIT');
    assert.equal(service.getBuiltinVoice('melotts-zh', { storage: { local_path: root } }).preview_url, '/api/v1/voice-catalog/melotts-zh/preview');
      assert.equal(fs.existsSync(path.join(root, result.asset.local_path)), true);
      const saved = JSON.parse(db.prepare('SELECT seedance2_voice_asset FROM characters WHERE id = ?').get(characterId).seedance2_voice_asset);
      assert.equal(saved.url, result.asset.url);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects binding when the local sample has not been generated', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-catalog-'));
    const { db, characterId } = createDb();
    try {
      const result = service.bindBuiltinVoice({
        db,
        cfg: { storage: { local_path: root } },
        characterId,
        voiceId: 'melotts-zh',
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'BUILTIN_VOICE_NOT_READY');
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists extracted project voices with reusable media paths', () => {
    const { db, dramaId } = createDb();
    try {
      db.prepare(
        `INSERT INTO assets (drama_id, name, type, category, url, local_path, metadata, created_at, updated_at)
         VALUES (?, '小岚 · 提取音色', 'audio', 'voice', '', 'project/voices/xiaolan.wav', ?, ?, ?)`
      ).run(
        dramaId,
        JSON.stringify({
          character_name: '小岚',
          storyboard_id: 12,
          voice_asset: {
            duration: 3,
            quality_status: 'requires_preview_confirmation',
            quality_notice: '测试质量提示',
            speaker_diarization: false,
            source_audio_kind: 'mixed_video_track',
          },
        }),
        new Date().toISOString(),
        new Date().toISOString()
      );
      const voices = service.listProjectVoiceAssets(db, dramaId);
      assert.equal(voices.length, 1);
      assert.equal(voices[0].source, 'extracted_voice_asset');
      assert.equal(voices[0].local_path, 'project/voices/xiaolan.wav');
      assert.equal(voices[0].voice_local_path, 'project/voices/xiaolan.wav');
      assert.equal(voices[0].preview_url, '/static/project/voices/xiaolan.wav');
      assert.equal(voices[0].quality_status, 'requires_preview_confirmation');
      assert.equal(voices[0].quality_notice, '测试质量提示');
      assert.equal(voices[0].speaker_diarization, false);
      assert.equal(voices[0].source_audio_kind, 'mixed_video_track');
      assert.match(voices[0].description, /测试质量提示/);
    } finally {
      db.close();
    }
  });

  it('marks historical extracted voices as requiring preview confirmation', () => {
    const { db, dramaId } = createDb();
    try {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO assets (drama_id, name, type, category, url, metadata, created_at, updated_at)
         VALUES (?, '旧音色', 'audio', 'voice', '/static/legacy.mp3', ?, ?, ?)`
      ).run(dramaId, JSON.stringify({ character_name: '小岚', storyboard_id: 1 }), now, now);

      const [voice] = service.listProjectVoiceAssets(db, dramaId);
      assert.equal(voice.quality_status, 'requires_preview_confirmation');
      assert.equal(voice.speaker_diarization, false);
      assert.match(voice.quality_notice, /不是真实说话人分离/);
      assert.match(voice.description, /请试听确认/);
    } finally {
      db.close();
    }
  });
});
