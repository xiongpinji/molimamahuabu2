const userAuth = require('../services/userAuthService');
const sessionCookie = require('../services/sessionCookieService');

function numericId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function lookup(db, sql, id) {
  const row = db.prepare(sql).get(id);
  return row?.drama_id == null ? null : numericId(row.drama_id);
}

function resolveDramaId(db, req) {
  const parts = String(req.path || '').split('/').filter(Boolean);
  const root = parts[0];
  const first = numericId(parts[1]);
  const body = req.body || {};
  const query = req.query || {};

  if (root === 'dramas') return first ? { dramaId: first } : { skip: true };
  if (root === 'generation') {
    const dramaId = numericId(body.drama_id || query.drama_id);
    return dramaId ? { dramaId } : { skip: true };
  }
  if (root === 'episodes') {
    return first ? { dramaId: lookup(db, 'SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL', first) } : { skip: true };
  }
  if (root === 'storyboards') {
    if (parts[1] === 'episode') {
      const episodeId = numericId(parts[2]);
      return episodeId ? { dramaId: lookup(db, 'SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL', episodeId) } : { skip: true };
    }
    if (first) {
      return { dramaId: lookup(db, `SELECT e.drama_id FROM storyboards s JOIN episodes e ON e.id = s.episode_id
        WHERE s.id = ? AND s.deleted_at IS NULL AND e.deleted_at IS NULL`, first) };
    }
    const dramaId = numericId(body.drama_id || query.drama_id);
    const episodeId = numericId(body.episode_id || query.episode_id);
    if (dramaId) return { dramaId };
    return episodeId ? { dramaId: lookup(db, 'SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL', episodeId) } : { skip: true };
  }
  if (root === 'characters') {
    if (parts[1] === 'batch-generate-images') {
      const ids = Array.isArray(body.character_ids) ? body.character_ids.map(numericId).filter(Boolean) : [];
      if (ids.length === 0) return { skip: true };
      return {
        dramaIds: ids.map((id) => lookup(
          db,
          'SELECT drama_id FROM characters WHERE id = ? AND deleted_at IS NULL',
          id,
        )),
      };
    }
    if (first) return { dramaId: lookup(db, 'SELECT drama_id FROM characters WHERE id = ? AND deleted_at IS NULL', first) };
    return relationFromInput(db, body, query);
  }
  if (root === 'scenes') {
    if (parts[1] === 'generate-image') {
      const sceneId = numericId(body.scene_id || query.scene_id);
      return sceneId
        ? { dramaId: lookup(db, 'SELECT drama_id FROM scenes WHERE id = ? AND deleted_at IS NULL', sceneId) }
        : { skip: true };
    }
    if (!first) return relationFromInput(db, body, query);
    return { dramaId: lookup(db, 'SELECT drama_id FROM scenes WHERE id = ? AND deleted_at IS NULL', first) };
  }
  if (root === 'props') {
    if (!first) {
      const dramaId = numericId(body.drama_id || query.drama_id);
      return dramaId ? { dramaId } : { skip: true };
    }
    return { dramaId: lookup(db, 'SELECT drama_id FROM props WHERE id = ? AND deleted_at IS NULL', first) };
  }
  if (root === 'images') {
    if (parts[1] === 'scene') {
      const sceneId = numericId(parts[2]);
      return sceneId ? { dramaId: lookup(db, 'SELECT drama_id FROM scenes WHERE id = ? AND deleted_at IS NULL', sceneId) } : { skip: true };
    }
    if (parts[1] === 'episode') {
      const episodeId = numericId(parts[2]);
      return episodeId ? { dramaId: lookup(db, 'SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL', episodeId) } : { skip: true };
    }
    if (first) return { dramaId: lookup(db, 'SELECT drama_id FROM image_generations WHERE id = ? AND deleted_at IS NULL', first) };
    return relationFromInput(db, body, query);
  }
  if (root === 'videos') {
    if (parts[1] === 'image') {
      const imageId = numericId(parts[2]);
      return imageId ? { dramaId: lookup(db, 'SELECT drama_id FROM image_generations WHERE id = ? AND deleted_at IS NULL', imageId) } : { skip: true };
    }
    if (parts[1] === 'episode') {
      const episodeId = numericId(parts[2]);
      return episodeId ? { dramaId: lookup(db, 'SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL', episodeId) } : { skip: true };
    }
    if (first) return { dramaId: lookup(db, 'SELECT drama_id FROM video_generations WHERE id = ? AND deleted_at IS NULL', first) };
    return relationFromInput(db, body, query);
  }
  if (root === 'video-merges') {
    if (first) return { dramaId: lookup(db, 'SELECT drama_id FROM video_merges WHERE id = ? AND deleted_at IS NULL', first) };
    return relationFromInput(db, body, query);
  }
  if (root === 'assets') {
    if (parts[1] === 'import' && parts[2] === 'image') {
      const imageId = numericId(parts[3]);
      return imageId ? { dramaId: lookup(db, 'SELECT drama_id FROM image_generations WHERE id = ? AND deleted_at IS NULL', imageId) } : { skip: true };
    }
    if (parts[1] === 'import' && parts[2] === 'video') {
      const videoId = numericId(parts[3]);
      return videoId ? { dramaId: lookup(db, 'SELECT drama_id FROM video_generations WHERE id = ? AND deleted_at IS NULL', videoId) } : { skip: true };
    }
    if (first) return { dramaId: lookup(db, 'SELECT drama_id FROM assets WHERE id = ? AND deleted_at IS NULL', first) };
    return relationFromInput(db, body, query);
  }
  if (root === 'audio') return relationFromInput(db, body, query);
  if (root === 'tasks' && parts[1]) return { taskId: String(parts[1]) };
  return relationFromInput(db, body, query);
}

