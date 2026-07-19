const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const assetService = require('../src/services/assetService');
const voiceCatalogService = require('../src/services/builtinVoiceCatalogService');

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const dramaId = db.prepare(
    `INSERT INTO dramas (title, status, created_at, updated_at) VALUES ('音频库测试', 'draft', ?, ?)`
  ).run(now, now).lastInsertRowid;
  const characterId = db.prepare(
    `INSERT INTO characters (drama_id, name, created_at, updated_at) VALUES (?, '小狐狸', ?, ?)`
  ).run(dramaId, now, now).lastInsertRowid;
  return { db, dramaId, characterId };
}

describe('voice library assets', () => {
  it('lists extracted voice assets and binds one back to a character', () => {
    const { db, dramaId, characterId } = createDb();
    try {
      const item = assetService.saveExtractedVoice(db, null, {
        dramaId,
        characterId,
        characterName: '小狐狸',
        storyboardId: 12,
        videoId: 34,
        voiceAsset: {
          url: '/static/projects/demo/voice.mp3',
          local_path: 'projects/demo/voice.mp3',
          duration: 2.4,
          format: 'mp3',
          source: 'storyboard_video',
        },
      });
      assert.equal(item.type, 'audio');
      assert.equal(item.metadata.character_name, '小狐狸');

      const catalog = voiceCatalogService.listProjectVoiceAssets(db, dramaId);
      assert.equal(catalog.length, 1);
      assert.equal(catalog[0].id, `asset-${item.id}`);
      assert.equal(catalog[0].can_bind, true);

      const bound = voiceCatalogService.bindBuiltinVoice({
        db,
        characterId,
        voiceId: catalog[0].id,
      });
      assert.equal(bound.ok, true, bound.error);
      const saved = JSON.parse(db.prepare('SELECT seedance2_voice_asset FROM characters WHERE id = ?').get(characterId).seedance2_voice_asset);
      assert.equal(saved.source, 'audio_library');
      assert.equal(saved.source_asset_id, item.id);
      assert.equal(saved.url, '/static/projects/demo/voice.mp3');
    } finally {
      db.close();
    }
  });
});
