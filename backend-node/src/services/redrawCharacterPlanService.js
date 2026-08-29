const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { readIdentityPack, identityPackStatus } = require('./redrawCharacterIdentityService');

const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const SUPPORTED_AUDIO_MIME_TYPES = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/mp4']);

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

function parseSourceFacts(value) {
  try {
    const facts = JSON.parse(value || '');
    return facts && typeof facts === 'object' ? { facts, invalid: false } : { facts: {}, invalid: true };
  } catch (_) {
    return { facts: {}, invalid: true };
  }
}

function expectedCharacters(version) {
  const { facts, invalid } = parseSourceFacts(version.source_facts_json);
  const raw = Array.isArray(facts.characters)
    ? facts.characters
    : Array.isArray(facts.source_characters)
      ? facts.source_characters
      : null;
  const missing = [];
  if (invalid) missing.push('source_facts_invalid');
  if (!Array.isArray(raw) || raw.length === 0) {
    missing.push('source_characters_missing');
    return { characters: [], missing };
  }
  const characters = [];
  const keys = new Set();
  for (const item of raw) {
    const sourceName = String(item?.source_name ?? item?.display_name ?? item?.name ?? item?.source_character_name ?? '').trim();
    const character = {
      source_character_key: String(item?.source_character_key ?? item?.stable_id ?? item?.id ?? '').trim(),
      source_name: sourceName,
    };
    if (!character.source_character_key) {
      missing.push('source_character_key_missing');
      continue;
    }
    if (keys.has(character.source_character_key)) {
      missing.push(`${character.source_character_key}:source_duplicate_character_key`);
      continue;
    }
    keys.add(character.source_character_key);
    if (!character.source_name) {
      missing.push(`${character.source_character_key}:source_name_missing`);
    }
    characters.push(character);
  }
  return { characters, missing };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative);
}

