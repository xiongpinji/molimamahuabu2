const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { readIdentityPack, identityPackStatus } = require('./redrawCharacterIdentityService');

const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
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

function sourceKeyFromPayload(payload = {}) {
  const sourceRef = payload.source_ref && typeof payload.source_ref === 'object'
    ? payload.source_ref
    : payload.source && typeof payload.source === 'object'
      ? payload.source
      : {};
  for (const value of [
    sourceRef.source_character_key,
    sourceRef.stable_id,
    sourceRef.id,
    sourceRef.source_character_id,
    sourceRef.character_id,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  }
  return '';
}

function expectedCharacters(version) {
  const facts = parseJson(version.source_facts_json, {});
  const raw = Array.isArray(facts.characters)
    ? facts.characters
    : Array.isArray(facts.source_characters)
      ? facts.source_characters
      : [];
  return raw.map((item) => ({
    source_character_key: String(item?.source_character_key ?? item?.stable_id ?? item?.id ?? '').trim(),
    target_name: String(item?.target_name ?? item?.localized_name ?? item?.name ?? '').trim(),
    adult_status: String(item?.adult_status ?? '').trim(),
    persona_origin: String(item?.persona_origin ?? '').trim(),
  })).filter((item) => item.source_character_key);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative);
}

function readableAsset(ctx, asset) {
  if (typeof ctx.assetReader?.canRead === 'function') return ctx.assetReader.canRead(asset) === true;
  if (typeof ctx.canReadAsset === 'function') return ctx.canReadAsset(asset) === true;
  if (typeof ctx.canReadArtifact === 'function') return ctx.canReadArtifact(asset?.id) === true;
  return true;
}

function trustedAssetOwnerHook(ctx, asset, owner) {
  return typeof ctx.assetReader?.owns === 'function'
    && ctx.assetReader.owns(asset, owner) === true;
}

function assertOwnedAsset(ctx, assetId, kind) {
  const asset = ctx.db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(assetId));
  if (!asset || !readableAsset(ctx, asset)) return null;
  if (kind === 'wardrobe') {
    if (asset.type !== 'image' || !SUPPORTED_IMAGE_MIME_TYPES.has(String(asset.mime_type || '').toLowerCase())) return null;
  }
  if (asset.drama_id != null) {
    const drama = ctx.db.prepare('SELECT tenant_id, user_id FROM dramas WHERE id = ? AND deleted_at IS NULL')
      .get(Number(asset.drama_id));
    const tenantId = String(ctx.tenantId ?? ctx.tenant_id ?? '');
    const userId = String(ctx.userId ?? ctx.user_id ?? '');
    const owned = String(drama?.tenant_id ?? '') === tenantId
      && (!String(drama?.user_id ?? '') || String(drama?.user_id ?? '') === userId);
    if (!owned) return null;
  } else if (kind === 'wardrobe' && !trustedAssetOwnerHook(ctx, asset, {
    tenantId: String(ctx.tenantId ?? ctx.tenant_id ?? ''),
    userId: String(ctx.userId ?? ctx.user_id ?? ''),
  })) {
    return null;
  }
  return asset;
}

function fileSha256(ctx, asset) {
  const storageRoot = String(ctx.storageRoot ?? ctx.storage_root ?? '').trim();
  const localPath = String(asset?.local_path || '').trim();
  if (!storageRoot || !localPath) return null;
  const portablePath = localPath.replace(/\\/g, '/');
  if (path.posix.isAbsolute(localPath) || path.win32.isAbsolute(localPath)
    || portablePath === '.' || portablePath.split('/').includes('..')) return null;
  const fsApi = ctx.fs || fs;
  try {
    const rootRealPath = fsApi.realpathSync(storageRoot);
    const candidate = path.resolve(rootRealPath, localPath);
    const realPath = fsApi.realpathSync(candidate);
    if (!isInside(rootRealPath, realPath)) return null;
    return sha256(fsApi.readFileSync(realPath));
  } catch (_) {
    return null;
  }
}

