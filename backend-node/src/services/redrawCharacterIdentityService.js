const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 'target-actor-identity-v1';
const PERSONA_ORIGIN = 'fictional_ai_generated';
const TARGET_COUNTRY = 'US';
const WARDROBE_LABEL = '整集主服装';
const REQUIRED_VIEWS = ['front', 'profile', 'full_body'];
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeViews(value) {
  const values = Array.isArray(value) ? value : [];
  const selected = new Set(values.map((item) => String(item || '').trim().toLowerCase()));
  return REQUIRED_VIEWS.filter((view) => selected.has(view));
}

function sanitizeArtifact(value) {
  if (!value || typeof value !== 'object') return null;
  const assetId = Number(value.asset_id);
  const width = Number(value.width);
  const height = Number(value.height);
  const mimeType = String(value.mime_type || '').toLowerCase();
  const digest = String(value.sha256 || '').toLowerCase();
  if (!Number.isSafeInteger(assetId) || assetId <= 0
    || !Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0
    || !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)
    || !/^[0-9a-f]{64}$/.test(digest)) return null;
  return {
    asset_id: assetId,
    sha256: digest,
    width,
    height,
    mime_type: mimeType,
  };
}

function sanitizeWardrobe(value) {
  if (!value || typeof value !== 'object') return null;
  const assetId = Number(value.reference_asset_id);
  const digest = String(value.reference_sha256 || '').toLowerCase();
  if (!Number.isSafeInteger(assetId) || assetId <= 0 || !/^[0-9a-f]{64}$/.test(digest)) return null;
  return {
    label: WARDROBE_LABEL,
    reference_asset_id: assetId,
    reference_sha256: digest,
    consistency_confirmed: value.consistency_confirmed === true,
  };
}

function packFrom(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.identity_pack && typeof value.identity_pack === 'object') return value.identity_pack;
  if (value.source_ref_json !== undefined) {
    return parseJson(value.source_ref_json, {}).identity_pack || null;
  }
  return value;
}

function packCompleteness(pack) {
  const confirmedViews = normalizeViews(pack?.confirmed_views);
  const missingViews = REQUIRED_VIEWS.filter((view) => !confirmedViews.includes(view));
  const missingConfirmations = [];
  if (pack?.live_action_human_confirmed !== true) {
    missingConfirmations.push('live_action_human_confirmed');
  }
  if (pack?.adult_status !== 'verified_18_plus') {
    missingConfirmations.push('adult_status');
  }
  if (pack?.identity_consistency_confirmed !== true) {
    missingConfirmations.push('identity_consistency_confirmed');
  }
  const wardrobe = sanitizeWardrobe(pack?.wardrobe);
  if (!wardrobe || wardrobe.consistency_confirmed !== true) {
    missingConfirmations.push('wardrobe');
  }
  const validContract = pack?.schema_version === SCHEMA_VERSION
    && Boolean(String(pack?.source_character_key || '').trim())
    && sanitizeArtifact(pack?.artifact) !== null;
  return {
    ready: validContract && missingViews.length === 0 && missingConfirmations.length === 0,
    missing_views: missingViews,
    missing_confirmations: missingConfirmations,
  };
}

function identityPolicyFields(pack) {
  const personaOrigin = typeof pack?.persona_origin === 'string'
    ? pack.persona_origin.trim()
    : '';
  const targetCountry = typeof pack?.target_country === 'string'
    ? pack.target_country.trim()
    : '';
  return {
    ...(personaOrigin === PERSONA_ORIGIN ? { persona_origin: PERSONA_ORIGIN } : {}),
    ...(targetCountry === TARGET_COUNTRY ? { target_country: TARGET_COUNTRY } : {}),
  };
}

