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
