'use strict';

const { createHash } = require('node:crypto');

const HEX_64 = /^[a-f0-9]{64}$/;
const UNSAFE_CONTRACT_KEY = /(?:^|_)(?:api_?key|access_?key|secret|token|password|credential|provider|model|prompt|raw|url|path)(?:_|$)/i;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function parseJson(value, fallback, label) {
  if (value == null || value === '') return clone(fallback);
  if (value && typeof value === 'object') return clone(value);
  try {
    return JSON.parse(String(value));
  } catch (_) {
    throw codedError('REDRAW_PRODUCTION_PACK_STALE', `${label} invalid`);
  }
}

function requiredHash(value, label) {
  const hash = String(value || '').trim();
  if (!HEX_64.test(hash)) throw codedError('REDRAW_PRODUCTION_PACK_STALE', `${label} invalid`);
  return hash;
}

function productionPackHash(pack) {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    throw codedError('REDRAW_PRODUCTION_PACK_STALE', 'production pack invalid');
  }
  const value = clone(pack);
  delete value.production_pack_hash;
  return sha256(stableStringify(value));
}

function sourceCharacterKey(asset) {
  const direct = asset?.source_character_key ?? asset?.stable_id;
  if (direct) return String(direct);
  const sourceRef = parseJson(asset?.source_ref_json, {}, 'asset source_ref_json');
  return String(sourceRef?.source_ref?.stable_id || sourceRef?.stable_id || '');
}

function sanitizeAsset(asset) {
  const result = { kind: String(asset?.kind || 'asset') };
  for (const field of ['asset_id', 'voice_asset_id', 'clean_plate_asset_id', 'mask_asset_id']) {
    const id = Number(asset?.[field]);
    if (Number.isSafeInteger(id) && id > 0) result[field] = id;
  }
  for (const field of ['sha256', 'identity_pack_sha256', 'reference_sha256']) {
    const hash = String(asset?.[field] || '').trim().toLowerCase();
    if (HEX_64.test(hash)) result[field] = hash;
  }
  return result;
}

function sanitizeReference(reference) {
  const result = {};
  for (const field of ['kind', 'anchor', 'stable_id', 'character_id', 'source_character_key', 'target_actor_label']) {
    const value = reference?.[field];
    if (typeof value === 'string' && value.trim()) result[field] = value.trim();
  }
  for (const field of ['asset_id', 'redraw_asset_id', 'voice_asset_id', 'clean_plate_asset_id', 'mask_asset_id']) {
    const value = Number(reference?.[field]);
    if (Number.isSafeInteger(value) && value > 0) result[field] = value;
  }
  for (const field of ['sha256', 'identity_pack_sha256', 'reference_sha256', 'coverage_sha256']) {
    const value = String(reference?.[field] || '').trim().toLowerCase();
    if (HEX_64.test(value)) result[field] = value;
  }
  return result;
}

function sanitizeContract(value) {
  if (Array.isArray(value)) return value.map(sanitizeContract);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !UNSAFE_CONTRACT_KEY.test(key))
    .map(([key, item]) => [key, sanitizeContract(item)]));
}

function valuesForShot(value, shotId) {
  if (Array.isArray(value)) {
    return value.filter((item) => !item?.shot_id || String(item.shot_id) === String(shotId));
  }
  if (!value || typeof value !== 'object') return [];
  const selected = value[shotId];
  if (Array.isArray(selected)) return selected;
  return selected && typeof selected === 'object' ? [selected] : [];
}

function localizeVisualText(value, blueprint, localization) {
  let text = String(value || '').trim();
  const replacements = (Array.isArray(blueprint.characters) ? blueprint.characters : [])
    .map((character) => ({
      source: String(character?.source_name || character?.display_name || '').trim(),
      target: String(localization.character_name_map?.[character?.id] || '').trim(),
    }))
    .filter((item) => item.source && item.target && item.source !== item.target)
    .sort((left, right) => right.source.length - left.source.length);
  for (const { source, target } of replacements) text = text.split(source).join(target);
  return text;
}

