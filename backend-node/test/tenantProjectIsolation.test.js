const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { createResourceOwnershipMiddleware } = require('../src/middleware/resourceOwnership');

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test('项目授权按当前租户隔离且允许同租户成员协作', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO tenants (id, name, slug, status, created_by, created_at, updated_at)
    VALUES ('tenant-a', 'A', 'tenant-a', 'active', 'user-1', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO tenant_members (tenant_id, user_id, role, status, created_at, updated_at)
    VALUES ('tenant-a', 'user-1', 'owner', 'active', ?, ?), ('tenant-a', 'user-2', 'member', 'active', ?, ?)`)
    .run(now, now, now, now);
  const dramaId = db.prepare(`INSERT INTO dramas
    (tenant_id, user_id, title, status, created_at, updated_at)
    VALUES ('tenant-a', 'user-1', 'Shared', 'draft', ?, ?)`).run(now, now).lastInsertRowid;
  const middleware = createResourceOwnershipMiddleware({ db, enabled: true });

  const collaborator = response();
  let collaboratorCalled = false;
  middleware({
    path: `/dramas/${dramaId}`,
    user: { id: 'user-2' },
    tenant: { id: 'tenant-a', role: 'member' },
    body: {},
    query: {},
  }, collaborator, () => { collaboratorCalled = true; });
  assert.equal(collaboratorCalled, true);

  const foreign = response();
  middleware({
    path: `/dramas/${dramaId}`,
    user: { id: 'user-1' },
    tenant: { id: 'tenant-b', role: 'owner' },
    body: {},
    query: {},
  }, foreign, () => {});
  assert.equal(foreign.statusCode, 404);
});

test('批量角色与场景生图不能绕过当前租户项目隔离', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const ownDrama = db.prepare(`INSERT INTO dramas
    (tenant_id, user_id, title, status, created_at, updated_at)
    VALUES ('tenant-a', 'user-1', 'Own', 'draft', ?, ?)`).run(now, now).lastInsertRowid;
  const otherDrama = db.prepare(`INSERT INTO dramas
    (tenant_id, user_id, title, status, created_at, updated_at)
    VALUES ('tenant-b', 'user-2', 'Other', 'draft', ?, ?)`).run(now, now).lastInsertRowid;
  const ownCharacter = db.prepare(`INSERT INTO characters
    (drama_id, name, created_at, updated_at) VALUES (?, 'Own role', ?, ?)`).run(ownDrama, now, now).lastInsertRowid;
  const otherCharacter = db.prepare(`INSERT INTO characters
    (drama_id, name, created_at, updated_at) VALUES (?, 'Other role', ?, ?)`).run(otherDrama, now, now).lastInsertRowid;
  const otherScene = db.prepare(`INSERT INTO scenes
    (drama_id, location, created_at, updated_at) VALUES (?, 'Other scene', ?, ?)`).run(otherDrama, now, now).lastInsertRowid;
  const middleware = createResourceOwnershipMiddleware({ db, enabled: true });

  const batch = response();
  let batchCalled = false;
  middleware({
    path: '/characters/batch-generate-images',
    user: { id: 'user-1' },
    tenant: { id: 'tenant-a', role: 'owner' },
    body: { character_ids: [ownCharacter, otherCharacter] },
    query: {},
  }, batch, () => { batchCalled = true; });
  assert.equal(batchCalled, false);
  assert.equal(batch.statusCode, 404);

  const scene = response();
  let sceneCalled = false;
  middleware({
    path: '/scenes/generate-image',
    user: { id: 'user-1' },
    tenant: { id: 'tenant-a', role: 'owner' },
    body: { scene_id: otherScene },
    query: {},
  }, scene, () => { sceneCalled = true; });
  assert.equal(sceneCalled, false);
  assert.equal(scene.statusCode, 404);
});
