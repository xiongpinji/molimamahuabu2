const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { listAssets, rowToAsset } = require('../src/services/redrawAssetService');
const {
  identityBindingForAsset,
  identityPackStatus,
  readIdentityPack,
  saveIdentityPack,
} = require('../src/services/redrawCharacterIdentityService');

const INITIAL_UPDATED_AT = '2026-08-12T00:00:00.000Z';
const REVIEWED_AT = '2026-08-13T00:00:00.000Z';
const IMAGE_BYTES = Buffer.from('identity-evidence-image');

function setup() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-character-identity-'));
  db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '身份测试项目', ?, ?)`).run(INITIAL_UPDATED_AT, INITIAL_UPDATED_AT);
  db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, created_at, updated_at)
    VALUES (1, 'tenant-a', 'user-a', '身份测试作品', 1, 'source-a', 15000, ?, ?)`)
    .run(INITIAL_UPDATED_AT, INITIAL_UPDATED_AT);
  const workId = db.prepare('SELECT id FROM redraw_works LIMIT 1').get().id;
  db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, source_facts_json,
     facts_hash, status, created_at, updated_at)
    VALUES (?, 'tenant-a', 'user-a', 1, 'en-US', 'US', '{}', 'facts-a',
      'asset_review', ?, ?)`)
    .run(workId, INITIAL_UPDATED_AT, INITIAL_UPDATED_AT);
  const versionId = Number(db.prepare('SELECT id FROM redraw_versions LIMIT 1').get().id);
  return { db, root, versionId };
}

function close(state, extraPaths = []) {
  state.db.close();
  fs.rmSync(state.root, { recursive: true, force: true });
  for (const extraPath of extraPaths) fs.rmSync(extraPath, { recursive: true, force: true });
}

function context(state, overrides = {}) {
  return {
    db: state.db,
    tenantId: 'tenant-a',
    userId: 'user-a',
    versionId: state.versionId,
    storageRoot: state.root,
    now: REVIEWED_AT,
    ...overrides,
  };
}

function addProviderAsset(state, input = {}) {
  const id = Number(input.id || 101);
  const localPath = input.localPath ?? `character-${id}.png`;
  state.db.prepare(`INSERT INTO assets
    (id, drama_id, name, type, category, url, local_path, mime_type, width, height,
     created_at, updated_at)
    VALUES (?, ?, '身份图片', ?, 'redraw', '', ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      input.dramaId ?? null,
      input.type || 'image',
      localPath,
      input.mimeType || 'image/png',
      input.width ?? 640,
      input.height ?? 960,
      INITIAL_UPDATED_AT,
      INITIAL_UPDATED_AT,
    );
  return id;
}

function addCharacter(state, input = {}) {
  const sourceRef = input.sourceRef || { stable_id: `character-${input.id || 1}` };
  const result = state.db.prepare(`INSERT INTO redraw_assets
    (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     localized_description, prompt, asset_id, version_number, approval_status,
     approved_by, approved_at, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'Maya', 'localized character', 'identity prompt', ?, 1,
      'approved', 'old-reviewer', ?, 'generated', ?, ?)`)
    .run(
      input.versionId ?? state.versionId,
      input.tenantId || 'tenant-a',
      input.userId || 'user-a',
      input.kind || 'character',
      JSON.stringify({ source_ref: sourceRef }),
      input.assetId ?? 101,
      INITIAL_UPDATED_AT,
      INITIAL_UPDATED_AT,
      input.updatedAt || INITIAL_UPDATED_AT,
    );
  return Number(result.lastInsertRowid);
}

function completeInput(expectedUpdatedAt = INITIAL_UPDATED_AT, overrides = {}) {
  return {
    expected_updated_at: expectedUpdatedAt,
    target_actor_label: '  Actor Maya  ',
    confirmed_views: ['full_body', 'front', 'profile', 'front'],
    live_action_human_confirmed: true,
    adult_status: 'verified_18_plus',
    identity_consistency_confirmed: true,
    ...overrides,
  };
}