function canonicalPackFields(pack) {
  return {
    schema_version: pack?.schema_version === SCHEMA_VERSION ? SCHEMA_VERSION : String(pack?.schema_version || ''),
    source_character_key: String(pack?.source_character_key || '').trim(),
    target_actor_label: String(pack?.target_actor_label || '').trim(),
    artifact: sanitizeArtifact(pack?.artifact),
    confirmed_views: normalizeViews(pack?.confirmed_views),
    live_action_human_confirmed: pack?.live_action_human_confirmed === true,
    adult_status: pack?.adult_status === 'verified_18_plus' ? 'verified_18_plus' : null,
    identity_consistency_confirmed: pack?.identity_consistency_confirmed === true,
    wardrobe: sanitizeWardrobe(pack?.wardrobe),
    ready: packCompleteness(pack).ready,
    reviewed_by: String(pack?.reviewed_by || '').trim() || null,
    reviewed_at: String(pack?.reviewed_at || '').trim() || null,
    ...identityPolicyFields(pack),
  };
}

function canonicalPackHash(pack) {
  return sha256(stableJson(canonicalPackFields(pack)));
}

function identityPackStatus(rowOrPack) {
  const pack = packFrom(rowOrPack);
  const completeness = packCompleteness(pack);
  const storedHash = String(pack?.pack_sha256 || '');
  const hashValid = /^[0-9a-f]{64}$/.test(storedHash)
    && storedHash === canonicalPackHash(pack);
  return {
    has_identity_pack: Boolean(pack),
    ready: completeness.ready && hashValid,
    missing_views: completeness.missing_views,
    missing_confirmations: completeness.missing_confirmations,
    hash_valid: hashValid,
  };
}

function readIdentityPack(row) {
  const source = packFrom(row);
  if (!source) return null;
  const pack = {
    schema_version: source.schema_version === SCHEMA_VERSION ? SCHEMA_VERSION : String(source.schema_version || ''),
    source_character_key: String(source.source_character_key || '').trim(),
    target_actor_label: String(source.target_actor_label || '').trim(),
    artifact: sanitizeArtifact(source.artifact),
    confirmed_views: normalizeViews(source.confirmed_views),
    live_action_human_confirmed: source.live_action_human_confirmed === true,
    adult_status: source.adult_status === 'verified_18_plus' ? 'verified_18_plus' : null,
    identity_consistency_confirmed: source.identity_consistency_confirmed === true,
    wardrobe: sanitizeWardrobe(source.wardrobe),
    ready: false,
    pack_sha256: /^[0-9a-f]{64}$/.test(String(source.pack_sha256 || ''))
      ? String(source.pack_sha256)
      : null,
    reviewed_by: String(source.reviewed_by || '').trim() || null,
    reviewed_at: String(source.reviewed_at || '').trim() || null,
    ...identityPolicyFields(source),
  };
  pack.ready = identityPackStatus(pack).ready;
  return pack;
}

function normalizeContext(ctx = {}) {
  if (!ctx.db) throw codedError('REDRAW_IDENTITY_DB_REQUIRED', '缺少数据库');
  const tenantId = String(ctx.tenantId ?? ctx.tenant_id ?? '').trim();
  const userId = String(ctx.userId ?? ctx.user_id ?? '').trim();
  const versionId = Number(ctx.versionId ?? ctx.version_id);
  const storageRoot = String(ctx.storageRoot ?? ctx.storage_root ?? '').trim();
  if (!tenantId || !userId || !Number.isSafeInteger(versionId) || versionId <= 0) {
    throw codedError('REDRAW_IDENTITY_CONTEXT_INVALID', '身份包上下文无效');
  }
  if (!storageRoot) throw codedError('REDRAW_IDENTITY_STORAGE_REQUIRED', '缺少资产存储根目录');
  return { db: ctx.db, tenantId, userId, versionId, storageRoot };
}

function normalizeSourceKeyValue(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return '';
}

function sourceCharacterKey(row) {
  const payload = parseJson(row.source_ref_json, {});
  const sourceRef = payload.source_ref || payload.source || {};
  const normalized = [
    sourceRef.source_character_key,
    sourceRef.stable_id,
    sourceRef.id,
    sourceRef.source_character_id,
  ]
    .map(normalizeSourceKeyValue)
    .find(Boolean) || '';
  if (!normalized) {
    throw codedError('REDRAW_IDENTITY_SOURCE_KEY_REQUIRED', '角色来源缺少稳定身份键');
  }
  return normalized;
}

function samePath(left, right) {
  const normalize = process.platform === 'win32'
    ? (value) => path.resolve(value).toLowerCase()
    : (value) => path.resolve(value);
  return normalize(left) === normalize(right);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative);
}