function dialogueForShot(localization, shotId) {
  return (Array.isArray(localization.dialogue_map) ? localization.dialogue_map : [])
    .filter((turn) => String(turn?.shot_id || '') === String(shotId))
    .map((turn) => ({
      id: String(turn.source_dialogue_id || ''),
      speaker_id: String(turn.speaker_id || ''),
      speaker_kind: String(turn.speaker_kind || 'character'),
      speaker_name: String(localization.character_name_map?.[turn.speaker_id] || turn.speaker_id || ''),
      text: String(turn.target_text || ''),
      start_ms: Number(turn.start_ms),
      end_ms: Number(turn.end_ms),
      emotion: String(turn.emotion || ''),
      pronunciation_hint: String(turn.pronunciation_hint || ''),
    }));
}

function textRegionsForShot(localization, shotId) {
  return (Array.isArray(localization.text_region_map) ? localization.text_region_map : [])
    .filter((region) => String(region?.shot_id || '') === String(shotId))
    .map((region) => ({
      id: String(region.text_region_id || ''),
      text: String(region.target_text || ''),
    }));
}

function characterIdsForShot(shot, dialogue, references) {
  const ids = new Set();
  for (const item of [...(shot.visible_character_ids || []), ...(shot.character_ids || []), ...(shot.characters || [])]) {
    const id = typeof item === 'string' ? item : item?.id;
    if (id) ids.add(String(id));
  }
  for (const turn of dialogue) if (turn.speaker_id) ids.add(turn.speaker_id);
  for (const reference of references) {
    const id = reference.source_character_key || reference.character_id;
    if (id) ids.add(String(id));
  }
  return [...ids].sort();
}

function buildPrompt(pack) {
  const visual = pack.visual_contract;
  const lines = [
    `Shot ${pack.shot_id}; duration ${pack.duration_ms}ms.`,
    `Composition: ${visual.composition || 'preserve locked composition'}.`,
    `Camera: ${visual.camera_movement || 'preserve locked camera movement'}.`,
    `Opening: ${visual.opening_state || 'preserve locked opening state'}.`,
    `Action: ${visual.continuous_action || 'preserve locked continuous action'}.`,
    `Ending: ${visual.ending_state || 'preserve locked ending state'}.`,
  ];
  if (pack.characters.length) lines.push(`Characters: ${pack.characters.map((item) => item.name).join(', ')}.`);
  if (pack.dialogue.length) lines.push(`Dialogue: ${pack.dialogue.map((item) => `${item.speaker_name}: ${item.text}`).join(' ')}`);
  if (visual.text_regions.length) lines.push(`On-screen text: ${visual.text_regions.map((item) => item.text).join('; ')}.`);
  lines.push(`Audio locale: ${pack.audio_contract.locale || 'none'}.`);
  return lines.join('\n');
}

function assertPromptUsesTargetText(prompt, blueprint, localization) {
  if (!String(localization.locale || '').toLowerCase().startsWith('en')) return;
  const sourceTokens = [];
  for (const character of Array.isArray(blueprint.characters) ? blueprint.characters : []) {
    const source = String(character?.source_name || character?.display_name || '').trim();
    const target = String(localization.character_name_map?.[character?.id] || '').trim();
    if (source && source !== target) sourceTokens.push(source);
  }
  for (const shot of Array.isArray(blueprint.shots) ? blueprint.shots : []) {
    for (const turn of Array.isArray(shot.dialogue) ? shot.dialogue : []) {
      const source = String(turn?.source_text || turn?.text || '').trim();
      if (source) sourceTokens.push(source);
    }
    for (const region of Array.isArray(shot.text_regions) ? shot.text_regions : []) {
      const source = String(region?.source_text || '').trim();
      if (source) sourceTokens.push(source);
    }
  }
  if (sourceTokens.some((token) => prompt.includes(token))) {
    throw codedError('REDRAW_PRODUCTION_PACK_SOURCE_TEXT_REMAINS', 'production prompt contains source identity or dialogue');
  }
}

