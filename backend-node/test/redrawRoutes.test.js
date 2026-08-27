const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const express = require('express');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const redrawRoutes = require('../src/routes/redraw');
const { setupRouter } = require('../src/routes');
const creditLedger = require('../src/services/creditLedgerService');
const prices = require('../src/services/modelPriceService');
const realRedrawOrchestrator = require('../src/services/redrawOrchestrator');
const redrawCapabilityService = require('../src/services/redrawCapabilityService');
const redrawAssetService = require('../src/services/redrawAssetService');
const redrawReviewService = require('../src/services/redrawReviewService');
const providerAssetUrlService = require('../src/services/providerAssetUrlService');
const userAuthService = require('../src/services/userAuthService');

const NOW = '2026-08-06T00:00:00.000Z';
const EXPECTED_SERVER_AUTOMATION_POLICY = {
  schema_version: 'redraw-server-automation-policy-v1',
  analysis_confidence_thresholds: {
    character_mapping: 0.9,
    speaker_mapping: 0.9,
    text_regions: 0.9,
    shot_boundary: 0.9,
  },
  localization_thresholds: {
    names: 0.9,
    dialogue_semantics: 0.9,
    dialogue_timing: 0.9,
    culture: 0.9,
    screen_text: 0.9,
  },
};

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalIdentityPack(input = {}) {
  const wardrobeSeed = input.wardrobeSeed || 'canonical actor wardrobe';
  const pack = {
    schema_version: 'target-actor-identity-v1',
    source_character_key: input.sourceCharacterKey || 'source-character-maya',
    target_actor_label: input.targetActorLabel || 'Actor Maya',
    artifact: {
      asset_id: Number(input.artifactAssetId || 701),
      sha256: crypto.createHash('sha256').update(input.artifactSeed || 'canonical actor portrait').digest('hex'),
      width: 640,
      height: 960,
      mime_type: 'image/png',
    },
    wardrobe: {
      label: '整集主服装',
      reference_asset_id: Number(input.wardrobeAssetId || 702),
      reference_sha256: crypto.createHash('sha256').update(wardrobeSeed).digest('hex'),
      consistency_confirmed: input.wardrobeConsistencyConfirmed ?? true,
    },
    confirmed_views: ['front', 'profile', 'full_body'],
    live_action_human_confirmed: true,
    adult_status: 'verified_18_plus',
    identity_consistency_confirmed: true,
    persona_origin: 'fictional_ai_generated',
    target_country: 'US',
    ready: true,
    reviewed_by: 'user-a',
    reviewed_at: NOW,
  };
  return {
    ...pack,
    pack_sha256: crypto.createHash('sha256').update(stableJson(pack)).digest('hex'),
  };
}

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
       source_facts_json, facts_hash, style_snapshot_json, localization_task_id, status, created_at, updated_at, deleted_at)
    VALUES
      (@work_id, @tenant_id, @user_id, @version, @locale, @market, @localization_level,
       @source_facts_json, @facts_hash, @style_snapshot_json, @localization_task_id, @status, @created_at, @updated_at, @deleted_at)
  `).run({
    work_id: workId,
    tenant_id: 'tenant-a',
    user_id: 'user-a',
    version: 1,
    locale: 'en-US',
    market: 'US',
    localization_level: 'faithful',
    source_facts_json: null,
    facts_hash: null,
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

function routeSourceFacts() {
  return {
    schema_version: '1.0',
    duration_ms: 10_000,
    episode_hook: { id: 'hook-1', text: 'locked hook' },
    causal_chain: [],
    reversals: [],
    locked_facts: [{ id: 'fact-1', text: 'locked fact' }],
    characters: [{ id: 'c1', source_name: '小满', relationships: [] }],
    scenes: [{ id: 's1', location: '天台', time: '夜', source_ranges: [{ start_ms: 0, end_ms: 10_000 }] }],
    props: [{ id: 'p1', name: '旧手机', evidence_ranges: [{ start_ms: 1_000, end_ms: 2_000 }] }],
    shots: [{
      id: 'shot-1',
      start_ms: 0,
      end_ms: 10_000,
      dialogue: [{ speaker_id: 'c1', text: '别回头' }],
      opening_state: '小满站在天台',
      continuous_action: '小满看旧手机',
      ending_state: '小满离开',
    }],
  };
}

function insertAnalysisDecision(db, workId, factsHash, decisionOverrides = {}, versionId = 1) {
  const decision = {
    action: 'advance',
    effective_mode: 'auto',
    reason_codes: [],
    policy_version: 1,
    evidence_hash: factsHash,
    effective_analysis_state: 'asset_review',
    ...decisionOverrides,
  };
  db.prepare(`
    INSERT INTO async_tasks
      (id, type, status, progress, message, result, resource_id, tenant_id, user_id, created_at, updated_at, completed_at)
    VALUES (?, 'redraw_analysis', 'completed', 100, '分析完成', ?, ?, 'tenant-a', 'user-a', ?, ?, ?)
  `).run(`task-analysis-${workId}`, JSON.stringify({
    status: 'completed',
    work_id: workId,
    version_id: versionId,
    facts_hash: factsHash,
    automation_decision: decision,
  }), String(workId), NOW, NOW, NOW);
  db.prepare('UPDATE redraw_works SET task_id = ? WHERE id = ?').run(`task-analysis-${workId}`, workId);
  return decision;
}

function setupIdentityPackRouteFixture(values = {}) {
  const db = createDb();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-identity-route-'));
  const artifactBytes = Buffer.from(values.artifactBody || 'canonical actor portrait');
  const wardrobeBytes = Buffer.from(values.wardrobeBody || 'canonical actor wardrobe');
  const localPath = values.localPath || 'redraw-assets/actor.png';
  const wardrobeLocalPath = values.wardrobeLocalPath || 'redraw-assets/wardrobe.png';
  fs.mkdirSync(path.dirname(path.join(storageRoot, localPath)), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, localPath), artifactBytes);
  fs.writeFileSync(path.join(storageRoot, wardrobeLocalPath), wardrobeBytes);
  db.prepare(`INSERT INTO assets
    (id, name, type, category, url, local_path, mime_type, width, height, created_at, updated_at)
    VALUES (701, 'Actor Maya', 'image', 'redraw', '/static/redraw-assets/actor.png', ?,
      'image/png', 640, 960, ?, ?)`).run(localPath, NOW, NOW);
  db.prepare(`INSERT INTO assets
    (id, name, type, category, url, local_path, mime_type, width, height, created_at, updated_at)
    VALUES (702, 'Actor Maya wardrobe', 'image', 'redraw', '/static/redraw-assets/wardrobe.png', ?,
      'image/png', 640, 960, ?, ?)`).run(wardrobeLocalPath, NOW, NOW);
  const projectId = insertProject(db);
  const workId = insertWork(db, projectId, { current_version: 1, current_step: 2 });
  const versionId = insertVersion(db, workId, { status: 'asset_review', ...(values.version || {}) });
  const assetId = insertRedrawAsset(db, versionId, {
    kind: values.kind || 'character',
    source_ref_json: JSON.stringify({
      source_ref: {
        stable_id: 'source-character-maya',
        absolute_path: 'C:\\private\\actor.png',
        local_path: 'private/actor.png',
        storageRoot: 'C:\\private',
      },
    }),
    approval_status: 'approved',
  });
  db.prepare(`UPDATE redraw_assets
    SET approved_by = 'old-reviewer', approved_at = ?
    WHERE id = ?`).run(NOW, Number(assetId));
  const handlers = redrawRoutes(db, { error() {}, warn() {}, info() {} }, routeDeps({
    cfg: { storage: { local_path: storageRoot } },
  }));
  return {
    db,
    storageRoot,
    artifactBytes,
    wardrobeBytes,
    versionId: Number(versionId),
    assetId: Number(assetId),
    handlers,
    close() {
      db.close();
      fs.rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}

function completeIdentityPackRequest(overrides = {}) {
  const body = {
    target_actor_label: '  Actor Maya  ',
    confirmed_views: ['full_body', 'front', 'profile', 'front'],
    live_action_human_confirmed: true,
    adult_status: 'verified_18_plus',
    identity_consistency_confirmed: true,
    expected_updated_at: NOW,
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, 'wardrobe_reference_asset_id')
    && !Object.prototype.hasOwnProperty.call(overrides, 'wardrobeReferenceAssetId')
    && !Object.prototype.hasOwnProperty.call(overrides, 'wardrobe')) {
    body.wardrobe_reference_asset_id = 702;
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, 'wardrobe_consistency_confirmed')
    && !Object.prototype.hasOwnProperty.call(overrides, 'wardrobeConsistencyConfirmed')
    && !Object.prototype.hasOwnProperty.call(overrides, 'wardrobe')) {
    body.wardrobe_consistency_confirmed = true;
  }
  return body;
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

function insertNativeAudioReviewCandidate(db, storageRoot, localPath, values = {}) {
  creditLedger.setTenantAccountBalance(db, 'tenant-a', 100);
  const projectId = insertProject(db);
  const sourceFingerprint = crypto.createHash('sha256').update(String(localPath || Math.random())).digest('hex');
  const workId = insertWork(db, projectId, {
    current_version: 1,
    current_step: 3,
    status: 'generating',
    source_fingerprint: sourceFingerprint,
  });
  const versionId = insertVersion(db, workId, { locale: 'es', market: '', status: 'generating' });
  const artifactSha256 = values.artifactSha256 || 'd'.repeat(64);
  const audit = {
    contract: 'redraw-native-audio-validation-v1',
    artifact_sha256: artifactSha256,
    audio_stream: { codec: 'aac', channels: 2, sample_rate: 44100, duration_ms: 5000 },
    video_duration_ms: 5000,
    silence: { rms_db: -24, threshold_db: -45 },
    verification: {
      detected_language: 'es',
      detected_locale: null,
      language_verified: false,
      locale_verified: false,
      transcript_sha256: 'b'.repeat(64),
      dialogue_similarity: 0.61,
      speech_chars_per_second: 8,
    },
    validation_hash: 'c'.repeat(64),
    status: 'verified',
    candidate: {
      video_generation_id: null,
      artifact_sha256: artifactSha256,
      artifact_locator_sha256: 'e'.repeat(64),
    },
    human_review: { status: 'available' },
  };
  const shotId = insertShot(db, versionId, {
    status: 'needs_attention',
    localized_dialogue_json: JSON.stringify([
      { speaker_id: 'Valeria', start_ms: 700, end_ms: 1900, text: 'Hola, pequeño.' },
    ]),
    draft_json: JSON.stringify({
      revision: 1,
      generation: { reservation_id: null },
      native_audio_validation: audit,
    }),
  });
  const reservation = creditLedger.reserve(db, {
    tenantId: 'tenant-a',
    actorUserId: 'user-a',
    operationKey: `route-native-review-${shotId}-${String(localPath || 'missing').replace(/[^a-z0-9]/gi, '-')}`,
    model: 'seedance-2-fast',
    resourceType: 'redraw_shot',
    resourceId: String(shotId),
    amount: 4,
  });
  const taskId = `task-native-review-${shotId}`;
  db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, message, resource_id, tenant_id, user_id, metadata, credit_reservation_id, created_at, updated_at)
    VALUES (?, 'redraw_shot', 'needs_attention', 90, 'manual review', ?, 'tenant-a', 'user-a', ?, ?, ?, ?)`)
    .run(taskId, String(shotId), JSON.stringify({ redraw_shot: { reservation_id: reservation.id } }), reservation.id, NOW, NOW);
  const videoId = db.prepare(`INSERT INTO video_generations
    (status, task_id, tenant_id, user_id, provider, model, ai_service_config_id, duration,
     generate_audio, request_snapshot, local_path, created_at, updated_at)
    VALUES ('needs_attention', ?, 'tenant-a', 'user-a', 'test-provider', 'seedance-2-fast', 1, 5,
            1, ?, ?, ?, ?)`)
    .run(taskId, JSON.stringify({
      generate_audio: true,
      locale_pack: 'es@1',
      dialogue_snapshot_hash: 'a'.repeat(64),
      config_updated_at: NOW,
    }), localPath, NOW, NOW).lastInsertRowid;
  audit.candidate.video_generation_id = Number(videoId);
  db.prepare('UPDATE redraw_shots SET video_generation_id = ?, draft_json = ? WHERE id = ?')
    .run(videoId, JSON.stringify({
      revision: 1,
      generation: { reservation_id: reservation.id, task_id: taskId, video_generation_id: videoId },
      native_audio_validation: audit,
    }), shotId);
  if (values.writeFile !== false && localPath) {
    const file = path.join(storageRoot, localPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, values.fileBody || 'native route artifact');
  }
  return { shotId, videoId, taskId, reservationId: reservation.id };
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

test('创建转绘项目原子保存并投影新项目策略', () => {
  const db = createDb();
  try {
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const created = captureResponse();
    handlers.createProject(request({
      body: {
        title: '英语自动复刻项目',
        default_locale: 'en-US',
        default_market: 'US',
        localization_level: 'localized',
        execution_mode: 'auto',
        budget_limit_credits: 120,
        max_auto_attempts_per_shot: 3,
      },
    }), created);
    assert.equal(created.statusCode, 201);
    assert.deepEqual(
      {
        execution_mode: created.body.data.execution_mode,
        budget_limit_credits: created.body.data.budget_limit_credits,
        max_auto_attempts_per_shot: created.body.data.max_auto_attempts_per_shot,
        policy_version: created.body.data.policy_version,
        default_locale: created.body.data.default_locale,
        default_market: created.body.data.default_market,
      },
      {
        execution_mode: 'auto',
        budget_limit_credits: 120,
        max_auto_attempts_per_shot: 3,
        policy_version: 1,
        default_locale: 'en-US',
        default_market: 'US',
      },
    );
    assert.equal(JSON.stringify(created.body.data).includes('automation_policy_json'), false);

    const stored = db.prepare(`
      SELECT execution_mode, budget_limit_credits, max_auto_attempts_per_shot,
             policy_version, default_locale, default_market, automation_policy_json
      FROM redraw_projects WHERE id = ?
    `).get(created.body.data.id);
    const storedPolicy = JSON.parse(stored.automation_policy_json);
    delete stored.automation_policy_json;
    assert.deepEqual(stored, {
      execution_mode: 'auto',
      budget_limit_credits: 120,
      max_auto_attempts_per_shot: 3,
      policy_version: 1,
      default_locale: 'en-US',
      default_market: 'US',
    });
    assert.deepEqual(storedPolicy, EXPECTED_SERVER_AUTOMATION_POLICY);

    const own = captureResponse();
    handlers.getProject(request({ id: created.body.data.id }), own);
    assert.equal(own.statusCode, 200);
    assert.equal(own.body.data.execution_mode, 'auto');
    assert.equal(own.body.data.budget_limit_credits, 120);
    assert.equal(own.body.data.max_auto_attempts_per_shot, 3);
    assert.equal(own.body.data.policy_version, 1);

    const listed = captureResponse();
    handlers.listProjects(request(), listed);
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.data[0].execution_mode, 'auto');
    assert.equal(listed.body.data[0].budget_limit_credits, 120);
    assert.equal(listed.body.data[0].max_auto_attempts_per_shot, 3);
    assert.equal(listed.body.data[0].policy_version, 1);
  } finally {
    db.close();
  }
});

test('创建转绘项目严格拒绝新合同非法策略目标与客户端注入且零写入', () => {
  const db = createDb();
  try {
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());
    const cases = [
      { title: 'bad', default_locale: 'en-US', default_market: 'US', execution_mode: 'manual', budget_limit_credits: 10, max_auto_attempts_per_shot: 1 },
      { title: 'bad', default_locale: 'en-US', default_market: 'US', execution_mode: 'auto', max_auto_attempts_per_shot: 1 },
      { title: 'bad', default_locale: 'en-US', default_market: 'US', execution_mode: 'auto', budget_limit_credits: 10 },
      { title: 'bad', default_locale: 'en-US', default_market: 'US', execution_mode: 'auto', budget_limit_credits: 10, max_auto_attempts_per_shot: 6 },
      { title: 'bad', default_locale: '', default_market: 'US', execution_mode: 'safe' },
      { title: 'bad', default_locale: ['en-US', 'es-ES'], default_market: 'US', execution_mode: 'safe' },
      { title: 'bad', default_locale: 'en-US-Latn-FOO', default_market: 'US', execution_mode: 'safe' },
      { title: 'bad', default_locale: 'en-US', default_market: '', execution_mode: 'safe' },
      { title: 'bad', default_locale: 'en-US', default_market: ['US', 'GB'], execution_mode: 'safe' },
      { title: 'bad', default_locale: 'en-US', default_market: 'us', execution_mode: 'safe' },
      { title: 'bad', default_locale: 'en-US', default_market: 'US', execution_mode: 'safe', spent_credits: 1 },
      { title: 'bad', default_locale: 'en-US', default_market: 'US', execution_mode: 'safe', held_credits: 1 },
      { title: 'bad', default_locale: 'en-US', default_market: 'US', execution_mode: 'safe', model: 'client' },
      { title: 'bad', default_locale: 'en-US', default_market: 'US', execution_mode: 'safe', provider: 'client' },
      { title: 'bad', default_locale: 'en-US', default_market: 'US', execution_mode: 'safe', reservation_id: 'client' },
      { title: 'bad', default_locale: 'en-US', default_market: 'US', execution_mode: 'safe', automation_policy_json: '{}' },
      { title: 'bad', default_locale: 'en-US', default_market: 'US', execution_mode: 'safe', thresholds: { speaker_mapping: 0.1 } },
      JSON.parse('{"title":"bad","default_locale":"en-US","default_market":"US","execution_mode":"safe","__proto__":{"polluted":true}}'),
    ];
    for (const body of cases) {
      const res = captureResponse();
      handlers.createProject(request({ body }), res);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_projects').get().count, 0);

    const legacy = captureResponse();
    handlers.createProject(request({ body: { title: '旧客户端项目' } }), legacy);
    assert.equal(legacy.statusCode, 201);
    assert.equal(legacy.body.data.execution_mode, 'safe');
    assert.equal(legacy.body.data.default_locale, 'en-US');
    assert.equal(legacy.body.data.default_market, '');
    assert.equal(legacy.body.data.budget_limit_credits, null);
    assert.equal(legacy.body.data.max_auto_attempts_per_shot, null);
    assert.equal(legacy.body.data.policy_version, 1);
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
    db.prepare('UPDATE redraw_versions SET reference_bundle_required = 1 WHERE id = ?').run(versionId);
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
    assert.equal(gate.body.data.current_step, 2);
    assert.equal(gate.body.data.blocking[0].code, 'preparation_not_ready');

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
    assert.equal(review.body.data.gate.ok, false);
    assert.equal(review.body.data.gate.blocking[0].code, 'preparation_not_ready');
    assert.ok(review.body.data.gate.missing.some((item) => item.reason_code === 'character_plan_not_ready'));
    assert.equal(review.body.data.current_step, 2);
    assert.equal(db.prepare('SELECT current_step FROM redraw_works WHERE id = ?').get(workId).current_step, 2);
  } finally {
    db.close();
  }
});

