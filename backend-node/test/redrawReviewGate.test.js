const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  evaluateGenerationGate,
  reviewAsset,
} = require('../src/services/redrawReviewService');
const { updateAsset } = require('../src/services/redrawAssetService');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalIdentityPack(overrides = {}) {
  const pack = {
    schema_version: 'target-actor-identity-v1',
    source_character_key: 'source-character-1',
    target_actor_label: 'Actor Maya',
    artifact: {
      asset_id: 1001,
      sha256: crypto.createHash('sha256').update('canonical actor portrait').digest('hex'),
      width: 640,
      height: 960,
      mime_type: 'image/png',
    },
    wardrobe: {
      label: '整集主服装',
      reference_asset_id: 1002,
      reference_sha256: crypto.createHash('sha256').update('canonical actor wardrobe').digest('hex'),
      consistency_confirmed: true,
    },
    confirmed_views: ['front', 'profile', 'full_body'],
    live_action_human_confirmed: true,
    adult_status: 'verified_18_plus',
    identity_consistency_confirmed: true,
    persona_origin: 'fictional_ai_generated',
    target_country: 'US',
    ready: true,
    reviewed_by: 'user-a',
    reviewed_at: '2026-08-06T00:00:00.000Z',
    ...overrides,
  };
  const canonical = {
    schema_version: pack.schema_version,
    source_character_key: pack.source_character_key,
    target_actor_label: pack.target_actor_label,
    artifact: pack.artifact,
    wardrobe: pack.wardrobe,
    confirmed_views: pack.confirmed_views,
    live_action_human_confirmed: pack.live_action_human_confirmed,
    adult_status: pack.adult_status,
    identity_consistency_confirmed: pack.identity_consistency_confirmed,
    persona_origin: pack.persona_origin,
    target_country: pack.target_country,
    ready: pack.ready,
    reviewed_by: pack.reviewed_by,
    reviewed_at: pack.reviewed_at,
  };
  return {
    ...pack,
    pack_sha256: Object.hasOwn(overrides, 'pack_sha256')
      ? overrides.pack_sha256
      : crypto.createHash('sha256').update(stableJson(canonical)).digest('hex'),
  };
}

function characterReference(assetId, pack, overrides = {}) {
  return {
    kind: 'character',
    asset_id: Number(assetId),
    source_character_key: pack.source_character_key,
    target_actor_label: pack.target_actor_label,
    identity_pack_sha256: pack.pack_sha256,
    ...overrides,
  };
}

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

