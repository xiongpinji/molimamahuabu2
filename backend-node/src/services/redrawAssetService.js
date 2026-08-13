const creditLedger = require('./creditLedgerService');
const aiConfigService = require('./aiConfigService');
const {
  readIdentityPack,
  identityPackStatus,
} = require('./redrawCharacterIdentityService');

let defaultEvidenceRegistry = null;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeOwner(ctx = {}) {
  return {
    tenantId: ctx.tenantId ?? ctx.tenant_id ?? null,
    userId: ctx.userId ?? ctx.user_id ?? null,
  };
}

function assertContext(ctx) {
  if (!ctx?.db) throw codedError('REDRAW_ASSET_DB_REQUIRED', '缺少数据库');
  const { tenantId, userId } = normalizeOwner(ctx);
  if (!tenantId) throw codedError('REDRAW_ASSET_TENANT_REQUIRED', '缺少租户');
  if (!userId) throw codedError('REDRAW_ASSET_USER_REQUIRED', '缺少用户');
  if (!ctx.versionId) throw codedError('REDRAW_VERSION_REQUIRED', '缺少本地化版本');
  return { db: ctx.db, tenantId: String(tenantId), userId: String(userId) };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function getVersion(ctx) {
  const { db, tenantId, userId } = assertContext(ctx);
  const version = db.prepare(`
    SELECT * FROM redraw_versions
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(ctx.versionId), tenantId, userId);
  if (!version) throw codedError('REDRAW_VERSION_NOT_FOUND', '本地化版本不存在');
  return version;
}

function rowToAsset(row) {
  if (!row) return null;
  const sourcePayload = parseJson(row.source_ref_json, {});
  const identityPack = readIdentityPack(row);
  const { identity_pack: _storedIdentityPack, ...directSourceRef } = sourcePayload;
  return {
    ...row,
    source_ref_json: identityPack
      ? JSON.stringify({ ...sourcePayload, identity_pack: identityPack })
      : row.source_ref_json,
    source_ref: sourcePayload.source_ref || sourcePayload.source || directSourceRef,
    source_asset_id: sourcePayload.source_asset_id
      ?? sourcePayload.source_ref?.source_asset_id
      ?? row.source_asset_id
      ?? null,
    snapshot: sourcePayload.snapshot || {},
    identity_pack: identityPack,
    identity_pack_status: identityPackStatus(identityPack),
    review_status: row.status === 'needs_attention' && row.approval_status === 'pending'
      ? 'needs_review'
      : row.approval_status,
  };
}

function assetWhere(ctx, extra = '') {
  const { tenantId, userId } = assertContext(ctx);
  return {
    sql: `SELECT * FROM redraw_assets WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL${extra}`,
    params: [tenantId, userId],
  };
}

function listAssets(db, ctx, filters = {}) {
  const scoped = assetWhere({ ...ctx, db });
  const clauses = ['version_id = ?'];
  const params = [...scoped.params, Number(ctx.versionId)];
  if (filters.kind) {
    clauses.push('kind = ?');
    params.push(String(filters.kind));
  }
  const rows = db.prepare(`${scoped.sql} AND ${clauses.join(' AND ')} ORDER BY kind ASC, version_number DESC, id DESC`)
    .all(...params);
  return rows.map(rowToAsset);
}

function updateAsset(db, ctx, assetId, changes = {}) {
  const { tenantId, userId } = assertContext({ ...ctx, db });
  const row = db.prepare(`
    SELECT * FROM redraw_assets
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(assetId), tenantId, userId);
  if (!row) return null;
  const updates = [];
  const params = [];
  const fields = {
    localizedName: 'localized_name',
    localizedDescription: 'localized_description',
    prompt: 'prompt',
  };
  for (const [input, column] of Object.entries(fields)) {
    if (changes[input] !== undefined) {
      updates.push(`${column} = ?`);
      params.push(String(changes[input]));
    }
  }
  if (updates.length === 0) return rowToAsset(row);
  updates.push("approval_status = 'pending'");
  updates.push('approved_by = NULL');
  updates.push('approved_at = NULL');
  params.push(new Date().toISOString(), Number(assetId));
  db.prepare(`UPDATE redraw_assets SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`).run(...params);
  return rowToAsset(db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(assetId)));
}