test('生成审核门禁未知异常响应脱敏但保留 not found 语义', () => {
  const db = createDb();
  const original = redrawReviewService.evaluateGenerationGate;
  const logs = [];
  try {
    const handlers = redrawRoutes(db, { error(error, message) { logs.push({ error, message }); } }, routeDeps());
    redrawReviewService.evaluateGenerationGate = () => {
      throw Object.assign(new Error('C:\\private\\gate.json Authorization Bearer sk-secret Key=raw'), {
        cause: new Error('https://provider.example/private'),
      });
    };
    const result = captureResponse();
    handlers.generationGate(request({ id: 1 }), result);

    assert.equal(result.statusCode, 500);
    assert.equal(result.body.error.message, '读取生成审核门禁失败');
    const serialized = JSON.stringify(result.body);
    for (const secret of ['C:\\private', 'Authorization', 'sk-secret', 'provider.example', 'Key=raw']) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    assert.equal(logs.length, 1);

    redrawReviewService.evaluateGenerationGate = () => {
      throw Object.assign(new Error('missing'), { code: 'REDRAW_VERSION_NOT_FOUND' });
    };
    const notFound = captureResponse();
    handlers.generationGate(request({ id: 404 }), notFound);
    assert.equal(notFound.statusCode, 404);
  } finally {
    redrawReviewService.evaluateGenerationGate = original;
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

test('真实本地化报价在分析未 advance 时服务端拒绝且无副作用', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 1 });
    const factsHash = 'route-facts-hash-safe-review';
    const sourceVersionId = insertVersion(db, workId, {
      locale: 'source',
      market: '',
      status: 'needs_attention',
      source_facts_json: JSON.stringify(routeSourceFacts()),
      facts_hash: factsHash,
      style_snapshot_json: JSON.stringify({ tone: 'thriller' }),
    });
    insertAnalysisDecision(db, workId, factsHash, {
      action: 'needs_review',
      effective_mode: 'safe',
      reason_codes: ['safe_mode_requires_review'],
      effective_analysis_state: 'analysis_review',
    }, sourceVersionId);
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
    }));

    const result = captureResponse();
    handlers.localizationQuote(request({
      id: workId,
      body: { locale: 'en-US', market: 'US', localization_level: 'faithful' },
    }), result);

    assert.equal(result.statusCode, 409);
    assert.equal(result.body.error.code, 'REDRAW_LOCALIZATION_ANALYSIS_NOT_ADVANCED');
    assert.equal(result.body.error.details.quote.automation_decision.action, 'needs_review');
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
    insertAnalysisDecision(db, workId, 'source-facts-hash', {}, sourceVersionId);
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

test('作品详情只投影可恢复分析决策白名单且不公开 task result', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, {
      current_version: 1,
      current_step: 1,
      status: 'needs_attention',
      task_id: 'task-analysis-safe-projection',
    });
    const factsHash = 'projection-facts-hash';
    const sourceVersionId = insertVersion(db, workId, {
      locale: 'source',
      market: '',
      status: 'needs_attention',
      source_facts_json: JSON.stringify(routeSourceFacts()),
      facts_hash: factsHash,
    });
    const decision = {
      action: 'blocked',
      effective_mode: 'safe',
      reason_codes: ['project_policy_missing'],
      policy_version: 1,
      evidence_hash: factsHash,
      effective_analysis_state: 'blocked',
    };
    db.prepare(`INSERT INTO async_tasks
      (id, type, status, progress, message, result, metadata, resource_id, tenant_id, user_id, created_at, updated_at)
      VALUES ('task-analysis-safe-projection', 'redraw_analysis', 'completed', 100, '分析完成', ?, ?, ?, 'tenant-a', 'user-a', ?, ?)
    `).run(
      JSON.stringify({
        status: 'completed',
        work_id: workId,
        version_id: sourceVersionId,
        facts_hash: factsHash,
        automation_decision: {
          ...decision,
          internal_path: 'C:\\private\\analysis.json',
          metadata_json: { leaked: true },
        },
        result_asset_id: 'private-asset',
      }),
      JSON.stringify({ private: true }),
      String(workId),
      NOW,
      NOW,
    );
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const result = captureResponse();
    handlers.getWork(request({ id: workId }), result);

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.data.analysis_decision, decision);
    assert.equal(result.body.data.analysis_task.result, undefined);
    assert.equal(result.body.data.analysis_task.metadata, undefined);
    assert.equal(JSON.stringify(result.body.data).includes('private'), false);
    assert.equal(JSON.stringify(result.body.data).includes('internal_path'), false);
  } finally {
    db.close();
  }
});

test('作品详情只投影可恢复本地化决策白名单且不公开 task result', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db, {
      default_locale: 'es-ES',
      default_market: 'ES',
      execution_mode: 'auto',
      budget_limit_credits: 100,
      max_auto_attempts_per_shot: 1,
    });
    const workId = insertWork(db, projectId, {
      current_version: 1,
      current_step: 1,
      status: 'needs_attention',
    });
    const factsHash = 'a'.repeat(64);
    const versionId = insertVersion(db, workId, {
      locale: 'es-ES',
      market: 'ES',
      status: 'needs_attention',
      source_facts_json: JSON.stringify(routeSourceFacts()),
      facts_hash: factsHash,
      localization_task_id: 'task-localization-safe-projection',
    });
    const decision = {
      action: 'needs_review',
      effective_mode: 'safe',
      reason_codes: ['speaker_confidence_low'],
      policy_version: 1,
      version_id: versionId,
      evidence_hash: factsHash,
      effective_analysis_state: 'analysis_review',
    };
    db.prepare(`INSERT INTO async_tasks
      (id, type, status, progress, message, result, metadata, resource_id, tenant_id, user_id, created_at, updated_at)
      VALUES ('task-localization-safe-projection', 'redraw_localization', 'needs_attention', 100, '本地化需审核', ?, ?, ?, 'tenant-a', 'user-a', ?, ?)
    `).run(
      JSON.stringify({
        status: 'needs_attention',
        work_id: workId,
        version_id: versionId,
        facts_hash: factsHash,
        localization_decision: {
          action: decision.action,
          effective_mode: decision.effective_mode,
          reason_codes: decision.reason_codes,
          policy_version: decision.policy_version,
          evidence_hash: factsHash,
          effective_analysis_state: decision.effective_analysis_state,
          private_prompt: 'should-not-leak',
          metadata_json: { leaked: true },
        },
        provider_payload: { apiKey: 'secret' },
      }),
      JSON.stringify({ private: true }),
      String(workId),
      NOW,
      NOW,
    );
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const result = captureResponse();
    handlers.getWork(request({ id: workId }), result);

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.data.localization_decision, decision);
    assert.deepEqual(Object.keys(result.body.data.localization_decision).sort(), [
      'action',
      'effective_analysis_state',
      'effective_mode',
      'evidence_hash',
      'policy_version',
      'reason_codes',
      'version_id',
    ]);
    assert.match(result.body.data.localization_decision.evidence_hash, /^[a-f0-9]{64}$/);
    assert.equal(result.body.data.localization_decision.evidence, undefined);
    assert.equal(result.body.data.localization_task.result, undefined);
    assert.equal(result.body.data.localization_task.metadata, undefined);
    assert.equal(JSON.stringify(result.body.data).includes('private'), false);
    assert.equal(JSON.stringify(result.body.data).includes('private_prompt'), false);
    assert.equal(JSON.stringify(result.body.data).includes('apiKey'), false);
  } finally {
    db.close();
  }
});

test('作品详情拒绝失配或非法的本地化决策投影', () => {
  const invalidCases = [
    {
      name: 'stale version',
      patch: (_decision, context) => ({ version_id: context.versionId + 1 }),
    },
    {
      name: 'stale hash',
      patch: () => ({ facts_hash: 'stale-hash', localization_decision: { evidence_hash: 'stale-hash' } }),
    },
    {
      name: 'stale policy',
      patch: () => ({ localization_decision: { policy_version: 2 } }),
    },
    {
      name: 'invalid action',
      patch: () => ({ localization_decision: { action: 'run_provider' } }),
    },
    {
      name: 'unsafe reason code',
      patch: () => ({ localization_decision: { reason_codes: ['speaker_confidence_low', 'C:\\private\\prompt.txt'] } }),
    },
    {
      name: 'unsafe effective state',
      patch: () => ({ localization_decision: { effective_analysis_state: 'https://provider.example/task' } }),
    },
  ];

  for (const testCase of invalidCases) {
    const db = createDb();
    try {
      const projectId = insertProject(db, {
        default_locale: 'es-ES',
        default_market: 'ES',
        execution_mode: 'auto',
        budget_limit_credits: 100,
        max_auto_attempts_per_shot: 1,
      });
      const workId = insertWork(db, projectId, { current_version: 1, current_step: 1 });
      const factsHash = 'a'.repeat(64);
      const versionId = insertVersion(db, workId, {
        locale: 'es-ES',
        market: 'ES',
        source_facts_json: JSON.stringify(routeSourceFacts()),
        facts_hash: factsHash,
        localization_task_id: `task-localization-invalid-${testCase.name.replace(/\W+/g, '-')}`,
      });
      const decision = {
        action: 'needs_review',
        effective_mode: 'safe',
        reason_codes: ['speaker_confidence_low'],
        policy_version: 1,
        evidence_hash: factsHash,
        effective_analysis_state: 'analysis_review',
      };
      const context = { workId, versionId, factsHash };
      const patch = testCase.patch(decision, context);
      const payload = {
        status: 'needs_attention',
        work_id: workId,
        version_id: versionId,
        facts_hash: factsHash,
        localization_decision: decision,
        ...patch,
      };
      if (patch.localization_decision) {
        payload.localization_decision = { ...decision, ...patch.localization_decision };
      }
      db.prepare(`INSERT INTO async_tasks
        (id, type, status, progress, message, result, resource_id, tenant_id, user_id, created_at, updated_at)
        VALUES (?, 'redraw_localization', 'needs_attention', 100, '本地化需审核', ?, ?, 'tenant-a', 'user-a', ?, ?)
      `).run(
        `task-localization-invalid-${testCase.name.replace(/\W+/g, '-')}`,
        JSON.stringify(payload),
        String(workId),
        NOW,
        NOW,
      );
      const handlers = redrawRoutes(db, { error() {} }, routeDeps());

      const result = captureResponse();
      handlers.getWork(request({ id: workId }), result);

      assert.equal(result.statusCode, 200, testCase.name);
      assert.equal(result.body.data.localization_decision, null, testCase.name);
      assert.equal(JSON.stringify(result.body.data).includes('private'), false, testCase.name);
    } finally {
      db.close();
    }
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
    insertVersion(db, workId, {
      locale: 'source',
      market: '',
      status: 'asset_review',
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

test('编辑历史角色指针镜头时 snake/camel 引用均由服务端重新绑定身份', () => {
  for (const pointerField of ['character_asset_id', 'characterAssetId']) {
    const db = createDb();
    try {
      const projectId = insertProject(db);
      const workId = insertWork(db, projectId, { current_version: 1 });
      const versionId = insertVersion(db, workId);
      const pack = canonicalIdentityPack({ artifactSeed: pointerField });
      const assetId = insertRedrawAsset(db, versionId, {
        source_ref_json: JSON.stringify({
          source_ref: { stable_id: pack.source_character_key },
          identity_pack: pack,
        }),
      });
      const shotId = insertShot(db, versionId, {
        references_json: JSON.stringify([{
          [pointerField]: Number(assetId),
          source_character_key: 'forged-source',
          target_actor_label: 'Forged Actor',
          identity_pack_sha256: 'forged-hash',
        }]),
      });
      const handlers = redrawRoutes(db, { error() {} }, routeDeps());
      const updated = captureResponse();

      handlers.updateShot(request({ id: shotId, body: {
        updated_at: NOW,
        start_ms: 1000,
        end_ms: 7000,
        prompt: 'legacy character shot edited',
      } }), updated);

      assert.equal(updated.statusCode, 200, pointerField);
      assert.equal(updated.body.data.prompt, 'legacy character shot edited');
      assert.equal(updated.body.data.start_ms, 1000);
      assert.equal(updated.body.data.end_ms, 7000);
      assert.deepEqual(updated.body.data.references, [{
        asset_id: Number(assetId),
        kind: 'character',
        version_number: 1,
        approval_status: 'approved',
        name: 'Maya',
        source_character_key: pack.source_character_key,
        target_actor_label: pack.target_actor_label,
        identity_pack_sha256: pack.pack_sha256,
      }]);
      assert.deepEqual(
        JSON.parse(db.prepare('SELECT references_json FROM redraw_shots WHERE id = ?').get(shotId).references_json),
        updated.body.data.references,
      );
    } finally {
      db.close();
    }
  }
});

test('历史角色指针显式声明非 character kind 时拒绝更新', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const pack = canonicalIdentityPack();
    const assetId = insertRedrawAsset(db, versionId, {
      source_ref_json: JSON.stringify({ identity_pack: pack }),
    });
    const shotId = insertShot(db, versionId, {
      references_json: JSON.stringify([{ kind: 'prop', character_asset_id: Number(assetId) }]),
    });
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());
    const result = captureResponse();

    handlers.updateShot(request({ id: shotId, body: {
      updated_at: NOW,
      prompt: 'must reject conflicting historical kind',
    } }), result);

    assert.equal(result.statusCode, 400);
    assert.equal(result.body.error.code, 'REDRAW_SHOT_INVALID');
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

test('参考包 API PUT 仅传递服务端 shot 身份并返回脱敏投影', async () => {
  const db = createDb();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-reference-bundle-route-'));
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId);
    const input = {
      expected_updated_at: NOW,
      motion_reference_asset_id: 305,
      face_tracks: [{ track_key: 'face-1' }],
      text_regions: [{ region_key: 'subtitle-1' }],
      coverage_review: { status: 'approved' },
    };
    const calls = [];
    const referenceBundleService = {
      async saveReferenceBundle(context, savedInput) {
        calls.push({ context, input: savedInput });
        return {
          shot_id: shotId,
          reference_bundle_hash: 'a'.repeat(64),
          reference_bundle_updated_at: '2026-08-06T00:01:00.000Z',
          bundle: {
            schema_version: 'redraw-reference-bundle-v1',
            shot_id: shotId,
            coverage_review: {
              reviewed_at: '2026-08-06T00:01:00.000Z',
              reviewed_by: 'user-a',
            },
            local_path: 'private/reference.json',
            nested: {
              url: 'https://private.example/reference',
              absolute_path: 'C:\\private\\reference.json',
              tenant_id: 'tenant-a',
              user_id: 'user-a',
              safe_value: 'visible',
            },
          },
          raw_service_field: 'must-not-leak',
        };
      },
    };
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      cfg: { storage: { local_path: storageRoot } },
      referenceBundleService,
    }));
    const result = captureResponse();

    await handlers.saveReferenceBundle(request({ id: shotId, body: input }), result);

    assert.equal(result.statusCode, 200);
    assert.deepEqual(Object.keys(result.body.data).sort(), [
      'bundle',
      'reference_bundle_hash',
      'reference_bundle_updated_at',
      'shot_id',
    ]);
    assert.equal(result.body.data.shot_id, Number(shotId));
    assert.equal(result.body.data.reference_bundle_hash, 'a'.repeat(64));
    assert.equal(result.body.data.bundle.nested.safe_value, 'visible');
    const serialized = JSON.stringify(result.body.data);
    for (const secret of [
      'raw_service_field', 'local_path', 'absolute_path', 'https://private.example',
      'reviewed_by', 'tenant_id', 'user_id', 'C:\\\\private',
    ]) assert.equal(serialized.includes(secret), false, secret);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].input, { shot_id: Number(shotId), ...input });
    assert.equal(calls[0].context.db, db);
    assert.equal(calls[0].context.tenantId, 'tenant-a');
    assert.equal(calls[0].context.userId, 'user-a');
    assert.equal(calls[0].context.versionId, Number(versionId));
    assert.equal(calls[0].context.storageRoot, storageRoot);
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('作品详情只读投影当前版本参考包门禁且更新与生成 payload 均不能控制', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId);
    db.prepare('UPDATE redraw_versions SET reference_bundle_required = 1 WHERE id = ?')
      .run(versionId);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const before = captureResponse();
    handlers.getWork(request({ id: workId }), before);
    assert.equal(before.statusCode, 200);
    assert.equal(before.body.data.reference_bundle_required, true);

    const updated = captureResponse();
    handlers.updateShot(request({
      id: shotId,
      body: { updated_at: NOW, reference_bundle_required: false },
    }), updated);
    assert.equal(updated.statusCode, 200, JSON.stringify(updated.body));
    assert.equal(
      db.prepare('SELECT reference_bundle_required FROM redraw_versions WHERE id = ?')
        .get(versionId).reference_bundle_required,
      1,
    );

    let generationCalls = 0;
    const generationHandlers = redrawRoutes(db, { error() {} }, routeDeps({
      generationService: {
        async generateShot() { generationCalls += 1; return {}; },
        async retryShot() { generationCalls += 1; return {}; },
      },
    }));
    const generated = captureResponse();
    await generationHandlers.generateShot(request({
      id: shotId,
      body: { reference_bundle_required: false },
    }), generated);
    assert.equal(generated.statusCode, 400);
    assert.equal(generated.body.error.code, 'REDRAW_GENERATION_INPUT_INVALID');
    assert.equal(generationCalls, 0);
  } finally {
    db.close();
  }
});

