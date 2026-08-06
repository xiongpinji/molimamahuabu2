const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const NOW = '2026-08-06T00:00:00.000Z';

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
      (tenant_id, source_fingerprint, deleted_at)
    VALUES ('tenant-legacy', 'legacy-fingerprint', NULL)
  `).run();
  assert.throws(() => db.prepare(`
    INSERT INTO redraw_works
      (tenant_id, source_fingerprint, deleted_at)
    VALUES ('tenant-legacy', 'legacy-fingerprint', NULL)
  `).run(), /UNIQUE/);
});

test('源片指纹按活跃作品和租户隔离', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const projectA = insertProject(db, 'tenant-a', 'user-a');
  const projectB = insertProject(db, 'tenant-b', 'user-b');

  const workId = insertWork(db, projectA);
  assert.throws(() => insertWork(db, projectA), /UNIQUE/);

  const otherTenantWorkId = insertWork(db, projectB, {
    tenant_id: 'tenant-b',
    user_id: 'user-b',
    source_asset_id: 202,
  });
  assert.notEqual(otherTenantWorkId, workId);

  db.prepare('UPDATE redraw_works SET deleted_at = ? WHERE id = ?').run(NOW, workId);
  const replacementId = insertWork(db, projectA, { source_asset_id: 303 });
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
