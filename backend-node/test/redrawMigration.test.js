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
const REDRAW_SHOT_PREPARATION_STATES = [
  'parsed',
  'localized',
  'identity_bound',
  'clean_ready',
  'reference_ready',
  'needs_review',
  'needs_attention',
  'failed',
  'stale',
];

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function schemaSnapshot(db) {
  return db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
}

function tableSql(db, table) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql;
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

test('新库转绘作品和版本状态 CHECK 支持本地化审核与阻断状态', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const projectId = insertProject(db);
  const reviewWorkId = insertWork(db, projectId, {
    source_fingerprint: 'fingerprint-review',
    status: 'needs_review',
  });
  assert.equal(
    db.prepare('SELECT status FROM redraw_works WHERE id = ?').get(reviewWorkId).status,
    'needs_review',
  );
  const blockedVersionId = insertVersion(db, reviewWorkId, 1, {
    status: 'blocked',
  });
  assert.equal(
    db.prepare('SELECT status FROM redraw_versions WHERE id = ?').get(blockedVersionId).status,
    'blocked',
  );

  assert.throws(() => insertWork(db, projectId, {
    source_fingerprint: 'fingerprint-invalid-work',
    status: 'manual_review',
  }), /CHECK/);
  assert.throws(() => insertVersion(db, reviewWorkId, 2, {
    status: 'manual_review',
  }), /CHECK/);
});

test('旧库 redraw_works/redraw_versions 状态 CHECK 可升级并保留数据索引外键 owner 字段', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE redraw_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      user_id TEXT,
      title TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE redraw_works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source_asset_id INTEGER NOT NULL,
      source_fingerprint TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 12000 AND 3600000),
      current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
      current_step INTEGER NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 4),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'analyzing', 'asset_review', 'ready_to_generate', 'generating', 'composing', 'completed', 'failed', 'needs_attention')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY(project_id) REFERENCES redraw_projects(id)
    );
    CREATE TABLE redraw_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      tenant_id TEXT,
      user_id TEXT,
      version INTEGER NOT NULL CHECK (version > 0),
      locale TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT '',
      localization_level TEXT NOT NULL DEFAULT 'faithful',
      style_snapshot_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'analyzing', 'asset_review', 'ready_to_generate', 'generating', 'composing', 'completed', 'failed', 'needs_attention')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY(work_id) REFERENCES redraw_works(id)
    );
    CREATE INDEX idx_redraw_work_owner_legacy ON redraw_works(tenant_id, user_id, updated_at DESC);
    CREATE UNIQUE INDEX uq_redraw_version_number ON redraw_versions(work_id, version);
    CREATE TABLE redraw_version_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER NOT NULL,
      note TEXT,
      FOREIGN KEY(version_id) REFERENCES redraw_versions(id)
    );
    INSERT INTO redraw_projects
      (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', 'legacy project', '${NOW}', '${NOW}');
    INSERT INTO redraw_works
      (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
       duration_ms, current_version, current_step, status, created_at, updated_at, deleted_at)
    VALUES
      (1, 'tenant-a', 'user-a', 'legacy work', 101, 'legacy-fingerprint',
       12000, 1, 1, 'asset_review', '${NOW}', '${NOW}', NULL);
    INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, localization_level, style_snapshot_json,
       status, created_at, updated_at, deleted_at)
    VALUES
      (1, 'tenant-a', 'user-a', 1, 'source', '', 'faithful', '{}',
       'asset_review', '${NOW}', '${NOW}', NULL);
    INSERT INTO redraw_version_notes (version_id, note) VALUES (1, 'keep child fk');
  `);

  assert.throws(() => db.prepare("UPDATE redraw_works SET status = 'needs_review' WHERE id = 1").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE redraw_versions SET status = 'blocked' WHERE id = 1").run(), /CHECK/);

  assert.doesNotThrow(() => runMigrationsAndEnsure(db));
  assert.doesNotThrow(() => runMigrationsAndEnsure(db));

  assert.match(tableSql(db, 'redraw_works'), /needs_review/);
  assert.match(tableSql(db, 'redraw_versions'), /blocked/);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_redraw_work_owner_legacy'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'uq_redraw_version_number'").get());
  assert.deepEqual(
    db.prepare('SELECT tenant_id, user_id FROM redraw_works WHERE id = 1').get(),
    { tenant_id: 'tenant-a', user_id: 'user-a' },
  );
  assert.equal(db.prepare('SELECT note FROM redraw_version_notes WHERE version_id = 1').get().note, 'keep child fk');
  assert.doesNotThrow(() => db.prepare("UPDATE redraw_works SET status = 'needs_review' WHERE id = 1").run());
  assert.doesNotThrow(() => db.prepare("UPDATE redraw_versions SET status = 'blocked' WHERE id = 1").run());
  assert.throws(() => db.prepare("UPDATE redraw_works SET status = 'manual_review' WHERE id = 1").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE redraw_versions SET status = 'manual_review' WHERE id = 1").run(), /CHECK/);
});

test('旧库状态 CHECK 升级遇到固定临时表碰撞会 fail closed 且无部分写入', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE redraw_works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'asset_review'))
    );
    CREATE TABLE __redraw_works_status_rebuild (
      id INTEGER PRIMARY KEY,
      marker TEXT NOT NULL
    );
    INSERT INTO redraw_works (status) VALUES ('asset_review');
    INSERT INTO __redraw_works_status_rebuild (id, marker) VALUES (1, 'do not drop');
  `);
  assert.throws(() => runMigrationsAndEnsure(db), /redraw_works status rebuild temp table already exists/);
  assert.equal(
    db.prepare('SELECT marker FROM __redraw_works_status_rebuild WHERE id = 1').get().marker,
    'do not drop',
  );
  assert.match(tableSql(db, 'redraw_works'), /status TEXT NOT NULL DEFAULT 'draft' CHECK \(status IN \('draft', 'asset_review'\)\)/);
  assert.doesNotMatch(tableSql(db, 'redraw_works'), /needs_review|blocked/);
  assert.throws(() => db.prepare("UPDATE redraw_works SET status = 'needs_review' WHERE id = 1").run(), /CHECK/);
});