test('没有参考包门禁的旧版本作品详情稳定返回 false', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    insertVersion(db, workId);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());
    const result = captureResponse();
    handlers.getWork(request({ id: workId }), result);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.data.reference_bundle_required, false);
  } finally {
    db.close();
  }
});

test('参考包 API PUT 对未知、客户端控制和 camelCase 字段 fail closed', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId);
    let calls = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      referenceBundleService: {
        async saveReferenceBundle() { calls += 1; },
      },
    }));
    const forbiddenFields = [
      'shot_id', 'reference_bundle_hash', 'hash', 'path', 'local_path', 'url',
      'reviewer', 'reviewed_by', 'status', 'tenant_id', 'tenantId', 'user_id', 'userId',
      'expectedUpdatedAt', 'motionReferenceAssetId', 'faceTracks', 'textRegions', 'coverageReview',
    ];

    for (const field of forbiddenFields) {
      const result = captureResponse();
      await handlers.saveReferenceBundle(request({
        id: shotId,
        body: {
          expected_updated_at: NOW,
          motion_reference_asset_id: 305,
          face_tracks: [],
          text_regions: [],
          coverage_review: {},
          [field]: 'client-controlled',
        },
      }), result);
      assert.equal(result.statusCode, 400, field);
      assert.equal(result.body.error.code, 'REDRAW_REFERENCE_BUNDLE_INPUT_INVALID', field);
    }
    const nonObject = captureResponse();
    await handlers.saveReferenceBundle(request({ id: shotId, body: [] }), nonObject);
    assert.equal(nonObject.statusCode, 400);
    assert.equal(nonObject.body.error.code, 'REDRAW_REFERENCE_BUNDLE_INPUT_INVALID');
    assert.equal(calls, 0);
  } finally {
    db.close();
  }
});

test('参考包 API GET 使用 service 同一读取快照且不二次读取 shot', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId);
    const updatedAt = '2026-08-06T00:02:00.000Z';
    const concurrentUpdatedAt = '2026-08-06T00:03:00.000Z';
    db.prepare('UPDATE redraw_shots SET reference_bundle_updated_at = ? WHERE id = ?')
      .run(updatedAt, shotId);
    let ownedShotReads = 0;
    const observedDb = new Proxy(db, {
      get(target, property) {
        if (property !== 'prepare') return Reflect.get(target, property, target);
        return (sql) => {
          if (/FROM\s+redraw_shots\s+s[\s\S]+JOIN\s+redraw_versions\s+v/i.test(String(sql))) {
            ownedShotReads += 1;
          }
          return target.prepare(sql);
        };
      },
    });
    const calls = [];
    const handlers = redrawRoutes(observedDb, { error() {} }, routeDeps({
      referenceBundleService: {
        async loadCurrentReferenceBundle(context, id) {
          calls.push({ context, id });
          db.prepare('UPDATE redraw_shots SET reference_bundle_updated_at = ? WHERE id = ?')
            .run(concurrentUpdatedAt, shotId);
          return {
            shot_id: id,
            reference_bundle_hash: 'b'.repeat(64),
            reference_bundle_updated_at: updatedAt,
            bundle: {
              schema_version: 'redraw-reference-bundle-v1',
              safe: true,
              storageRoot: 'C:\\private',
              source_url: 'https://private.example/source',
              reviewed_by: 'user-a',
            },
            internal: 'must-not-leak',
          };
        },
      },
    }));
    const result = captureResponse();

    await handlers.getReferenceBundle(request({ id: shotId }), result);

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.data, {
      shot_id: Number(shotId),
      reference_bundle_hash: 'b'.repeat(64),
      reference_bundle_updated_at: updatedAt,
      bundle: {
        schema_version: 'redraw-reference-bundle-v1',
        safe: true,
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, Number(shotId));
    assert.equal(calls[0].context.versionId, Number(versionId));
    assert.equal(ownedShotReads, 1);
    assert.equal(
      db.prepare('SELECT reference_bundle_updated_at FROM redraw_shots WHERE id = ?').get(shotId)
        .reference_bundle_updated_at,
      concurrentUpdatedAt,
    );
  } finally {
    db.close();
  }
});

test('参考包 API 对跨 owner 与不存在镜头统一 404 且不调用 service', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId);
    let calls = 0;
    const referenceBundleService = {
      async saveReferenceBundle() { calls += 1; },
      async loadCurrentReferenceBundle() { calls += 1; },
    };
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({ referenceBundleService }));
    const requests = [
      ['getReferenceBundle', request({ id: shotId, tenantId: 'tenant-b' })],
      ['getReferenceBundle', request({ id: shotId, userId: 'user-b' })],
      ['getReferenceBundle', request({ id: 999999 })],
      ['saveReferenceBundle', request({ id: shotId, tenantId: 'tenant-b', body: {} })],
      ['saveReferenceBundle', request({ id: shotId, userId: 'user-b', body: {} })],
      ['saveReferenceBundle', request({ id: 999999, body: {} })],
    ];

    for (const [method, req] of requests) {
      const result = captureResponse();
      await handlers[method](req, result);
      assert.equal(result.statusCode, 404, method);
      assert.equal(result.body.error.code, 'REDRAW_SHOT_NOT_FOUND', method);
    }
    assert.equal(calls, 0);
  } finally {
    db.close();
  }
});

test('参考包 API 稳定映射未找到、CAS 冲突和输入错误', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId);
    const baseBody = {
      expected_updated_at: NOW,
      motion_reference_asset_id: 305,
      face_tracks: [],
      text_regions: [],
      coverage_review: {},
    };
    const cases = [
      ['getReferenceBundle', 'REDRAW_REFERENCE_BUNDLE_NOT_FOUND', 404],
      ['saveReferenceBundle', 'REDRAW_REFERENCE_BUNDLE_CONFLICT', 409],
      ['saveReferenceBundle', 'REDRAW_REFERENCE_BUNDLE_FACE_COVERAGE_REQUIRED', 400],
    ];
    for (const [method, code, status] of cases) {
      const referenceBundleService = {
        async saveReferenceBundle() { throw Object.assign(new Error('参考包错误'), { code }); },
        async loadCurrentReferenceBundle() { throw Object.assign(new Error('参考包错误'), { code }); },
      };
      const handlers = redrawRoutes(db, { error() {} }, routeDeps({ referenceBundleService }));
      const result = captureResponse();
      await handlers[method](request({ id: shotId, body: baseBody }), result);
      assert.equal(result.statusCode, status, code);
      assert.equal(result.body.error.code, code);
    }
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
    const localeVerifier = { assertReady: () => ({ id: 'en@route-test' }) };
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({ generationService, localeVerifier }));

    const current = captureResponse();
    await handlers.generateBatch(request({ id: workId, body: {} }), current);
    assert.equal(current.statusCode, 202);
    assert.equal(calls[0].input.versionId, versionId);
    assert.equal(calls[0].context.localeVerifier, localeVerifier);

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

test('默认单镜生成 context 为参考包资产创建静态签名公网 URL 且不复用 provider HMAC secret', async (t) => {
  const db = createDb();
  const previousPlatformSecret = process.env.PLATFORM_JWT_SECRET;
  const previousProviderSecret = process.env.REDRAW_PROVIDER_ASSET_HMAC_SECRET;
  process.env.PLATFORM_JWT_SECRET = 'route-static-asset-jwt-secret-value-1234567890';
  process.env.REDRAW_PROVIDER_ASSET_HMAC_SECRET = 'wrong-redraw-provider-hmac-secret-1234567890';
  t.after(() => {
    if (previousPlatformSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = previousPlatformSecret;
    if (previousProviderSecret === undefined) delete process.env.REDRAW_PROVIDER_ASSET_HMAC_SECRET;
    else process.env.REDRAW_PROVIDER_ASSET_HMAC_SECRET = previousProviderSecret;
  });
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const shotId = insertShot(db, versionId);
    const now = new Date().toISOString();
    const assetId = db.prepare(`INSERT INTO assets
      (name, type, category, url, local_path, mime_type, created_at, updated_at)
      VALUES ('motion.mp4', 'video', 'redraw', '/static/redraw/motion.mp4', 'redraw/motion.mp4', 'video/mp4', ?, ?)`)
      .run(now, now).lastInsertRowid;
    const traversalAssetId = db.prepare(`INSERT INTO assets
      (name, type, category, url, local_path, mime_type, created_at, updated_at)
      VALUES ('bad-motion.mp4', 'video', 'redraw', '/static/%2e%2e/private/motion.mp4',
        'redraw/private/motion.mp4', 'video/mp4', ?, ?)`)
      .run(now, now).lastInsertRowid;
    let capturedContext = null;
    const handlers = redrawRoutes(db, { error() {}, info() {} }, routeDeps({
      cfg: { storage: { local_path: 'data/storage', base_url: 'https://media.example.test/static' } },
      providerAssetSecret: 'route-option-redraw-provider-secret-1234567890',
      generationService: {
        generateShot: async (context) => {
          capturedContext = context;
          return { status: 'processing' };
        },
      },
    }));

    const result = captureResponse();
    await handlers.generateShot(request({ id: shotId }), result);

    assert.equal(result.statusCode, 202);
    const signed = capturedContext.createReferenceUrl({
      asset_id: assetId,
      sha256: 'a'.repeat(64),
      kind: 'motion',
    });
    const url = new URL(signed);
    assert.equal(`${url.origin}${url.pathname}`, 'https://media.example.test/static/redraw/motion.mp4');
    assert.ok(url.searchParams.get('provider_asset_expires'));
    assert.ok(providerAssetUrlService.verifyProviderAssetRequest({
      pathname: url.pathname,
      expires: Number(url.searchParams.get('provider_asset_expires')),
      signature: url.searchParams.get('provider_asset_signature'),
      secret: process.env.PLATFORM_JWT_SECRET,
    }));
    assert.equal(providerAssetUrlService.verifyProviderAssetRequest({
      pathname: url.pathname,
      expires: Number(url.searchParams.get('provider_asset_expires')),
      signature: url.searchParams.get('provider_asset_signature'),
      secret: process.env.REDRAW_PROVIDER_ASSET_HMAC_SECRET,
    }), false);
    assert.equal(capturedContext.storageBaseUrl, 'https://media.example.test/static');
    assert.equal(capturedContext.providerAssetSecret, 'route-option-redraw-provider-secret-1234567890');
    assert.throws(() => capturedContext.createReferenceUrl({
      asset_id: traversalAssetId,
      sha256: 'b'.repeat(64),
      kind: 'motion',
    }), (error) => error.code === 'REDRAW_REFERENCE_ASSET_URL_UNAVAILABLE');
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

test('原生音轨人工审核真实路由将不可读和无音轨候选映射为 409', async () => {
  const db = createDb();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-route-native-review-'));
  try {
    const missing = insertNativeAudioReviewCandidate(db, storageRoot, 'videos/missing.mp4', { writeFile: false });
    const noAudioSha256 = crypto.createHash('sha256').update('no audio route artifact').digest('hex');
    const noAudio = insertNativeAudioReviewCandidate(db, storageRoot, 'videos/no-audio.mp4', {
      fileBody: 'no audio route artifact',
      artifactSha256: noAudioSha256,
    });
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      cfg: { storage: { local_path: storageRoot } },
      generationOptions: {
        probeRunner: async (_absPath, _row, options) => ({
          duration: 5,
          width: 720,
          height: 1280,
          hasAudio: options.requireAudio ? false : undefined,
        }),
        assetImporter: () => {
          throw new Error('asset importer must not run');
        },
      },
    }));
    const body = {
      validation_hash: 'c'.repeat(64),
      expected_updated_at: NOW,
      decision: 'approved',
      speaker_order: 'passed',
      lip_sync: 'passed',
      extra_dialogue: 'passed',
    };

    const missingResult = captureResponse();
    await handlers.nativeAudioReview(request({ id: missing.shotId, body }), missingResult);
    assert.equal(missingResult.statusCode, 409);
    assert.equal(missingResult.body.error.code, 'REDRAW_NATIVE_AUDIO_REVIEW_UNAVAILABLE');

    const noAudioResult = captureResponse();
    await handlers.nativeAudioReview(request({ id: noAudio.shotId, body }), noAudioResult);
    assert.equal(noAudioResult.statusCode, 409);
    assert.equal(noAudioResult.body.error.code, 'REDRAW_NATIVE_AUDIO_REVIEW_UNAVAILABLE');
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
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

test('角色身份包 API 保存服务端证据、重置审核且响应不泄露存储路径', () => {
  const fixture = setupIdentityPackRouteFixture({ version: { locale: 'es-ES', market: 'ES' } });
  try {
    const result = captureResponse();
    fixture.handlers.saveRedrawCharacterIdentityPack(
      request({
        id: fixture.assetId,
        body: completeIdentityPackRequest(),
      }),
      result,
    );

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.data.version_id, fixture.versionId);
    assert.equal(result.body.data.status, 'asset_review');
    assert.equal(result.body.data.current_step, 2);
    assert.equal(result.body.data.identity_pack.source_character_key, 'source-character-maya');
    assert.equal(result.body.data.identity_pack.target_actor_label, 'Actor Maya');
    assert.equal(result.body.data.identity_pack.persona_origin, 'fictional_ai_generated');
    assert.equal(result.body.data.identity_pack.target_country, 'ES');
    assert.deepEqual(result.body.data.identity_pack.confirmed_views, ['front', 'profile', 'full_body']);
    assert.deepEqual(result.body.data.identity_pack.artifact, {
      asset_id: 701,
      sha256: crypto.createHash('sha256').update(fixture.artifactBytes).digest('hex'),
      width: 640,
      height: 960,
      mime_type: 'image/png',
    });
    assert.deepEqual(result.body.data.identity_pack.wardrobe, {
      label: '整集主服装',
      reference_asset_id: 702,
      reference_sha256: crypto.createHash('sha256').update(fixture.wardrobeBytes).digest('hex'),
      consistency_confirmed: true,
    });
    assert.equal(result.body.data.identity_pack.reviewed_by, 'user-a');
    assert.equal(result.body.data.identity_pack.ready, true);
    assert.equal(result.body.data.identity_pack_status.ready, true);
    assert.match(result.body.data.identity_pack.pack_sha256, /^[0-9a-f]{64}$/);
    const { pack_sha256: _storedHash, ...canonicalFields } = result.body.data.identity_pack;
    assert.equal(
      result.body.data.identity_pack.pack_sha256,
      crypto.createHash('sha256').update(stableJson(canonicalFields)).digest('hex'),
    );
    const stored = fixture.db.prepare(`SELECT approval_status, approved_by, approved_at
      FROM redraw_assets WHERE id = ?`).get(fixture.assetId);
    assert.deepEqual(stored, { approval_status: 'pending', approved_by: null, approved_at: null });
    assert.deepEqual(result.body.data.asset.identity_pack, result.body.data.identity_pack);
    const serialized = JSON.stringify(result.body.data);
    assert.equal(serialized.includes('source_ref_json'), false);
    assert.equal(serialized.includes('storageRoot'), false);
    assert.equal(serialized.includes('"path"'), false);
    assert.equal(serialized.includes('local_path'), false);
    assert.equal(serialized.includes('absolute_path'), false);
    assert.equal(serialized.includes('C:\\\\private'), false);
  } finally {
    fixture.close();
  }
});

test('角色身份包 API 接受 camelCase 非政策字段并保持安全响应', () => {
  const fixture = setupIdentityPackRouteFixture();
  try {
    const result = captureResponse();
    fixture.handlers.saveRedrawCharacterIdentityPack(
      request({
        id: fixture.assetId,
        body: completeIdentityPackRequest({
          wardrobeReferenceAssetId: 702,
          wardrobeConsistencyConfirmed: true,
        }),
      }),
      result,
    );

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.data.identity_pack.persona_origin, 'fictional_ai_generated');
    assert.equal(result.body.data.identity_pack.target_country, 'US');
    assert.equal(result.body.data.identity_pack_status.ready, true);
    const serialized = JSON.stringify(result.body.data);
    assert.equal(serialized.includes('source_ref_json'), false);
    assert.equal(serialized.includes('storageRoot'), false);
    assert.equal(serialized.includes('local_path'), false);
    assert.equal(serialized.includes('absolute_path'), false);
  } finally {
    fixture.close();
  }
});

test('角色身份包 API 严格拒绝非法、重复和未知政策字段且数据库不变', () => {
  const fixture = setupIdentityPackRouteFixture();
  try {
    const invalidPatches = [
      { persona_origin: 'real_person' },
      { target_country: 'CN' },
      { persona_origin: 'fictional_ai_generated' },
      { target_country: 'US' },
      { personaOrigin: 'fictional_ai_generated' },
      { targetCountry: 'US' },
      { persona_origin: 1 },
      { target_country: true },
      { target_country: 'us' },
      { persona_origin: 'fictional_ai_generated', personaOrigin: 'fictional_ai_generated' },
      { target_country: 'US', targetCountry: 'US' },
      { wardrobe_reference_asset_id: 702, wardrobeReferenceAssetId: 702 },
      { wardrobe_consistency_confirmed: true, wardrobeConsistencyConfirmed: true },
      { unknown_policy: 'fictional_ai_generated' },
    ];
    const before = fixture.db.prepare(`SELECT source_ref_json, approval_status, approved_by,
      approved_at, updated_at FROM redraw_assets WHERE id = ?`).get(fixture.assetId);

    for (const patch of invalidPatches) {
      const result = captureResponse();
      fixture.handlers.saveRedrawCharacterIdentityPack(
        request({ id: fixture.assetId, body: completeIdentityPackRequest(patch) }),
        result,
      );
      assert.equal(result.statusCode, 400, JSON.stringify(patch));
      assert.equal(result.body.error.code, 'REDRAW_CHARACTER_IDENTITY_INPUT_INVALID');
      assert.deepEqual(
        fixture.db.prepare(`SELECT source_ref_json, approval_status, approved_by,
          approved_at, updated_at FROM redraw_assets WHERE id = ?`).get(fixture.assetId),
        before,
        JSON.stringify(patch),
      );
    }
  } finally {
    fixture.close();
  }
});

test('角色身份包 API 投影缺失时拒绝回退 raw saved 且不泄露路径', () => {
  const fixture = setupIdentityPackRouteFixture();
  const originalListAssets = redrawAssetService.listAssets;
  try {
    const before = fixture.db.prepare(`SELECT source_ref_json, approval_status, approved_by,
      approved_at, updated_at FROM redraw_assets WHERE id = ?`).get(fixture.assetId);
    redrawAssetService.listAssets = () => [];
    const result = captureResponse();
    fixture.handlers.saveRedrawCharacterIdentityPack(
      request({ id: fixture.assetId, body: completeIdentityPackRequest() }),
      result,
    );
    assert.equal(result.statusCode, 500);
    assert.equal(result.body.success, false);
    assert.equal(result.body.error.code, 'REDRAW_IDENTITY_PROJECTION_FAILED');
    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes('storageRoot'), false);
    assert.equal(serialized.includes('local_path'), false);
    assert.equal(serialized.includes('absolute_path'), false);
    assert.equal(serialized.includes('C:\\\\private'), false);
    const after = fixture.db.prepare(`SELECT source_ref_json, approval_status, approved_by,
      approved_at, updated_at FROM redraw_assets WHERE id = ?`).get(fixture.assetId);
    assert.notDeepEqual(after, before);
    assert.equal(after.approval_status, 'pending');
    assert.equal(after.approved_by, null);
  } finally {
    redrawAssetService.listAssets = originalListAssets;
    fixture.close();
  }
});

