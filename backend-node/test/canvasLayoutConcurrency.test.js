const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const dramaService = require('../src/services/dramaService');
const storageLayout = require('../src/services/storageLayout');

const log = { info() {}, warn() {}, error() {} };

test('陈旧画布快照不得覆盖较新的节点布局', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const initialRevision = '2026-08-02T12:00:00.000Z';
    const dramaId = db.prepare(
      `INSERT INTO dramas (title, style, status, metadata, created_at, updated_at)
       VALUES (?, ?, 'draft', ?, ?, ?)`,
    ).run('画布并发保护', 'realistic', JSON.stringify({}), initialRevision, initialRevision).lastInsertRowid;

    const current = dramaService.saveCanvasLayout(db, log, dramaId, {
      base_updated_at: initialRevision,
      canvas_layout: { free_nodes: [{ id: 'new-node' }] },
    });

    assert.throws(
      () => dramaService.saveCanvasLayout(db, log, dramaId, {
        base_updated_at: initialRevision,
        canvas_layout: { free_nodes: [{ id: 'stale-node' }] },
      }),
      (error) => error.code === 'CANVAS_LAYOUT_CONFLICT',
    );
    assert.deepEqual(
      dramaService.getDramaById(db, dramaId).metadata.canvas_layout.free_nodes,
      [{ id: 'new-node' }],
    );
    assert.notEqual(current.updated_at, initialRevision);
  } finally {
    db.close();
  }
});

test('内部存储目录标签不推进画布 CAS 且原子保留布局', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const initialRevision = '2026-08-02T12:00:00.000Z';
    const dramaId = db.prepare(
      `INSERT INTO dramas (title, style, status, metadata, created_at, updated_at)
       VALUES (?, ?, 'draft', ?, ?, ?)`,
    ).run('目录标签并发保护', 'realistic', JSON.stringify({ seed: true }), initialRevision, initialRevision).lastInsertRowid;

    assert.match(storageLayout.getProjectStorageSubdir(db, dramaId), /^projects\//);
    assert.equal(db.prepare('SELECT updated_at FROM dramas WHERE id = ?').get(dramaId).updated_at, initialRevision);

    const current = dramaService.saveCanvasLayout(db, log, dramaId, {
      base_updated_at: initialRevision,
      canvas_layout: { free_nodes: [{ id: 'generated-node' }] },
    });
    assert.equal(current.metadata.seed, true);
    assert.equal(current.metadata.storage_folder_label, '目录标签并发保护');
    assert.deepEqual(current.metadata.canvas_layout.free_nodes, [{ id: 'generated-node' }]);
  } finally {
    db.close();
  }
});
