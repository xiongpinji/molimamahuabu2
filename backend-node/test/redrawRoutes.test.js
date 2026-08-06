const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const redrawRoutes = require('../src/routes/redraw');
const { setupRouter } = require('../src/routes');
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

function insertVersion(db, workId, values = {}) {
  return db.prepare(`
    INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, market, localization_level,
       style_snapshot_json, status, created_at, updated_at, deleted_at)
    VALUES
      (@work_id, @tenant_id, @user_id, @version, @locale, @market, @localization_level,
       @style_snapshot_json, @status, @created_at, @updated_at, @deleted_at)
  `).run({
    work_id: workId,
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    version: 1,
    locale: 'en-US',
    market: 'US',
    localization_level: 'faithful',
    style_snapshot_json: '{}',
    status: 'ready_to_generate',
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...values,
  }).lastInsertRowid;
}

function insertRedrawAsset(db, versionId, values = {}) {
  return db.prepare(`
    INSERT INTO redraw_assets
      (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
       asset_id, version_number, approval_status, status, created_at, updated_at, deleted_at)
    VALUES
      (@version_id, @tenant_id, @user_id, @kind, @source_ref_json, @localized_name,
       @asset_id, @version_number, @approval_status, @status, @created_at, @updated_at, @deleted_at)
  `).run({
    version_id: versionId,
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    kind: 'character',
    source_ref_json: '{}',
    localized_name: 'Maya',
    asset_id: 701,
    version_number: 1,
    approval_status: 'approved',
    status: 'generated',
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...values,
  }).lastInsertRowid;
}

