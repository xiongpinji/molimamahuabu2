const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const redrawRoutes = require('../src/routes/redraw');

const NOW = '2026-08-06T00:00:00.000Z';

function captureResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function request({ id, projectId, tenantId = 'tenant-a', userId = 'user-a', body = {}, file = null } = {}) {
  const params = {};
  if (id !== undefined) params.id = String(id);
  if (projectId !== undefined) params.id = String(projectId);
  return {
    params,
    tenant: { id: tenantId },
    user: { id: userId },
    body,
    file,
  };
}

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  return db;
}

function insertProject(db, values = {}) {
  return db.prepare(`
    INSERT INTO redraw_projects
      (tenant_id, user_id, title, default_locale, default_market, localization_level, status, created_at, updated_at, deleted_at)
    VALUES
      (@tenant_id, @user_id, @title, @default_locale, @default_market, @localization_level, @status, @created_at, @updated_at, @deleted_at)
  `).run({
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    title: '转绘项目',
    default_locale: 'en-US',
    default_market: 'US',
    localization_level: 'faithful',
    status: 'draft',
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...values,
  }).lastInsertRowid;
}

function insertWork(db, projectId, values = {}) {
  return db.prepare(`
    INSERT INTO redraw_works
      (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms,
       current_version, current_step, status, task_id, provider_task_id, credit_reservation_id,
       created_at, updated_at, deleted_at)
    VALUES
      (@project_id, @tenant_id, @user_id, @title, @source_asset_id, @source_fingerprint, @duration_ms,
       @current_version, @current_step, @status, @task_id, @provider_task_id, @credit_reservation_id,
       @created_at, @updated_at, @deleted_at)
  `).run({
    project_id: projectId,
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    title: '源片',
    source_asset_id: 101,
    source_fingerprint: 'f'.repeat(64),
    duration_ms: 90000,
    current_version: 0,
    current_step: 1,
    status: 'draft',
    task_id: null,
    provider_task_id: null,
    credit_reservation_id: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...values,
  }).lastInsertRowid;
}

function routeDeps(overrides = {}) {
  return {
    uploadService: {
      expandSourceUpload: async () => [{
        id: 101,
        name: 'clip.mp4',
        source_fingerprint: 'a'.repeat(64),
        sha256: 'a'.repeat(64),
        duration_ms: 90000,
        local_path: 'redraw-sources/a.mp4',
        url: '/static/redraw-sources/a.mp4',
      }],
    },
    uploadLimits: { storageRoot: 'data/storage' },
    probeVideo: async () => ({ duration_ms: 90000, width: 1920, height: 1080 }),
    capabilityService: {
      listPublicStylePresets: () => [{
        id: 1,
        stable_key: 'verified-style',
        name: '真实电影',
        category: 'live_action',
        verification_evidence_json: JSON.stringify({ artifact_id: 1 }),
      }],
      listLocaleCapabilities: () => [{
        locale: 'en-US',
        market: 'US',
        status: 'full_output',
        blocking: [],
      }],
    },
    canReadArtifact: () => true,
    orchestrator: {
      startAnalysis: async () => ({
        task_id: 'task-redraw',
        provider_task_id: 'provider-redraw',
        billing: { charged: 0, held: 1, released: 0 },
      }),
    },
    ...overrides,
  };
}

test('转绘项目列表与创建按租户和用户隔离', () => {
  const db = createDb();
  try {
    insertProject(db, { title: '自己的项目' });
    insertProject(db, { tenant_id: 'tenant-b', title: '其他租户' });
    insertProject(db, { user_id: 'user-b', title: '其他用户' });
    insertProject(db, { title: '已删除', deleted_at: NOW });
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const listed = captureResponse();
    handlers.listProjects(request(), listed);
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.body.data.map((item) => item.title), ['自己的项目']);

    const created = captureResponse();
    handlers.createProject(request({
      body: {
        title: '新项目',
        default_locale: 'ja-JP',
        default_market: 'JP',
        localization_level: 'localized',
      },
    }), created);
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.data.title, '新项目');
    assert.equal(created.body.data.default_locale, 'ja-JP');
    assert.equal(created.body.data.tenant_id, 'tenant-a');
    assert.equal(created.body.data.user_id, 'user-a');
  } finally {
    db.close();
  }
});

test('转绘项目详情跨租户和跨用户返回 404', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const own = captureResponse();
    handlers.getProject(request({ id: projectId }), own);
    assert.equal(own.statusCode, 200);
    assert.equal(own.body.data.id, projectId);

    const otherTenant = captureResponse();
    handlers.getProject(request({ id: projectId, tenantId: 'tenant-b' }), otherTenant);
    assert.equal(otherTenant.statusCode, 404);

    const otherUser = captureResponse();
    handlers.getProject(request({ id: projectId, userId: 'user-b' }), otherUser);
    assert.equal(otherUser.statusCode, 404);
  } finally {
    db.close();
  }
});

test('上传源片创建作品并只返回受控路径', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    let expandCalled = false;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      uploadService: {
        expandSourceUpload: async (file) => {
          expandCalled = file.originalname === 'clip.mp4';
          return [{
            id: 101,
            name: 'clip.mp4',
            source_fingerprint: 'b'.repeat(64),
            sha256: 'b'.repeat(64),
            duration_ms: 45000,
            local_path: 'redraw-sources/b.mp4',
            url: '/static/redraw-sources/b.mp4',
            absolute_path: 'C:\\secret\\b.mp4',
          }];
        },
      },
    }));

    const created = captureResponse();
    await handlers.createWorks(request({
      projectId,
      file: { originalname: 'clip.mp4', path: 'tmp/clip.mp4' },
    }), created);

    assert.equal(created.statusCode, 201);
    assert.equal(expandCalled, true);
    assert.equal(created.body.data.items.length, 1);
    assert.equal(created.body.data.items[0].reused, false);
    assert.equal(created.body.data.items[0].local_path, 'redraw-sources/b.mp4');
    assert.equal(created.body.data.items[0].url, '/static/redraw-sources/b.mp4');
    assert.equal('absolute_path' in created.body.data.items[0], false);
  } finally {
    db.close();
  }
});