function samePath(left, right) {
  const normalize = process.platform === 'win32'
    ? (value) => path.resolve(value).toLowerCase()
    : (value) => path.resolve(value);
  return normalize(left) === normalize(right);
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

function ownerContext(ctx) {
  return {
    tenantId: String(ctx.tenantId ?? ctx.tenant_id ?? ''),
    userId: String(ctx.userId ?? ctx.user_id ?? ''),
  };
}

function isOwnedRedrawLocalVoice(ctx, asset, expected = {}) {
  const owner = ownerContext(ctx);
  const metadata = parseJson(asset.metadata, {});
  const versionId = Number(expected.versionId ?? ctx.versionId ?? ctx.version_id);
  const voiceRedrawAssetId = Number(expected.voiceRedrawAssetId);
  if (asset.category !== 'redraw-local-voice'
    || metadata.source !== 'local_offline_tts'
    || String(metadata.tenant_id || '') !== owner.tenantId
    || String(metadata.user_id || '') !== owner.userId
    || Number(metadata.version_id) !== versionId
    || Number(metadata.voice_redraw_asset_id) !== voiceRedrawAssetId
    || String(metadata.audio_sha256 || '') !== String(expected.audioSha256 || '')) return false;
  const scope = ctx.db.prepare(`
    SELECT w.project_id
    FROM redraw_versions v
    JOIN redraw_works w
      ON w.id = v.work_id AND w.tenant_id = v.tenant_id AND w.user_id = v.user_id
     AND w.deleted_at IS NULL
    WHERE v.id = ? AND v.tenant_id = ? AND v.user_id = ? AND v.deleted_at IS NULL
  `).get(versionId, owner.tenantId, owner.userId);
  const registration = ctx.db.prepare(`
    SELECT id
    FROM redraw_local_voice_registrations
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND version_id = ?
      AND voice_redraw_asset_id = ? AND status = 'completed'
      AND audio_asset_id = ? AND audio_sha256 = ? AND deleted_at IS NULL
  `).get(
    Number(metadata.registration_id),
    owner.tenantId,
    owner.userId,
    versionId,
    voiceRedrawAssetId,
    Number(asset.id),
    String(expected.audioSha256 || ''),
  );
  return Boolean(scope && registration
    && Number(scope.project_id) === Number(asset.drama_id));
}

function assertOwnedAsset(ctx, assetId, kind, expected = {}) {
  const asset = ctx.db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(assetId));
  if (!asset || !readableAsset(ctx, asset)) return null;
  if (kind === 'wardrobe') {
    if (asset.type !== 'image' || !SUPPORTED_IMAGE_MIME_TYPES.has(String(asset.mime_type || '').toLowerCase())) return null;
  } else if (kind === 'voice') {
    if (asset.type !== 'audio' || !SUPPORTED_AUDIO_MIME_TYPES.has(String(asset.mime_type || '').toLowerCase())) return null;
  }
  if (kind === 'voice' && asset.category === 'redraw-local-voice') {
    if (!isOwnedRedrawLocalVoice(ctx, asset, expected)) return null;
  } else if (asset.drama_id != null) {
    const drama = ctx.db.prepare('SELECT tenant_id, user_id FROM dramas WHERE id = ? AND deleted_at IS NULL')
      .get(Number(asset.drama_id));
    const { tenantId, userId } = ownerContext(ctx);
    const owned = String(drama?.tenant_id ?? '') === tenantId
      && (!String(drama?.user_id ?? '') || String(drama?.user_id ?? '') === userId);
    if (!owned) return null;
  } else if (!trustedAssetOwnerHook(ctx, asset, ownerContext(ctx))) {
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
  let fd = null;
  try {
    const rootRealPath = fsApi.realpathSync(storageRoot);
    const candidate = path.resolve(rootRealPath, localPath);
    if (!isInside(rootRealPath, candidate)) return null;
    const realPathBefore = fsApi.realpathSync(candidate);
    if (!isInside(rootRealPath, realPathBefore)) return null;
    const constants = fsApi.constants || fs.constants;
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
    fd = fsApi.openSync(candidate, flags);
    const fdBefore = fsApi.fstatSync(fd);
    if (!fdBefore.isFile()) return null;
    const realPathAfter = fsApi.realpathSync(candidate);
    if (!samePath(realPathBefore, realPathAfter) || !isInside(rootRealPath, realPathAfter)) return null;
    if (!sameFileIdentity(fdBefore, fsApi.statSync(realPathAfter))) return null;
    const bytes = fsApi.readFileSync(fd);
    const fdAfter = fsApi.fstatSync(fd);
    const realPathFinal = fsApi.realpathSync(candidate);
    if (!samePath(realPathAfter, realPathFinal)
      || !sameOpenFileState(fdBefore, fdAfter)
      || !sameFileIdentity(fdAfter, fsApi.statSync(realPathFinal))) return null;
    return sha256(bytes);
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fsApi.closeSync(fd);
      } catch (_) {}
    }
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
  } else {
    const audioAsset = assertOwnedAsset(ctx, evidence.audio_asset_id, 'voice', {
      versionId: Number(version.id),
      voiceRedrawAssetId: Number(voiceRow.id),
      audioSha256: voice.sha256,
    });
    const digest = audioAsset ? fileSha256(ctx, audioAsset) : null;
    if (!digest) {
      missing.push(`${sourceKey}:voice_audio_unreadable`);
    } else if (digest !== voice.sha256) {
      missing.push(`${sourceKey}:voice_hash_drift`);
    } else {
      voice.sha256 = digest;
      voice.ready = true;
    }
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

  const sourceContract = expectedCharacters(version);
  const expected = sourceContract.characters;
  const expectedByKey = new Map(expected.map((item) => [item.source_character_key, item]));
  const rows = ctx.db.prepare(`
    SELECT * FROM redraw_assets
    WHERE version_id = ? AND tenant_id = ? AND user_id = ?
      AND kind = 'character' AND deleted_at IS NULL
    ORDER BY id ASC
  `).all(id, tenantId, userId);
  const rowsByKey = new Map();
  const missing = [...sourceContract.missing];
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
    const expectedItem = expectedByKey.get(key);
    const targetName = String(row.localized_name || pack?.target_actor_label || '').trim();
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
    if (!expectedItem) {
      missing.push(`${key}:unexpected_character`);
    } else if (!targetName
      || String(row.localized_name || '').trim() !== targetName
      || String(pack?.target_actor_label || '').trim() !== targetName) {
      missing.push(`${key}:target_name_mismatch`);
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
    throw codedError('REDRAW_CHARACTER_PLAN_NOT_READY', '整集角色计划未就绪', {
      missing: plan.missing,
      plan_hash: plan.plan_hash,
    });
  }
  return plan;
}

module.exports = {
  buildCharacterPlan,
  assertCharacterPlanReady,
};