function compileShotProductionPack(input = {}) {
  const blueprint = input.blueprint || {};
  const localization = input.localization || {};
  const shotInput = input.shot || {};
  const shotId = String(shotInput.shot_id || shotInput.id || '').trim();
  const shot = (Array.isArray(blueprint.shots) ? blueprint.shots : [])
    .find((item) => String(item?.id || '') === shotId);
  if (!shotId || !shot) throw codedError('REDRAW_PRODUCTION_PACK_STALE', 'shot does not match locked blueprint');
  const blueprintHash = requiredHash(input.blueprintHash || input.blueprint_hash || blueprint.blueprint_hash, 'blueprint_hash');
  const localizationHash = requiredHash(input.localizationHash || input.localization_hash || localization.localization_hash, 'localization_hash');
  const startMs = Number(shot.start_ms);
  const endMs = Number(shot.end_ms);
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs) {
    throw codedError('REDRAW_PRODUCTION_PACK_STALE', 'shot timing invalid');
  }
  const references = valuesForShot(
    input.references ?? parseJson(shotInput.references_json, [], 'references_json'),
    shotId,
  ).map(sanitizeReference);
  const assets = (Array.isArray(input.assets) ? input.assets : []).map((asset) => ({
    source_character_key: sourceCharacterKey(asset),
    value: sanitizeAsset(asset),
  }));
  const dialogue = dialogueForShot(localization, shotId);
  const characterById = new Map((Array.isArray(blueprint.characters) ? blueprint.characters : [])
    .map((character) => [String(character?.id || ''), character]));
  const characters = characterIdsForShot(shot, dialogue, references).map((id) => {
    const character = characterById.get(id) || {};
    const name = String(localization.character_name_map?.[id] || '').trim();
    if (!name) throw codedError('REDRAW_PRODUCTION_PACK_STALE', 'localized character mapping missing');
    return {
      id,
      name,
      kind: dialogue.find((turn) => turn.speaker_id === id)?.speaker_kind || character.kind || 'character',
      assets: assets.filter((asset) => asset.source_character_key === id).map((asset) => asset.value),
    };
  });
  const referenceBundle = input.referenceBundle ?? input.reference_bundle;
  const selectedBundle = valuesForShot(referenceBundle, shotId)[0] || {};
  const pack = {
    schema_version: 'redraw-shot-production-pack-v1',
    shot_id: shotId,
    start_ms: startMs,
    end_ms: endMs,
    duration_ms: endMs - startMs,
    blueprint_hash: blueprintHash,
    localization_hash: localizationHash,
    characters,
    dialogue,
    visual_contract: {
      composition: localizeVisualText(shot.composition, blueprint, localization),
      camera_movement: localizeVisualText(shot.camera_movement, blueprint, localization),
      opening_state: localizeVisualText(shot.opening_state, blueprint, localization),
      continuous_action: localizeVisualText(shot.continuous_action, blueprint, localization),
      ending_state: localizeVisualText(shot.ending_state, blueprint, localization),
      text_regions: textRegionsForShot(localization, shotId),
      assets: assets.map((asset) => asset.value),
      references,
      reference_bundle: sanitizeContract(selectedBundle),
    },
    audio_contract: {
      locale: String(localization.locale || ''),
      market: String(localization.market || ''),
      source: sanitizeContract(shot.audio_contract || {}),
      speech_required: dialogue.length > 0,
    },
    prompt: '',
  };
  pack.prompt = buildPrompt(pack);
  assertPromptUsesTargetText(pack.prompt, blueprint, localization);
  pack.production_pack_hash = productionPackHash(pack);
  return pack;
}

function compileEpisodeProductionPacks(input = {}) {
  const blueprint = input.blueprint || {};
  const localization = input.localization || {};
  if (blueprint.schema_version !== 'episode-blueprint-v1' || blueprint.review?.status !== 'locked') {
    throw codedError('REDRAW_BLUEPRINT_NOT_LOCKED', 'locked episode blueprint required');
  }
  if (localization.schema_version !== 'episode-localization-v1' || localization.review?.status !== 'locked') {
    throw codedError('REDRAW_LOCALIZATION_NOT_LOCKED', 'locked episode localization required');
  }
  const blueprintHash = requiredHash(blueprint.blueprint_hash, 'blueprint_hash');
  const localizationHash = requiredHash(localization.localization_hash, 'localization_hash');
  if (String(localization.blueprint_hash || '') !== blueprintHash || !Array.isArray(blueprint.shots)) {
    throw codedError('REDRAW_PRODUCTION_PACK_STALE', 'blueprint/localization binding invalid');
  }
  return blueprint.shots.map((shot) => compileShotProductionPack({
    ...input,
    shot,
    blueprintHash,
    localizationHash,
  }));
}