test('真实上传项先登记资产再创建作品', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      uploadService: {
        expandSourceUpload: async () => [{
          name: 'real.mp4',
          source_fingerprint: 'c'.repeat(64),
          sha256: 'c'.repeat(64),
          duration_ms: 45000,
          width: 1280,
          height: 720,
          kind: 'mp4',
          local_path: 'redraw-sources/c.mp4',
          url: '/static/redraw-sources/c.mp4',
        }],
      },
    }));

    const created = captureResponse();
    await handlers.createWorks(request({
      projectId,
      file: { originalname: 'real.mp4', path: 'tmp/real.mp4' },
    }), created);

    assert.equal(created.statusCode, 201);
    const work = db.prepare('SELECT * FROM redraw_works WHERE id = ?').get(created.body.data.items[0].id);
    const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(work.source_asset_id);
    assert.ok(asset);
    assert.equal(asset.name, 'real.mp4');
    assert.equal(asset.type, 'video');
    assert.equal(asset.category, 'redraw_source');
    assert.equal(asset.local_path, 'redraw-sources/c.mp4');
    assert.equal(created.body.data.items[0].source_asset_id, asset.id);
  } finally {
    db.close();
  }
});

test('作品创建失败会补偿本次登记资产和新持久化文件', async () => {
  const db = createDb();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-route-cleanup-'));
  try {
    const projectId = insertProject(db);
    const localPath = 'redraw-sources/bad.mp4';
    const absPath = path.join(tempRoot, localPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, 'bad video');
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      uploadLimits: { storageRoot: tempRoot },
      uploadService: {
        expandSourceUpload: async () => [{
          name: 'bad.mp4',
          source_fingerprint: 'd'.repeat(64),
          sha256: 'd'.repeat(64),
          duration_ms: 0,
          width: 1280,
          height: 720,
          kind: 'mp4',
          local_path: localPath,
          url: '/static/redraw-sources/bad.mp4',
          persisted_file_created: true,
        }],
      },
    }));

    const created = captureResponse();
    await handlers.createWorks(request({
      projectId,
      file: { originalname: 'bad.mp4', path: 'tmp/bad.mp4' },
    }), created);

    assert.equal(created.statusCode, 500);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NULL').get().n, 0);
    assert.equal(fs.existsSync(absPath), false);
  } finally {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('重复源片指纹返回 reused true', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const first = captureResponse();
    await handlers.createWorks(request({ projectId, file: { originalname: 'clip.mp4', path: 'tmp/clip.mp4' } }), first);
    const second = captureResponse();
    await handlers.createWorks(request({ projectId, file: { originalname: 'clip.mp4', path: 'tmp/clip.mp4' } }), second);

    assert.equal(first.body.data.items[0].reused, false);
    assert.equal(second.body.data.items[0].id, first.body.data.items[0].id);
    assert.equal(second.body.data.items[0].reused, true);
  } finally {
    db.close();
  }
});

test('作品状态读取按租户用户过滤', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { status: 'asset_review', current_step: 2 });
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const own = captureResponse();
    handlers.getWork(request({ id: workId }), own);
    assert.equal(own.statusCode, 200);
    assert.equal(own.body.data.status, 'asset_review');
    assert.equal(own.body.data.current_step, 2);

    const otherTenant = captureResponse();
    handlers.getWork(request({ id: workId, tenantId: 'tenant-b' }), otherTenant);
    assert.equal(otherTenant.statusCode, 404);
  } finally {
    db.close();
  }
});

test('风格和语言目录来自能力服务且仅暴露验证结果', () => {
  const db = createDb();
  try {
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const styles = captureResponse();
    handlers.listStylePresets(request(), styles);
    assert.equal(styles.statusCode, 200);
    assert.deepEqual(styles.body.data.map((item) => item.stable_key), ['verified-style']);

    const locales = captureResponse();
    handlers.listLocales(request(), locales);
    assert.equal(locales.statusCode, 200);
    assert.deepEqual(locales.body.data, [{ locale: 'en-US', market: 'US', status: 'full_output', blocking: [] }]);
  } finally {
    db.close();
  }
});

test('提交分析返回异步任务、厂商任务与 billing 三键，并保持步骤 1', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId);
    let input = null;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      orchestrator: {
        startAnalysis: async (_db, _log, value) => {
          input = value;
          return {
            task_id: 'task-redraw',
            provider_task_id: 'provider-redraw',
            billing: { charged: 0, held: 1, released: 0 },
          };
        },
      },
    }));

    const submitted = captureResponse();
    await handlers.analyzeWork(request({ id: workId }), submitted);
    assert.equal(submitted.statusCode, 201);
    assert.equal(input.workId, workId);
    assert.equal(input.userId, 'user-a');
    assert.equal(submitted.body.data.task_id, 'task-redraw');
    assert.equal(submitted.body.data.provider_task_id, 'provider-redraw');
    assert.deepEqual(Object.keys(submitted.body.data.billing).sort(), ['charged', 'held', 'released']);
    assert.equal(submitted.body.data.current_step, 1);
  } finally {
    db.close();
  }
});