function listAssetVersions(db, ctx, assetId) {
  const { tenantId, userId } = assertContext({ ...ctx, db });
  const current = db.prepare(`
    SELECT version_id, kind, source_ref_json
    FROM redraw_assets
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(assetId), tenantId, userId);
  if (!current) return [];
  const sourceKey = stableJson(parseJson(current.source_ref_json, {}).source_ref || {});
  return db.prepare(`
    SELECT * FROM redraw_assets
    WHERE version_id = ? AND kind = ?
      AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY version_number DESC, id DESC
  `).all(current.version_id, current.kind, tenantId, userId)
    .filter((row) => stableJson(parseJson(row.source_ref_json, {}).source_ref || {}) === sourceKey)
    .map(rowToAsset);
}

function createAssetAttempt(ctx, input = {}) {
  const { db, tenantId, userId } = assertContext(ctx);
  const version = getVersion({ ...ctx, db });
  const kind = String(input.kind || '').trim();
  if (!['character', 'scene', 'prop', 'voice'].includes(kind)) {
    throw codedError('REDRAW_ASSET_KIND_INVALID', '不支持的转绘资产类型');
  }
  const sourceRef = input.sourceRef || input.source_ref;
  if (!sourceRef || typeof sourceRef !== 'object') throw codedError('REDRAW_ASSET_SOURCE_REQUIRED', '缺少资产来源引用');
  const snapshot = input.snapshot || input.generationSnapshot || input.generation_snapshot || {};
  validateVoiceTtsConfigPin({ ...ctx, db }, { kind, snapshot });
  validateVoiceAuthorizationInput({ ...ctx, db, versionId: version.id }, { kind, sourceRef });
  const sourceKey = stableJson(sourceRef);
  const previousRows = db.prepare(`
    SELECT *
    FROM redraw_assets
    WHERE version_id = ? AND kind = ?
      AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).all(Number(version.id), kind, tenantId, userId);
  const matchingRows = previousRows
    .filter((row) => stableJson(parseJson(row.source_ref_json, {}).source_ref || {}) === sourceKey);
  if (matchingRows.some((row) => String(row.status) === 'processing')) {
    throw codedError('REDRAW_ASSET_ATTEMPT_IN_PROGRESS', '该资产已有生成任务处理中');
  }
  if (kind === 'voice' && matchingRows.some((row) => String(row.status) === 'needs_attention')) {
    throw codedError('REDRAW_ASSET_ATTEMPT_NEEDS_ATTENTION', '该音色生成结果需要人工确认，禁止重复提交');
  }
  if (kind !== 'voice' && matchingRows.some((row) => String(row.status) === 'needs_attention' && row.error_code)) {
    throw codedError('REDRAW_ASSET_ATTEMPT_NEEDS_ATTENTION', '该资产生成结果需要人工确认，禁止重复提交');
  }
  const placeholder = matchingRows
    .filter((row) => String(row.status) === 'draft'
      && !row.generation_task_id && !row.credit_reservation_id && !row.asset_id
      && !row.voice_asset_id && !row.clean_plate_asset_id)
    .sort((left, right) => Number(right.version_number) - Number(left.version_number) || Number(right.id) - Number(left.id))[0] || null;
  const previous = matchingRows
    .reduce((max, row) => Math.max(max, Number(row.version_number || 0)), 0);
  if (!placeholder && previous === 0 && ctx.allowUnmaterializedDraft !== true) {
    throw codedError('REDRAW_ASSET_PLACEHOLDER_REQUIRED', '当前版本缺少可认领的本地化资产草稿');
  }
  const versionNumber = placeholder ? Number(placeholder.version_number) : previous + 1;
  let reservation = null;
  const amount = Number(ctx.creditAmount || input.creditAmount || 0);
  const model = String(input.model || ctx.model || 'redraw-asset');
  const operationKey = String(input.operationKey || ctx.operationKey || `redraw_asset:${version.id}:${kind}:${sourceKey}:${versionNumber}`);
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    if (amount > 0) {
      reservation = creditLedger.reserve(db, {
        tenantId,
        actorUserId: userId,
        userId,
        operationKey,
        amount,
        model,
        resourceType: 'redraw_asset',
        resourceId: `${version.id}:${kind}:${versionNumber}`,
      });
    }
    const sourcePayload = JSON.stringify({ source_ref: sourceRef, snapshot });
    const localizedName = String(input.localizedName ?? input.localized_name ?? placeholder?.localized_name ?? '');
    const localizedDescription = String(input.localizedDescription ?? input.localized_description
      ?? placeholder?.localized_description ?? '');
    const prompt = String(input.prompt ?? placeholder?.prompt ?? '');
    const generationTaskId = input.generationTaskId || input.generation_task_id || null;
    if (placeholder) {
      const claimed = db.prepare(`
        UPDATE redraw_assets
        SET source_ref_json = ?, localized_name = ?, localized_description = ?, prompt = ?,
            generation_task_id = ?, credit_reservation_id = ?, approval_status = 'pending',
            status = 'processing', error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'draft'
          AND generation_task_id IS NULL AND credit_reservation_id IS NULL
          AND asset_id IS NULL AND voice_asset_id IS NULL AND clean_plate_asset_id IS NULL
      `).run(
        sourcePayload, localizedName, localizedDescription, prompt,
        generationTaskId, reservation?.id || null, now,
        Number(placeholder.id), tenantId, userId,
      );
      if (claimed.changes !== 1) {
        throw codedError('REDRAW_ASSET_ATTEMPT_CONFLICT', '资产草稿已被其他任务认领');
      }
      return Number(placeholder.id);
    }
    const result = db.prepare(`
        INSERT INTO redraw_assets
          (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
           localized_description, prompt, generation_task_id, credit_reservation_id, version_number,
           approval_status, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'processing', ?, ?)
      `).run(
        Number(version.id), tenantId, userId, kind, sourcePayload,
        localizedName, localizedDescription, prompt, generationTaskId,
        reservation?.id || null, versionNumber, now, now,
      );
    return Number(result.lastInsertRowid);
  })();
  return {
    id: transaction,
    version_id: Number(version.id),
    version_number: versionNumber,
    kind,
    source_ref: sourceRef,
    reservation_id: reservation?.id || null,
    snapshot,
  };
}

function readProviderAsset(db, assetId) {
  if (!assetId) return null;
  return db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(assetId)) || null;
}

