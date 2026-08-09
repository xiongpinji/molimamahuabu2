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
const redrawCapabilityService = require('../src/services/redrawCapabilityService');

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
       style_snapshot_json, localization_task_id, status, created_at, updated_at, deleted_at)
    VALUES
      (@work_id, @tenant_id, @user_id, @version, @locale, @market, @localization_level,
       @style_snapshot_json, @localization_task_id, @status, @created_at, @updated_at, @deleted_at)
  `).run({
    work_id: workId,
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    version: 1,
    locale: 'en-US',
    market: 'US',
    localization_level: 'faithful',
    style_snapshot_json: '{}',
    localization_task_id: null,
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

function insertAssetBatch(db, versionId, values = {}) {
  return db.prepare(`
    INSERT INTO redraw_asset_batches
      (version_id, tenant_id, user_id, task_id, idempotency_key, quote_snapshot_json,
       asset_ids_json, status, total_count, success_count, failed_count, created_at, updated_at, deleted_at)
    VALUES
      (@version_id, @tenant_id, @user_id, @task_id, @idempotency_key, @quote_snapshot_json,
       @asset_ids_json, @status, @total_count, @success_count, @failed_count, @created_at, @updated_at, @deleted_at)
  `).run({
    version_id: versionId,
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    task_id: 'task-asset-batch',
    idempotency_key: `asset-batch-${versionId}`,
    quote_snapshot_json: '{}',
    asset_ids_json: '[]',
    status: 'pending',
    total_count: 1,
    success_count: 0,
    failed_count: 0,
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
  const generationOptions = {
    resolveVideoConditioningCapability: (_db, model, verifiedCapability) => verifiedCapability && ({
      ...verifiedCapability,
      model,
      protocol: 'feituo_open',
      max_videos: 1,
    }),
    prepareSourceConditioning: async ({ shot }) => {
      const billingSnapshot = {
        source_asset_id: Number(shot.source_asset_id),
        source_fingerprint: String(shot.source_fingerprint),
        start_ms: Number(shot.start_ms),
        end_ms: Number(shot.end_ms),
        segment_sha256: 'e'.repeat(64),
      };
      return {
        referenceVideoUrl: `https://storage.example.com/api/v1/redraw-provider-assets/${'e'.repeat(64)}.mp4?expires=4102444800&sig=test-only`,
        billingSnapshot,
        auditSnapshot: { ...billingSnapshot, relative_path: `redraw-conditioning/${'e'.repeat(64)}.mp4` },
      };
    },
    ...(overrides.generationOptions || {}),
  };
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
    localeVerifier: {
      assertReady(locale) {
        return {
          id: `${locale}@fixture`,
          model_manifest_sha256: 'a'.repeat(64),
          calibration_manifest_sha256: 'b'.repeat(64),
        };
      },
    },
    orchestrator: {
      startAnalysis: async () => ({
        task_id: 'task-redraw',
        provider_task_id: 'provider-redraw',
        billing: { charged: 0, held: 1, released: 0 },
      }),
    },
    localizationOrchestrator: {
      quoteLocalization: () => ({ priced: true, credits: 7, model: 'gpt-localize', quote_hash: 'quote-ok' }),
      startLocalization: () => ({
        task_id: 'task-localize',
        draft_version_id: 2,
        status: 'pending',
        billing: { charged: 0, held: 7, released: 0 },
        completion: Promise.resolve(),
      }),
    },
    assetGenerationProvider: async () => ({ status: 'completed' }),
    dialogueOrchestrator: {
      quoteDialogue: () => ({ status: 'ready', total_credits: 4, quote_hash: 'dialogue-quote-ok' }),
      startDialogue: () => ({
        task_id: 'task-dialogue',
        status: 'pending',
        quote: { status: 'ready', total_credits: 4, quote_hash: 'dialogue-quote-ok' },
        completion: new Promise(() => {}),
      }),
    },
    ...overrides,
    generationOptions,
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

function insertSourceAsset(db, values = {}) {
  const now = values.created_at || NOW;
  return db.prepare(`
    INSERT INTO assets
      (name, type, category, url, local_path, file_size, mime_type, duration, metadata, created_at, updated_at, deleted_at)
    VALUES
      (@name, @type, @category, @url, @local_path, @file_size, @mime_type, @duration, @metadata, @created_at, @updated_at, @deleted_at)
  `).run({
    name: 'source.mp4',
    type: 'video',
    category: 'redraw_source',
    url: '',
    local_path: 'redraw-sources/source.mp4',
    file_size: 1234,
    mime_type: 'video/mp4',
    duration: 9,
    metadata: '{}',
    created_at: now,
    updated_at: now,
    deleted_at: null,
    ...values,
  }).lastInsertRowid;
}

function insertVerifiedVoiceTtsConfig(db, values = {}) {
  const provider = values.provider || 'voice-provider-b';
  const model = values.model || 'voice-model';
  const updatedAt = values.updated_at || NOW;
  const configId = Number(db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, model, default_model, priority, is_default, is_active,
     settings, created_at, updated_at)
    VALUES ('tts', ?, ?, ?, ?, ?, ?, 1, '{}', ?, ?)`)
    .run(
      provider,
      values.name || provider,
      JSON.stringify([model]),
      model,
      values.priority ?? 0,
      values.is_default ? 1 : 0,
      NOW,
      updatedAt,
    ).lastInsertRowid);
  if (values.capability !== false) {
    db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = ?').run(JSON.stringify({
      redraw_locale_capabilities: [{
        locale: 'en-US',
        market: 'US',
        status: 'verified',
        evidence: {
          tts: {
            provider,
            model,
            task_id: values.task_id || 'verified-voice-task',
            terminal_status: 'completed',
            artifact_id: 900,
            ai_service_config_id: configId,
            config_updated_at: values.evidence_updated_at || updatedAt,
          },
        },
      }],
    }), configId);
  }
  return configId;
}

function setupAssetBatchFixture(db, values = {}) {
  const projectId = insertProject(db, values.project || {});
  const workId = insertWork(db, projectId, {
    current_version: 1,
    current_step: 2,
    status: 'asset_review',
    ...(values.work || {}),
  });
  const versionId = insertVersion(db, workId, { status: 'asset_review', ...(values.version || {}) });
  const assetId = insertRedrawAsset(db, versionId, {
    source_ref_json: JSON.stringify({ source_ref: { kind: 'character', id: 'character-1' } }),
    asset_id: null,
    approval_status: 'pending',
    status: 'draft',
    ...(values.asset || {}),
  });
  return { projectId, workId, versionId, assetId };
}

function makeAssetBatchService(overrides = {}) {
  return {
    quoteAssetBatch: overrides.quoteAssetBatch || (() => ({
      priced: true,
      version_id: 1,
      total_credits: 7,
      items: [{ asset_id: 1, credits: 7, model: 'server-model', provider: 'server-provider' }],
      blocked: [],
      quote_hash: 'quote-ok',
    })),
    startAssetBatch: overrides.startAssetBatch || (() => ({
      batch: { id: 10, status: 'pending', attempt_ids: [1], asset_ids: [1] },
      task: { id: 'task-batch', status: 'pending' },
      completion: new Promise(() => {}),
    })),
  };
}

function insertRedrawLocaleCapabilityConfig(db, entries) {
  const now = new Date().toISOString();
  const inserted = db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('video', 'test-provider', '转绘生成能力', ?, ?, 1, 1, 0, ?, ?, ?)
  `).run(
    JSON.stringify(entries.map((entry) => entry.evidence?.video?.model || 'unverified-model')),
    entries[0]?.evidence?.video?.model || 'unverified-model',
    '{}',
    now,
    now,
  );
  const configId = Number(inserted.lastInsertRowid);
  const boundEntries = entries.map((entry) => ({
    ...entry,
    evidence: entry.evidence?.video ? {
      ...entry.evidence,
      video: {
        config_id: configId,
        config_updated_at: now,
        ...entry.evidence.video,
      },
    } : entry.evidence,
  }));
  db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = ?')
    .run(JSON.stringify({ redraw_locale_capabilities: boundEntries }), configId);
}

function verifiedVideoCapability(model = 'seedance 2.0', overrides = {}) {
  return {
    locale: 'en-US',
    market: 'US',
    status: 'verified',
    evidence: {
      video: {
        provider: 'test-provider',
        model,
        task_id: `verified-${model}`,
        terminal_status: 'completed',
        artifact_id: `artifact-${model}`,
      },
    },
    ...overrides,
  };
}

function nativeDialogueEvidence(configId, configUpdatedAt, artifactId = 771) {
  return {
    contract: 'redraw-native-dialogue-audio-v1',
    provider: 'test-provider',
    protocol: 'feituo_open',
    model: 'seedance-2-fast',
    config_id: configId,
    config_updated_at: configUpdatedAt,
    provider_task_id: 'provider-native-dialogue-real',
    terminal_status: 'completed',
    artifact_id: artifactId,
    artifact_sha256: 'd'.repeat(64),
    media: { video_stream: true, audio_stream: true },
    locale_verification: {
      language: 'es',
      language_verified: true,
      locale_verified: false,
    },
    human_review: {
      status: 'passed',
      speaker_order: 'passed',
      lip_sync: 'passed',
      extra_dialogue: 'passed',
    },
  };
}

