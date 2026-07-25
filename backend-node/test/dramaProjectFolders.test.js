const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const dramaService = require('../src/services/dramaService');

const log = { info() {} };

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

test('项目文件夹按租户隔离并可统计当前模式的项目数', () => {
  const db = setup();
  const folderA = dramaService.createProjectFolder(db, { tenantId: 'tenant-a', name: '宣传片' });
  dramaService.createProjectFolder(db, { tenantId: 'tenant-b', name: '宣传片' });
  const canvas = dramaService.createDrama(db, log, {
    tenant_id: 'tenant-a',
    title: '产品画布',
    folder_id: folderA.id,
    metadata: { project_type: 'canvas' },
  });
  dramaService.createDrama(db, log, {
    tenant_id: 'tenant-a',
    title: '产品短剧',
    folder_id: folderA.id,
    metadata: { project_type: 'factory' },
  });

  assert.equal(canvas.folder_id, folderA.id);
  assert.deepEqual(
    dramaService.listProjectFolders(db, { tenantId: 'tenant-a', project_type: 'canvas' }),
    [{ ...folderA, project_count: 1 }],
  );
  assert.deepEqual(
    dramaService.listProjectFolders(db, { tenantId: 'tenant-b', project_type: 'canvas' })
      .map((item) => item.name),
    ['宣传片'],
  );
});

test('文件夹筛选、关键词、项目类型和排序可以组合生效', () => {
  const db = setup();
  const folder = dramaService.createProjectFolder(db, { tenantId: 'tenant-a', name: '进行中' });
  const first = dramaService.createDrama(db, log, {
    tenant_id: 'tenant-a',
    title: '森林 B',
    folder_id: folder.id,
    metadata: { project_type: 'canvas' },
  });
  const second = dramaService.createDrama(db, log, {
    tenant_id: 'tenant-a',
    title: '森林 A',
    folder_id: folder.id,
    metadata: { project_type: 'canvas' },
  });
  dramaService.createDrama(db, log, {
    tenant_id: 'tenant-a',
    title: '森林短剧',
    folder_id: folder.id,
    metadata: { project_type: 'factory' },
  });
  db.prepare('UPDATE dramas SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', first.id);
  db.prepare('UPDATE dramas SET created_at = ? WHERE id = ?').run('2026-02-01T00:00:00.000Z', second.id);

  const byTitle = dramaService.listDramas(db, {
    tenantId: 'tenant-a',
    page: 1,
    page_size: 20,
    project_type: 'canvas',
    keyword: '森林',
    folder_id: folder.id,
    sort: 'title_asc',
  });
  const byCreated = dramaService.listDramas(db, {
    tenantId: 'tenant-a',
    page: 1,
    page_size: 20,
    project_type: 'canvas',
    folder_id: folder.id,
    sort: 'created_desc',
  });

  assert.deepEqual(byTitle.dramas.map((item) => item.title), ['森林 A', '森林 B']);
  assert.deepEqual(byCreated.dramas.map((item) => item.title), ['森林 A', '森林 B']);
});

test('跨租户不能归档到他人文件夹，删除文件夹只解除项目关联', () => {
  const db = setup();
  const ownFolder = dramaService.createProjectFolder(db, { tenantId: 'tenant-a', name: '自己的' });
  const foreignFolder = dramaService.createProjectFolder(db, { tenantId: 'tenant-b', name: '别人的' });
  const drama = dramaService.createDrama(db, log, {
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    title: '待整理画布',
    folder_id: ownFolder.id,
    metadata: { project_type: 'canvas' },
  });

  assert.throws(
    () => dramaService.updateDrama(
      db,
      log,
      drama.id,
      { folder_id: foreignFolder.id },
      'user-a',
      'tenant-a',
    ),
    { code: 'PROJECT_FOLDER_NOT_FOUND' },
  );

  dramaService.deleteProjectFolder(db, ownFolder.id, 'tenant-a');
  const retained = dramaService.getDramaById(db, drama.id, 'user-a', 'tenant-a');
  const unfiled = dramaService.listDramas(db, {
    tenantId: 'tenant-a',
    page: 1,
    page_size: 20,
    project_type: 'canvas',
    folder_id: 'unfiled',
  });

  assert.equal(retained.folder_id, null);
  assert.deepEqual(unfiled.dramas.map((item) => item.id), [drama.id]);
});

test('本地模式没有租户上下文时仍可管理文件夹并归档项目', () => {
  const db = setup();
  const folder = dramaService.createProjectFolder(db, { name: '本地画布' });
  const drama = dramaService.createDrama(db, log, {
    title: '本地项目',
    folder_id: folder.id,
    metadata: { project_type: 'canvas' },
  });

  assert.equal(drama.folder_id, folder.id);
  assert.deepEqual(
    dramaService.listProjectFolders(db, { project_type: 'canvas' }),
    [{ ...folder, project_count: 1 }],
  );

  dramaService.deleteProjectFolder(db, folder.id);
  assert.equal(dramaService.getDramaById(db, drama.id).folder_id, null);
});
