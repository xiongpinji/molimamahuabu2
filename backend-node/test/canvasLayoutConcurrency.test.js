const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const dramaService = require('../src/services/dramaService');
const storageLayout = require('../src/services/storageLayout');

const log = { info() {}, warn() {}, error() {} };

function createDrama(db, title, metadata = {}) {
  const now = '2026-08-02T12:00:00.000Z';
  return db.prepare(
    `INSERT INTO dramas (title, style, status, metadata, created_at, updated_at)
     VALUES (?, ?, 'draft', ?, ?, ?)`,
  ).run(title, 'realistic', JSON.stringify(metadata), now, now).lastInsertRowid;
}

test('画布 revision 不受无关 updated_at 和 metadata 写入影响', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const dramaId = createDrama(db, '独立画布 revision', { canvas_state_revision: 0, seed: true });
    db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify({ canvas_state_revision: 0, seed: true, asset_sync: 'completed' }),
      '2026-08-02T12:00:05.000Z',
      dramaId,
    );

    const saved = dramaService.saveCanvasLayout(db, log, dramaId, {
      base_canvas_revision: 0,
      canvas_layout: { free_nodes: [{ id: 'generated-node' }] },
    });

    assert.equal(saved.metadata.canvas_state_revision, 1);
    assert.equal(saved.metadata.asset_sync, 'completed');
    assert.deepEqual(saved.metadata.canvas_layout.free_nodes, [{ id: 'generated-node' }]);
  } finally {
    db.close();
  }
});

test('revision 保存精确替换 canvas_layout 根字段而不递归残留旧键', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const dramaId = createDrama(db, '画布快照精确替换', {
      canvas_state_revision: 0,
      canvas_layout: {
        free_nodes: [{ id: 'old-node' }],
        obsolete_nested: { should_disappear: true },
      },
    });

    const nextLayout = { free_nodes: [{ id: 'new-node' }] };
    const saved = dramaService.saveCanvasLayout(db, log, dramaId, {
      base_canvas_revision: 0,
      canvas_layout: nextLayout,
    });

    assert.deepEqual(saved.metadata.canvas_layout, nextLayout);
  } finally {
    db.close();
  }
});

test('陈旧 canvas revision 仍拒绝覆盖较新布局', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const dramaId = createDrama(db, '独立画布 revision 冲突');
    dramaService.saveCanvasLayout(db, log, dramaId, {
      base_canvas_revision: 0,
      canvas_layout: { free_nodes: [{ id: 'new-node' }] },
    });

    assert.throws(
      () => dramaService.saveCanvasLayout(db, log, dramaId, {
        base_canvas_revision: 0,
        canvas_layout: { free_nodes: [{ id: 'stale-node' }] },
      }),
      (error) => error.code === 'CANVAS_LAYOUT_CONFLICT',
    );
    assert.equal(dramaService.getDramaById(db, dramaId).metadata.canvas_state_revision, 1);
    assert.deepEqual(
      dramaService.getDramaById(db, dramaId).metadata.canvas_layout.free_nodes,
      [{ id: 'new-node' }],
    );
  } finally {
    db.close();
  }
});

test('工作流组成功保存同样推进 canvas revision', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const dramaId = createDrama(db, '工作流 revision');
    const saved = dramaService.saveCanvasLayout(db, log, dramaId, {
      base_canvas_revision: 0,
      workflow_groups: [{ id: 'g1' }],
    });

    assert.equal(saved.metadata.canvas_state_revision, 1);
    assert.deepEqual(saved.metadata.workflow_groups, [{ id: 'g1' }]);
  } finally {
    db.close();
  }
});

test('无 token 兼容保存成功同样推进 canvas revision', () => {
  const db = new Database(':memory:');
  try {
    runMigrationsAndEnsure(db);
    const dramaId = createDrama(db, '无 token 兼容保存');
    const saved = dramaService.saveCanvasLayout(db, log, dramaId, {
      canvas_layout: { free_nodes: [{ id: 'legacy-node' }] },
    });

    assert.equal(saved.metadata.canvas_state_revision, 1);
  } finally {
    db.close();
  }
});

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
    assert.equal(current.metadata.canvas_state_revision, 1);
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
