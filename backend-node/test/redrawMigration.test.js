const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const NOW = '2026-08-06T00:00:00.000Z';
const LIVE_ACTION_STYLE_NAMES = [
  '默认风格',
  '古典武侠风',
  '宫斗权谋冷峻风格',
  '国产悬疑冷调',
  '古偶唯美柔光',
  '国产都市写实',
  '武侠江湖写实摄影风格',
  '90 年代中国农村电影风格',
  '中式暖调蓝辉风格',
  '90 年代港片风格',
  '日式青春胶片',
  '日式生活自然',
  '日本黑白胶片摄影风格',
  '韩剧都市柔光',
  '韩国冷淡风电影风格',
  '复古科幻原子朋克',
  '90 年代写实电影风格',
  '复古叙事电影风格',
  '美式复古好莱坞',
  '老式工业影视风格',
  '复古战争电影风格',
  '复古电影摄影风格',
  '美式复古怪异影视风格',
  '美式经济上行风格',
  '美式复古影视风格',
  '好莱坞黑白电影风格',
  '霓虹赛博电影风格',
  '荒野电影风格',
  '橙黄色电影风格',
  '恐怖电影风格',
  '荒诞高调白色色调电影风格',
  '蓝橙色调影视风格',
  '工业电影风格',
  '科技感电影风格',
  '悬疑电影风格',
  '希腊神话电影风格',
  '紫色色调电影风格',
];

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function insertProject(db, tenantId = 'tenant-a', userId = 'user-a') {
  return db.prepare(`
    INSERT INTO redraw_projects
      (tenant_id, user_id, title, default_locale, default_market, localization_level, status, created_at, updated_at)
    VALUES (?, ?, '转绘项目', 'en-US', 'US', 'faithful', 'draft', ?, ?)
  `).run(tenantId, userId, NOW, NOW).lastInsertRowid;
}

function insertWork(db, projectId, overrides = {}) {
  const values = {
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    title: '源片',
    source_asset_id: 101,
    source_fingerprint: 'fingerprint-a',
    duration_ms: 90000,
    current_version: 0,
    current_step: 1,
    status: 'draft',
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
  return db.prepare(`
    INSERT INTO redraw_works
      (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms,
       current_version, current_step, status, created_at, updated_at, deleted_at)
    VALUES
      (@project_id, @tenant_id, @user_id, @title, @source_asset_id, @source_fingerprint, @duration_ms,
       @current_version, @current_step, @status, @created_at, @updated_at, @deleted_at)
  `).run({ project_id: projectId, ...values }).lastInsertRowid;
}

function insertVersion(db, workId, version = 1, overrides = {}) {
  const values = {
    locale: 'en-US',
    market: 'US',
    localization_level: 'faithful',
    source_facts_json: null,
    glossary_json: '{}',
    name_map_json: '{}',
    culture_map_json: '{}',
    style_snapshot_json: '{}',
    capability_snapshot_json: '{}',
    facts_hash: null,
    status: 'draft',
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...overrides,
  };
  return db.prepare(`
    INSERT INTO redraw_versions
      (work_id, version, locale, market, localization_level, source_facts_json, glossary_json,
       name_map_json, culture_map_json, style_snapshot_json, capability_snapshot_json, facts_hash,
       status, created_at, updated_at, deleted_at)
    VALUES
      (@work_id, @version, @locale, @market, @localization_level, @source_facts_json, @glossary_json,
       @name_map_json, @culture_map_json, @style_snapshot_json, @capability_snapshot_json, @facts_hash,
       @status, @created_at, @updated_at, @deleted_at)
  `).run({ work_id: workId, version, ...values }).lastInsertRowid;
}

test('转绘迁移建立版本化领域表和唯一约束', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);

  const names = tableNames(db);
  for (const name of [
    'redraw_projects',
    'redraw_style_presets',
    'redraw_works',
    'redraw_versions',
    'redraw_assets',
    'redraw_shots',
    'redraw_exports',
  ]) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(columnNames(db, 'redraw_exports').includes('deleted_at'));
  assert.equal(names.includes('redraw_locale_capabilities'), false);

  db.prepare(`
    INSERT INTO redraw_style_presets
      (stable_key, name, category, sort_order, version, status, created_at, updated_at)
    VALUES ('live-default', '默认风格', 'live_action', 1, 1, 'draft', ?, ?)
  `).run(NOW, NOW);
  assert.throws(() => db.prepare(`
    INSERT INTO redraw_style_presets
      (stable_key, name, category, sort_order, version, status, created_at, updated_at)
    VALUES ('live-default', '重复', 'live_action', 2, 1, 'draft', ?, ?)
  `).run(NOW, NOW), /UNIQUE/);
});