test('通用转绘项目保存 A/B、预算、尝试上限和追加式事件', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const projectColumns = db.prepare('PRAGMA table_info(redraw_projects)').all();
  const columns = projectColumns.map((row) => row.name);
  for (const name of [
    'execution_mode',
    'budget_limit_credits',
    'max_auto_attempts_per_shot',
    'policy_version',
    'automation_policy_json',
  ]) assert.ok(columns.includes(name), name);
  const columnMap = new Map(projectColumns.map((row) => [row.name, row]));
  assert.deepEqual(
    {
      execution_mode: columnMap.get('execution_mode').dflt_value,
      policy_version: columnMap.get('policy_version').dflt_value,
      automation_policy_json: columnMap.get('automation_policy_json').dflt_value,
    },
    {
      execution_mode: "'safe'",
      policy_version: '1',
      automation_policy_json: "'{}'",
    },
  );

  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='redraw_workflow_events'").get().name,
    'redraw_workflow_events',
  );
  assert.ok(db.prepare(`
    SELECT 1 FROM pragma_index_list('redraw_workflow_events')
    WHERE name = 'idx_redraw_workflow_events_project'
  `).get());
  assert.deepEqual(
    db.prepare('PRAGMA index_info(idx_redraw_workflow_events_project)').all().map((row) => row.name),
    ['tenant_id', 'user_id', 'project_id', 'id'],
  );
  assert.deepEqual(
    db.prepare('PRAGMA foreign_key_list(redraw_workflow_events)').all().map((row) => ({
      table: row.table,
      from: row.from,
      to: row.to,
    })),
    [{ table: 'redraw_projects', from: 'project_id', to: 'id' }],
  );

  const projectId = insertProject(db);
  assert.deepEqual(
    db.prepare('SELECT execution_mode, policy_version, automation_policy_json FROM redraw_projects WHERE id = ?')
      .get(projectId),
    { execution_mode: 'safe', policy_version: 1, automation_policy_json: '{}' },
  );
  assert.throws(() => db.prepare(`
    INSERT INTO redraw_projects
      (tenant_id, user_id, title, execution_mode, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', 'bad mode', 'manual', ?, ?)
  `).run(NOW, NOW), /CHECK/);
  assert.throws(() => db.prepare(`
    INSERT INTO redraw_projects
      (tenant_id, user_id, title, budget_limit_credits, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', 'bad budget', 0, ?, ?)
  `).run(NOW, NOW), /CHECK/);
  assert.throws(() => db.prepare(`
    INSERT INTO redraw_projects
      (tenant_id, user_id, title, max_auto_attempts_per_shot, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', 'bad attempts', 6, ?, ?)
  `).run(NOW, NOW), /CHECK/);
  assert.throws(() => db.prepare(`
    INSERT INTO redraw_projects
      (tenant_id, user_id, title, policy_version, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', 'bad version', 0, ?, ?)
  `).run(NOW, NOW), /CHECK/);

  const eventId = db.prepare(`
    INSERT INTO redraw_workflow_events
      (tenant_id, user_id, project_id, resource_type, resource_id, from_state, to_state,
       reason_code, evidence_hash, created_at)
    VALUES
      ('tenant-a', 'user-a', ?, 'project', 'project-1', 'draft', 'active',
       'policy-selected', 'sha256:abc', ?)
  `).run(projectId, NOW).lastInsertRowid;
  assert.throws(() => db.prepare(`
    UPDATE redraw_workflow_events SET metadata_json = '{"changed":true}' WHERE id = ?
  `).run(eventId), /redraw workflow events are immutable/);
  assert.throws(() => db.prepare('DELETE FROM redraw_workflow_events WHERE id = ?').run(eventId), /redraw workflow events are immutable/);
  assert.doesNotThrow(() => runMigrationsAndEnsure(db));
});