function loadLockedEpisodeContext(db, owner, versionId) {
  const version = db.prepare(`SELECT * FROM redraw_versions
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1`)
    .get(Number(versionId), String(owner.tenantId), String(owner.userId));
  if (!version) throw codedError('REDRAW_PRODUCTION_PACK_STALE', 'owned version missing');
  const blueprintRow = db.prepare(`SELECT * FROM redraw_episode_blueprints
    WHERE work_id = ? AND tenant_id = ? AND user_id = ? AND revision = ?
    ORDER BY id DESC LIMIT 1`)
    .get(Number(version.work_id), String(owner.tenantId), String(owner.userId), Number(version.version));
  const blueprint = parseJson(blueprintRow?.blueprint_json, null, 'blueprint_json');
  const localization = parseJson(version.localization_review_json, null, 'localization_review_json');
  const blueprintHash = requiredHash(version.blueprint_hash, 'blueprint_hash');
  const localizationHash = requiredHash(version.localization_hash, 'localization_hash');
  if (!blueprintRow || blueprintRow.status !== 'locked'
    || String(blueprintRow.blueprint_hash || '') !== blueprintHash
    || String(blueprint?.blueprint_hash || '') !== blueprintHash
    || String(localization?.blueprint_hash || '') !== blueprintHash
    || String(localization?.localization_hash || '') !== localizationHash) {
    throw codedError('REDRAW_PRODUCTION_PACK_STALE', 'locked blueprint/localization mismatch');
  }
  return { version, blueprint, localization };
}

function versionRows(db, owner, versionId) {
  return db.prepare(`SELECT * FROM redraw_shots
    WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY batch_index ASC, shot_index ASC, id ASC`)
    .all(Number(versionId), String(owner.tenantId), String(owner.userId));
}

function compileVersionProductionPacks(db, owner, versionId) {
  const context = loadLockedEpisodeContext(db, owner, versionId);
  const rows = versionRows(db, owner, versionId);
  if (rows.length === 0) return [];
  const blueprintIds = new Set((context.blueprint.shots || []).map((shot) => String(shot.id)));
  const rowIds = new Set(rows.map((row) => String(row.shot_id || '')));
  if (blueprintIds.size !== rows.length || rowIds.size !== rows.length
    || [...blueprintIds].some((id) => !rowIds.has(id))) {
    throw codedError('REDRAW_PRODUCTION_PACK_STALE', 'shot rows do not match locked blueprint');
  }
  const assets = db.prepare(`SELECT * FROM redraw_assets
    WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY id`)
    .all(Number(versionId), String(owner.tenantId), String(owner.userId));
  const references = Object.fromEntries(rows.map((row) => [
    String(row.shot_id),
    parseJson(row.references_json, [], 'references_json'),
  ]));
  const referenceBundle = Object.fromEntries(rows.map((row) => [
    String(row.shot_id),
    parseJson(row.reference_bundle_json, {}, 'reference_bundle_json'),
  ]));
  const packs = compileEpisodeProductionPacks({
    blueprint: context.blueprint,
    localization: context.localization,
    assets,
    references,
    referenceBundle,
  });
  for (const pack of packs) {
    const row = rows.find((item) => String(item.shot_id) === pack.shot_id);
    if (Number(row.start_ms) !== pack.start_ms || Number(row.end_ms) !== pack.end_ms
      || Number(row.duration_ms) !== pack.duration_ms) {
      throw codedError('REDRAW_PRODUCTION_PACK_STALE', 'shot timing does not match locked blueprint');
    }
  }
  return packs;
}

function defaultPersistProductionPack(db, owner, versionId, payload) {
  const changed = db.prepare(`UPDATE redraw_shots
    SET compiled_prompt_json = ?, preparation_snapshot_json = ?, updated_at = ?
    WHERE id = ? AND version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL`)
    .run(
      JSON.stringify(payload.pack),
      JSON.stringify(payload.snapshot),
      payload.now,
      Number(payload.row.id),
      Number(versionId),
      String(owner.tenantId),
      String(owner.userId),
    );
  if (changed.changes !== 1) throw codedError('REDRAW_PRODUCTION_PACK_STALE', 'shot pack write conflict');
}