function relationFromInput(db, body, query) {
  const dramaId = numericId(body.drama_id || query.drama_id);
  if (dramaId) return { dramaId };
  const episodeId = numericId(body.episode_id || query.episode_id);
  if (episodeId) return { dramaId: lookup(db, 'SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL', episodeId) };
  const storyboardId = numericId(body.storyboard_id || query.storyboard_id);
  if (storyboardId) return { dramaId: lookup(db, `SELECT e.drama_id FROM storyboards s JOIN episodes e ON e.id = s.episode_id
    WHERE s.id = ? AND s.deleted_at IS NULL AND e.deleted_at IS NULL`, storyboardId) };
  const sceneId = numericId(body.scene_id || query.scene_id);
  if (sceneId) return { dramaId: lookup(db, 'SELECT drama_id FROM scenes WHERE id = ? AND deleted_at IS NULL', sceneId) };
  return { skip: true };
}

function taskOwnedByUser(db, taskId, userId, tenantId) {
  const task = db.prepare('SELECT id, type, resource_id, user_id, tenant_id FROM async_tasks WHERE id = ? AND deleted_at IS NULL').get(taskId);
  if (!task) return false;
  if (tenantId && task.tenant_id != null) return task.tenant_id === tenantId;
  if (task.user_id != null) return task.user_id === userId;
  const resource = String(task.resource_id || '');
  let dramaId = null;
  if (resource.startsWith('scene_')) {
    dramaId = lookup(db, 'SELECT drama_id FROM scenes WHERE id = ? AND deleted_at IS NULL', numericId(resource.slice(6)));
  } else if (resource.startsWith('character_')) {
    dramaId = lookup(db, 'SELECT drama_id FROM characters WHERE id = ? AND deleted_at IS NULL', numericId(resource.slice(10)));
  } else if (resource.startsWith('prop_')) {
    dramaId = lookup(db, 'SELECT drama_id FROM props WHERE id = ? AND deleted_at IS NULL', numericId(resource.slice(5)));
  } else if (['storyboard_generation', 'background_extraction', 'prop_extraction', 'video_merge'].includes(task.type)) {
    dramaId = lookup(db, 'SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL', numericId(resource));
  } else if (task.type === 'frame_prompt_generation') {
    dramaId = lookup(db, `SELECT e.drama_id FROM storyboards s JOIN episodes e ON e.id = s.episode_id
      WHERE s.id = ? AND s.deleted_at IS NULL AND e.deleted_at IS NULL`, numericId(resource));
  } else if (task.type === 'character_image') {
    dramaId = lookup(db, 'SELECT drama_id FROM characters WHERE id = ? AND deleted_at IS NULL', numericId(resource));
  } else {
    dramaId = numericId(resource);
  }
  if (!dramaId) return false;
  if (tenantId) {
    return Boolean(db.prepare('SELECT id FROM dramas WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(dramaId, tenantId));
  }
  return Boolean(db.prepare('SELECT id FROM dramas WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(dramaId, userId));
}

function createResourceOwnershipMiddleware({ db, enabled } = {}) {
  return (req, res, next) => {
    if (!enabled) return next();
    const resolved = resolveDramaId(db, req);
    if (resolved.skip) return next();
    if (resolved.taskId) {
      if (!taskOwnedByUser(db, resolved.taskId, req.user?.id, req.tenant?.id)) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '资源不存在' } });
      return next();
    }
    if (resolved.dramaIds) {
      const allOwned = resolved.dramaIds.length > 0 && resolved.dramaIds.every((dramaId) => {
        if (!dramaId) return false;
        return req.tenant?.id
          ? Boolean(db.prepare('SELECT id FROM dramas WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(dramaId, req.tenant.id))
          : Boolean(db.prepare('SELECT id FROM dramas WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(dramaId, req.user?.id));
      });
      if (!allOwned) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '资源不存在' } });
      return next();
    }
    if (!resolved.dramaId) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '资源不存在' } });
    const owned = req.tenant?.id
      ? db.prepare('SELECT id FROM dramas WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(resolved.dramaId, req.tenant.id)
      : db.prepare('SELECT id FROM dramas WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(resolved.dramaId, req.user?.id);
    if (!owned) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '资源不存在' } });
    req.ownerDramaId = owned.id;
    return next();
  };
}