test('旧的不完整 redraw_projects 表可补齐通用策略列和追加式事件表', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE redraw_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      user_id TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'safe'
    );
  `);

  assert.doesNotThrow(() => runMigrationsAndEnsure(db));
  assert.doesNotThrow(() => runMigrationsAndEnsure(db));
  const columns = columnNames(db, 'redraw_projects');
  for (const name of [
    'execution_mode',
    'budget_limit_credits',
    'max_auto_attempts_per_shot',
    'policy_version',
    'automation_policy_json',
  ]) assert.ok(columns.includes(name), name);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'redraw_workflow_events'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'redraw_workflow_events_immutable_update'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'redraw_workflow_events_immutable_delete'").get());
});

test('redraw_works 接受 12 秒源片并拒绝低于 12 秒', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const projectId = insertProject(db);

  assert.doesNotThrow(() => insertWork(db, projectId, {
    source_fingerprint: 'fingerprint-12s',
    duration_ms: 12000,
  }));
  assert.throws(() => insertWork(db, projectId, {
    source_fingerprint: 'fingerprint-11999ms',
    duration_ms: 11999,
  }), /CHECK/);
});

test('旧 15 秒 redraw_works CHECK 可幂等升级为 12 秒且保留数据索引外键状态', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE redraw_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      user_id TEXT,
      title TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE redraw_works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source_asset_id INTEGER NOT NULL,
      source_fingerprint TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 15000 AND 3600000),
      current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
      current_step INTEGER NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 4),
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY(project_id) REFERENCES redraw_projects(id)
    );
    CREATE INDEX idx_redraw_work_custom
      ON redraw_works(tenant_id, updated_at);
    CREATE TABLE redraw_work_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      note TEXT,
      FOREIGN KEY(work_id) REFERENCES redraw_works(id)
    );
    INSERT INTO redraw_projects
      (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', 'legacy project', '${NOW}', '${NOW}');
    INSERT INTO redraw_works
      (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
       duration_ms, current_version, current_step, status, created_at, updated_at, deleted_at)
    VALUES
      (1, 'tenant-a', 'user-a', 'legacy work', 101, 'legacy-fingerprint',
       15000, 0, 1, 'draft', '${NOW}', '${NOW}', NULL);
    INSERT INTO redraw_work_notes (work_id, note) VALUES (1, 'keep child fk');
  `);

  assert.doesNotThrow(() => runMigrationsAndEnsure(db));
  assert.doesNotThrow(() => runMigrationsAndEnsure(db));

  const ddl = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'redraw_works'
  `).get().sql;
  assert.match(ddl, /duration_ms INTEGER NOT NULL CHECK \(duration_ms BETWEEN 12000 AND 3600000\)/);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_redraw_work_custom'").get());
  assert.ok(db.prepare('SELECT note FROM redraw_work_notes WHERE work_id = 1').get());
  assert.equal(db.prepare('SELECT duration_ms FROM redraw_works WHERE id = 1').get().duration_ms, 15000);
  assert.doesNotThrow(() => db.prepare(`
    INSERT INTO redraw_works
      (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
       duration_ms, current_version, current_step, status, created_at, updated_at, deleted_at)
    VALUES
      (1, 'tenant-a', 'user-a', 'new 12s', 102, 'new-12s',
       12000, 0, 1, 'draft', ?, ?, NULL)
  `).run(NOW, NOW));
  assert.throws(() => db.prepare(`
    INSERT INTO redraw_works
      (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
       duration_ms, current_version, current_step, status, created_at, updated_at, deleted_at)
    VALUES
      (1, 'tenant-a', 'user-a', 'too short', 103, 'new-11999',
       11999, 0, 1, 'draft', ?, ?, NULL)
  `).run(NOW, NOW), /CHECK/);
});

test('旧 15 秒 redraw_works CHECK 升级遇到外层事务会拒绝且保留调用方事务', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE migration_marker (id INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE redraw_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      user_id TEXT,
      title TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE redraw_works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source_asset_id INTEGER NOT NULL,
      source_fingerprint TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 15000 AND 3600000),
      current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
      current_step INTEGER NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 4),
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY(project_id) REFERENCES redraw_projects(id)
    );
  `);
  db.exec('BEGIN');
  db.prepare("INSERT INTO migration_marker (id, value) VALUES (1, 'outer transaction stays open')").run();
  const beforeSchema = schemaSnapshot(db);
  const beforeTables = tableNames(db).sort();
  const beforeWorksColumns = columnNames(db, 'redraw_works');

  assert.throws(() => runMigrationsAndEnsure(db), /runMigrationsAndEnsure requires no active transaction/);
  assert.equal(db.inTransaction, true);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(schemaSnapshot(db), beforeSchema);
  assert.deepEqual(tableNames(db).sort(), beforeTables);
  assert.deepEqual(columnNames(db, 'redraw_works'), beforeWorksColumns);
  assert.equal(
    db.prepare('SELECT value FROM migration_marker WHERE id = 1').get().value,
    'outer transaction stays open',
  );
  assert.match(
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'redraw_works'").get().sql,
    /duration_ms BETWEEN 15000 AND 3600000/,
  );

  db.exec('ROLLBACK');
  assert.equal(db.inTransaction, false);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});