function normalizeEvidence(value = {}) {
  return {
    locale: String(value.locale || ''),
    market: String(value.market || ''),
    audio_sha256: String(value.audio_sha256 || value.audioSha256 || ''),
    audio_asset_id: Number(value.audio_asset_id ?? value.audioAssetId),
    language_verified: value.language_verified === true,
    detected_locale: String(value.detected_locale || value.detectedLocale || ''),
  };
}

function voiceForCharacter(ctx, version, row, sourceKey, missing) {
  const payload = parseJson(row.source_ref_json, {});
  const evidence = normalizeEvidence(payload.snapshot?.voice_snapshot);
  const voice = {
    asset_id: Number.isSafeInteger(evidence.audio_asset_id) ? evidence.audio_asset_id : null,
    language: evidence.locale || '',
    sha256: /^[0-9a-f]{64}$/.test(evidence.audio_sha256) ? evidence.audio_sha256 : '',
    ready: false,
  };
  const voiceRow = ctx.db.prepare(`
    SELECT * FROM redraw_assets
    WHERE version_id = ? AND tenant_id = ? AND user_id = ?
      AND kind = 'voice' AND status = 'generated' AND voice_asset_id = ?
      AND deleted_at IS NULL
    ORDER BY id DESC
  `).get(Number(version.id), String(version.tenant_id), String(version.user_id), voice.asset_id || 0);
  const voicePayload = parseJson(voiceRow?.source_ref_json, {});
  const voiceSourceKey = sourceKeyFromPayload(voicePayload);
  if (!voiceRow || voiceSourceKey !== sourceKey) missing.push(`${sourceKey}:voice_missing`);
  else if (String(voiceRow.approval_status) !== 'approved') missing.push(`${sourceKey}:voice_not_approved`);
  else if (evidence.locale !== String(version.locale)
    || (version.market && evidence.market !== String(version.market))
    || !evidence.language_verified
    || evidence.detected_locale !== evidence.locale) {
    missing.push(`${sourceKey}:voice_language_mismatch`);
  } else if (!assertOwnedAsset(ctx, evidence.audio_asset_id, 'voice')) {
    missing.push(`${sourceKey}:voice_audio_unreadable`);
  } else {
    voice.ready = true;
  }
  return voice;
}

function wardrobeForCharacter(ctx, sourceKey, pack, missing) {
  const wardrobe = pack?.wardrobe || null;
  const output = {
    label: '整集主服装',
    asset_id: Number(wardrobe?.reference_asset_id) || null,
    sha256: String(wardrobe?.reference_sha256 || ''),
    ready: false,
  };
  if (!wardrobe || !output.asset_id) {
    missing.push(`${sourceKey}:wardrobe_missing_reference`);
    return output;
  }
  const asset = assertOwnedAsset(ctx, output.asset_id, 'wardrobe');
  if (!asset) {
    missing.push(`${sourceKey}:wardrobe_missing_reference`);
    return output;
  }
  const digest = fileSha256(ctx, asset);
  if (!digest || digest !== output.sha256 || wardrobe.consistency_confirmed !== true) {
    missing.push(`${sourceKey}:wardrobe_hash_drift`);
    return output;
  }
  output.ready = true;
  return output;
}

