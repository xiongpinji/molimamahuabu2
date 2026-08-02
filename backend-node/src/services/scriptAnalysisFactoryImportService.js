'use strict';

const dramaService = require('./dramaService');

const IMPORT_SCHEMA_VERSION = 'script-analysis-factory-import@1.1';
const LEGACY_IMPORT_SCHEMA_VERSION = 'script-analysis-factory-import@1.0';

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

function shotCharacterReferences(shot) {
  return itemNames(firstArray(shot?.characters, shot?.character_names, shot?.continuity?.characters));
}

function shotPropReferences(shot) {
  return itemNames(firstArray(shot?.props, shot?.prop_names, shot?.continuity?.props));
}

function referenceKeys(item, kind) {
  const values = kind === 'scene'
    ? [item?.id, item?.scene_id, item?.name, item?.title, item?.location]
    : kind === 'character'
      ? [item?.character_id, item?.id, item?.name, item?.character_name]
      : [item?.prop_id, item?.id, item?.name, item?.prop_name];
  const keys = values.map((value) => stringValue(value).toLowerCase()).filter(Boolean);
  if (kind === 'scene' && Number(item?.scene_number) > 0) {
    keys.push(`scene-number:${Number(item.scene_number)}`);
  }
  return [...new Set(keys)];
}

function addReferences(map, item, kind, databaseId) {
  for (const key of referenceKeys(item, kind)) map.set(key, Number(databaseId));
}

