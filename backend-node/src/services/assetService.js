function list(db, query) {
  let sql = 'FROM assets WHERE deleted_at IS NULL';
  const params = [];
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  if (query.type) {
    sql += ' AND type = ?';
    params.push(query.type);
  }
  if (query.category) {
    sql += ' AND category = ?';
    params.push(query.category);
  }
  if (query.storyboard_id) {
    sql += ' AND storyboard_id = ?';
    params.push(query.storyboard_id);
  }
  if (query.keyword) {
    sql += ' AND (name LIKE ? OR category LIKE ? OR url LIKE ? OR local_path LIKE ? OR metadata LIKE ?)';
    const keyword = `%${String(query.keyword).trim()}%`;
    params.push(keyword, keyword, keyword, keyword, keyword);
  }
  const countRow = db.prepare('SELECT COUNT(*) as total ' + sql).get(...params);
  const total = countRow.total || 0;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size, 10) || 20));
  const offset = (page - 1) * pageSize;
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params, pageSize, offset);
  return { items: rows.map(rowToItem), total, page, pageSize };
}

function rowToItem(r) {
  return {
    id: r.id,
    drama_id: r.drama_id,
    storyboard_id: r.storyboard_id,
    name: r.name,
    type: r.type,
    category: r.category,
    url: r.url,
    local_path: r.local_path,
    file_size: r.file_size,
    mime_type: r.mime_type,
    duration: r.duration,
    image_gen_id: r.image_gen_id,
    video_gen_id: r.video_gen_id,
    metadata: parseMetadata(r.metadata),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return r ? rowToItem(r) : null;
}

function create(db, log, req) {
  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO assets (drama_id, storyboard_id, name, type, category, url, local_path, file_size, mime_type, width, height, duration, image_gen_id, video_gen_id, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.drama_id ?? null,
    req.storyboard_id ?? null,
    req.name || '未命名',
    req.type || 'image',
    req.category ?? null,
    req.url || '',
    req.local_path ?? null,
    req.file_size ?? null,
    req.mime_type ?? null,
    req.width ?? null,
    req.height ?? null,
    req.duration ?? null,
    req.image_gen_id ?? null,
    req.video_gen_id ?? null,
    req.metadata == null ? null : JSON.stringify(req.metadata),
    now,
    now
  );
  return getById(db, info.lastInsertRowid);
}

function update(db, log, id, req) {
  const row = db.prepare('SELECT id FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) return null;
  const updates = [];
  const params = [];
  ['name', 'description', 'type', 'category', 'url', 'local_path', 'thumbnail_url', 'file_size', 'mime_type', 'width', 'height', 'duration', 'is_favorite', 'metadata', 'drama_id', 'storyboard_id'].forEach((key) => {
    if (req[key] !== undefined) {
      updates.push(key + ' = ?');
      params.push(key === 'metadata' && req[key] != null ? JSON.stringify(req[key]) : req[key]);
    }
  });
  if (updates.length === 0) return getById(db, id);
  params.push(new Date().toISOString(), id);
  db.prepare('UPDATE assets SET ' + updates.join(', ') + ', updated_at = ? WHERE id = ?').run(...params);
  return getById(db, id);
}

/** 将分镜中提取的角色音色登记到可复用的项目音频素材库。 */
function saveExtractedVoice(db, log, {
  dramaId,
  characterId,
  characterName,
  storyboardId,
  videoId,
  voiceAsset,
}) {
  const metadata = {
    source: 'storyboard_voice_extraction',
    character_id: Number(characterId),
    character_name: characterName || `角色${characterId}`,
    storyboard_id: Number(storyboardId),
    video_id: Number(videoId),
    voice_asset: voiceAsset,
  };
  const rows = db.prepare(
    `SELECT * FROM assets
     WHERE drama_id = ? AND type = 'audio' AND category = 'voice' AND deleted_at IS NULL`
  ).all(Number(dramaId));
  const existing = rows.find((row) => {
    const item = parseMetadata(row.metadata);
    return item.source === metadata.source
      && Number(item.character_id) === metadata.character_id
      && Number(item.storyboard_id) === metadata.storyboard_id
      && Number(item.video_id) === metadata.video_id;
  });
  const now = new Date().toISOString();
  const payload = {
    name: `${metadata.character_name} · 提取音色`,
    type: 'audio',
    category: 'voice',
    url: voiceAsset.url || '',
    local_path: voiceAsset.local_path || null,
    file_size: null,
    mime_type: 'audio/mpeg',
    duration: Number(voiceAsset.duration) || null,
    metadata,
  };
  if (existing) {
    db.prepare(
      `UPDATE assets SET name = ?, url = ?, local_path = ?, file_size = ?, mime_type = ?, duration = ?, metadata = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      payload.name,
      payload.url,
      payload.local_path,
      payload.file_size,
      payload.mime_type,
      payload.duration,
      JSON.stringify(payload.metadata),
      now,
      existing.id,
    );
    log?.info?.('[素材库] 已更新提取音色', { asset_id: existing.id, drama_id: dramaId });
    return getById(db, existing.id);
  }
  const item = create(db, log, { drama_id: dramaId, ...payload });
  log?.info?.('[素材库] 已保存提取音色', { asset_id: item.id, drama_id: dramaId });
  return item;
}

function bindVoiceAsset({ db, cfg, characterId, assetId }) {
  const id = Number(characterId);
  const asset = db.prepare(
    `SELECT * FROM assets WHERE id = ? AND type = 'audio' AND category = 'voice' AND deleted_at IS NULL`
  ).get(Number(assetId));
  const character = db.prepare(
    'SELECT id, drama_id FROM characters WHERE id = ? AND deleted_at IS NULL'
  ).get(id);
  if (!character) return { ok: false, code: 'CHARACTER_NOT_FOUND', error: '角色不存在' };
  if (!asset) return { ok: false, code: 'VOICE_ASSET_NOT_FOUND', error: '音频素材不存在' };
  if (Number(asset.drama_id) !== Number(character.drama_id)) {
    return { ok: false, code: 'VOICE_ASSET_FORBIDDEN', error: '音频素材不属于当前项目' };
  }
  const metadata = parseMetadata(asset.metadata);
  const sourceAsset = metadata.voice_asset && typeof metadata.voice_asset === 'object'
    ? metadata.voice_asset
    : {};
  const now = new Date().toISOString();
  const voice = {
    ...sourceAsset,
    status: 'active',
    url: asset.url,
    local_path: asset.local_path,
    duration: asset.duration ?? sourceAsset.duration ?? null,
    format: asset.mime_type?.split('/')[1] || sourceAsset.format || 'mp3',
    source: 'audio_library',
    source_asset_id: asset.id,
  };
  db.prepare('UPDATE characters SET seedance2_voice_asset = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(voice), now, id,
  );
  return { ok: true, asset: voice, library_asset: rowToItem(asset) };
}

function deleteById(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE assets SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  return result.changes > 0;
}

function importFromImage(db, log, imageGenId) {
  const img = db.prepare('SELECT * FROM image_generations WHERE id = ? AND deleted_at IS NULL').get(Number(imageGenId));
  if (!img) return null;
  return create(db, log, {
    drama_id: img.drama_id,
    name: `图片 ${imageGenId}`,
    type: 'image',
    url: img.image_url || '',
    local_path: img.local_path,
    image_gen_id: img.id,
  });
}

function importFromVideo(db, log, videoGenId) {
  const vid = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(videoGenId));
  if (!vid) return null;
  return create(db, log, {
    drama_id: vid.drama_id,
    name: `视频 ${videoGenId}`,
    type: 'video',
    url: vid.video_url || '',
    local_path: vid.local_path,
    video_gen_id: vid.id,
  });
}

module.exports = {
  list,
  getById,
  create,
  update,
  deleteById,
  importFromImage,
  importFromVideo,
  saveExtractedVoice,
  bindVoiceAsset,
};
