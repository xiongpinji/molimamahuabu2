const storyboardService = require('./storyboardService');

function normalizeAssetText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/的/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function parseCharacterEntries(value) {
  let items = value;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch (_) {
      items = [];
    }
  }
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const isObject = typeof item === 'object' && item != null;
    const id = Number(isObject ? item.id : item);
    const name = isObject
      ? String(item.name || '')
      : (Number.isFinite(id) ? '' : String(item || ''));
    return { id, name };
  }).filter((item) => Number.isFinite(item.id) || item.name.trim());
}

function uniqueIds(ids) {
  const seen = new Set();
  const result = [];
  for (const value of ids) {
    const id = Number(value);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function sameOrderedIds(left, right) {
  const a = uniqueIds(left);
  const b = uniqueIds(right);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function sameIdSet(left, right) {
  return sameOrderedIds(
    uniqueIds(left).sort((a, b) => a - b),
    uniqueIds(right).sort((a, b) => a - b),
  );
}

function buildActiveNameMap(rows, field) {
  const map = new Map();
  for (const row of [...rows].sort((a, b) => Number(b.id) - Number(a.id))) {
    const key = normalizeAssetText(row[field]);
    if (key && !map.has(key)) map.set(key, Number(row.id));
  }
  return map;
}

function remapExistingEntries(entries, activeRows, allRows, nameField) {
  const activeById = new Map(activeRows.map((row) => [Number(row.id), row]));
  const allById = new Map(allRows.map((row) => [Number(row.id), row]));
  const activeByName = buildActiveNameMap(activeRows, nameField);
  const result = [];
  for (const entry of entries) {
    if (activeById.has(entry.id)) {
      result.push(entry.id);
      continue;
    }
    const historical = allById.get(entry.id);
    const name = entry.name || historical?.[nameField] || '';
    const replacementId = activeByName.get(normalizeAssetText(name));
    if (replacementId) result.push(replacementId);
  }
  return uniqueIds(result);
}

function mentionRanges(text, key) {
  const result = [];
  let start = 0;
  while (key && start < text.length) {
    const index = text.indexOf(key, start);
    if (index < 0) break;
    result.push([index, index + key.length]);
    start = index + Math.max(1, key.length);
  }
  return result;
}

function addTextMatches(existingIds, rows, field, scanText) {
  const normalizedText = normalizeAssetText(scanText);
  const result = uniqueIds(existingIds);
  const selected = new Set(result);
  const coveredRanges = [];
  const candidates = rows
    .map((row) => ({ id: Number(row.id), key: normalizeAssetText(row[field]) }))
    .filter((item) => Number.isFinite(item.id) && item.key.length >= 2)
    .sort((a, b) => b.key.length - a.key.length || a.id - b.id);

  for (const candidate of candidates) {
    const ranges = mentionRanges(normalizedText, candidate.key);
    if (!ranges.length) continue;
    const hasStandaloneMention = ranges.some(([start, end]) =>
      !coveredRanges.some(([coveredStart, coveredEnd]) =>
        start >= coveredStart && end <= coveredEnd,
      ),
    );
    if (hasStandaloneMention && !selected.has(candidate.id)) {
      result.push(candidate.id);
      selected.add(candidate.id);
    }
    if (selected.has(candidate.id)) coveredRanges.push(...ranges);
  }
  return result;
}

function chooseSceneId(storyboard, activeScenes, allScenes) {
  const currentId = Number(storyboard.scene_id);
  if (activeScenes.some((scene) => Number(scene.id) === currentId)) return currentId;

  const historical = allScenes.find((scene) => Number(scene.id) === currentId);
  if (historical) {
    const locationKey = normalizeAssetText(historical.location);
    const timeKey = normalizeAssetText(historical.time);
    const exact = activeScenes.find((scene) =>
      normalizeAssetText(scene.location) === locationKey
      && (!timeKey || normalizeAssetText(scene.time) === timeKey),
    ) || activeScenes.find((scene) => normalizeAssetText(scene.location) === locationKey);
    if (exact) return Number(exact.id);
  }

  const locationText = normalizeAssetText(storyboard.location);
  const timeText = normalizeAssetText(storyboard.time);
  const scanText = normalizeAssetText([
    storyboard.title,
    storyboard.description,
    storyboard.location,
    storyboard.time,
    storyboard.action,
    storyboard.dialogue,
    storyboard.narration,
    storyboard.result,
    storyboard.image_prompt,
    storyboard.video_prompt,
    storyboard.universal_segment_text,
  ].filter(Boolean).join('\n'));
  let best = null;
  for (const scene of activeScenes) {
    const locationKey = normalizeAssetText(scene.location);
    const sceneTimeKey = normalizeAssetText(scene.time);
    if (locationKey.length < 2) continue;
    let score = 0;
    if (locationText === locationKey) score += 10_000;
    else if (locationText.includes(locationKey)) score += 6_000 + locationKey.length;
    else if (locationText.length >= 2 && locationKey.includes(locationText)) score += 5_000 + locationText.length;
    else if (scanText.includes(locationKey)) score += 2_000 + locationKey.length;
    if (sceneTimeKey && timeText
      && (timeText.includes(sceneTimeKey) || sceneTimeKey.includes(timeText))) score += 500;
    if (score > 0 && (!best || score > best.score)) best = { id: Number(scene.id), score };
  }
  return best?.id ?? null;
}

function storyboardScanText(storyboard) {
  return [
    storyboard.title,
    storyboard.description,
    storyboard.location,
    storyboard.time,
    storyboard.dialogue,
    storyboard.narration,
    storyboard.action,
    storyboard.result,
    storyboard.atmosphere,
    storyboard.image_prompt,
    storyboard.polished_prompt,
    storyboard.video_prompt,
    storyboard.universal_segment_text,
  ].filter(Boolean).join('\n');
}

function syncStoryboardAssets(db, log, storyboardId) {
  const storyboard = db.prepare(
    `SELECT s.*, e.drama_id
     FROM storyboards s
     JOIN episodes e ON e.id = s.episode_id AND e.deleted_at IS NULL
     WHERE s.id = ? AND s.deleted_at IS NULL`,
  ).get(Number(storyboardId));
  if (!storyboard) {
    const error = new Error('分镜不存在');
    error.code = 'not_found';
    throw error;
  }

  const dramaId = Number(storyboard.drama_id);
  const activeCharacters = db.prepare(
    'SELECT id, name FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id ASC',
  ).all(dramaId);
  const allCharacters = db.prepare(
    'SELECT id, name FROM characters WHERE drama_id = ? ORDER BY id ASC',
  ).all(dramaId);
  const activeScenes = db.prepare(
    'SELECT id, location, time FROM scenes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id ASC',
  ).all(dramaId);
  const allScenes = db.prepare(
    'SELECT id, location, time FROM scenes WHERE drama_id = ? ORDER BY id ASC',
  ).all(dramaId);
  const activeProps = db.prepare(
    'SELECT id, name FROM props WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id ASC',
  ).all(dramaId);
  const allProps = db.prepare(
    'SELECT id, name FROM props WHERE drama_id = ? ORDER BY id ASC',
  ).all(dramaId);

  const originalCharacterEntries = parseCharacterEntries(storyboard.characters);
  const originalCharacterIds = originalCharacterEntries.map((item) => item.id);
  const scanText = storyboardScanText(storyboard);
  const remappedCharacterIds = remapExistingEntries(
    originalCharacterEntries,
    activeCharacters,
    allCharacters,
    'name',
  );
  const characterIds = addTextMatches(remappedCharacterIds, activeCharacters, 'name', scanText);

  const originalPropIds = db.prepare(
    'SELECT prop_id FROM storyboard_props WHERE storyboard_id = ? ORDER BY prop_id ASC',
  ).all(Number(storyboardId)).map((row) => Number(row.prop_id));
  const remappedPropIds = remapExistingEntries(
    originalPropIds.map((id) => ({ id, name: '' })),
    activeProps,
    allProps,
    'name',
  );
  const propIds = addTextMatches(remappedPropIds, activeProps, 'name', scanText);
  const sceneId = chooseSceneId(storyboard, activeScenes, allScenes);

  const charactersChanged = !sameOrderedIds(originalCharacterIds, characterIds);
  const sceneChanged = (Number.isFinite(Number(storyboard.scene_id)) ? Number(storyboard.scene_id) : null) !== sceneId;
  const propsChanged = !sameIdSet(originalPropIds, propIds);
  const updated = charactersChanged || sceneChanged || propsChanged;

  if (updated) {
    storyboardService.updateStoryboard(db, log, storyboardId, {
      character_ids: characterIds,
      scene_id: sceneId,
      prop_ids: propIds,
    });
  }

  const originalActiveIds = new Set(originalCharacterIds.filter((id) =>
    activeCharacters.some((row) => Number(row.id) === id),
  ));
  const added = characterIds
    .filter((id) => !originalActiveIds.has(id))
    .map((id) => activeCharacters.find((row) => Number(row.id) === id)?.name)
    .filter(Boolean);

  return {
    storyboard_id: Number(storyboardId),
    updated,
    characters_changed: charactersChanged,
    scene_changed: sceneChanged,
    props_changed: propsChanged,
    character_ids: characterIds,
    scene_id: sceneId,
    prop_ids: propIds,
    added,
  };
}

function rematchEpisodeAssets(db, log, episodeId) {
  const episode = db.prepare(
    'SELECT id FROM episodes WHERE id = ? AND deleted_at IS NULL',
  ).get(Number(episodeId));
  if (!episode) {
    const error = new Error('剧集不存在');
    error.code = 'not_found';
    throw error;
  }
  const rows = db.prepare(
    `SELECT id FROM storyboards
     WHERE episode_id = ? AND deleted_at IS NULL
     ORDER BY storyboard_number ASC, id ASC`,
  ).all(Number(episodeId));
  const results = rows.map((row) => syncStoryboardAssets(db, log, row.id));
  const summary = {
    episode_id: Number(episodeId),
    total: results.length,
    updated: results.filter((item) => item.updated).length,
    character_storyboards: results.filter((item) => item.character_ids.length > 0).length,
    scene_storyboards: results.filter((item) => item.scene_id != null).length,
    prop_storyboards: results.filter((item) => item.prop_ids.length > 0).length,
    character_links: results.reduce((sum, item) => sum + item.character_ids.length, 0),
    scene_links: results.reduce((sum, item) => sum + (item.scene_id == null ? 0 : 1), 0),
    prop_links: results.reduce((sum, item) => sum + item.prop_ids.length, 0),
  };
  if (log) log.info('[分镜资产匹配] 当前集匹配完成', summary);
  return summary;
}

module.exports = {
  normalizeAssetText,
  syncStoryboardAssets,
  rematchEpisodeAssets,
};