function addAsset(db, {
  id,
  kind,
  status = 'generated',
  approvalStatus = 'pending',
  versionNumber = 1,
  identityPack = null,
}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     asset_id, version_number, approval_status, status, created_at, updated_at)
    VALUES (?, ?, 'tenant-a', 'user-a', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    1,
    kind,
    JSON.stringify(identityPack ? { identity_pack: identityPack } : {}),
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

test('视频生成门禁先执行准备门禁，旧候选不能绕过未完成准备', () => {
  const state = setup();
  try {
    addAsset(state.db, { id: 80, kind: 'scene' });
    addShot(state.db, state.versionId, 1, [{ kind: 'scene', asset_id: 80 }]);
    state.db.prepare('UPDATE redraw_versions SET reference_bundle_required = 1 WHERE id = ?').run(state.versionId);
    state.db.prepare(`UPDATE redraw_shots
      SET video_generation_id = 9001, preparation_state = 'parsed'
      WHERE version_id = ?`).run(state.versionId);

    const gate = evaluateGenerationGate(state.db, state.versionId, { tenantId: 'tenant-a', userId: 'user-a' });

    assert.equal(gate.ok, false);
    assert.equal(gate.blocking[0].code, 'preparation_not_ready');
    assert.equal(gate.missing[0].reason_code, 'character_plan_not_ready');
  } finally {
    state.db.close();
  }
});

test('视频生成门禁只把内部受信 preparationContext 合并进准备门禁', () => {
  const state = setup();
  try {
    addAsset(state.db, { id: 81, kind: 'scene', approvalStatus: 'approved' });
    addShot(state.db, state.versionId, 1, [{ kind: 'scene', asset_id: 81 }]);
    state.db.prepare('UPDATE redraw_versions SET reference_bundle_required = 1 WHERE id = ?').run(state.versionId);
    const trustedAssetReader = { owns: () => true };
    let captured = null;
    const gate = evaluateGenerationGate(state.db, state.versionId, { tenantId: 'tenant-a', userId: 'user-a' }, {
      preparationContext: {
        tenantId: 'tenant-b',
        userId: 'user-b',
        db: 'forged',
        storageRoot: 'C:\\trusted\\storage',
        assetReader: trustedAssetReader,
        canReadArtifact: () => true,
        probeRunner: () => null,
        rawSecret: 'must-not-pass',
      },
      preparationGate(ctx) {
        captured = ctx;
        return { ok: true, ready_shot_ids: [1], missing: [] };
      },
    });

    assert.equal(gate.ok, true);
    assert.equal(captured.db, state.db);
    assert.equal(captured.tenantId, 'tenant-a');
    assert.equal(captured.userId, 'user-a');
    assert.equal(captured.storageRoot, 'C:\\trusted\\storage');
    assert.equal(captured.assetReader, trustedAssetReader);
    assert.equal(typeof captured.canReadArtifact, 'function');
    assert.equal(typeof captured.probeRunner, 'function');
    assert.equal(Object.prototype.hasOwnProperty.call(captured, 'rawSecret'), false);
  } finally {
    state.db.close();
  }
});

test('审核资产批准时在事务内用受信 preparationContext 重算生成门禁', () => {
  const state = setup();
  try {
    const scene = addAsset(state.db, { id: 82, kind: 'scene', approvalStatus: 'pending' });
    addShot(state.db, state.versionId, 1, [{ kind: 'scene', asset_id: scene.id }]);
    state.db.prepare('UPDATE redraw_versions SET reference_bundle_required = 1 WHERE id = ?').run(state.versionId);
    let captured = null;
    const reviewed = reviewAsset(state.db, scene.id, {
      action: 'approved',
      reviewerId: 'user-a',
      tenantId: 'tenant-a',
      userId: 'user-a',
      expectedUpdatedAt: scene.updated_at,
      preparationContext: { storageRoot: 'C:\\trusted\\storage', assetReader: { owns: () => true } },
      preparationGate(ctx) {
        captured = ctx;
        return { ok: true, ready_shot_ids: [1], missing: [] };
      },
    });

    assert.equal(reviewed.approval_status, 'approved');
    assert.equal(captured.storageRoot, 'C:\\trusted\\storage');
    assert.equal(captured.tenantId, 'tenant-a');
    assert.equal(state.db.prepare('SELECT status FROM redraw_versions WHERE id = ?').get(state.versionId).status, 'ready_to_generate');
  } finally {
    state.db.close();
  }
});

test('未被分镜引用的可选源事实资产不会全局阻塞门禁', () => {
  const state = setup();
  try {
    state.db.prepare('UPDATE redraw_versions SET source_facts_json = ? WHERE id = ?').run(JSON.stringify({
      characters: [{ id: 'c1' }],
      scenes: [{ id: 's1' }],
      props: [{ id: 'p1' }],
    }), state.versionId);
    addShot(state.db, state.versionId, 1, []);
    const gate = evaluateGenerationGate(state.db, state.versionId, { tenantId: 'tenant-a', userId: 'user-a' });
    assert.equal(gate.ok, true);
    assert.deepEqual(gate.blocking, []);
    assert.deepEqual(gate.missing, []);
  } finally {
    state.db.close();
  }
});

test('门禁只接受同版本 redraw_assets.id 并拒绝底层素材 asset_id 兜底', () => {
  const state = setup();
  try {
    const scene = addAsset(state.db, { id: 61, kind: 'scene', approvalStatus: 'approved' });
    addShot(state.db, state.versionId, 1, [{ kind: 'scene', asset_id: scene.asset_id }]);
    const gate = evaluateGenerationGate(state.db, state.versionId, { tenantId: 'tenant-a', userId: 'user-a' });
    assert.equal(gate.ok, false);
    assert.deepEqual(gate.missing, [{
      kind: 'scene',
      asset_id: scene.asset_id,
      shot_ids: [1],
      anchor: `asset-${scene.asset_id}-scene`,
    }]);
    assert.deepEqual(gate.blocking, [{
      code: 'asset_reference_invalid',
      reason: '分镜引用不属于当前版本的转绘资产',
      asset_count: 1,
    }]);
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

test('重复无效或未审批引用按唯一 reference key 计数并继续合并定位镜头', () => {
  const state = setup();
  try {
    addAsset(state.db, { id: 14, kind: 'voice' });
    addShot(state.db, state.versionId, 1, [
      { kind: 'voice', asset_id: 14 },
      { kind: 'voice', asset_id: 14 },
      { kind: 'prop', asset_id: 999 },
      { kind: 'prop', asset_id: 999 },
    ]);

    const gate = evaluateGenerationGate(state.db, state.versionId, { tenantId: 'tenant-a', userId: 'user-a' });
    assert.equal(gate.ok, false);
    assert.equal(gate.blocking.find((item) => item.code === 'asset_not_approved').asset_count, 1);
    assert.equal(gate.blocking.find((item) => item.code === 'asset_reference_invalid').asset_count, 1);
    assert.deepEqual(gate.missing.map((item) => ({
      kind: item.kind,
      asset_id: item.asset_id,
      shot_ids: item.shot_ids,
    })), [
      { kind: 'prop', asset_id: 999, shot_ids: [1] },
      { kind: 'voice', asset_id: 14, shot_ids: [1] },
    ]);
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

test('角色资产缺少完整且哈希有效的身份包时不能批准，但仍允许退回', () => {
  const state = setup();
  try {
    const incompletePack = canonicalIdentityPack({
      confirmed_views: ['front', 'profile'],
      live_action_human_confirmed: false,
      ready: false,
    });
    const asset = addAsset(state.db, {
      id: 32,
      kind: 'character',
      identityPack: incompletePack,
    });
    assert.throws(
      () => reviewAsset(state.db, asset.id, {
        action: 'approved',
        reviewerId: 'user-a',
        expectedUpdatedAt: asset.updated_at,
      }),
      (error) => error.code === 'REDRAW_CHARACTER_IDENTITY_REQUIRED',
    );
    assert.equal(state.db.prepare('SELECT approval_status FROM redraw_assets WHERE id = ?').get(asset.id).approval_status, 'pending');

    const rejected = reviewAsset(state.db, asset.id, {
      action: 'rejected',
      reviewerId: 'user-a',
      expectedUpdatedAt: asset.updated_at,
    });
    assert.equal(rejected.approval_status, 'rejected');
  } finally {
    state.db.close();
  }
});

test('角色身份包完整且 canonical hash 有效时可以批准', () => {
  const state = setup();
  try {
    const pack = canonicalIdentityPack();
    const asset = addAsset(state.db, { id: 33, kind: 'character', identityPack: pack });
    const approved = reviewAsset(state.db, asset.id, {
      action: 'approved',
      reviewerId: 'user-a',
      expectedUpdatedAt: asset.updated_at,
    });
    assert.equal(approved.approval_status, 'approved');
  } finally {
    state.db.close();
  }
});

test('角色门禁要求当前身份包及逐镜 binding 完整一致', () => {
  const cases = [
    {
      name: '缺身份包',
      pack: null,
      reference: (assetId) => ({ kind: 'character', asset_id: assetId }),
      code: 'character_identity_pack_required',
    },
    {
      name: '缺逐镜 binding',
      pack: canonicalIdentityPack(),
      reference: (assetId) => ({ kind: 'character', asset_id: assetId }),
      code: 'character_identity_binding_stale',
    },
    {
      name: '身份包 hash 漂移',
      pack: canonicalIdentityPack(),
      reference: (assetId, pack) => characterReference(assetId, pack, {
        identity_pack_sha256: crypto.createHash('sha256').update('older canonical identity pack').digest('hex'),
      }),
      code: 'character_identity_binding_stale',
    },
    {
      name: 'source 不一致',
      pack: canonicalIdentityPack(),
      reference: (assetId, pack) => characterReference(assetId, pack, { source_character_key: 'forged-source' }),
      code: 'character_identity_binding_stale',
    },
    {
      name: 'target 不一致',
      pack: canonicalIdentityPack(),
      reference: (assetId, pack) => characterReference(assetId, pack, { target_actor_label: 'Forged Actor' }),
      code: 'character_identity_binding_stale',
    },
  ];
  for (const entry of cases) {
    const state = setup();
    try {
      const asset = addAsset(state.db, {
        id: 70,
        kind: 'character',
        approvalStatus: 'approved',
        identityPack: entry.pack,
      });
      addShot(state.db, state.versionId, 1, [entry.reference(asset.id, entry.pack)]);
      const gate = evaluateGenerationGate(state.db, state.versionId, { tenantId: 'tenant-a', userId: 'user-a' });
      assert.equal(gate.ok, false, entry.name);
      assert.equal(gate.blocking.some((item) => item.code === entry.code), true, entry.name);
      assert.equal(gate.missing[0].code, entry.code, entry.name);
    } finally {
      state.db.close();
    }
  }
});

test('当前 canonical 身份 binding 与身份包一致时角色门禁开放', () => {
  const state = setup();
  try {
    const pack = canonicalIdentityPack();
    const asset = addAsset(state.db, {
      id: 71,
      kind: 'character',
      approvalStatus: 'approved',
      identityPack: pack,
    });
    addShot(state.db, state.versionId, 1, [characterReference(asset.id, pack)]);
    const gate = evaluateGenerationGate(state.db, state.versionId, { tenantId: 'tenant-a', userId: 'user-a' });
    assert.equal(gate.ok, true);
    assert.deepEqual(gate.blocking, []);
    assert.deepEqual(gate.missing, []);
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