test('角色身份包 API 拒绝客户端控制和未知字段且不修改数据库', () => {
  const fixture = setupIdentityPackRouteFixture();
  try {
    const forbiddenFields = [
      'source_character_key', 'artifact', 'sha256', 'pack_sha256', 'ready',
      'reviewed_by', 'reviewed_at', 'asset_id', 'version_id', 'tenant_id', 'user_id',
      'path', 'url', 'approval_status', 'status', 'wardrobe_reference_sha256',
      'wardrobeReferenceSha256', 'wardrobe', 'unexpected_field',
    ];
    const before = fixture.db.prepare(`SELECT source_ref_json, approval_status, approved_by,
      approved_at, updated_at FROM redraw_assets WHERE id = ?`).get(fixture.assetId);

    for (const field of forbiddenFields) {
      const result = captureResponse();
      fixture.handlers.saveRedrawCharacterIdentityPack(
        request({
          id: fixture.assetId,
          body: completeIdentityPackRequest({ [field]: field === 'artifact' ? {} : 'forged' }),
        }),
        result,
      );
      assert.equal(result.statusCode, 400, field);
      assert.equal(result.body.error.code, 'REDRAW_CHARACTER_IDENTITY_INPUT_INVALID', field);
      assert.deepEqual(
        fixture.db.prepare(`SELECT source_ref_json, approval_status, approved_by,
          approved_at, updated_at FROM redraw_assets WHERE id = ?`).get(fixture.assetId),
        before,
        field,
      );
    }

    const aliases = captureResponse();
    fixture.handlers.saveRedrawCharacterIdentityPack(
      request({
        id: fixture.assetId,
        body: completeIdentityPackRequest({ targetActorLabel: 'Duplicate alias' }),
      }),
      aliases,
    );
    assert.equal(aliases.statusCode, 400);
    assert.equal(aliases.body.error.code, 'REDRAW_CHARACTER_IDENTITY_INPUT_INVALID');
    assert.deepEqual(
      fixture.db.prepare(`SELECT source_ref_json, approval_status, approved_by,
        approved_at, updated_at FROM redraw_assets WHERE id = ?`).get(fixture.assetId),
      before,
    );
  } finally {
    fixture.close();
  }
});

test('角色身份包 API 对跨 owner 统一返回 404', () => {
  const fixture = setupIdentityPackRouteFixture();
  try {
    for (const ownerPatch of [
      { tenantId: 'tenant-b', userId: 'user-a' },
      { tenantId: 'tenant-a', userId: 'user-b' },
    ]) {
      const result = captureResponse();
      fixture.handlers.saveRedrawCharacterIdentityPack(
        request({ id: fixture.assetId, body: completeIdentityPackRequest(), ...ownerPatch }),
        result,
      );
      assert.equal(result.statusCode, 404);
    }
  } finally {
    fixture.close();
  }
});

test('角色身份包 API 拒绝非角色资产并把 CAS 冲突映射为 409', () => {
  const nonCharacter = setupIdentityPackRouteFixture({ kind: 'prop' });
  try {
    const invalidKind = captureResponse();
    nonCharacter.handlers.saveRedrawCharacterIdentityPack(
      request({ id: nonCharacter.assetId, body: completeIdentityPackRequest() }),
      invalidKind,
    );
    assert.equal(invalidKind.statusCode, 400);
    assert.equal(invalidKind.body.error.code, 'REDRAW_IDENTITY_ASSET_INVALID_KIND');
  } finally {
    nonCharacter.close();
  }

  const conflict = setupIdentityPackRouteFixture();
  try {
    const result = captureResponse();
    conflict.handlers.saveRedrawCharacterIdentityPack(
      request({
        id: conflict.assetId,
        body: completeIdentityPackRequest({ expected_updated_at: '2026-08-05T00:00:00.000Z' }),
      }),
      result,
    );
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.error.code, 'REDRAW_IDENTITY_CONFLICT');
  } finally {
    conflict.close();
  }
});

test('角色身份包 API 允许保存明确未完成的包并保持 ready=false', () => {
  const fixture = setupIdentityPackRouteFixture();
  try {
    const result = captureResponse();
    fixture.handlers.saveRedrawCharacterIdentityPack(
      request({
        id: fixture.assetId,
        body: {
          targetActorLabel: 'Actor Maya',
          confirmedViews: ['front'],
          liveActionHumanConfirmed: false,
          adultStatus: 'unverified',
          identityConsistencyConfirmed: false,
          wardrobeReferenceAssetId: 702,
          wardrobeConsistencyConfirmed: false,
          expectedUpdatedAt: NOW,
        },
      }),
      result,
    );
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.data.identity_pack.ready, false);
    assert.equal(result.body.data.identity_pack_status.ready, false);
    assert.deepEqual(result.body.data.identity_pack_status.missing_views, ['profile', 'full_body']);
    assert.deepEqual(result.body.data.identity_pack_status.missing_confirmations, [
      'live_action_human_confirmed',
      'adult_status',
      'identity_consistency_confirmed',
      'wardrobe',
    ]);
  } finally {
    fixture.close();
  }
});

test('角色身份包 API 严格校验允许字段类型和值', () => {
  const fixture = setupIdentityPackRouteFixture();
  try {
    const invalidPatches = [
      { target_actor_label: '' },
      { target_actor_label: 'a'.repeat(101) },
      { confirmed_views: 'front' },
      { confirmed_views: ['front', 'rear'] },
      { live_action_human_confirmed: 1 },
      { adult_status: 'unknown' },
      { identity_consistency_confirmed: 'true' },
      { wardrobe_reference_asset_id: 0 },
      { wardrobe_reference_asset_id: '702' },
      { wardrobe_consistency_confirmed: 'true' },
      { expected_updated_at: ' ' },
    ];
    for (const patch of invalidPatches) {
      const result = captureResponse();
      fixture.handlers.saveRedrawCharacterIdentityPack(
        request({ id: fixture.assetId, body: completeIdentityPackRequest(patch) }),
        result,
      );
      assert.equal(result.statusCode, 400, JSON.stringify(patch));
      assert.equal(result.body.error.code, 'REDRAW_CHARACTER_IDENTITY_INPUT_INVALID');
    }
  } finally {
    fixture.close();
  }
});

test('第三步、角色身份包、本地化确认和参考准备 API 已真实注册在总路由', () => {
  const db = createDb();
  try {
    const router = setupRouter({}, db, { error() {}, warn() {}, info() {} });
    const routes = new Set(router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route.methods)
        .map((method) => `${method.toUpperCase()} ${layer.route.path}`)));
    assert.equal(routes.has('GET /redraw/works/:id'), true);
    assert.equal(routes.has('PUT /redraw/shots/:id'), true);
    assert.equal(routes.has('GET /redraw/shots/:id/reference-bundle'), true);
    assert.equal(routes.has('PUT /redraw/shots/:id/reference-bundle'), true);
    assert.equal(routes.has('POST /redraw/shots/:id/generate'), true);
    assert.equal(routes.has('POST /redraw/shots/:id/native-audio-review'), true);
    assert.equal(routes.has('POST /redraw/works/:id/generate-batch'), true);
    assert.equal(routes.has('POST /redraw/works/:id/localization-quote'), true);
    assert.equal(routes.has('POST /redraw/works/:id/versions'), true);
    assert.equal(routes.has('POST /redraw/versions/:id/assets/batch-quote'), true);
    assert.equal(routes.has('POST /redraw/versions/:id/assets/batches'), true);
    assert.equal(routes.has('GET /redraw/assets/:id/preview/:variant'), true);
    assert.equal(routes.has('PUT /redraw/assets/:id/identity-pack'), true);
    assert.equal(routes.has('GET /redraw/versions/:id/voices'), true);
    assert.equal(routes.has('GET /redraw/versions/:versionId/voices/:voiceAssetId/preview'), true);
    assert.equal(routes.has('POST /redraw/assets/:id/voice'), true);
    assert.equal(routes.has('GET /redraw/versions/:id/character-plan'), true);
    assert.equal(routes.has('GET /redraw/versions/:id/preparation-gate'), true);
    assert.equal(routes.has('POST /redraw/versions/:id/reference-preparation-quote'), true);
    assert.equal(routes.has('POST /redraw/versions/:id/reference-preparations'), true);
    assert.equal(routes.has('POST /redraw/versions/:id/dialogue/quote'), true);
    assert.equal(routes.has('POST /redraw/versions/:id/dialogue/start'), true);
    assert.equal(routes.has('GET /redraw/versions/:id/dialogue/tasks/:taskId'), true);
    assert.equal(routes.has('PUT /redraw/projects/:id/policy'), true);
    assert.equal(routes.has('GET /redraw/projects/:id/events'), true);
    assert.equal(routes.has('GET /redraw/versions/:id/generation-summary'), true);
    assert.equal(routes.has('GET /redraw/shots/:id/candidate-reviews'), true);
    assert.equal(routes.has('POST /redraw/shots/:id/candidate-reviews'), true);
    assert.equal(routes.has('GET /redraw/versions/:id/release-readiness'), true);
    assert.equal(routes.has('POST /redraw/versions/:id/releases'), true);
  } finally {
    db.close();
  }
});

test('参考准备 API 按 owner 接线、严格白名单且只传服务端受信上下文', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 2 });
    const versionId = Number(insertVersion(db, workId, { status: 'asset_review' }));
    const shotId = Number(insertShot(db, workId, versionId, { preparation_state: 'localized' }));
    const calls = [];
    const handlers = redrawRoutes(db, { error() {}, warn() {} }, routeDeps({
      cfg: { storage: { local_path: 'trusted-storage-root' } },
      characterPlanService: {
        buildCharacterPlan(ctx, id) {
          calls.push({ name: 'character-plan', ctx, id });
          return { version_id: id, ready: true, plan_hash: 'a'.repeat(64), characters: [] };
        },
      },
      preparationGateService: {
        evaluatePreparationGate(ctx, id) {
          calls.push({ name: 'preparation-gate', ctx, id });
          return { ok: false, version_id: id, ready_shot_ids: [], missing: [] };
        },
      },
      referencePreparationService: {
        async quoteVersionPreparation(ctx, input, deps) {
          calls.push({ name: 'quote', ctx, input, deps });
          return {
            version_id: ctx.versionId,
            selected_shot_ids: input.shot_ids || [shotId],
            action: 'needs_review',
            effective_mode: 'safe',
            reason_codes: [],
            priced: true,
            credits: 3,
            confirmation_required: true,
            quote_hash: 'quote-reference-ready',
          };
        },
        async startVersionPreparation(ctx, input, deps) {
          calls.push({ name: 'start', ctx, input, deps });
          return {
            task_id: 'task-reference-preparation',
            status: 'pending',
            quote: { quote_hash: input.quote_hash, credits: 3, priced: true },
            completion: new Promise(() => {}),
          };
        },
      },
    }));

    const plan = captureResponse();
    handlers.getCharacterPlan(request({ id: versionId }), plan);
    assert.equal(plan.statusCode, 200);
    assert.equal(plan.body.data.version_id, versionId);

    const gate = captureResponse();
    handlers.preparationGate(request({ id: versionId }), gate);
    assert.equal(gate.statusCode, 200);

    db.prepare(`UPDATE redraw_shots SET preparation_state = 'stale', stale_reason_code = 'voice_changed',
      preparation_snapshot_json = ? WHERE id = ?`).run(JSON.stringify({
      status: 'stale',
      requirements: [{ kind: 'person_clean', key: 'person-a', local_path: 'C:/private/mask.png' }],
      clean_results: [{
        kind: 'person_clean', key: 'person-a', status: 'completed',
        provider_task_id: 'private-provider-task', reservation_id: 'private-reservation',
      }],
      absolute_path: 'C:/private/reference.png',
    }), shotId);
    const work = captureResponse();
    handlers.getWork(request({ id: workId }), work);
    assert.equal(work.statusCode, 200);
    assert.equal(work.body.data.shots[0].preparation_state, 'stale');
    assert.equal(work.body.data.shots[0].stale_reason_code, 'voice_changed');
    assert.deepEqual(work.body.data.shots[0].preparation.requirements, [{ kind: 'person_clean', key: 'person-a' }]);
    assert.equal(JSON.stringify(work.body.data.shots[0]).includes('private'), false);

    const quote = captureResponse();
    await handlers.referencePreparationQuote(request({
      id: versionId,
      body: { shot_ids: [shotId] },
    }), quote);
    assert.equal(quote.statusCode, 200);
    assert.equal(quote.body.data.credits, 3);

    const started = captureResponse();
    await handlers.startReferencePreparation(request({
      id: versionId,
      body: {
        quote_hash: 'quote-reference-ready',
        idempotency_key: 'prep-route-once',
        shot_ids: [shotId],
      },
    }), started);
    assert.equal(started.statusCode, 202);
    assert.equal(started.body.data.task_id, 'task-reference-preparation');
    const startCall = calls.find((call) => call.name === 'start');
    assert.deepEqual(startCall.input, {
      quote_hash: 'quote-reference-ready',
      idempotency_key: 'prep-route-once',
      shot_ids: [shotId],
    });
    assert.equal(startCall.ctx.tenantId, 'tenant-a');
    assert.equal(startCall.ctx.userId, 'user-a');
    assert.equal(startCall.ctx.versionId, versionId);
    assert.equal(startCall.ctx.storageRoot.endsWith('trusted-storage-root'), true);
    assert.equal(typeof startCall.ctx.assetReader.canRead, 'function');
    assert.equal(typeof startCall.deps.quoteCleanRequirement, 'function');
    assert.equal(typeof startCall.deps.provider, 'function');

    for (const field of [
      'model', 'provider', 'price', 'credits', 'credit_amount', 'reservation',
      'reservation_id', 'reference_bundle_hash', 'referenceBundleHash',
      'path', 'local_path', 'absolute_path', 'url', 'asset_url',
    ]) {
      const forbidden = captureResponse();
      await handlers.startReferencePreparation(request({
        id: versionId,
        body: {
          quote_hash: 'quote-reference-ready',
          idempotency_key: `forbidden-${field}`,
          shot_ids: [shotId],
          [field]: 'attacker-controlled',
        },
      }), forbidden);
      assert.equal(forbidden.statusCode, 400, field);
      assert.equal(forbidden.body.error.code, 'REDRAW_REFERENCE_PREPARATION_CLIENT_CONTROL_FORBIDDEN', field);
    }
    assert.equal(calls.filter((call) => call.name === 'start').length, 1);

    for (const body of [
      { shot_ids: [999999] },
      { shot_ids: [shotId, shotId] },
      { shot_ids: [] },
    ]) {
      const invalidShots = captureResponse();
      await handlers.referencePreparationQuote(request({ id: versionId, body }), invalidShots);
      assert.equal(invalidShots.statusCode, 400, JSON.stringify(body));
      assert.equal(invalidShots.body.error.code, 'REDRAW_REFERENCE_PREPARATION_SHOTS_INVALID');

      const invalidStart = captureResponse();
      await handlers.startReferencePreparation(request({
        id: versionId,
        body: {
          quote_hash: 'quote-reference-ready',
          idempotency_key: 'invalid-start-scope',
          ...body,
        },
      }), invalidStart);
      assert.equal(invalidStart.statusCode, 400, JSON.stringify(body));
      assert.equal(invalidStart.body.error.code, 'REDRAW_REFERENCE_PREPARATION_SHOTS_INVALID');
    }
    assert.equal(calls.filter((call) => call.name === 'quote').length, 1);
    assert.equal(calls.filter((call) => call.name === 'start').length, 1);

    for (const req of [
      request({ id: versionId, tenantId: 'tenant-b' }),
      request({ id: versionId, userId: 'user-b' }),
      request({ id: 999999 }),
    ]) {
      const foreign = captureResponse();
      handlers.getCharacterPlan(req, foreign);
      assert.equal(foreign.statusCode, 404);
      assert.equal(foreign.body.error.code, 'REDRAW_VERSION_NOT_FOUND');
    }
    assert.equal(calls.filter((call) => call.name === 'character-plan').length, 1);
  } finally {
    db.close();
  }
});

