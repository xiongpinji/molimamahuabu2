/**
 * 分镜角色音色固定快照。
 *
 * 角色上的 seedance2_voice_asset 是项目级配置；分镜生成时再复制一份快照，
 * 这样后续批量生成、失败重试或更换模型时，已有分镜仍然使用同一条参考音频。
 */

function parseVoiceAsset(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch (_) {
    return null;
  }
}

function parseCharacterRefs(raw) {
  if (raw == null || raw === '') return [];
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch (_) { return []; }
  }
  if (!Array.isArray(value)) value = [value];
  const seen = new Set();
  return value.map((item) => {
    const object = item && typeof item === 'object' ? item : null;
    const id = Number(object ? object.id : item);
    const name = String(object?.name || object?.character_name || (typeof item === 'string' && !/^\d+$/.test(item) ? item : '')).trim();
    const key = Number.isInteger(id) && id > 0 ? `id:${id}` : name ? `name:${name}` : '';
    if (!key || seen.has(key)) return null;
    seen.add(key);
    return { id: Number.isInteger(id) && id > 0 ? id : null, name };
  }).filter(Boolean);
}

function parseCharacterIds(raw) {
  return parseCharacterRefs(raw).map((ref) => ref.id).filter(Boolean);
}

function normalizeCharacterName(name) {
  return String(name || '').trim().toLowerCase().replace(/[\s　]+/g, '');
}

function buildVoiceSnapshot(db, dramaId, characterRefs) {
  const refs = parseCharacterRefs(characterRefs);
  if (!db || !Number.isInteger(Number(dramaId)) || Number(dramaId) <= 0 || refs.length === 0) return null;

  let rows = [];
  try {
    rows = db.prepare(
      `SELECT id, name, seedance2_voice_asset
       FROM characters
       WHERE drama_id = ? AND deleted_at IS NULL
       ORDER BY id ASC`
    ).all(Number(dramaId));
  } catch (_) {
    return null;
  }

  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const byName = new Map(rows.map((row) => [normalizeCharacterName(row.name), row]));
  const selected = [];
  const seen = new Set();
  for (const ref of refs) {
    const row = (ref.id && byId.get(ref.id)) || (ref.name && byName.get(normalizeCharacterName(ref.name)));
    if (!row || seen.has(Number(row.id))) continue;
    seen.add(Number(row.id));
    selected.push(row);
  }

  const characters = selected.map((row) => {
    const asset = parseVoiceAsset(row.seedance2_voice_asset);
    const status = String(asset?.status || '').toLowerCase();
    const url = String(asset?.url || '').trim();
    if (status !== 'active' || !url) return null;
    return {
      id: Number(row.id),
      name: row.name || '',
      url,
      source: asset.source || 'character_voice',
      source_asset_id: asset.source_asset_id ?? null,
    };
  }).filter(Boolean);

  if (!characters.length) return null;
  return JSON.stringify({
    version: 1,
    locked_at: new Date().toISOString(),
    characters,
  });
}

function parseVoiceSnapshot(raw) {
  if (!raw) return [];
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch (_) { return []; }
  }
  const rows = Array.isArray(value) ? value : value?.characters;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    id: Number(row?.id),
    name: row?.name || '',
    url: String(row?.url || '').trim(),
    source: row?.source || 'character_voice',
    source_asset_id: row?.source_asset_id ?? null,
  })).filter((row) => Number.isInteger(row.id) && row.id > 0 && row.url);
}

/** 按角色 id 读取快照中的稳定参考音频。 */
function snapshotVoiceMap(raw) {
  return new Map(parseVoiceSnapshot(raw).map((row) => [row.id, row.url]));
}

/** 在创建/重生成分镜后刷新一次快照；没有 active 音色时保持为空，允许后续回退到角色当前配置。 */
function refreshStoryboardVoiceSnapshot(db, storyboardId) {
  const sid = Number(storyboardId);
  if (!Number.isInteger(sid) || sid <= 0) return null;
  try {
    const row = db.prepare(
      `SELECT s.characters, e.drama_id
       FROM storyboards s
       JOIN episodes e ON e.id = s.episode_id AND e.deleted_at IS NULL
       WHERE s.id = ? AND s.deleted_at IS NULL`
    ).get(sid);
    if (!row) return null;
    const snapshot = buildVoiceSnapshot(db, row.drama_id, row.characters);
    db.prepare('UPDATE storyboards SET voice_snapshot = ?, updated_at = ? WHERE id = ?')
      .run(snapshot, new Date().toISOString(), sid);
    return snapshot;
  } catch (_) {
    // 兼容尚未执行 34 号迁移的旧开发库，不能阻断分镜保存。
    return null;
  }
}

module.exports = {
  parseCharacterIds,
  buildVoiceSnapshot,
  parseVoiceSnapshot,
  snapshotVoiceMap,
  refreshStoryboardVoiceSnapshot,
};