function findReference(map, item, kind) {
  for (const key of referenceKeys(item, kind)) {
    const databaseId = map.get(key);
    if (databaseId) return databaseId;
  }
  return null;
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

function repairLegacyImport(db, existing, productionPackage) {
  const metadata = parseObject(existing.metadata);
  const importMetadata = parseObject(metadata?.script_analysis_import);
  if (importMetadata?.schema_version !== LEGACY_IMPORT_SCHEMA_VERSION) return false;

  const dramaId = Number(existing.id);
  const now = new Date().toISOString();
  const rawEpisodes = firstArray(productionPackage.episodes);
  const topLevelShots = firstArray(productionPackage.shots, productionPackage.storyboards);
  const episodes = rawEpisodes.length > 0
    ? rawEpisodes
    : [{ episode_number: 1, scenes: topLevelShots.length ? [{ scene_number: 1, shots: topLevelShots }] : [] }];
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
  const characterIdByReference = new Map(characterIdByName);
  for (const character of firstArray(productionPackage.character_bible, productionPackage.characters)) {
    const characterId = characterIdByName.get(stringValue(character?.name || character?.character_name).toLowerCase());
    if (characterId) addReferences(characterIdByReference, character, 'character', characterId);
  }

  const sceneRows = db.prepare(`
    SELECT id, location, time, prompt FROM scenes
    WHERE drama_id = ? AND deleted_at IS NULL
    ORDER BY id
  `).all(dramaId);
  const sceneIdByReference = new Map();
  for (const scene of firstArray(productionPackage.scene_bible, productionPackage.scenes)) {
    const location = stringValue(scene?.location || scene?.name || scene?.title).toLowerCase();
    const time = stringValue(scene?.time || scene?.period).toLowerCase();
    const sceneRow = sceneRows.find((row) => (
      stringValue(row.location).toLowerCase() === location
      && stringValue(row.time).toLowerCase() === time
    ));
    if (sceneRow) addReferences(sceneIdByReference, scene, 'scene', sceneRow.id);
  }

  const propRows = db.prepare(`
    SELECT id, name FROM props
    WHERE drama_id = ? AND deleted_at IS NULL
  `).all(dramaId);
  const propIdByName = new Map(propRows.map((row) => [stringValue(row.name).toLowerCase(), Number(row.id)]));
  const propIdByReference = new Map(propIdByName);
  for (const prop of firstArray(productionPackage.prop_bible, productionPackage.props)) {
    const propId = propIdByName.get(stringValue(prop?.name || prop?.prop_name).toLowerCase());
    if (propId) addReferences(propIdByReference, prop, 'prop', propId);
  }

  const storyboardsByEpisode = new Map();
  for (const episodeRow of episodeRows) {
    storyboardsByEpisode.set(Number(episodeRow.id), db.prepare(`
      SELECT id, scene_id, storyboard_number FROM storyboards
      WHERE episode_id = ? AND deleted_at IS NULL
      ORDER BY storyboard_number, id
    `).all(episodeRow.id));
  }
  const updateStoryboard = db.prepare(`
    UPDATE storyboards
    SET scene_id = ?, characters = ?, updated_at = ?
    WHERE id = ?
  `);
  const linkStoryboardProp = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
  const softDeleteScene = db.prepare('UPDATE scenes SET deleted_at = ?, updated_at = ? WHERE id = ?');
  const activeStoryboardsForScene = db.prepare(`
    SELECT COUNT(*) AS count FROM storyboards
    WHERE scene_id = ? AND deleted_at IS NULL
  `);

  for (const [episodeIndex, episode] of episodes.entries()) {
    const episodeNumber = Number(episode?.episode_number) || episodeIndex + 1;
    const episodeId = episodeIdByNumber.get(episodeNumber) || firstEpisodeId;
    const storyboardRows = storyboardsByEpisode.get(episodeId) || [];
    let numberInEpisode = 0;
    for (const [sceneIndex, scene] of firstArray(episode?.scenes).entries()) {
      const sceneId = findReference(sceneIdByReference, scene, 'scene');
      const fallbackLocation = `第${Number(scene?.scene_number) || sceneIndex + 1}场`;
      for (const shot of firstArray(scene?.shots)) {
        numberInEpisode += 1;
        const storyboard = storyboardRows.find((row) => Number(row.storyboard_number) === numberInEpisode);
        if (!storyboard) continue;
        const characterIds = shotCharacterReferences(shot)
          .map((reference) => characterIdByReference.get(reference.toLowerCase()))
          .filter(Boolean);
        const previousSceneId = Number(storyboard.scene_id);
        updateStoryboard.run(sceneId || previousSceneId || null, JSON.stringify(characterIds), now, storyboard.id);
        for (const propReference of shotPropReferences(shot)) {
          const propId = propIdByReference.get(propReference.toLowerCase());
          if (propId) linkStoryboardProp.run(storyboard.id, propId);
        }
        if (sceneId && previousSceneId && previousSceneId !== sceneId) {
          const legacyScene = sceneRows.find((row) => Number(row.id) === previousSceneId);
          if (
            legacyScene
            && stringValue(legacyScene.location) === fallbackLocation
            && !stringValue(legacyScene.prompt)
            && Number(activeStoryboardsForScene.get(previousSceneId).count) === 0
          ) {
            softDeleteScene.run(now, now, previousSceneId);
          }
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
  importMetadata.schema_version = IMPORT_SCHEMA_VERSION;
  metadata.script_analysis_import = importMetadata;
  db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(metadata), now, dramaId);
  return true;
}

function findExistingImport(db, userId, tenantId, importKey) {
  const tenantClause = tenantId == null ? 'tenant_id IS NULL' : 'tenant_id = ?';
  const params = tenantId == null
    ? [String(userId), importKey]
    : [String(userId), String(tenantId), importKey];
  return db.prepare(`
    SELECT id, title, metadata
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
      const repaired = repairLegacyImport(db, existing, productionPackage);
      return {
        created: false,
        repaired,
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
        schema_version: IMPORT_SCHEMA_VERSION,
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
    const characterIdByReference = new Map(characterIdByName);
    for (const character of characterSource) {
      const characterId = characterIdByName.get(stringValue(character?.name || character?.character_name).toLowerCase());
      if (characterId) addReferences(characterIdByReference, character, 'character', characterId);
    }
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
      addReferences(sceneIdByReference, scene, 'scene', sceneId);
      return sceneId;
    }
    for (const scene of firstArray(productionPackage.scene_bible, productionPackage.scenes)) {
      registerScene(scene, firstEpisodeId);
    }

    const propIdByReference = new Map();
    let propCount = 0;
    const insertProp = db.prepare(`
      INSERT INTO props (
        drama_id, episode_id, name, type, description, prompt,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const prop of firstArray(productionPackage.prop_bible, productionPackage.props)) {
      const name = stringValue(prop?.name || prop?.prop_name);
      if (!name || propIdByReference.has(name.toLowerCase())) continue;
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
      addReferences(propIdByReference, prop, 'prop', propId);
      propCount += 1;
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
        const sceneId = findReference(sceneIdByReference, scene, 'scene')
          || registerScene({
            ...scene,
            name: scene?.name || scene?.location || `第${Number(scene?.scene_number) || sceneIndex + 1}场`,
          }, episodeId);
        const sceneRow = db.prepare('SELECT location, time FROM scenes WHERE id = ?').get(sceneId);
        for (const shot of firstArray(scene?.shots)) {
          numberInEpisode += 1;
          storyboardCount += 1;
          const characterIds = shotCharacterReferences(shot)
            .map((reference) => characterIdByReference.get(reference.toLowerCase()))
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
          for (const propReference of shotPropReferences(shot)) {
            const propId = propIdByReference.get(propReference.toLowerCase());
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
        props: propCount,
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