function insertNativeDialogueLocaleConfig(db, values = {}) {
  const now = values.updated_at || NOW;
  const language = values.language || 'es';
  const locale = values.locale || 'es';
  const targetLocale = Object.prototype.hasOwnProperty.call(values, 'target_locale') ? values.target_locale : null;
  const market = Object.prototype.hasOwnProperty.call(values, 'market') ? values.market : '';
  const configId = Number(db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, api_protocol, name, model, default_model, is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('video', 'test-provider', 'feituo_open', '原生对白能力', 'seedance-2-fast', 'seedance-2-fast', 1, 1, 0, '{}', ?, ?)
  `).run(NOW, now).lastInsertRowid);
  db.prepare('UPDATE ai_service_configs SET settings = ? WHERE id = ?').run(JSON.stringify({
    redraw_locale_capabilities: [{
      language,
      locale,
      target_language: language,
      target_locale: targetLocale,
      market,
      status: 'verified',
      evidence: {
        text: {
          provider: 'test-provider',
          model: 'seedance-2-fast',
          task_id: 'text-task',
          terminal_status: 'completed',
          artifact_id: 772,
        },
        subtitles: {
          provider: 'test-provider',
          model: 'seedance-2-fast',
          task_id: 'subtitles-task',
          terminal_status: 'completed',
          artifact_id: 773,
        },
        character_image: {
          provider: 'test-provider',
          model: 'seedance-2-fast',
          task_id: 'character-task',
          terminal_status: 'completed',
          artifact_id: 774,
        },
        clean_plate_image: {
          provider: 'test-provider',
          model: 'seedance-2-fast',
          task_id: 'clean-plate-task',
          terminal_status: 'completed',
          artifact_id: 775,
        },
        video: {
          provider: 'test-provider',
          model: 'seedance-2-fast',
          task_id: 'video-task',
          terminal_status: 'completed',
          artifact_id: 776,
        },
        native_dialogue_audio: values.evidence || nativeDialogueEvidence(configId, now),
      },
    }],
  }), configId);
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

test('语言目录真实响应只暴露已验证原生对白语言级能力', () => {
  const db = createDb();
  try {
    insertNativeDialogueLocaleConfig(db);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      capabilityService: redrawCapabilityService,
      canReadArtifact: (assetId) => [771, 772, 773, 774, 775, 776].includes(Number(assetId)),
    }));

    const locales = captureResponse();
    handlers.listLocales(request(), locales);

    assert.equal(locales.statusCode, 200);
    assert.deepEqual(locales.body.data, [{
      locale: 'es',
      market: '',
      language: 'es',
      region_status: 'unverified',
      audio_mode: 'native',
      native_dialogue_audio: true,
      locale_verified: false,
      status: 'full_output',
      blocking: [],
    }]);
  } finally {
    db.close();
  }
});

test('语言目录真实响应不展示 human review 缺字段的原生对白能力', () => {
  const db = createDb();
  try {
    const evidence = nativeDialogueEvidence(1, NOW);
    delete evidence.human_review.lip_sync;
    insertNativeDialogueLocaleConfig(db, { evidence });
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      capabilityService: redrawCapabilityService,
      canReadArtifact: (assetId) => [771, 772, 773, 774, 775, 776].includes(Number(assetId)),
    }));

    const locales = captureResponse();
    handlers.listLocales(request(), locales);

    assert.equal(locales.statusCode, 200);
    assert.deepEqual(locales.body.data, [{
      locale: 'es',
      market: '',
      language: 'es',
      region_status: 'unverified',
      audio_mode: null,
      native_dialogue_audio: false,
      locale_verified: false,
      status: 'subtitle_only',
      blocking: ['tts', 'native_dialogue_audio'],
    }]);
  } finally {
    db.close();
  }
});

test('语言目录真实响应不展示人工覆盖通过的原生对白能力', () => {
  const db = createDb();
  try {
    const evidence = nativeDialogueEvidence(1, NOW);
    evidence.human_review.manual_override = true;
    insertNativeDialogueLocaleConfig(db, { evidence });
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      capabilityService: redrawCapabilityService,
      canReadArtifact: (assetId) => [771, 772, 773, 774, 775, 776].includes(Number(assetId)),
    }));

    const locales = captureResponse();
    handlers.listLocales(request(), locales);

    assert.equal(locales.statusCode, 200);
    assert.deepEqual(locales.body.data, [{
      locale: 'es',
      market: '',
      language: 'es',
      region_status: 'unverified',
      audio_mode: null,
      native_dialogue_audio: false,
      locale_verified: false,
      status: 'subtitle_only',
      blocking: ['tts', 'native_dialogue_audio'],
    }]);
  } finally {
    db.close();
  }
});

test('语言目录真实响应不把原生对白语言证据提升为地区能力', () => {
  const db = createDb();
  try {
    insertNativeDialogueLocaleConfig(db, {
      locale: 'es-MX',
      target_locale: 'es-MX',
      market: 'MX',
    });
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      capabilityService: redrawCapabilityService,
      canReadArtifact: (assetId) => [771, 772, 773, 774, 775, 776].includes(Number(assetId)),
    }));

    const locales = captureResponse();
    handlers.listLocales(request(), locales);

    assert.equal(locales.statusCode, 200);
    assert.deepEqual(locales.body.data, [{
      locale: 'es-MX',
      market: 'MX',
      language: 'es',
      region_status: 'unverified',
      audio_mode: null,
      native_dialogue_audio: false,
      locale_verified: false,
      status: 'subtitle_only',
      blocking: ['tts', 'native_dialogue_audio'],
    }]);
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

test('同步原生分析完成时接口直接返回步骤 2 和已结算账单', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      orchestrator: {
        startAnalysis: async () => ({
          task_id: 'task-native-complete',
          provider_task_id: 'response-native-complete',
          status: 'completed',
          current_step: 2,
          facts_hash: 'a'.repeat(64),
          billing: { charged: 6, held: 0, released: 0 },
        }),
      },
    }));

    const submitted = captureResponse();
    await handlers.analyzeWork(request({
      id: workId,
      body: {
        locale: 'en-US',
        market: 'US',
        aspect_ratio: '9:16',
        style_preset_id: 1,
      },
    }), submitted);

    assert.equal(submitted.statusCode, 201);
    assert.equal(submitted.body.data.current_step, 2);
    assert.equal(submitted.body.data.status, 'completed');
    assert.equal(submitted.body.data.facts_hash, 'a'.repeat(64));
    assert.deepEqual(submitted.body.data.billing, { charged: 6, held: 0, released: 0 });
  } finally {
    db.close();
  }
});

test('未注入外部分析器时路由使用原生视觉服务完成真实编排合同', async () => {
  const db = createDb();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-native-route-'));
  try {
    insertVerifiedVideoUnderstandingConfig(db);
    prices.set(db, 'GPT-5.5', 6);
    creditLedger.setTenantAccountBalance(db, 'tenant-a', 100);
    fs.mkdirSync(path.join(tempRoot, 'redraw-sources'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'redraw-analysis'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'redraw-sources', 'source.mp4'), 'source');
    fs.writeFileSync(path.join(tempRoot, 'redraw-analysis', 'result.json'), '{}');
    db.prepare(`INSERT INTO assets
      (id, name, type, category, local_path, created_at, updated_at)
      VALUES (101, 'source', 'video', 'redraw_source', 'redraw-sources/source.mp4', ?, ?)`)
      .run(NOW, NOW);
    db.prepare(`INSERT INTO assets
      (id, name, type, category, local_path, created_at, updated_at)
      VALUES (102, 'analysis', 'json', 'redraw_source_analysis', 'redraw-analysis/result.json', ?, ?)`)
      .run(NOW, NOW);
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId);
    let nativeInput;
    const handlers = redrawRoutes(db, { error() {}, warn() {}, info() {} }, routeDeps({
      cfg: { storage: { local_path: tempRoot } },
      uploadLimits: { storageRoot: tempRoot },
      orchestrator: realRedrawOrchestrator,
      nativeSourceAnalysis: async (_ctx, input) => {
        nativeInput = input;
        return {
          status: 'completed',
          provider_task_id: 'response-native-route',
          result_asset_id: 102,
          facts: {
            duration_ms: 90_000,
            characters: [{ id: 'c1', source_name: '小满', relationships: [] }],
            scenes: [{ id: 's1', location: '天台', time: '夜', source_ranges: [{ start_ms: 0, end_ms: 90_000 }] }],
            props: [{ id: 'p1', name: '手机', evidence_ranges: [{ start_ms: 500, end_ms: 1_500 }] }],
            shots: [{
              id: 'shot-1',
              start_ms: 0,
              end_ms: 90_000,
              dialogue: [{ speaker_id: 'c1', text: '别回头', start_ms: 500, end_ms: 2_500 }],
              opening_state: '小满站在天台边',
              continuous_action: '小满查看手机',
              ending_state: '小满转身',
            }],
            causal_chain: ['手机消息促使小满转身'],
            locked_facts: ['小满在天台查看手机'],
            reversals: ['消息来自未来'],
            episode_hook: '发信人是谁',
          },
        };
      },
    }));

    const submitted = captureResponse();
    await handlers.analyzeWork(request({
      id: workId,
      body: {
        locale: 'en-US',
        market: 'US',
        aspect_ratio: '9:16',
        style_preset_id: 1,
      },
    }), submitted);

    assert.equal(submitted.statusCode, 201);
    assert.equal(submitted.body.data.current_step, 2);
    assert.equal(submitted.body.data.provider_task_id, 'response-native-route');
    assert.equal(nativeInput.workId, workId);
    assert.equal(nativeInput.tenantId, 'tenant-a');
    assert.equal(nativeInput.userId, 'user-a');
    assert.equal(nativeInput.model, 'GPT-5.5');
    assert.match(nativeInput.taskId, /^[0-9a-f-]{36}$/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_versions WHERE work_id = ?').get(workId).count, 1);
  } finally {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
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

test('本地化版本提交拒绝客户端控制字段且不启动任务', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId);
    let starts = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      localizationOrchestrator: {
        quoteLocalization: () => ({ priced: true, quote_hash: 'quote-ok' }),
        startLocalization: () => { starts += 1; return {}; },
      },
    }));

    for (const body of [
      { dialogue: [] },
      { model: 'attacker-model' },
      { credit_amount: 1 },
    ]) {
      const result = captureResponse();
      await handlers.createVersion(request({ id: workId, body }), result);
      assert.equal(result.statusCode, 400, JSON.stringify(body));
      assert.equal(result.body.error.code, 'REDRAW_LOCALIZATION_CLIENT_CONTROL_FORBIDDEN');
    }
    assert.equal(starts, 0);
  } finally {
    db.close();
  }
});

test('本地化报价只使用服务端 owner 与能力上下文并按租户隔离', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId);
    const canReadArtifact = () => true;
    const calls = [];
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      canReadArtifact,
      localizationOrchestrator: {
        quoteLocalization: (_db, input) => {
          calls.push(input);
          return { priced: true, credits: 7, model: 'gpt-localize', quote_hash: 'quote-ok' };
        },
        startLocalization: () => { throw new Error('should not start'); },
      },
    }));

    const quoted = captureResponse();
    handlers.localizationQuote(request({
      id: workId,
      body: {
        locale: 'en-US',
        market: 'US',
        localization_level: 'faithful',
        canReadArtifact: () => false,
      },
    }), quoted);
    assert.equal(quoted.statusCode, 200);
    assert.equal(quoted.body.data.quote_hash, 'quote-ok');
    assert.deepEqual(calls[0], {
      workId,
      tenantId: 'tenant-a',
      userId: 'user-a',
      locale: 'en-US',
      market: 'US',
      localizationLevel: 'faithful',
      canReadArtifact,
    });

    const otherTenant = captureResponse();
    handlers.localizationQuote(request({ id: workId, tenantId: 'tenant-b', body: { locale: 'en-US' } }), otherTenant);
    assert.equal(otherTenant.statusCode, 404);
    assert.equal(calls.length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_localization'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE resource_type = 'redraw_localization'").get().count, 0);
  } finally {
    db.close();
  }
});

test('本地化报价未配置能力或价格返回 409 且无副作用', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      localizationOrchestrator: {
        quoteLocalization: () => ({ priced: false, code: 'pricing_unconfigured' }),
        startLocalization: () => { throw new Error('should not start'); },
      },
    }));

    const result = captureResponse();
    handlers.localizationQuote(request({ id: workId, body: { locale: 'en-US', market: 'US' } }), result);

    assert.equal(result.statusCode, 409);
    assert.equal(result.body.error.code, 'pricing_unconfigured');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_localization'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE resource_type = 'redraw_localization'").get().count, 0);
  } finally {
    db.close();
  }
});

test('本地化版本提交走异步 orchestrator 并返回 202 草稿版本和服务端账单', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId);
    const canReadArtifact = () => true;
    const provider = async () => ({});
    const schedule = () => {};
    const calls = [];
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      canReadArtifact,
      localizationProvider: provider,
      localizationSchedule: schedule,
      localizationOrchestrator: {
        quoteLocalization: () => ({ priced: true, credits: 7, model: 'gpt-localize', quote_hash: 'quote-ok' }),
        startLocalization: (_db, _log, input, deps) => {
          calls.push({ input, deps });
          return {
            task_id: 'task-localize-1',
            draft_version_id: 2,
            task: { status: 'pending' },
            reservation_id: 'reservation-localize-1',
            quote: { credits: 7, model: 'gpt-localize', quote_hash: 'quote-ok' },
            completion: new Promise(() => {}),
          };
        },
      },
    }));

    const result = captureResponse();
    await handlers.createVersion(request({
      id: workId,
      body: {
        locale: 'en-US',
        market: 'US',
        localization_level: 'faithful',
        quote_hash: 'quote-ok',
        idempotency_key: 'idem-localize-1',
      },
    }), result);

    assert.equal(result.statusCode, 202);
    assert.deepEqual(result.body.data, {
      task_id: 'task-localize-1',
      version_id: 2,
      status: 'pending',
      current_step: 1,
      billing: { charged: 0, held: 7, released: 0 },
    });
    assert.deepEqual(calls[0].input, {
      workId,
      tenantId: 'tenant-a',
      userId: 'user-a',
      locale: 'en-US',
      market: 'US',
      localizationLevel: 'faithful',
      quoteHash: 'quote-ok',
      idempotencyKey: 'idem-localize-1',
      canReadArtifact,
    });
    assert.equal(calls[0].deps.provider, provider);
    assert.equal(calls[0].deps.schedule, schedule);
    assert.equal(calls[0].deps.canReadArtifact, canReadArtifact);
  } finally {
    db.close();
  }
});

test('本地化版本提交默认真实 orchestrator 无 provider 时同步拒绝且无副作用', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 1 });
    const sourceVersionId = insertVersion(db, workId, {
      locale: 'source',
      market: '',
      status: 'asset_review',
      style_snapshot_json: JSON.stringify({ tone: 'thriller' }),
    });
    const sourceFacts = {
      schema_version: '1.0',
      episode_hook: { summary: 'locked hook' },
      causal_chain: [],
      reversals: [],
      locked_facts: [],
      characters: [],
      scenes: [],
      props: [],
      shots: [],
    };
    db.prepare('UPDATE redraw_versions SET source_facts_json = ?, facts_hash = ? WHERE id = ?')
      .run(JSON.stringify(sourceFacts), 'source-facts-hash', sourceVersionId);
    insertRedrawLocaleCapabilityConfig(db, [{
      locale: 'en-US',
      market: 'US',
      status: 'verified',
      evidence: {
        text: {
          provider: 'verified-provider',
          model: 'gpt-localize',
          task_id: 'verified-localization-text',
          terminal_status: 'completed',
          artifact_id: 'readable-localization-artifact',
        },
      },
    }]);
    prices.set(db, 'gpt-localize', 7, { category: 'text' });
    creditLedger.setTenantAccountBalance(db, 'tenant-a', 100);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      canReadArtifact: () => true,
      localizationOrchestrator: undefined,
      localizationProvider: undefined,
    }));

    const quoted = captureResponse();
    handlers.localizationQuote(request({
      id: workId,
      body: { locale: 'en-US', market: 'US', localization_level: 'faithful' },
    }), quoted);
    assert.equal(quoted.statusCode, 200);
    const before = {
      versions: db.prepare('SELECT COUNT(*) AS count FROM redraw_versions').get().count,
      tasks: db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_localization'").get().count,
      reservations: db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE resource_type = 'redraw_localization'").get().count,
    };

    const result = captureResponse();
    await handlers.createVersion(request({
      id: workId,
      body: {
        locale: 'en-US',
        market: 'US',
        localization_level: 'faithful',
        quote_hash: quoted.body.data.quote_hash,
        idempotency_key: 'idem-no-provider',
      },
    }), result);

    assert.equal(result.statusCode, 409);
    assert.equal(result.body.error.code, 'REDRAW_LOCALIZATION_PROVIDER_UNAVAILABLE');
    assert.deepEqual({
      versions: db.prepare('SELECT COUNT(*) AS count FROM redraw_versions').get().count,
      tasks: db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_localization'").get().count,
      reservations: db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE resource_type = 'redraw_localization'").get().count,
    }, before);
  } finally {
    db.close();
  }
});

test('本地化版本提交映射 quote changed 与余额不足错误', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId);
    for (const [code, expectedStatus] of [
      ['REDRAW_LOCALIZATION_QUOTE_CHANGED', 409],
      ['INSUFFICIENT_CREDITS', 402],
    ]) {
      const error = Object.assign(new Error(code), {
        code,
        quote: { quote_hash: 'fresh-quote', credits: 9 },
        details: { reason: 'changed' },
      });
      const handlers = redrawRoutes(db, { error() {} }, routeDeps({
        localizationOrchestrator: {
          quoteLocalization: () => ({ priced: true }),
          startLocalization: () => { throw error; },
        },
      }));
      const result = captureResponse();
      await handlers.createVersion(request({
        id: workId,
        body: {
          locale: 'en-US',
          quote_hash: 'old-quote',
          idempotency_key: `idem-${code}`,
        },
      }), result);
      assert.equal(result.statusCode, expectedStatus);
      assert.equal(result.body.error.code, code);
      if (code === 'REDRAW_LOCALIZATION_QUOTE_CHANGED') {
        assert.deepEqual(result.body.error.details.quote, error.quote);
      }
    }
  } finally {
    db.close();
  }
});

test('作品详情独立返回分析、本地化、资产批次任务和 workflow phase', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, {
      current_version: 1,
      current_step: 2,
      status: 'asset_review',
      task_id: 'task-analysis-complete',
    });
    const versionId = insertVersion(db, workId, {
      status: 'asset_review',
      localization_task_id: 'task-localization-processing',
    });
    insertAssetBatch(db, versionId, {
      task_id: 'task-asset-batch-processing',
      status: 'processing',
    });
    db.prepare(`INSERT INTO async_tasks
      (id, type, status, progress, message, resource_id, tenant_id, user_id, created_at, updated_at)
      VALUES
        ('task-analysis-complete', 'redraw_analysis', 'completed', 100, '分析完成', ?, 'tenant-a', 'user-a', ?, ?),
        ('task-localization-processing', 'redraw_localization', 'processing', 33, '本地化中', ?, 'tenant-a', 'user-a', ?, ?),
        ('task-asset-batch-processing', 'redraw_asset_batch', 'processing', 12, '资产生成中', ?, 'tenant-a', 'user-a', ?, ?)
    `).run(
      String(workId), NOW, NOW,
      String(workId), NOW, NOW,
      String(versionId), NOW, NOW,
    );
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const result = captureResponse();
    handlers.getWork(request({ id: workId }), result);

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.data.analysis_task.id, 'task-analysis-complete');
    assert.equal(result.body.data.localization_task.id, 'task-localization-processing');
    assert.equal(result.body.data.asset_batch.task_id, 'task-asset-batch-processing');
    assert.equal(result.body.data.workflow_phase, 'asset_generating');
    assert.equal(result.body.data.task_status, 'completed');
  } finally {
    db.close();
  }
});

test('作品详情按真实本地化 reservation 投影退款证据且隔离错误资源', () => {
  const db = createDb();
  try {
    creditLedger.setTenantAccountBalance(db, 'tenant-a', 100);
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, {
      current_version: 1,
      current_step: 1,
      task_id: 'task-analysis-complete',
    });
    const otherWorkId = insertWork(db, projectId, { source_fingerprint: '9'.repeat(64) });
    const wrongReservation = creditLedger.reserve(db, {
      tenantId: 'tenant-a',
      actorUserId: 'user-a',
      operationKey: 'wrong-localization-resource',
      model: 'gpt-localize',
      resourceType: 'redraw_localization',
      resourceId: String(otherWorkId),
      amount: 7,
    });
    const correctReservation = creditLedger.reserve(db, {
      tenantId: 'tenant-a',
      actorUserId: 'user-a',
      operationKey: 'correct-localization-resource',
      model: 'gpt-localize',
      resourceType: 'redraw_localization',
      resourceId: String(workId),
      amount: 9,
    });
    insertVersion(db, workId, {
      localization_task_id: 'task-localization-failed',
      status: 'draft',
    });
    db.prepare(`INSERT INTO async_tasks
      (id, type, status, progress, message, resource_id, tenant_id, user_id, credit_reservation_id, created_at, updated_at)
      VALUES
        ('task-analysis-complete', 'redraw_analysis', 'completed', 100, '分析完成', ?, 'tenant-a', 'user-a', NULL, ?, ?),
        ('task-localization-failed', 'redraw_localization', 'failed', 100, '本地化失败', ?, 'tenant-a', 'user-a', ?, ?, ?)
    `).run(String(workId), NOW, NOW, String(workId), wrongReservation.id, NOW, NOW);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const wrong = captureResponse();
    handlers.getWork(request({ id: workId }), wrong);
    assert.equal(wrong.statusCode, 200);
    assert.deepEqual(wrong.body.data.localization_billing, { held: 0, charged: 0, released: 0, quote: null });

    db.prepare('UPDATE async_tasks SET credit_reservation_id = ? WHERE id = ?')
      .run(correctReservation.id, 'task-localization-failed');
    const held = captureResponse();
    handlers.getWork(request({ id: workId }), held);
    assert.equal(held.statusCode, 200);
    assert.deepEqual(held.body.data.localization_billing, {
      held: 9,
      charged: 0,
      released: 0,
      quote: { model: 'gpt-localize', amount: 9 },
    });

    creditLedger.refund(db, correctReservation.id, 'localization_failed');
    const refunded = captureResponse();
    handlers.getWork(request({ id: workId }), refunded);
    assert.equal(refunded.statusCode, 200);
    assert.deepEqual(refunded.body.data.localization_billing, {
      held: 0,
      charged: 0,
      released: 9,
      quote: { model: 'gpt-localize', amount: 9 },
    });
  } finally {
    db.close();
  }
});

test('分析完成但未本地化时仍停留步骤 1 和 analysis_review phase', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, {
      current_step: 2,
      status: 'asset_review',
      task_id: 'task-analysis-done',
    });
    db.prepare(`INSERT INTO async_tasks
      (id, type, status, progress, message, resource_id, tenant_id, user_id, created_at, updated_at)
      VALUES ('task-analysis-done', 'redraw_analysis', 'completed', 100, '分析完成', ?, 'tenant-a', 'user-a', ?, ?)
    `).run(String(workId), NOW, NOW);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const result = captureResponse();
    handlers.getWork(request({ id: workId }), result);

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.data.current_step, 1);
    assert.equal(result.body.data.workflow_phase, 'analysis_review');
    assert.equal(result.body.data.version_id, null);
  } finally {
    db.close();
  }
});

test('作品详情隐藏 draft 当前版本并回退到已提升版本', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 2, current_step: 2 });
    const promotedVersionId = insertVersion(db, workId, { version: 1, status: 'asset_review' });
    const draftVersionId = insertVersion(db, workId, { version: 2, status: 'draft' });
    insertShot(db, promotedVersionId, { shot_index: 1, prompt: 'promoted shot' });
    insertShot(db, draftVersionId, { shot_index: 1, prompt: 'draft shot' });
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const result = captureResponse();
    handlers.getWork(request({ id: workId }), result);

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.data.version_id, promotedVersionId);
    assert.equal(result.body.data.current_version, 1);
    assert.equal(result.body.data.shots.length, 1);
    assert.equal(result.body.data.shots[0].prompt, 'promoted shot');
  } finally {
    db.close();
  }
});

test('作品详情只有 draft 版本时不泄漏隐藏 current_version', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 2, current_step: 1 });
    const draftVersionId = insertVersion(db, workId, { version: 2, status: 'draft' });
    insertShot(db, draftVersionId, { prompt: 'draft only shot' });
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const result = captureResponse();
    handlers.getWork(request({ id: workId }), result);

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.data.version_id, null);
    assert.notEqual(result.body.data.current_version, 2);
    assert.equal(result.body.data.current_version, 0);
    assert.equal(result.body.data.shots.length, 0);
  } finally {
    db.close();
  }
});

test('workflowPhase 纯函数按阶段优先级返回状态', () => {
  assert.equal(redrawRoutes.workflowPhase({ current_step: 3 }, null, null, null), 'video_generation');
  assert.equal(redrawRoutes.workflowPhase({ current_step: 2 }, null, null, { status: 'pending' }), 'asset_generating');
  assert.equal(redrawRoutes.workflowPhase({ current_step: 2 }, null, null, null), 'asset_review');
  assert.equal(redrawRoutes.workflowPhase({ current_step: 1 }, null, { status: 'processing' }, null), 'localizing');
  assert.equal(redrawRoutes.workflowPhase({ current_step: 1 }, null, { status: 'needs_attention' }, null), 'localization_needs_attention');
  assert.equal(redrawRoutes.workflowPhase({ current_step: 1 }, { status: 'completed' }, null, null), 'analysis_review');
  assert.equal(redrawRoutes.workflowPhase({ current_step: 1 }, { status: 'pending' }, null, null), 'analyzing');
  assert.equal(redrawRoutes.workflowPhase({ current_step: 1 }, null, null, null), 'source');
});

test('资产报价与生成都使用服务端模型和积分快照', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 2, status: 'asset_review' });
    const versionId = insertVersion(db, workId, { status: 'asset_review' });
    const assetId = insertRedrawAsset(db, versionId, {
      source_ref_json: JSON.stringify({ source_ref: { kind: 'character', id: 'character-1' } }),
      asset_id: null,
      approval_status: 'pending',
      status: 'draft',
    });
    db.prepare(`INSERT INTO assets
      (id, name, type, category, url, local_path, mime_type, created_at, updated_at)
      VALUES (771, '生成角色', 'image', 'redraw', '', 'redraw/character-1.png', 'image/png', ?, ?)`)
      .run(NOW, NOW);
    creditLedger.setTenantAccountBalance(db, 'tenant-a', 100);
    let quoteCalls = 0;
    let providerCalls = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetQuoteProvider: async ({ asset, tenantId, userId }) => {
        quoteCalls += 1;
        assert.equal(asset.id, assetId);
        assert.equal(tenantId, 'tenant-a');
        assert.equal(userId, 'user-a');
        return { credits: 7, model: 'verified-image-model' };
      },
      assetGenerationProvider: async ({ input }) => {
        providerCalls += 1;
        assert.equal(input.model, 'verified-image-model');
        assert.equal(input.creditAmount, 7);
        return {
          status: 'completed',
          asset_id: 771,
          metadata: { views: ['front', 'side', 'back'] },
        };
      },
      canReadArtifact: (id) => Number(id) === 771,
    }));

    const quoted = captureResponse();
    await handlers.assetQuote(request({ id: assetId }), quoted);
    assert.equal(quoted.statusCode, 200);
    assert.deepEqual(quoted.body.data, {
      asset_id: assetId,
      model: 'verified-image-model',
      credits: 7,
      priced: true,
    });

    const generated = captureResponse();
    await handlers.generateRedrawAsset(request({ id: assetId, body: { prompt: '英文角色三视图' } }), generated);
    assert.equal(generated.statusCode, 202);
    assert.equal(providerCalls, 1);
    assert.equal(quoteCalls, 2);
    const reservation = db.prepare(`
      SELECT model, amount, status
      FROM tenant_usage_reservations
      WHERE resource_type = 'redraw_asset'
    `).get();
    assert.deepEqual(reservation, { model: 'verified-image-model', amount: 7, status: 'confirmed' });
  } finally {
    db.close();
  }
});

test('单项音色生成复用服务端批量报价并固定同模型的精确 TTS 配置', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 2, status: 'asset_review' });
    const versionId = insertVersion(db, workId, { status: 'asset_review' });
    const assetId = insertRedrawAsset(db, versionId, {
      kind: 'voice',
      source_ref_json: JSON.stringify({
        source_ref: { id: 'single-route-voice', voice_id: 'voice-en-us', is_cloned: false },
      }),
      localized_name: 'Maya voice',
      asset_id: null,
      approval_status: 'pending',
      status: 'draft',
    });
    db.prepare('UPDATE redraw_assets SET prompt = ? WHERE id = ?').run('Stay with me.', assetId);
    insertVerifiedVoiceTtsConfig(db, {
      provider: 'voice-provider-a',
      name: 'same model first config',
      model: 'voice-model',
      priority: 100,
      is_default: true,
      capability: false,
    });
    const pinnedConfigId = insertVerifiedVoiceTtsConfig(db, {
      provider: 'voice-provider-b',
      name: 'verified exact config',
      model: 'voice-model',
      priority: 10,
    });
    prices.set(db, 'voice-model', 3, { category: 'audio' });
    creditLedger.setTenantAccountBalance(db, 'tenant-a', 10);
    let injectedQuoteCalls = 0;
    let providerCalls = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetQuoteProvider: async () => {
        injectedQuoteCalls += 1;
        return { model: 'attacker-model', credits: 1 };
      },
      assetGenerationProvider: async ({ attempt, locale, market }) => {
        providerCalls += 1;
        assert.equal(attempt.snapshot.ai_service_config_id, pinnedConfigId);
        assert.equal(attempt.snapshot.provider, 'voice-provider-b');
        assert.equal(attempt.snapshot.model, 'voice-model');
        assert.equal(attempt.snapshot.config_updated_at, NOW);
        assert.equal(locale, 'en-US');
        assert.equal(market, 'US');
        return {
          status: 'unknown',
          unknown: true,
          provider_task_id: 'single-route-provider-task',
          error: 'audit pending',
        };
      },
      canReadArtifact: () => true,
    }));

    const quoted = captureResponse();
    await handlers.assetQuote(request({ id: assetId }), quoted);
    assert.deepEqual(quoted.body.data, {
      asset_id: assetId,
      model: 'voice-model',
      credits: 3,
      priced: true,
      quote_hash: quoted.body.data.quote_hash,
    });
    assert.match(quoted.body.data.quote_hash, /^[a-f0-9]{64}$/);

    const overridden = captureResponse();
    await handlers.generateRedrawAsset(request({
      id: assetId,
      body: {
        quote_hash: quoted.body.data.quote_hash,
        prompt: 'Attacker-controlled text.',
        localized_description: 'Attacker-controlled fallback.',
      },
    }), overridden);
    assert.equal(overridden.statusCode, 409);
    assert.equal(overridden.body.error.code, 'REDRAW_ASSET_QUOTE_CHANGED');
    assert.equal(providerCalls, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);

    const generated = captureResponse();
    await handlers.generateRedrawAsset(request({
      id: assetId,
      body: { quote_hash: quoted.body.data.quote_hash, prompt: 'Stay with me.' },
    }), generated);
    assert.equal(generated.statusCode, 202);
    assert.equal(generated.body.data.status, 'needs_attention');
    assert.equal(providerCalls, 1);
    assert.equal(injectedQuoteCalls, 0);
    const row = db.prepare('SELECT source_ref_json, credit_reservation_id FROM redraw_assets WHERE id = ?').get(assetId);
    const snapshot = JSON.parse(row.source_ref_json).snapshot;
    assert.equal(snapshot.ai_service_config_id, pinnedConfigId);
    assert.equal(snapshot.provider_task_id, 'single-route-provider-task');
    assert.equal(creditLedger.getReservation(db, row.credit_reservation_id).status, 'held');
  } finally {
    db.close();
  }
});

test('单项音色生成严格校验 GET 报价 hash，缺失或价格/配置/实际文本变化时零冻结零 provider', async (t) => {
  for (const mode of ['missing', 'price changed', 'config changed', 'description changed']) {
    await t.test(mode, async () => {
      const db = createDb();
      try {
        const projectId = insertProject(db);
        const workId = insertWork(db, projectId, { current_version: 1, current_step: 2, status: 'asset_review' });
        const versionId = insertVersion(db, workId, { status: 'asset_review' });
        const assetId = insertRedrawAsset(db, versionId, {
          kind: 'voice',
          source_ref_json: JSON.stringify({
            source_ref: { id: `single-quote-${mode}`, voice_id: 'voice-en-us', is_cloned: false },
          }),
          localized_name: 'Quoted voice',
          asset_id: null,
          approval_status: 'pending',
          status: 'draft',
        });
        db.prepare('UPDATE redraw_assets SET prompt = ?, localized_description = ? WHERE id = ?')
          .run(mode === 'description changed' ? '' : 'Confirm this quote.', 'Initial fallback text.', assetId);
        const configId = insertVerifiedVoiceTtsConfig(db, {
          provider: 'voice-provider-b',
          model: 'voice-model',
        });
        prices.set(db, 'voice-model', 3, { category: 'audio' });
        creditLedger.setTenantAccountBalance(db, 'tenant-a', 10);
        let providerCalls = 0;
        const handlers = redrawRoutes(db, { error() {} }, routeDeps({
          assetGenerationProvider: async () => {
            providerCalls += 1;
            return { status: 'unknown', unknown: true };
          },
          canReadArtifact: () => true,
        }));

        const quoted = captureResponse();
        await handlers.assetQuote(request({ id: assetId }), quoted);
        const acceptedHash = quoted.body.data.quote_hash;
        assert.match(acceptedHash, /^[a-f0-9]{64}$/);

        if (mode === 'price changed') {
          prices.set(db, 'voice-model', 4, { category: 'audio' });
        } else if (mode === 'config changed') {
          const nextUpdatedAt = '2026-08-06T00:00:01.000Z';
          const row = db.prepare('SELECT settings FROM ai_service_configs WHERE id = ?').get(configId);
          const settings = JSON.parse(row.settings);
          settings.redraw_locale_capabilities[0].evidence.tts.config_updated_at = nextUpdatedAt;
          db.prepare('UPDATE ai_service_configs SET settings = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(settings), nextUpdatedAt, configId);
        } else if (mode === 'description changed') {
          db.prepare('UPDATE redraw_assets SET localized_description = ? WHERE id = ?')
            .run('Changed fallback text.', assetId);
        }

        const generated = captureResponse();
        await handlers.generateRedrawAsset(request({
          id: assetId,
          body: mode === 'missing' ? {} : { quote_hash: acceptedHash },
        }), generated);
        assert.equal(generated.statusCode, 409);
        assert.equal(generated.body.error.code, 'REDRAW_ASSET_QUOTE_CHANGED');
        assert.equal(providerCalls, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
      } finally {
        db.close();
      }
    });
  }
});

test('单项音色生成在 capability evidence 配置版本过期时零冻结且零 provider', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 2, status: 'asset_review' });
    const versionId = insertVersion(db, workId, { status: 'asset_review' });
    const assetId = insertRedrawAsset(db, versionId, {
      kind: 'voice',
      source_ref_json: JSON.stringify({
        source_ref: { id: 'single-route-stale', voice_id: 'voice-en-us', is_cloned: false },
      }),
      asset_id: null,
      approval_status: 'pending',
      status: 'draft',
    });
    db.prepare('UPDATE redraw_assets SET prompt = ? WHERE id = ?').run('Stale evidence.', assetId);
    insertVerifiedVoiceTtsConfig(db, {
      provider: 'voice-provider-b',
      model: 'voice-model',
      evidence_updated_at: '2026-01-01T00:00:00.000Z',
    });
    prices.set(db, 'voice-model', 3, { category: 'audio' });
    creditLedger.setTenantAccountBalance(db, 'tenant-a', 10);
    let providerCalls = 0;
    let injectedQuoteCalls = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetQuoteProvider: async () => {
        injectedQuoteCalls += 1;
        return { model: 'attacker-model', credits: 1 };
      },
      assetGenerationProvider: async () => {
        providerCalls += 1;
        return { status: 'completed' };
      },
      canReadArtifact: () => true,
    }));

    const quoted = captureResponse();
    await handlers.assetQuote(request({ id: assetId }), quoted);
    const result = captureResponse();
    await handlers.generateRedrawAsset(request({
      id: assetId,
      body: { quote_hash: quoted.body.data.quote_hash },
    }), result);
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.error.code, 'pricing_unconfigured');
    assert.equal(providerCalls, 0);
    assert.equal(injectedQuoteCalls, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
  } finally {
    db.close();
  }
});

test('资产批量报价只接受资产 ID 并使用服务端 quote', async () => {
  const db = createDb();
  try {
    const { versionId, assetId } = setupAssetBatchFixture(db);
    let serviceInput = null;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetBatchService: makeAssetBatchService({
        quoteAssetBatch: (ctx, input) => {
          serviceInput = { ctx, input };
          return {
            priced: true,
            version_id: versionId,
            total_credits: 9,
            items: [{ asset_id: assetId, credits: 9, model: 'server-model', provider: 'server-provider' }],
            blocked: [],
            quote_hash: 'hash-server',
          };
        },
      }),
    }));

    const result = captureResponse();
    await handlers.assetBatchQuote(request({
      id: versionId,
      body: { asset_ids: [assetId, assetId] },
    }), result);

    assert.equal(result.statusCode, 200);
    assert.deepEqual(serviceInput.input, { assetIds: [assetId] });
    assert.equal(serviceInput.ctx.db, db);
    assert.equal(serviceInput.ctx.versionId, versionId);
    assert.equal(serviceInput.ctx.tenantId, 'tenant-a');
    assert.equal(serviceInput.ctx.userId, 'user-a');
    assert.equal(typeof serviceInput.ctx.canReadArtifact, 'function');
    assert.equal(typeof serviceInput.ctx.provider, 'function');
    assert.equal(Object.prototype.hasOwnProperty.call(serviceInput.ctx, 'schedule'), false);
    assert.equal('model' in serviceInput.input, false);
    assert.equal('provider' in serviceInput.input, false);
    assert.equal(result.body.data.total_credits, 9);
    assert.equal(result.body.data.quote_hash, 'hash-server');
  } finally {
    db.close();
  }
});

test('资产批量报价未定价返回 409 并保留服务详情', async () => {
  const db = createDb();
  try {
    const { versionId, assetId } = setupAssetBatchFixture(db);
    let calls = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetBatchService: makeAssetBatchService({
        quoteAssetBatch: () => {
          calls += 1;
          return {
            priced: false,
            version_id: versionId,
            total_credits: 0,
            items: [{ asset_id: assetId, priced: false }],
            blocked: [{ asset_id: assetId, code: 'REDRAW_CAPABILITY_UNVERIFIED', message: '未验证' }],
            quote_hash: 'hash-blocked',
          };
        },
      }),
    }));

    const result = captureResponse();
    await handlers.assetBatchQuote(request({ id: versionId, body: { asset_ids: [assetId] } }), result);

    assert.equal(calls, 1);
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.error.code, 'REDRAW_ASSET_BATCH_UNPRICED');
    assert.deepEqual(result.body.error.details.blocked, [{ asset_id: assetId, code: 'REDRAW_CAPABILITY_UNVERIFIED', message: '未验证' }]);
    assert.equal(result.body.error.details.quote_hash, 'hash-blocked');
  } finally {
    db.close();
  }
});

test('资产批量接口只允许当前已提升版本且历史和隐藏 draft 零副作用', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 2, current_step: 2, status: 'asset_review' });
    const historicalVersionId = insertVersion(db, workId, { version: 1, status: 'asset_review' });
    const draftVersionId = insertVersion(db, workId, { version: 2, status: 'draft' });
    const historicalAssetId = insertRedrawAsset(db, historicalVersionId, { asset_id: null, status: 'draft' });
    const draftAssetId = insertRedrawAsset(db, draftVersionId, { asset_id: null, status: 'draft' });
    let quoteCalls = 0;
    let startCalls = 0;
    let providerCalls = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetGenerationProvider: async () => { providerCalls += 1; return {}; },
      assetBatchService: makeAssetBatchService({
        quoteAssetBatch: () => { quoteCalls += 1; return {}; },
        startAssetBatch: () => { startCalls += 1; return {}; },
      }),
    }));

    for (const [versionId, assetId] of [[historicalVersionId, historicalAssetId], [draftVersionId, draftAssetId]]) {
      const quote = captureResponse();
      await handlers.assetBatchQuote(request({ id: versionId, body: { asset_ids: [assetId] } }), quote);
      assert.equal(quote.statusCode, 409);
      assert.equal(quote.body.error.code, 'REDRAW_ASSET_VERSION_NOT_CURRENT');

      const create = captureResponse();
      await handlers.createAssetBatch(request({
        id: versionId,
        body: { asset_ids: [assetId], quote_hash: 'hash', idempotency_key: `idem-${versionId}` },
      }), create);
      assert.equal(create.statusCode, 409);
      assert.equal(create.body.error.code, 'REDRAW_ASSET_VERSION_NOT_CURRENT');
    }

    assert.equal(quoteCalls, 0);
    assert.equal(startCalls, 0);
    assert.equal(providerCalls, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM async_tasks').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tenant_usage_reservations').get().n, 0);
  } finally {
    db.close();
  }
});

test('资产批量接口拒绝非对象 body 且 quote primitive 不触发默认全量', async () => {
  const db = createDb();
  try {
    const { versionId } = setupAssetBatchFixture(db);
    let calls = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetBatchService: makeAssetBatchService({
        quoteAssetBatch: () => { calls += 1; return {}; },
        startAssetBatch: () => { calls += 1; return {}; },
      }),
    }));

    for (const body of [[], 'asset_ids=1', 1, true, false]) {
      const quote = captureResponse();
      await handlers.assetBatchQuote(request({ id: versionId, body }), quote);
      assert.equal(quote.statusCode, 400);
      assert.equal(quote.body.error.code, 'REDRAW_ASSET_CLIENT_CONTROL_FORBIDDEN');

      const create = captureResponse();
      await handlers.createAssetBatch(request({ id: versionId, body }), create);
      assert.equal(create.statusCode, 400);
      assert.equal(create.body.error.code, 'REDRAW_ASSET_CLIENT_CONTROL_FORBIDDEN');
    }
    assert.equal(calls, 0);
  } finally {
    db.close();
  }
});

test('资产批量路由只在显式提供服务端 schedule 时传入 ctx', async () => {
  const db = createDb();
  try {
    const { versionId, assetId } = setupAssetBatchFixture(db);
    const scheduledJobs = [];
    const sentinel = Promise.resolve('scheduled-result');
    const serverSchedule = (job) => {
      scheduledJobs.push(job);
      return job();
    };
    let quoteSchedule = null;
    let startSchedule = null;
    let scheduledReturn = null;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetBatchSchedule: serverSchedule,
      assetBatchService: makeAssetBatchService({
        quoteAssetBatch: (ctx) => {
          quoteSchedule = ctx.schedule;
          return {
            priced: true,
            version_id: versionId,
            total_credits: 4,
            items: [{ asset_id: assetId, credits: 4 }],
            blocked: [],
            quote_hash: 'hash-schedule',
          };
        },
        startAssetBatch: (ctx) => {
          startSchedule = ctx.schedule;
          scheduledReturn = ctx.schedule(() => sentinel);
          return {
            batch: { id: 45, status: 'pending', attempt_ids: [assetId] },
            task: { id: 'task-schedule', status: 'pending' },
            completion: new Promise(() => {}),
          };
        },
      }),
    }));

    const quote = captureResponse();
    await handlers.assetBatchQuote(request({ id: versionId, body: { asset_ids: [assetId] } }), quote);
    assert.equal(quote.statusCode, 200);
    assert.equal(quoteSchedule, serverSchedule);

    const created = captureResponse();
    await handlers.createAssetBatch(request({
      id: versionId,
      body: { asset_ids: [assetId], quote_hash: 'hash-schedule', idempotency_key: 'idem-schedule' },
    }), created);
    assert.equal(created.statusCode, 202);
    assert.equal(startSchedule, serverSchedule);
    assert.equal(scheduledJobs.length, 1);
    assert.equal(scheduledReturn, sentinel);
  } finally {
    db.close();
  }
});

test('资产批量创建返回 202 映射真实 service shape 且不等待 completion', async () => {
  const db = createDb();
  try {
    const { versionId, assetId } = setupAssetBatchFixture(db);
    let serviceInput = null;
    let providerCalls = 0;
    const never = new Promise(() => {});
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetGenerationProvider: async () => {
        providerCalls += 1;
        return { status: 'completed' };
      },
      assetBatchService: makeAssetBatchService({
        startAssetBatch: (ctx, input) => {
          serviceInput = { ctx, input };
          return {
            batch: { id: 44, status: 'pending', attempt_ids: [assetId], asset_ids: [assetId] },
            task: { id: 'task-real-shape', status: 'pending' },
            completion: never,
          };
        },
      }),
    }));

    const startedAt = Date.now();
    const result = captureResponse();
    await handlers.createAssetBatch(request({
      id: versionId,
      body: { asset_ids: [assetId], quote_hash: 'hash-server', idempotency_key: 'idem-1' },
    }), result);

    assert.ok(Date.now() - startedAt < 500);
    assert.equal(providerCalls, 0);
    assert.deepEqual(serviceInput.input, {
      assetIds: [assetId],
      quoteHash: 'hash-server',
      idempotencyKey: 'idem-1',
    });
    assert.equal(typeof serviceInput.ctx.provider, 'function');
    assert.equal(Object.prototype.hasOwnProperty.call(serviceInput.ctx, 'schedule'), false);
    assert.equal(result.statusCode, 202);
    assert.equal(result.body.data.batch_id, 44);
    assert.equal(result.body.data.task_id, 'task-real-shape');
    assert.equal(result.body.data.status, 'pending');
    assert.deepEqual(result.body.data.billing, { charged: 0, held: 0, released: 0 });
    assert.equal(result.body.data.current_step, 2);
  } finally {
    db.close();
  }
});

test('资产批量创建拒绝异步 startAssetBatch contract 且不等待返回 Promise', async () => {
  const db = createDb();
  try {
    const { versionId, assetId } = setupAssetBatchFixture(db);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetBatchService: makeAssetBatchService({
        startAssetBatch: () => new Promise(() => {}),
      }),
    }));

    const startedAt = Date.now();
    const result = captureResponse();
    await handlers.createAssetBatch(request({
      id: versionId,
      body: { asset_ids: [assetId], quote_hash: 'hash-server', idempotency_key: 'idem-async-start' },
    }), result);

    assert.ok(Date.now() - startedAt < 500);
    assert.equal(result.statusCode, 500);
    assert.equal(result.body.error.code, 'INTERNAL_ERROR');
  } finally {
    db.close();
  }
});

test('资产批量创建原样透传 idempotency_key 并返回 service 给出的同 batch/task', async () => {
  const db = createDb();
  try {
    const { versionId, assetId } = setupAssetBatchFixture(db);
    let calls = 0;
    const inputs = [];
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetBatchService: makeAssetBatchService({
        startAssetBatch: (_ctx, input) => {
          calls += 1;
          inputs.push(input);
          return {
            batch_id: 55,
            task_id: 'task-stub-shape',
            status: 'pending',
            billing: { charged: 0, held: 5, released: 0 },
            completion: new Promise(() => {}),
          };
        },
      }),
    }));

    for (let i = 0; i < 2; i += 1) {
      const result = captureResponse();
      await handlers.createAssetBatch(request({
        id: versionId,
        body: { asset_ids: [assetId], quote_hash: 'hash-server', idempotency_key: 'idem-replay' },
      }), result);
      assert.equal(result.statusCode, 202);
      assert.equal(result.body.data.batch_id, 55);
      assert.equal(result.body.data.task_id, 'task-stub-shape');
      assert.deepEqual(result.body.data.billing, { charged: 0, held: 5, released: 0 });
    }
    assert.equal(calls, 2);
    assert.deepEqual(inputs.map((input) => input.idempotencyKey), ['idem-replay', 'idem-replay']);
  } finally {
    db.close();
  }
});

test('资产批量两条路径跨租户和跨用户返回 404 且 service 0 调用', async () => {
  const db = createDb();
  try {
    const { versionId, assetId } = setupAssetBatchFixture(db);
    let quoteCalls = 0;
    let startCalls = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetBatchService: makeAssetBatchService({
        quoteAssetBatch: () => { quoteCalls += 1; return {}; },
        startAssetBatch: () => { startCalls += 1; return {}; },
      }),
    }));

    for (const req of [
      request({ id: versionId, tenantId: 'tenant-b', body: { asset_ids: [assetId] } }),
      request({ id: versionId, userId: 'user-b', body: { asset_ids: [assetId] } }),
    ]) {
      const quote = captureResponse();
      await handlers.assetBatchQuote(req, quote);
      assert.equal(quote.statusCode, 404);

      const create = captureResponse();
      await handlers.createAssetBatch({
        ...req,
        body: { asset_ids: [assetId], quote_hash: 'hash', idempotency_key: 'idem' },
      }, create);
      assert.equal(create.statusCode, 404);
    }
    assert.equal(quoteCalls, 0);
    assert.equal(startCalls, 0);
  } finally {
    db.close();
  }
});

test('资产批量接口拒绝客户端控制字段和未知字段且 service/provider 0 调用', async () => {
  const db = createDb();
  try {
    const { versionId, assetId } = setupAssetBatchFixture(db);
    let quoteCalls = 0;
    let startCalls = 0;
    let providerCalls = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetGenerationProvider: async () => { providerCalls += 1; return {}; },
      assetBatchService: makeAssetBatchService({
        quoteAssetBatch: () => { quoteCalls += 1; return {}; },
        startAssetBatch: () => { startCalls += 1; return {}; },
      }),
    }));
    const forbidden = ['model', 'provider', 'credits', 'credit_amount', 'reservation_id', 'asset_results'];
    for (const field of forbidden) {
      for (const handlerName of ['assetBatchQuote', 'createAssetBatch']) {
        const body = handlerName === 'assetBatchQuote'
          ? { asset_ids: [assetId], [field]: null }
          : { asset_ids: [assetId], quote_hash: 'hash', idempotency_key: 'idem', [field]: undefined };
        const result = captureResponse();
        await handlers[handlerName](request({ id: versionId, body }), result);
        assert.equal(result.statusCode, 400, `${handlerName} ${field}`);
        assert.equal(result.body.error.code, 'REDRAW_ASSET_CLIENT_CONTROL_FORBIDDEN');
      }
    }
    for (const [handlerName, body] of [
      ['assetBatchQuote', { asset_ids: [assetId], unexpected: true }],
      ['createAssetBatch', { asset_ids: [assetId], quote_hash: 'hash', idempotency_key: 'idem', unexpected: true }],
    ]) {
      const result = captureResponse();
      await handlers[handlerName](request({ id: versionId, body }), result);
      assert.equal(result.statusCode, 400);
      assert.equal(result.body.error.code, 'REDRAW_ASSET_CLIENT_CONTROL_FORBIDDEN');
    }
    assert.equal(quoteCalls, 0);
    assert.equal(startCalls, 0);
    assert.equal(providerCalls, 0);
  } finally {
    db.close();
  }
});

test('资产批量接口拒绝非法 asset_ids 且不调用 service', async () => {
  const db = createDb();
  try {
    const { versionId } = setupAssetBatchFixture(db);
    let calls = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetBatchService: makeAssetBatchService({
        quoteAssetBatch: () => { calls += 1; return {}; },
        startAssetBatch: () => { calls += 1; return {}; },
      }),
    }));
    const invalidValues = [[0], [-1], [1.2], ['abc'], 'abc', []];
    for (const value of invalidValues) {
      const quote = captureResponse();
      await handlers.assetBatchQuote(request({ id: versionId, body: { asset_ids: value } }), quote);
      assert.equal(quote.statusCode, 400);
      const create = captureResponse();
      await handlers.createAssetBatch(request({
        id: versionId,
        body: { asset_ids: value, quote_hash: 'hash', idempotency_key: 'idem' },
      }), create);
      assert.equal(create.statusCode, 400);
    }
    assert.equal(calls, 0);
  } finally {
    db.close();
  }
});

test('资产批量创建映射报价变化、余额不足和能力缺失错误', async () => {
  const db = createDb();
  try {
    const { versionId, assetId } = setupAssetBatchFixture(db);
    for (const [code, expectedStatus] of [
      ['REDRAW_ASSET_BATCH_QUOTE_CHANGED', 409],
      ['REDRAW_ASSET_QUOTE_CHANGED', 409],
      ['REDRAW_ASSET_BATCH_UNPRICED', 409],
      ['REDRAW_ASSET_BATCH_EMPTY', 409],
      ['REDRAW_ASSET_PROVIDER_REQUIRED', 409],
      ['INSUFFICIENT_CREDITS', 402],
    ]) {
      const handlers = redrawRoutes(db, { error() {} }, routeDeps({
        assetBatchService: makeAssetBatchService({
          startAssetBatch: () => {
            throw Object.assign(new Error(code), {
              code,
              quote: { quote_hash: `new-${code}`, total_credits: 8 },
              details: { marker: code },
            });
          },
        }),
      }));
      const result = captureResponse();
      await handlers.createAssetBatch(request({
        id: versionId,
        body: { asset_ids: [assetId], quote_hash: 'old', idempotency_key: `idem-${code}` },
      }), result);
      assert.equal(result.statusCode, expectedStatus, code);
      assert.equal(result.body.error.code, code);
      if (code.includes('QUOTE_CHANGED')) {
        assert.equal(result.body.error.details.quote.quote_hash, `new-${code}`);
      }
    }
  } finally {
    db.close();
  }
});

test('资产批量创建 billing 从逐项 reservation 真实聚合 confirmed held refunded', async () => {
  const db = createDb();
  try {
    const { versionId, assetId } = setupAssetBatchFixture(db);
    const heldAssetId = insertRedrawAsset(db, versionId, { localized_name: 'Held', asset_id: null, status: 'pending' });
    const refundedAssetId = insertRedrawAsset(db, versionId, { localized_name: 'Refunded', asset_id: null, status: 'failed' });
    creditLedger.setTenantAccountBalance(db, 'tenant-a', 100);
    const confirmed = creditLedger.reserve(db, {
      tenantId: 'tenant-a',
      actorUserId: 'user-a',
      operationKey: 'batch-confirmed',
      model: 'server-model',
      resourceType: 'redraw_asset',
      resourceId: String(assetId),
      amount: 3,
    });
    creditLedger.confirm(db, confirmed.id);
    const held = creditLedger.reserve(db, {
      tenantId: 'tenant-a',
      actorUserId: 'user-a',
      operationKey: 'batch-held',
      model: 'server-model',
      resourceType: 'redraw_asset',
      resourceId: String(heldAssetId),
      amount: 5,
    });
    const refunded = creditLedger.reserve(db, {
      tenantId: 'tenant-a',
      actorUserId: 'user-a',
      operationKey: 'batch-refunded',
      model: 'server-model',
      resourceType: 'redraw_asset',
      resourceId: String(refundedAssetId),
      amount: 7,
    });
    creditLedger.refund(db, refunded.id, 'failed');
    db.prepare('UPDATE redraw_assets SET credit_reservation_id = ? WHERE id = ?').run(confirmed.id, assetId);
    db.prepare('UPDATE redraw_assets SET credit_reservation_id = ? WHERE id = ?').run(held.id, heldAssetId);
    db.prepare('UPDATE redraw_assets SET credit_reservation_id = ? WHERE id = ?').run(refunded.id, refundedAssetId);

    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetBatchService: makeAssetBatchService({
        startAssetBatch: () => ({
          batch: { id: 77, status: 'pending', attempt_ids: [assetId, heldAssetId, refundedAssetId] },
          task: { id: 'task-billing', status: 'pending' },
          completion: new Promise(() => {}),
        }),
      }),
    }));

    const result = captureResponse();
    await handlers.createAssetBatch(request({
      id: versionId,
      body: { asset_ids: [assetId, heldAssetId, refundedAssetId], quote_hash: 'hash', idempotency_key: 'idem-billing' },
    }), result);

    assert.equal(result.statusCode, 202);
    assert.deepEqual(result.body.data.billing, { charged: 3, held: 5, released: 7 });
  } finally {
    db.close();
  }
});

test('资产生成拒绝客户端注入模型和积分且不触发报价、冻结或 provider', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 2 });
    const versionId = insertVersion(db, workId, { status: 'asset_review' });
    const assetId = insertRedrawAsset(db, versionId, {
      source_ref_json: JSON.stringify({ source_ref: { kind: 'character', id: 'character-2' } }),
      asset_id: null,
      approval_status: 'pending',
      status: 'draft',
    });
    let quoteCalls = 0;
    let providerCalls = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetQuoteProvider: async () => {
        quoteCalls += 1;
        return { credits: 7, model: 'verified-image-model' };
      },
      assetGenerationProvider: async () => {
        providerCalls += 1;
        return { status: 'failed' };
      },
    }));

    const result = captureResponse();
    await handlers.generateRedrawAsset(request({
      id: assetId,
      body: { model: 'attacker-model', credit_amount: 0 },
    }), result);

    assert.equal(result.statusCode, 400);
    assert.equal(result.body.error.code, 'REDRAW_ASSET_CLIENT_CONTROL_FORBIDDEN');
    assert.equal(quoteCalls, 0);
    assert.equal(providerCalls, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
  } finally {
    db.close();
  }
});

test('资产未配置或无法解析服务端报价时 fail closed 且不冻结积分或调用 provider', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 2 });
    const versionId = insertVersion(db, workId, { status: 'asset_review' });
    const assetId = insertRedrawAsset(db, versionId, {
      source_ref_json: JSON.stringify({ source_ref: { kind: 'scene', id: 'scene-1' } }),
      kind: 'scene',
      asset_id: null,
      approval_status: 'pending',
      status: 'draft',
    });
    let providerCalls = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetQuoteProvider: async () => ({ credits: null, model: 'verified-image-model' }),
      assetGenerationProvider: async () => {
        providerCalls += 1;
        return { status: 'failed' };
      },
    }));

    const result = captureResponse();
    await handlers.generateRedrawAsset(request({ id: assetId, body: { prompt: '海外场景' } }), result);

    assert.equal(result.statusCode, 409);
    assert.equal(result.body.error.code, 'pricing_unconfigured');
    assert.equal(providerCalls, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);

    const invalidPriceHandlers = redrawRoutes(db, { error() {} }, routeDeps({
      assetQuoteProvider: async () => {
        throw Object.assign(new Error('invalid price'), { code: 'INVALID_MODEL_PRICE' });
      },
      assetGenerationProvider: async () => {
        providerCalls += 1;
        return { status: 'failed' };
      },
    }));
    const invalidPrice = captureResponse();
    await invalidPriceHandlers.generateRedrawAsset(
      request({ id: assetId, body: { prompt: '海外场景' } }),
      invalidPrice,
    );
    assert.equal(invalidPrice.statusCode, 409);
    assert.equal(invalidPrice.body.error.code, 'pricing_unconfigured');
    assert.equal(providerCalls, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tenant_usage_reservations').get().count, 0);
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

test('作品详情为 draft 分镜返回 verified 生成快照、只读报价和安全源片引用', () => {
  const db = createDb();
  try {
    prices.set(db, 'seedance 2.0', 2, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '720p': { credits: 3 } },
    });
    insertRedrawLocaleCapabilityConfig(db, [
      verifiedVideoCapability('unpriced-unverified', { status: 'draft' }),
      verifiedVideoCapability('seedance 2.0'),
    ]);
    const sourceAssetId = insertSourceAsset(db, {
      url: '',
      local_path: 'redraw-sources/source.mp4',
    });
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 3, source_asset_id: sourceAssetId });
    const versionId = insertVersion(db, workId, {
      locale: 'en-US',
      market: 'US',
      style_snapshot_json: JSON.stringify({ tone: 'warm' }),
    });
    const shotId = insertShot(db, versionId, {
      start_ms: 1000,
      end_ms: 13000,
      duration_ms: 12000,
      status: 'draft',
      draft_json: JSON.stringify({
        revision: 1,
        resolution: '720P',
        count: 99,
      }),
    });
    const handlers = redrawRoutes(db, { error() {}, warn() {} }, routeDeps({
      canReadArtifact: (assetId) => String(assetId) === 'artifact-seedance 2.0',
    }));

    const result = captureResponse();
    handlers.getWork(request({ id: workId }), result);

    assert.equal(result.statusCode, 200);
    const shot = result.body.data.shots[0];
    assert.equal(shot.id, shotId);
    assert.deepEqual(shot.generation_availability, { ok: true });
    assert.equal(shot.model, 'seedance 2.0');
    assert.equal(shot.duration, 12);
    assert.equal(shot.resolution, '720p');
    assert.equal(shot.count, 1);
    assert.equal(shot.quote.amount, 36);
    assert.equal(shot.quote.unit_amount, 36);
    assert.equal(shot.billing.quote.amount, 36);
    assert.equal(shot.billing.quote.unit_amount, 36);
    assert.equal(shot.generation_snapshot.model, 'seedance 2.0');
    assert.equal(shot.generation_snapshot.duration, 12);
    assert.equal(shot.generation_snapshot.attempt, 1);
    assert.equal(shot.generation_snapshot.version_id, String(versionId));
    assert.deepEqual(shot.generation_snapshot.shot_ids, [String(shotId)]);
    assert.deepEqual(shot.source_video_ref, {
      asset_id: Number(sourceAssetId),
      url: '/static/redraw-sources/source.mp4',
      start_ms: 1000,
      end_ms: 13000,
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE resource_type = 'redraw_shot'").get().count, 0);
  } finally {
    db.close();
  }
});

test('作品详情 failed 分镜预报价 attempt 使用当前持久 attempt 加一', () => {
  const db = createDb();
  try {
    prices.set(db, 'seedance 2.0', 2, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '720p': { credits: 3 } },
    });
    insertRedrawLocaleCapabilityConfig(db, [verifiedVideoCapability('seedance 2.0')]);
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 3 });
    const versionId = insertVersion(db, workId, { locale: 'en-US', market: 'US' });
    const shotId = insertShot(db, versionId, {
      duration_ms: 12000,
      status: 'failed',
      draft_json: JSON.stringify({
        revision: 4,
        resolution: '720p',
        generation: {
          attempt: 4,
          model: 'seedance 2.0',
          duration: 12,
          resolution: '720p',
        },
      }),
      error_code: 'REDRAW_VIDEO_FAILED',
      error_message: '上次生成失败',
    });
    const handlers = redrawRoutes(db, { error() {}, warn() {} }, routeDeps({
      canReadArtifact: (assetId) => String(assetId) === 'artifact-seedance 2.0',
    }));

    const result = captureResponse();
    handlers.getWork(request({ id: workId }), result);

    assert.equal(result.statusCode, 200);
    const shot = result.body.data.shots[0];
    assert.equal(shot.id, shotId);
    assert.equal(shot.generation_snapshot.attempt, 5);
    assert.equal(shot.generation_snapshot.duration, 12);
    assert.equal(shot.quote.snapshot.attempt, 5);
    assert.equal(shot.billing.quote.snapshot.attempt, 5);
    assert.equal(shot.quote.amount, 36);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE resource_type = 'redraw_shot'").get().count, 0);
  } finally {
    db.close();
  }
});

test('作品详情无 verified evidence 或未定价时显式 blocked 且不创建 reservation', () => {
  const db = createDb();
  try {
    insertRedrawLocaleCapabilityConfig(db, [
      verifiedVideoCapability('unreadable-model'),
    ]);
    const projectId = insertProject(db);
    const unreadableWorkId = insertWork(db, projectId, { current_version: 1, current_step: 3 });
    const unreadableVersionId = insertVersion(db, unreadableWorkId, { locale: 'en-US', market: 'US' });
    insertShot(db, unreadableVersionId, { status: 'draft' });
    const unpricedWorkId = insertWork(db, projectId, {
      current_version: 1,
      current_step: 3,
      source_fingerprint: '9'.repeat(64),
    });
    const unpricedVersionId = insertVersion(db, unpricedWorkId, { locale: 'en-US', market: 'US' });
    insertShot(db, unpricedVersionId, { status: 'failed' });
    const handlers = redrawRoutes(db, { error() {}, warn() {} }, routeDeps({
      canReadArtifact: (assetId) => String(assetId) === 'artifact-unpriced-model',
    }));

    const noEvidence = captureResponse();
    handlers.getWork(request({ id: unreadableWorkId }), noEvidence);
    assert.equal(noEvidence.statusCode, 200);
    assert.deepEqual(noEvidence.body.data.shots[0].generation_availability, {
      ok: false,
      code: 'no_verified_video_model',
      reason: '当前语言市场没有已验证可读的视频生成能力',
    });
    assert.equal(noEvidence.body.data.shots[0].quote, null);

    prices.ensureSchema(db);
    insertRedrawLocaleCapabilityConfig(db, [
      verifiedVideoCapability('unpriced-model', { market: 'US' }),
    ]);
    const unpriced = captureResponse();
    handlers.getWork(request({ id: unpricedWorkId }), unpriced);
    assert.equal(unpriced.statusCode, 200);
    assert.equal(unpriced.body.data.shots[0].generation_availability.ok, false);
    assert.equal(unpriced.body.data.shots[0].generation_availability.code, 'pricing_unconfigured');
    assert.match(unpriced.body.data.shots[0].generation_availability.reason, /尚未配置积分价格/);
    assert.equal(unpriced.body.data.shots[0].quote, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE resource_type = 'redraw_shot'").get().count, 0);
  } finally {
    db.close();
  }
});

test('作品详情不覆盖 processing 和 completed 分镜的持久任务与报价', () => {
  const db = createDb();
  try {
    prices.set(db, 'seedance 2.0', 2, {
      category: 'video',
      billing_unit: 'second',
      resolution_prices: { '720p': { credits: 3 } },
    });
    prices.set(db, 'new-verified-model', 9, { category: 'video', billing_unit: 'second' });
    insertRedrawLocaleCapabilityConfig(db, [verifiedVideoCapability('new-verified-model')]);
    creditLedger.setTenantAccountBalance(db, 'tenant-a', 100);
    const projectId = insertProject(db);
    const sourceAssetId = insertSourceAsset(db, {
      url: 'https://unsafe.example/source.mp4',
      local_path: 'redraw-sources/runtime-source.mp4',
    });
    const workId = insertWork(db, projectId, {
      current_version: 1,
      current_step: 3,
      source_asset_id: sourceAssetId,
    });
    const versionId = insertVersion(db, workId, { locale: 'en-US', market: 'US' });
    const processingShotId = insertShot(db, versionId, {
      status: 'processing',
      draft_json: JSON.stringify({
        revision: 2,
        generation: { reservation_id: 'reservation-processing', task_id: 'task-processing' },
        quote_snapshot: { model: 'seedance 2.0' },
      }),
    });
    const completedShotId = insertShot(db, versionId, {
      shot_index: 2,
      start_ms: 6000,
      end_ms: 12000,
      status: 'completed',
      draft_json: JSON.stringify({
        revision: 3,
        generation: { reservation_id: 'reservation-completed', task_id: 'task-completed' },
        new_video_ref: { asset_id: 901, video_url: 'https://cdn.example.com/completed.mp4' },
      }),
    });
    const processingReservation = creditLedger.reserve(db, {
      tenantId: 'tenant-a',
      actorUserId: 'user-a',
      operationKey: 'redraw-processing-existing',
      model: 'seedance 2.0',
      resourceType: 'redraw_shot',
      resourceId: String(processingShotId),
      amount: 18,
    });
    const completedReservation = creditLedger.reserve(db, {
      tenantId: 'tenant-a',
      actorUserId: 'user-a',
      operationKey: 'redraw-completed-existing',
      model: 'seedance 2.0',
      resourceType: 'redraw_shot',
      resourceId: String(completedShotId),
      amount: 18,
    });
    creditLedger.confirm(db, completedReservation.id);
    db.prepare(`INSERT INTO async_tasks
      (id, type, status, progress, message, resource_id, tenant_id, user_id, metadata, created_at, updated_at)
      VALUES
      ('task-processing', 'redraw_shot', 'processing', 55, '仍在生成', ?, 'tenant-a', 'user-a', ?, ?, ?),
      ('task-completed', 'redraw_shot', 'completed', 100, '完成', ?, 'tenant-a', 'user-a', ?, ?, ?)`)
      .run(
        String(processingShotId),
        JSON.stringify({ redraw_shot: {
          reservation_id: processingReservation.id,
          quote: { amount: 18, unit_amount: 18, snapshot: { model: 'seedance 2.0' } },
        } }),
        NOW,
        NOW,
        String(completedShotId),
        JSON.stringify({ redraw_shot: {
          reservation_id: completedReservation.id,
          quote: { amount: 18, unit_amount: 18, snapshot: { model: 'seedance 2.0' } },
        } }),
        NOW,
        NOW,
      );
    const handlers = redrawRoutes(db, { error() {}, warn() {} }, routeDeps({
      canReadArtifact: () => true,
    }));

    const result = captureResponse();
    handlers.getWork(request({ id: workId }), result);

    assert.equal(result.statusCode, 200);
    const [processing, completed] = result.body.data.shots;
    assert.equal(processing.generation.task_id, 'task-processing');
    assert.equal(processing.generation.status, 'processing');
    assert.equal(processing.generation_snapshot, undefined);
    assert.equal(processing.quote, undefined);
    assert.deepEqual(processing.source_video_ref, {
      asset_id: Number(sourceAssetId),
      url: '/static/redraw-sources/runtime-source.mp4',
      start_ms: 0,
      end_ms: 6000,
    });
    assert.deepEqual(processing.billing, {
      held: 18,
      charged: 0,
      released: 0,
      quote: { amount: 18, unit_amount: 18, snapshot: { model: 'seedance 2.0' } },
    });
    assert.equal(completed.generation.task_id, 'task-completed');
    assert.equal(completed.generation.status, 'completed');
    assert.equal(completed.generation_snapshot, undefined);
    assert.equal(completed.quote, undefined);
    assert.deepEqual(completed.source_video_ref, {
      asset_id: Number(sourceAssetId),
      url: '/static/redraw-sources/runtime-source.mp4',
      start_ms: 6000,
      end_ms: 12000,
    });
    assert.deepEqual(completed.billing, {
      held: 0,
      charged: 18,
      released: 0,
      quote: { amount: 18, unit_amount: 18, snapshot: { model: 'seedance 2.0' } },
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tenant_usage_reservations WHERE resource_type = 'redraw_shot'").get().count, 2);
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

test('同版本跨租户坏分镜不影响 owner GET PUT 而 owner 坏 JSON 仍 fail closed', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const ownShotId = insertShot(db, versionId);
    insertShot(db, versionId, {
      tenant_id: 'tenant-b',
      user_id: 'user-b',
      shot_index: 2,
      references_json: '{bad foreign json',
    });
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const listed = captureResponse();
    handlers.getWork(request({ id: workId }), listed);
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.body.data.shots.map((shot) => shot.id), [ownShotId]);

    const updated = captureResponse();
    handlers.updateShot(request({ id: ownShotId, body: {
      updated_at: NOW,
      prompt: 'owner edit remains isolated',
    } }), updated);
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.data.prompt, 'owner edit remains isolated');

    db.prepare("UPDATE redraw_shots SET references_json = '{bad owned json' WHERE id = ?").run(ownShotId);
    const ownedBroken = captureResponse();
    handlers.getWork(request({ id: workId }), ownedBroken);
    assert.equal(ownedBroken.statusCode, 500);
    assert.equal(ownedBroken.body.error.code, 'INTERNAL_ERROR');
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

test('分镜 PUT 拒绝 count 大于 1 且保持数据库零修改', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId);
    const before = db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(shotId);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());
    const result = captureResponse();

    handlers.updateShot(request({ id: shotId, body: {
      updated_at: NOW,
      count: 99,
    } }), result);

    assert.equal(result.statusCode, 400);
    assert.equal(result.body.error.code, 'REDRAW_SHOT_INVALID');
    assert.deepEqual(db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(shotId), before);
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
    await handlers.generateShot(request({ id: shotId, body: {} }), first);
    const duplicate = captureResponse();
    await handlers.generateShot(request({ id: shotId, body: {} }), duplicate);
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
    insertRedrawLocaleCapabilityConfig(db, [verifiedVideoCapability('seedance 2.0')]);
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

test('无 verified 生成能力时单镜生成 fail closed 且不冻结不提交', async () => {
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
    let providerCalls = 0;
    const handlers = redrawRoutes(db, { error() {}, warn() {}, info() {} }, routeDeps({
      generationOptions: { videoProcessor: async () => { providerCalls += 1; } },
      canReadArtifact: () => false,
    }));

    const result = captureResponse();
    await handlers.generateShot(request({ id: shotId, body: {} }), result);

    assert.equal(result.statusCode, 400);
    assert.equal(result.body.error.code, 'REDRAW_NO_VERIFIED_VIDEO_MODEL');
    assert.equal(providerCalls, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM async_tasks WHERE type = 'redraw_shot'").get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_generations WHERE deleted_at IS NULL').get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tenant_usage_reservations WHERE resource_type = 'redraw_shot'").get().n, 0);
    assert.equal(creditLedger.getTenantAccount(db, 'tenant-a').held, 0);
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
    insertRedrawLocaleCapabilityConfig(db, [verifiedVideoCapability('seedance 2.0')]);
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
      { model: 'seedance 2.0' },
      { locale: 'en-US' },
      { prompt: 'attacker prompt' },
      { generate_audio: false },
      { ai_service_config_id: 1 },
      { provider: 'attacker' },
      { credits: 1 },
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

test('原生音轨人工审核接口严格 body、owner 隔离且不需要供应商 provider', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId, { status: 'needs_attention' });
    const calls = [];
    const generationService = {
      reviewNativeAudio: async (ctx, input) => {
        calls.push({ ctx, input });
        return { status: 'completed', shot_id: input.shotId, video_generation_id: 77, asset_id: 88 };
      },
      resolveVerifiedGenerationModel: () => null,
    };
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({ generationService }));
    const validBody = {
      validation_hash: 'c'.repeat(64),
      expected_updated_at: NOW,
      decision: 'approved',
      speaker_order: 'passed',
      lip_sync: 'passed',
      extra_dialogue: 'passed',
    };

    for (const body of [
      { ...validBody, unknown: true },
      { ...validBody, validation_hash: 'x' },
      { ...validBody, expected_updated_at: 'not-iso' },
      { ...validBody, decision: 'accept' },
      { ...validBody, speaker_order: 'failed' },
      { ...validBody, lip_sync: 'failed' },
      { ...validBody, extra_dialogue: 'failed' },
      { validation_hash: 'c'.repeat(64), expected_updated_at: NOW, decision: 'rejected' },
      { validation_hash: 'c'.repeat(64), expected_updated_at: NOW, decision: 'rejected', reason: '' },
      { validation_hash: 'c'.repeat(64), expected_updated_at: NOW, decision: 'rejected', reason: 'bad', speaker_order: 'passed' },
    ]) {
      const result = captureResponse();
      await handlers.nativeAudioReview(request({ id: shotId, body }), result);
      assert.equal(result.statusCode, 400, JSON.stringify(body));
      assert.equal(result.body.error.code, 'REDRAW_NATIVE_AUDIO_REVIEW_INVALID');
    }
    assert.equal(calls.length, 0);

    const otherTenant = captureResponse();
    await handlers.nativeAudioReview(request({ id: shotId, tenantId: 'tenant-b', body: validBody }), otherTenant);
    assert.equal(otherTenant.statusCode, 404);
    assert.equal(calls.length, 0);

    const approved = captureResponse();
    await handlers.nativeAudioReview(request({ id: shotId, body: validBody }), approved);
    assert.equal(approved.statusCode, 202);
    assert.equal(approved.body.data.status, 'completed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ctx.tenantId, 'tenant-a');
    assert.equal(calls[0].ctx.userId, 'user-a');
    assert.deepEqual(calls[0].input, {
      shotId,
      validation_hash: 'c'.repeat(64),
      expected_updated_at: NOW,
      decision: 'approved',
      speaker_order: 'passed',
      lip_sync: 'passed',
      extra_dialogue: 'passed',
    });
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

test('真实 startAnalysis 创建的任务可由同租户 GET work 写读闭环恢复', async () => {
  const db = createDb();
  try {
    insertVerifiedVideoUnderstandingConfig(db);
    prices.set(db, 'GPT-5.5', 6);
    creditLedger.setTenantAccountBalance(db, '42', 100);
    const projectId = insertProject(db, { tenant_id: '42' });
    const workId = insertWork(db, projectId, { tenant_id: '42' });
    const handlers = redrawRoutes(db, { error() {}, warn() {}, info() {} }, routeDeps({
      orchestrator: realRedrawOrchestrator,
      analysisOptions: {
        provider: {
          startAnalysis: async () => ({ provider_task_id: 'provider-analysis-owner-loop' }),
        },
      },
    }));

    const submitted = captureResponse();
    await handlers.analyzeWork(request({
      id: workId,
      tenantId: 42,
      body: {
        locale: 'en-US',
        market: 'US',
        aspect_ratio: '9:16',
        style_preset_id: 1,
      },
    }), submitted);
    assert.equal(submitted.statusCode, 201);
    const task = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(submitted.body.data.task_id);
    assert.equal(task.tenant_id, '42');
    assert.equal(task.user_id, 'user-a');
    assert.equal(task.model, 'GPT-5.5');
    assert.equal(task.status, 'processing');
    assert.equal(task.progress, 10);
    assert.ok(task.credit_reservation_id);
    assert.equal(task.type, 'redraw_analysis');
    assert.equal(String(task.resource_id), String(workId));
    assert.equal(db.prepare('SELECT task_id FROM redraw_works WHERE id = ?').get(workId).task_id, task.id);

    const own = captureResponse();
    handlers.getWork(request({ id: workId, tenantId: 42 }), own);
    assert.equal(own.statusCode, 200);
    assert.equal(own.body.data.task_status, 'processing');
    assert.equal(own.body.data.task_progress, 10);
    assert.equal(own.body.data.task_message, '源片分析已开始');

    const otherTenant = captureResponse();
    handlers.getWork(request({ id: workId, tenantId: 43 }), otherTenant);
    assert.equal(otherTenant.statusCode, 404);
    const otherUser = captureResponse();
    handlers.getWork(request({ id: workId, tenantId: 42, userId: 'user-b' }), otherUser);
    assert.equal(otherUser.statusCode, 404);
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

test('第三步和本地化确认 API 已真实注册在总路由', () => {
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
    assert.equal(routes.has('POST /redraw/shots/:id/native-audio-review'), true);
    assert.equal(routes.has('POST /redraw/works/:id/generate-batch'), true);
    assert.equal(routes.has('POST /redraw/works/:id/localization-quote'), true);
    assert.equal(routes.has('POST /redraw/works/:id/versions'), true);
    assert.equal(routes.has('POST /redraw/versions/:id/assets/batch-quote'), true);
    assert.equal(routes.has('POST /redraw/versions/:id/assets/batches'), true);
    assert.equal(routes.has('GET /redraw/versions/:id/voices'), true);
    assert.equal(routes.has('GET /redraw/versions/:versionId/voices/:voiceAssetId/preview'), true);
    assert.equal(routes.has('POST /redraw/assets/:id/voice'), true);
    assert.equal(routes.has('POST /redraw/versions/:id/dialogue/quote'), true);
    assert.equal(routes.has('POST /redraw/versions/:id/dialogue/start'), true);
    assert.equal(routes.has('GET /redraw/versions/:id/dialogue/tasks/:taskId'), true);
  } finally {
    db.close();
  }
});

test('配音 quote/start/status 路由按版本 owner 接线且拒绝客户端模型积分字段', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const calls = [];
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      dialogueOrchestrator: {
        quoteDialogue: (_db, input) => {
          calls.push({ name: 'quote', input });
          return { status: 'ready', total_credits: 4, quote_hash: 'dialogue-quote-ok' };
        },
        startDialogue: (_db, _log, ctx, input) => {
          calls.push({ name: 'start', ctx, input });
          db.prepare(`INSERT INTO async_tasks
            (id, type, status, progress, message, resource_id, tenant_id, user_id, created_at, updated_at)
            VALUES ('task-dialogue-route', 'redraw_dialogue', 'completed', 100, 'done', ?, ?, ?, ?, ?)`)
            .run(`redraw_dialogue:${versionId}:hash`, ctx.tenantId, ctx.userId, NOW, NOW);
          return {
            task_id: 'task-dialogue-route',
            status: 'completed',
            quote: { status: 'ready', total_credits: 4, quote_hash: 'dialogue-quote-ok' },
            completion: Promise.resolve(),
          };
        },
      },
      dialogueProvider: async () => ({ status: 'completed' }),
    }));

    const quote = captureResponse();
    handlers.dialogueQuote(request({ id: versionId, body: { model: 'attacker' } }), quote);
    assert.equal(quote.statusCode, 400);
    assert.equal(quote.body.error.code, 'REDRAW_DIALOGUE_CLIENT_CONTROL_FORBIDDEN');

    const okQuote = captureResponse();
    handlers.dialogueQuote(request({ id: versionId, body: {} }), okQuote);
    assert.equal(okQuote.statusCode, 200);
    assert.equal(okQuote.body.data.quote_hash, 'dialogue-quote-ok');
    assert.equal(calls[0].input.versionId, versionId);
    assert.equal(calls[0].input.tenantId, 'tenant-a');

    const badStart = captureResponse();
    await handlers.startDialogue(request({
      id: versionId,
      body: { quote_hash: 'dialogue-quote-ok', idempotency_key: 'idem-route', credits: 1 },
    }), badStart);
    assert.equal(badStart.statusCode, 400);
    assert.equal(badStart.body.error.code, 'REDRAW_DIALOGUE_CLIENT_CONTROL_FORBIDDEN');

    const start = captureResponse();
    await handlers.startDialogue(request({
      id: versionId,
      body: { quote_hash: 'dialogue-quote-ok', idempotency_key: 'idem-route' },
    }), start);
    assert.equal(start.statusCode, 202);
    assert.equal(start.body.data.task_id, 'task-dialogue-route');
    assert.equal(start.body.data.quote.quote_hash, 'dialogue-quote-ok');
    assert.deepEqual(calls[1].input, { quoteHash: 'dialogue-quote-ok', idempotencyKey: 'idem-route' });

    const status = captureResponse();
    handlers.getDialogueTask({
      params: { id: String(versionId), taskId: 'task-dialogue-route' },
      tenant: { id: 'tenant-a' },
      user: { id: 'user-a' },
    }, status);
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.data.id, 'task-dialogue-route');
    assert.equal(status.body.data.status, 'completed');

    const otherTenant = captureResponse();
    handlers.getDialogueTask({
      params: { id: String(versionId), taskId: 'task-dialogue-route' },
      tenant: { id: 'tenant-b' },
      user: { id: 'user-a' },
    }, otherTenant);
    assert.equal(otherTenant.statusCode, 404);
  } finally {
    db.close();
  }
});
