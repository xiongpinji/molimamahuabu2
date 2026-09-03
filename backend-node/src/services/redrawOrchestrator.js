const fs = require('fs');
const path = require('path');
const creditLedger = require('./creditLedgerService');
const modelPrice = require('./modelPriceService');
const taskService = require('./taskService');
const { normalizeSourceFacts } = require('./redrawAnalysisService');
const {
  evaluateAutomationDecision,
  requiredAnalysisConfidenceKeys,
} = require('./redrawAutomationPolicyService');
const redrawGenerationService = require('./redrawGenerationService');
const { appendWorkflowEvent } = require('./redrawWorkflowEventService');

const DEFAULT_RESUME_QUERY_TIMEOUT_MS = 10_000;
const RESUME_ERROR_SNIPPET_LIMIT = 512;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseSettings(row) {
  if (!row?.settings) return {};
  try {
    return typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings;
  } catch (_) {
    return {};
  }
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function loadVerifiedCapability(db) {
  const rows = db.prepare(
    `SELECT * FROM ai_service_configs
     WHERE deleted_at IS NULL AND service_type = 'video_understanding' AND is_active = 1
     ORDER BY is_default DESC, priority DESC, id ASC`
  ).all();
  for (const row of rows) {
    const settings = parseSettings(row);
    const evidence = settings.evidence || settings.real_generation_evidence || {};
    if (
      settings.real_generation_verified === true &&
      evidence.provider_task_id &&
      evidence.result_asset_id &&
      evidence.result_asset_readable === true &&
      evidence.completed_at
    ) {
      return row;
    }
  }
  throw codedError('VIDEO_UNDERSTANDING_NOT_VERIFIED', '视频理解模型缺少真实生成且结果可读的验证证据');
}

function quoteAnalysis(db, log) {
  try {
    const config = loadVerifiedCapability(db);
    const model = modelPrice.canonicalModel(config.default_model || config.model || 'GPT-5.5');
    const amount = modelPrice.calculateCharge(db, model);
    return { model, credits: amount, amount };
  } catch (error) {
    if (['VIDEO_UNDERSTANDING_NOT_VERIFIED', 'MODEL_PRICE_NOT_CONFIGURED', 'MODEL_DISABLED'].includes(error.code)) {
      return null;
    }
    log?.error?.('redraw analysis quote failed', { code: error.code, message: error.message });
    throw error;
  }
}

function getWork(db, workId) {
  return db.prepare('SELECT * FROM redraw_works WHERE id = ?').get(String(workId)) || null;
}

function getTask(db, taskId) {
  return db.prepare('SELECT * FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(String(taskId)) || null;
}

function getAsset(db, assetId) {
  if (!assetId) return null;
  return db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(assetId) || null;
}

function defaultCanRead(asset) {
  return createAssetReader({}).canRead(asset);
}

function isPathInside(parent, child) {
  const from = process.platform === 'win32' ? path.resolve(parent).toLowerCase() : path.resolve(parent);
  const to = process.platform === 'win32' ? path.resolve(child).toLowerCase() : path.resolve(child);
  const relative = path.relative(from, to);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function createAssetReader(options = {}) {
  const storageRoot = path.resolve(options.storageRoot || process.cwd());
  return {
    canRead(asset) {
      if (!asset) return false;
      if (asset.local_path) {
        const localPath = String(asset.local_path);
        if (path.isAbsolute(localPath)) return false;
        const absPath = path.resolve(storageRoot, localPath);
        try {
          const realRoot = fs.realpathSync(storageRoot);
          if (!isPathInside(realRoot, absPath)) return false;
          const realPath = fs.realpathSync(absPath);
          if (!isPathInside(realRoot, realPath)) return false;
          fs.accessSync(realPath, fs.constants.R_OK);
          return true;
        } catch (_) {
          return false;
        }
      }
      return asset.readable === true || asset.readable === 1 || asset.readable === 'true';
    },
  };
}

function assertAssetReadable(db, assetReader, assetId, label) {
  const asset = getAsset(db, assetId);
  const canRead = assetReader?.canRead || defaultCanRead;
  if (!asset || !canRead(asset)) throw codedError('ASSET_NOT_READABLE', `${label}资产不可回读`);
  return asset;
}

function safeUpdate(db, sql, params) {
  try {
    return db.prepare(sql).run(...params);
  } catch (error) {
    if (/no such column/i.test(String(error.message || ''))) return null;
    throw error;
  }
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function insertDynamic(db, table, values) {
  const columns = tableColumns(db, table);
  const names = Object.keys(values).filter((name) => columns.has(name));
  const placeholders = names.map(() => '?').join(', ');
  return db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders})`)
    .run(...names.map((name) => values[name]));
}

function updateDynamic(db, table, values, whereName, whereValue) {
  const columns = tableColumns(db, table);
  const names = Object.keys(values).filter((name) => columns.has(name));
  if (!columns.has(whereName) || names.length === 0) return null;
  return db.prepare(`UPDATE ${table} SET ${names.map((name) => `${name} = ?`).join(', ')} WHERE ${whereName} = ?`)
    .run(...names.map((name) => values[name]), whereValue);
}

function resolveBlueprintPipeline(options) {
  const candidates = [
    options.sourceAudioEvidenceService,
    options.nativeSourceAnalysisService,
    options.evidenceFusionService,
  ];
  if (candidates.every((item) => item == null)) return null;
  if (typeof candidates[0]?.analyzeSourceAudio !== 'function'
    || typeof candidates[1]?.analyzeNativeSource !== 'function'
    || typeof candidates[2]?.fuseEpisodeEvidence !== 'function') {
    throw codedError(
      'REDRAW_BLUEPRINT_PIPELINE_DEPENDENCY_REQUIRED',
      '母本蓝图分析必须完整注入音频、视觉和证据融合服务',
    );
  }
  return {
    sourceAudioEvidenceService: candidates[0],
    nativeSourceAnalysisService: candidates[1],
    evidenceFusionService: candidates[2],
  };
}

function evidenceAsset(result, kind, idPrefix, tool) {
  if (result?.evidence_asset) return result.evidence_asset;
  const assetId = result?.result_asset_id;
  const sha256 = result?.evidence_sha256 || result?.sha256;
  if (assetId == null || !sha256) return null;
  return {
    id: `${idPrefix}-${assetId}`,
    kind,
    asset_id: assetId,
    sha256,
    tool,
    tool_version: '1.0.0',
  };
}

async function runBlueprintPipeline(db, log, pipeline, request, options) {
  const context = { ...(options.analysisContext || {}), db, log };
  const audioEvidence = await pipeline.sourceAudioEvidenceService.analyzeSourceAudio(context, {
    sourceAssetId: Number(request.sourceAssetId),
    tenantId: String(request.tenantId || ''),
    userId: String(request.userId || ''),
    workId: Number(request.workId),
  });
  const visualEvidence = await pipeline.nativeSourceAnalysisService.analyzeNativeSource(context, {
    taskId: request.taskId,
    workId: request.workId,
    tenantId: request.tenantId,
    userId: request.userId,
    model: request.model,
    probeTimeoutMs: options.nativeAnalysisProbeTimeoutMs,
    ffmpegTimeoutMs: options.nativeAnalysisFfmpegTimeoutMs,
    maxTokens: options.nativeAnalysisMaxTokens,
  }, audioEvidence);
  if (visualEvidence?.status !== 'completed') {
    throw codedError('REDRAW_BLUEPRINT_VISUAL_ANALYSIS_INCOMPLETE', '视觉证据分析未完成');
  }
  const evidenceAssets = [
    evidenceAsset(audioEvidence, audioEvidence?.dialogue_mode === 'silent' ? 'audio' : 'audio_transcript', 'evidence-audio', 'source-audio-evidence'),
    evidenceAsset(visualEvidence, 'visual', 'evidence-visual', 'native-source-analysis'),
  ].filter(Boolean);
  const blueprint = await pipeline.evidenceFusionService.fuseEpisodeEvidence({
    source: visualEvidence.source || audioEvidence?.source,
    visualFacts: visualEvidence.facts || visualEvidence.visualFacts,
    audioEvidence,
    evidenceAssets,
  });
  return {
    status: 'completed',
    provider_task_id: visualEvidence.provider_task_id,
    result_asset_id: visualEvidence.result_asset_id || null,
    blueprint,
  };
}

function assertNeedsReviewBlueprint(blueprint) {
  if (!blueprint
    || blueprint.schema_version !== 'episode-blueprint-v1'
    || !/^[a-f0-9]{64}$/.test(String(blueprint.blueprint_hash || ''))
    || blueprint.review?.status !== 'needs_review'
    || !Array.isArray(blueprint.shots)
    || blueprint.shots.length === 0) {
    throw codedError('REDRAW_BLUEPRINT_RESULT_INVALID', '母本蓝图必须完整且进入 needs_review');
  }
  return blueprint;
}

function insertBlueprintShots(db, work, version, blueprint) {
  const shotColumns = tableColumns(db, 'redraw_shots');
  for (const [index, shot] of blueprint.shots.entries()) {
    const existing = shotColumns.has('work_id')
      ? db.prepare('SELECT id FROM redraw_shots WHERE work_id = ? AND shot_id = ? LIMIT 1').get(work.id, shot.id)
      : null;
    if (existing) continue;
    insertDynamic(db, 'redraw_shots', {
      work_id: work.id,
      version_id: version.id,
      tenant_id: work.tenant_id || null,
      user_id: work.user_id || null,
      shot_id: shot.id,
      batch_index: 1,
      shot_index: index + 1,
      start_ms: shot.start_ms,
      end_ms: shot.end_ms,
      duration_ms: shot.end_ms - shot.start_ms,
      source_dialogue_json: JSON.stringify(shot.dialogue || []),
      opening_state: shot.opening_state,
      continuous_action: shot.continuous_action,
      ending_state: shot.ending_state,
      draft_json: JSON.stringify(shot),
      status: 'draft',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
}

function writeBlueprintOnce(db, work, blueprint) {
  const now = new Date().toISOString();
  let version = existingSourceFactsVersion(db, work);
  let changed = false;
  if (version) {
    if (version.facts_hash !== blueprint.blueprint_hash) {
      throw codedError('SOURCE_FACTS_HASH_CONFLICT', '母本蓝图 hash 冲突，请人工确认后再继续');
    }
  } else {
    const existing = db.prepare('SELECT * FROM redraw_versions WHERE work_id = ? ORDER BY id ASC LIMIT 1').get(work.id);
    if (existing) {
      db.prepare('UPDATE redraw_versions SET source_facts_json = ?, facts_hash = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(blueprint), blueprint.blueprint_hash, 'needs_attention', now, existing.id);
      version = { ...existing, source_facts_json: JSON.stringify(blueprint), facts_hash: blueprint.blueprint_hash };
    } else {
      const id = insertDynamic(db, 'redraw_versions', {
        work_id: work.id,
        tenant_id: work.tenant_id || null,
        user_id: work.user_id || null,
        version: 1,
        locale: 'source',
        market: '',
        localization_level: 'faithful',
        source_facts_json: JSON.stringify(blueprint),
        facts_hash: blueprint.blueprint_hash,
        status: 'needs_attention',
        created_at: now,
        updated_at: now,
      }).lastInsertRowid;
      version = { id, work_id: work.id, version: 1, facts_hash: blueprint.blueprint_hash };
    }
    changed = true;
  }
  updateDynamic(db, 'redraw_versions', { status: 'needs_attention', updated_at: now }, 'id', version.id);
  insertBlueprintShots(db, work, version, blueprint);
  updateDynamic(db, 'redraw_works', {
    status: 'needs_attention',
    current_version: Number(version.version || 1),
    current_step: 1,
    error_msg: null,
    updated_at: now,
  }, 'id', work.id);
  return { version, changed };
}

function finalizeBlueprintAnalysis(db, task, work, pipelineResult) {
  const blueprint = assertNeedsReviewBlueprint(pipelineResult.blueprint);
  return atomicFinalize(db, () => {
    const { version, changed } = writeBlueprintOnce(db, work, blueprint);
    const project = readProjectPolicy(db, work);
    if (changed && project) {
      appendWorkflowEvent(db, {
        tenantId: String(project.tenant_id || ''),
        userId: String(project.user_id || ''),
        projectId: Number(project.id),
        resourceType: 'version',
        resourceId: String(version.id),
        fromState: String(work.status || ''),
        toState: 'analysis_review',
        reasonCode: 'analysis_completed',
        evidenceHash: blueprint.blueprint_hash,
        metadata: {
          action: 'needs_review',
          effective_mode: 'safe',
          reason_codes: ['blueprint_review_required'],
          policy_version: Number(project.policy_version || 0),
        },
        createdAt: new Date().toISOString(),
      });
    }
    const payload = {
      status: 'completed',
      work_id: work.id,
      version_id: version.id,
      blueprint_hash: blueprint.blueprint_hash,
      review_status: blueprint.review.status,
      blueprint,
    };
    taskService.updateTaskResult(db, task.id, payload);
    creditLedger.settleGeneration(
      db,
      task.credit_reservation_id || work.credit_reservation_id,
      'completed',
    );
    return payload;
  });
}

function buildUrl(baseUrl, endpoint, providerTaskId) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  const ep = String(endpoint || '').trim();
  if (!base || !ep) return '';
  const replaced = ep.replace('{taskId}', encodeURIComponent(String(providerTaskId)));
  return replaced.startsWith('http://') || replaced.startsWith('https://')
    ? replaced
    : `${base}${replaced.startsWith('/') ? '' : '/'}${replaced}`;
}

function normalizeProviderResult(payload) {
  const status = String(payload?.status || payload?.state || payload?.task_status || '').toLowerCase();
  if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(status)) {
    return {
      status: 'completed',
      result_asset_id: payload.result_asset_id || payload.asset_id || payload.result_asset?.id,
      facts: payload.facts || payload.source_facts || payload.result?.facts || payload.result?.source_facts,
    };
  }
  if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status)) {
    return { status: 'failed', error: payload.error || payload.message || '供应商源片分析失败' };
  }
  if (['processing', 'pending', 'running', 'queued', 'in_progress'].includes(status)) {
    return { status: 'processing' };
  }
  return { status: 'unknown', error: '源片分析状态未知，请人工确认后再处理' };
}

function createProviderResumeUnavailable(message) {
  return codedError('REDRAW_PROVIDER_RESUME_UNAVAILABLE', message || '源片分析供应商恢复查询不可用');
}

function resumeQueryTimeoutMs() {
  const raw = Number(process.env.REDRAW_RESUME_QUERY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_RESUME_QUERY_TIMEOUT_MS;
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

async function readErrorSnippet(response) {
  try {
    if (!response.body?.getReader) return (await response.text()).slice(0, RESUME_ERROR_SNIPPET_LIMIT);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (total < RESUME_ERROR_SNIPPET_LIMIT) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8', 0, RESUME_ERROR_SNIPPET_LIMIT);
  } catch (_) {
    return '';
  }
}

function createStartupResumeOptions(db, log, options = {}) {
  let config = null;
  try {
    config = db ? loadVerifiedCapability(db) : null;
  } catch (error) {
    log?.warn?.('redraw resume capability unavailable', { code: error.code, message: error.message });
  }
  const queryEndpoint = config?.query_endpoint || parseSettings(config)?.query_endpoint;
  const queryUrlTemplate = buildUrl(config?.base_url, queryEndpoint, '{taskId}');
  return {
    provider: {
      pollAnalysisTask: async ({ providerTaskId }) => {
        if (!queryUrlTemplate) {
          throw createProviderResumeUnavailable('video_understanding 未配置 query_endpoint，无法恢复源片分析任务');
        }
        const url = buildUrl(config.base_url, queryEndpoint, providerTaskId);
        const headers = {};
        if (config.api_key) headers.authorization = `Bearer ${config.api_key}`;
        try {
          const response = await fetch(url, { method: 'GET', headers, signal: timeoutSignal(resumeQueryTimeoutMs()) });
          if (!response.ok) {
            const detail = await readErrorSnippet(response);
            throw createProviderResumeUnavailable(`源片分析恢复查询失败: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
          }
          return normalizeProviderResult(await response.json());
        } catch (error) {
          if (error.code === 'REDRAW_PROVIDER_RESUME_UNAVAILABLE') throw error;
          throw createProviderResumeUnavailable(`源片分析恢复查询不可用: ${error.message}`);
        }
      },
    },
    assetReader: createAssetReader({ storageRoot: options.storageRoot }),
  };
}

