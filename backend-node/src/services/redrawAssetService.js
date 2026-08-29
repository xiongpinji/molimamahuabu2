const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const sharp = require('sharp');

const creditLedger = require('./creditLedgerService');
const aiConfigService = require('./aiConfigService');
const assetService = require('./assetService');
const {
  readIdentityPack,
  identityPackStatus,
} = require('./redrawCharacterIdentityService');
const { invalidateDialogueDependents } = require('./redrawDependencyInvalidationService');

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

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
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

function storedAssetEvidence(db, assetId) {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(assetId));
  const metadata = parseJson(asset?.metadata, {});
  const digest = String(metadata?.sha256 || asset?.sha256 || '').trim();
  if (!asset || asset.type !== 'image' || !/^\w+\/[-+.\w]+$/.test(String(asset.mime_type || ''))
    || !/^[a-f0-9]{64}$/.test(digest)) return null;
  return { asset_id: Number(asset.id), sha256: digest };
}

function buildCleanPlatePack(db, attempt, cleanPlateAssetId) {
  const payload = parseJson(attempt.source_ref_json, {});
  const ref = payload.source_ref && typeof payload.source_ref === 'object' ? payload.source_ref : {};
  const snapshot = payload.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot : {};
  const source = storedAssetEvidence(db, ref.source_asset_id);
  const mask = storedAssetEvidence(db, attempt.mask_asset_id);
  const artifact = storedAssetEvidence(db, cleanPlateAssetId);
  const stableId = String(ref.stable_id || '').trim();
  const analysisSha256 = String(ref.analysis_sha256 || '').trim();
  const frameIndex = Number(ref.frame_index);
  if (!source || !mask || !artifact || !stableId
    || !/^[a-f0-9]{64}$/.test(analysisSha256) || !Number.isSafeInteger(frameIndex) || frameIndex < 0
    || ref.source_fingerprint !== source.sha256) return null;
  if (snapshot.mode === 'clean_plate' && ref.kind === 'person_clean') {
    const pack = {
      schema_version: 'person-clean-plate-reference-v1',
      requirement_key: stableId,
      analysis_sha256: analysisSha256,
      frame_index: frameIndex,
      input_frame_fingerprint: String(snapshot.input_frame_fingerprint || ''),
      source,
      mask,
      artifact,
      ready: true,
    };
    if (pack.input_frame_fingerprint !== source.sha256) return null;
    return { key: 'person_clean_plate_pack', value: { ...pack, pack_sha256: sha256(stableJson(pack)) } };
  }
  if (snapshot.mode === 'text_clean_plate' && ['text_subtitle', 'text_screen'].includes(ref.kind)) {
    const work = db.prepare(`SELECT w.source_fingerprint FROM redraw_versions v
      JOIN redraw_works w ON w.id = v.work_id AND w.deleted_at IS NULL
      WHERE v.id = ? AND v.deleted_at IS NULL`).get(Number(attempt.version_id));
    const sourceFingerprint = String(work?.source_fingerprint || '').trim();
    if (!/^[a-f0-9]{64}$/.test(sourceFingerprint)) return null;
    const pack = {
      schema_version: 'text-clean-plate-reference-v1',
      region_key: stableId,
      kind: ref.kind,
      artifact,
      source_fingerprint: sourceFingerprint,
      analysis_sha256: analysisSha256,
      frame_index: frameIndex,
      input_frame_fingerprint: String(ref.source_fingerprint || ''),
      source,
      mask,
      ready: true,
    };
    return { key: 'text_clean_plate_pack', value: { ...pack, pack_sha256: sha256(stableJson(pack)) } };
  }
  return null;
}

