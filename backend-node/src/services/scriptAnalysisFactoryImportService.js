'use strict';

const dramaService = require('./dramaService');

function importError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function firstArray(...values) {
  const arrays = values.filter(Array.isArray);
  return arrays.find((value) => value.length > 0) || arrays[0] || [];
}

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function itemName(value) {
  if (typeof value === 'string') return value.trim();
  return stringValue(value?.name || value?.character_name || value?.prop_name || value?.id);
}

function itemNames(value) {
  return firstArray(value).map(itemName).filter(Boolean);
}

function formatDialogue(value) {
  if (typeof value === 'string') return value.trim();
  return firstArray(value)
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      const text = stringValue(item?.text || item?.dialogue || item?.line || item?.content);
      const speaker = stringValue(item?.speaker || item?.character || item?.name);
      return text ? `${speaker ? `${speaker}：` : ''}${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function shotSourceBasis(shot) {
  return firstArray(shot?.source_basis)
    .map((item) => (typeof item === 'string'
      ? item.trim()
      : stringValue(item?.source_text || item?.text || item?.source_location)))
    .filter(Boolean);
}

function episodeScript(episode, fallbackSource) {
  if (stringValue(episode?.script_content)) return String(episode.script_content);
  const lines = [];
  for (const [sceneIndex, scene] of firstArray(episode?.scenes).entries()) {
    const location = stringValue(scene?.location || scene?.name || scene?.title);
    const time = stringValue(scene?.time);
    lines.push(`第${Number(scene?.scene_number) || sceneIndex + 1}场${location ? ` · ${location}` : ''}${time ? ` · ${time}` : ''}`);
    const sceneDescription = stringValue(scene?.description || scene?.action);
    if (sceneDescription) lines.push(sceneDescription);
    for (const [shotIndex, shot] of firstArray(scene?.shots).entries()) {
      const action = stringValue(shot?.action || shot?.description);
      const dialogue = formatDialogue(shot?.dialogue);
      lines.push(`镜头${Number(shot?.shot_number) || shotIndex + 1}${action ? `：${action}` : ''}`);
      if (dialogue) lines.push(dialogue);
    }
    lines.push('');
  }
  return lines.join('\n').trim() || String(fallbackSource || '');
}

function episodeDuration(episode) {
  const explicit = Number(episode?.duration);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return firstArray(episode?.scenes).reduce((episodeTotal, scene) => (
    episodeTotal + firstArray(scene?.shots).reduce((sceneTotal, shot) => {
      const duration = Number(shot?.duration);
      return sceneTotal + (Number.isFinite(duration) && duration > 0 ? duration : 0);
    }, 0)
  ), 0);
}

function safeLogger(log) {
  return {
    info: typeof log?.info === 'function' ? log.info.bind(log) : () => {},
    warn: typeof log?.warn === 'function' ? log.warn.bind(log) : () => {},
    error: typeof log?.error === 'function' ? log.error.bind(log) : () => {},
  };
}

function findExistingImport(db, userId, tenantId, importKey) {
  const tenantClause = tenantId == null ? 'tenant_id IS NULL' : 'tenant_id = ?';
  const params = tenantId == null
    ? [String(userId), importKey]
    : [String(userId), String(tenantId), importKey];
  return db.prepare(`
    SELECT id, title
    FROM dramas
    WHERE user_id = ?
      AND ${tenantClause}
      AND deleted_at IS NULL
      AND json_valid(metadata) = 1
      AND json_extract(metadata, '$.script_analysis_import.import_key') = ?
    ORDER BY id ASC
    LIMIT 1
  `).get(...params);
}

function importApprovedPackageToFactory(db, log, {
  projectId,
  version,
  userId,
  tenantId,
}) {
  const ownerId = String(userId || 'local');
  const project = db.prepare(`
    SELECT * FROM script_analysis_projects
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(projectId), ownerId);
  if (!project) {
    throw importError('SCRIPT_ANALYSIS_PROJECT_NOT_FOUND', '剧本分析项目不存在');
  }

  const requestedVersion = Number(version);
  if (!Number.isInteger(requestedVersion) || requestedVersion !== Number(project.current_version)) {
    throw importError('FACTORY_IMPORT_STALE_VERSION', '只能导入当前审核版本');
  }
  const versionRow = db.prepare(`
    SELECT package_json, approval_status
    FROM script_analysis_versions
    WHERE project_id = ? AND version = ?
  `).get(project.id, requestedVersion);
  const productionPackage = parseObject(versionRow?.package_json);
  if (
    project.status !== 'approved'
    || versionRow?.approval_status !== 'approved'
    || productionPackage?.approval_status !== 'approved'
  ) {
    throw importError('FACTORY_IMPORT_NOT_APPROVED', '仅审核通过的当前版本可以导入短剧工厂');
  }

  const normalized = parseObject(productionPackage.normalized_script)
    || parseObject(productionPackage.story_overview)
    || parseObject(productionPackage.story)
    || {};
  const importKey = `script-analysis:${project.id}:version:${requestedVersion}`;
  const logger = safeLogger(log);
  const runImport = db.transaction(() => {
    const existing = findExistingImport(db, ownerId, tenantId, importKey);
    if (existing) {
      return {
        created: false,
        drama_id: existing.id,
        title: existing.title,
        source_project_id: project.id,
        source_version: requestedVersion,
      };
    }

    const rawEpisodes = firstArray(productionPackage.episodes);
    const topLevelShots = firstArray(productionPackage.shots, productionPackage.storyboards);
    const episodes = rawEpisodes.length > 0
      ? rawEpisodes
      : [{ episode_number: 1, title: '第1集', scenes: topLevelShots.length ? [{ scene_number: 1, shots: topLevelShots }] : [] }];
    const totalTargetDuration = Number(normalized.target_duration_seconds) || 0;
    const episodePayload = episodes.map((episode, index) => {
      const measuredDuration = episodeDuration(episode);
      return {
        episode_number: Number(episode?.episode_number) || index + 1,
        title: stringValue(episode?.title) || `第${index + 1}集`,
        script_content: episodeScript(episode, episodes.length === 1 ? project.source_script : ''),
        description: stringValue(episode?.description) || null,
        duration: measuredDuration || (totalTargetDuration > 0 ? Math.round(totalTargetDuration / episodes.length) : 0),
      };
    });
    const importMetadata = {
      project_type: 'factory',
      script_analysis_import: {
        schema_version: 'script-analysis-factory-import@1.0',
        import_key: importKey,
        source_project_id: project.id,
        source_project_title: project.title,
        source_version: requestedVersion,
        approval_status: 'approved',
        imported_at: new Date().toISOString(),
        locked_facts: firstArray(productionPackage?.source?.locked_facts),
        skill_snapshot: parseObject(productionPackage.skill_snapshot),
        visual_direction: parseObject(productionPackage.visual_direction),
        continuity_rules: firstArray(productionPackage.continuity_rules),
        package_snapshot: productionPackage,
      },
    };
    const drama = dramaService.createDrama(db, logger, {
      title: stringValue(project.title) || stringValue(productionPackage?.source?.title) || '导入短剧项目',
      description: stringValue(normalized.logline || normalized.summary) || null,
      genre: stringValue(normalized.genre) || null,
      metadata: importMetadata,
      user_id: ownerId,
      tenant_id: tenantId == null ? null : String(tenantId),
    });
    const dramaId = Number(drama.id);

    const characterSource = firstArray(productionPackage.character_bible, productionPackage.characters);
    const characters = characterSource
      .map((character) => ({
        name: stringValue(character?.name || character?.character_name),
        role: stringValue(character?.role || character?.type) || null,
        description: stringValue(character?.description || character?.bio) || null,
        personality: stringValue(character?.personality) || null,
        appearance: stringValue(character?.appearance || character?.visual_description) || null,
      }))
      .filter((character) => character.name);
    dramaService.saveCharacters(db, logger, dramaId, { characters });
    dramaService.saveEpisodes(db, logger, dramaId, { episodes: episodePayload });

    const episodeRows = db.prepare(`
      SELECT id, episode_number FROM episodes
      WHERE drama_id = ? AND deleted_at IS NULL
      ORDER BY episode_number, id
    `).all(dramaId);
    const episodeIdByNumber = new Map(episodeRows.map((row) => [Number(row.episode_number), Number(row.id)]));
    const firstEpisodeId = Number(episodeRows[0]?.id);
    const characterRows = db.prepare(`
      SELECT id, name FROM characters
      WHERE drama_id = ? AND deleted_at IS NULL
    `).all(dramaId);
    const characterIdByName = new Map(characterRows.map((row) => [stringValue(row.name).toLowerCase(), Number(row.id)]));
    const linkEpisodeCharacter = db.prepare('INSERT OR IGNORE INTO episode_characters (episode_id, character_id) VALUES (?, ?)');
    for (const episodeRow of episodeRows) {
      for (const characterRow of characterRows) linkEpisodeCharacter.run(episodeRow.id, characterRow.id);
    }

    const now = new Date().toISOString();
    const insertScene = db.prepare(`
      INSERT INTO scenes (
        drama_id, episode_id, location, time, prompt,
        storyboard_count, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 'draft', ?, ?)
    `);
    const sceneIdByKey = new Map();
    const sceneIdByReference = new Map();
    function registerScene(scene, episodeId) {
      const location = stringValue(scene?.location || scene?.name || scene?.title) || '未命名场景';
      const time = stringValue(scene?.time || scene?.period);
      const key = `${location.toLowerCase()}|${time.toLowerCase()}`;
      let sceneId = sceneIdByKey.get(key);
      if (!sceneId) {
        sceneId = Number(insertScene.run(
          dramaId,
          episodeId || firstEpisodeId || null,
          location,
          time || null,
          stringValue(scene?.prompt || scene?.description || scene?.visual_description) || null,
          now,
          now,
        ).lastInsertRowid);
        sceneIdByKey.set(key, sceneId);
      }
      for (const reference of [scene?.id, scene?.scene_id, scene?.name, scene?.location]) {
        if (stringValue(reference)) sceneIdByReference.set(stringValue(reference).toLowerCase(), sceneId);
      }
      return sceneId;
    }
    for (const scene of firstArray(productionPackage.scene_bible, productionPackage.scenes)) {
      registerScene(scene, firstEpisodeId);
    }

    const propIdByName = new Map();
    const insertProp = db.prepare(`
      INSERT INTO props (
        drama_id, episode_id, name, type, description, prompt,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const prop of firstArray(productionPackage.prop_bible, productionPackage.props)) {
      const name = stringValue(prop?.name || prop?.prop_name);
      if (!name || propIdByName.has(name.toLowerCase())) continue;
      const propId = Number(insertProp.run(
        dramaId,
        firstEpisodeId || null,
        name,
        stringValue(prop?.type || prop?.category) || null,
        stringValue(prop?.description) || null,
        stringValue(prop?.prompt || prop?.appearance) || null,
        now,
        now,
      ).lastInsertRowid);
      propIdByName.set(name.toLowerCase(), propId);
    }

    const insertStoryboard = db.prepare(`
      INSERT INTO storyboards (
        episode_id, scene_id, storyboard_number, title, description,
        location, time, duration, dialogue, action, atmosphere,
        image_prompt, video_prompt, characters, shot_type, angle, movement,
        continuity_snapshot, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `);
    const linkStoryboardProp = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
    let storyboardCount = 0;
    for (const [episodeIndex, episode] of episodes.entries()) {
      const episodeNumber = Number(episode?.episode_number) || episodeIndex + 1;
      const episodeId = episodeIdByNumber.get(episodeNumber) || firstEpisodeId;
      let numberInEpisode = 0;
      for (const [sceneIndex, scene] of firstArray(episode?.scenes).entries()) {
        const reference = stringValue(scene?.scene_id || scene?.id || scene?.name || scene?.location).toLowerCase();
        const sceneId = sceneIdByReference.get(reference)
          || registerScene({
            ...scene,
            name: scene?.name || scene?.location || `第${Number(scene?.scene_number) || sceneIndex + 1}场`,
          }, episodeId);
        const sceneRow = db.prepare('SELECT location, time FROM scenes WHERE id = ?').get(sceneId);
        for (const shot of firstArray(scene?.shots)) {
          numberInEpisode += 1;
          storyboardCount += 1;
          const characterIds = itemNames(shot?.characters || shot?.character_names)
            .map((name) => characterIdByName.get(name.toLowerCase()))
            .filter(Boolean);
          const sourceBasis = shotSourceBasis(shot);
          const continuity = parseObject(shot?.continuity);
          const storyboardId = Number(insertStoryboard.run(
            episodeId,
            sceneId,
            numberInEpisode,
            stringValue(shot?.title) || `镜头${numberInEpisode}`,
            stringValue(shot?.description) || sourceBasis.join('\n') || null,
            stringValue(shot?.location) || sceneRow?.location || null,
            stringValue(shot?.time) || sceneRow?.time || null,
            Number(shot?.duration) || 0,
            formatDialogue(shot?.dialogue) || null,
            stringValue(shot?.action) || null,
            stringValue(shot?.atmosphere) || null,
            stringValue(shot?.image_prompt) || null,
            stringValue(shot?.video_prompt) || null,
            JSON.stringify(characterIds),
            stringValue(shot?.shot_type) || null,
            stringValue(shot?.angle) || null,
            stringValue(shot?.movement || shot?.camera_movement) || null,
            continuity ? JSON.stringify(continuity) : null,
            now,
            now,
          ).lastInsertRowid);
          for (const propName of itemNames(shot?.props || shot?.prop_names)) {
            const propId = propIdByName.get(propName.toLowerCase());
            if (propId) linkStoryboardProp.run(storyboardId, propId);
          }
        }
      }
    }
    db.prepare(`
      UPDATE scenes
      SET storyboard_count = (
        SELECT COUNT(*) FROM storyboards
        WHERE storyboards.scene_id = scenes.id AND storyboards.deleted_at IS NULL
      )
      WHERE drama_id = ?
    `).run(dramaId);
    const totalDuration = episodePayload.reduce((total, episode) => total + Number(episode.duration || 0), 0);
    db.prepare(`
      UPDATE dramas
      SET total_episodes = ?, total_duration = ?, updated_at = ?
      WHERE id = ?
    `).run(episodePayload.length, totalDuration, now, dramaId);

    logger.info('Script analysis package imported to factory', {
      drama_id: dramaId,
      source_project_id: project.id,
      source_version: requestedVersion,
    });
    return {
      created: true,
      drama_id: dramaId,
      title: drama.title,
      source_project_id: project.id,
      source_version: requestedVersion,
      counts: {
        characters: characterRows.length,
        scenes: sceneIdByKey.size,
        props: propIdByName.size,
        episodes: episodeRows.length,
        storyboards: storyboardCount,
      },
    };
  });

  return runImport();
}

module.exports = {
  importApprovedPackageToFactory,
};