function insertShot(db, versionId, values = {}) {
  return db.prepare(`
    INSERT INTO redraw_shots
      (version_id, tenant_id, user_id, batch_index, shot_index, start_ms, end_ms,
       duration_ms, source_dialogue_json, localized_dialogue_json, references_json,
       opening_state, continuous_action, ending_state, prompt, negative_prompt,
       compiled_prompt_json, video_generation_id, status, error_code, error_message,
       draft_json, created_at, updated_at, deleted_at)
    VALUES
      (@version_id, @tenant_id, @user_id, @batch_index, @shot_index, @start_ms, @end_ms,
       @duration_ms, @source_dialogue_json, @localized_dialogue_json, @references_json,
       @opening_state, @continuous_action, @ending_state, @prompt, @negative_prompt,
       @compiled_prompt_json, @video_generation_id, @status, @error_code, @error_message,
       @draft_json, @created_at, @updated_at, @deleted_at)
  `).run({
    version_id: versionId,
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    batch_index: 1,
    shot_index: 1,
    start_ms: 0,
    end_ms: 6000,
    duration_ms: 6000,
    source_dialogue_json: '[]',
    localized_dialogue_json: '[]',
    references_json: '[]',
    opening_state: '',
    continuous_action: '',
    ending_state: '',
    prompt: 'Maya enters',
    negative_prompt: '',
    compiled_prompt_json: JSON.stringify({ text: 'Maya enters', revision: 1 }),
    video_generation_id: null,
    status: 'draft',
    error_code: null,
    error_message: null,
    draft_json: JSON.stringify({ revision: 1, model: 'seedance 2.0', duration: 6, resolution: '720p', count: 1 }),
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
        (id, type, status, progress, message, resource_id, tenant_id, user_id, created_at, updated_at)
      VALUES ('task-real-progress', 'redraw_analysis', 'processing', 64, '正在读取源片', ?, 'tenant-a', 'user-a', ?, ?)
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

test('作品详情按当前版本返回可恢复的 shots batches 任务与账单状态', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 3 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId, {
      status: 'processing',
      draft_json: JSON.stringify({
        revision: 2,
        new_video_ref: { asset_id: 9001, url: '/static/redraw-videos/shot.mp4' },
        generation: { reservation_id: 'reservation-api', task_id: 'task-api' },
      }),
    });
    creditLedger.setTenantAccountBalance(db, 'tenant-a', 100);
    const reservation = creditLedger.reserve(db, {
      tenantId: 'tenant-a',
      actorUserId: 'user-a',
      operationKey: 'redraw-route-api',
      model: 'seedance 2.0',
      resourceType: 'redraw_shot',
      resourceId: String(shotId),
      amount: 6,
    });
    db.prepare(`INSERT INTO async_tasks
      (id, type, status, progress, message, resource_id, tenant_id, user_id, metadata, created_at, updated_at)
      VALUES ('task-api', 'redraw_shot', 'processing', 42, '供应商处理中', ?, 'tenant-a', 'user-a', ?, ?, ?)`)
      .run(String(shotId), JSON.stringify({ redraw_shot: {
        reservation_id: reservation.id,
        quote: { amount: 6, unit_amount: 6, snapshot: { model: 'seedance 2.0' } },
      } }), NOW, NOW);
    const videoId = db.prepare(`INSERT INTO video_generations
      (prompt, model, duration, resolution, status, task_id, tenant_id, user_id, created_at, updated_at)
      VALUES ('Maya enters', 'seedance 2.0', 6, '720p', 'processing', 'task-api', 'tenant-a', 'user-a', ?, ?)`)
      .run(NOW, NOW).lastInsertRowid;
    db.prepare('UPDATE redraw_shots SET video_generation_id = ? WHERE id = ?').run(videoId, shotId);
    const handlers = redrawRoutes(db, { error() {}, warn() {} }, routeDeps());

    const processing = captureResponse();
    handlers.getWork(request({ id: workId }), processing);
    assert.equal(processing.statusCode, 200);
    assert.equal(processing.body.data.version_id, versionId);
    assert.equal(processing.body.data.shots.length, 1);
    assert.equal(processing.body.data.batches.length, 1);
    assert.equal(processing.body.data.shots[0].status, 'processing');
    assert.equal(processing.body.data.shots[0].video_generation_id, videoId);
    assert.deepEqual(processing.body.data.shots[0].new_video_ref, {
      asset_id: 9001,
      url: '/static/redraw-videos/shot.mp4',
    });
    assert.deepEqual(processing.body.data.shots[0].generation, {
      task_id: 'task-api',
      status: 'processing',
      progress: 42,
      message: '供应商处理中',
    });
    assert.deepEqual(processing.body.data.shots[0].billing, {
      held: 6,
      charged: 0,
      released: 0,
      quote: { amount: 6, unit_amount: 6, snapshot: { model: 'seedance 2.0' } },
    });

    creditLedger.confirm(db, reservation.id);
    db.prepare("UPDATE async_tasks SET status = 'completed', progress = 100, message = '完成' WHERE id = 'task-api'").run();
    db.prepare("UPDATE redraw_shots SET status = 'completed' WHERE id = ?").run(shotId);
    const refreshed = captureResponse();
    handlers.getWork(request({ id: workId }), refreshed);
    assert.equal(refreshed.body.data.shots[0].generation.status, 'completed');
    assert.equal(refreshed.body.data.shots[0].billing.held, 0);
    assert.equal(refreshed.body.data.shots[0].billing.charged, 6);
    assert.equal('confirmed' in refreshed.body.data.shots[0].billing, false);
  } finally {
    db.close();
  }
});

test('作品没有当前版本时返回空 shots 与 batches 且越权仍为 404', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 0 });
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const own = captureResponse();
    handlers.getWork(request({ id: workId }), own);
    assert.equal(own.statusCode, 200);
    assert.deepEqual(own.body.data.shots, []);
    assert.deepEqual(own.body.data.batches, []);

    const otherUser = captureResponse();
    handlers.getWork(request({ id: workId, userId: 'user-b' }), otherUser);
    assert.equal(otherUser.statusCode, 404);
  } finally {
    db.close();
  }
});