function sameFileIdentity(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino;
}

function sameOpenFileState(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function trustedAssetOwnerHook(ctx, asset, owner) {
  return typeof ctx.assetReader?.owns === 'function'
    && ctx.assetReader.owns(asset, owner) === true;
}

function resolveArtifact(ctx, row) {
  const { db, storageRoot, tenantId, userId, versionId } = ctx;
  const providerAssetId = Number(row.asset_id);
  if (!Number.isSafeInteger(providerAssetId) || providerAssetId <= 0) {
    throw codedError('REDRAW_IDENTITY_ARTIFACT_INVALID', '角色身份图片无效');
  }
  const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(providerAssetId);
  const explicitCurrentLink = row.kind === 'character'
    && Number(row.version_id) === versionId
    && String(row.tenant_id || '') === tenantId
    && String(row.user_id || '') === userId
    && Number(row.asset_id) === providerAssetId;
  if (!explicitCurrentLink) {
    throw codedError('REDRAW_IDENTITY_ARTIFACT_NOT_OWNED', '角色身份图片不属于当前本地化角色');
  }
  if (asset?.drama_id != null) {
    const drama = db.prepare('SELECT tenant_id, user_id FROM dramas WHERE id = ? AND deleted_at IS NULL')
      .get(Number(asset.drama_id));
    const dramaTenantId = String(drama?.tenant_id ?? '').trim();
    const dramaUserId = String(drama?.user_id ?? '').trim();
    const owned = dramaTenantId
      ? dramaTenantId === tenantId && (!dramaUserId || dramaUserId === userId)
      : Boolean(dramaUserId) && dramaUserId === userId;
    if (!owned) {
      throw codedError('REDRAW_IDENTITY_ARTIFACT_NOT_OWNED', '角色身份图片不属于当前租户用户');
    }
  }
  const hookReadable = typeof ctx.assetReader?.canRead === 'function'
    ? ctx.assetReader.canRead(asset) === true
    : typeof ctx.canReadArtifact === 'function'
      ? ctx.canReadArtifact(providerAssetId) === true
      : true;
  if (!hookReadable) {
    throw codedError('REDRAW_IDENTITY_ARTIFACT_NOT_READABLE', '角色身份图片不可读取');
  }
  const mimeType = String(asset?.mime_type || '').trim().toLowerCase();
  const width = Number(asset?.width);
  const height = Number(asset?.height);
  if (!asset || asset.type !== 'image' || !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)
    || !Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0) {
    throw codedError('REDRAW_IDENTITY_ARTIFACT_INVALID', '角色身份资产必须是带有效尺寸的受支持图片');
  }

  const localPath = String(asset.local_path || '').trim();
  const portablePath = localPath.replace(/\\/g, '/');
  if (!localPath || path.posix.isAbsolute(localPath) || path.win32.isAbsolute(localPath) || portablePath === '.'
    || portablePath.split('/').includes('..')) {
    throw codedError('REDRAW_IDENTITY_ARTIFACT_PATH_INVALID', '角色身份图片路径无效');
  }

  const fsApi = ctx.fs || fs;
  let rootRealPath;
  try {
    rootRealPath = fsApi.realpathSync(storageRoot);
  } catch (_) {
    throw codedError('REDRAW_IDENTITY_ARTIFACT_NOT_READABLE', '资产存储根目录不可读取');
  }
  const candidatePath = path.resolve(rootRealPath, localPath);
  if (!isInside(rootRealPath, candidatePath)) {
    throw codedError('REDRAW_IDENTITY_ARTIFACT_PATH_INVALID', '角色身份图片必须位于资产存储目录内');
  }

  let realPathBefore;
  try {
    realPathBefore = fsApi.realpathSync(candidatePath);
  } catch (_) {
    throw codedError('REDRAW_IDENTITY_ARTIFACT_NOT_READABLE', '角色身份图片不可读取');
  }
  if (!isInside(rootRealPath, realPathBefore)) {
    throw codedError('REDRAW_IDENTITY_ARTIFACT_PATH_INVALID', '角色身份图片符号链接越界');
  }

  let fd = null;
  let bytes;
  try {
    const constants = fsApi.constants || fs.constants;
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
    fd = fsApi.openSync(candidatePath, flags);
    const fdBefore = fsApi.fstatSync(fd);
    if (!fdBefore.isFile()) {
      throw codedError('REDRAW_IDENTITY_ARTIFACT_NOT_READABLE', '角色身份资产不是可读文件');
    }
    const realPathAfter = fsApi.realpathSync(candidatePath);
    if (!samePath(realPathBefore, realPathAfter) || !isInside(rootRealPath, realPathAfter)) {
      throw codedError('REDRAW_IDENTITY_ARTIFACT_CHANGED', '角色身份图片路径在读取期间发生变化');
    }
    if (!sameFileIdentity(fdBefore, fsApi.statSync(realPathAfter))) {
      throw codedError('REDRAW_IDENTITY_ARTIFACT_CHANGED', '角色身份图片文件身份在读取期间发生变化');
    }
    bytes = fsApi.readFileSync(fd);
    const fdAfter = fsApi.fstatSync(fd);
    const realPathFinal = fsApi.realpathSync(candidatePath);
    if (!samePath(realPathAfter, realPathFinal)
      || !sameOpenFileState(fdBefore, fdAfter)
      || !sameFileIdentity(fdAfter, fsApi.statSync(realPathFinal))) {
      throw codedError('REDRAW_IDENTITY_ARTIFACT_CHANGED', '角色身份图片在读取期间发生变化');
    }
  } catch (error) {
    if (error?.code?.startsWith('REDRAW_IDENTITY_')) throw error;
    throw codedError('REDRAW_IDENTITY_ARTIFACT_NOT_READABLE', '角色身份图片不可读取');
  } finally {
    if (fd !== null) {
      try {
        fsApi.closeSync(fd);
      } catch (_) {
        throw codedError('REDRAW_IDENTITY_ARTIFACT_NOT_READABLE', '角色身份图片读取句柄关闭失败');
      }
    }
  }

  return {
    asset_id: providerAssetId,
    sha256: sha256(bytes),
    width,
    height,
    mime_type: mimeType,
  };
}