function voiceDependencyKey(sourceRef = {}) {
  return String(
    sourceRef.source_character_key
      ?? sourceRef.sourceCharacterKey
      ?? sourceRef.speaker_id
      ?? sourceRef.speakerId
      ?? sourceRef.id
      ?? '',
  ).trim();
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

const CLEAN_PLATE_MEDIA_DEFAULTS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxPixels: 40 * 1000 * 1000,
  maxDimension: 8192,
});
const CLEAN_PLATE_IMAGE_FORMATS = Object.freeze({
  png: { mimeType: 'image/png', extension: 'png' },
  jpeg: { mimeType: 'image/jpeg', extension: 'jpg' },
  webp: { mimeType: 'image/webp', extension: 'webp' },
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cleanPlateMediaLimits(ctx = {}) {
  const supplied = ctx.cleanPlateMediaLimits || ctx.clean_plate_media_limits || {};
  const limits = {};
  for (const key of Object.keys(CLEAN_PLATE_MEDIA_DEFAULTS)) {
    const value = Number(supplied[key] ?? CLEAN_PLATE_MEDIA_DEFAULTS[key]);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw codedError('REDRAW_CLEAN_PLATE_MEDIA_LIMIT_INVALID', '净景媒体限制配置无效');
    }
    limits[key] = value;
  }
  return limits;
}

function assertCleanPlateRelativePath(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.includes('\0')) {
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_PATH_INVALID', '净景输出必须是单次目录内的相对路径');
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_PATH_INVALID', '净景输出不得使用绝对路径');
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized === '.' || normalized === '..'
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_PATH_INVALID', '净景输出路径超出单次目录');
  }
  return normalized;
}

function pathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!!relative && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertNoLinkedPath(rootReal, relativePath) {
  let current = rootReal;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (_) {
      throw codedError('REDRAW_CLEAN_PLATE_MEDIA_PATH_INVALID', '净景输出文件不存在');
    }
    if (stat.isSymbolicLink()) {
      throw codedError('REDRAW_CLEAN_PLATE_MEDIA_PATH_INVALID', '净景输出不得使用链接或 reparse');
    }
  }
}

async function secureReadCleanPlate(stagingRoot, relativePath, limits) {
  const normalized = assertCleanPlateRelativePath(relativePath);
  let rootReal;
  try {
    rootReal = await fsp.realpath(stagingRoot);
  } catch (_) {
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_PATH_INVALID', '净景单次目录不可读');
  }
  const target = path.resolve(rootReal, normalized);
  if (!pathInside(rootReal, target)) {
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_PATH_INVALID', '净景输出路径超出单次目录');
  }
  await assertNoLinkedPath(rootReal, normalized);
  let real;
  try {
    real = await fsp.realpath(target);
  } catch (_) {
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_PATH_INVALID', '净景输出文件不存在');
  }
  if (!pathInside(rootReal, real)) {
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_PATH_INVALID', '净景输出路径超出单次目录');
  }
  let handle;
  try {
    const expected = await fsp.stat(real, { bigint: true });
    if (!expected.isFile() || expected.size <= 0n || expected.size > BigInt(limits.maxBytes)) {
      throw codedError('REDRAW_CLEAN_PLATE_MEDIA_SIZE_INVALID', '净景输出文件大小不合法');
    }
    handle = await fsp.open(real, 'r');
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino
      || before.size !== expected.size || before.mtimeNs !== expected.mtimeNs || before.ctimeNs !== expected.ctimeNs) {
      throw codedError('REDRAW_CLEAN_PLATE_MEDIA_CHANGED', '净景输出在读取前发生变化');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw codedError('REDRAW_CLEAN_PLATE_MEDIA_CHANGED', '净景输出在读取中发生变化');
    }
    return { bytes, relativePath: normalized };
  } catch (error) {
    if (String(error?.code || '').startsWith('REDRAW_CLEAN_PLATE_MEDIA_')) throw error;
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_READ_FAILED', '净景输出文件不可读');
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

function magicImageFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return '';
}

async function inspectCleanPlateImage(file, providerResult, limits) {
  const magicFormat = magicImageFormat(file.bytes);
  const extension = path.posix.extname(file.relativePath).slice(1).toLowerCase();
  const extensionFormat = extension === 'jpg' || extension === 'jpeg' ? 'jpeg' : extension;
  if (!CLEAN_PLATE_IMAGE_FORMATS[magicFormat] || extensionFormat !== magicFormat) {
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_TYPE_INVALID', '净景输出图片 magic 与扩展名不一致');
  }
  let metadata;
  let decoded;
  try {
    const decoder = sharp(file.bytes, { limitInputPixels: limits.maxPixels, failOn: 'error' });
    metadata = await decoder.metadata();
    decoded = await decoder.clone().raw().toBuffer({ resolveWithObject: true });
  } catch (_) {
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_DECODE_INVALID', '净景输出图片解码失败');
  }
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  if (metadata.format !== magicFormat || decoded.info.width !== width || decoded.info.height !== height
    || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels) {
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_DIMENSIONS_INVALID', '净景输出图片尺寸或像素数不合法');
  }
  const format = CLEAN_PLATE_IMAGE_FORMATS[magicFormat];
  const declaredMime = String(providerResult?.quality?.mime_type ?? providerResult?.quality?.mimeType ?? '').trim().toLowerCase();
  if (declaredMime && declaredMime !== format.mimeType) {
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_TYPE_INVALID', '净景输出 MIME 与解码格式不一致');
  }
  const qualityWidth = Number(providerResult?.quality?.width);
  const qualityHeight = Number(providerResult?.quality?.height);
  if (qualityWidth !== width || qualityHeight !== height) {
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_DIMENSIONS_INVALID', '净景输出尺寸与供应商质量证据不一致');
  }
  return {
    ...file,
    width,
    height,
    mimeType: format.mimeType,
    extension: format.extension,
    sha256: crypto.createHash('sha256').update(file.bytes).digest('hex'),
  };
}