test('旧 15 秒 redraw_works CHECK 升级遇到固定临时表碰撞会 fail closed', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE redraw_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT,
      user_id TEXT,
      title TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE redraw_works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source_asset_id INTEGER NOT NULL,
      source_fingerprint TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 15000 AND 3600000),
      current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
      current_step INTEGER NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 4),
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY(project_id) REFERENCES redraw_projects(id)
    );
    CREATE TABLE __redraw_works_duration_rebuild (
      id INTEGER PRIMARY KEY,
      marker TEXT NOT NULL
    );
    INSERT INTO __redraw_works_duration_rebuild (id, marker) VALUES (1, 'do not drop');
    INSERT INTO redraw_projects
      (tenant_id, user_id, title, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', 'legacy project', '${NOW}', '${NOW}');
    INSERT INTO redraw_works
      (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
       duration_ms, current_version, current_step, status, created_at, updated_at, deleted_at)
    VALUES
      (1, 'tenant-a', 'user-a', 'legacy work', 101, 'legacy-fingerprint',
       15000, 0, 1, 'draft', '${NOW}', '${NOW}', NULL);
  `);

  assert.throws(() => runMigrationsAndEnsure(db), /redraw_works duration rebuild temp table already exists/);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(
    db.prepare('SELECT marker FROM __redraw_works_duration_rebuild WHERE id = 1').get().marker,
    'do not drop',
  );
  assert.match(
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '__redraw_works_duration_rebuild'").get().sql,
    /marker TEXT NOT NULL/,
  );
  assert.equal(db.prepare('SELECT duration_ms FROM redraw_works WHERE id = 1').get().duration_ms, 15000);
  assert.match(
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'redraw_works'").get().sql,
    /duration_ms BETWEEN 15000 AND 3600000/,
  );
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

  const versionColumnRows = db.prepare('PRAGMA table_info(redraw_versions)').all();
  const versionColumns = versionColumnRows.map((row) => row.name);
  for (const name of [
    'localization_task_id',
    'localization_credit_reservation_id',
    'localization_input_hash',
    'localization_idempotency_key',
    'localization_model_snapshot_json',
    'text_map_json',
  ]) {
    assert.ok(versionColumns.includes(name), name);
  }
  const textMapColumn = versionColumnRows.find((row) => row.name === 'text_map_json');
  assert.deepEqual(
    { type: textMapColumn.type, notnull: textMapColumn.notnull, default: textMapColumn.dflt_value },
    { type: 'TEXT', notnull: 1, default: "'{}'" },
  );

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
  const projectId = insertProject(db);
  const workId = insertWork(db, projectId);
  const versionId = insertVersion(db, workId);
  assert.deepEqual(JSON.parse(db.prepare('SELECT text_map_json FROM redraw_versions WHERE id = ?').get(versionId).text_map_json), {});
});

test('旧库 redraw_versions 补齐 text_map_json 且保留旧版本数据', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE redraw_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      locale TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT '',
      localization_level TEXT NOT NULL DEFAULT 'faithful',
      source_facts_json TEXT,
      glossary_json TEXT NOT NULL DEFAULT '{}',
      name_map_json TEXT NOT NULL DEFAULT '{}',
      culture_map_json TEXT NOT NULL DEFAULT '{}',
      style_snapshot_json TEXT NOT NULL DEFAULT '{"tone":"legacy"}',
      capability_snapshot_json TEXT NOT NULL DEFAULT '{}',
      facts_hash TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    INSERT INTO redraw_versions
      (work_id, version, locale, market, localization_level, source_facts_json,
       glossary_json, name_map_json, culture_map_json, style_snapshot_json, capability_snapshot_json,
       facts_hash, status, created_at, updated_at, deleted_at)
    VALUES
      (1, 1, 'source', '', 'faithful', '{"locked":true}',
       '{"keep":"glossary"}', '{"keep":"name"}', '{"keep":"culture"}', '{"tone":"legacy"}', '{}',
       'hash-a', 'asset_review', '${NOW}', '${NOW}', NULL);
  `);

  assert.doesNotThrow(() => runMigrationsAndEnsure(db));
  assert.doesNotThrow(() => runMigrationsAndEnsure(db));

  const columns = new Map(db.prepare('PRAGMA table_info(redraw_versions)').all().map((row) => [row.name, row]));
  assert.deepEqual(
    {
      type: columns.get('text_map_json').type,
      notnull: columns.get('text_map_json').notnull,
      default: columns.get('text_map_json').dflt_value,
    },
    { type: 'TEXT', notnull: 1, default: "'{}'" },
  );
  assert.deepEqual(
    db.prepare('SELECT source_facts_json, glossary_json, name_map_json, culture_map_json, style_snapshot_json, text_map_json FROM redraw_versions WHERE id = 1').get(),
    {
      source_facts_json: '{"locked":true}',
      glossary_json: '{"keep":"glossary"}',
      name_map_json: '{"keep":"name"}',
      culture_map_json: '{"keep":"culture"}',
      style_snapshot_json: '{"tone":"legacy"}',
      text_map_json: '{}',
    },
  );
});