function readOwnedAuthorizationAsset(db, input = {}) {
  const assetId = Number(input.assetId ?? input.asset_id);
  const versionId = Number(input.versionId ?? input.version_id);
  const tenantId = String(input.tenantId ?? input.tenant_id ?? '').trim();
  const userId = String(input.userId ?? input.user_id ?? '').trim();
  if (!db || !Number.isSafeInteger(assetId) || assetId <= 0
    || !Number.isSafeInteger(versionId) || versionId <= 0 || !tenantId || !userId) return null;
  return db.prepare(`
    SELECT authorization.*
    FROM assets authorization
    WHERE authorization.id = ? AND authorization.deleted_at IS NULL
      AND authorization.category = 'voice_authorization'
      AND (
        (authorization.type = 'audio' AND authorization.mime_type LIKE 'audio/%')
        OR (authorization.type IN ('text', 'document')
          AND authorization.mime_type IN ('text/plain', 'application/pdf'))
      )
      AND (
        EXISTS (
          SELECT 1 FROM dramas owner
          WHERE owner.id = authorization.drama_id
            AND owner.tenant_id = ? AND owner.user_id = ? AND owner.deleted_at IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM redraw_versions version
          JOIN redraw_works work ON work.id = version.work_id
          WHERE version.id = ?
            AND version.tenant_id = ? AND version.user_id = ? AND version.deleted_at IS NULL
            AND work.tenant_id = ? AND work.user_id = ? AND work.deleted_at IS NULL
            AND work.source_asset_id = authorization.id
        )
      )
  `).get(assetId, tenantId, userId, versionId, tenantId, userId, tenantId, userId) || null;
}

function validateVoiceAuthorizationInput(ctx, input = {}) {
  if (String(input.kind || '') !== 'voice') return null;
  const sourceRef = input.sourceRef || input.source_ref || {};
  const isCloned = sourceRef.is_cloned === true || sourceRef.cloned === true || sourceRef.voice_type === 'clone';
  if (!isCloned) return null;
  const asset = readOwnedAuthorizationAsset(ctx.db, {
    assetId: sourceRef.authorization_asset_id ?? sourceRef.authorizationAssetId,
    versionId: ctx.versionId ?? ctx.version_id,
    tenantId: ctx.tenantId ?? ctx.tenant_id,
    userId: ctx.userId ?? ctx.user_id,
  });
  const readable = typeof ctx.assetReader?.canRead === 'function'
    ? ctx.assetReader.canRead(asset) === true
    : typeof ctx.canReadArtifact === 'function'
      ? ctx.canReadArtifact(asset?.id) === true
      : asset?.readable === true;
  if (!asset || !readable) {
    throw codedError('REDRAW_VOICE_AUTHORIZATION_REQUIRED', '克隆音色缺少当前用户可读的专用授权资产');
  }
  return asset;
}

function configSupportsModel(config, model) {
  const models = Array.isArray(config?.model) ? config.model.map(String) : [];
  return String(config?.default_model || '') === String(model || '') || models.includes(String(model || ''));
}

function validateVoiceTtsConfigPin(ctx, input = {}) {
  if (String(input.kind || '') !== 'voice') return null;
  const snapshot = input.snapshot || input.generationSnapshot || input.generation_snapshot || {};
  const configId = Number(snapshot.ai_service_config_id ?? snapshot.aiServiceConfigId);
  const configUpdatedAt = String(snapshot.config_updated_at ?? snapshot.configUpdatedAt ?? '').trim();
  const provider = String(snapshot.provider || '').trim();
  const model = String(snapshot.model || '').trim();
  if (!Number.isSafeInteger(configId) || configId <= 0 || !configUpdatedAt || !provider || !model) {
    throw codedError('REDRAW_TTS_CONFIG_PIN_INVALID', '语音生成缺少精确的服务端 TTS 配置快照');
  }
  const config = aiConfigService.getConfig(ctx.db, configId);
  if (!config || config.service_type !== 'tts' || !config.is_active
    || String(config.provider || '') !== provider
    || String(config.updated_at || '') !== configUpdatedAt
    || !configSupportsModel(config, model)) {
    throw codedError('REDRAW_TTS_CONFIG_PIN_INVALID', '语音生成的 TTS 配置快照已失效');
  }
  return config;
}

function assertReadableAsset(ctx, assetId, label) {
  const asset = readProviderAsset(ctx.db, assetId);
  const canRead = typeof ctx.assetReader?.canRead === 'function'
    ? ctx.assetReader.canRead(asset)
    : asset?.readable === true;
  if (!asset || !canRead) throw codedError('ASSET_NOT_READABLE', `${label}资产不可读取`);
  return asset;
}

function validateCleanPlateQuality(sceneAsset, options, providerResult) {
  const quality = providerResult.quality || providerResult.metrics;
  const width = Number(quality?.width);
  const height = Number(quality?.height);
  if (!quality || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw codedError('CLEAN_PLATE_QUALITY_UNVERIFIED', '净景质量未通过：缺少可审计尺寸');
  }
  const expectedWidth = Number(options.width || sceneAsset.width || sceneAsset.source_width);
  const expectedHeight = Number(options.height || sceneAsset.height || sceneAsset.source_height);
  if ((Number.isFinite(expectedWidth) && width !== expectedWidth)
    || (Number.isFinite(expectedHeight) && height !== expectedHeight)) {
    throw codedError('CLEAN_PLATE_QUALITY_FAILED', '净景质量未通过：输出尺寸与源场景不一致');
  }
  if (quality.mask_area_changed !== true) {
    throw codedError('CLEAN_PLATE_QUALITY_FAILED', '净景质量未通过：遮罩区域没有可验证变化');
  }
  const similarity = Number(quality.non_mask_similarity);
  const minimum = Number(options.nonMaskSimilarityMin ?? 0.9);
  if (!Number.isFinite(similarity) || similarity < minimum) {
    throw codedError('CLEAN_PLATE_QUALITY_FAILED', '净景质量未通过：非遮罩区域结构相似度不足');
  }
}