function writeVersionProductionPacks(db, owner, versionId, options = {}) {
  const compile = options.compileVersionProductionPacks || compileVersionProductionPacks;
  const packs = compile(db, owner, versionId);
  if (packs.length === 0) return packs;
  const rows = versionRows(db, owner, versionId);
  const persist = options.persistProductionPack || ((database, payload) => (
    defaultPersistProductionPack(database, owner, versionId, payload)
  ));
  for (const pack of packs) {
    const row = rows.find((item) => String(item.shot_id) === pack.shot_id);
    const previous = parseJson(row.preparation_snapshot_json, {}, 'preparation_snapshot_json');
    const snapshot = {
      ...previous,
      production_pack_hash: pack.production_pack_hash,
      blueprint_hash: pack.blueprint_hash,
      localization_hash: pack.localization_hash,
    };
    persist(db, { row, pack, snapshot, now: options.now || row.updated_at });
  }
  return packs;
}

function assertProductionPackShape(pack, shot) {
  if (!pack || pack.schema_version !== 'redraw-shot-production-pack-v1'
    || !Array.isArray(pack.characters) || !Array.isArray(pack.dialogue)
    || !pack.visual_contract || typeof pack.visual_contract !== 'object' || Array.isArray(pack.visual_contract)
    || !pack.audio_contract || typeof pack.audio_contract !== 'object' || Array.isArray(pack.audio_contract)
    || typeof pack.prompt !== 'string' || !pack.prompt.trim()
    || String(pack.shot_id || '') !== String(shot.shot_id || '')
    || Number(pack.start_ms) !== Number(shot.start_ms)
    || Number(pack.end_ms) !== Number(shot.end_ms)
    || Number(pack.duration_ms) !== Number(shot.duration_ms)
    || Number(pack.duration_ms) !== Number(pack.end_ms) - Number(pack.start_ms)) {
    throw codedError('REDRAW_PRODUCTION_PACK_STALE', 'production pack shape changed');
  }
}

function assertShotProductionPackCurrent(db, owner, shot) {
  const pack = parseJson(shot.compiled_prompt_json, null, 'compiled_prompt_json');
  const hasVersionBinding = HEX_64.test(String(shot.version_blueprint_hash || ''))
    || HEX_64.test(String(shot.version_localization_hash || ''));
  if (!pack || pack.schema_version !== 'redraw-shot-production-pack-v1') {
    if (!hasVersionBinding) return null;
    throw codedError('REDRAW_PRODUCTION_PACK_STALE', '逐镜生产包缺失，请重新锁定本地化并刷新生成准备');
  }
  const version = db.prepare(`SELECT work_id, version, blueprint_hash, localization_hash
    FROM redraw_versions WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1`)
    .get(Number(shot.version_id), String(owner.tenantId), String(owner.userId));
  const blueprintRow = version && db.prepare(`SELECT status, blueprint_json, blueprint_hash
    FROM redraw_episode_blueprints
    WHERE work_id = ? AND tenant_id = ? AND user_id = ? AND revision = ? ORDER BY id DESC LIMIT 1`)
    .get(Number(version.work_id), String(owner.tenantId), String(owner.userId), Number(version.version));
  const blueprint = parseJson(blueprintRow?.blueprint_json, null, 'blueprint_json');
  assertProductionPackShape(pack, shot);
  if (!version || !blueprintRow || blueprintRow.status !== 'locked'
    || String(blueprintRow.blueprint_hash || '') !== String(version.blueprint_hash || '')
    || String(blueprint?.blueprint_hash || '') !== String(version.blueprint_hash || '')
    || String(pack.blueprint_hash || '') !== String(version.blueprint_hash || '')
    || String(pack.localization_hash || '') !== String(version.localization_hash || '')
    || !HEX_64.test(String(pack.production_pack_hash || ''))
    || productionPackHash(pack) !== String(pack.production_pack_hash)) {
    throw codedError('REDRAW_PRODUCTION_PACK_STALE', '逐镜生产包已变化，请重新锁定本地化并刷新生成准备');
  }
  return pack;
}

module.exports = {
  assertShotProductionPackCurrent,
  compileEpisodeProductionPacks,
  compileShotProductionPack,
  compileVersionProductionPacks,
  productionPackHash,
  writeVersionProductionPacks,
};