test('参考包列迁移幂等且旧生成默认关闭', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  runMigrationsAndEnsure(db);

  const versionColumns = new Map(
    db.prepare('PRAGMA table_info(redraw_versions)').all().map((column) => [column.name, column]),
  );
  const shotColumns = new Map(
    db.prepare('PRAGMA table_info(redraw_shots)').all().map((column) => [column.name, column]),
  );
  const requiredColumn = versionColumns.get('reference_bundle_required');
  assert.ok(requiredColumn);
  assert.deepEqual(
    { type: requiredColumn.type, notnull: requiredColumn.notnull, default: requiredColumn.dflt_value },
    { type: 'INTEGER', notnull: 1, default: '0' },
  );

  const bundleJsonColumn = shotColumns.get('reference_bundle_json');
  assert.ok(bundleJsonColumn);
  assert.deepEqual(
    { type: bundleJsonColumn.type, notnull: bundleJsonColumn.notnull, default: bundleJsonColumn.dflt_value },
    { type: 'TEXT', notnull: 1, default: "'{}'" },
  );
  for (const name of ['reference_bundle_hash', 'reference_bundle_updated_at']) {
    const column = shotColumns.get(name);
    assert.ok(column, name);
    assert.deepEqual({ type: column.type, notnull: column.notnull }, { type: 'TEXT', notnull: 0 });
  }

  const projectId = insertProject(db);
  const workId = insertWork(db, projectId);
  const versionId = insertVersion(db, workId);
  assert.equal(
    db.prepare('SELECT reference_bundle_required FROM redraw_versions WHERE id = ?')
      .get(versionId).reference_bundle_required,
    0,
  );

  const shotId = db.prepare(`
    INSERT INTO redraw_shots
      (version_id, batch_index, shot_index, start_ms, end_ms, duration_ms, status, created_at, updated_at)
    VALUES (?, 1, 1, 0, 10000, 10000, 'draft', ?, ?)
  `).run(versionId, NOW, NOW).lastInsertRowid;
  const referenceBundleJson = db.prepare(`
    SELECT reference_bundle_json FROM redraw_shots WHERE id = ?
  `).get(shotId).reference_bundle_json;
  assert.deepEqual(JSON.parse(referenceBundleJson), {});
  db.close();
});