async function startAnalysis(db, log, input, options = {}) {
  const work = getWork(db, input.workId);
  if (!work) throw codedError('REDRAW_WORK_NOT_FOUND', '转绘作品不存在');
  const userId = String(input.userId || work.user_id || '');
  const tenantId = input.tenantId || work.tenant_id;
  if (!userId) throw codedError('UNAUTHORIZED', '缺少用户身份');
  const blueprintPipeline = resolveBlueprintPipeline(options);

  const config = loadVerifiedCapability(db);
  const model = modelPrice.canonicalModel(config.default_model || config.model || 'GPT-5.5');
  const price = modelPrice.calculateCharge(db, model);
  const sourceAssetId = input.sourceAssetId || work.source_asset_id;
  if (!sourceAssetId) throw codedError('SOURCE_ASSET_REQUIRED', '缺少源片资产');
  const analysisSettings = input.analysisSettings && typeof input.analysisSettings === 'object'
    ? input.analysisSettings
    : {};
  const metadata = JSON.stringify({ redraw_analysis: analysisSettings });

  const now = new Date().toISOString();
  const created = db.transaction(() => {
    const reservation = price > 0
      ? creditLedger.reserve(db, {
        userId,
        tenantId: tenantId == null ? null : String(tenantId),
        actorUserId: userId,
        operationKey: `redraw_analysis:${work.id}:${sourceAssetId}`,
        amount: price,
        model,
        resourceType: 'redraw_analysis',
        resourceId: work.id,
      })
      : null;
    const task = taskService.createTask(db, log, 'redraw_analysis', work.id);
    updateDynamic(db, 'async_tasks', {
      tenant_id: tenantId == null ? null : String(tenantId),
      user_id: userId,
      resource_id: String(work.id),
      model,
      credit_reservation_id: reservation?.id || null,
      status: 'processing',
      progress: 10,
      message: '源片分析已开始',
      updated_at: now,
    }, 'id', task.id);
    db.prepare('UPDATE async_tasks SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(metadata, now, task.id);
    db.prepare(
      `UPDATE redraw_works
       SET source_asset_id = ?, status = 'analyzing', current_step = 1, task_id = ?,
           credit_reservation_id = ?, updated_at = ?
       WHERE id = ?`
    ).run(sourceAssetId, task.id, reservation?.id || null, now, work.id);
    return {
      task_id: task.id,
      reservation_id: reservation?.id || null,
      model,
      billing: { charged: 0, held: reservation?.amount || 0, released: 0 },
    };
  })();

  let providerResult;
  try {
    const request = {
        taskId: created.task_id,
        reservationId: created.reservation_id,
        workId: work.id,
        tenantId: tenantId == null ? null : String(tenantId),
        userId,
        model,
        work,
        sourceAssetId,
        config,
        analysisSettings,
        operationKey: `redraw_analysis:${work.id}:${sourceAssetId}`,
      };
    providerResult = blueprintPipeline
      ? await runBlueprintPipeline(db, log, blueprintPipeline, request, options)
      : options.provider?.startAnalysis
        ? await options.provider.startAnalysis(request)
      : {};
  } catch (error) {
    markFailure(db, log, getTask(db, created.task_id), getWork(db, work.id), error.message);
    throw error;
  }
  const providerTaskId = providerResult?.provider_task_id || providerResult?.task_id || '';
  if (!providerTaskId) {
    const error = codedError('PROVIDER_TASK_ID_REQUIRED', '源片分析启动失败：缺少厂商任务 ID');
    markFailure(db, log, getTask(db, created.task_id), getWork(db, work.id), error.message);
    throw error;
  }
  if (providerTaskId) {
    db.prepare('UPDATE async_tasks SET provider_task_id = ?, updated_at = ? WHERE id = ?')
      .run(String(providerTaskId), new Date().toISOString(), created.task_id);
    db.prepare('UPDATE redraw_works SET provider_task_id = ?, updated_at = ? WHERE id = ?')
      .run(String(providerTaskId), new Date().toISOString(), work.id);
  }
  if (blueprintPipeline) {
    try {
      const completion = finalizeBlueprintAnalysis(
        db,
        getTask(db, created.task_id),
        getWork(db, work.id),
        providerResult,
      );
      return {
        ...created,
        ...completion,
        provider_task_id: String(providerTaskId),
        result_asset_id: providerResult.result_asset_id || null,
        current_step: 1,
        billing: { charged: price, held: 0, released: 0 },
      };
    } catch (error) {
      markFailure(db, log, getTask(db, created.task_id), getWork(db, work.id), error.message);
      throw error;
    }
  }
  const normalizedResult = normalizeProviderResult(providerResult);
  if (normalizedResult.status === 'failed') {
    const message = normalizedResult.error || '供应商源片分析失败';
    markFailure(db, log, getTask(db, created.task_id), getWork(db, work.id), message);
    throw codedError('REDRAW_ANALYSIS_PROVIDER_FAILED', message);
  }
  if (normalizedResult.status === 'completed') {
    const completion = finalizeCompletedAnalysis(
      db,
      log,
      getTask(db, created.task_id),
      getWork(db, work.id),
      normalizedResult,
      options,
    );
    if (completion.status !== 'completed') {
      const error = codedError(
        'REDRAW_ANALYSIS_RESULT_INVALID',
        completion.error || '源片分析结果不可用',
      );
      error.analysis_status = completion.status;
      throw error;
    }
    return {
      ...created,
      ...completion,
      provider_task_id: String(providerTaskId),
      result_asset_id: normalizedResult.result_asset_id || null,
      current_step: 2,
      billing: { charged: price, held: 0, released: 0 },
    };
  }
  return { ...created, status: 'processing', provider_task_id: providerTaskId || null, current_step: 1 };
}

function markFailure(db, log, task, work, message) {
  const now = new Date().toISOString();
  db.prepare('UPDATE redraw_works SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
    .run('failed', String(message || '').slice(0, 500), now, work.id);
  taskService.updateTaskError(db, task.id, message || '源片分析失败');
  creditLedger.settleGeneration(db, task.credit_reservation_id || work.credit_reservation_id, 'failed', message || '源片分析失败');
  log?.warn?.('redraw analysis failed', { task_id: task.id, work_id: work.id, message });
}

function markNeedsAttention(db, task, work, message) {
  const now = new Date().toISOString();
  db.prepare('UPDATE redraw_works SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?')
    .run('needs_attention', String(message || '').slice(0, 500), now, work.id);
  safeUpdate(
    db,
    'UPDATE async_tasks SET status = ?, progress = ?, message = ?, error = ?, updated_at = ? WHERE id = ?',
    ['needs_attention', 90, message || '源片分析状态未知', message || '源片分析状态未知', now, task.id]
  );
}

function readProjectPolicy(db, work) {
  const columns = tableColumns(db, 'redraw_works');
  if (!columns.has('project_id') || !columns.has('tenant_id') || !columns.has('user_id') || !work.project_id) return null;
  try {
    return db.prepare(`
      SELECT id, tenant_id, user_id, execution_mode, budget_limit_credits,
             automation_policy_json, policy_version, updated_at
      FROM redraw_projects
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    `).get(Number(work.project_id), String(work.tenant_id || ''), String(work.user_id || '')) || null;
  } catch (error) {
    if (/no such table|no such column/i.test(String(error.message || ''))) return null;
    throw error;
  }
}

function analysisGates(normalized) {
  return {
    media: Number(normalized.duration_ms) > 0 && Array.isArray(normalized.shots) && normalized.shots.length > 0,
    timeline: Array.isArray(normalized.shots) && normalized.shots.length > 0,
    facts: Array.isArray(normalized.characters) && normalized.characters.length > 0
      && Array.isArray(normalized.scenes) && normalized.scenes.length > 0
      && Array.isArray(normalized.props) && normalized.props.length > 0,
  };
}

function analysisConfidence(normalized) {
  const result = {};
  for (const key of requiredAnalysisConfidenceKeys) {
    let min = null;
    let complete = true;
    for (const shot of normalized.shots || []) {
      const value = shot?.confidence?.[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        complete = false;
        break;
      }
      min = min == null ? value : Math.min(min, value);
    }
    if (complete && min != null) result[key] = min;
  }
  return result;
}

function parseAutomationPolicy(project) {
  if (project?.automation_policy_json == null || String(project.automation_policy_json).trim() === '') {
    return { ok: false, code: 'project_policy_missing', policy: null };
  }
  try {
    const parsed = typeof project.automation_policy_json === 'string'
      ? JSON.parse(project.automation_policy_json)
      : project.automation_policy_json;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, code: 'project_policy_missing', policy: null };
    }
    return { ok: true, policy: parsed };
  } catch (_) {
    return { ok: false, code: 'project_policy_invalid', policy: null };
  }
}

