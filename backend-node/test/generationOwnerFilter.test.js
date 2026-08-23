const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const imageService = require('../src/services/imageService');
const videoService = require('../src/services/videoService');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

function setup(options = {}) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  const otherUserId = options.sameUserAcrossTenants ? 'user-1' : 'user-2';
  const image = db.prepare(`
    INSERT INTO image_generations (drama_id, model, status, user_id, tenant_id, created_at, updated_at)
    VALUES (?, ?, 'completed', ?, ?, ?, ?)
  `).run(1, 'gpt-image-2', 'user-1', 'tenant-a', now, now);
  const imageOther = db.prepare(`
    INSERT INTO image_generations (drama_id, model, status, user_id, tenant_id, created_at, updated_at)
    VALUES (?, ?, 'completed', ?, ?, ?, ?)
  `).run(1, 'gpt-image-2', otherUserId, 'tenant-b', now, now);
  const video = db.prepare(`
    INSERT INTO video_generations (drama_id, model, status, user_id, tenant_id, created_at, updated_at)
    VALUES (?, ?, 'completed', ?, ?, ?, ?)
  `).run(1, 'seedance 2.0', 'user-1', 'tenant-a', now, now);
  const videoOther = db.prepare(`
    INSERT INTO video_generations (drama_id, model, status, user_id, tenant_id, created_at, updated_at)
    VALUES (?, ?, 'completed', ?, ?, ?, ?)
  `).run(1, 'seedance 2.0', otherUserId, 'tenant-b', now, now);
  return { db, imageId: image.lastInsertRowid, imageOtherId: imageOther.lastInsertRowid, videoId: video.lastInsertRowid, videoOtherId: videoOther.lastInsertRowid };
}

test('公开模式图片生成记录只允许当前用户读取和删除', () => {
  const { db, imageId, imageOtherId } = setup();
  const own = imageService.list(db, {}, { billingEnabled: true, userId: 'user-1' });
  assert.equal(own.total, 1);
  assert.equal(own.items[0].id, imageId);
  assert.equal(imageService.getById(db, imageOtherId, { billingEnabled: true, userId: 'user-1' }), null);
  assert.equal(imageService.deleteById(db, {}, imageOtherId, { billingEnabled: true, userId: 'user-1' }), false);
  assert.equal(db.prepare('SELECT deleted_at FROM image_generations WHERE id = ?').get(imageOtherId).deleted_at, null);
  assert.equal(imageService.deleteById(db, {}, imageId, { billingEnabled: true, userId: 'user-1' }), true);
});

test('公开模式视频生成记录只允许当前用户读取和删除', () => {
  const { db, videoId, videoOtherId } = setup();
  const own = videoService.list(db, {}, { billingEnabled: true, userId: 'user-1' });
  assert.equal(own.total, 1);
  assert.equal(own.items[0].id, videoId);
  assert.equal(videoService.getById(db, videoOtherId, { billingEnabled: true, userId: 'user-1' }), null);
  assert.equal(videoService.deleteById(db, {}, videoOtherId, { billingEnabled: true, userId: 'user-1' }), false);
  assert.equal(db.prepare('SELECT deleted_at FROM video_generations WHERE id = ?').get(videoOtherId).deleted_at, null);
  assert.equal(videoService.deleteById(db, {}, videoId, { billingEnabled: true, userId: 'user-1' }), true);
});

test('租户 A 图片生成记录不能列出读取或删除租户 B 资源且可读取本租户资源', () => {
  const { db, imageId, imageOtherId } = setup({ sameUserAcrossTenants: true });
  const tenantA = { billingEnabled: true, userId: 'user-1', tenantId: 'tenant-a' };
  const own = imageService.list(db, {}, tenantA);
  assert.equal(own.total, 1);
  assert.equal(own.items[0].id, imageId);
  assert.equal(imageService.getById(db, imageId, tenantA).id, imageId);
  assert.equal(imageService.getById(db, imageOtherId, tenantA), null);
  assert.equal(imageService.deleteById(db, {}, imageOtherId, tenantA), false);
  assert.equal(db.prepare('SELECT deleted_at FROM image_generations WHERE id = ?').get(imageOtherId).deleted_at, null);
});

test('租户 A 视频生成记录不能列出读取或删除租户 B 资源且可读取本租户资源', () => {
  const { db, videoId, videoOtherId } = setup({ sameUserAcrossTenants: true });
  const tenantA = { billingEnabled: true, userId: 'user-1', tenantId: 'tenant-a' };
  const own = videoService.list(db, {}, tenantA);
  assert.equal(own.total, 1);
  assert.equal(own.items[0].id, videoId);
  assert.equal(videoService.getById(db, videoId, tenantA).id, videoId);
  assert.equal(videoService.getById(db, videoOtherId, tenantA), null);
  assert.equal(videoService.deleteById(db, {}, videoOtherId, tenantA), false);
  assert.equal(db.prepare('SELECT deleted_at FROM video_generations WHERE id = ?').get(videoOtherId).deleted_at, null);
});

test('本地单用户模式保持原有全量查询行为', () => {
  const { db } = setup();
  assert.equal(imageService.list(db, {}).total, 2);
  assert.equal(videoService.list(db, {}).total, 2);
});