function resolveWardrobe(ctx, input = {}) {
  const { db, storageRoot, tenantId, userId } = ctx;
  const assetId = Number(
    input.wardrobe_reference_asset_id
      ?? input.wardrobeReferenceAssetId
      ?? input.wardrobe?.reference_asset_id
      ?? input.wardrobe?.referenceAssetId,
  );
  if (!Number.isSafeInteger(assetId) || assetId <= 0) return null;
  const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(assetId);
  if (asset?.drama_id == null) {
    if (!trustedAssetOwnerHook(ctx, asset, { tenantId, userId })) {
      throw codedError('REDRAW_IDENTITY_WARDROBE_NOT_OWNED', '角色服装参考图缺少可信归属绑定');
    }
  } else {
    const drama = db.prepare('SELECT tenant_id, user_id FROM dramas WHERE id = ? AND deleted_at IS NULL')
      .get(Number(asset.drama_id));
    const dramaTenantId = String(drama?.tenant_id ?? '').trim();
    const dramaUserId = String(drama?.user_id ?? '').trim();
    const owned = dramaTenantId
      ? dramaTenantId === tenantId && (!dramaUserId || dramaUserId === userId)
      : Boolean(dramaUserId) && dramaUserId === userId;
    if (!owned) {
      throw codedError('REDRAW_IDENTITY_WARDROBE_NOT_OWNED', '角色服装参考图不属于当前租户用户');
    }
  }
  const hookReadable = typeof ctx.assetReader?.canRead === 'function'
    ? ctx.assetReader.canRead(asset) === true
    : typeof ctx.canReadArtifact === 'function'
      ? ctx.canReadArtifact(assetId) === true
      : true;
  if (!hookReadable) {
    throw codedError('REDRAW_IDENTITY_WARDROBE_NOT_READABLE', '角色服装参考图不可读取');
  }
  const mimeType = String(asset?.mime_type || '').trim().toLowerCase();
  if (!asset || asset.type !== 'image' || !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw codedError('REDRAW_IDENTITY_WARDROBE_INVALID', '角色服装参考必须是受支持图片');
  }
  const localPath = String(asset.local_path || '').trim();
  const portablePath = localPath.replace(/\\/g, '/');
  if (!localPath || path.posix.isAbsolute(localPath) || path.win32.isAbsolute(localPath)
    || portablePath === '.' || portablePath.split('/').includes('..')) {
    throw codedError('REDRAW_IDENTITY_WARDROBE_PATH_INVALID', '角色服装参考路径无效');
  }
  const fsApi = ctx.fs || fs;
  let rootRealPath;
  try {
    rootRealPath = fsApi.realpathSync(storageRoot);
  } catch (_) {
    throw codedError('REDRAW_IDENTITY_WARDROBE_NOT_READABLE', '资产存储根目录不可读取');
  }
  const candidatePath = path.resolve(rootRealPath, localPath);
  if (!isInside(rootRealPath, candidatePath)) {
    throw codedError('REDRAW_IDENTITY_WARDROBE_PATH_INVALID', '角色服装参考必须位于资产存储目录内');
  }
  let realPath;
  try {
    realPath = fsApi.realpathSync(candidatePath);
  } catch (_) {
    throw codedError('REDRAW_IDENTITY_WARDROBE_NOT_READABLE', '角色服装参考图不可读取');
  }
  if (!isInside(rootRealPath, realPath)) {
    throw codedError('REDRAW_IDENTITY_WARDROBE_PATH_INVALID', '角色服装参考符号链接越界');
  }
  let fd = null;
  let bytes;
  try {
    const constants = fsApi.constants || fs.constants;
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
    fd = fsApi.openSync(candidatePath, flags);
    const fdBefore = fsApi.fstatSync(fd);
    if (!fdBefore.isFile()) {
      throw codedError('REDRAW_IDENTITY_WARDROBE_NOT_READABLE', '角色服装参考资产不是可读文件');
    }
    const realPathAfter = fsApi.realpathSync(candidatePath);
    if (!samePath(realPath, realPathAfter) || !isInside(rootRealPath, realPathAfter)) {
      throw codedError('REDRAW_IDENTITY_WARDROBE_CHANGED', '角色服装参考路径在读取期间发生变化');
    }
    if (!sameFileIdentity(fdBefore, fsApi.statSync(realPathAfter))) {
      throw codedError('REDRAW_IDENTITY_WARDROBE_CHANGED', '角色服装参考文件身份在读取期间发生变化');
    }
    bytes = fsApi.readFileSync(fd);
    const fdAfter = fsApi.fstatSync(fd);
    const realPathFinal = fsApi.realpathSync(candidatePath);
    if (!samePath(realPathAfter, realPathFinal)
      || !sameOpenFileState(fdBefore, fdAfter)
      || !sameFileIdentity(fdAfter, fsApi.statSync(realPathFinal))) {
      throw codedError('REDRAW_IDENTITY_WARDROBE_CHANGED', '角色服装参考图在读取期间发生变化');
    }
  } catch (error) {
    if (error?.code?.startsWith('REDRAW_IDENTITY_')) throw error;
    throw codedError('REDRAW_IDENTITY_WARDROBE_NOT_READABLE', '角色服装参考图不可读取');
  } finally {
    if (fd !== null) {
      try {
        fsApi.closeSync(fd);
      } catch (_) {
        throw codedError('REDRAW_IDENTITY_WARDROBE_NOT_READABLE', '角色服装参考图读取句柄关闭失败');
      }
    }
  }
  return {
    label: WARDROBE_LABEL,
    reference_asset_id: assetId,
    reference_sha256: sha256(bytes),
    consistency_confirmed: input.wardrobe_consistency_confirmed === true
      || input.wardrobeConsistencyConfirmed === true
      || input.wardrobe?.consistency_confirmed === true
      || input.wardrobe?.consistencyConfirmed === true,
  };
}