function createStaticOwnershipMiddleware({ db, enabled, secret } = {}) {
  return (req, res, next) => {
    if (!enabled) return next();
    if (!userAuth.validSecret(secret)) return res.status(503).end();
    const match = /^Bearer\s+(.+)$/i.exec(String(req.get('authorization') || ''));
    const token = match?.[1] || sessionCookie.readSessionCookie(req);
    if (!token) return res.status(401).end();
    let user;
    try {
      const claims = userAuth.verifyToken(token, secret);
      const current = db.prepare(`SELECT email, role, platform_role, status, token_version
        FROM platform_users WHERE id = ?`).get(claims.id);
      if (!current
        || current.status !== 'active'
        || (Number(current.token_version) || 0) !== claims.tokenVersion) {
        throw new Error('inactive user');
      }
      user = { id: claims.id, email: current.email, role: current.platform_role || current.role };
    } catch (_) {
      return res.status(401).end();
    }
    let pathValue;
    try {
      pathValue = decodeURIComponent(String(req.path || ''));
    } catch (_) {
      return res.status(404).end();
    }
    const project = /^\/projects\/(\d+)_/.exec(pathValue);
    const redrawSource = /^\/redraw-sources\/([a-f0-9]{64})\.(?:mp4|mov)$/i.exec(pathValue);
    const relativePath = pathValue.replace(/^\/+/, '');
    const owned = redrawSource
      ? db.prepare(`SELECT w.id FROM redraw_works w
          WHERE lower(w.source_fingerprint) = lower(?) AND w.deleted_at IS NULL
            AND (w.user_id = ? OR EXISTS (
              SELECT 1 FROM tenant_members m
              WHERE m.tenant_id = w.tenant_id AND m.user_id = ? AND m.status = 'active'
            ))
          LIMIT 1`)
        .get(redrawSource[1], user.id, user.id)
      : project
      ? db.prepare(`SELECT d.id FROM dramas d
          WHERE d.id = ? AND d.deleted_at IS NULL
            AND (d.user_id = ? OR EXISTS (
              SELECT 1 FROM tenant_members m
              WHERE m.tenant_id = d.tenant_id AND m.user_id = ? AND m.status = 'active'
            ))`)
        .get(Number(project[1]), user.id, user.id)
      : db.prepare(`SELECT g.id FROM (
            SELECT id, tenant_id, user_id FROM image_generations
              WHERE local_path = ? AND deleted_at IS NULL
            UNION ALL
            SELECT id, tenant_id, user_id FROM video_generations
              WHERE local_path = ? AND deleted_at IS NULL
          ) g
          WHERE g.user_id = ? OR EXISTS (
            SELECT 1 FROM tenant_members m
            WHERE m.tenant_id = g.tenant_id AND m.user_id = ? AND m.status = 'active'
          )
          LIMIT 1`)
        .get(relativePath, relativePath, user.id, user.id);
    if (!owned) return res.status(404).end();
    req.user = user;
    return next();
  };
}

module.exports = { createResourceOwnershipMiddleware, createStaticOwnershipMiddleware, resolveDramaId };