function cleanPlateQualityOptions(attempt, providerResult = {}) {
  const snapshot = parseJson(attempt.source_ref_json, {}).snapshot || {};
  return {
    width: snapshot.expected_width ?? snapshot.source_width ?? snapshot.width,
    height: snapshot.expected_height ?? snapshot.source_height ?? snapshot.height,
    nonMaskSimilarityMin: providerResult.nonMaskSimilarityMin ?? providerResult.non_mask_similarity_min,
  };
}

function completedProviderStatus(status) {
  return ['completed', 'complete', 'succeeded', 'success', 'done'].includes(String(status || '').toLowerCase());
}

function isHexSha256(value) {
  return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function evidenceRegistry(ctx = {}) {
  return ctx.localeRegistry || ctx.locale_registry
    || ctx.evidenceRegistry || ctx.evidence_registry
    || ctx.registry || defaultEvidenceRegistry;
}

function assertEvidenceTrusted(ctx, evidence) {
  const registry = evidenceRegistry(ctx);
  if (!registry || typeof registry.assertEvidenceTrusted !== 'function') return false;
  try {
    registry.assertEvidenceTrusted(evidence);
    return true;
  } catch (_) {
    return false;
  }
}

function indeterminateProviderOutcome(value) {
  const status = String(value?.status || '').toLowerCase();
  const code = String(value?.code || value?.error_code || '').toUpperCase();
  return value?.unknown === true || !status
    || ['pending', 'processing', 'indeterminate', 'needs_attention', 'unknown'].includes(status)
    || ['UNKNOWN', 'PROVIDER_UNKNOWN', 'TASK_UNKNOWN', 'STATUS_UNKNOWN', 'INDETERMINATE'].includes(code);
}

function ambiguousVoiceError(error) {
  const code = String(error?.code || '').toUpperCase();
  return error?.unknown === true || error?.provider_completed === true
    || ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN',
      'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'PROVIDER_STATUS_UNKNOWN',
      'ASSET_NOT_READABLE', 'REDRAW_VOICE_DURATION_REQUIRED'].includes(code)
    || /timed?\s*out|timeout|network|socket hang up|connection reset/i.test(String(error?.message || ''));
}

function markAssetNeedsAttention(
  ctx,
  attempt,
  message,
  code = 'REDRAW_VOICE_EVIDENCE_INCOMPLETE',
  voiceAssetId = null,
  providerTaskId = null,
  options = {},
) {
  const now = new Date().toISOString();
  const current = ctx.db.prepare(`
    SELECT source_ref_json FROM redraw_assets
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND kind = 'voice' AND deleted_at IS NULL
  `).get(Number(attempt.id), String(attempt.tenant_id), String(attempt.user_id));
  const sourcePayload = parseJson(current?.source_ref_json, {});
  const taskId = String(providerTaskId || '').trim();
  const nextSourcePayload = taskId
    ? {
        ...sourcePayload,
        snapshot: {
          ...(sourcePayload.snapshot && typeof sourcePayload.snapshot === 'object' ? sourcePayload.snapshot : {}),
          provider_task_id: taskId,
          ...(options.providerCompleted ? { provider_completed: true } : {}),
        },
      }
    : sourcePayload;
  ctx.db.prepare(`
    UPDATE redraw_assets
    SET voice_asset_id = COALESCE(?, voice_asset_id), source_ref_json = ?,
        status = 'needs_attention', approval_status = 'pending',
        error_code = ?, error_message = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND kind = 'voice' AND deleted_at IS NULL
  `).run(
    Number.isSafeInteger(Number(voiceAssetId)) && Number(voiceAssetId) > 0 ? Number(voiceAssetId) : null,
    JSON.stringify(nextSourcePayload),
    String(code),
    String(message),
    now,
    Number(attempt.id),
    String(attempt.tenant_id),
    String(attempt.user_id),
  );
  return rowToAsset(ctx.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(attempt.id)));
}

function markCompletedAssetNeedsAttention(ctx, attempt, asset, providerResult, error) {
  const now = new Date().toISOString();
  const sourcePayload = parseJson(attempt.source_ref_json, {});
  const snapshot = sourcePayload.snapshot && typeof sourcePayload.snapshot === 'object'
    ? sourcePayload.snapshot
    : {};
  const providerTaskId = String(
    providerResult.provider_task_id || providerResult.providerTaskId
      || providerResult.task_id || providerResult.taskId || '',
  ).trim();
  const nextSourcePayload = {
    ...sourcePayload,
    snapshot: {
      ...snapshot,
      completed_asset_id: Number(asset.id),
      ...(providerTaskId ? { provider_task_id: providerTaskId } : {}),
    },
  };
  const targetColumn = attempt.kind === 'scene' && providerResult.clean_plate === true
    ? 'clean_plate_asset_id'
    : 'asset_id';
  ctx.db.prepare(`
    UPDATE redraw_assets
    SET ${targetColumn} = ?, source_ref_json = ?, status = 'needs_attention', approval_status = 'pending',
        error_code = 'REDRAW_ASSET_SETTLEMENT_UNKNOWN', error_message = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND kind != 'voice' AND deleted_at IS NULL
  `).run(
    Number(asset.id),
    JSON.stringify(nextSourcePayload),
    `供应商已完成但本地结算状态未知：${String(error?.message || error)}`,
    now,
    Number(attempt.id),
    String(attempt.tenant_id),
    String(attempt.user_id),
  );
  return rowToAsset(ctx.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(attempt.id)));
}