test('分镜更新要求乐观锁并只写白名单且按批准资产重新规范化', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const assetId = insertRedrawAsset(db, versionId);
    const shotId = insertShot(db, versionId, { status: 'failed', video_generation_id: 99 });
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const missingLock = captureResponse();
    handlers.updateShot(request({ id: shotId, body: { prompt: '@Maya runs' } }), missingLock);
    assert.equal(missingLock.statusCode, 400);
    assert.equal(missingLock.body.error.code, 'REDRAW_SHOT_LOCK_REQUIRED');

    const updated = captureResponse();
    handlers.updateShot(request({ id: shotId, body: {
      updated_at: NOW,
      start_ms: 1000,
      end_ms: 8000,
      prompt: '@Maya runs',
      references: [{ kind: 'character', asset_id: assetId }],
      model: 'seedance 2.0',
      duration: 7,
      resolution: '1080p',
      count: 1,
      status: 'completed',
      video_generation_id: 12345,
      tenant_id: 'tenant-b',
      version_id: 999,
      billing: { held: 0 },
    } }), updated);
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.data.start_ms, 1000);
    assert.equal(updated.body.data.duration_ms, 7000);
    assert.equal(updated.body.data.prompt, '@Maya runs');
    assert.equal(updated.body.data.references[0].asset_id, assetId);
    assert.equal(updated.body.data.draft.revision, 2);
    const stored = db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(shotId);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.video_generation_id, 99);
    assert.equal(stored.tenant_id, 'tenant-a');
    assert.equal(stored.version_id, versionId);
    const storedDraft = JSON.parse(stored.draft_json);
    const storedCompiled = JSON.parse(stored.compiled_prompt_json);
    const storedReferences = JSON.parse(stored.references_json);
    assert.equal(storedDraft.prompt, stored.prompt);
    assert.equal(storedCompiled.text, stored.prompt);
    assert.deepEqual(storedDraft.references, storedReferences);
    assert.deepEqual(storedCompiled.references, storedReferences);
    assert.equal(storedDraft.duration, storedCompiled.duration);

    const conflict = captureResponse();
    handlers.updateShot(request({ id: shotId, body: { updated_at: NOW, prompt: '@Maya waits' } }), conflict);
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.body.error.code, 'REDRAW_SHOT_CONFLICT');
  } finally {
    db.close();
  }
});

test('分镜更新的 version 锁校验 draft revision 并拒绝未知或未审批引用', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    insertRedrawAsset(db, versionId, { localized_name: '草稿道具', kind: 'prop', approval_status: 'pending' });
    const shotId = insertShot(db, versionId);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const versionConflict = captureResponse();
    handlers.updateShot(request({ id: shotId, body: { version: 999, prompt: 'new' } }), versionConflict);
    assert.equal(versionConflict.statusCode, 409);
    assert.equal(versionConflict.body.error.code, 'REDRAW_SHOT_CONFLICT');

    const unknown = captureResponse();
    handlers.updateShot(request({ id: shotId, body: {
      version: 1,
      references: [{ kind: 'prop', asset_id: 99999 }],
    } }), unknown);
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.body.error.code, 'REDRAW_SHOT_INVALID');

    const pending = captureResponse();
    handlers.updateShot(request({ id: shotId, body: {
      version: 1,
      references: ['@草稿道具'],
    } }), pending);
    assert.equal(pending.statusCode, 400);
    assert.equal(pending.body.error.code, 'REDRAW_SHOT_INVALID');
  } finally {
    db.close();
  }
});

test('结构化引用在资产重名时仍保持请求的精确资产身份', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const requestedAssetId = insertRedrawAsset(db, versionId, { localized_name: 'Maya', asset_id: 701 });
    const otherAssetId = insertRedrawAsset(db, versionId, { localized_name: 'Maya', asset_id: 702 });
    const shotId = insertShot(db, versionId);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const updated = captureResponse();
    handlers.updateShot(request({ id: shotId, body: {
      updated_at: NOW,
      references: [{ kind: 'character', asset_id: requestedAssetId }],
    } }), updated);

    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.data.references[0].asset_id, requestedAssetId);
    assert.notEqual(updated.body.data.references[0].asset_id, otherAssetId);
  } finally {
    db.close();
  }
});