test('参考准备默认报价与执行复用已验证净景能力和模型价格且报价不创建 attempt', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 2 });
    const versionId = Number(insertVersion(db, workId, { status: 'asset_review' }));
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, is_active, is_default,
       priority, settings, created_at, updated_at)
      VALUES ('image', 'trusted-image-provider', 'trusted image', ?, ?, 1, 1, 10, ?, ?, ?)`)
      .run(
        JSON.stringify(['gpt-image-2']),
        'gpt-image-2',
        JSON.stringify({ redraw_locale_capabilities: [{
          locale: 'en-US', market: 'US', status: 'verified',
          evidence: { clean_plate_image: {
            provider: 'trusted-image-provider', model: 'gpt-image-2',
            task_id: 'verified-clean-task', terminal_status: 'completed', artifact_id: 901,
          } },
        }] }),
        now,
        now,
      );
    prices.set(db, 'gpt-image-2', 6, { category: 'image' });
    let quoted;
    let prepared;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      prepareReferenceCleanRequirement: async (ctx, payload) => {
        prepared = { ctx, payload };
        return { status: 'completed', redraw_asset_id: 701 };
      },
      referencePreparationService: {
        async quoteVersionPreparation(ctx, _input, deps) {
          quoted = await deps.quoteCleanRequirement({
            ctx,
            scope: { locale: 'en-US', market: 'US' },
            requirement: { kind: 'person_clean', key: 'person-a' },
          });
          return quoted;
        },
        async startVersionPreparation(ctx, input, deps) {
          await deps.prepareCleanRequirement({
            ctx,
            scope: { locale: 'en-US', market: 'US' },
            requirement: { kind: 'text_clean', key: 'subtitle-a' },
            operation_key: 'server-operation-key',
          });
          return {
            task_id: 'task-reference-priced', status: 'pending',
            quote: { priced: true, credits: 6, quote_hash: input.quote_hash },
          };
        },
      },
    }));
    const before = db.prepare('SELECT COUNT(*) AS count FROM redraw_assets').get().count;
    const responseValue = captureResponse();
    await handlers.referencePreparationQuote(request({ id: versionId, body: {} }), responseValue);
    assert.equal(responseValue.statusCode, 200);
    assert.deepEqual(responseValue.body.data, { priced: true, credits: 6 });
    assert.deepEqual(quoted, { priced: true, credits: 6 });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_assets').get().count, before);

    const started = captureResponse();
    await handlers.startReferencePreparation(request({ id: versionId, body: {
      quote_hash: 'trusted-quote', idempotency_key: 'trusted-idempotency',
    } }), started);
    assert.equal(started.statusCode, 202);
    assert.equal(prepared.ctx.model, 'gpt-image-2');
    assert.equal(prepared.ctx.creditAmount, 6);
    assert.equal(prepared.ctx.operationKey, 'server-operation-key');
    assert.equal(typeof prepared.ctx.provider, 'function');
    assert.equal(prepared.payload.requirement.kind, 'text_clean');
  } finally {
    db.close();
  }
});

test('参考准备 API 对未知异常只返回脱敏错误', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = Number(insertVersion(db, workId));
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      referencePreparationService: {
        quoteVersionPreparation() {
          throw new Error('C:\\private\\reference.png https://secret.example/?key=abc');
        },
      },
    }));
    const result = captureResponse();
    await handlers.referencePreparationQuote(request({ id: versionId, body: {} }), result);
    assert.equal(result.statusCode, 500);
    assert.equal(result.body.error.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(result.body).includes('private'), false);
    assert.equal(JSON.stringify(result.body).includes('secret.example'), false);

    const codedHandlers = redrawRoutes(db, { error() {} }, routeDeps({
      referencePreparationService: {
        quoteVersionPreparation() {
          throw Object.assign(new Error('C:\\private\\coded.png https://coded-secret.example/?key=abc'), {
            code: 'REDRAW_REFERENCE_PREPARATION_PROVIDER_FAILED',
          });
        },
      },
    }));
    const codedResult = captureResponse();
    await codedHandlers.referencePreparationQuote(request({ id: versionId, body: {} }), codedResult);
    assert.equal(codedResult.statusCode, 500);
    assert.equal(codedResult.body.error.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(codedResult.body).includes('private'), false);
    assert.equal(JSON.stringify(codedResult.body).includes('coded-secret.example'), false);
  } finally {
    db.close();
  }
});

test('项目策略 API 严格白名单、CAS 更新并追加脱敏事件', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const missingCas = captureResponse();
    handlers.updateProjectPolicy(request({
      id: projectId,
      body: { execution_mode: 'safe' },
    }), missingCas);
    assert.equal(missingCas.statusCode, 400);
    assert.equal(missingCas.body.error.code, 'REDRAW_PROJECT_POLICY_EXPECTED_UPDATED_AT_REQUIRED');

    for (const field of ['default_market', 'default_locale', 'spent_credits', 'reservation_id', 'provider', 'model', 'apiKey', 'base_url', 'automation_policy_json', 'thresholds']) {
      const bad = captureResponse();
      handlers.updateProjectPolicy(request({
        id: projectId,
        body: { execution_mode: 'safe', expected_updated_at: NOW, [field]: 'client' },
      }), bad);
      assert.equal(bad.statusCode, 400, field);
      assert.equal(bad.body.error.code, 'REDRAW_PROJECT_POLICY_UNKNOWN_FIELD', field);
    }

    const ok = captureResponse();
    handlers.updateProjectPolicy(request({
      id: projectId,
      body: {
        execution_mode: 'auto',
        budget_limit_credits: 100,
        max_auto_attempts_per_shot: 2,
        expected_updated_at: NOW,
      },
    }), ok);
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(
      {
        execution_mode: ok.body.data.execution_mode,
        budget_limit_credits: ok.body.data.budget_limit_credits,
        max_auto_attempts_per_shot: ok.body.data.max_auto_attempts_per_shot,
        policy_version: ok.body.data.policy_version,
      },
      {
        execution_mode: 'auto',
        budget_limit_credits: 100,
        max_auto_attempts_per_shot: 2,
        policy_version: 2,
      },
    );
    assert.ok(ok.body.data.updated_at);
    assert.deepEqual(db.prepare(`
      SELECT default_market, default_locale FROM redraw_projects WHERE id = ?
    `).get(projectId), {
      default_market: 'US',
      default_locale: 'en-US',
    });
    const storedPolicy = db.prepare('SELECT automation_policy_json FROM redraw_projects WHERE id = ?')
      .get(projectId);
    assert.deepEqual(JSON.parse(storedPolicy.automation_policy_json), EXPECTED_SERVER_AUTOMATION_POLICY);

    const events = captureResponse();
    handlers.listProjectEvents(request({ id: projectId }), events);
    assert.equal(events.statusCode, 200);
    assert.equal(events.body.data.length, 1);
    assert.equal(events.body.data[0].reason_code, 'project_policy_updated');
    assert.match(events.body.data[0].evidence_hash, /^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(events.body.data);
    assert.equal(serialized.includes('metadata_json'), false);
    assert.equal(serialized.includes('apiKey'), false);
    assert.equal(serialized.includes('http'), false);
  } finally {
    db.close();
  }
});

test('项目策略 API 对跨 owner 统一 404，CAS 冲突 409 且不追加事件', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());

    const foreignPut = captureResponse();
    handlers.updateProjectPolicy(request({
      id: projectId,
      tenantId: 'tenant-b',
      body: {
        execution_mode: 'safe',
        expected_updated_at: NOW,
      },
    }), foreignPut);
    assert.equal(foreignPut.statusCode, 404);
    assert.equal(foreignPut.body.error.code, 'REDRAW_PROJECT_NOT_FOUND');

    const conflict = captureResponse();
    handlers.updateProjectPolicy(request({
      id: projectId,
      body: {
        execution_mode: 'auto',
        budget_limit_credits: 100,
        max_auto_attempts_per_shot: 2,
        expected_updated_at: '2026-08-05T00:00:00.000Z',
      },
    }), conflict);
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.body.error.code, 'REDRAW_PROJECT_POLICY_CONFLICT');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_workflow_events').get().count, 0);

    const foreignList = captureResponse();
    handlers.listProjectEvents(request({ id: projectId, userId: 'user-b' }), foreignList);
    assert.equal(foreignList.statusCode, 404);
    assert.equal(foreignList.body.error.code, 'REDRAW_PROJECT_NOT_FOUND');
  } finally {
    db.close();
  }
});

test('项目策略 API 拒绝继承字段和原型污染键且零写入', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());
    const before = db.prepare(`
      SELECT execution_mode, budget_limit_credits, max_auto_attempts_per_shot,
             policy_version, updated_at, automation_policy_json
      FROM redraw_projects WHERE id = ?
    `).get(projectId);

    const inheritedPolicy = Object.create({
      execution_mode: 'auto',
      budget_limit_credits: 100,
      max_auto_attempts_per_shot: 2,
      expected_updated_at: NOW,
    });
    const inherited = captureResponse();
    handlers.updateProjectPolicy(request({ id: projectId, body: inheritedPolicy }), inherited);
    assert.equal(inherited.statusCode, 400);
    assert.equal(inherited.body.error.code, 'REDRAW_PROJECT_POLICY_EXPECTED_UPDATED_AT_REQUIRED');

    const inheritedCas = Object.assign(Object.create({ expected_updated_at: NOW }), {
      execution_mode: 'safe',
    });
    const cas = captureResponse();
    handlers.updateProjectPolicy(request({ id: projectId, body: inheritedCas }), cas);
    assert.equal(cas.statusCode, 400);
    assert.equal(cas.body.error.code, 'REDRAW_PROJECT_POLICY_EXPECTED_UPDATED_AT_REQUIRED');

    const literalProto = { __proto__: { execution_mode: 'safe', expected_updated_at: NOW } };
    const literal = captureResponse();
    handlers.updateProjectPolicy(request({ id: projectId, body: literalProto }), literal);
    assert.equal(literal.statusCode, 400);
    assert.equal(literal.body.error.code, 'REDRAW_PROJECT_POLICY_EXPECTED_UPDATED_AT_REQUIRED');

    const jsonProto = JSON.parse(`{"__proto__":{"execution_mode":"safe"},"execution_mode":"safe","expected_updated_at":"${NOW}"}`);
    const ownProto = captureResponse();
    handlers.updateProjectPolicy(request({ id: projectId, body: jsonProto }), ownProto);
    assert.equal(ownProto.statusCode, 400);
    assert.equal(ownProto.body.error.code, 'REDRAW_PROJECT_POLICY_INVALID');

    assert.deepEqual(db.prepare(`
      SELECT execution_mode, budget_limit_credits, max_auto_attempts_per_shot,
             policy_version, updated_at, automation_policy_json
      FROM redraw_projects WHERE id = ?
    `).get(projectId), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_workflow_events').get().count, 0);
  } finally {
    db.close();
  }
});

test('转绘图片预览仅返回当前 owner 的存储根内图片', () => {
  const db = createDb();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-asset-preview-'));
  const outsidePath = path.join(path.dirname(storageRoot), `${path.basename(storageRoot)}-outside.png`);
  try {
    fs.mkdirSync(path.join(storageRoot, 'redraw-assets'), { recursive: true });
    const imagePath = path.join(storageRoot, 'redraw-assets', 'actor.png');
    fs.writeFileSync(imagePath, 'real actor preview');
    db.prepare(`INSERT INTO assets
      (id, name, type, category, url, local_path, mime_type, created_at, updated_at)
      VALUES (701, 'Mateo', 'image', 'redraw', '/static/unsafe-actor.png', 'redraw-assets/actor.png', 'image/png', ?, ?)`)
      .run(NOW, NOW);
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1 });
    const versionId = insertVersion(db, workId);
    const assetId = insertRedrawAsset(db, versionId, { localized_name: 'Mateo' });
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      cfg: { storage: { local_path: storageRoot } },
    }));

    const sent = { path: null, headers: {} };
    const ownerResponse = captureResponse();
    ownerResponse.setHeader = (name, value) => { sent.headers[name] = value; };
    ownerResponse.sendFile = (filename, callback) => {
      sent.path = filename;
      callback?.();
      return ownerResponse;
    };
    handlers.previewRedrawAsset({
      params: { id: String(assetId), variant: 'primary' },
      tenant: { id: 'tenant-a' },
      user: { id: 'user-a' },
    }, ownerResponse);

    assert.equal(sent.path, fs.realpathSync(imagePath));
    assert.equal(sent.headers['Content-Type'], 'image/png');
    assert.equal(sent.headers['Cache-Control'], 'private, no-store, max-age=0');
    assert.equal(sent.headers['X-Content-Type-Options'], 'nosniff');

    const foreign = captureResponse();
    handlers.previewRedrawAsset({
      params: { id: String(assetId), variant: 'primary' },
      tenant: { id: 'tenant-b' },
      user: { id: 'user-a' },
    }, foreign);
    assert.equal(foreign.statusCode, 404);

    const invalidVariant = captureResponse();
    handlers.previewRedrawAsset({
      params: { id: String(assetId), variant: 'source' },
      tenant: { id: 'tenant-a' },
      user: { id: 'user-a' },
    }, invalidVariant);
    assert.equal(invalidVariant.statusCode, 404);

    db.prepare(`INSERT INTO assets
      (id, name, type, category, local_path, mime_type, created_at, updated_at)
      VALUES (702, 'not-image', 'video', 'redraw', 'redraw-assets/actor.png', 'video/mp4', ?, ?)`)
      .run(NOW, NOW);
    const nonImageAssetId = insertRedrawAsset(db, versionId, { asset_id: 702, localized_name: '错误媒体' });
    const nonImage = captureResponse();
    handlers.previewRedrawAsset({
      params: { id: String(nonImageAssetId), variant: 'primary' },
      tenant: { id: 'tenant-a' },
      user: { id: 'user-a' },
    }, nonImage);
    assert.equal(nonImage.statusCode, 404);

    fs.writeFileSync(outsidePath, 'outside image');
    db.prepare(`INSERT INTO assets
      (id, name, type, category, local_path, mime_type, created_at, updated_at)
      VALUES (703, 'outside', 'image', 'redraw', ?, 'image/png', ?, ?)`)
      .run(`../${path.basename(outsidePath)}`, NOW, NOW);
    const outsideAssetId = insertRedrawAsset(db, versionId, { asset_id: 703, localized_name: '越界媒体' });
    const outside = captureResponse();
    handlers.previewRedrawAsset({
      params: { id: String(outsideAssetId), variant: 'primary' },
      tenant: { id: 'tenant-a' },
      user: { id: 'user-a' },
    }, outside);
    assert.equal(outside.statusCode, 404);
  } finally {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(outsidePath, { force: true });
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
          return { status: 'ready', priced: true, total_credits: 4, quote_hash: 'a'.repeat(64) };
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
            quote: { status: 'ready', priced: true, total_credits: 4, quote_hash: 'a'.repeat(64) },
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
    assert.equal(okQuote.body.data.priced, true);
    assert.equal(okQuote.body.data.quote_hash, 'a'.repeat(64));
    assert.equal(calls[0].input.versionId, versionId);
    assert.equal(calls[0].input.tenantId, 'tenant-a');

    const badStart = captureResponse();
    await handlers.startDialogue(request({
      id: versionId,
      body: { quote_hash: 'a'.repeat(64), idempotency_key: 'idem-route', credits: 1 },
    }), badStart);
    assert.equal(badStart.statusCode, 400);
    assert.equal(badStart.body.error.code, 'REDRAW_DIALOGUE_CLIENT_CONTROL_FORBIDDEN');

    const start = captureResponse();
    await handlers.startDialogue(request({
      id: versionId,
      body: { quote_hash: 'a'.repeat(64), idempotency_key: 'idem-route' },
    }), start);
    assert.equal(start.statusCode, 202);
    assert.equal(start.body.data.task_id, 'task-dialogue-route');
    assert.equal(start.body.data.quote.quote_hash, 'a'.repeat(64));
    assert.deepEqual(calls[1].input, { quoteHash: 'a'.repeat(64), idempotencyKey: 'idem-route' });

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

test('参考准备 start 将 needs_attention 范围冲突映射为 409 且不创建服务端任务', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 3 });
    const versionId = Number(insertVersion(db, workId, { status: 'asset_review' }));
    const shotId = Number(insertShot(db, workId, versionId, { preparation_state: 'needs_attention' }));
    let startCalls = 0;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      referencePreparationService: {
        async startVersionPreparation() {
          startCalls += 1;
          throw Object.assign(new Error('结果未知镜头只能人工核对'), {
            code: 'REDRAW_REFERENCE_PREPARATION_NEEDS_ATTENTION',
            details: {
              quote: {
                selected_shot_ids: [shotId],
                missing_shot_ids: [],
                needs_attention_shot_ids: [shotId],
                quote_hash: 'a'.repeat(64),
              },
            },
          });
        },
      },
    }));
    const result = captureResponse();
    await handlers.startReferencePreparation(request({
      id: versionId,
      body: {
        quote_hash: 'a'.repeat(64),
        idempotency_key: 'needs-attention-scope',
        shot_ids: [shotId],
      },
    }), result);
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.error.code, 'REDRAW_REFERENCE_PREPARATION_NEEDS_ATTENTION');
    assert.deepEqual(result.body.error.details.quote.needs_attention_shot_ids, [shotId]);
    assert.equal(startCalls, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM async_tasks WHERE type = 'redraw_reference_preparation'").get().count, 0);
  } finally {
    db.close();
  }
});

test('交付工作台生成摘要按 owner 返回预算、attempt 和规范 provider 状态', () => {
  const db = createDb();
  try {
    const projectId = insertProject(db, {
      execution_mode: 'auto',
      budget_limit_credits: 30,
      max_auto_attempts_per_shot: 3,
    });
    db.prepare(`UPDATE redraw_projects
      SET execution_mode = 'auto', budget_limit_credits = 30, max_auto_attempts_per_shot = 3
      WHERE id = ?`).run(projectId);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 3 });
    const versionId = insertVersion(db, workId, { status: 'generating' });
    const shotId = Number(insertShot(db, versionId, { status: 'failed' }));
    const heldShotId = Number(insertShot(db, versionId, { shot_index: 2, status: 'processing' }));
    const candidateShotId = Number(insertShot(db, versionId, { shot_index: 3, status: 'candidate_ready' }));
    const unknownShotId = Number(insertShot(db, versionId, { shot_index: 4, status: 'needs_attention' }));
    db.prepare(`INSERT INTO async_tasks
      (id, type, status, progress, resource_id, tenant_id, user_id, metadata, created_at, updated_at)
      VALUES ('delivery-task-1', 'redraw_shot', 'failed', 100, ?, 'tenant-a', 'user-a', ?, ?, ?)`)
      .run(String(shotId), JSON.stringify({ redraw_shot: { attempt: 2, reservation_id: 'delivery-reservation-1' } }), NOW, NOW);
    const videoId = Number(db.prepare(`INSERT INTO video_generations
      (status, task_id, tenant_id, user_id, provider_task_id, created_at, updated_at)
      VALUES ('failed', 'delivery-task-1', 'tenant-a', 'user-a', 'provider-safe-1', ?, ?)`)
      .run(NOW, NOW).lastInsertRowid);
    db.prepare('UPDATE redraw_shots SET video_generation_id = ? WHERE id = ?').run(videoId, shotId);
    const candidateVideoId = Number(db.prepare(`INSERT INTO video_generations
      (status, local_path, tenant_id, user_id, created_at, updated_at)
      VALUES ('completed', 'redraw/candidate.mp4', 'tenant-a', 'user-a', ?, ?)`)
      .run(NOW, NOW).lastInsertRowid);
    db.prepare('UPDATE redraw_shots SET video_generation_id = ? WHERE id = ?')
      .run(candidateVideoId, candidateShotId);
    for (const reservation of [
      ['delivery-reservation-1', 'confirmed', 10, shotId],
      ['delivery-reservation-2', 'held', 5, heldShotId],
    ]) {
      db.prepare(`INSERT INTO tenant_usage_reservations
        (id, tenant_id, operation_key, actor_user_id, model, resource_type, resource_id,
         amount, status, created_at, updated_at)
        VALUES (?, 'tenant-a', ?, 'user-a', 'server-model', 'redraw_shot', ?, ?, ?, ?, ?)`)
        .run(reservation[0], `operation-${reservation[0]}`, String(reservation[3]), reservation[2], reservation[1], NOW, NOW);
    }
    const handlers = redrawRoutes(db, { error() {} }, routeDeps());
    const output = captureResponse();
    handlers.generationSummary(request({ id: versionId }), output);
    assert.equal(output.statusCode, 200);
    assert.deepEqual(output.body.data.budget, { limit: 30, spent: 10, held: 5, remaining: 15 });
    assert.deepEqual(output.body.data.shots[0], {
      shot_id: shotId,
      shot_index: 1,
      status: 'failed',
      attempt: 2,
      provider_status: 'failed_terminal',
      provider_task_id: 'provider-safe-1',
      can_start_next_attempt: true,
      next_attempt: 3,
      policy_reason: null,
      updated_at: NOW,
    });
    assert.equal(JSON.stringify(output.body).includes('server-model'), false);
    assert.equal(output.body.data.shots.find((shot) => shot.shot_id === heldShotId).provider_status, 'running');
    assert.equal(output.body.data.shots.find((shot) => shot.shot_id === candidateShotId).provider_status, 'completed_candidate');
    assert.deepEqual(
      output.body.data.shots.find((shot) => shot.shot_id === unknownShotId),
      {
        shot_id: unknownShotId,
        shot_index: 4,
        status: 'needs_attention',
        attempt: 0,
        provider_status: 'submission_unknown',
        provider_task_id: null,
        can_start_next_attempt: false,
        next_attempt: null,
        policy_reason: 'submission_state_uncertain',
        updated_at: NOW,
      },
    );

    db.prepare('UPDATE redraw_shots SET deleted_at = ? WHERE id IN (?, ?)')
      .run(NOW, shotId, heldShotId);
    const afterSoftDelete = captureResponse();
    handlers.generationSummary(request({ id: versionId }), afterSoftDelete);
    assert.equal(afterSoftDelete.statusCode, 200);
    assert.deepEqual(afterSoftDelete.body.data.budget, {
      limit: 30,
      spent: 10,
      held: 5,
      remaining: 15,
    });
    assert.equal(afterSoftDelete.body.data.shots.some((shot) => shot.shot_id === shotId), false);
    assert.equal(afterSoftDelete.body.data.shots.some((shot) => shot.shot_id === heldShotId), false);

    const foreign = captureResponse();
    handlers.generationSummary(request({ id: versionId, tenantId: 'tenant-b' }), foreign);
    assert.equal(foreign.statusCode, 404);
  } finally {
    db.close();
  }
});

test('候选审核路由只允许人工白名单字段并保持 owner、CAS 与零副作用边界', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 3 });
    const versionId = insertVersion(db, workId);
    const shotId = Number(insertShot(db, versionId, { status: 'candidate_ready' }));
    const videoId = Number(db.prepare(`INSERT INTO video_generations
      (status, tenant_id, user_id, created_at, updated_at)
      VALUES ('completed', 'tenant-a', 'user-a', ?, ?)`)
      .run(NOW, NOW).lastInsertRowid);
    db.prepare('UPDATE redraw_shots SET video_generation_id = ? WHERE id = ?').run(videoId, shotId);
    const calls = [];
    const candidateReviewService = {
      getCurrentCandidateReview: () => ({
        id: 9,
        shot_id: shotId,
        decision: 'needs_review',
        decision_source: 'automatic',
        candidate_sha256: 'a'.repeat(64),
        reason_codes: ['safe_mode_human_review_required'],
        metrics: { visual: 'passed' },
      }),
      reviewCandidate: async (_ctx, input) => {
        calls.push(input);
        return { id: 10, ...input, reason_codes: input.reason_codes, metrics: {} };
      },
    };
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({ candidateReviewService }));

    for (const field of ['model', 'provider', 'price', 'credits', 'path', 'url', 'metrics', 'reviewer_id']) {
      const rejected = captureResponse();
      await handlers.reviewCandidate(request({
        id: shotId,
        body: {
          decision: 'approved',
          candidate_sha256: 'a'.repeat(64),
          expected_updated_at: NOW,
          [field]: 'attacker',
        },
      }), rejected);
      assert.equal(rejected.statusCode, 400, field);
    }
    assert.equal(calls.length, 0);

    const inherited = captureResponse();
    await handlers.reviewCandidate(request({
      id: shotId,
      body: Object.create({
        decision: 'approved',
        candidate_sha256: 'a'.repeat(64),
        expected_updated_at: NOW,
      }),
    }), inherited);
    assert.equal(inherited.statusCode, 400);
    assert.equal(calls.length, 0);

    const invalidDecision = captureResponse();
    await handlers.reviewCandidate(request({ id: shotId, body: {
      decision: 'needs_review', candidate_sha256: 'a'.repeat(64), expected_updated_at: NOW,
    } }), invalidDecision);
    assert.equal(invalidDecision.statusCode, 400);
    assert.equal(calls.length, 0);

    const approved = captureResponse();
    await handlers.reviewCandidate(request({ id: shotId, body: {
      decision: 'approved', reason_code: 'manual_visual_passed',
      candidate_sha256: 'a'.repeat(64), expected_updated_at: NOW,
    } }), approved);
    assert.equal(approved.statusCode, 200);
    assert.deepEqual(calls[0], {
      shot_id: shotId,
      video_generation_id: videoId,
      decision_source: 'human',
      decision: 'approved',
      reason_codes: ['manual_visual_passed'],
      candidate_sha256: 'a'.repeat(64),
      expected_updated_at: NOW,
    });

    const listed = captureResponse();
    handlers.listCandidateReviews(request({ id: shotId }), listed);
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.data.current.decision_source, 'automatic');
    assert.equal(listed.body.data.shot_updated_at, NOW);

    const foreign = captureResponse();
    handlers.listCandidateReviews(request({ id: shotId, tenantId: 'tenant-b' }), foreign);
    assert.equal(foreign.statusCode, 404);
  } finally {
    db.close();
  }
});

test('release readiness 与创建只使用服务端 hash、Task6 服务和受控相对下载 URL', async () => {
  const db = createDb();
  try {
    const projectId = insertProject(db);
    const workId = insertWork(db, projectId, { current_version: 1, current_step: 4 });
    const versionId = Number(insertVersion(db, workId, { status: 'composing' }));
    const release = {
      schema_version: 'redraw-episode-release-v1',
      version_id: versionId,
      shots: [{ shot_id: 1 }],
      quality_summary: { decision: 'approved' },
      release_hash: 'b'.repeat(64),
    };
    const builds = [];
    const compositions = [];
    let forceBlocked = false;
    const handlers = redrawRoutes(db, { error() {} }, routeDeps({
      episodeReleaseService: {
        buildEpisodeRelease: async (ctx, input) => {
          builds.push({ tenantId: ctx.tenantId, userId: ctx.userId, input });
          if (forceBlocked) throw Object.assign(new Error('version has no shots'), {
            code: 'REDRAW_EPISODE_RELEASE_SHOTS_EMPTY',
          });
          return release;
        },
      },
      compositionService: {
        createComposition: async (_ctx, input) => {
          compositions.push(input);
          return { id: 88, status: 'pending', version_number: 1, created: false };
        },
      },
    }));

    const readiness = captureResponse();
    await handlers.releaseReadiness(request({ id: versionId }), readiness);
    assert.equal(readiness.statusCode, 200);
    assert.equal(readiness.body.data.ready, true);
    assert.equal(readiness.body.data.readiness_hash, 'b'.repeat(64));

    for (const field of ['model', 'provider', 'price', 'path', 'url', 'metrics', 'release_hash']) {
      const rejected = captureResponse();
      await handlers.createRelease(request({ id: versionId, body: {
        idempotency_key: 'release-idem', readiness_hash: 'b'.repeat(64), [field]: 'attacker',
      } }), rejected);
      assert.equal(rejected.statusCode, 400, field);
    }
    assert.equal(compositions.length, 0);

    const inherited = captureResponse();
    await handlers.createRelease(request({
      id: versionId,
      body: Object.create({ idempotency_key: 'release-idem', readiness_hash: 'b'.repeat(64) }),
    }), inherited);
    assert.equal(inherited.statusCode, 400);
    assert.equal(compositions.length, 0);

    const stale = captureResponse();
    await handlers.createRelease(request({ id: versionId, body: {
      idempotency_key: 'release-idem', readiness_hash: 'c'.repeat(64),
    } }), stale);
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.error.code, 'REDRAW_RELEASE_READINESS_CONFLICT');
    assert.equal(compositions.length, 0);

    const created = captureResponse();
    await handlers.createRelease(request({ id: versionId, body: {
      idempotency_key: 'release-idem', readiness_hash: 'b'.repeat(64),
    } }), created);
    assert.equal(created.statusCode, 202);
    assert.deepEqual(compositions, [{ versionId, idempotencyKey: 'release-idem', audioMode: 'replace' }]);
    assert.deepEqual(created.body.data.downloads, {
      mp4: '/api/v1/redraw/exports/88/download/mp4',
      srt: '/api/v1/redraw/exports/88/download/srt',
      vtt: '/api/v1/redraw/exports/88/download/vtt',
      report: '/api/v1/redraw/exports/88',
    });
    assert.equal(JSON.stringify(created.body).includes('C:'), false);
    assert.equal(builds.every((item) => item.tenantId === 'tenant-a' && item.input.version_id === versionId), true);

    const auditQuality = {
      decision: 'approved',
      approved_shot_count: 1,
      automatic_review_count: 0,
      human_review_count: 1,
    };
    const auditShot = {
      shot_id: 7,
      shot_index: 1,
      start_ms: 0,
      end_ms: 5000,
      candidate_review_id: 19,
      candidate_sha256: 'c'.repeat(64),
      audio_sha256: 'd'.repeat(64),
      subtitle_sha256: 'e'.repeat(64),
      dependency_hash: 'f'.repeat(64),
    };
    const auditUnsignedRelease = {
      schema_version: 'redraw-episode-release-v1',
      project_id: projectId,
      work_id: workId,
      version_id: versionId,
      locale: 'en-US',
      market: 'US',
      shots: [auditShot],
      quality_summary: auditQuality,
    };
    const auditReleaseHash = crypto.createHash('sha256').update(stableJson(auditUnsignedRelease)).digest('hex');
    const auditRelease = { ...auditUnsignedRelease, release_hash: auditReleaseHash };
    const taintedRelease = {
      ...auditRelease,
      provider_raw: { api_key: 'secret-provider-key', url: 'https://provider.invalid/raw' },
      absolute_path: 'C:\\private\\episode.mp4',
      shots: [{
        ...auditShot,
        provider: 'attacker-provider',
        local_path: 'C:\\private\\candidate.mp4',
        external_url: 'https://attacker.invalid/candidate.mp4',
      }],
      quality_summary: { ...auditQuality, provider_metrics: { raw: true } },
    };
    const insertAuditExport = db.prepare(`INSERT INTO redraw_exports
      (version_id, tenant_id, user_id, export_type, version_number, manifest_json,
       release_hash, quality_summary_json, status, created_at, updated_at)
      VALUES (?, 'tenant-a', 'user-a', 'video', ?, ?, ?, ?, ?, ?, ?)`);
    const completedExportId = Number(insertAuditExport.run(
      versionId,
      2,
      JSON.stringify({
        episode_release: taintedRelease,
        provider_raw: { api_key: 'secret-provider-key' },
        outputs: { absolute_path: 'C:\\private\\episode.mp4', external_url: 'https://provider.invalid/file' },
      }),
      auditReleaseHash,
      JSON.stringify({ ...auditQuality, provider_raw: { score: 1 } }),
      'completed',
      NOW,
      NOW,
    ).lastInsertRowid);
    const completedReport = captureResponse();
    handlers.getExport(request({ id: completedExportId }), completedReport);
    assert.equal(completedReport.statusCode, 200);
    assert.equal(completedReport.body.data.release_hash, auditReleaseHash);
    assert.deepEqual(completedReport.body.data.quality_summary, auditQuality);
    assert.deepEqual(completedReport.body.data.episode_release, auditRelease);
    assert.equal(completedReport.body.data.downloads.report, `/api/v1/redraw/exports/${completedExportId}`);
    assert.equal(/C:\\|https?:\/\/|provider_raw|api_key|external_url|local_path/
      .test(JSON.stringify(completedReport.body.data)), false);

    for (const [status, versionNumber] of [['pending', 3], ['failed', 4]]) {
      const exportId = Number(insertAuditExport.run(
        versionId,
        versionNumber,
        JSON.stringify({ episode_release: taintedRelease }),
        auditReleaseHash,
        JSON.stringify(auditQuality),
        status,
        NOW,
        NOW,
      ).lastInsertRowid);
      const notAReport = captureResponse();
      handlers.getExport(request({ id: exportId }), notAReport);
      assert.equal(notAReport.statusCode, 200);
      assert.equal(Object.hasOwn(notAReport.body.data, 'release_hash'), false, status);
      assert.equal(Object.hasOwn(notAReport.body.data, 'quality_summary'), false, status);
      assert.equal(Object.hasOwn(notAReport.body.data, 'episode_release'), false, status);
      assert.equal(Object.hasOwn(notAReport.body.data, 'downloads'), false, status);
    }

    forceBlocked = true;
    const blocked = captureResponse();
    await handlers.releaseReadiness(request({ id: versionId }), blocked);
    assert.equal(blocked.statusCode, 200);
    assert.deepEqual(blocked.body.data, {
      ready: false,
      version_id: versionId,
      readiness_hash: null,
      blockers: [{ shot_id: null, reason_code: 'shots_empty' }],
    });

    const foreign = captureResponse();
    await handlers.releaseReadiness(request({ id: versionId, tenantId: 'tenant-b' }), foreign);
    assert.equal(foreign.statusCode, 404);
  } finally {
    db.close();
  }
});

test('release readiness 按对白轮次检查生成音频而不比较跨域 segment_id', async (t) => {
  for (const mutation of ['valid', 'turn_index', 'start_ms', 'start_ms_type', 'end_ms', 'speaker_id', 'text_hash']) {
    await t.test(mutation, async () => {
      const db = createDb();
      try {
        const projectId = insertProject(db);
        const workId = insertWork(db, projectId, { current_version: 1, current_step: 4 });
        const versionId = Number(insertVersion(db, workId, { status: 'composing' }));
        const localized = {
          segment_id: 'g1-t1',
          speaker_id: 'Maya',
          target_text: 'Come with me.',
          start_ms: 500,
          end_ms: 1500,
        };
        const shotId = Number(insertShot(db, versionId, {
          start_ms: 0,
          end_ms: 2000,
          duration_ms: 2000,
          status: 'approved',
          video_generation_id: 41,
          localized_dialogue_json: JSON.stringify([localized]),
        }));
        const generated = {
          segment_id: `${shotId}:0`,
          turn_index: 0,
          speaker_id: localized.speaker_id,
          start_ms: localized.start_ms,
          end_ms: localized.end_ms,
          text_hash: crypto.createHash('sha256').update(localized.target_text).digest('hex'),
          status: 'completed',
          reservation_status: 'confirmed',
          audio_asset_id: 51,
        };
        if (mutation === 'turn_index') generated.turn_index = 1;
        if (mutation === 'start_ms') generated.start_ms += 1;
        if (mutation === 'start_ms_type') generated.start_ms = String(generated.start_ms);
        if (mutation === 'end_ms') generated.end_ms -= 1;
        if (mutation === 'speaker_id') generated.speaker_id = 'speaker-drift';
        if (mutation === 'text_hash') generated.text_hash = '0'.repeat(64);
        db.prepare('UPDATE redraw_shots SET approved_candidate_review_id = 31, draft_json = ? WHERE id = ?')
          .run(JSON.stringify({ dialogue_generation: { status: 'completed', segments: [generated] } }), shotId);

        const handlers = redrawRoutes(db, { error() {} }, routeDeps({
          candidateReviewService: {
            assertCurrentApprovedCandidate: () => ({ id: 31 }),
          },
          episodeReleaseService: {
            buildEpisodeRelease: async () => {
              if (mutation !== 'valid') {
                throw Object.assign(new Error('dialogue audio mismatch'), {
                  code: 'REDRAW_EPISODE_RELEASE_AUDIO_CONTRACT_INVALID',
                });
              }
              return {
                release_hash: 'a'.repeat(64),
                shots: [{ shot_id: shotId }],
                quality_summary: { decision: 'approved' },
              };
            },
          },
        }));
        const response = captureResponse();
        await handlers.releaseReadiness(request({ id: versionId }), response);
        assert.equal(response.statusCode, 200);
        if (mutation === 'valid') {
          assert.equal(response.body.data.ready, true);
        } else {
          assert.deepEqual(response.body.data.blockers, [
            { shot_id: shotId, reason_code: 'dialogue_audio_contract_invalid' },
          ]);
        }
      } finally {
        db.close();
      }
    });
  }
});

async function withRouteServer(router, run) {
  const app = express();
  app.use('/api/v1', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}/api/v1`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function waitForDirectoryState(directory, predicate, label) {
  return new Promise((resolve, reject) => {
    let watcher;
    const fileWatchers = new Map();
    const closeWatchers = () => {
      watcher?.close();
      for (const fileWatcher of fileWatchers.values()) fileWatcher.close();
      fileWatchers.clear();
    };
    const timeout = setTimeout(() => {
      closeWatchers();
      reject(new Error(`timed out waiting for ${label}`));
    }, 5000);
    const inspect = () => {
      try {
        const entries = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
        for (const entry of entries) {
          if (fileWatchers.has(entry)) continue;
          const target = path.join(directory, entry);
          try {
            fs.watchFile(target, { interval: 20 }, inspect);
            fileWatchers.set(entry, { close: () => fs.unwatchFile(target, inspect) });
          } catch (_) {}
        }
        if (!predicate(entries)) return;
        clearTimeout(timeout);
        closeWatchers();
        resolve(entries);
      } catch (error) {
        clearTimeout(timeout);
        closeWatchers();
        reject(error);
      }
    };
    watcher = fs.watch(directory, inspect);
    inspect();
  });
}