function readableAsset(ctx, asset) {
  if (!asset) return false;
  return typeof ctx.assetReader?.canRead === 'function'
    ? ctx.assetReader.canRead(asset) === true
    : asset.readable === true;
}

function verifiedVoiceEvidence(ctx, attempt, asset, providerResult, terminalStatus) {
  const raw = providerResult.voice_evidence || providerResult.voiceEvidence;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sourcePayload = parseJson(attempt.source_ref_json, {});
  const sourceRef = sourcePayload.source_ref && typeof sourcePayload.source_ref === 'object'
    ? sourcePayload.source_ref
    : {};
  const attemptSnapshot = sourcePayload.snapshot && typeof sourcePayload.snapshot === 'object'
    ? sourcePayload.snapshot
    : {};
  const version = ctx.db.prepare(`
    SELECT locale, market FROM redraw_versions
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(attempt.version_id), String(attempt.tenant_id), String(attempt.user_id));
  if (!version) return null;
  const locale = String(version.locale || '');
  const market = String(version.market || '');
  const providerTaskId = String(
    providerResult.provider_task_id || providerResult.providerTaskId
      || providerResult.task_id || providerResult.taskId || '',
  ).trim();
  const rawTaskId = String(raw.task_id || raw.taskId || '').trim();
  const rawStatus = String(raw.terminal_status || raw.terminalStatus || '').toLowerCase();
  const provider = String(raw.provider || '').trim();
  const model = String(raw.model || '').trim();
  const voiceId = String(raw.voice_id || raw.voiceId || '').trim();
  const expectedVoiceId = String(sourceRef.voice_id || sourceRef.voiceId || '').trim();
  const expectedModel = String(attemptSnapshot.model || ctx.model || '').trim();
  const expectedProvider = String(attemptSnapshot.provider || '').trim();
  const detectedLocale = String(raw.detected_locale || raw.detectedLocale || '').trim();
  const workerEvidence = raw.locale_verifier && typeof raw.locale_verifier === 'object' ? raw.locale_verifier : {};
  const source = String(raw.source || workerEvidence.source || '').trim();
  const localePack = String(raw.locale_pack || raw.localePack || workerEvidence.localePack
    || workerEvidence.locale_pack || '').trim();
  const audioSha256 = String(raw.audio_sha256 || raw.audioSha256 || workerEvidence.audioSha256
    || workerEvidence.audio_sha256 || '').trim();
  const transcriptSha256 = String(raw.transcript_sha256 || raw.transcriptSha256
    || workerEvidence.transcriptSha256 || workerEvidence.transcript_sha256 || '').trim();
  const modelManifestSha256 = String(raw.model_manifest_sha256 || raw.modelManifestSha256
    || workerEvidence.modelManifestSha256 || workerEvidence.model_manifest_sha256 || '').trim();
  const calibrationManifestSha256 = String(
    raw.calibration_manifest_sha256 || raw.calibrationManifestSha256
      || workerEvidence.calibrationManifestSha256 || workerEvidence.calibration_manifest_sha256 || '',
  ).trim();
  const asrModelRevision = String(raw.asr_model_revision || raw.asrModelRevision || raw.asr_revision
    || workerEvidence.asrModelRevision || workerEvidence.asr_model_revision || workerEvidence.asr_revision || '').trim();
  const accentModelRevision = String(
    raw.accent_model_revision || raw.accentModelRevision || raw.accent_revision
      || workerEvidence.accentModelRevision || workerEvidence.accent_model_revision || workerEvidence.accent_revision || '',
  ).trim();
  const metrics = raw.metrics && typeof raw.metrics === 'object' && !Array.isArray(raw.metrics)
    ? raw.metrics
    : workerEvidence.metrics && typeof workerEvidence.metrics === 'object' && !Array.isArray(workerEvidence.metrics)
      ? workerEvidence.metrics
      : null;
  const completedAt = String(raw.completed_at || raw.completedAt
    || workerEvidence.completedAt || workerEvidence.completed_at || '').trim();
  const durationMs = Math.round(Number(asset.duration ?? providerResult.duration) * 1000);
  const rawDurationMs = Number(raw.duration_ms ?? raw.durationMs);
  const rawAudioAssetId = Number(raw.audio_asset_id ?? raw.audioAssetId);
  const aiServiceConfigId = Number(raw.ai_service_config_id ?? raw.aiServiceConfigId);
  const configUpdatedAt = String(raw.config_updated_at ?? raw.configUpdatedAt ?? '').trim();
  const expectedConfigId = Number(attemptSnapshot.ai_service_config_id ?? attemptSnapshot.aiServiceConfigId);
  const expectedConfigUpdatedAt = String(
    attemptSnapshot.config_updated_at ?? attemptSnapshot.configUpdatedAt ?? '',
  ).trim();
  const isCloned = raw.is_cloned === true || raw.cloned === true || raw.voice_type === 'clone';
  const authorizationAssetId = Number(raw.authorization_asset_id ?? raw.authorizationAssetId);
  const sourceAuthorizationAssetId = Number(sourceRef.authorization_asset_id ?? sourceRef.authorizationAssetId);
  const authorizationAsset = isCloned && Number.isSafeInteger(authorizationAssetId) && authorizationAssetId > 0
    ? readOwnedAuthorizationAsset(ctx.db, {
      assetId: authorizationAssetId,
      versionId: attempt.version_id,
      tenantId: attempt.tenant_id,
      userId: attempt.user_id,
    })
    : null;
  const trustedEvidence = {
    source,
    locale_pack: localePack,
    model_manifest_sha256: modelManifestSha256,
    calibration_manifest_sha256: calibrationManifestSha256,
  };
  if (!locale || !market || raw.locale !== locale || raw.market !== market
    || source !== 'offline-worker'
    || !localePack
    || !isHexSha256(audioSha256)
    || !isHexSha256(transcriptSha256)
    || !isHexSha256(modelManifestSha256)
    || !isHexSha256(calibrationManifestSha256)
    || !asrModelRevision
    || !accentModelRevision
    || !metrics
    || Object.keys(metrics).length === 0
    || !completedAt
    || !assertEvidenceTrusted(ctx, trustedEvidence)
    || !provider || (expectedProvider && provider !== expectedProvider)
    || !model || (expectedModel && model !== expectedModel)
    || !Number.isSafeInteger(aiServiceConfigId) || aiServiceConfigId <= 0
    || !configUpdatedAt
    || (Number.isSafeInteger(expectedConfigId) && expectedConfigId > 0
      && (aiServiceConfigId !== expectedConfigId || configUpdatedAt !== expectedConfigUpdatedAt))
    || !voiceId || !expectedVoiceId || voiceId !== expectedVoiceId
    || !providerTaskId || rawTaskId !== providerTaskId
    || !completedProviderStatus(terminalStatus) || !completedProviderStatus(rawStatus)
    || raw.real_generation_verified !== true || raw.language_verified !== true
    || detectedLocale !== locale
    || !Number.isSafeInteger(rawAudioAssetId) || rawAudioAssetId !== Number(asset.id)
    || !Number.isFinite(durationMs) || durationMs <= 0
    || !Number.isFinite(rawDurationMs) || rawDurationMs !== durationMs
    || (isCloned && (authorizationAssetId !== sourceAuthorizationAssetId
      || !readableAsset(ctx, authorizationAsset)))) {
    return null;
  }
  return {
    source,
    locale,
    market,
    locale_pack: localePack,
    audio_sha256: audioSha256,
    transcript_sha256: transcriptSha256,
    model_manifest_sha256: modelManifestSha256,
    calibration_manifest_sha256: calibrationManifestSha256,
    asr_model_revision: asrModelRevision,
    accent_model_revision: accentModelRevision,
    metrics,
    completed_at: completedAt,
    provider,
    model,
    ai_service_config_id: aiServiceConfigId,
    config_updated_at: configUpdatedAt,
    voice_id: voiceId,
    task_id: providerTaskId,
    terminal_status: String(terminalStatus).toLowerCase(),
    audio_asset_id: Number(asset.id),
    duration_ms: durationMs,
    real_generation_verified: true,
    language_verified: true,
    detected_locale: detectedLocale,
    is_cloned: isCloned,
    authorization_asset_id: isCloned ? authorizationAssetId : null,
  };
}

function finalizeAssetAttempt(ctx, attemptId, providerResult = {}) {
  const { db, tenantId, userId } = assertContext(ctx);
  const attempt = db.prepare(`
    SELECT * FROM redraw_assets
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(attemptId), tenantId, userId);
  if (!attempt) throw codedError('REDRAW_ASSET_NOT_FOUND', '转绘资产尝试不存在');
  const reservationId = attempt.credit_reservation_id || null;
  const fail = (message, code = 'REDRAW_ASSET_GENERATION_FAILED') => {
    failAssetAttempt(ctx, attempt.id, Object.assign(new Error(String(message)), { code }));
    throw codedError(code, String(message));
  };
  const status = String(providerResult.status || '').toLowerCase();
  const providerTaskId = providerResult.provider_task_id || providerResult.providerTaskId
    || providerResult.task_id || providerResult.taskId || null;
  if (!completedProviderStatus(status)) {
    if (attempt.kind === 'voice' && indeterminateProviderOutcome(providerResult)) {
      return markAssetNeedsAttention(
        ctx,
        attempt,
        providerResult.error || '语音供应商任务状态未知',
        'REDRAW_VOICE_PROVIDER_UNKNOWN',
        null,
        providerTaskId,
      );
    }
    return fail(providerResult.error || '资产生成失败');
  }
  const assetId = providerResult.asset_id || providerResult.assetId || providerResult.asset?.id
    || providerResult.voice_asset_id || providerResult.voiceAssetId
    || providerResult.clean_plate_asset_id || providerResult.cleanPlateAssetId;
  const asset = readProviderAsset(db, assetId);
  const canRead = typeof ctx.assetReader?.canRead === 'function'
    ? ctx.assetReader.canRead(asset)
    : providerResult.readable === true;
  if (!asset || !canRead) {
    if (attempt.kind === 'voice') {
      return markAssetNeedsAttention(ctx, attempt, '生成语音不可读取', 'ASSET_NOT_READABLE', asset?.id, providerTaskId);
    }
    return fail('生成图片不可读取', 'ASSET_NOT_READABLE');
  }
  if (attempt.kind === 'voice'
    && (asset.type !== 'audio' || !String(asset.mime_type || '').toLowerCase().startsWith('audio/'))) {
    return markAssetNeedsAttention(ctx, attempt, '语音资产类型不是音频', 'VOICE_ASSET_TYPE_INVALID', asset.id, providerTaskId);
  }
  if (attempt.kind === 'voice') {
    const duration = Number(asset.duration ?? providerResult.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      return markAssetNeedsAttention(ctx, attempt, '语音资产缺少有效时长', 'VOICE_ASSET_DURATION_INVALID', asset.id, providerTaskId);
    }
  }
  if (attempt.kind === 'character' && providerResult.metadata?.views
    && (!Array.isArray(providerResult.metadata.views) || providerResult.metadata.views.length < 3)) {
    return fail('角色资产缺少正面、侧面、背面三视图', 'CHARACTER_VIEWS_INCOMPLETE');
  }
  if (attempt.kind === 'scene' && providerResult.clean_plate === true) {
    try {
      validateCleanPlateQuality(asset, cleanPlateQualityOptions(attempt, providerResult), providerResult);
    } catch (error) {
      return fail(error.message, error.code || 'CLEAN_PLATE_QUALITY_FAILED');
    }
  }
  const now = new Date().toISOString();
  if (attempt.kind === 'voice') {
    const sourcePayload = parseJson(attempt.source_ref_json, {});
    const snapshot = sourcePayload.snapshot && typeof sourcePayload.snapshot === 'object'
      ? sourcePayload.snapshot
      : {};
    const evidence = verifiedVoiceEvidence(ctx, attempt, asset, providerResult, status);
    if (!evidence) {
      return markAssetNeedsAttention(
        ctx,
        attempt,
        '语音生成已完成但生产证据不完整',
        'REDRAW_VOICE_EVIDENCE_INCOMPLETE',
        asset.id,
        providerTaskId,
      );
    }
    try {
      validateVoiceTtsConfigPin(ctx, { kind: attempt.kind, snapshot });
    } catch (error) {
      return markAssetNeedsAttention(
        ctx,
        attempt,
        error.message || '语音生成的 TTS 配置快照已失效',
        error.code || 'REDRAW_TTS_CONFIG_PIN_INVALID',
        asset.id,
        providerTaskId,
        { providerCompleted: true },
      );
    }
    const nextSourcePayload = { ...sourcePayload, snapshot: { ...snapshot, voice_evidence: evidence } };
    try {
      db.transaction(() => {
        db.prepare(`
          UPDATE redraw_assets
          SET voice_asset_id = ?, source_ref_json = ?, status = 'generated', approval_status = 'pending',
              error_code = NULL, error_message = NULL, updated_at = ?
          WHERE id = ?
        `).run(Number(asset.id), JSON.stringify(nextSourcePayload), now, Number(attempt.id));
        if (reservationId) creditLedger.settleGeneration(db, reservationId, 'completed');
      })();
    } catch (error) {
      return markAssetNeedsAttention(
        ctx,
        attempt,
        `语音扣费结算状态未知：${String(error.message || error)}`,
        'REDRAW_VOICE_SETTLEMENT_UNKNOWN',
        asset.id,
        providerTaskId,
      );
    }
    return rowToAsset(db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(attempt.id)));
  }
  const cleanPlate = attempt.kind === 'scene' && providerResult.clean_plate === true;
  const targetColumn = cleanPlate ? 'clean_plate_asset_id' : 'asset_id';
  const targetStatus = cleanPlate ? 'needs_attention' : 'generated';
  try {
    db.transaction(() => {
      db.prepare(`
        UPDATE redraw_assets
        SET ${targetColumn} = ?, status = ?, approval_status = 'pending',
            error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ?
      `).run(Number(asset.id), targetStatus, now, Number(attempt.id));
      if (reservationId) creditLedger.settleGeneration(db, reservationId, 'completed');
    })();
  } catch (error) {
    return markCompletedAssetNeedsAttention(ctx, attempt, asset, providerResult, error);
  }
  return rowToAsset(db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(attempt.id)));
}