test('旧分镜缺少生成设置时仍可编辑并补齐安全默认值', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId, {
      draft_json: JSON.stringify({ revision: 1 }),
      compiled_prompt_json: '{}',
    });
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());
    const updated = captureResponse();

    handlers.updateShot(request({ id: shotId, body: {
      updated_at: NOW,
      prompt: 'legacy shot edited',
    } }), updated);

    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.data.draft.model, 'seedance 2.0');
    assert.equal(updated.body.data.draft.duration, 6);
    assert.equal(updated.body.data.draft.resolution, '720p');
    assert.equal(updated.body.data.draft.count, 1);
  } finally {
    db.close();
  }
});

test('单镜生成与显式重试统一调用 generation service 并返回 202', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId);
    const calls = [];
    const generationService = {
      generateShot: async (context, input) => {
        calls.push({ method: 'generate', context, input });
        return { task_id: 'same-task', status: 'processing', billing: { held: 6, charged: 0, released: 0 } };
      },
      retryShot: async (context, input) => {
        calls.push({ method: 'retry', context, input });
        return { task_id: 'retry-task', status: 'processing', billing: { held: 6, charged: 0, released: 0 } };
      },
    };
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({ generationService }));

    const first = captureResponse();
    await handlers.generateShot(request({ id: shotId, body: { model: 'seedance 2.0' } }), first);
    const duplicate = captureResponse();
    await handlers.generateShot(request({ id: shotId, body: { model: 'seedance 2.0' } }), duplicate);
    const retry = captureResponse();
    await handlers.generateShot(request({ id: shotId, body: { retry: true } }), retry);

    assert.equal(first.statusCode, 202);
    assert.equal(duplicate.body.data.task_id, 'same-task');
    assert.equal(retry.statusCode, 202);
    assert.equal(retry.body.data.task_id, 'retry-task');
    assert.deepEqual(calls.map((call) => call.method), ['generate', 'generate', 'retry']);
    assert.equal(calls[0].context.tenantId, 'tenant-a');
    assert.equal(calls[0].context.userId, 'user-a');
    assert.equal(calls[0].input.shotId, shotId);
  } finally {
    db.close();
  }
});

test('分镜更新和生成对跨租户或跨用户统一返回 404 且不调用 generation service', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId);
    let calls = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      generationService: {
        generateShot: async () => { calls += 1; },
        retryShot: async () => { calls += 1; },
      },
    }));

    const tenantUpdate = captureResponse();
    handlers.updateShot(request({ id: shotId, tenantId: 'tenant-b', body: { updated_at: NOW } }), tenantUpdate);
    const userGenerate = captureResponse();
    await handlers.generateShot(request({ id: shotId, userId: 'user-b' }), userGenerate);

    assert.equal(tenantUpdate.statusCode, 404);
    assert.equal(tenantUpdate.body.error.code, 'REDRAW_SHOT_NOT_FOUND');
    assert.equal(userGenerate.statusCode, 404);
    assert.equal(userGenerate.body.error.code, 'REDRAW_SHOT_NOT_FOUND');
    assert.equal(calls, 0);
  } finally {
    db.close();
  }
});

test('单镜生成错误保持结构化 code details 与规定 HTTP 状态', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId);
    const failures = [
      ['REDRAW_ASSET_REVIEW_REQUIRED', 409, { missing: [{ asset_id: 7 }] }],
      ['INSUFFICIENT_CREDITS', 402, undefined],
      ['REDRAW_SHOT_PRICING_UNCONFIGURED', 409, undefined],
      ['REDRAW_RETRY_UNCERTAIN', 409, undefined],
      ['INVALID_REDRAW_GENERATION_INPUT', 400, undefined],
    ];
    for (const [code, expectedStatus, details] of failures) {
      const error = Object.assign(new Error(`error ${code}`), { code, details });
      const handlers = redrawRoutes(db, { error() {} }, routeDeps({
        generationService: { generateShot: async () => { throw error; }, retryShot: async () => { throw error; } },
      }));
      const result = captureResponse();
      await handlers.generateShot(request({ id: shotId }), result);
      assert.equal(result.statusCode, expectedStatus);
      assert.equal(result.body.success, false);
      assert.equal(result.body.error.code, code);
      assert.deepEqual(result.body.error.details, details);
    }
  } finally {
    db.close();
  }
});

