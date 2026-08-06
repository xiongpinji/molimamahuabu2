const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const redrawRoutes = require('../src/routes/redraw');
const creditLedger = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const realRedrawOrchestrator = require('../src/services/redrawOrchestrator');

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

function insertVerifiedVideoUnderstandingConfig(db) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('video_understanding', 'test-provider', '已验证视频理解', 'GPT-5.5', 'GPT-5.5', 1, 1, 0, ?, ?, ?)
  `).run(JSON.stringify({
    real_generation_verified: true,
    evidence: {
      provider_task_id: 'verified-provider-task',
      result_asset_id: 'verified-result',
      result_asset_readable: true,
      completed_at: now,
    },
  }), now, now);
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

test('作品状态返回真实分析报价和 async task 状态', () => {
  const db = createDb();
  try {
    insertVerifiedVideoUnderstandingConfig(db);
    prices.set(db, 'GPT-5.5', 6);
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, {
      status: 'analyzing',
      current_step: 1,
      task_id: 'task-real-progress',
    });
    db.prepare(`
      INSERT INTO async_tasks
        (id, type, status, progress, message, resource_id, user_id, created_at, updated_at)
      VALUES ('task-real-progress', 'redraw_analysis', 'processing', 64, '正在读取源片', ?, 'user-a', ?, ?)
    `).run(String(workId), NOW, NOW);
    const handlers = redrawRoutes(db, { error() {}, info() {}, warn() {} }, routeDeps({
      orchestrator: realRedrawOrchestrator,
    }));

    const own = captureResponse();
    handlers.getWork(request({ id: workId }), own);

    assert.equal(own.statusCode, 200);
    assert.deepEqual(own.body.data.analysis_quote, { model: 'GPT-5.5', credits: 6, amount: 6 });
    assert.equal(own.body.data.task_id, 'task-real-progress');
    assert.equal(own.body.data.task_status, 'processing');
    assert.equal(own.body.data.task_progress, 64);
    assert.equal(own.body.data.task_message, '正在读取源片');
  } finally {
    db.close();
  }
});

test('未验证能力或未配置价格时作品报价为 null', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId);
    const handlers = redrawRoutes(db, { error() {}, info() {}, warn() {} }, routeDeps({
      orchestrator: realRedrawOrchestrator,
    }));

    const own = captureResponse();
    handlers.getWork(request({ id: workId }), own);

    assert.equal(own.statusCode, 200);
    assert.equal(own.body.data.analysis_quote, null);
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
    await handlers.analyzeWork(request({
      id: workId,
      body: {
        locale: 'ja-JP',
        market: 'JP',
        aspect_ratio: '9:16',
        style_preset_id: 7,
      },
    }), submitted);
    assert.equal(submitted.statusCode, 201);
    assert.equal(input.workId, workId);
    assert.equal(input.userId, 'user-a');
    assert.deepEqual(input.analysisSettings, {
      locale: 'ja-JP',
      market: 'JP',
      aspect_ratio: '9:16',
      style_preset_id: 7,
    });
    assert.equal(submitted.body.data.task_id, 'task-redraw');
    assert.equal(submitted.body.data.provider_task_id, 'provider-redraw');
    assert.deepEqual(Object.keys(submitted.body.data.billing).sort(), ['charged', 'held', 'released']);
    assert.equal(submitted.body.data.current_step, 1);
  } finally {
    db.close();
  }
});

test('提交分析支持完整输出比例白名单并拒绝未知比例', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId);
    const acceptedRatios = [];
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      orchestrator: {
        startAnalysis: async (_db, _log, value) => {
          acceptedRatios.push(value.analysisSettings.aspect_ratio);
          return {
            task_id: `task-${acceptedRatios.length}`,
            provider_task_id: `provider-${acceptedRatios.length}`,
            billing: { charged: 0, held: 1, released: 0 },
          };
        },
      },
    }));

    for (const ratio of ['1:1', '9:16', '16:9', '3:4', '4:3', '21:9']) {
      const submitted = captureResponse();
      await handlers.analyzeWork(request({
        id: workId,
        body: {
          locale: 'ja-JP',
          aspect_ratio: ratio,
          style_preset_id: 7,
        },
      }), submitted);
      assert.equal(submitted.statusCode, 201);
    }

    const rejected = captureResponse();
    await handlers.analyzeWork(request({
      id: workId,
      body: {
        locale: 'ja-JP',
        aspect_ratio: '2:1',
        style_preset_id: 7,
      },
    }), rejected);

    assert.equal(rejected.statusCode, 400);
    assert.deepEqual(acceptedRatios, ['1:1', '9:16', '16:9', '3:4', '4:3', '21:9']);
  } finally {
    db.close();
  }
});

test('提交分析接受自由风格并保留参考图字段进入编排输入', async () => {
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
            task_id: 'task-redraw-free',
            provider_task_id: 'provider-redraw-free',
            billing: { charged: 0, held: 1, released: 0 },
          };
        },
      },
    }));

    const submitted = captureResponse();
    await handlers.analyzeWork(request({
      id: workId,
      body: {
        locale: 'en-US',
        market: 'US',
        aspect_ratio: '16:9',
        free_style: {
          positive: 'warm light',
          negative: 'blur',
          reference: { filename: 'style.png', id: 'asset-style' },
        },
      },
    }), submitted);

    assert.equal(submitted.statusCode, 201);
    assert.deepEqual(input.analysisSettings.free_style, {
      positive: 'warm light',
      negative: 'blur',
      reference: { filename: 'style.png', id: 'asset-style' },
    });
  } finally {
    db.close();
  }
});

test('提交分析 multipart 参考图登记为资产并写入自由风格 metadata', async () => {
  const db = createDb();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-reference-upload-'));
  try {
    insertVerifiedVideoUnderstandingConfig(db);
    prices.set(db, 'GPT-5.5', 6);
    creditLedger.setTenantAccountBalance(db, 'tenant-a', 100);
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId);
    const handlers = redrawRoutes(db, { error() {}, info() {} }, routeDeps({
      cfg: { storage: { local_path: tempRoot, base_url: '/static' } },
      uploadLimits: { storageRoot: tempRoot },
      orchestrator: realRedrawOrchestrator,
      analysisOptions: {
        provider: {
          startAnalysis: async () => ({ provider_task_id: 'provider-redraw-free-ref' }),
        },
      },
    }));

    const submitted = captureResponse();
    await handlers.analyzeWork(request({
      id: workId,
      body: {
        locale: 'en-US',
        market: 'US',
        aspect_ratio: '3:4',
        free_style: JSON.stringify({
          positive: 'warm light',
          negative: 'blur',
        }),
      },
      file: {
        originalname: 'style.png',
        mimetype: 'image/png',
        size: 7,
        buffer: Buffer.from('png-ref'),
      },
    }), submitted);

    assert.equal(submitted.statusCode, 201);
    const asset = db.prepare("SELECT * FROM assets WHERE category = 'redraw_style_reference' AND deleted_at IS NULL").get();
    assert.ok(asset);
    assert.equal(asset.name, 'style.png');
    assert.equal(asset.type, 'image');
    assert.match(asset.local_path, /^redraw-references\//);
    assert.ok(fs.existsSync(path.join(tempRoot, asset.local_path)));
    const task = db.prepare('SELECT metadata FROM async_tasks WHERE id = ?').get(submitted.body.data.task_id);
    const metadata = JSON.parse(task.metadata);
    assert.equal(metadata.redraw_analysis.free_style.reference.id, String(asset.id));
    assert.equal(metadata.redraw_analysis.free_style.reference.url, asset.url);
  } finally {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('阶段 2 资产审核路由返回门禁并禁止普通更新接口改审核状态', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 2, status: 'asset_review' });
    db.prepare(`INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, status, created_at, updated_at)
      VALUES (?, 'tenant-a', 'user-a', 1, 'en-US', 'US', 'asset_review', ?, ?)`).run(workId, NOW, NOW);
    const versionId = db.prepare('SELECT id FROM redraw_versions WHERE work_id = ?').get(workId).id;
    const assetNow = new Date().toISOString();
    db.prepare(`INSERT INTO redraw_assets
      (version_id, tenant_id, user_id, kind, source_ref_json, localized_name, asset_id,
       version_number, approval_status, status, created_at, updated_at)
      VALUES (?, 'tenant-a', 'user-a', 'scene', '{}', '场景', 990, 1, 'pending', 'generated', ?, ?)`).run(versionId, assetNow, assetNow);
    const asset = db.prepare('SELECT * FROM redraw_assets WHERE version_id = ?').get(versionId);
    db.prepare(`INSERT INTO redraw_shots
      (version_id, tenant_id, user_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
       references_json, status, created_at, updated_at)
      VALUES (?, 'tenant-a', 'user-a', 1, 1, 0, 1000, 1000, ?, 'draft', ?, ?)`).run(
      versionId, JSON.stringify([{ kind: 'scene', asset_id: asset.id }]), assetNow, assetNow,
    );
    const handlers = redrawRoutes(db, { error() {}, info() {} }, routeDeps({ canReadArtifact: () => true }));

    const gate = captureResponse();
    handlers.generationGate(request({ id: versionId }), gate);
    assert.equal(gate.statusCode, 200);
    assert.equal(gate.body.data.ok, false);
    assert.equal(gate.body.data.missing[0].asset_id, asset.id);

    const update = captureResponse();
    handlers.updateRedrawAsset(request({ id: asset.id, body: { approval_status: 'approved' } }), update);
    assert.equal(update.statusCode, 400);

    const review = captureResponse();
    handlers.reviewRedrawAsset(request({ id: asset.id, body: {
      action: 'approved',
      expected_updated_at: asset.updated_at,
    } }), review);
    assert.equal(review.statusCode, 200);
    assert.equal(review.body.data.asset.approval_status, 'approved');
    assert.equal(review.body.data.gate.ok, true);
  } finally {
    db.close();
  }
});