function failAssetAttempt(ctx, attemptId, error) {
  const { db, tenantId, userId } = assertContext(ctx);
  const attempt = db.prepare(`
    SELECT * FROM redraw_assets
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(attemptId), tenantId, userId);
  if (!attempt) throw codedError('REDRAW_ASSET_NOT_FOUND', '转绘资产尝试不存在');
  const message = String(error?.message || error || '资产生成失败');
  const code = String(error?.code || 'REDRAW_ASSET_GENERATION_FAILED');
  if (String(attempt.status) === 'failed') return rowToAsset(attempt);
  const now = new Date().toISOString();
  db.prepare('UPDATE redraw_assets SET status = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?')
    .run('failed', code, message, now, Number(attempt.id));
  if (attempt.credit_reservation_id) creditLedger.settleGeneration(db, attempt.credit_reservation_id, 'failed', message);
  return rowToAsset(db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(attempt.id)));
}

async function generateAsset(ctx, input = {}) {
  const attempt = createAssetAttempt(ctx, input);
  try {
    if (typeof ctx.provider !== 'function') throw codedError('REDRAW_ASSET_PROVIDER_REQUIRED', '缺少资产生成 provider');
    const version = getVersion({ ...ctx, versionId: attempt.version_id });
    validateVoiceTtsConfigPin(ctx, attempt);
    validateVoiceAuthorizationInput({ ...ctx, versionId: attempt.version_id }, attempt);
    const result = await ctx.provider({
      attempt,
      input,
      versionId: attempt.version_id,
      locale: version.locale || null,
      market: version.market || null,
      model: attempt.snapshot?.model || ctx.model || input.model || null,
    });
    return finalizeAssetAttempt(ctx, attempt.id, result);
  } catch (error) {
    const row = ctx.db.prepare('SELECT status FROM redraw_assets WHERE id = ?').get(attempt.id);
    if (attempt.kind === 'voice' && row?.status === 'processing' && ambiguousVoiceError(error)) {
      return markAssetNeedsAttention(ctx, {
        ...attempt,
        tenant_id: ctx.tenantId ?? ctx.tenant_id,
        user_id: ctx.userId ?? ctx.user_id,
      }, error.message || '语音供应商任务状态未知', error.code || 'REDRAW_VOICE_PROVIDER_UNKNOWN', null,
      error.provider_task_id || error.providerTaskId || error.task_id || error.taskId || null);
    }
    if (row?.status !== 'failed') {
      failAssetAttempt(ctx, attempt.id, error);
    }
    throw error;
  }
}

async function generateCleanPlate(ctx, sceneAsset = {}, options = {}) {
  const { db } = assertContext(ctx);
  const maskAssetId = options.mask_asset_id ?? options.maskAssetId;
  if (!maskAssetId) throw codedError('CLEAN_PLATE_MASK_REQUIRED', '去人净景需要人物遮罩');
  const sourceAssetId = sceneAsset.source_asset_id
    ?? sceneAsset.sourceAssetId
    ?? sceneAsset.asset_id
    ?? sceneAsset.id;
  if (!sourceAssetId) throw codedError('CLEAN_PLATE_SOURCE_REQUIRED', '去人净景缺少源场景资产');
  assertReadableAsset(ctx, maskAssetId, '人物遮罩');
  assertReadableAsset(ctx, sourceAssetId, '源场景');

  const inputFrameFingerprint = options.inputFrameFingerprint
    || options.input_frame_fingerprint
    || sceneAsset.source_fingerprint
    || sceneAsset.sourceFingerprint
    || '';
  const model = String(options.model || ctx.model || 'redraw-clean-plate');
  const prompt = String(options.prompt || '去除人物并保留场景结构');
  const sourceRef = {
    source_asset_id: sourceAssetId,
    source_fingerprint: String(inputFrameFingerprint),
    source_ref: sceneAsset.source_ref || sceneAsset.sourceRef || {},
  };
  const attempt = createAssetAttempt({
    ...ctx,
    model,
    creditAmount: options.creditAmount ?? ctx.creditAmount,
    allowUnmaterializedDraft: true,
  }, {
    kind: 'scene',
    sourceRef,
    snapshot: {
      mode: 'clean_plate',
      source_asset_id: sourceAssetId,
      mask_asset_id: maskAssetId,
      input_frame_fingerprint: String(inputFrameFingerprint),
      model,
      prompt,
    },
    prompt,
    generationTaskId: options.generationTaskId || options.generation_task_id || null,
  });
  const now = new Date().toISOString();
  db.prepare('UPDATE redraw_assets SET mask_asset_id = ?, updated_at = ? WHERE id = ?')
    .run(Number(maskAssetId), now, Number(attempt.id));

  try {
    if (typeof ctx.provider !== 'function') throw codedError('REDRAW_ASSET_PROVIDER_REQUIRED', '缺少净景生成 provider');
    const providerResult = await ctx.provider({
      attempt,
      versionId: attempt.version_id,
      input: {
        ...sceneAsset,
        source_asset_id: sourceAssetId,
        mask_asset_id: Number(maskAssetId),
        input_frame_fingerprint: inputFrameFingerprint,
        model,
        prompt,
      },
    });
    const providerTaskId = providerResult?.provider_task_id || providerResult?.task_id;
    if (providerTaskId) {
      db.prepare('UPDATE redraw_assets SET generation_task_id = ?, updated_at = ? WHERE id = ?')
        .run(String(providerTaskId), new Date().toISOString(), Number(attempt.id));
    }
    const providerStatus = String(providerResult?.status || '').toLowerCase();
    if (!['completed', 'complete', 'succeeded', 'success', 'done'].includes(providerStatus)) {
      throw codedError('REDRAW_ASSET_GENERATION_FAILED', providerResult?.error || '净景生成失败');
    }
    validateCleanPlateQuality(sceneAsset, options, providerResult || {});
    const finalized = finalizeAssetAttempt(ctx, attempt.id, providerResult);
    db.prepare(`
      UPDATE redraw_assets
      SET clean_plate_asset_id = ?, mask_asset_id = ?, status = 'needs_attention',
          approval_status = 'pending', updated_at = ?
      WHERE id = ?
    `).run(Number(finalized.asset_id), Number(maskAssetId), new Date().toISOString(), Number(attempt.id));
    return rowToAsset(db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(attempt.id)));
  } catch (error) {
    const row = db.prepare('SELECT status FROM redraw_assets WHERE id = ?').get(Number(attempt.id));
    if (row?.status !== 'failed') {
      failAssetAttempt(ctx, attempt.id, error);
    }
    throw error;
  }
}

module.exports = {
  rowToAsset,
  listAssets,
  updateAsset,
  createAssetAttempt,
  finalizeAssetAttempt,
  failAssetAttempt,
  listAssetVersions,
  generateAsset,
  generateCleanPlate,
  readOwnedAuthorizationAsset,
  validateVoiceAuthorizationInput,
  validateVoiceTtsConfigPin,
  validateCleanPlateQuality,
  setDefaultEvidenceRegistry(registry) {
    defaultEvidenceRegistry = registry || null;
  },
};
