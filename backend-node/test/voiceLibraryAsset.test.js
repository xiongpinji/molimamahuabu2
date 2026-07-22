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

  it('filters reusable voice assets by category and keyword', () => {
    const { db, dramaId } = createDb();
    try {
      const voice = assetService.saveExtractedVoice(db, null, {
        dramaId,
        characterId: 1,
        characterName: '小狐狸',
        storyboardId: 12,
        videoId: 34,
        voiceAsset: {
          url: '/static/projects/demo/fox.mp3',
          local_path: 'projects/demo/fox.mp3',
          duration: 2.4,
          format: 'mp3',
        },
      });
      assetService.create(db, null, {
        drama_id: dramaId,
        name: '环境雨声',
        type: 'audio',
        category: 'sfx',
        url: '/static/projects/demo/rain.mp3',
      });

      const result = assetService.list(db, {
        drama_id: dramaId,
        type: 'audio',
        category: 'voice',
        keyword: '小狐狸',
        page: 1,
        page_size: 20,
      });

      assert.equal(result.total, 1);
      assert.equal(result.items[0].id, voice.id);
      assert.equal(result.items[0].metadata.character_name, '小狐狸');
    } finally {
      db.close();
    }
  });

  it('can include global assets when listing project-scoped reusable assets', () => {
    const { db, dramaId } = createDb();
    try {
      const projectAsset = assetService.create(db, null, {
        drama_id: dramaId,
        name: '本剧参考图',
        type: 'image',
        url: '/static/projects/demo/project.png',
      });
      const globalAsset = assetService.create(db, null, {
        drama_id: null,
        name: '全局参考图',
        type: 'image',
        url: '/static/projects/demo/global.png',
      });
      assetService.create(db, null, {
        drama_id: null,
        name: '全局音频',
        type: 'audio',
        url: '/static/projects/demo/global.mp3',
      });

      const scopedOnly = assetService.list(db, {
        drama_id: dramaId,
        type: 'image',
        page: 1,
        page_size: 20,
      });
      assert.deepEqual(scopedOnly.items.map((item) => item.id), [projectAsset.id]);

      const withGlobal = assetService.list(db, {
        drama_id: dramaId,
        include_global: '1',
        type: 'image',
        page: 1,
        page_size: 20,
      });
      assert.deepEqual(new Set(withGlobal.items.map((item) => item.id)), new Set([projectAsset.id, globalAsset.id]));
    } finally {
      db.close();
    }
  });
});