test('未审批单镜生成返回 409 missing 且不会冻结积分或调用 provider', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const assetId = insertRedrawAsset(db, versionId, { approval_status: 'pending' });
    const shotId = insertShot(db, versionId, {
      references_json: JSON.stringify([{ kind: 'character', asset_id: assetId }]),
    });
    creditLedger.setTenantAccountBalance(db, 'tenant-a', 100);
    let providerCalls = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      generationOptions: { videoProcessor: async () => { providerCalls += 1; } },
    }));
    const result = captureResponse();
    await handlers.generateShot(request({ id: shotId }), result);

    assert.equal(result.statusCode, 409);
    assert.equal(result.body.error.code, 'REDRAW_ASSET_REVIEW_REQUIRED');
    assert.equal(result.body.error.details.missing[0].asset_id, assetId);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_shot'").get().count, 0);
    assert.equal(providerCalls, 0);
  } finally {
    db.close();
  }
});

test('批量生成严格绑定作品当前版本并拒绝 singular shot_id', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const otherWorkId = insertWork(db, projectId, { current_version: 1, source_fingerprint: 'e'.repeat(64) });
    const otherVersionId = insertVersion(db, otherWorkId);
    const calls = [];
    const generationService = {
      generateBatch: async (context, input) => {
        calls.push({ context, input });
        return { version_id: input.versionId, results: [{ shot_id: 1, status: 'processing', billing: { held: 6 } }], skipped: [] };
      },
    };
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({ generationService }));

    const current = captureResponse();
    await handlers.generateBatch(request({ id: workId, body: {} }), current);
    assert.equal(current.statusCode, 202);
    assert.equal(calls[0].input.versionId, versionId);

    const mismatch = captureResponse();
    await handlers.generateBatch(request({ id: workId, body: { version_id: otherVersionId } }), mismatch);
    assert.equal(mismatch.statusCode, 409);
    assert.equal(mismatch.body.error.code, 'REDRAW_VERSION_CONFLICT');

    const singular = captureResponse();
    await handlers.generateBatch(request({ id: workId, body: { shot_id: 1 } }), singular);
    assert.equal(singular.statusCode, 400);
    assert.equal(singular.body.error.code, 'REDRAW_BATCH_INPUT_INVALID');

    const otherOwner = captureResponse();
    await handlers.generateBatch(request({ id: workId, userId: 'user-b' }), otherOwner);
    assert.equal(otherOwner.statusCode, 404);
    assert.equal(calls.length, 1);
  } finally {
    db.close();
  }
});

test('客户端 attempt 不能绕过 processing 幂等并制造第二次任务与冻结', async () => {
  const db = createDb();
  try {
    prices.set(db, 'seedance 2.0', 2, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '720p': { credits: 3 } },
    });
    creditLedger.setTenantAccountBalance(db, 'tenant-a', 100);
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 3 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId);
    const scheduled = [];
    const handlers = redrawRoutes(db, { error() {}, warn() {}, info() {} }, routeDeps({
      generationOptions: { schedule: (callback) => scheduled.push(callback) },
    }));

    const first = captureResponse();
    await handlers.generateShot(request({ id: shotId, body: {} }), first);
    const injectedAttempt = captureResponse();
    await handlers.generateShot(request({ id: shotId, body: { attempt: 2 } }), injectedAttempt);
    const summary = {
      firstStatus: first.statusCode,
      secondStatus: injectedAttempt.statusCode,
      secondCode: injectedAttempt.body?.error?.code,
      tasks: db.prepare("SELECT COUNT(*) AS n FROM async_tasks WHERE type = 'redraw_shot'").get().n,
      videos: db.prepare('SELECT COUNT(*) AS n FROM video_generations WHERE deleted_at IS NULL').get().n,
      reservations: db.prepare("SELECT COUNT(*) AS n FROM tenant_usage_reservations WHERE resource_type = 'redraw_shot'").get().n,
      held: creditLedger.getTenantAccount(db, 'tenant-a').held,
      scheduled: scheduled.length,
    };
    assert.deepEqual(summary, {
      firstStatus: 202,
      secondStatus: 400,
      secondCode: 'REDRAW_GENERATION_INPUT_INVALID',
      tasks: 1,
      videos: 1,
      reservations: 1,
      held: 18,
      scheduled: 1,
    });
  } finally {
    db.close();
  }
});

