const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const assetRoutes = require('../src/routes/assets');

const log = { info() {}, warn() {}, error() {} };

function captureResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('画布素材通过真实资产接口绑定分镜并在数据库重开后恢复', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-canvas-asset-'));
  const dbPath = path.join(tempRoot, 'canvas-asset.db');
  let db = new Database(dbPath);

  try {
    runMigrationsAndEnsure(db);
    const now = new Date().toISOString();
    const dramaId = db.prepare(
      `INSERT INTO dramas (title, status, created_at, updated_at)
       VALUES (?, 'draft', ?, ?)`,
    ).run('画布素材闭环', now, now).lastInsertRowid;
    const episodeId = db.prepare(
      `INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?)`,
    ).run(dramaId, '第1集', now, now).lastInsertRowid;
    const storyboardId = db.prepare(
      `INSERT INTO storyboards (episode_id, storyboard_number, title, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?)`,
    ).run(episodeId, '雨夜相遇', now, now).lastInsertRowid;
    const handlers = assetRoutes(db, log);

    const createdResponse = captureResponse();
    handlers.create({
      body: {
        drama_id: dramaId,
        name: '雨夜站台参考',
        type: 'image',
        category: 'canvas-library-pick',
        url: '/static/library-rain-station.png',
        metadata: {
          source: 'canvas_asset_picker',
          picker_source: 'scene',
          source_asset_id: 77,
        },
      },
    }, createdResponse);

    assert.equal(createdResponse.statusCode, 201);
    assert.equal(createdResponse.body.success, true);
    const assetId = createdResponse.body.data.id;
    assert.equal(assetId > 0, true);

    const updatedResponse = captureResponse();
    handlers.update({
      params: { id: assetId },
      body: {
        drama_id: dramaId,
        storyboard_id: storyboardId,
      },
    }, updatedResponse);

    assert.equal(updatedResponse.statusCode, 200);
    assert.equal(updatedResponse.body.data.storyboard_id, storyboardId);
    assert.equal(updatedResponse.body.data.metadata.picker_source, 'scene');

    db.close();
    db = new Database(dbPath, { readonly: true });
    const restoredHandlers = assetRoutes(db, log);
    const listResponse = captureResponse();
    restoredHandlers.list({
      query: {
        drama_id: String(dramaId),
        storyboard_id: String(storyboardId),
        page: 1,
        page_size: 100,
      },
    }, listResponse);

    assert.equal(listResponse.statusCode, 200);
    assert.equal(listResponse.body.success, true);
    assert.equal(listResponse.body.data.pagination.total, 1);
    assert.equal(listResponse.body.data.items.length, 1);
    const restoredAsset = listResponse.body.data.items[0];
    assert.equal(restoredAsset.id, assetId);
    assert.equal(restoredAsset.drama_id, dramaId);
    assert.equal(restoredAsset.storyboard_id, storyboardId);
    assert.equal(restoredAsset.name, '雨夜站台参考');
    assert.equal(restoredAsset.category, 'canvas-library-pick');
    assert.equal(restoredAsset.url, '/static/library-rain-station.png');
    assert.deepEqual(restoredAsset.metadata, {
      source: 'canvas_asset_picker',
      picker_source: 'scene',
      source_asset_id: 77,
    });
  } finally {
    if (db.open) db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