function rowSnapshot(db, id) {
  return db.prepare(`SELECT source_ref_json, approval_status, approved_by, approved_at, updated_at
    FROM redraw_assets WHERE id = ?`).get(id);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalPackFields(pack) {
  return {
    schema_version: pack.schema_version,
    source_character_key: pack.source_character_key,
    target_actor_label: pack.target_actor_label,
    artifact: {
      asset_id: pack.artifact.asset_id,
      sha256: pack.artifact.sha256,
      width: pack.artifact.width,
      height: pack.artifact.height,
      mime_type: pack.artifact.mime_type,
    },
    confirmed_views: pack.confirmed_views,
    live_action_human_confirmed: pack.live_action_human_confirmed,
    adult_status: pack.adult_status,
    identity_consistency_confirmed: pack.identity_consistency_confirmed,
    ready: pack.ready,
    reviewed_by: pack.reviewed_by,
    reviewed_at: pack.reviewed_at,
    ...(pack.persona_origin ? { persona_origin: pack.persona_origin } : {}),
    ...(pack.target_country ? { target_country: pack.target_country } : {}),
  };
}

function canonicalPackHash(pack) {
  return crypto.createHash('sha256').update(stableJson(canonicalPackFields(pack))).digest('hex');
}

function validPack(overrides = {}) {
  const pack = {
    schema_version: 'target-actor-identity-v1',
    source_character_key: 'character-1',
    target_actor_label: 'Actor Maya',
    artifact: {
      asset_id: 101,
      sha256: crypto.createHash('sha256').update(IMAGE_BYTES).digest('hex'),
      width: 640,
      height: 960,
      mime_type: 'image/png',
    },
    confirmed_views: ['front', 'profile', 'full_body'],
    live_action_human_confirmed: true,
    adult_status: 'verified_18_plus',
    identity_consistency_confirmed: true,
    ready: true,
    reviewed_by: 'user-a',
    reviewed_at: REVIEWED_AT,
    ...overrides,
  };
  return {
    ...pack,
    pack_sha256: Object.hasOwn(overrides, 'pack_sha256')
      ? overrides.pack_sha256
      : canonicalPackHash(pack),
  };
}

test('完整身份包使用服务端证据并生成稳定的 64 位小写哈希', () => {
  const state = setup();
  try {
    fs.writeFileSync(path.join(state.root, 'character-101.png'), IMAGE_BYTES);
    addProviderAsset(state);
    const firstId = addCharacter(state, {
      sourceRef: { id: 'fallback-id', stable_id: 'character-1' },
    });
    const secondId = addCharacter(state, {
      sourceRef: { stable_id: 'character-1', id: 'fallback-id' },
    });

    const forged = {
      schema_version: 'client-schema',
      source_character_key: 'forged-character',
      artifact: {
        asset_id: 999,
        sha256: 'f'.repeat(64),
        width: 1,
        height: 1,
        mime_type: 'image/svg+xml',
        local_path: 'C:\\secrets\\actor.png',
      },
      sha256: 'e'.repeat(64),
      ready: false,
      pack_sha256: 'd'.repeat(64),
      reviewed_by: 'forged-reviewer',
      reviewed_at: '1999-01-01T00:00:00.000Z',
    };
    const first = saveIdentityPack(context(state), firstId, completeInput(INITIAL_UPDATED_AT, forged));
    const second = saveIdentityPack(context(state), secondId, {
      ...forged,
      identity_consistency_confirmed: true,
      adult_status: 'verified_18_plus',
      live_action_human_confirmed: true,
      confirmed_views: ['profile', 'full_body', 'front'],
      target_actor_label: 'Actor Maya',
      expected_updated_at: INITIAL_UPDATED_AT,
    });

    const expectedArtifactSha = crypto.createHash('sha256').update(IMAGE_BYTES).digest('hex');
    assert.equal(first.identity_pack.schema_version, 'target-actor-identity-v1');
    assert.equal(first.identity_pack.source_character_key, 'character-1');
    assert.equal(first.identity_pack.target_actor_label, 'Actor Maya');
    assert.deepEqual(first.identity_pack.artifact, {
      asset_id: 101,
      sha256: expectedArtifactSha,
      width: 640,
      height: 960,
      mime_type: 'image/png',
    });
    assert.deepEqual(first.identity_pack.confirmed_views, ['front', 'profile', 'full_body']);
    assert.equal(first.identity_pack.live_action_human_confirmed, true);
    assert.equal(first.identity_pack.adult_status, 'verified_18_plus');
    assert.equal(first.identity_pack.identity_consistency_confirmed, true);
    assert.equal(first.identity_pack.ready, true);
    assert.match(first.identity_pack.pack_sha256, /^[0-9a-f]{64}$/);
    assert.equal(first.identity_pack.pack_sha256, second.identity_pack.pack_sha256);
    assert.equal(first.identity_pack.reviewed_by, 'user-a');
    assert.equal(first.identity_pack.reviewed_at, REVIEWED_AT);
    assert.equal(first.approval_status, 'pending');
    assert.equal(first.approved_by, null);
    assert.equal(first.approved_at, null);
    assert.notEqual(first.updated_at, INITIAL_UPDATED_AT);
    assert.deepEqual(identityBindingForAsset(first), {
      source_character_key: 'character-1',
      target_actor_label: 'Actor Maya',
      artifact: first.identity_pack.artifact,
      pack_sha256: first.identity_pack.pack_sha256,
      ready: true,
    });
  } finally {
    close(state);
  }
});

test('完整虚构美国角色身份包保存、读取和绑定一致投影政策字段', () => {
  const state = setup();
  try {
    fs.writeFileSync(path.join(state.root, 'character-101.png'), IMAGE_BYTES);
    addProviderAsset(state);
    const characterId = addCharacter(state);

    const saved = saveIdentityPack(context(state), characterId, completeInput(INITIAL_UPDATED_AT, {
      persona_origin: 'fictional_ai_generated',
      target_country: 'US',
    }));
    const read = readIdentityPack(saved);

    assert.equal(saved.identity_pack.persona_origin, 'fictional_ai_generated');
    assert.equal(saved.identity_pack.target_country, 'US');
    assert.match(saved.identity_pack.pack_sha256, /^[0-9a-f]{64}$/);
    assert.equal(saved.identity_pack.pack_sha256, canonicalPackHash(saved.identity_pack));
    assert.equal(read.persona_origin, 'fictional_ai_generated');
    assert.equal(read.target_country, 'US');
    assert.equal(read.ready, true);
    assert.equal(identityPackStatus(read).ready, true);
    assert.equal(identityPackStatus(read).hash_valid, true);
    assert.deepEqual(identityBindingForAsset(saved), {
      source_character_key: 'character-1',
      target_actor_label: 'Actor Maya',
      artifact: saved.identity_pack.artifact,
      pack_sha256: saved.identity_pack.pack_sha256,
      ready: true,
      persona_origin: 'fictional_ai_generated',
      target_country: 'US',
    });
  } finally {
    close(state);
  }
});

test('历史身份包缺少政策字段时保留原哈希且仍为 ready', () => {
  const historical = validPack();
  const read = readIdentityPack(historical);

  assert.equal(Object.hasOwn(historical, 'persona_origin'), false);
  assert.equal(Object.hasOwn(historical, 'target_country'), false);
  assert.equal(Object.hasOwn(read, 'persona_origin'), false);
  assert.equal(Object.hasOwn(read, 'target_country'), false);
  assert.equal(read.pack_sha256, historical.pack_sha256);
  assert.equal(read.ready, true);
  assert.equal(identityPackStatus(read).ready, true);
  assert.equal(identityPackStatus(read).hash_valid, true);
});

test('service 直接调用不会把非法角色政策值写入身份包', () => {
  const state = setup();
  try {
    fs.writeFileSync(path.join(state.root, 'character-101.png'), IMAGE_BYTES);
    addProviderAsset(state);
    const cases = [
      { persona_origin: 'real_person', target_country: 'CN' },
      { persona_origin: new String('fictional_ai_generated'), target_country: ['US'] },
    ];
    for (const policyFields of cases) {
      const characterId = addCharacter(state);
      const saved = saveIdentityPack(context(state), characterId, completeInput(
        INITIAL_UPDATED_AT,
        policyFields,
      ));

      assert.equal(Object.hasOwn(saved.identity_pack, 'persona_origin'), false);
      assert.equal(Object.hasOwn(saved.identity_pack, 'target_country'), false);
      assert.equal(saved.identity_pack.ready, true);
      assert.equal(saved.identity_pack_status.hash_valid, true);
    }
  } finally {
    close(state);
  }
});

test('角色键按 stable_id、id、source_character_id 的首个非空值回退', () => {
  const state = setup();
  try {
    fs.writeFileSync(path.join(state.root, 'character-101.png'), IMAGE_BYTES);
    addProviderAsset(state);
    const cases = [
      [{ id: 'id-only' }, 'id-only'],
      [{ source_character_id: 'source-character-only' }, 'source-character-only'],
      [{ stable_id: ' ', id: 'fallback-id', source_character_id: 'unused-source-id' }, 'fallback-id'],
    ];

    for (const [sourceRef, expectedKey] of cases) {
      const characterId = addCharacter(state, { sourceRef });
      const saved = saveIdentityPack(context(state), characterId, completeInput());
      assert.equal(saved.identity_pack.source_character_key, expectedKey);
    }
  } finally {
    close(state);
  }
});

test('任一必需视图或确认项缺失时身份包均不 ready', () => {
  const cases = [
    ['front', { confirmed_views: ['profile', 'full_body'] }],
    ['profile', { confirmed_views: ['front', 'full_body'] }],
    ['full_body', { confirmed_views: ['front', 'profile'] }],
    ['live_action_human_confirmed', { live_action_human_confirmed: false }],
    ['adult_status', { adult_status: 'unverified' }],
    ['identity_consistency_confirmed', { identity_consistency_confirmed: false }],
  ];
  for (const [missing, patch] of cases) {
    const status = identityPackStatus(validPack(patch));
    assert.equal(status.ready, false, `${missing} 缺失时必须 fail closed`);
  }
  assert.equal(identityPackStatus(validPack()).ready, true);
});

test('已存身份包内容漂移但保留旧哈希时不 ready、不绑定且投影 fail closed', () => {
  const original = validPack();
  const driftedPacks = [
    { ...original, target_actor_label: 'Tampered Actor' },
    { ...original, artifact: { ...original.artifact, width: 641 } },
  ];

  for (const identityPack of driftedPacks) {
    assert.equal(identityPackStatus(identityPack).ready, false);
    assert.equal(identityBindingForAsset(identityPack), null);
    const projected = rowToAsset({
      id: 1,
      source_ref_json: JSON.stringify({ source_ref: { id: 'character-1' }, identity_pack: identityPack }),
      status: 'generated',
      approval_status: 'pending',
    });
    assert.equal(projected.identity_pack.ready, false);
    assert.equal(projected.identity_pack_status.ready, false);
  }
});

test('允许保存不完整身份包并明确投影缺项', () => {
  const state = setup();
  try {
    fs.writeFileSync(path.join(state.root, 'character-101.png'), IMAGE_BYTES);
    addProviderAsset(state);
    const characterId = addCharacter(state);
    const saved = saveIdentityPack(context(state), characterId, completeInput(INITIAL_UPDATED_AT, {
      confirmed_views: ['front', 'profile', 'side', 'profile'],
      live_action_human_confirmed: false,
    }));

    assert.deepEqual(saved.identity_pack.confirmed_views, ['front', 'profile']);
    assert.equal(saved.identity_pack.ready, false);
    assert.equal(saved.identity_pack_status.ready, false);
    assert.deepEqual(saved.identity_pack_status.missing_views, ['full_body']);
    assert.deepEqual(saved.identity_pack_status.missing_confirmations, ['live_action_human_confirmed']);
  } finally {
    close(state);
  }
});

test('owner、version、角色类型与 CAS 任一不匹配时数据库保持不变', () => {
  const state = setup();
  try {
    fs.writeFileSync(path.join(state.root, 'character-101.png'), IMAGE_BYTES);
    addProviderAsset(state);
    const characterId = addCharacter(state);
    const propId = addCharacter(state, { kind: 'prop' });
    const checks = [
      [characterId, context(state, { userId: 'user-b' }), completeInput(), 'REDRAW_IDENTITY_ASSET_NOT_FOUND'],
      [characterId, context(state, { versionId: state.versionId + 1 }), completeInput(), 'REDRAW_IDENTITY_ASSET_NOT_FOUND'],
      [propId, context(state), completeInput(), 'REDRAW_IDENTITY_ASSET_INVALID_KIND'],
      [characterId, context(state), completeInput('stale-updated-at'), 'REDRAW_IDENTITY_CONFLICT'],
    ];

    for (const [id, ctx, input, expectedCode] of checks) {
      const before = rowSnapshot(state.db, id);
      assert.throws(
        () => saveIdentityPack(ctx, id, input),
        (error) => error.code === expectedCode,
      );
      assert.deepEqual(rowSnapshot(state.db, id), before);
    }
  } finally {
    close(state);
  }
});

test('当前角色误链到其他租户 drama 图片时拒绝且不写入身份哈希', () => {
  const state = setup();
  try {
    fs.writeFileSync(path.join(state.root, 'character-151.png'), IMAGE_BYTES);
    state.db.prepare(`INSERT INTO dramas
      (id, title, tenant_id, user_id, created_at, updated_at)
      VALUES (51, '其他租户项目', 'tenant-b', 'user-b', ?, ?)`)
      .run(INITIAL_UPDATED_AT, INITIAL_UPDATED_AT);
    addProviderAsset(state, { id: 151, dramaId: 51 });
    const characterId = addCharacter(state, { assetId: 151 });
    const before = rowSnapshot(state.db, characterId);

    assert.throws(
      () => saveIdentityPack(context(state), characterId, completeInput()),
      (error) => error.code === 'REDRAW_IDENTITY_ARTIFACT_NOT_OWNED',
    );
    assert.deepEqual(rowSnapshot(state.db, characterId), before);
    assert.equal(before.source_ref_json.includes('pack_sha256'), false);
    assert.equal(before.source_ref_json.includes(crypto.createHash('sha256').update(IMAGE_BYTES).digest('hex')), false);
  } finally {
    close(state);
  }
});

test('非图片、不可读、路径越界、根目录与符号链接逃逸均失败且不改库', () => {
  const state = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-character-outside-'));
  try {
    fs.writeFileSync(path.join(state.root, 'valid.png'), IMAGE_BYTES);
    fs.writeFileSync(path.join(outside, 'outside.png'), IMAGE_BYTES);
    const escapeLink = path.join(state.root, 'escape-link');
    fs.symlinkSync(outside, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');

    const cases = [
      { id: 201, localPath: 'valid.png', type: 'audio', mimeType: 'audio/mpeg', code: 'REDRAW_IDENTITY_ARTIFACT_INVALID' },
      { id: 202, localPath: 'valid.png', type: 'image', mimeType: 'image/svg+xml', code: 'REDRAW_IDENTITY_ARTIFACT_INVALID' },
      { id: 203, localPath: 'missing.png', code: 'REDRAW_IDENTITY_ARTIFACT_NOT_READABLE' },
      { id: 204, localPath: path.relative(state.root, path.join(outside, 'outside.png')), code: 'REDRAW_IDENTITY_ARTIFACT_PATH_INVALID' },
      { id: 205, localPath: path.join(outside, 'outside.png'), code: 'REDRAW_IDENTITY_ARTIFACT_PATH_INVALID' },
      { id: 206, localPath: '.', code: 'REDRAW_IDENTITY_ARTIFACT_PATH_INVALID' },
      { id: 207, localPath: path.join('escape-link', 'outside.png'), code: 'REDRAW_IDENTITY_ARTIFACT_PATH_INVALID' },
    ];

    for (const item of cases) {
      addProviderAsset(state, item);
      const characterId = addCharacter(state, { id: item.id, assetId: item.id });
      const before = rowSnapshot(state.db, characterId);
      assert.throws(
        () => saveIdentityPack(context(state), characterId, completeInput()),
        (error) => error.code === item.code,
        `asset ${item.id} 应返回 ${item.code}`,
      );
      assert.deepEqual(rowSnapshot(state.db, characterId), before);
    }
  } finally {
    close(state, [outside]);
  }
});

test('文件打开后 realpath 漂移时关闭同一 fd 并拒绝写库', () => {
  const state = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-character-toctou-'));
  try {
    const candidate = path.join(state.root, 'character-251.png');
    const outsideFile = path.join(outside, 'replaced.png');
    fs.writeFileSync(candidate, IMAGE_BYTES);
    fs.writeFileSync(outsideFile, Buffer.from('replaced-image'));
    addProviderAsset(state, { id: 251, localPath: 'character-251.png' });
    const characterId = addCharacter(state, { assetId: 251 });
    const before = rowSnapshot(state.db, characterId);
    let candidateRealpathCalls = 0;
    let opened = 0;
    let closed = 0;
    const injectedFs = {
      constants: fs.constants,
      realpathSync(value) {
        if (path.resolve(value) === path.resolve(candidate)) {
          candidateRealpathCalls += 1;
          if (candidateRealpathCalls > 1) return fs.realpathSync(outsideFile);
        }
        return fs.realpathSync(value);
      },
      openSync(...args) {
        opened += 1;
        return fs.openSync(...args);
      },
      fstatSync: (...args) => fs.fstatSync(...args),
      statSync: (...args) => fs.statSync(...args),
      readFileSync: (...args) => fs.readFileSync(...args),
      closeSync(...args) {
        closed += 1;
        return fs.closeSync(...args);
      },
    };

    assert.throws(
      () => saveIdentityPack(context(state, { fs: injectedFs }), characterId, completeInput()),
      (error) => error.code === 'REDRAW_IDENTITY_ARTIFACT_CHANGED',
    );
    assert.equal(opened, 1);
    assert.equal(closed, 1);
    assert.deepEqual(rowSnapshot(state.db, characterId), before);
  } finally {
    close(state, [outside]);
  }
});

test('无效图片尺寸失败且不改库', () => {
  const state = setup();
  try {
    fs.writeFileSync(path.join(state.root, 'character-301.png'), IMAGE_BYTES);
    addProviderAsset(state, { id: 301, width: 0, height: 960 });
    const characterId = addCharacter(state, { assetId: 301 });
    const before = rowSnapshot(state.db, characterId);
    assert.throws(
      () => saveIdentityPack(context(state), characterId, completeInput()),
      (error) => error.code === 'REDRAW_IDENTITY_ARTIFACT_INVALID',
    );
    assert.deepEqual(rowSnapshot(state.db, characterId), before);
  } finally {
    close(state);
  }
});

test('rowToAsset 与 listAssets 仅投影净化后的身份包和状态', () => {
  const state = setup();
  try {
    const characterId = addCharacter(state);
    const stored = validPack({
      local_path: 'C:\\private\\identity.png',
      storage_root: state.root,
      artifact: {
        ...validPack().artifact,
        local_path: 'C:\\private\\identity.png',
        real_path: path.join(state.root, 'character-101.png'),
      },
    });
    state.db.prepare('UPDATE redraw_assets SET source_ref_json = ? WHERE id = ?').run(JSON.stringify({
      source_ref: { id: 'character-1' },
      identity_pack: stored,
    }), characterId);
    const rawRow = state.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(characterId);
    const direct = rowToAsset(rawRow);
    const listed = listAssets(state.db, context(state))[0];

    for (const projected of [direct, listed]) {
      assert.deepEqual(projected.identity_pack.artifact, validPack().artifact);
      assert.equal(projected.identity_pack_status.ready, true);
      assert.equal(projected.source_ref_json.includes('private'), false);
      assert.equal(projected.source_ref_json.includes('real_path'), false);
      assert.equal(JSON.stringify(projected.identity_pack).includes('private'), false);
      assert.equal(JSON.stringify(projected.identity_pack).includes('real_path'), false);
      assert.equal(Object.hasOwn(projected.identity_pack, 'local_path'), false);
      assert.equal(Object.hasOwn(projected.identity_pack.artifact, 'real_path'), false);
    }
  } finally {
    close(state);
  }
});