test('新库 redraw_shots 包含逐镜准备状态列默认值和 CHECK 约束', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);

  const shotColumns = new Map(
    db.prepare('PRAGMA table_info(redraw_shots)').all().map((column) => [column.name, column]),
  );
  assert.deepEqual(
    {
      type: shotColumns.get('preparation_state').type,
      notnull: shotColumns.get('preparation_state').notnull,
      default: shotColumns.get('preparation_state').dflt_value,
    },
    { type: 'TEXT', notnull: 1, default: "'parsed'" },
  );
  assert.deepEqual(
    {
      type: shotColumns.get('preparation_version').type,
      notnull: shotColumns.get('preparation_version').notnull,
      default: shotColumns.get('preparation_version').dflt_value,
    },
    { type: 'INTEGER', notnull: 1, default: '1' },
  );
  for (const name of ['preparation_evidence_hash', 'stale_reason_code']) {
    const column = shotColumns.get(name);
    assert.ok(column, name);
    assert.deepEqual({ type: column.type, notnull: column.notnull }, { type: 'TEXT', notnull: 0 });
  }
  assert.deepEqual(
    {
      type: shotColumns.get('preparation_snapshot_json').type,
      notnull: shotColumns.get('preparation_snapshot_json').notnull,
      default: shotColumns.get('preparation_snapshot_json').dflt_value,
    },
    { type: 'TEXT', notnull: 1, default: "'{}'" },
  );
  for (const state of REDRAW_SHOT_PREPARATION_STATES) assert.match(tableSql(db, 'redraw_shots'), new RegExp(`'${state}'`));
  assert.match(tableSql(db, 'redraw_shots'), /preparation_version INTEGER NOT NULL DEFAULT 1 CHECK \(preparation_version > 0\)/);

  const projectId = insertProject(db);
  const workId = insertWork(db, projectId);
  const versionId = insertVersion(db, workId);
  const shotId = db.prepare(`
    INSERT INTO redraw_shots
      (version_id, batch_index, shot_index, start_ms, end_ms, duration_ms, status, created_at, updated_at)
    VALUES (?, 1, 1, 0, 10000, 10000, 'draft', ?, ?)
  `).run(versionId, NOW, NOW).lastInsertRowid;
  assert.deepEqual(
    db.prepare(`
      SELECT preparation_state, preparation_version, preparation_evidence_hash,
             preparation_snapshot_json, stale_reason_code
      FROM redraw_shots WHERE id = ?
    `).get(shotId),
    {
      preparation_state: 'parsed',
      preparation_version: 1,
      preparation_evidence_hash: null,
      preparation_snapshot_json: '{}',
      stale_reason_code: null,
    },
  );
  assert.throws(() => db.prepare(`
    INSERT INTO redraw_shots
      (version_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
       preparation_state, status, created_at, updated_at)
    VALUES (?, 1, 2, 10000, 20000, 10000, 'manual_review', 'draft', ?, ?)
  `).run(versionId, NOW, NOW), /CHECK/);
  assert.throws(() => db.prepare(`
    INSERT INTO redraw_shots
      (version_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
       preparation_version, status, created_at, updated_at)
    VALUES (?, 1, 3, 20000, 30000, 10000, 0, 'draft', ?, ?)
  `).run(versionId, NOW, NOW), /CHECK/);
  db.close();
});