async function writeCleanPlateContentAddressed(storageRoot, image) {
  if (!storageRoot) {
    throw codedError('REDRAW_CLEAN_PLATE_REGISTRATION_UNKNOWN', '净景本地登记缺少存储根目录');
  }
  const root = path.resolve(String(storageRoot));
  await fsp.mkdir(root, { recursive: true });
  const rootReal = await fsp.realpath(root);
  const relativePath = path.posix.join('redraw-clean-plates', `${image.sha256}.${image.extension}`);
  const directory = path.join(rootReal, 'redraw-clean-plates');
  let directoryStat = null;
  try {
    directoryStat = await fsp.lstat(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (directoryStat?.isSymbolicLink()) {
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_PATH_INVALID', '净景存储目录不得使用链接或 reparse');
  }
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryReal = await fsp.realpath(directory);
  if (!pathInside(rootReal, directoryReal)) {
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_PATH_INVALID', '净景存储目录越界');
  }
  const destination = path.join(directoryReal, `${image.sha256}.${image.extension}`);
  let existing = null;
  try {
    const stat = await fsp.lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw codedError('REDRAW_CLEAN_PLATE_MEDIA_PATH_INVALID', '净景内容寻址目标不是普通文件');
    }
    existing = await fsp.readFile(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing) {
    const digest = crypto.createHash('sha256').update(existing).digest('hex');
    if (digest !== image.sha256) {
      throw codedError('REDRAW_CLEAN_PLATE_MEDIA_CHANGED', '净景内容寻址文件与 hash 不一致');
    }
    return { relativePath, absolutePath: destination, created: false };
  }
  const temporary = path.join(directoryReal, `.${image.sha256}.${crypto.randomUUID()}.tmp`);
  let handle;
  let created = false;
  try {
    handle = await fsp.open(temporary, 'wx', 0o600);
    await handle.writeFile(image.bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fsp.link(temporary, destination);
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const raced = await fsp.readFile(destination);
      if (crypto.createHash('sha256').update(raced).digest('hex') !== image.sha256) {
        throw codedError('REDRAW_CLEAN_PLATE_MEDIA_CHANGED', '净景内容寻址并发写入冲突');
      }
    }
    return { relativePath, absolutePath: destination, created };
  } finally {
    await handle?.close?.().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function registerLocalCleanPlate(ctx, providerResult, stagingRoot) {
  const output = providerResult?.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)
    || Object.keys(output).some((key) => key !== 'relative_path')) {
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_OUTPUT_INVALID', '净景输出合同不合法');
  }
  const limits = cleanPlateMediaLimits(ctx);
  const file = await secureReadCleanPlate(stagingRoot, output.relative_path, limits);
  const image = await inspectCleanPlateImage(file, providerResult, limits);
  let stored;
  try {
    stored = await writeCleanPlateContentAddressed(ctx.storageRoot || ctx.storage_root, image);
    const asset = ctx.db.transaction(() => assetService.create(ctx.db, null, {
      name: `clean plate ${image.sha256.slice(0, 12)}`,
      type: 'image',
      category: 'redraw',
      local_path: stored.relativePath,
      file_size: image.bytes.length,
      mime_type: image.mimeType,
      width: image.width,
      height: image.height,
      metadata: { sha256: image.sha256 },
    }))();
    return asset;
  } catch (error) {
    if (stored?.created) await fsp.rm(stored.absolutePath, { force: true }).catch(() => {});
    if (String(error?.code || '').startsWith('REDRAW_CLEAN_PLATE_MEDIA_')) throw error;
    throw codedError('REDRAW_CLEAN_PLATE_REGISTRATION_UNKNOWN', '净景文件登记结果未知');
  }
}

async function createCleanPlateStaging(ctx = {}) {
  const base = path.resolve(String(ctx.cleanPlateStagingRoot || ctx.clean_plate_staging_root
    || path.join(os.tmpdir(), 'moli-redraw-clean-staging')));
  await fsp.mkdir(base, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(base);
  if (stat.isSymbolicLink()) {
    throw codedError('REDRAW_CLEAN_PLATE_MEDIA_PATH_INVALID', '净景 staging 根目录不得使用链接或 reparse');
  }
  const staging = await fsp.mkdtemp(path.join(base, 'attempt-'));
  await fsp.chmod(staging, 0o700).catch(() => {});
  return staging;
}

const TEXT_CLEAN_KINDS = new Set(['text_subtitle', 'text_screen']);
const TEXT_CLEAN_REGION_SOURCES = new Set(['manual_fixture', 'ocr_region']);

function normalizeTextCleanShotId(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/^shot-?/, 'shot-');
  return normalized === 'shot-4' || normalized === 'shot-8' ? normalized : '';
}

function normalizeTextCleanPoint(point) {
  if (Array.isArray(point)) {
    if (point.length !== 2 || !point.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
    return [point[0], point[1]];
  }
  if (point && typeof point === 'object'
    && Object.keys(point).length === 2
    && typeof point.x === 'number' && Number.isFinite(point.x)
    && typeof point.y === 'number' && Number.isFinite(point.y)) {
    return { x: point.x, y: point.y };
  }
  return null;
}

function validateTextCleanPlateOptions(sceneAsset, options = {}) {
  if (options.region !== undefined) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', '文字净景不得混用 region 与 text_regions');
  }
  const textKind = String(options.textKind ?? options.text_kind ?? '').trim();
  if (!TEXT_CLEAN_KINDS.has(textKind)) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_TEXT_KIND_INVALID', '文字净景类型不在白名单');
  }
  const shotId = normalizeTextCleanShotId(sceneAsset.shotId ?? sceneAsset.shot_id);
  if (shotId) {
    const expected = shotId === 'shot-4' ? 'text_subtitle' : 'text_screen';
    if (textKind !== expected) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_TEXT_KIND_INVALID', '文字净景类型与镜头不匹配');
    }
  }
  if (options.textKind !== undefined && options.text_kind !== undefined
    && String(options.textKind) !== String(options.text_kind)) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_TEXT_KIND_INVALID', '文字净景类型重复且不一致');
  }
  if (options.textRegions !== undefined && options.text_regions !== undefined) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', '文字净景不得重复提供 text_regions');
  }
  const rawRegions = options.textRegions ?? options.text_regions;
  if (!Array.isArray(rawRegions) || rawRegions.length === 0) {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', '文字净景需要非空 text_regions');
  }
  const width = Number(sceneAsset.width ?? sceneAsset.source_width);
  const height = Number(sceneAsset.height ?? sceneAsset.source_height);
  const textRegions = rawRegions.map((region) => {
    if (!region || typeof region !== 'object' || Array.isArray(region)) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', '文字区域结构无效');
    }
    const allowed = new Set(['kind', 'shape', 'points', 'source']);
    if (Object.keys(region).some((key) => !allowed.has(key))) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', '文字区域包含未允许字段');
    }
    if (region.kind !== textKind || region.shape !== 'polygon' || !Array.isArray(region.points) || region.points.length < 3) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', '文字区域类型、形状或点集无效');
    }
    if (region.source !== undefined && !TEXT_CLEAN_REGION_SOURCES.has(region.source)) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', '文字区域来源不在脱敏白名单');
    }
    const points = region.points.map(normalizeTextCleanPoint);
    if (points.some((point) => !point)) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', '文字区域坐标必须是有限数字');
    }
    if (Number.isFinite(width) && Number.isFinite(height)
      && points.some((point) => {
        const x = Array.isArray(point) ? point[0] : point.x;
        const y = Array.isArray(point) ? point[1] : point.y;
        return x < 0 || x > width || y < 0 || y > height;
      })) {
      throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', '文字区域坐标超出图片边界');
    }
    let area = 0;
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      const currentX = Array.isArray(current) ? current[0] : current.x;
      const currentY = Array.isArray(current) ? current[1] : current.y;
      const nextX = Array.isArray(next) ? next[0] : next.x;
      const nextY = Array.isArray(next) ? next[1] : next.y;
      area += currentX * nextY - nextX * currentY;
    }
    if (area === 0) throw codedError('REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID', '文字区域面积必须大于零');
    return {
      kind: textKind,
      shape: 'polygon',
      points,
      ...(region.source !== undefined ? { source: region.source } : {}),
    };
  });
  return { textKind, textRegions };
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