function decisionFromReason(reasonCode, factsHash, projectStatus = 'blocked', policyVersion = 0) {
  return {
    action: projectStatus === 'blocked' ? 'blocked' : 'needs_review',
    effective_mode: 'safe',
    reason_codes: [reasonCode],
    policy_version: Number(policyVersion || 0),
    evidence_hash: factsHash,
    effective_analysis_state: projectStatus,
  };
}

function enrichAutomationDecision(decision, outcome, factsHash) {
  if (!decision) return null;
  return {
    action: decision.action,
    effective_mode: decision.effective_mode,
    reason_codes: Array.isArray(decision.reason_codes) ? [...decision.reason_codes] : [],
    policy_version: Number(outcome?.project?.policy_version || 0),
    evidence_hash: factsHash,
    effective_analysis_state: outcome?.projectStatus || (decision.action === 'advance' ? 'asset_review' : 'analysis_review'),
  };
}

function taskResultPayload(work, version, resultAssetId, factsHash, decision) {
  return {
    status: 'completed',
    work_id: work.id,
    version_id: Number(version.id),
    result_asset_id: resultAssetId,
    facts_hash: factsHash,
    automation_decision: decision,
  };
}

function persistedAutomationDecision(task, factsHash, versionId, policyVersion) {
  const parsed = parseJson(task?.result, null);
  const decision = parsed?.automation_decision;
  if (
    !decision
    || Number(parsed?.version_id) !== Number(versionId)
    || !['advance', 'needs_review', 'blocked'].includes(decision.action)
    || !['auto', 'safe'].includes(decision.effective_mode)
    || !Array.isArray(decision.reason_codes)
    || typeof decision.evidence_hash !== 'string'
    || decision.evidence_hash !== factsHash
    || Number(decision.policy_version) !== Number(policyVersion)
    || typeof decision.effective_analysis_state !== 'string'
  ) {
    return null;
  }
  return {
    action: decision.action,
    effective_mode: decision.effective_mode,
    reason_codes: [...decision.reason_codes].sort(),
    policy_version: Number(decision.policy_version || 0),
    evidence_hash: decision.evidence_hash,
    effective_analysis_state: decision.effective_analysis_state,
  };
}

