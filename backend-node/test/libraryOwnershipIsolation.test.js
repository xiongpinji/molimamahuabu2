'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const createCharacterLibraryRoutes = require('../src/routes/characterLibrary');
const createSceneLibraryRoutes = require('../src/routes/sceneLibrary');
const createPropLibraryRoutes = require('../src/routes/propLibrary');
const { resolveDramaId, OWNERSHIP_SKIP_ROOTS } = require('../src/middleware/resourceOwnership');

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

function request({ params = {}, query = {}, body = {}, userId = 'user-a', tenantId = 'tenant-a', method = 'GET', path: reqPath = '/' } = {}) {
  return {
    params,
    query,
    body,
    method,
    path: reqPath,
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

function insertLibraryItem(db, table, dramaId, name) {
  const now = new Date().toISOString();
  if (table === 'scene_libraries') {
    return Number(db.prepare(`INSERT INTO ${table}
      (drama_id, location, image_url, source_type, created_at, updated_at)
      VALUES (?, ?, ?, 'generated', ?, ?)`)
      .run(dramaId, name, `/static/${name}.png`, now, now).lastInsertRowid);
  }
  return Number(db.prepare(`INSERT INTO ${table}
    (drama_id, name, image_url, source_type, created_at, updated_at)
    VALUES (?, ?, ?, 'generated', ?, ?)`)
    .run(dramaId, name, `/static/${name}.png`, now, now).lastInsertRowid);
}

function call(handler, req) {
  const res = createResponse();
  handler(req, res);
  return res;
}

function itemLabel(item) {
  return item.name || item.location;
}

function runLibraryIsolationSuite(label, createRoutes, table) {
  test(`公开模式${label}必须绑定自有项目，并拒绝跨租户读写`, () => {
    const db = new Database(':memory:');
    try {
      runMigrationsAndEnsure(db);
      const ownDramaId = insertDrama(db, 'tenant-a', 'user-a', '自己的项目');
      const foreignDramaId = insertDrama(db, 'tenant-b', 'user-b', '其他租户项目');
      const ownItemId = insertLibraryItem(db, table, ownDramaId, '自己的库项');
      const foreignItemId = insertLibraryItem(db, table, foreignDramaId, '其他租户库项');
      const globalItemId = insertLibraryItem(db, table, null, '全局库项');
      const routes = createRoutes(db, {}, log, { publicPlatformEnabled: true });

      const unscoped = call(routes.list, request());
      assert.equal(unscoped.statusCode, 400);
      assert.equal(unscoped.body.error.code, 'DRAMA_ID_REQUIRED');

      const foreignList = call(routes.list, request({ query: { drama_id: foreignDramaId } }));
      assert.equal(foreignList.statusCode, 404);

      const ownList = call(routes.list, request({ query: { drama_id: ownDramaId } }));
      assert.equal(ownList.statusCode, 200);
      assert.deepEqual(ownList.body.data.items.map(itemLabel), ['自己的库项']);

      const globalList = call(routes.list, request({ query: { global: 1 } }));
      assert.equal(globalList.statusCode, 200);
      assert.ok(globalList.body.data.items.some((item) => itemLabel(item) === '全局库项'));

      assert.equal(call(routes.get, request({ params: { id: foreignItemId } })).statusCode, 404);
      assert.equal(call(routes.get, request({ params: { id: ownItemId } })).statusCode, 200);
      assert.equal(call(routes.get, request({ params: { id: globalItemId } })).statusCode, 200);

      const createBody = table === 'scene_libraries'
        ? { drama_id: ownDramaId, location: '合法创建', image_url: '/static/y.png' }
        : { drama_id: ownDramaId, name: '合法创建', image_url: '/static/y.png' };
      const foreignCreateBody = table === 'scene_libraries'
        ? { drama_id: foreignDramaId, location: '越权创建', image_url: '/static/x.png' }
        : { drama_id: foreignDramaId, name: '越权创建', image_url: '/static/x.png' };

      assert.equal(call(routes.create, request({ body: foreignCreateBody })).statusCode, 404);
      assert.equal(call(routes.create, request({ body: createBody })).statusCode, 201);

      assert.equal(call(routes.update, request({
        params: { id: foreignItemId },
        body: table === 'scene_libraries' ? { location: '改别人的' } : { name: '改别人的' },
      })).statusCode, 404);
      assert.equal(call(routes.delete, request({ params: { id: foreignItemId } })).statusCode, 404);
      assert.equal(call(routes.update, request({
        params: { id: globalItemId },
        body: table === 'scene_libraries' ? { location: '改全局' } : { name: '改全局' },
      })).statusCode, 403);
      assert.equal(call(routes.delete, request({ params: { id: globalItemId } })).statusCode, 403);
      const globalRow = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(globalItemId);
      assert.equal(itemLabel(globalRow), '全局库项');
    } finally {
      db.close();
    }
  });
}

runLibraryIsolationSuite('角色库', createCharacterLibraryRoutes, 'character_libraries');
runLibraryIsolationSuite('场景库', createSceneLibraryRoutes, 'scene_libraries');
runLibraryIsolationSuite('道具库', createPropLibraryRoutes, 'prop_libraries');

test('全局设置写操作路由要求管理员门禁', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/index.js'), 'utf8');
  for (const route of [
    "r.put('/settings/generation'",
    "r.put('/settings/prompts/:key'",
    "r.delete('/settings/prompts/:key'",
    "r.post('/scene-model-map'",
    "r.put('/scene-model-map/:key'",
    "r.delete('/scene-model-map/:key'",
  ]) {
    const line = source.split(/\r?\n/).find((item) => item.includes(route));
    assert.ok(line, `缺少路由 ${route}`);
    assert.match(line, /requireAdmin/);
  }
  const readLines = [
    "r.get('/settings/generation'",
    "r.get('/settings/prompts'",
    "r.get('/scene-model-map'",
  ];
  for (const route of readLines) {
    const line = source.split(/\r?\n/).find((item) => item.includes(route));
    assert.ok(line, `缺少路由 ${route}`);
    assert.doesNotMatch(line, /requireAdmin/);
  }
});

test('素材库路径纳入归属解析，未知写前缀默认拒绝', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const dramaId = insertDrama(db, 'tenant-a', 'user-a', '项目');
    const itemId = insertLibraryItem(db, 'character_libraries', dramaId, '库项');

    const byId = resolveDramaId(db, request({
      path: `/character-library/${itemId}`,
      method: 'GET',
    }));
    assert.equal(byId.dramaId, dramaId);

    const create = resolveDramaId(db, request({
      path: '/character-library',
      method: 'POST',
      body: { drama_id: dramaId },
    }));
    assert.equal(create.dramaId, dramaId);

    assert.ok(OWNERSHIP_SKIP_ROOTS.has('billing'));
    assert.ok(OWNERSHIP_SKIP_ROOTS.has('settings'));

    const unknownWrite = resolveDramaId(db, request({
      path: '/brand-new-unmapped-write',
      method: 'POST',
      body: {},
    }));
    assert.equal(unknownWrite.skip, undefined);
    assert.equal(unknownWrite.dramaId, null);

    const unknownRead = resolveDramaId(db, request({
      path: '/brand-new-unmapped-read',
      method: 'GET',
    }));
    assert.equal(unknownRead.skip, true);
  } finally {
    db.close();
  }
});