function buildCharacterPlan(ctx = {}, versionId) {
  if (!ctx.db) throw codedError('REDRAW_CHARACTER_PLAN_DB_REQUIRED', '缺少数据库');
  const id = Number(versionId);
  const tenantId = String(ctx.tenantId ?? ctx.tenant_id ?? '').trim();
  const userId = String(ctx.userId ?? ctx.user_id ?? '').trim();
  const version = ctx.db.prepare(`
    SELECT * FROM redraw_versions
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(id, tenantId, userId);
  if (!version) throw codedError('REDRAW_VERSION_NOT_FOUND', '本地化版本不存在');

  const expected = expectedCharacters(version);
  const expectedByKey = new Map(expected.map((item) => [item.source_character_key, item]));
  const rows = ctx.db.prepare(`
    SELECT * FROM redraw_assets
    WHERE version_id = ? AND tenant_id = ? AND user_id = ?
      AND kind = 'character' AND deleted_at IS NULL
    ORDER BY id ASC
  `).all(id, tenantId, userId);
  const rowsByKey = new Map();
  const missing = [];
  for (const row of rows) {
    const key = sourceKeyFromPayload(parseJson(row.source_ref_json, {}));
    if (!key) continue;
    if (rowsByKey.has(key)) missing.push(`${key}:duplicate_source_character_key`);
    else rowsByKey.set(key, row);
  }
  for (const item of expected) {
    if (!rowsByKey.has(item.source_character_key)) missing.push(`${item.source_character_key}:missing_character`);
  }

  const targetNames = new Map();
  const packHashes = new Map();
  const characters = [];
  const keys = Array.from(new Set([...expectedByKey.keys(), ...rowsByKey.keys()])).sort();
  for (const key of keys) {
    const row = rowsByKey.get(key);
    if (!row) continue;
    const pack = readIdentityPack(row);
    const status = identityPackStatus(pack);
    const targetName = String(row.localized_name || pack?.target_actor_label || expectedByKey.get(key)?.target_name || '').trim();
    if (targetName) {
      const normalized = targetName.toLowerCase();
      if (targetNames.has(normalized)) missing.push(`${key}:duplicate_target_name`);
      else targetNames.set(normalized, key);
    }
    if (!pack || !status.ready) missing.push(`${key}:identity_not_ready`);
    if (pack?.source_character_key !== key) missing.push(`${key}:identity_source_mismatch`);
    if (pack?.pack_sha256) {
      if (packHashes.has(pack.pack_sha256)) missing.push(`${key}:identity_pack_reused`);
      else packHashes.set(pack.pack_sha256, key);
    }
    if (pack?.adult_status !== 'verified_18_plus') missing.push(`${key}:age_not_adult`);
    if (pack?.persona_origin !== 'fictional_ai_generated') missing.push(`${key}:persona_not_fictional_ai`);
    const expectedItem = expectedByKey.get(key);
    if (expectedItem?.adult_status !== 'verified_18_plus') missing.push(`${key}:source_age_not_adult`);
    if (expectedItem?.persona_origin !== 'fictional_ai_generated') {
      missing.push(`${key}:source_persona_not_fictional_ai`);
    }
    const voice = voiceForCharacter(ctx, version, row, key, missing);
    const wardrobe = wardrobeForCharacter(ctx, key, pack, missing);
    characters.push({
      source_character_key: key,
      target_name: targetName,
      identity_pack_sha256: pack?.pack_sha256 || '',
      adult_status: pack?.adult_status || '',
      voice,
      wardrobe,
    });
  }
  const uniqueMissing = Array.from(new Set(missing)).sort();
  const ready = uniqueMissing.length === 0 && characters.length > 0
    && characters.every((item) => item.voice.ready && item.wardrobe.ready && item.identity_pack_sha256);
  const body = {
    version_id: id,
    ready,
    missing: uniqueMissing,
    characters: characters.sort((left, right) => left.source_character_key.localeCompare(right.source_character_key)),
  };
  return { ...body, plan_hash: sha256(stableJson(body)) };
}

function assertCharacterPlanReady(ctx, versionId) {
  const plan = buildCharacterPlan(ctx, versionId);
  if (!plan.ready) {
    throw codedError('REDRAW_CHARACTER_PLAN_NOT_READY', '整集角色计划未就绪', { missing: plan.missing, plan });
  }
  return plan;
}

module.exports = {
  buildCharacterPlan,
  assertCharacterPlanReady,
};