test('processing 镜头正常重复生成返回原任务且只保留一次冻结', async () => {
  const db = createDb();
  try {
    prices.set(db, 'seedance 2.0', 2, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '720p': { credits: 3 } },
    });
    creditLedger.setTenantAccountBalance(db, 'tenant-a', 100);
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 3 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId);
    const handlers = redrawRoutes(db, { error() {}, warn() {}, info() {} }, routeDeps({
      generationOptions: { schedule() {} },
    }));

    const first = captureResponse();
    await handlers.generateShot(request({ id: shotId }), first);
    const second = captureResponse();
    await handlers.generateShot(request({ id: shotId }), second);

    assert.equal(first.statusCode, 202);
    assert.equal(second.statusCode, 202);
    assert.equal(second.body.data.task_id, first.body.data.task_id);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM async_tasks WHERE type = 'redraw_shot'").get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_generations WHERE deleted_at IS NULL').get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tenant_usage_reservations WHERE resource_type = 'redraw_shot'").get().n, 1);
    assert.equal(creditLedger.getTenantAccount(db, 'tenant-a').held, 18);
  } finally {
    db.close();
  }
});

test('生成接口严格拒绝内部控制字段、未知字段与非 1 count', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId);
    let calls = 0;
    const generationService = {
      generateShot: async () => { calls += 1; return { status: 'processing' }; },
      retryShot: async () => { calls += 1; return { status: 'processing' }; },
      generateBatch: async () => { calls += 1; return { results: [], skipped: [] }; },
    };
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({ generationService }));
    const invalidSingle = [
      { attempt: 2 },
      { operation_key: 'attacker-key' },
      { awaitCompletion: true },
      { schedule: 'inline' },
      { count: 1 },
      { retry: 'true' },
      { unknown_field: true },
    ];
    for (const body of invalidSingle) {
      const result = captureResponse();
      await handlers.generateShot(request({ id: shotId, body }), result);
      assert.equal(result.statusCode, 400, JSON.stringify(body));
      assert.equal(result.body.error.code, 'REDRAW_GENERATION_INPUT_INVALID');
    }
    const invalidBatch = [
      { attempt: 2 },
      { operation_key: 'attacker-key' },
      { schedule: true },
      { count: 2 },
      { retry: true },
      { unknown_field: true },
    ];
    for (const body of invalidBatch) {
      const result = captureResponse();
      await handlers.generateBatch(request({ id: workId, body }), result);
      assert.equal(result.statusCode, 400, JSON.stringify(body));
      assert.equal(result.body.error.code, 'REDRAW_GENERATION_INPUT_INVALID');
    }
    assert.equal(calls, 0);
  } finally {
    db.close();
  }
});

test('processing 等非可编辑状态拒绝 PUT 且不改变生成快照', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const originalDraft = JSON.stringify({ revision: 1, model: 'seedance 2.0', duration: 6, resolution: '720p', count: 1 });
    const shotId = insertShot(db, versionId, { status: 'processing', draft_json: originalDraft });
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    for (const status of ['processing', 'completed', 'needs_attention', 'pending']) {
      db.prepare('UPDATE redraw_shots SET status = ?, draft_json = ?, prompt = ? WHERE id = ?')
        .run(status, originalDraft, 'original prompt', shotId);
      const result = captureResponse();
      handlers.updateShot(request({ id: shotId, body: {
        updated_at: NOW,
        prompt: 'attacker edit during generation',
      } }), result);
      assert.equal(result.statusCode, 409, status);
      assert.equal(result.body.error.code, 'REDRAW_SHOT_EDIT_CONFLICT');
      const stored = db.prepare('SELECT status, draft_json, prompt FROM redraw_shots WHERE id = ?').get(shotId);
      assert.deepEqual(stored, { status, draft_json: originalDraft, prompt: 'original prompt' });
    }
  } finally {
    db.close();
  }
});