test('旧的不完整 redraw_shots 可幂等补齐逐镜准备状态列且保留旧行数据', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE redraw_shots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER,
      batch_index INTEGER NOT NULL DEFAULT 1,
      shot_index INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      updated_at TEXT
    );
    INSERT INTO redraw_shots
      (version_id, batch_index, shot_index, status, updated_at)
    VALUES (7, 2, 3, 'processing', '${NOW}');
  `);
  const before = db.prepare('SELECT version_id, batch_index, shot_index, status, updated_at FROM redraw_shots WHERE id = 1').get();

  assert.doesNotThrow(() => runMigrationsAndEnsure(db));
  assert.doesNotThrow(() => runMigrationsAndEnsure(db));

  const columns = new Map(db.prepare('PRAGMA table_info(redraw_shots)').all().map((column) => [column.name, column]));
  assert.deepEqual(
    {
      stateDefault: columns.get('preparation_state').dflt_value,
      stateNotNull: columns.get('preparation_state').notnull,
      versionDefault: columns.get('preparation_version').dflt_value,
      versionNotNull: columns.get('preparation_version').notnull,
      snapshotDefault: columns.get('preparation_snapshot_json').dflt_value,
      snapshotNotNull: columns.get('preparation_snapshot_json').notnull,
    },
    {
      stateDefault: "'parsed'",
      stateNotNull: 1,
      versionDefault: '1',
      versionNotNull: 1,
      snapshotDefault: "'{}'",
      snapshotNotNull: 1,
    },
  );
  assert.ok(columns.has('preparation_evidence_hash'));
  assert.ok(columns.has('stale_reason_code'));
  assert.deepEqual(
    db.prepare('SELECT version_id, batch_index, shot_index, status, updated_at FROM redraw_shots WHERE id = 1').get(),
    before,
  );
  assert.deepEqual(
    db.prepare(`
      SELECT preparation_state, preparation_version, preparation_evidence_hash,
             preparation_snapshot_json, stale_reason_code
      FROM redraw_shots WHERE id = 1
    `).get(),
    {
      preparation_state: 'parsed',
      preparation_version: 1,
      preparation_evidence_hash: null,
      preparation_snapshot_json: '{}',
      stale_reason_code: null,
    },
  );
  assert.throws(() => db.prepare("UPDATE redraw_shots SET preparation_state = 'manual_review' WHERE id = 1").run(), /CHECK/);
  assert.throws(() => db.prepare('UPDATE redraw_shots SET preparation_version = 0 WHERE id = 1').run(), /CHECK/);
  db.close();
});

test('源视频 conditioning 列迁移可重复执行并兼容单列已存在的旧库', () => {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const initialColumns = columnNames(db, 'video_generations');
  if (!initialColumns.includes('reference_video_urls')) {
    db.exec('ALTER TABLE video_generations ADD COLUMN reference_video_urls TEXT');
  }
  if (initialColumns.includes('source_conditioning_json')) {
    db.exec('ALTER TABLE video_generations DROP COLUMN source_conditioning_json');
  }

  assert.doesNotThrow(() => runMigrationsAndEnsure(db));
  assert.doesNotThrow(() => runMigrationsAndEnsure(db));

  const columns = columnNames(db, 'video_generations');
  assert.ok(columns.includes('reference_video_urls'));
  assert.ok(columns.includes('source_conditioning_json'));
});

test('候选审核追加保存并由镜头和导出绑定当前批准哈希', () => {
  const db = new Database(':memory:');
  assert.doesNotThrow(() => runMigrationsAndEnsure(db));
  assert.doesNotThrow(() => runMigrationsAndEnsure(db));

  const reviewColumns = new Map(
    db.prepare('PRAGMA table_info(redraw_candidate_reviews)').all().map((column) => [column.name, column]),
  );
  const expectedColumns = {
    id: ['INTEGER', 0, null],
    tenant_id: ['TEXT', 1, null],
    user_id: ['TEXT', 1, null],
    version_id: ['INTEGER', 1, null],
    shot_id: ['INTEGER', 1, null],
    video_generation_id: ['INTEGER', 1, null],
    candidate_sha256: ['TEXT', 1, null],
    dependency_hash: ['TEXT', 1, null],
    review_version: ['INTEGER', 1, null],
    decision: ['TEXT', 1, null],
    decision_source: ['TEXT', 1, null],
    reason_codes_json: ['TEXT', 1, "'[]'"],
    metrics_json: ['TEXT', 1, "'{}'"],
    reviewer_id: ['TEXT', 0, null],
    created_at: ['TEXT', 1, null],
  };
  assert.deepEqual(
    Object.fromEntries(
      [...reviewColumns].map(([name, column]) => [name, [column.type, column.notnull, column.dflt_value]]),
    ),
    expectedColumns,
  );
  assert.equal(reviewColumns.get('id').pk, 1);

  const reviewTableSql = tableSql(db, 'redraw_candidate_reviews');
  assert.match(reviewTableSql, /review_version INTEGER NOT NULL CHECK \(review_version > 0\)/);
  assert.match(reviewTableSql, /decision TEXT NOT NULL CHECK \(decision IN \('approved', 'rejected', 'needs_review'\)\)/);
  assert.match(reviewTableSql, /decision_source TEXT NOT NULL CHECK \(decision_source IN \('automatic', 'human'\)\)/);
  assert.deepEqual(
    db.prepare('PRAGMA foreign_key_list(redraw_candidate_reviews)').all()
      .map((row) => [row.from, row.table, row.to])
      .sort((left, right) => left[0].localeCompare(right[0])),
    [
      ['shot_id', 'redraw_shots', 'id'],
      ['version_id', 'redraw_versions', 'id'],
    ],
  );
  assert.deepEqual(
    db.prepare('PRAGMA index_info(uq_redraw_candidate_review_version)').all().map((row) => row.name),
    ['tenant_id', 'user_id', 'shot_id', 'video_generation_id', 'review_version'],
  );

  const shotColumns = new Map(db.prepare('PRAGMA table_info(redraw_shots)').all().map((column) => [column.name, column]));
  assert.deepEqual(
    {
      type: shotColumns.get('approved_candidate_review_id').type,
      notnull: shotColumns.get('approved_candidate_review_id').notnull,
      default: shotColumns.get('approved_candidate_review_id').dflt_value,
    },
    { type: 'INTEGER', notnull: 0, default: null },
  );
  const exportColumns = new Map(db.prepare('PRAGMA table_info(redraw_exports)').all().map((column) => [column.name, column]));
  assert.deepEqual(
    {
      releaseHash: [exportColumns.get('release_hash').type, exportColumns.get('release_hash').notnull],
      qualitySummary: [
        exportColumns.get('quality_summary_json').type,
        exportColumns.get('quality_summary_json').notnull,
        exportColumns.get('quality_summary_json').dflt_value,
      ],
    },
    { releaseHash: ['TEXT', 0], qualitySummary: ['TEXT', 1, "'{}'"] },
  );

  const projectId = insertProject(db);
  const workId = insertWork(db, projectId);
  const versionId = insertVersion(db, workId);
  const shotId = db.prepare(`
    INSERT INTO redraw_shots
      (version_id, batch_index, shot_index, start_ms, end_ms, duration_ms, status, created_at, updated_at)
    VALUES (?, 1, 1, 0, 5000, 5000, 'draft', ?, ?)
  `).run(versionId, NOW, NOW).lastInsertRowid;
  const insertReview = db.prepare(`
    INSERT INTO redraw_candidate_reviews
      (tenant_id, user_id, version_id, shot_id, video_generation_id, candidate_sha256,
       dependency_hash, review_version, decision, decision_source, reviewer_id, created_at)
    VALUES
      ('tenant-a', 'user-a', ?, ?, ?, 'candidate-hash',
       'dependency-hash', ?, ?, ?, NULL, ?)
  `);
  const reviewId = insertReview.run(versionId, shotId, 501, 1, 'approved', 'automatic', NOW).lastInsertRowid;
  assert.deepEqual(
    db.prepare('SELECT reason_codes_json, metrics_json FROM redraw_candidate_reviews WHERE id = ?').get(reviewId),
    { reason_codes_json: '[]', metrics_json: '{}' },
  );
  assert.throws(
    () => insertReview.run(versionId, shotId, 501, 1, 'rejected', 'human', NOW),
    /UNIQUE/,
  );
  const nextReviewId = insertReview.run(versionId, shotId, 501, 2, 'rejected', 'human', NOW).lastInsertRowid;
  assert.notEqual(nextReviewId, reviewId);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM redraw_candidate_reviews WHERE shot_id = ?').get(shotId).count,
    2,
  );
  assert.throws(
    () => insertReview.run(versionId, shotId, 502, 0, 'approved', 'automatic', NOW),
    /CHECK/,
  );
  assert.throws(
    () => insertReview.run(versionId, shotId, 503, 1, 'invalid', 'automatic', NOW),
    /CHECK/,
  );
  assert.throws(
    () => insertReview.run(versionId, shotId, 504, 1, 'approved', 'client', NOW),
    /CHECK/,
  );
  assert.throws(
    () => db.prepare("UPDATE redraw_candidate_reviews SET decision = 'rejected' WHERE id = ?").run(reviewId),
    /immutable/,
  );
  assert.throws(
    () => db.prepare('DELETE FROM redraw_candidate_reviews WHERE id = ?').run(reviewId),
    /immutable/,
  );
  db.close();
});

test('旧的不完整镜头和导出表可幂等补齐候选 release 列且保留旧行', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE redraw_shots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER,
      batch_index INTEGER NOT NULL DEFAULT 1,
      shot_index INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      updated_at TEXT,
      legacy_marker TEXT
    );
    CREATE TABLE redraw_exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER,
      export_type TEXT NOT NULL DEFAULT 'video',
      version_number INTEGER NOT NULL DEFAULT 1,
      legacy_marker TEXT
    );
    INSERT INTO redraw_shots
      (version_id, batch_index, shot_index, status, updated_at, legacy_marker)
    VALUES (7, 2, 3, 'processing', '${NOW}', 'keep-shot');
    INSERT INTO redraw_exports
      (version_id, export_type, version_number, legacy_marker)
    VALUES (7, 'video', 4, 'keep-export');
  `);

  assert.doesNotThrow(() => runMigrationsAndEnsure(db));
  assert.doesNotThrow(() => runMigrationsAndEnsure(db));

  const shotColumns = new Map(db.prepare('PRAGMA table_info(redraw_shots)').all().map((column) => [column.name, column]));
  assert.deepEqual(
    {
      type: shotColumns.get('approved_candidate_review_id').type,
      notnull: shotColumns.get('approved_candidate_review_id').notnull,
      default: shotColumns.get('approved_candidate_review_id').dflt_value,
    },
    { type: 'INTEGER', notnull: 0, default: null },
  );
  const exportColumns = new Map(db.prepare('PRAGMA table_info(redraw_exports)').all().map((column) => [column.name, column]));
  assert.deepEqual(
    {
      releaseHash: [exportColumns.get('release_hash').type, exportColumns.get('release_hash').notnull],
      qualitySummary: [
        exportColumns.get('quality_summary_json').type,
        exportColumns.get('quality_summary_json').notnull,
        exportColumns.get('quality_summary_json').dflt_value,
      ],
    },
    { releaseHash: ['TEXT', 0], qualitySummary: ['TEXT', 1, "'{}'"] },
  );
  assert.deepEqual(
    db.prepare('SELECT version_id, batch_index, shot_index, status, updated_at, legacy_marker, approved_candidate_review_id FROM redraw_shots WHERE id = 1').get(),
    {
      version_id: 7,
      batch_index: 2,
      shot_index: 3,
      status: 'processing',
      updated_at: NOW,
      legacy_marker: 'keep-shot',
      approved_candidate_review_id: null,
    },
  );
  assert.deepEqual(
    db.prepare('SELECT version_id, export_type, version_number, legacy_marker, release_hash, quality_summary_json FROM redraw_exports WHERE id = 1').get(),
    {
      version_id: 7,
      export_type: 'video',
      version_number: 4,
      legacy_marker: 'keep-export',
      release_hash: null,
      quality_summary_json: '{}',
    },
  );
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'redraw_candidate_reviews'").get());
  db.close();
});