function markCleanPlateNeedsAttention(ctx, attempt, value = {}, options = {}) {
  const now = new Date().toISOString();
  const sourcePayload = parseJson(attempt.source_ref_json, {});
  const rawProviderTaskId = String(
    value.provider_task_id || value.providerTaskId || value.task_id || value.taskId || '',
  ).trim();
  const providerTaskId = /^[A-Za-z0-9._:-]{1,160}$/.test(rawProviderTaskId) ? rawProviderTaskId : '';
  const snapshot = sourcePayload.snapshot && typeof sourcePayload.snapshot === 'object'
    ? sourcePayload.snapshot
    : {};
  const nextSourcePayload = {
    ...sourcePayload,
    snapshot: {
      ...snapshot,
      ...(providerTaskId ? { provider_task_id: providerTaskId } : {}),
      ...(options.providerCompleted ? { provider_completed: true } : {}),
    },
  };
  const errorCode = String(options.code || 'REDRAW_CLEAN_PLATE_PROVIDER_UNKNOWN');
  const errorMessage = String(options.message || '净景供应商任务状态未知，请人工确认');
  ctx.db.prepare(`
    UPDATE redraw_assets
    SET source_ref_json = ?, generation_task_id = COALESCE(?, generation_task_id),
        status = 'needs_attention', approval_status = 'pending',
        error_code = ?,
        error_message = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND kind = 'scene'
      AND status IN ('processing', 'needs_attention') AND deleted_at IS NULL
  `).run(
    JSON.stringify(nextSourcePayload),
    providerTaskId || null,
    errorCode,
    errorMessage,
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
    || !voiceId || (expectedVoiceId && voiceId !== expectedVoiceId)
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
    const sourceRef = sourcePayload.source_ref && typeof sourcePayload.source_ref === 'object'
      ? sourcePayload.source_ref
      : {};
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
        const dependencyKey = voiceDependencyKey(sourceRef);
        if (dependencyKey) {
          invalidateDialogueDependents({
            ...ctx,
            tenantId: String(attempt.tenant_id),
            userId: String(attempt.user_id),
            versionId: Number(attempt.version_id),
            now,
          }, {
            source_character_key: dependencyKey,
            reason_code: 'voice_changed',
          });
        }
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
  const mode = String(options.mode || 'clean_plate').trim();
  if (mode !== 'clean_plate' && mode !== 'text_clean_plate') {
    throw codedError('REDRAW_TEXT_CLEAN_PLATE_MODE_INVALID', '净景模式不受支持');
  }
  const maskAssetId = options.mask_asset_id ?? options.maskAssetId;
  if (!maskAssetId) throw codedError('CLEAN_PLATE_MASK_REQUIRED', '去人净景需要人物遮罩');
  const sourceAssetId = sceneAsset.source_asset_id
    ?? sceneAsset.sourceAssetId
    ?? sceneAsset.asset_id
    ?? sceneAsset.id;
  if (!sourceAssetId) throw codedError('CLEAN_PLATE_SOURCE_REQUIRED', '去人净景缺少源场景资产');
  const textClean = mode === 'text_clean_plate'
    ? validateTextCleanPlateOptions(sceneAsset, options)
    : null;
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
    ...(() => {
      const binding = sceneAsset.source_ref || sceneAsset.sourceRef || {};
      return {
        ...(binding.stable_id ? { stable_id: String(binding.stable_id) } : {}),
        ...(binding.kind ? { kind: String(binding.kind) } : {}),
        ...(binding.analysis_sha256 ? { analysis_sha256: String(binding.analysis_sha256) } : {}),
        ...(Number.isSafeInteger(Number(binding.frame_index)) ? { frame_index: Number(binding.frame_index) } : {}),
      };
    })(),
    ...(mode === 'clean_plate'
      ? { source_ref: sceneAsset.source_ref || sceneAsset.sourceRef || {} }
      : {
          text_kind: textClean.textKind,
          text_regions: textClean.textRegions,
        }),
  };
  const snapshot = mode === 'text_clean_plate'
    ? {
        mode,
        text_kind: textClean.textKind,
        text_regions: textClean.textRegions,
      }
    : {
        mode,
        source_asset_id: sourceAssetId,
        mask_asset_id: maskAssetId,
        input_frame_fingerprint: String(inputFrameFingerprint),
        model,
        prompt,
      };
  const attempt = createAssetAttempt({
    ...ctx,
    model,
    creditAmount: options.creditAmount ?? ctx.creditAmount,
    allowUnmaterializedDraft: true,
  }, {
    kind: 'scene',
    sourceRef,
    snapshot,
    prompt,
    generationTaskId: options.generationTaskId || options.generation_task_id || null,
  });
  const now = new Date().toISOString();
  db.prepare('UPDATE redraw_assets SET mask_asset_id = ?, updated_at = ? WHERE id = ?')
    .run(Number(maskAssetId), now, Number(attempt.id));

  let stagingRoot = null;
  try {
    if (typeof ctx.provider !== 'function') throw codedError('REDRAW_ASSET_PROVIDER_REQUIRED', '缺少净景生成 provider');
    stagingRoot = await createCleanPlateStaging(ctx);
    const trustedInput = deepFreeze({
      version_id: Number(ctx.versionId ?? ctx.version_id),
      kind: 'scene',
      mode,
      source_asset_id: Number(sourceAssetId),
      mask_asset_id: Number(maskAssetId),
      input_frame_fingerprint: String(inputFrameFingerprint),
      model,
      prompt,
      ...(sceneAsset.shot_id || sceneAsset.shotId
        ? { shot_id: String(sceneAsset.shot_id || sceneAsset.shotId) }
        : {}),
      ...(Number.isFinite(Number(sceneAsset.width ?? sceneAsset.source_width))
        ? { width: Number(sceneAsset.width ?? sceneAsset.source_width) }
        : {}),
      ...(Number.isFinite(Number(sceneAsset.height ?? sceneAsset.source_height))
        ? { height: Number(sceneAsset.height ?? sceneAsset.source_height) }
        : {}),
      ...(textClean ? {
        text_kind: textClean.textKind,
        text_regions: textClean.textRegions,
      } : {}),
    });
    const providerResult = await ctx.provider({
      outputDir: stagingRoot,
      input: trustedInput,
    });
    const providerTaskId = providerResult?.provider_task_id || providerResult?.task_id;
    if (providerTaskId) {
      db.prepare('UPDATE redraw_assets SET generation_task_id = ?, updated_at = ? WHERE id = ?')
        .run(String(providerTaskId), new Date().toISOString(), Number(attempt.id));
    }
    const providerStatus = String(providerResult?.status || '').toLowerCase();
    if (!['completed', 'complete', 'succeeded', 'success', 'done'].includes(providerStatus)) {
      if (indeterminateProviderOutcome(providerResult)) {
        return markCleanPlateNeedsAttention(ctx, {
          ...attempt,
          tenant_id: ctx.tenantId ?? ctx.tenant_id,
          user_id: ctx.userId ?? ctx.user_id,
          source_ref_json: db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = ?').get(attempt.id)?.source_ref_json,
        }, providerResult || {});
      }
      throw codedError('REDRAW_ASSET_GENERATION_FAILED', providerResult?.error || '净景生成失败');
    }
    validateCleanPlateQuality(sceneAsset, options, providerResult || {});
    let effectiveProviderResult = providerResult;
    if (providerResult?.output !== undefined) {
      try {
        const registered = await registerLocalCleanPlate(ctx, providerResult, stagingRoot);
        effectiveProviderResult = { ...providerResult, asset_id: Number(registered.id) };
      } catch (error) {
        if (error.code === 'REDRAW_CLEAN_PLATE_REGISTRATION_UNKNOWN') {
          return markCleanPlateNeedsAttention(ctx, {
            ...attempt,
            tenant_id: ctx.tenantId ?? ctx.tenant_id,
            user_id: ctx.userId ?? ctx.user_id,
            source_ref_json: db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = ?').get(attempt.id)?.source_ref_json,
          }, providerResult || {}, {
            code: error.code,
            message: '净景供应商已完成，但本地媒体登记结果未知，请人工确认',
            providerCompleted: true,
          });
        }
        throw error;
      }
    }
    const finalized = finalizeAssetAttempt(ctx, attempt.id, { ...effectiveProviderResult, clean_plate: true });
    const storedAttempt = db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(attempt.id));
    const pack = buildCleanPlatePack(db, storedAttempt, Number(finalized.clean_plate_asset_id || finalized.asset_id));
    const sourcePayload = parseJson(storedAttempt.source_ref_json, {});
    if (pack) sourcePayload[pack.key] = pack.value;
    try {
      db.prepare(`
        UPDATE redraw_assets
        SET clean_plate_asset_id = ?, mask_asset_id = ?, status = 'needs_attention',
            approval_status = 'pending', source_ref_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        Number(finalized.clean_plate_asset_id || finalized.asset_id), Number(maskAssetId),
        JSON.stringify(sourcePayload), new Date().toISOString(), Number(attempt.id),
      );
    } catch (_) {
      return markCleanPlateNeedsAttention(ctx, {
        ...storedAttempt,
        tenant_id: ctx.tenantId ?? ctx.tenant_id,
        user_id: ctx.userId ?? ctx.user_id,
      }, effectiveProviderResult || {}, {
        code: 'REDRAW_CLEAN_PLATE_REGISTRATION_UNKNOWN',
        message: '净景供应商已完成，但本地状态登记结果未知，请人工确认',
        providerCompleted: true,
      });
    }
    return rowToAsset(db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(Number(attempt.id)));
  } catch (error) {
    const row = db.prepare('SELECT status FROM redraw_assets WHERE id = ?').get(Number(attempt.id));
    if (row?.status === 'processing' && ambiguousVoiceError(error)) {
      return markCleanPlateNeedsAttention(ctx, {
        ...attempt,
        tenant_id: ctx.tenantId ?? ctx.tenant_id,
        user_id: ctx.userId ?? ctx.user_id,
        source_ref_json: db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = ?').get(attempt.id)?.source_ref_json,
      }, error);
    }
    if (row?.status !== 'failed') {
      failAssetAttempt(ctx, attempt.id, error);
    }
    throw error;
  } finally {
    if (stagingRoot) await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function prepareReferenceCleanRequirement(ctx, payload = {}) {
  const requirement = payload.requirement;
  if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) {
    throw codedError('REDRAW_REFERENCE_CLEAN_REQUIREMENT_INVALID', '净景准备要求不合法');
  }
  const kind = String(requirement.kind || '').trim();
  if (!['person_clean', 'text_clean'].includes(kind)) {
    throw codedError('REDRAW_REFERENCE_CLEAN_REQUIREMENT_INVALID', '净景准备类型不合法');
  }
  const sceneAsset = requirement.scene_asset || requirement.sceneAsset;
  const rawOptions = requirement.options;
  if (!sceneAsset || typeof sceneAsset !== 'object' || Array.isArray(sceneAsset)
    || !rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
    throw codedError('REDRAW_REFERENCE_CLEAN_REQUIREMENT_INVALID', '净景准备缺少服务端资产参数');
  }
  const result = await generateCleanPlate({
    ...ctx,
    provider: payload.provider || ctx.provider,
    operationKey: payload.operation_key || ctx.operationKey,
  }, sceneAsset, {
    ...rawOptions,
    mode: kind === 'text_clean' ? 'text_clean_plate' : 'clean_plate',
  });
  if (result.status === 'generated' && result.approval_status === 'approved') {
    return { status: 'completed', redraw_asset_id: Number(result.id) };
  }
  if (result.status === 'failed') {
    return { status: 'failed', error_code: result.error_code || 'REDRAW_REFERENCE_CLEAN_FAILED' };
  }
  return {
    status: 'unknown',
    redraw_asset_id: Number(result.id),
    ...(result.generation_task_id ? { provider_task_id: String(result.generation_task_id) } : {}),
    ...(result.credit_reservation_id ? { reservation_id: String(result.credit_reservation_id) } : {}),
  };
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
  prepareReferenceCleanRequirement,
  readOwnedAuthorizationAsset,
  validateVoiceAuthorizationInput,
  validateVoiceTtsConfigPin,
  validateCleanPlateQuality,
  setDefaultEvidenceRegistry(registry) {
    defaultEvidenceRegistry = registry || null;
  },
};
