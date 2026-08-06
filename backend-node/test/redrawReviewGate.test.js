const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  evaluateGenerationGate,
  reviewAsset,
} = require('../src/services/redrawReviewService');
const { updateAsset } = require('../src/services/redrawAssetService');

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '审核项目', ?, ?)`).run(now, now);
  const projectId = db.prepare('SELECT id FROM redraw_projects LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', '审核作品', 1, 'review-source', 15000, 1, 2, 'asset_review', ?, ?)`).run(projectId, now, now);
  const workId = db.prepare('SELECT id FROM redraw_works LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, 'en-US', 'US', 'asset_review', ?, ?)`).run(workId, now, now);
  const versionId = db.prepare('SELECT id FROM redraw_versions LIMIT 1').get().id;
  return { db, workId, versionId, now };
}

function addAsset(db, { id, kind, status = 'generated', approvalStatus = 'pending', versionNumber = 1 }) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     asset_id, version_number, approval_status, status, created_at, updated_at)
    VALUES (?, ?, 'tenant-a', 'user-a', ?, '{}', ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    1,
    kind,
    `${kind}-${id}`,
    id + 1000,
    versionNumber,
    approvalStatus,
    status,
    now,
    now,
  );
  return db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(id);
}

function addShot(db, versionId, shotIndex, references) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO redraw_shots
    (version_id, tenant_id, user_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
     references_json, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, ?, 0, 1000, 1000, ?, 'draft', ?, ?)`).run(
    versionId,
    shotIndex,
    JSON.stringify(references),
    now,
    now,
  );
}

test('零分镜版本 fail closed 并返回 shots_missing', () => {
  const state = setup();
  try {
    const gate = evaluateGenerationGate(state.db, state.versionId, { tenantId: 'tenant-a', userId: 'user-a' });
    assert.equal(gate.ok, false);
    assert.deepEqual(gate.blocking, [{ code: 'shots_missing', reason: '当前版本没有可生成分镜' }]);
    assert.deepEqual(gate.missing, []);
  } finally {
    state.db.close();
  }
});

test('源事实存在但资产草稿未物化时返回 required_assets_missing', () => {
  const state = setup();
  try {
    state.db.prepare('UPDATE redraw_versions SET source_facts_json = ? WHERE id = ?').run(JSON.stringify({
      characters: [{ id: 'c1' }],
      scenes: [{ id: 's1' }],
      props: [{ id: 'p1' }],
    }), state.versionId);
    addShot(state.db, state.versionId, 1, []);
    const gate = evaluateGenerationGate(state.db, state.versionId, { tenantId: 'tenant-a', userId: 'user-a' });
    assert.equal(gate.ok, false);
    assert.deepEqual(gate.blocking, [{
      code: 'required_assets_missing',
      reason: '当前版本的本地化资产尚未物化',
      kinds: ['character', 'scene', 'prop'],
      assets: [
        { kind: 'character', source_id: 'c1' },
        { kind: 'scene', source_id: 's1' },
        { kind: 'prop', source_id: 'p1' },
      ],
    }]);
    assert.deepEqual(gate.missing, []);
  } finally {
    state.db.close();
  }
});

test('返回每个未审批引用及直接定位信息', () => {
  const state = setup();
  try {
    addAsset(state.db, { id: 12, kind: 'voice' });
    addAsset(state.db, { id: 13, kind: 'scene', approvalStatus: 'approved' });
    addShot(state.db, state.versionId, 1, [
      { kind: 'voice', asset_id: 12 },
      { kind: 'scene', asset_id: 13 },
    ]);
    const gate = evaluateGenerationGate(state.db, state.versionId, { tenantId: 'tenant-a', userId: 'user-a' });
    assert.equal(gate.ok, false);
    assert.deepEqual(gate.missing, [{
      kind: 'voice',
      asset_id: 12,
      shot_ids: [1],
      anchor: 'asset-12-voice',
    }]);
  } finally {
    state.db.close();
  }
});

test('退回已引用净景会重新关闭视频生成门禁', () => {
  const state = setup();
  try {
    const scene = addAsset(state.db, { id: 21, kind: 'scene', approvalStatus: 'approved' });
    addShot(state.db, state.versionId, 1, [{ kind: 'scene', asset_id: scene.id }]);
    assert.equal(evaluateGenerationGate(state.db, state.versionId, { tenantId: 'tenant-a', userId: 'user-a' }).ok, true);
    const updated = reviewAsset(state.db, scene.id, {
      action: 'rejected',
      reviewerId: 'user-a',
      expectedUpdatedAt: scene.updated_at,
    });
    assert.equal(updated.approval_status, 'rejected');
    assert.equal(evaluateGenerationGate(state.db, state.versionId, { tenantId: 'tenant-a', userId: 'user-a' }).ok, false);
  } finally {
    state.db.close();
  }
});

test('审核使用 expected_updated_at 乐观锁且只允许 approved/rejected', () => {
  const state = setup();
  try {
    const asset = addAsset(state.db, { id: 31, kind: 'character' });
    assert.throws(
      () => reviewAsset(state.db, asset.id, {
        action: 'approved',
        reviewerId: 'user-a',
        expectedUpdatedAt: 'stale',
      }),
      (error) => error.code === 'REDRAW_REVIEW_CONFLICT',
    );
    assert.throws(
      () => reviewAsset(state.db, asset.id, {
        action: 'pending',
        reviewerId: 'user-a',
        expectedUpdatedAt: asset.updated_at,
      }),
      (error) => error.code === 'REDRAW_REVIEW_ACTION_INVALID',
    );
  } finally {
    state.db.close();
  }
});

test('审核严格隔离租户和用户并写入审批人、时间和版本号', () => {
  const state = setup();
  try {
    const asset = addAsset(state.db, { id: 41, kind: 'prop', versionNumber: 2 });
    assert.throws(
      () => reviewAsset(state.db, asset.id, {
        action: 'approved',
        reviewerId: 'user-b',
        tenantId: 'tenant-b',
        userId: 'user-b',
        expectedUpdatedAt: asset.updated_at,
      }),
      (error) => error.code === 'REDRAW_ASSET_NOT_FOUND',
    );
    const approved = reviewAsset(state.db, asset.id, {
      action: 'approved',
      reviewerId: 'user-a',
      tenantId: 'tenant-a',
      userId: 'user-a',
      expectedUpdatedAt: asset.updated_at,
    });
    assert.equal(approved.approved_by, 'user-a');
    assert.ok(approved.approved_at);
    assert.equal(approved.version_number, 2);
  } finally {
    state.db.close();
  }
});

test('修改已审核资产会清除旧审核并重新进入待审核', () => {
  const state = setup();
  try {
    const asset = addAsset(state.db, { id: 51, kind: 'scene', approvalStatus: 'approved' });
    state.db.prepare("UPDATE redraw_assets SET approved_by = 'user-a', approved_at = ? WHERE id = ?")
      .run(new Date().toISOString(), asset.id);
    const updated = updateAsset(state.db, {
      versionId: state.versionId,
      tenantId: 'tenant-a',
      userId: 'user-a',
    }, asset.id, { prompt: '新版提示词' });
    assert.equal(updated.approval_status, 'pending');
    assert.equal(updated.approved_by, null);
    assert.equal(updated.approved_at, null);
  } finally {
    state.db.close();
  }
});
