const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const createAssetRoutes = require('../src/routes/assets');

const log = { info() {}, warn() {}, error() {} };

function createResponse() {
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

function request({ params = {}, query = {}, body = {}, userId = 'user-a', tenantId = 'tenant-a' } = {}) {
  return {
    params,
    query,
    body,
    user: { id: userId },
    tenant: { id: tenantId },
  };
}

function insertDrama(db, tenantId, userId, title) {
  const now = new Date().toISOString();
  return Number(db.prepare(`INSERT INTO dramas
    (tenant_id, user_id, title, status, created_at, updated_at)
    VALUES (?, ?, ?, 'draft', ?, ?)`)
    .run(tenantId, userId, title, now, now).lastInsertRowid);
}

function insertStoryboard(db, dramaId, title) {
  const now = new Date().toISOString();
  const episodeId = Number(db.prepare(`INSERT INTO episodes
    (drama_id, episode_number, title, status, created_at, updated_at)
    VALUES (?, 1, ?, 'draft', ?, ?)`).run(dramaId, title, now, now).lastInsertRowid);
  return Number(db.prepare(`INSERT INTO storyboards
    (episode_id, storyboard_number, title, status, created_at, updated_at)
    VALUES (?, 1, ?, 'draft', ?, ?)`).run(episodeId, title, now, now).lastInsertRowid);
}

function insertAsset(db, dramaId, name, metadata = null) {
  const now = new Date().toISOString();
  return Number(db.prepare(`INSERT INTO assets
    (drama_id, name, type, url, metadata, created_at, updated_at)
    VALUES (?, ?, 'image', ?, ?, ?, ?)`)
    .run(dramaId, name, `/static/${name}.png`, metadata == null ? null : JSON.stringify(metadata), now, now)
    .lastInsertRowid);
}

function insertImageGeneration(db, dramaId, name) {
  const now = new Date().toISOString();
  return Number(db.prepare(`INSERT INTO image_generations
    (drama_id, prompt, image_url, status, created_at, updated_at)
    VALUES (?, ?, ?, 'completed', ?, ?)`)
    .run(dramaId, name, `/static/${name}.png`, now, now).lastInsertRowid);
}

function insertVideoGeneration(db, dramaId, name) {
  const now = new Date().toISOString();
  return Number(db.prepare(`INSERT INTO video_generations
    (drama_id, prompt, video_url, status, created_at, updated_at)
    VALUES (?, ?, ?, 'completed', ?, ?)`)
    .run(dramaId, name, `/static/${name}.mp4`, now, now).lastInsertRowid);
}

function call(handler, req) {
  const res = createResponse();
  handler(req, res);
  return res;
}

test('公开模式素材列表必须绑定自有项目，且仅显式系统共享素材可跨项目复用', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const ownDramaId = insertDrama(db, 'tenant-a', 'user-a', '自己的项目');
    const foreignDramaId = insertDrama(db, 'tenant-b', 'user-b', '其他租户项目');
    insertAsset(db, ownDramaId, '自己的素材');
    insertAsset(db, foreignDramaId, '其他租户素材');
    insertAsset(db, null, '历史无归属素材');
    insertAsset(db, null, '系统共享素材', { system_shared: true });
    const routes = createAssetRoutes(db, log, { publicPlatformEnabled: true });

    const unscoped = call(routes.list, request());
    assert.equal(unscoped.statusCode, 400);
    assert.equal(unscoped.body.error.code, 'DRAMA_ID_REQUIRED');

    const foreign = call(routes.list, request({ query: { drama_id: foreignDramaId } }));
    assert.equal(foreign.statusCode, 404);

    const own = call(routes.list, request({
      query: { drama_id: ownDramaId, include_global: 1, page_size: 100 },
    }));
    assert.equal(own.statusCode, 200);
    assert.deepEqual(
      own.body.data.items.map((item) => item.name).sort(),
      ['自己的素材', '系统共享素材'].sort(),
    );
  } finally {
    db.close();
  }
});

test('公开模式素材写操作、详情和生成记录导入均拒绝跨租户项目', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const ownDramaId = insertDrama(db, 'tenant-a', 'user-a', '自己的项目');
    const foreignDramaId = insertDrama(db, 'tenant-b', 'user-b', '其他租户项目');
    const ownStoryboardId = insertStoryboard(db, ownDramaId, '自己的分镜');
    const foreignStoryboardId = insertStoryboard(db, foreignDramaId, '其他租户分镜');
    const ownAssetId = insertAsset(db, ownDramaId, '自己的素材');
    const foreignAssetId = insertAsset(db, foreignDramaId, '其他租户素材');
    const ownImageId = insertImageGeneration(db, ownDramaId, 'own-image');
    const foreignImageId = insertImageGeneration(db, foreignDramaId, 'foreign-image');
    const ownVideoId = insertVideoGeneration(db, ownDramaId, 'own-video');
    const foreignVideoId = insertVideoGeneration(db, foreignDramaId, 'foreign-video');
    const routes = createAssetRoutes(db, log, { publicPlatformEnabled: true });

    assert.equal(call(routes.create, request({
      body: { drama_id: ownDramaId, storyboard_id: ownStoryboardId, name: '新素材', type: 'image' },
    })).statusCode, 201);
    assert.equal(call(routes.create, request({
      body: { drama_id: foreignDramaId, name: '越权素材', type: 'image' },
    })).statusCode, 404);
    assert.equal(call(routes.get, request({ params: { id: foreignAssetId } })).statusCode, 404);
    assert.equal(call(routes.get, request({ params: { id: 999999 } })).statusCode, 404);
    assert.equal(call(routes.delete, request({ params: { id: foreignAssetId } })).statusCode, 404);

    assert.equal(call(routes.update, request({
      params: { id: ownAssetId },
      body: { drama_id: foreignDramaId },
    })).statusCode, 404);
    assert.equal(db.prepare('SELECT drama_id FROM assets WHERE id = ?').get(ownAssetId).drama_id, ownDramaId);

    assert.equal(call(routes.update, request({
      params: { id: ownAssetId },
      body: { storyboard_id: foreignStoryboardId },
    })).statusCode, 404);
    assert.equal(call(routes.get, request({ params: { id: ownAssetId } })).statusCode, 200);

    assert.equal(call(routes.importImage, request({ params: { image_gen_id: ownImageId } })).statusCode, 201);
    assert.equal(call(routes.importImage, request({ params: { image_gen_id: foreignImageId } })).statusCode, 404);
    assert.equal(call(routes.importVideo, request({ params: { video_gen_id: ownVideoId } })).statusCode, 201);
    assert.equal(call(routes.importVideo, request({ params: { video_gen_id: foreignVideoId } })).statusCode, 404);
  } finally {
    db.close();
  }
});

test('本地非公开模式保留无项目素材查询和创建兼容性', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const dramaA = insertDrama(db, null, null, '本地项目 A');
    const dramaB = insertDrama(db, null, null, '本地项目 B');
    insertAsset(db, dramaA, '素材 A');
    insertAsset(db, dramaB, '素材 B');
    const routes = createAssetRoutes(db, log);

    const list = call(routes.list, request());
    assert.equal(list.statusCode, 200);
    assert.equal(list.body.data.pagination.total, 2);

    const created = call(routes.create, request({
      body: { name: '本地无项目素材', type: 'image', url: '/static/local.png' },
    }));
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.data.drama_id, null);
  } finally {
    db.close();
  }
});