function projectPolicyVersion(db, work) {
  const project = readProjectPolicy(db, work);
  return project ? Number(project.policy_version || 0) : 0;
}

function eventAutomationDecision(db, work, version, factsHash) {
  if (!work.project_id) return null;
  const policyVersion = projectPolicyVersion(db, work);
  if (!policyVersion) return null;
  const row = db.prepare(`
    SELECT *
    FROM redraw_workflow_events
    WHERE tenant_id = ? AND user_id = ? AND project_id = ?
      AND resource_type = 'version' AND resource_id = ?
      AND reason_code = 'analysis_completed' AND evidence_hash = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(String(work.tenant_id || ''), String(work.user_id || ''), Number(work.project_id), String(version.id), factsHash);
  const metadata = parseJson(row?.metadata_json, null);
  if (
    !metadata
    || !['advance', 'needs_review', 'blocked'].includes(metadata.action)
    || !['auto', 'safe'].includes(metadata.effective_mode)
    || !Array.isArray(metadata.reason_codes)
    || Number(metadata.policy_version) !== policyVersion
  ) {
    return null;
  }
  return {
    action: metadata.action,
    effective_mode: metadata.effective_mode,
    reason_codes: [...metadata.reason_codes].map(String).sort(),
    policy_version: policyVersion,
    evidence_hash: factsHash,
    effective_analysis_state: String(row.to_state || ''),
  };
}

function reservationIsHeld(db, reservationId) {
  return creditLedger.getReservation(db, reservationId)?.status === 'held';
}

function atomicFinalize(db, work) {
  try {
    return db.transaction(work)();
  } catch (error) {
    error.atomic_finalize_failed = true;
    throw error;
  }
}

function automationOutcome(db, work, normalized) {
  const project = readProjectPolicy(db, work);
  if (!project) {
    const columns = tableColumns(db, 'redraw_works');
    if (columns.has('project_id') && work.project_id) {
      return {
        project: null,
        decision: decisionFromReason('project_policy_missing', normalized.facts_hash),
        projectStatus: 'blocked',
        workStatus: 'needs_attention',
        versionStatus: 'needs_attention',
        currentStep: 1,
        errorMessage: 'project_policy_missing',
      };
    }
    return {
      project: null,
      decision: null,
      workStatus: 'asset_review',
      versionStatus: 'asset_review',
      currentStep: 2,
      errorMessage: null,
    };
  }
  const input = {
    execution_mode: project.execution_mode || 'safe',
    gates: analysisGates(normalized),
  };
  if (input.execution_mode === 'auto') {
    const parsedPolicy = parseAutomationPolicy(project);
    if (!parsedPolicy.ok) {
      return {
        project,
        decision: decisionFromReason(parsedPolicy.code, normalized.facts_hash, 'blocked', project.policy_version),
        projectStatus: 'blocked',
        workStatus: 'needs_attention',
        versionStatus: 'needs_attention',
        currentStep: 1,
        errorMessage: parsedPolicy.code,
      };
    }
    const budget = Number(project.budget_limit_credits);
    input.budget_configured = Number.isFinite(budget) && budget > 0;
    input.confidence = analysisConfidence(normalized);
    input.thresholds = parsedPolicy.policy.analysis_confidence_thresholds || parsedPolicy.policy.thresholds || {};
  }
  const decision = evaluateAutomationDecision(input);
  const blocked = decision.action === 'blocked';
  const advance = decision.action === 'advance';
  const enrichedDecision = enrichAutomationDecision(decision, {
    project,
    projectStatus: advance ? 'asset_review' : (blocked ? 'blocked' : 'analysis_review'),
  }, normalized.facts_hash);
  return {
    project,
    decision: enrichedDecision,
    projectStatus: advance ? 'asset_review' : (blocked ? 'blocked' : 'analysis_review'),
    workStatus: advance ? 'asset_review' : 'needs_attention',
    versionStatus: advance ? 'asset_review' : 'needs_attention',
    currentStep: advance ? 2 : 1,
    errorMessage: blocked ? decision.reason_codes.join(',') : null,
  };
}

function writeFactsOnce(db, work, normalized, outcome = null) {
  const now = new Date().toISOString();
  const state = outcome || {
    workStatus: 'asset_review',
    versionStatus: 'asset_review',
    currentStep: 2,
    errorMessage: null,
  };
  let changed = true;
  let version = db.prepare(
    'SELECT * FROM redraw_versions WHERE work_id = ? AND source_facts_json IS NOT NULL ORDER BY id ASC LIMIT 1'
  ).get(work.id);
  if (version) {
    if (version.facts_hash !== normalized.facts_hash) {
      const error = codedError('SOURCE_FACTS_HASH_CONFLICT', '源片事实 hash 冲突，请人工确认后再继续');
      error.existing_hash = version.facts_hash;
      error.incoming_hash = normalized.facts_hash;
      throw error;
    }
    changed = false;
  } else {
    const existing = db.prepare('SELECT * FROM redraw_versions WHERE work_id = ? ORDER BY id ASC LIMIT 1').get(work.id);
    if (existing) {
      db.prepare('UPDATE redraw_versions SET source_facts_json = ?, facts_hash = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(normalized), normalized.facts_hash, state.versionStatus, now, existing.id);
      version = {
        ...existing,
        source_facts_json: JSON.stringify(normalized),
        facts_hash: normalized.facts_hash,
        status: state.versionStatus,
      };
    } else {
      const id = insertDynamic(db, 'redraw_versions', {
        work_id: work.id,
        tenant_id: work.tenant_id || null,
        user_id: work.user_id || null,
        version: 1,
        locale: 'source',
        market: '',
        localization_level: 'faithful',
        source_facts_json: JSON.stringify(normalized),
        facts_hash: normalized.facts_hash,
        status: state.versionStatus,
        created_at: now,
        updated_at: now,
      }).lastInsertRowid;
      version = { id, work_id: work.id, source_facts_json: JSON.stringify(normalized), facts_hash: normalized.facts_hash };
    }
  }
  const shotColumns = tableColumns(db, 'redraw_shots');
  for (const [index, shot] of normalized.shots.entries()) {
    if (shotColumns.has('work_id')) {
      const existingShot = db.prepare('SELECT id FROM redraw_shots WHERE work_id = ? AND shot_id = ? LIMIT 1').get(work.id, shot.id);
      if (existingShot) continue;
    } else {
      const existingShot = db.prepare('SELECT id FROM redraw_shots WHERE version_id = ? AND batch_index = ? AND shot_index = ? LIMIT 1')
        .get(version.id, 1, index + 1);
      if (existingShot) continue;
    }
    insertDynamic(db, 'redraw_shots', {
      work_id: work.id,
      version_id: version.id,
      tenant_id: work.tenant_id || null,
      user_id: work.user_id || null,
      shot_id: shot.id,
      batch_index: 1,
      shot_index: index + 1,
      start_ms: shot.start_ms,
      end_ms: shot.end_ms,
      duration_ms: shot.end_ms - shot.start_ms,
      source_dialogue_json: JSON.stringify(shot.dialogue || []),
      localized_dialogue_json: JSON.stringify(shot.dialogue || []),
      opening_state: shot.opening_state,
      continuous_action: shot.continuous_action,
      ending_state: shot.ending_state,
      draft_json: JSON.stringify(shot),
      status: 'draft',
      created_at: now,
      updated_at: now,
    });
  }
  updateDynamic(db, 'redraw_works', {
    status: state.workStatus,
    current_version: Number(version.version || 1),
    current_step: state.currentStep,
    error_msg: state.errorMessage,
    updated_at: now,
  }, 'id', work.id);
  if (version.status !== state.versionStatus) {
    updateDynamic(db, 'redraw_versions', { status: state.versionStatus, updated_at: now }, 'id', version.id);
    version = { ...version, status: state.versionStatus };
  }
  if (outcome?.project) {
    appendWorkflowEvent(db, {
      tenantId: String(outcome.project.tenant_id || ''),
      userId: String(outcome.project.user_id || ''),
      projectId: Number(outcome.project.id),
      resourceType: 'version',
      resourceId: String(version.id),
      fromState: String(work.status || ''),
      toState: outcome.projectStatus,
      reasonCode: 'analysis_completed',
      evidenceHash: normalized.facts_hash,
      metadata: {
        action: outcome.decision.action,
        effective_mode: outcome.decision.effective_mode,
        reason_codes: outcome.decision.reason_codes,
        policy_version: Number(outcome.project.policy_version || 0),
      },
      createdAt: now,
    });
  }
  return { version, changed };
}

function existingSourceFactsVersion(db, work) {
  const columns = tableColumns(db, 'redraw_versions');
  const localeClause = columns.has('locale') ? "AND locale = 'source'" : '';
  return db.prepare(
    `SELECT *
     FROM redraw_versions
     WHERE work_id = ? ${localeClause} AND source_facts_json IS NOT NULL
     ORDER BY CASE WHEN version = ? THEN 0 ELSE 1 END, version DESC, id DESC
     LIMIT 1`
  ).get(work.id, Number(work.current_version || 0));
}

function finalizeCompletedAnalysis(db, log, task, work, result, options = {}) {
  try {
    assertAssetReadable(db, options.assetReader, work.source_asset_id, '源片');
    const resultAssetId = result.result_asset_id || result.result_asset?.id;
    assertAssetReadable(db, options.assetReader, resultAssetId, '分析结果');
    const normalized = normalizeSourceFacts(result.facts || result.source_facts);
    const existingVersion = existingSourceFactsVersion(db, work);
    if (existingVersion) {
      if (existingVersion.facts_hash !== normalized.facts_hash) {
        const error = codedError('SOURCE_FACTS_HASH_CONFLICT', '源片事实 hash 冲突，请人工确认后再继续');
        error.existing_hash = existingVersion.facts_hash;
        error.incoming_hash = normalized.facts_hash;
        throw error;
      }
      const policyVersion = projectPolicyVersion(db, work);
      const decision = persistedAutomationDecision(task, normalized.facts_hash, existingVersion.id, policyVersion)
        || eventAutomationDecision(db, work, existingVersion, normalized.facts_hash);
      if (!decision && work.project_id) throw codedError('AUTOMATION_DECISION_MISSING', '自动化分析决策缺失');
      const alreadyComplete = task.status === 'completed'
        && persistedAutomationDecision(task, normalized.facts_hash, existingVersion.id, policyVersion)
        && !reservationIsHeld(db, task.credit_reservation_id || work.credit_reservation_id);
      if (!alreadyComplete && decision) {
        atomicFinalize(db, () => {
          taskService.updateTaskResult(
            db,
            task.id,
            taskResultPayload(work, existingVersion, resultAssetId, normalized.facts_hash, decision),
          );
          creditLedger.settleGeneration(db, task.credit_reservation_id || work.credit_reservation_id, 'completed');
        });
      }
      return {
        status: 'completed',
        facts_hash: normalized.facts_hash,
        version_id: existingVersion.id,
        result_asset_id: resultAssetId,
        automation_decision: decision,
      };
    }
    const committed = atomicFinalize(db, () => {
      const outcome = automationOutcome(db, work, normalized);
      const { version } = writeFactsOnce(db, work, normalized, outcome);
      if (task.status !== 'completed') {
        taskService.updateTaskResult(
          db,
          task.id,
          taskResultPayload(work, version, resultAssetId, normalized.facts_hash, outcome.decision),
        );
      }
      creditLedger.settleGeneration(db, task.credit_reservation_id || work.credit_reservation_id, 'completed');
      return { version, decision: outcome.decision };
    });
    return {
      status: 'completed',
      facts_hash: normalized.facts_hash,
      version_id: committed.version.id,
      result_asset_id: resultAssetId,
      automation_decision: committed.decision,
    };
  } catch (error) {
    if (error.code === 'SOURCE_FACTS_HASH_CONFLICT') {
      markNeedsAttention(db, task, work, error.message);
      return { status: 'needs_attention', error: error.message };
    }
    if (error.atomic_finalize_failed) {
      log?.warn?.('redraw analysis atomic finalize failed', { task_id: task.id, work_id: work.id, message: error.message });
      return { status: 'failed', error: error.message };
    }
    markFailure(db, log, task, work, error.message);
    return { status: 'failed', error: error.message };
  }
}

async function runAnalyzeTask(db, log, taskId, options = {}) {
  const task = getTask(db, taskId);
  if (!task || task.type !== 'redraw_analysis') return null;
  const work = getWork(db, task.resource_id);
  if (!work) throw codedError('REDRAW_WORK_NOT_FOUND', '转绘作品不存在');
  const providerTaskId = task.provider_task_id || work.provider_task_id;
  let result;
  try {
    result = options.provider?.pollAnalysisTask
      ? await options.provider.pollAnalysisTask({ task, work, providerTaskId })
      : { status: 'unknown', error: '源片分析供应商恢复查询不可用' };
  } catch (error) {
    if (error.code === 'REDRAW_PROVIDER_RESUME_UNAVAILABLE') {
      markNeedsAttention(db, task, work, error.message);
      return { status: 'needs_attention', error: error.message };
    }
    throw error;
  }

  if (result.status === 'processing' || result.status === 'pending') {
    taskService.updateTaskStatus(db, task.id, 'processing', 90, '供应商仍在分析源片');
    return { status: 'processing' };
  }
  if (result.status === 'failed') {
    markFailure(db, log, task, work, result.error || '供应商源片分析失败');
    return { status: 'failed' };
  }
  if (result.status !== 'completed') {
    markNeedsAttention(db, task, work, '源片分析状态未知，请人工确认后再处理');
    return { status: 'needs_attention' };
  }

  return finalizeCompletedAnalysis(db, log, task, work, result, options);
}

async function resumeRedrawTasks(db, log, options = {}) {
  const shotNeedsAttention = redrawGenerationService.markInterruptedShotGenerationsNeedsAttention(db, log);
  let rows;
  try {
    rows = db.prepare(
      `SELECT t.id AS task_id, t.provider_task_id AS task_provider_task_id,
              w.id AS work_id, w.provider_task_id AS work_provider_task_id
       FROM async_tasks t
       JOIN redraw_works w ON w.id = t.resource_id
       WHERE t.type = 'redraw_analysis' AND t.status = 'processing' AND w.status = 'analyzing' AND t.deleted_at IS NULL`
    ).all();
  } catch (error) {
    if (!/no such column: t\.provider_task_id/i.test(String(error.message || ''))) throw error;
    rows = db.prepare(
      `SELECT t.id AS task_id, NULL AS task_provider_task_id,
              w.id AS work_id, w.provider_task_id AS work_provider_task_id
       FROM async_tasks t
       JOIN redraw_works w ON w.id = t.resource_id
       WHERE t.type = 'redraw_analysis' AND t.status = 'processing' AND w.status = 'analyzing' AND t.deleted_at IS NULL`
    ).all();
  }
  let resumed = 0;
  let failed = 0;
  for (const row of rows) {
    const providerTaskId = row.task_provider_task_id || row.work_provider_task_id;
    if (providerTaskId && String(providerTaskId).trim()) {
      resumed += 1;
      await runAnalyzeTask(db, log, row.task_id, options);
    } else {
      const task = getTask(db, row.task_id);
      const work = getWork(db, row.work_id);
      markFailure(db, log, task, work, '服务重启后无法恢复源片分析（缺少厂商任务 ID）');
      failed += 1;
    }
  }
  return { resumed, failed, shot_needs_attention: shotNeedsAttention };
}

module.exports = {
  startAnalysis,
  runAnalyzeTask,
  resumeRedrawTasks,
  generateShot(db, log, input, options = {}) {
    return redrawGenerationService.generateShot({
      db,
      log,
      tenantId: input?.tenantId,
      userId: input?.userId,
      ...options,
    }, input);
  },
  quoteAnalysis,
  loadVerifiedCapability,
  createStartupResumeOptions,
  createAssetReader,
};
