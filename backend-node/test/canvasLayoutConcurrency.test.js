const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const dramaService = require('../src/services/dramaService');

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