test('作品分析任务脏指针跨租户时不回显任务状态', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { task_id: 'dirty-analysis-task' });
    db.prepare(`INSERT INTO async_tasks
      (id, type, status, progress, message, resource_id, tenant_id, user_id, created_at, updated_at)
      VALUES ('dirty-analysis-task', 'redraw_analysis', 'processing', 88, '其他租户私有状态', ?, 'tenant-b', 'user-b', ?, ?)`)
      .run(String(workId), NOW, NOW);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());
    const result = captureResponse();

    handlers.getWork(request({ id: workId }), result);

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.data.task_status, null);
    assert.equal(result.body.data.task_progress, null);
    assert.equal(result.body.data.task_message, null);
  } finally {
    db.close();
  }
});

test('作品分析账单按冻结 reservation 返回 held charged released 与冻结报价', () => {
  const db = createDb();
  try {
    creditLedger.setTenantAccountBalance(db, 'tenant-a', 100);
    const projectId = insertProject(db);
    const expectedByStatus = {
      held: { held: 6, charged: 0, released: 0 },
      confirmed: { held: 0, charged: 6, released: 0 },
      refunded: { held: 0, charged: 0, released: 6 },
    };
    for (const [index, status] of ['held', 'confirmed', 'refunded'].entries()) {
      const workId = insertWork(db, projectId, { source_fingerprint: String(index + 1).repeat(64) });
      const reservation = creditLedger.reserve(db, {
        tenantId: 'tenant-a',
        actorUserId: 'user-a',
        operationKey: `analysis-billing-${status}`,
        model: 'GPT-5.5-frozen',
        resourceType: 'redraw_analysis',
        resourceId: String(workId),
        amount: 6,
      });
      if (status === 'confirmed') creditLedger.confirm(db, reservation.id);
      if (status === 'refunded') creditLedger.refund(db, reservation.id, 'analysis_failed');
      db.prepare('UPDATE redraw_works SET credit_reservation_id = ? WHERE id = ?').run(reservation.id, workId);
      const handlers = redrawRoutes(db, { error() {} }, routeDeps({ quoteAnalysis: () => ({ amount: 999 }) }));
      const result = captureResponse();
      handlers.getWork(request({ id: workId }), result);
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.body.data.analysis_billing, {
        ...expectedByStatus[status],
        quote: { model: 'GPT-5.5-frozen', amount: 6 },
      });
    }
  } finally {
    db.close();
  }
});

test('批量生成显式历史版本返回冲突且零调用零冻结', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 2 });
    const historicalVersionId = insertVersion(db, workId, { version: 1 });
    insertVersion(db, workId, { version: 2 });
    let calls = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      generationService: { generateBatch: async () => { calls += 1; return {}; } },
    }));
    const result = captureResponse();

    await handlers.generateBatch(request({ id: workId, body: { version_id: historicalVersionId } }), result);

    assert.equal(result.statusCode, 409);
    assert.equal(result.body.error.code, 'REDRAW_VERSION_CONFLICT');
    assert.equal(calls, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tenant_usage_reservations WHERE resource_type = 'redraw_shot'").get().n, 0);
  } finally {
    db.close();
  }
});

test('第三步四个转绘分镜 API 已真实注册在总路由', () => {
  const db = createDb();
  try {
    const router = setupRouter({}, db, { error() {}, warn() {}, info() {} });
    const routes = new Set(router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route.methods)
        .map((method) => `${method.toUpperCase()} ${layer.route.path}`)));
    assert.equal(routes.has('GET /redraw/works/:id'), true);
    assert.equal(routes.has('PUT /redraw/shots/:id'), true);
    assert.equal(routes.has('POST /redraw/shots/:id/generate'), true);
    assert.equal(routes.has('POST /redraw/works/:id/generate-batch'), true);
  } finally {
    db.close();
  }
});
