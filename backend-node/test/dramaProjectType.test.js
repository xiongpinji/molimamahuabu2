const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const dramaService = require('../src/services/dramaService');

const log = { info() {} };

test('项目列表可以在同一实体中隔离画布项目和短剧项目', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);

  dramaService.createDrama(db, log, { title: '短剧项目' });
  dramaService.createDrama(db, log, {
    title: '独立画布',
    metadata: { project_type: 'canvas', aspect_ratio: '16:9' },
  });

  const canvas = dramaService.listDramas(db, { page: 1, page_size: 20, project_type: 'canvas' });
  const factory = dramaService.listDramas(db, { page: 1, page_size: 20, project_type: 'factory' });

  assert.deepEqual(canvas.dramas.map((item) => item.title), ['独立画布']);
  assert.deepEqual(factory.dramas.map((item) => item.title), ['短剧项目']);
});

test('画布项目搜索与项目类型过滤可以同时生效', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);

  dramaService.createDrama(db, log, {
    title: '森林追踪画布',
    description: '雨林镜头',
    metadata: { project_type: 'canvas' },
  });
  dramaService.createDrama(db, log, {
    title: '城市画布',
    description: '街景镜头',
    metadata: { project_type: 'canvas' },
  });
  dramaService.createDrama(db, log, {
    title: '森林追踪短剧',
    metadata: { project_type: 'factory' },
  });

  const result = dramaService.listDramas(db, {
    page: 1,
    page_size: 20,
    project_type: 'canvas',
    keyword: '森林追踪',
  });

  assert.deepEqual(result.dramas.map((item) => item.title), ['森林追踪画布']);
});