function referenceImportRouterFixture(importService) {
  const db = createDb();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-reference-route-storage-'));
  const tempRoot = path.join(storageRoot, 'http-motion-temp');
  const secret = 'redraw-reference-route-secret-value-at-least-32-bytes';
  const previous = {
    publicMode: process.env.PUBLIC_PLATFORM_MODE,
    jwtSecret: process.env.PLATFORM_JWT_SECRET,
  };
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = secret;
  const user = userAuthService.register(db, {
    email: `redraw-reference-${crypto.randomUUID()}@example.test`,
    password: 'route-fixture-password-123',
  });
  const tenantId = `personal:${user.id}`;
  const projectId = insertProject(db, { tenant_id: tenantId, user_id: user.id });
  const workId = insertWork(db, projectId, { tenant_id: tenantId, user_id: user.id });
  const versionId = Number(insertVersion(db, workId, { tenant_id: tenantId, user_id: user.id }));
  const assetId = Number(insertRedrawAsset(db, versionId, {
    tenant_id: tenantId, user_id: user.id, kind: 'character', updated_at: NOW,
  }));
  const shotId = Number(insertShot(db, versionId, {
    work_id: workId, tenant_id: tenantId, user_id: user.id, updated_at: NOW,
  }));
  const noProvider = async () => ({ status: 'completed' });
  const router = setupRouter({ storage: { local_path: storageRoot } }, db, {
    error() {}, warn() {}, info() {},
  }, {
    localizationProvider: noProvider,
    assetGenerationProvider: noProvider,
    dialogueProvider: noProvider,
    redrawOptions: {
      referenceArtifactImportService: importService,
      referenceArtifactTempRoot: tempRoot,
    },
  });
  const token = userAuthService.issueToken(user, secret, 0);
  return {
    db, router, storageRoot, tempRoot, user, tenantId, token, assetId, shotId, versionId,
    close() {
      db.close();
      fs.rmSync(storageRoot, { recursive: true, force: true });
      if (previous.publicMode === undefined) delete process.env.PUBLIC_PLATFORM_MODE;
      else process.env.PUBLIC_PLATFORM_MODE = previous.publicMode;
      if (previous.jwtSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
      else process.env.PLATFORM_JWT_SECRET = previous.jwtSecret;
    },
  };
}

test('reference artifact route requires auth and tenant before multipart parsing side effects', async () => {
  const calls = [];
  const fixture = referenceImportRouterFixture({
    async importCharacterReferenceArtifact(...args) { calls.push(args); return {}; },
    async importMotionReferenceArtifact(...args) { calls.push(args); return {}; },
  });
  try {
    const registered = new Set(fixture.router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route.methods)
        .map((method) => `${method.toUpperCase()} ${layer.route.path}`)));
    assert.equal(registered.has('POST /redraw/assets/:id/reference-artifact'), true);
    assert.equal(registered.has('POST /redraw/shots/:id/motion-reference'), true);
    await withRouteServer(fixture.router, async (baseUrl) => {
      const motion = new FormData();
      motion.set('expected_updated_at', NOW);
      motion.set('full_frame_reviewed', 'true');
      motion.set('source_identity_obscured', 'true');
      motion.set('source_text_obscured', 'true');
      motion.set('motion_preserved', 'true');
      motion.set('file', new Blob([Buffer.from('0000ftypisom')], { type: 'video/mp4' }), 'motion.mp4');
      const unauthorized = await fetch(`${baseUrl}/redraw/shots/${fixture.shotId}/motion-reference`, {
        method: 'POST', body: motion,
      });
      assert.equal(unauthorized.status, 401);

      const invalidTenant = new FormData();
      invalidTenant.set('expected_updated_at', NOW);
      invalidTenant.set('purpose', 'identity');
      invalidTenant.set('file', new Blob([Buffer.from('image')], { type: 'image/png' }), 'identity.png');
      const tenantFailure = await fetch(`${baseUrl}/redraw/assets/${fixture.assetId}/reference-artifact`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'X-Tenant-Id': 'tenant-not-owned',
          'Idempotency-Key': 'tenant-failure-key',
        },
        body: invalidTenant,
      });
      assert.equal(tenantFailure.status, 404);
    });
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(fixture.tempRoot), false);
  } finally {
    fixture.close();
  }
});