function nextServerTimestamp(ctx, previous) {
  const supplied = typeof ctx.now === 'function' ? ctx.now() : ctx.now;
  let next = new Date(supplied || Date.now());
  if (!Number.isFinite(next.getTime())) next = new Date();
  const previousTime = new Date(previous || 0).getTime();
  if (Number.isFinite(previousTime) && next.getTime() <= previousTime) {
    next = new Date(previousTime + 1);
  }
  return next.toISOString();
}

function projectSavedRow(row) {
  const payload = parseJson(row.source_ref_json, {});
  const identityPack = readIdentityPack(row);
  return {
    ...row,
    source_ref: payload.source_ref || payload.source || payload,
    identity_pack: identityPack,
    identity_pack_status: identityPackStatus(identityPack),
  };
}

function saveIdentityPack(ctx, assetId, input = {}) {
  const { db, tenantId, userId, versionId, storageRoot } = normalizeContext(ctx);
  const identityContext = { ...ctx, db, tenantId, userId, versionId, storageRoot };
  const id = Number(assetId);
  const expectedUpdatedAt = String(input.expected_updated_at ?? input.expectedUpdatedAt ?? '').trim();
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw codedError('REDRAW_IDENTITY_ASSET_NOT_FOUND', '角色资产不存在');
  }
  if (!expectedUpdatedAt) {
    throw codedError('REDRAW_IDENTITY_EXPECTED_UPDATED_AT_REQUIRED', '缺少身份包并发版本');
  }
  const row = db.prepare(`
    SELECT * FROM redraw_assets
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ? AND deleted_at IS NULL
  `).get(id, tenantId, userId, versionId);
  if (!row) throw codedError('REDRAW_IDENTITY_ASSET_NOT_FOUND', '角色资产不存在');
  if (row.kind !== 'character') {
    throw codedError('REDRAW_IDENTITY_ASSET_INVALID_KIND', '只有角色资产可以保存真人身份包');
  }
  if (String(row.updated_at || '') !== expectedUpdatedAt) {
    throw codedError('REDRAW_IDENTITY_CONFLICT', '角色资产已被其他操作更新');
  }

  const reviewedAt = nextServerTimestamp(ctx, row.updated_at);
  const identityPack = {
    schema_version: SCHEMA_VERSION,
    source_character_key: sourceCharacterKey(row),
    target_actor_label: String(input.target_actor_label ?? input.targetActorLabel ?? '').trim(),
    artifact: resolveArtifact(identityContext, row),
    confirmed_views: normalizeViews(input.confirmed_views ?? input.confirmedViews),
    live_action_human_confirmed: input.live_action_human_confirmed === true
      || input.liveActionHumanConfirmed === true,
    adult_status: input.adult_status === 'verified_18_plus'
      || input.adultStatus === 'verified_18_plus'
      ? 'verified_18_plus'
      : null,
    identity_consistency_confirmed: input.identity_consistency_confirmed === true
      || input.identityConsistencyConfirmed === true,
    wardrobe: resolveWardrobe(identityContext, input),
    ready: false,
    reviewed_by: userId,
    reviewed_at: reviewedAt,
    ...identityPolicyFields(input),
  };
  identityPack.ready = packCompleteness(identityPack).ready;
  identityPack.pack_sha256 = canonicalPackHash(identityPack);

  const sourcePayload = parseJson(row.source_ref_json, {});
  sourcePayload.identity_pack = identityPack;
  const updated = db.prepare(`
    UPDATE redraw_assets
    SET source_ref_json = ?, approval_status = 'pending', approved_by = NULL,
        approved_at = NULL, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ?
      AND kind = 'character' AND updated_at = ? AND deleted_at IS NULL
  `).run(
    JSON.stringify(sourcePayload),
    reviewedAt,
    id,
    tenantId,
    userId,
    versionId,
    expectedUpdatedAt,
  );
  if (updated.changes !== 1) {
    throw codedError('REDRAW_IDENTITY_CONFLICT', '角色资产已被其他操作更新');
  }
  return projectSavedRow(db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(id));
}

function identityBindingForAsset(row) {
  const pack = readIdentityPack(row);
  if (!pack || !identityPackStatus(pack).ready) return null;
  return {
    source_character_key: pack.source_character_key,
    target_actor_label: pack.target_actor_label,
    artifact: pack.artifact,
    pack_sha256: pack.pack_sha256,
    ready: true,
    ...identityPolicyFields(pack),
  };
}

module.exports = {
  readIdentityPack,
  identityPackStatus,
  saveIdentityPack,
  identityBindingForAsset,
};