test('旧的不完整 redraw_works 表可在迁移前补齐索引依赖列', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE redraw_works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      source_fingerprint TEXT
    );
  `);

  assert.doesNotThrow(() => runMigrationsAndEnsure(db));
  assert.ok(columnNames(db, 'redraw_works').includes('deleted_at'));
  db.prepare(`
    INSERT INTO redraw_works
      (tenant_id, user_id, source_fingerprint, deleted_at)
    VALUES ('tenant-legacy', 'user-a', 'legacy-fingerprint', NULL)
  `).run();
  assert.throws(() => db.prepare(`
    INSERT INTO redraw_works
      (tenant_id, user_id, source_fingerprint, deleted_at)
    VALUES ('tenant-legacy', 'user-a', 'legacy-fingerprint', NULL)
  `).run(), /UNIQUE/);
  assert.doesNotThrow(() => db.prepare(`
    INSERT INTO redraw_works
      (tenant_id, user_id, source_fingerprint, deleted_at)
    VALUES ('tenant-legacy', 'user-b', 'legacy-fingerprint', NULL)
  `).run());
});

test('旧的不完整 redraw_projects 表可在迁移前补齐 owner 索引依赖列', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE redraw_projects (id INTEGER PRIMARY KEY AUTOINCREMENT)');

  assert.doesNotThrow(() => runMigrationsAndEnsure(db));
  assert.ok(columnNames(db, 'redraw_projects').includes('tenant_id'));
  assert.ok(columnNames(db, 'redraw_projects').includes('user_id'));
  assert.ok(columnNames(db, 'redraw_projects').includes('updated_at'));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_redraw_projects_owner'").get());
});

test('旧的租户级源片唯一索引会安全重建为租户用户级索引', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE redraw_works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      user_id TEXT,
      source_fingerprint TEXT,
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX uq_redraw_work_source
      ON redraw_works(tenant_id, source_fingerprint) WHERE deleted_at IS NULL;
  `);

  assert.doesNotThrow(() => runMigrationsAndEnsure(db));
  assert.doesNotThrow(() => db.prepare(`
    INSERT INTO redraw_works
      (tenant_id, user_id, source_fingerprint, deleted_at)
    VALUES ('tenant-a', 'user-a', 'same-source', NULL)
  `).run());
  assert.doesNotThrow(() => db.prepare(`
    INSERT INTO redraw_works
      (tenant_id, user_id, source_fingerprint, deleted_at)
    VALUES ('tenant-a', 'user-b', 'same-source', NULL)
  `).run());
  assert.throws(() => db.prepare(`
    INSERT INTO redraw_works
      (tenant_id, user_id, source_fingerprint, deleted_at)
    VALUES ('tenant-a', 'user-b', 'same-source', NULL)
  `).run(), /UNIQUE/);
});