test('reference artifact multipart limits keep character in memory and motion on bounded disk storage', () => {
  const multerPath = require.resolve('multer');
  const redrawPath = require.resolve('../src/routes/redraw');
  const originalMulter = require.cache[multerPath];
  const originalRedraw = require.cache[redrawPath];
  const captured = [];
  const captureMulter = (config) => {
    captured.push(config);
    return { single: () => (_req, _res, next) => next() };
  };
  captureMulter.memoryStorage = () => ({ storage_kind: 'memory' });
  captureMulter.diskStorage = (config) => ({ storage_kind: 'disk', config });
  require.cache[multerPath] = {
    id: multerPath,
    filename: multerPath,
    loaded: true,
    exports: captureMulter,
  };
  delete require.cache[redrawPath];

  const db = createDb();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-reference-limit-test-'));
  try {
    const capturedRedrawRoutes = require('../src/routes/redraw');
    capturedRedrawRoutes(db, { error() {}, warn() {}, info() {} }, routeDeps({
      cfg: { storage: { local_path: tempRoot } },
      referenceArtifactTempRoot: path.join(tempRoot, 'motion-temp'),
    }));
    const character = captured.find((config) => config?.limits?.fields === 2
      && config?.limits?.files === 1);
    const motion = captured.find((config) => config?.limits?.fields === 5
      && config?.limits?.files === 1);
    assert.equal(character.limits.fileSize, 20 * 1024 * 1024);
    assert.equal(character.storage.storage_kind, 'memory');
    assert.equal(motion.limits.fileSize, 200 * 1024 * 1024);
    assert.equal(motion.storage.storage_kind, 'disk');
    assert.equal(motion.limits.parts, 7);
    let generatedName;
    motion.storage.config.filename({}, { originalname: '../../client-name.mp4' }, (_error, value) => {
      generatedName = value;
    });
    assert.match(generatedName, /^motion-\d+-\d+-[a-f0-9]{24}\.upload$/);
    assert.equal(generatedName.includes('client-name'), false);
  } finally {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    delete require.cache[redrawPath];
    if (originalRedraw) require.cache[redrawPath] = originalRedraw;
    if (originalMulter) require.cache[multerPath] = originalMulter;
    else delete require.cache[multerPath];
  }
});

test('character reference artifact route maps multipart owner version and idempotency to service', async () => {
  const calls = [];
  const serviceResult = {
    purpose: 'identity',
    asset: { id: 801, type: 'image', mime_type: 'image/png', sha256: 'a'.repeat(64), width: 640, height: 960, file_size: 12 },
    redraw_asset: { id: 11, asset_id: 801, status: 'generated', approval_status: 'pending', approved_by: null, approved_at: null, error_code: null, updated_at: NOW },
    billing: { credits: 0, held: 0, charged: 0 },
  };
  const fixture = referenceImportRouterFixture({
    async importCharacterReferenceArtifact(ctx, input) { calls.push({ ctx, input }); return serviceResult; },
    async importMotionReferenceArtifact() { throw new Error('unexpected motion import'); },
  });
  try {
    await withRouteServer(fixture.router, async (baseUrl) => {
      const form = new FormData();
      form.set('purpose', 'identity');
      form.set('expected_updated_at', NOW);
      form.set('file', new Blob([Buffer.from('reference-image')], { type: 'image/png' }), 'identity.png');
      const result = await fetch(`${baseUrl}/redraw/assets/${fixture.assetId}/reference-artifact`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'X-Tenant-Id': fixture.tenantId,
          'Idempotency-Key': 'character-route-idempotency',
        },
        body: form,
      });
      const responseBody = await result.text();
      assert.equal(result.status, 200, responseBody);
      assert.deepEqual(JSON.parse(responseBody).data, serviceResult);
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ctx.tenantId, fixture.tenantId);
    assert.equal(calls[0].ctx.userId, fixture.user.id);
    assert.equal(calls[0].ctx.versionId, fixture.versionId);
    assert.equal(calls[0].ctx.storageRoot, path.resolve(fixture.storageRoot));
    assert.deepEqual({
      assetId: calls[0].input.assetId,
      purpose: calls[0].input.purpose,
      expectedUpdatedAt: calls[0].input.expectedUpdatedAt,
      idempotencyKey: calls[0].input.idempotencyKey,
      originalname: calls[0].input.file.originalname,
      mimetype: calls[0].input.file.mimetype,
      buffer: calls[0].input.file.buffer.toString(),
    }, {
      assetId: fixture.assetId,
      purpose: 'identity',
      expectedUpdatedAt: NOW,
      idempotencyKey: 'character-route-idempotency',
      originalname: 'identity.png',
      mimetype: 'image/png',
      buffer: 'reference-image',
    });
  } finally {
    fixture.close();
  }
});

test('motion reference route maps strict review booleans and cleans disk multipart temp', async () => {
  const calls = [];
  const serviceResult = {
    purpose: 'motion',
    asset: { id: 901, type: 'video', mime_type: 'video/mp4', sha256: 'b'.repeat(64), duration_ms: 5000, width: 640, height: 360, file_size: 12 },
    billing: { credits: 0, held: 0, charged: 0 },
  };
  const fixture = referenceImportRouterFixture({
    async importCharacterReferenceArtifact() { throw new Error('unexpected character import'); },
    async importMotionReferenceArtifact(ctx, input) { calls.push({ ctx, input }); return serviceResult; },
  });
  try {
    await withRouteServer(fixture.router, async (baseUrl) => {
      const form = new FormData();
      form.set('expected_updated_at', NOW);
      form.set('full_frame_reviewed', 'true');
      form.set('source_identity_obscured', 'true');
      form.set('source_text_obscured', 'true');
      form.set('motion_preserved', 'true');
      form.set('file', new Blob([Buffer.from('0000ftypisom')], { type: 'video/mp4' }), 'motion.mp4');
      const result = await fetch(`${baseUrl}/redraw/shots/${fixture.shotId}/motion-reference`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'X-Tenant-Id': fixture.tenantId,
          'Idempotency-Key': 'motion-route-idempotency',
        },
        body: form,
      });
      const responseBody = await result.text();
      assert.equal(result.status, 200, responseBody);
      assert.deepEqual(JSON.parse(responseBody).data, serviceResult);
    });
    assert.equal(calls.length, 1);
    assert.deepEqual({
      shotId: calls[0].input.shotId,
      expectedUpdatedAt: calls[0].input.expectedUpdatedAt,
      idempotencyKey: calls[0].input.idempotencyKey,
      fullFrameReviewed: calls[0].input.fullFrameReviewed,
      sourceIdentityObscured: calls[0].input.sourceIdentityObscured,
      sourceTextObscured: calls[0].input.sourceTextObscured,
      motionPreserved: calls[0].input.motionPreserved,
      file: calls[0].input.file.buffer.toString(),
    }, {
      shotId: fixture.shotId,
      expectedUpdatedAt: NOW,
      idempotencyKey: 'motion-route-idempotency',
      fullFrameReviewed: true,
      sourceIdentityObscured: true,
      sourceTextObscured: true,
      motionPreserved: true,
      file: '0000ftypisom',
    });
    assert.deepEqual(fs.existsSync(fixture.tempRoot) ? fs.readdirSync(fixture.tempRoot) : [], []);
  } finally {
    fixture.close();
  }
});

test('reference artifact routes reject forbidden fields and redact internal service errors', async () => {
  let calls = 0;
  const fixture = referenceImportRouterFixture({
    async importCharacterReferenceArtifact() {
      calls += 1;
      throw Object.assign(new Error('C:\\private\\probe.mp4 SQL SELECT Authorization: Bearer secret provider_key=abc'), {
        code: 'REDRAW_REFERENCE_ARTIFACT_STORAGE_FAILED',
      });
    },
    async importMotionReferenceArtifact() { calls += 1; return {}; },
  });
  try {
    await withRouteServer(fixture.router, async (baseUrl) => {
      const forbidden = new FormData();
      forbidden.set('purpose', 'identity');
      forbidden.set('expected_updated_at', NOW);
      forbidden.set('provider', 'forbidden-provider');
      forbidden.set('file', new Blob([Buffer.from('image')], { type: 'image/png' }), 'identity.png');
      const rejected = await fetch(`${baseUrl}/redraw/assets/${fixture.assetId}/reference-artifact`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'X-Tenant-Id': fixture.tenantId,
          'Idempotency-Key': 'forbidden-field-key',
        },
        body: forbidden,
      });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error.code, 'REDRAW_REFERENCE_ARTIFACT_FORBIDDEN_FIELD');
      assert.equal(calls, 0);

      const unsafe = new FormData();
      unsafe.set('purpose', 'identity');
      unsafe.set('expected_updated_at', NOW);
      unsafe.set('file', new Blob([Buffer.from('image')], { type: 'image/png' }), 'identity.png');
      const failed = await fetch(`${baseUrl}/redraw/assets/${fixture.assetId}/reference-artifact`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'X-Tenant-Id': fixture.tenantId,
          'Idempotency-Key': 'storage-error-key',
        },
        body: unsafe,
      });
      const body = await failed.text();
      assert.equal(failed.status, 500, body);
      assert.equal(body.includes('C:\\private'), false);
      assert.equal(/Authorization|Bearer|SELECT|provider_key|secret/i.test(body), false);
      assert.equal(JSON.parse(body).error.code, 'REDRAW_REFERENCE_ARTIFACT_STORAGE_FAILED');
    });
    assert.equal(calls, 1);
  } finally {
    fixture.close();
  }
});