test('源片唯一索引重建遇到活跃重复键会失败并保留旧索引', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE redraw_works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      user_id TEXT,
      source_fingerprint TEXT,
      deleted_at TEXT
    );
    CREATE INDEX uq_redraw_work_source
      ON redraw_works(tenant_id, source_fingerprint);
    INSERT INTO redraw_works
      (tenant_id, user_id, source_fingerprint, deleted_at)
    VALUES
      ('tenant-a', 'user-a', 'duplicate-source', NULL),
      ('tenant-a', 'user-a', 'duplicate-source', NULL);
  `);

  assert.throws(
    () => runMigrationsAndEnsure(db),
    /redraw_works active source duplicates/,
  );
  assert.deepEqual(
    db.prepare('PRAGMA index_info(uq_redraw_work_source)').all().map((row) => row.name),
    ['tenant_id', 'source_fingerprint'],
  );
});

test('源片指纹按活跃作品、租户和用户隔离', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const projectA = insertProject(db, 'tenant-a', 'user-a');
  const projectSameTenantOtherUser = insertProject(db, 'tenant-a', 'user-b');
  const projectB = insertProject(db, 'tenant-b', 'user-b');

  const workId = insertWork(db, projectA);
  assert.throws(() => insertWork(db, projectA), /UNIQUE/);

  const otherUserWorkId = insertWork(db, projectSameTenantOtherUser, {
    user_id: 'user-b',
    source_asset_id: 202,
  });
  assert.notEqual(otherUserWorkId, workId);

  const otherTenantWorkId = insertWork(db, projectB, {
    tenant_id: 'tenant-b',
    user_id: 'user-b',
    source_asset_id: 303,
  });
  assert.notEqual(otherTenantWorkId, workId);

  db.prepare('UPDATE redraw_works SET deleted_at = ? WHERE id = ?').run(NOW, workId);
  const replacementId = insertWork(db, projectA, { source_asset_id: 404 });
  assert.notEqual(replacementId, workId);
});

test('版本号、分镜顺序和锁定事实不可变', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const projectId = insertProject(db);
  const workId = insertWork(db, projectId);
  const versionId = insertVersion(db, workId, 1);

  assert.throws(() => insertVersion(db, workId, 1), /UNIQUE/);

  db.prepare(`
    UPDATE redraw_versions
    SET source_facts_json = ?, facts_hash = ?, status = 'asset_review'
    WHERE id = ?
  `).run(JSON.stringify({ locked_facts: ['证据在保险柜'] }), 'facts-hash-a', versionId);

  assert.throws(() => db.prepare(`
    UPDATE redraw_versions SET source_facts_json = ? WHERE id = ?
  `).run(JSON.stringify({ locked_facts: ['被篡改'] }), versionId), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM redraw_versions WHERE id = ?').run(versionId), /immutable/);

  const factsOnlyVersionId = insertVersion(db, workId, 2);
  db.prepare(`
    UPDATE redraw_versions
    SET source_facts_json = ?, status = 'asset_review'
    WHERE id = ?
  `).run(JSON.stringify({ locked_facts: ['仅事实 JSON'] }), factsOnlyVersionId);
  assert.throws(() => db.prepare(`
    UPDATE redraw_versions SET source_facts_json = ? WHERE id = ?
  `).run(JSON.stringify({ locked_facts: ['被篡改'] }), factsOnlyVersionId), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM redraw_versions WHERE id = ?').run(factsOnlyVersionId), /immutable/);

  db.prepare(`
    INSERT INTO redraw_shots
      (version_id, batch_index, shot_index, start_ms, end_ms, duration_ms, status, created_at, updated_at)
    VALUES (?, 1, 1, 0, 10000, 10000, 'draft', ?, ?)
  `).run(versionId, NOW, NOW);
  assert.throws(() => db.prepare(`
    INSERT INTO redraw_shots
      (version_id, batch_index, shot_index, start_ms, end_ms, duration_ms, status, created_at, updated_at)
    VALUES (?, 1, 1, 10000, 20000, 10000, 'draft', ?, ?)
  `).run(versionId, NOW, NOW), /UNIQUE/);
});

test('转绘风格目录只种入 37 个未验证真人风格草稿且迁移幂等', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  runMigrationsAndEnsure(db);

  const rows = db.prepare(`
    SELECT name, category, status, verification_evidence_json
    FROM redraw_style_presets
    WHERE stable_key LIKE 'redraw-live-action-style-%'
    ORDER BY sort_order ASC
  `).all();

  assert.equal(rows.length, 37);
  assert.deepEqual(rows.map((row) => row.name), LIVE_ACTION_STYLE_NAMES);
  for (const row of rows) {
    assert.equal(row.category, 'live_action');
    assert.equal(row.status, 'draft');
    assert.equal(row.verification_evidence_json, '{}');
  }

  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM redraw_style_presets
    WHERE category IN ('anime_2d', 'anime_3d')
  `).get().count, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM redraw_style_presets
    WHERE category = 'free'
  `).get().count, 0);
});

test('转绘本地化任务与资产批次迁移可重复执行并保留幂等唯一约束', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  runMigrationsAndEnsure(db);

  const versionColumns = columnNames(db, 'redraw_versions');
  for (const name of [
    'localization_task_id',
    'localization_credit_reservation_id',
    'localization_input_hash',
    'localization_idempotency_key',
    'localization_model_snapshot_json',
  ]) {
    assert.ok(versionColumns.includes(name), name);
  }

  const batchColumns = columnNames(db, 'redraw_asset_batches');
  for (const name of [
    'version_id',
    'tenant_id',
    'user_id',
    'task_id',
    'idempotency_key',
    'quote_snapshot_json',
    'asset_ids_json',
    'status',
    'total_count',
    'success_count',
    'failed_count',
    'created_at',
    'updated_at',
    'completed_at',
  ]) {
    assert.ok(batchColumns.includes(name), name);
  }

  const versionIndexes = db.prepare('PRAGMA index_list(redraw_versions)').all();
  assert.ok(versionIndexes.some((index) => index.name === 'uq_redraw_localization_idempotency'));
});