test('motion reference route rejects cross-owner ambiguous booleans and idempotency conflicts safely', async () => {
  const calls = [];
  const fixture = referenceImportRouterFixture({
    async importCharacterReferenceArtifact() { throw new Error('unexpected character import'); },
    async importMotionReferenceArtifact(ctx, input) {
      calls.push({ ctx, input });
      throw Object.assign(new Error('idempotency conflict with Authorization: Bearer private'), {
        code: 'REDRAW_REFERENCE_ARTIFACT_IDEMPOTENCY_CONFLICT',
      });
    },
  });
  try {
    const otherUser = userAuthService.register(fixture.db, {
      email: `redraw-reference-other-${crypto.randomUUID()}@example.test`,
      password: 'route-fixture-password-456',
    });
    const otherTenantId = `personal:${otherUser.id}`;
    const otherProjectId = insertProject(fixture.db, {
      tenant_id: otherTenantId,
      user_id: otherUser.id,
    });
    const otherWorkId = insertWork(fixture.db, otherProjectId, {
      tenant_id: otherTenantId,
      user_id: otherUser.id,
    });
    const otherVersionId = Number(insertVersion(fixture.db, otherWorkId, {
      tenant_id: otherTenantId,
      user_id: otherUser.id,
    }));
    const otherShotId = Number(insertShot(fixture.db, otherVersionId, {
      work_id: otherWorkId,
      tenant_id: otherTenantId,
      user_id: otherUser.id,
      updated_at: NOW,
    }));

    await withRouteServer(fixture.router, async (baseUrl) => {
      function motionForm(booleanValue = 'true') {
        const form = new FormData();
        form.set('expected_updated_at', NOW);
        form.set('full_frame_reviewed', booleanValue);
        form.set('source_identity_obscured', 'true');
        form.set('source_text_obscured', 'true');
        form.set('motion_preserved', 'true');
        form.set('file', new Blob([Buffer.from('0000ftypisom')], { type: 'video/mp4' }), 'motion.mp4');
        return form;
      }

      const crossOwner = await fetch(`${baseUrl}/redraw/shots/${otherShotId}/motion-reference`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'X-Tenant-Id': fixture.tenantId,
          'Idempotency-Key': 'cross-owner-key',
        },
        body: motionForm(),
      });
      assert.equal(crossOwner.status, 404);
      assert.equal((await crossOwner.json()).error.code, 'REDRAW_REFERENCE_ARTIFACT_NOT_FOUND');
      assert.equal(fs.existsSync(fixture.tempRoot), false);
      assert.equal(calls.length, 0);

      const ambiguous = await fetch(`${baseUrl}/redraw/shots/${fixture.shotId}/motion-reference`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'X-Tenant-Id': fixture.tenantId,
          'Idempotency-Key': 'ambiguous-boolean-key',
        },
        body: motionForm('1'),
      });
      assert.equal(ambiguous.status, 400);
      assert.equal((await ambiguous.json()).error.code, 'REDRAW_REFERENCE_ARTIFACT_INPUT_INVALID');
      assert.equal(calls.length, 0);
      assert.deepEqual(fs.existsSync(fixture.tempRoot) ? fs.readdirSync(fixture.tempRoot) : [], []);

      const conflict = await fetch(`${baseUrl}/redraw/shots/${fixture.shotId}/motion-reference`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'X-Tenant-Id': fixture.tenantId,
          'Idempotency-Key': 'conflict-key',
        },
        body: motionForm(),
      });
      const conflictBody = await conflict.text();
      assert.equal(conflict.status, 409, conflictBody);
      assert.equal(JSON.parse(conflictBody).error.code, 'REDRAW_REFERENCE_ARTIFACT_IDEMPOTENCY_CONFLICT');
      assert.equal(/Authorization|Bearer|private/i.test(conflictBody), false);
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input.idempotencyKey, 'conflict-key');
    assert.deepEqual(fs.existsSync(fixture.tempRoot) ? fs.readdirSync(fixture.tempRoot) : [], []);
  } finally {
    fixture.close();
  }
});

test('aborted motion multipart removes started disk temp without calling import service', async () => {
  let calls = 0;
  const fixture = referenceImportRouterFixture({
    async importCharacterReferenceArtifact() { throw new Error('unexpected character import'); },
    async importMotionReferenceArtifact() { calls += 1; return {}; },
  });
  try {
    fs.mkdirSync(fixture.tempRoot, { recursive: true });
    await withRouteServer(fixture.router, async (baseUrl) => {
      const url = new URL(`${baseUrl}/redraw/shots/${fixture.shotId}/motion-reference`);
      const fileBytes = Buffer.alloc(512 * 1024, 0x61);
      const form = new FormData();
      form.set('expected_updated_at', NOW);
      form.set('full_frame_reviewed', 'true');
      form.set('source_identity_obscured', 'true');
      form.set('source_text_obscured', 'true');
      form.set('motion_preserved', 'true');
      form.set('file', new Blob([fileBytes], { type: 'video/mp4' }), 'motion.mp4');
      const serialized = new Request('http://multipart.test', { method: 'POST', body: form });
      const fullBody = Buffer.from(await serialized.arrayBuffer());
      const fileOffset = fullBody.indexOf(fileBytes.subarray(0, 64));
      assert.ok(fileOffset > 0);
      const multipartHeaders = fullBody.subarray(0, fileOffset + 1);
      const fileChunk = fullBody.subarray(fileOffset + 1, fileOffset + (256 * 1024));
      const clientSocket = net.createConnection({ host: url.hostname, port: Number(url.port) });
      clientSocket.on('error', () => {});
      const responseChunks = [];
      clientSocket.on('data', (chunk) => responseChunks.push(chunk));
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timed out waiting for multipart connect')), 5000);
        clientSocket.once('connect', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      const requestHeaders = Buffer.from([
        `POST ${url.pathname} HTTP/1.1`,
        `Host: ${url.hostname}:${url.port}`,
        `Authorization: Bearer ${fixture.token}`,
        `X-Tenant-Id: ${fixture.tenantId}`,
        'Idempotency-Key: aborted-motion-key',
        `Content-Type: ${serialized.headers.get('content-type')}`,
        `Content-Length: ${fullBody.length}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'));
      let flushed = clientSocket.write(Buffer.concat([requestHeaders, multipartHeaders]));
      if (!flushed) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('timed out waiting for multipart drain')), 5000);
          clientSocket.once('drain', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
      await waitForDirectoryState(fixture.tempRoot, (entries) => entries.length > 0, 'motion temp creation');
      const writeObserved = waitForDirectoryState(fixture.tempRoot, (entries) => entries.some((entry) => {
        try {
          return fs.statSync(path.join(fixture.tempRoot, entry)).size > 0;
        } catch (_) {
          return false;
        }
      }), 'motion temp write');
      flushed = clientSocket.write(fileChunk);
      if (!flushed) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('timed out waiting for multipart file drain')), 5000);
          clientSocket.once('drain', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
      try {
        await writeObserved;
      } catch (error) {
        const entries = fs.readdirSync(fixture.tempRoot).map((entry) => ({
          entry,
          size: fs.statSync(path.join(fixture.tempRoot, entry)).size,
        }));
        throw new Error(`${error.message}; entries=${JSON.stringify(entries)}; response=${Buffer.concat(responseChunks).toString()}`);
      }
      const closed = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timed out waiting for aborted socket close')), 5000);
        clientSocket.once('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      const cleaned = waitForDirectoryState(fixture.tempRoot, (entries) => entries.length === 0, 'motion temp cleanup');
      clientSocket.destroy(new Error('intentional multipart abort'));
      await Promise.all([closed, cleaned]);
    });
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(fixture.tempRoot), []);
  } finally {
    fixture.close();
  }
});

function coverageRegistrationRouterFixture(registrationService, { providerPlacement = 'redrawOptions' } = {}) {
  const db = createDb();
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-coverage-route-storage-'));
  const secret = 'redraw-coverage-route-secret-value-at-least-32-bytes';
  const previous = {
    publicMode: process.env.PUBLIC_PLATFORM_MODE,
    jwtSecret: process.env.PLATFORM_JWT_SECRET,
  };
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = secret;
  const user = userAuthService.register(db, {
    email: `redraw-coverage-${crypto.randomUUID()}@example.test`,
    password: 'route-fixture-password-123',
  });
  const tenantId = `personal:${user.id}`;
  const projectId = insertProject(db, { tenant_id: tenantId, user_id: user.id });
  const workId = insertWork(db, projectId, { tenant_id: tenantId, user_id: user.id });
  const versionId = Number(insertVersion(db, workId, {
    tenant_id: tenantId,
    user_id: user.id,
    facts_hash: 'a'.repeat(64),
    updated_at: NOW,
  }));
  const coverageProvider = async () => {
    throw new Error('coverage provider must only be called by the registration service');
  };
  const noProvider = async () => ({ status: 'completed' });
  const redrawOptions = { coverageRegistrationService: registrationService };
  const providerOptions = {};
  if (providerPlacement === 'redrawOptions') {
    redrawOptions.coverageRegistrationProvider = coverageProvider;
  } else if (providerPlacement === 'topLevel') {
    providerOptions.coverageRegistrationProvider = coverageProvider;
  } else if (providerPlacement !== 'none') {
    throw new Error(`unsupported coverage provider placement: ${providerPlacement}`);
  }
  const router = setupRouter({ storage: { local_path: storageRoot } }, db, {
    error() {}, warn() {}, info() {},
  }, {
    localizationProvider: noProvider,
    assetGenerationProvider: noProvider,
    dialogueProvider: noProvider,
    ...providerOptions,
    redrawOptions,
  });
  const token = userAuthService.issueToken(user, secret, 0);
  return {
    db,
    router,
    storageRoot,
    coverageProvider,
    user,
    tenantId,
    token,
    versionId,
    close() {
      db.close();
      fs.rmSync(storageRoot, { recursive: true, force: true });
      if (previous.publicMode === undefined) delete process.env.PUBLIC_PLATFORM_MODE;
      else process.env.PUBLIC_PLATFORM_MODE = previous.publicMode;
      if (previous.jwtSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
      else process.env.PLATFORM_JWT_SECRET = previous.jwtSecret;
    },
  };
}

test('coverage provider gate leaves the version route unmounted when no server provider is configured', async () => {
  let calls = 0;
  const fixture = coverageRegistrationRouterFixture({
    async registerReviewedCoverage() {
      calls += 1;
      return { redraw_asset_id: 811, expected_updated_at: NOW };
    },
  }, { providerPlacement: 'none' });
  try {
    const registered = new Set(fixture.router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route.methods)
        .map((method) => `${method.toUpperCase()} ${layer.route.path}`)));
    assert.equal(registered.has('POST /redraw/versions/:id/full-frame-coverages'), false);

    await withJsonRouteServer(fixture.router, async (baseUrl) => {
      const response = await postJson(
        `${baseUrl}/redraw/versions/${fixture.versionId}/full-frame-coverages`,
        fixture.token,
        fixture.tenantId,
        { expected_version_updated_at: NOW, idempotency_key: 'coverage-provider-missing' },
      );
      assert.equal(response.status, 404);
    });
    assert.equal(calls, 0);
  } finally {
    fixture.close();
  }
});

test('coverage provider gate accepts an explicit top-level server provider', async () => {
  const calls = [];
  const fixture = coverageRegistrationRouterFixture({
    async registerReviewedCoverage(input) {
      calls.push(input);
      return { redraw_asset_id: 812, expected_updated_at: NOW };
    },
  }, { providerPlacement: 'topLevel' });
  try {
    await withJsonRouteServer(fixture.router, async (baseUrl) => {
      const response = await postJson(
        `${baseUrl}/redraw/versions/${fixture.versionId}/full-frame-coverages`,
        fixture.token,
        fixture.tenantId,
        { expected_version_updated_at: NOW, idempotency_key: 'coverage-provider-top-level' },
      );
      assert.equal(response.status, 200, await response.text());
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, fixture.coverageProvider);
  } finally {
    fixture.close();
  }
});

async function withJsonRouteServer(router, run) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}/api/v1`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function postJson(url, token, tenantId, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

test('coverage version route authenticates tenant and owner before registration service', async () => {
  const calls = [];
  const result = {
    redraw_asset_id: 811,
    expected_updated_at: '2026-08-27T12:00:00.000Z',
    billing: { credits: 99, held: 88, charged: 77 },
    provider_task_id: 'provider-secret-task',
    analysis_sha256: 'b'.repeat(64),
    absolute_path: 'C:\\private\\coverage.json',
    secret: 'Authorization: Bearer provider-key',
    replayed: true,
  };
  const fixture = coverageRegistrationRouterFixture({
    async registerReviewedCoverage(input) {
      calls.push(input);
      return result;
    },
  });
  try {
    const registered = new Set(fixture.router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route.methods)
        .map((method) => `${method.toUpperCase()} ${layer.route.path}`)));
    assert.equal(registered.has('POST /redraw/versions/:id/full-frame-coverages'), true);

    await withJsonRouteServer(fixture.router, async (baseUrl) => {
      const endpoint = `${baseUrl}/redraw/versions/${fixture.versionId}/full-frame-coverages`;
      const input = { expected_version_updated_at: NOW, idempotency_key: 'coverage-route-key' };

      const unauthorized = await postJson(endpoint, null, null, input);
      assert.equal(unauthorized.status, 401);

      const invalidTenant = await postJson(endpoint, fixture.token, 'tenant-not-owned', input);
      assert.equal(invalidTenant.status, 404);

      const otherUser = userAuthService.register(fixture.db, {
        email: `redraw-coverage-other-${crypto.randomUUID()}@example.test`,
        password: 'route-fixture-password-456',
      });
      const otherTenantId = `personal:${otherUser.id}`;
      const otherProjectId = insertProject(fixture.db, {
        tenant_id: otherTenantId,
        user_id: otherUser.id,
      });
      const otherWorkId = insertWork(fixture.db, otherProjectId, {
        tenant_id: otherTenantId,
        user_id: otherUser.id,
      });
      const otherVersionId = Number(insertVersion(fixture.db, otherWorkId, {
        tenant_id: otherTenantId,
        user_id: otherUser.id,
        facts_hash: 'c'.repeat(64),
      }));
      const crossOwner = await postJson(
        `${baseUrl}/redraw/versions/${otherVersionId}/full-frame-coverages`,
        fixture.token,
        fixture.tenantId,
        input,
      );
      assert.equal(crossOwner.status, 404);
      assert.equal((await crossOwner.json()).error.code, 'REDRAW_VERSION_NOT_FOUND');
      assert.equal(calls.length, 0);

      const accepted = await postJson(endpoint, fixture.token, fixture.tenantId, input);
      const responseBody = await accepted.text();
      assert.equal(accepted.status, 200, responseBody);
      assert.deepEqual(JSON.parse(responseBody).data, {
        version_id: fixture.versionId,
        redraw_asset_id: 811,
        expected_updated_at: '2026-08-27T12:00:00.000Z',
        billing: { credits: 0, held: 0, charged: 0 },
      });
      assert.equal(/private|provider-secret|Authorization|Bearer|provider-key/i.test(responseBody), false);
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].db, fixture.db);
    assert.equal(calls[0].tenantId, fixture.tenantId);
    assert.equal(calls[0].userId, fixture.user.id);
    assert.equal(calls[0].versionId, fixture.versionId);
    assert.equal(calls[0].expected_version_updated_at, NOW);
    assert.equal(calls[0].idempotency_key, 'coverage-route-key');
    assert.equal(calls[0].provider, fixture.coverageProvider);
    assert.equal(calls[0].storageRoot, path.resolve(fixture.storageRoot));
    assert.deepEqual(
      Object.keys(calls[0]).sort(),
      ['db', 'expected_version_updated_at', 'idempotency_key', 'log', 'provider', 'storageRoot',
        'tenantId', 'userId', 'versionId'].sort(),
    );
  } finally {
    fixture.close();
  }
});

test('coverage version route rejects client control and maps registration failures without leaks', async () => {
  const calls = [];
  const fixture = coverageRegistrationRouterFixture({
    async registerReviewedCoverage(input) {
      calls.push(input);
      const code = String(input.idempotency_key || '');
      throw Object.assign(new Error('C:\\private\\staging Authorization: Bearer provider-secret SQL SELECT'), {
        code,
      });
    },
  });
  try {
    await withJsonRouteServer(fixture.router, async (baseUrl) => {
      const endpoint = `${baseUrl}/redraw/versions/${fixture.versionId}/full-frame-coverages`;
      for (const forbiddenField of [
        'provider', 'output_path', 'local_path', 'storage_root', 'asset_id', 'credits', 'price', 'reference_bundle',
      ]) {
        const rejected = await postJson(endpoint, fixture.token, fixture.tenantId, {
          expected_version_updated_at: NOW,
          idempotency_key: `forbidden-${forbiddenField}`,
          [forbiddenField]: forbiddenField === 'credits' ? 0 : 'client-controlled',
        });
        const rejectedBody = await rejected.text();
        assert.equal(rejected.status, 400, rejectedBody);
        assert.equal(JSON.parse(rejectedBody).error.code, 'REDRAW_COVERAGE_CLIENT_CONTROL_FORBIDDEN');
        assert.equal(/client-controlled|private|Authorization|Bearer|provider-secret/i.test(rejectedBody), false);
      }
      assert.equal(calls.length, 0);

      const invalid = await postJson(endpoint, fixture.token, fixture.tenantId, {
        expected_version_updated_at: NOW,
        idempotency_key: '',
      });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error.code, 'REDRAW_COVERAGE_REQUEST_INVALID');
      assert.equal(calls.length, 0);

      const mappings = [
        ['REDRAW_COVERAGE_VERSION_CONFLICT', 409],
        ['REDRAW_COVERAGE_REGISTRATION_IDEMPOTENCY_CONFLICT', 409],
        ['REDRAW_COVERAGE_REGISTRATION_IN_PROGRESS', 409],
        ['REDRAW_COVERAGE_REGISTRATION_NEEDS_ATTENTION', 409],
        ['REDRAW_COVERAGE_PROVIDER_UNKNOWN', 502],
        ['REDRAW_COVERAGE_VERSION_MISMATCH', 502],
        ['REDRAW_COVERAGE_EVIDENCE_INVALID', 502],
        ['UNEXPECTED_INTERNAL_FAILURE', 500],
      ];
      for (const [code, status] of mappings) {
        const failed = await postJson(endpoint, fixture.token, fixture.tenantId, {
          expected_version_updated_at: NOW,
          idempotency_key: code,
        });
        const failedBody = await failed.text();
        assert.equal(failed.status, status, `${code}: ${failedBody}`);
        const publicCode = JSON.parse(failedBody).error.code;
        assert.equal(publicCode, status === 500 ? 'INTERNAL_ERROR' : code);
        assert.equal(/private|Authorization|Bearer|provider-secret|SELECT/i.test(failedBody), false);
      }
    });
    assert.equal(calls.length, 8);
  } finally {
    fixture.close();
  }
});
