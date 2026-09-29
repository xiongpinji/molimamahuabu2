'use strict';

/**
 * 样片转绘 → 短剧工厂导入。
 *
 * 只新增数据：通过 dramaService 已有的公开写法（createDrama / saveCharacters / saveEpisodes）
 * 创建一个全新的工厂项目，场景、道具、分镜按工厂现有表结构插入。不修改任何已有项目，
 * 也不改动短剧工厂与剧本分析导入的代码路径。导入后由工厂自己的一键流程补生成图片与视频。
 *
 * 幂等：dramas.metadata.redraw_import.import_key = redraw:{workId}:version:{versionId}:facts:{hash}，
 * 完全转绘版本再加 :package:{生产包版本}。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dramaService = require('./dramaService');
const storageLayout = require('./storageLayout');
const { buildRedrawFactoryPackage } = require('./redrawFactoryPackageAdapter');
const { stageReferenceClips, registerStagedReferenceClips } = require('./redrawStoryboardReferenceClipService');
const voiceLock = require('./storyboardVoiceLockService');

const IMPORT_SCHEMA_VERSION = 'redraw-factory-import@1';
// 完全转绘生产包的版本：生产包内容一变就加 1，旧版本号的导入不再复用，重新导入会建新项目。
// 2：带目标语言台词、去掉字幕描述、不提交原片参考；3：分镜地点与时间改用本地化场景；4：剧集剧本用本地化剧情梗概；
// 5：台词补全说话人、标出定音镜头并开启首次对白音色自动沿用；6：说话人只按原文完全相同的画面内对白补，不再按单一说话人推断。
const FULL_LOCALIZATION_PACKAGE_VERSION = 6;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function silentLogger(log) {
  return {
    info: typeof log?.info === 'function' ? log.info.bind(log) : () => {},
    warn: typeof log?.warn === 'function' ? log.warn.bind(log) : () => {},
    error: typeof log?.error === 'function' ? log.error.bind(log) : () => {},
  };
}

function findExistingImport(db, owner, importKey) {
  const tenantClause = owner.tenantId == null ? 'tenant_id IS NULL' : 'tenant_id = ?';
  const params = owner.tenantId == null
    ? [owner.userId, importKey]
    : [owner.userId, owner.tenantId, importKey];
  return db.prepare(`
    SELECT id, title FROM dramas
    WHERE user_id = ? AND ${tenantClause} AND deleted_at IS NULL
      AND json_valid(metadata) = 1
      AND json_extract(metadata, '$.redraw_import.import_key') = ?
    ORDER BY id ASC LIMIT 1
  `).get(...params);
}

const FACTORY_LOCALIZATION_MARKER = '%"factory_localization@1"%';

function loadRedrawSource(db, owner, workId, _storageRoot = null, { localizedVersionId = null } = {}) {
  const work = db.prepare(`
    SELECT w.*, p.title AS project_title
    FROM redraw_works w
    LEFT JOIN redraw_projects p ON p.id = w.project_id AND p.tenant_id = w.tenant_id AND p.user_id = w.user_id
    WHERE w.id = ? AND w.tenant_id = ? AND w.user_id = ?
  `).get(Number(workId), owner.tenantId, owner.userId);
  if (!work) throw codedError('REDRAW_WORK_NOT_FOUND', '转绘作品不存在');
  const sourceVersion = db.prepare(`
    SELECT * FROM redraw_versions
    WHERE work_id = ? AND tenant_id = ? AND user_id = ? AND locale = 'source'
      AND source_facts_json IS NOT NULL AND TRIM(source_facts_json) != '' AND deleted_at IS NULL
    ORDER BY id ASC LIMIT 1
  `).get(work.id, owner.tenantId, owner.userId);
  const sourceFacts = parseJson(sourceVersion?.source_facts_json, null);
  if (!sourceFacts || sourceFacts.schema_version !== '2.0') {
    throw codedError('REDRAW_FACTORY_ANALYSIS_REQUIRED', '请先完成样片分析');
  }
  const analysisTask = work.task_id
    ? db.prepare(`
      SELECT metadata FROM async_tasks
      WHERE id = ? AND type = 'redraw_analysis' AND tenant_id = ? AND user_id = ? AND status = 'completed'
    `).get(String(work.task_id), owner.tenantId, owner.userId)
    : null;
  if (!analysisTask) throw codedError('REDRAW_FACTORY_ANALYSIS_REQUIRED', '请先完成样片分析');
  const analysisSettings = parseJson(analysisTask.metadata, {})?.redraw_analysis || {};
  const style = resolveStyle(db, owner, analysisSettings);
  // 指定了「完全转绘」版本就用它（目标国家的名字、形象、台词、场景）；
  // 否则沿用旧流水线已有的本地化版本（若有），完全转绘版本只在明确选择时使用。
  const localizedVersion = localizedVersionId
    ? db.prepare(`
      SELECT * FROM redraw_versions
      WHERE id = ? AND work_id = ? AND tenant_id = ? AND user_id = ? AND facts_hash = ?
        AND status = 'asset_review' AND deleted_at IS NULL
    `).get(Number(localizedVersionId), work.id, owner.tenantId, owner.userId, sourceVersion.facts_hash)
    : db.prepare(`
      SELECT * FROM redraw_versions
      WHERE work_id = ? AND tenant_id = ? AND user_id = ? AND COALESCE(locale, '') != 'source'
        AND facts_hash = ? AND status NOT IN ('draft', 'failed') AND deleted_at IS NULL
        AND COALESCE(localization_model_snapshot_json, '') NOT LIKE ?
      ORDER BY version DESC, id DESC LIMIT 1
    `).get(work.id, owner.tenantId, owner.userId, sourceVersion.facts_hash, FACTORY_LOCALIZATION_MARKER);
  if (localizedVersionId && !localizedVersion) {
    throw codedError('REDRAW_FACTORY_LOCALIZATION_NOT_READY', '转绘本地化版本不存在或还没完成');
  }
  return { work, sourceVersion, sourceFacts, analysisSettings, style, localizedVersion };
}

function resolveStyle(db, owner, analysisSettings) {
  // 分析设置里风格二选一：自由风格直接用；预设按 id 取出正、负向提示词模板。
  const freeStyle = analysisSettings?.free_style;
  if (freeStyle && typeof freeStyle === 'object') {
    return { positive: text(freeStyle.positive), negative: text(freeStyle.negative) };
  }
  const presetId = Number(analysisSettings?.style_preset_id);
  if (!Number.isInteger(presetId) || presetId <= 0) return { positive: '', negative: '' };
  const preset = db.prepare(`
    SELECT prompt_template, negative_prompt_template FROM redraw_style_presets
    WHERE id = ? AND deleted_at IS NULL AND (tenant_id IS NULL OR tenant_id = '' OR tenant_id = ?)
  `).get(presetId, owner.tenantId);
  return {
    positive: text(preset?.prompt_template),
    negative: text(preset?.negative_prompt_template),
  };
}

function localizationOf(version) {
  if (!version) return null;
  return {
    locale: version.locale,
    market: version.market,
    name_map: parseJson(version.name_map_json, {}),
    text_map: parseJson(version.text_map_json, {}),
    glossary: parseJson(version.glossary_json, {}),
    culture_map: parseJson(version.culture_map_json, {}),
  };
}

function characterImagesOf(db, owner, version) {
  // 转绘阶段已经生成且可读的角色图直接带入工厂，工厂一键流程会跳过已有角色图。
  if (!version) return {};
  const rows = db.prepare(`
    SELECT ra.source_ref_json, a.url, a.local_path
    FROM redraw_assets ra
    JOIN assets a ON a.id = ra.asset_id AND a.deleted_at IS NULL
    WHERE ra.version_id = ? AND ra.tenant_id = ? AND ra.user_id = ? AND ra.kind = 'character'
      AND ra.status = 'generated' AND ra.deleted_at IS NULL
  `).all(version.id, owner.tenantId, owner.userId);
  const images = {};
  for (const row of rows) {
    const ref = parseJson(row.source_ref_json, {})?.source_ref || {};
    const key = text(ref.source_character_key || ref.stable_id || ref.id);
    if (key) images[key] = { image_url: text(row.url), local_path: text(row.local_path) };
  }
  return images;
}

function copyCharacterImagesIntoProject(db, storageRoot, dramaId, productionPackage, { prefix = 'redraw' } = {}) {
  // 工厂按 projects/{drama}/… 路径做静态资源归属校验；转绘角色图复制到新项目的 characters 目录，
  // 不改工厂的访问规则，也不移动转绘原文件。复制失败的角色只是不带图，工厂会自己补生成。
  if (!storageRoot) return [];
  const root = path.resolve(storageRoot);
  const projectDir = `${storageLayout.getProjectStorageSubdir(db, dramaId)}/characters`;
  const copied = [];
  for (const character of productionPackage.characters) {
    const sourceRel = text(character.local_path);
    delete character.local_path;
    delete character.image_url;
    if (!sourceRel || path.isAbsolute(sourceRel)) continue;
    const sourceAbs = path.resolve(root, sourceRel);
    if (!sourceAbs.startsWith(root + path.sep) || !fs.existsSync(sourceAbs)) continue;
    let targetRel = `${projectDir}/${prefix}_${character.character_id}_${path.basename(sourceRel)}`;
    for (let n = 2; fs.existsSync(path.resolve(root, targetRel)); n += 1) {
      targetRel = `${projectDir}/${prefix}_${character.character_id}_${n}_${path.basename(sourceRel)}`;
    }
    const targetAbs = path.resolve(root, targetRel);
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
    fs.copyFileSync(sourceAbs, targetAbs);
    character.local_path = targetRel;
    character.image_url = `/static/${targetRel}`;
    copied.push(targetAbs);
  }
  return copied;
}

function insertFactoryRows(db, logger, dramaId, productionPackage) {
  const now = new Date().toISOString();
  const episode = productionPackage.episodes[0];
  dramaService.saveCharacters(db, logger, dramaId, { characters: productionPackage.characters });
  dramaService.saveEpisodes(db, logger, dramaId, {
    episodes: [{
      episode_number: 1,
      title: episode.title,
      script_content: episodeScript(productionPackage),
      description: episode.description,
      duration: totalDuration(productionPackage),
    }],
  });
  const episodeId = Number(db.prepare(`
    SELECT id FROM episodes WHERE drama_id = ? AND episode_number = 1 AND deleted_at IS NULL
  `).get(dramaId).id);

  const characterIdByKey = new Map();
  for (const character of productionPackage.characters) {
    const row = db.prepare('SELECT id FROM characters WHERE drama_id = ? AND name = ? AND deleted_at IS NULL')
      .get(dramaId, character.name);
    if (row) characterIdByKey.set(character.character_id, Number(row.id));
  }
  const linkCharacter = db.prepare('INSERT OR IGNORE INTO episode_characters (episode_id, character_id) VALUES (?, ?)');
  for (const characterId of characterIdByKey.values()) linkCharacter.run(episodeId, characterId);

  const sceneIdByKey = new Map();
  const insertScene = db.prepare(`
    INSERT INTO scenes (drama_id, episode_id, location, time, prompt, storyboard_count, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 'draft', ?, ?)
  `);
  for (const scene of productionPackage.scenes) {
    sceneIdByKey.set(scene.scene_id, Number(insertScene.run(
      dramaId, episodeId, scene.location, scene.time || null, scene.prompt || null, now, now,
    ).lastInsertRowid));
  }

  const propIdByKey = new Map();
  const insertProp = db.prepare(`
    INSERT INTO props (drama_id, episode_id, name, type, description, prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const prop of productionPackage.props) {
    propIdByKey.set(prop.prop_id, Number(insertProp.run(
      dramaId, episodeId, prop.name, prop.type, prop.description || null, prop.prompt || null, now, now,
    ).lastInsertRowid));
  }

  const { storyboardNumber, storyboardSources } = insertStoryboards(db, {
    episodeId, episode, sceneIdByKey, characterIdByKey, propIdByKey, now,
  });
  db.prepare(`
    UPDATE scenes SET storyboard_count = (
      SELECT COUNT(*) FROM storyboards WHERE storyboards.scene_id = scenes.id AND storyboards.deleted_at IS NULL
    ) WHERE drama_id = ?
  `).run(dramaId);
  db.prepare('UPDATE dramas SET total_episodes = 1, total_duration = ?, updated_at = ? WHERE id = ?')
    .run(totalDuration(productionPackage), now, dramaId);
  return {
    counts: {
      characters: characterIdByKey.size,
      scenes: sceneIdByKey.size,
      props: propIdByKey.size,
      episodes: 1,
      storyboards: storyboardNumber,
    },
    storyboardSources,
    characterIdByKey,
    episodeId,
  };
}

function insertStoryboards(db, { episodeId, episode, sceneIdByKey, characterIdByKey, propIdByKey, now }) {
  const insertStoryboard = db.prepare(`
    INSERT INTO storyboards (
      episode_id, scene_id, storyboard_number, title, description, location, time, duration,
      dialogue, action, image_prompt, video_prompt, characters, shot_type, movement, continuity_snapshot,
      creation_mode, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'universal', 'draft', ?, ?)
  `);
  const linkProp = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
  let storyboardNumber = 0;
  const storyboardSources = [];
  for (const group of episode.scenes) {
    const sceneId = sceneIdByKey.get(group.scene_id) || null;
    for (const shot of group.shots) {
      storyboardNumber += 1;
      const storyboardId = Number(insertStoryboard.run(
        episodeId,
        sceneId,
        storyboardNumber,
        shot.title,
        shot.description || null,
        group.location || null,
        group.time || null,
        shot.duration,
        shot.dialogue || null,
        shot.action || null,
        shot.image_prompt || null,
        shot.video_prompt || null,
        JSON.stringify(shot.characters.map((key) => characterIdByKey.get(key)).filter(Boolean)),
        shot.shot_type || null,
        shot.movement || null,
        JSON.stringify(shot.continuity),
        now,
        now,
      ).lastInsertRowid);
      for (const key of shot.props) {
        const propId = propIdByKey.get(key);
        if (propId) linkProp.run(storyboardId, propId);
      }
      storyboardSources.push({
        storyboardId,
        storyboardNumber,
        sourceShotId: shot.continuity.source_shot_id,
        startMs: shot.continuity.start_ms,
        endMs: shot.continuity.end_ms,
      });
    }
  }
  return { storyboardNumber, storyboardSources };
}

// ---------- 整部剧：追加集 ----------

function seriesOf(metadata) {
  const series = metadata?.redraw_series;
  return series && typeof series === 'object' ? series : null;
}

function normalizedName(value) {
  return text(value).toLowerCase().replace(/[\s　]+/g, '');
}

function seriesKeyOf(character) {
  return text(character?.source_name) || text(character?.display_name) || text(character?.id);
}

function activeCharacterRow(db, dramaId, characterId) {
  const id = Number(characterId);
  if (!(id > 0)) return null;
  return db.prepare('SELECT id, name, seedance2_voice_asset FROM characters WHERE id = ? AND drama_id = ? AND deleted_at IS NULL')
    .get(id, dramaId) || null;
}

function firstLiveEpisode(db, dramaId) {
  return db.prepare('SELECT id, episode_number FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number ASC, id ASC LIMIT 1')
    .get(dramaId) || null;
}

/**
 * R72 之前完全转绘导入的项目没有全剧档案：按它的导入记录（源作品 + 完全转绘版本）补一份，
 * 让已经做好的第 1 集项目（角色图、音色都在）也能追加后面的集。withCharacters 为 false 时只取概要（列表用）。
 */
function seriesFromImport(db, owner, drama, metadata, { storageRoot = null, withCharacters = false } = {}) {
  const imported = metadata?.redraw_import;
  if (!imported?.full_localization_package || !Number(imported.source_work_id) || !Number(imported.localized_version_id)) return null;
  const work = db.prepare('SELECT id, project_id FROM redraw_works WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(Number(imported.source_work_id), owner.tenantId, owner.userId);
  const episode = firstLiveEpisode(db, Number(drama.id));
  if (!work?.project_id) return null;
  const series = {
    project_id: Number(work.project_id),
    locale: text(imported.locale) || null,
    market: text(imported.market) || null,
    characters: {},
    episodes: episode ? [{
      work_id: Number(work.id), episode_id: Number(episode.id), episode_number: Number(episode.episode_number), import_key: text(imported.import_key),
    }] : [],
  };
  if (!withCharacters) return series;
  const source = loadRedrawSource(db, owner, work.id, storageRoot, { localizedVersionId: Number(imported.localized_version_id) });
  const names = parseJson(source.localizedVersion?.name_map_json, {}) || {};
  const byName = db.prepare('SELECT id FROM characters WHERE drama_id = ? AND name = ? AND deleted_at IS NULL ORDER BY id ASC LIMIT 1');
  for (const character of Array.isArray(source.sourceFacts?.characters) ? source.sourceFacts.characters : []) {
    const name = text(names[text(character?.id)]);
    const row = name ? byName.get(Number(drama.id), name) : null;
    const key = seriesKeyOf(character);
    if (row && key && !series.characters[key]) series.characters[key] = { character_id: Number(row.id), name };
  }
  return series;
}

/** 追加目标必须是同一转绘项目（同一部剧）、同一目标国家完全转绘导入的工厂项目。 */
function loadSeriesTarget(db, owner, targetDramaId, work, localizedVersion, storageRoot) {
  const drama = db.prepare('SELECT * FROM dramas WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(Number(targetDramaId), owner.tenantId, owner.userId);
  const metadata = parseJson(drama?.metadata, {}) || {};
  let series = null;
  if (drama) {
    try {
      series = seriesOf(metadata) || seriesFromImport(db, owner, drama, metadata, { storageRoot, withCharacters: true });
    } catch (_) {
      series = null;
    }
  }
  if (!series || Number(series.project_id) !== Number(work.project_id)) {
    throw codedError('REDRAW_SERIES_TARGET_INVALID', '只能追加到同一部剧（同一转绘项目）完全转绘导入的短剧工厂项目');
  }
  if (text(series.locale) !== text(localizedVersion?.locale) || text(series.market) !== text(localizedVersion?.market)) {
    throw codedError('REDRAW_SERIES_TARGET_INVALID', '该短剧工厂项目是按另一个目标国家转绘的，不能追加');
  }
  return { drama, metadata, series };
}

function seriesCharacterRow(db, dramaId, series, key) {
  return activeCharacterRow(db, dramaId, series?.characters?.[key]?.character_id);
}

/** 本集里已经在前几集定过音的老角色（源角色 id），这些角色本集不再标定音镜头。 */
function voicedSourceCharacterIds(db, dramaId, series, sourceFacts) {
  const ids = [];
  for (const character of Array.isArray(sourceFacts?.characters) ? sourceFacts.characters : []) {
    const row = seriesCharacterRow(db, dramaId, series, seriesKeyOf(character));
    const asset = parseJson(row?.seedance2_voice_asset, null);
    if (String(asset?.status || '').toLowerCase() === 'active' && text(asset?.url)) ids.push(text(character.id));
  }
  return ids;
}

/** 这个作品在全剧档案里、且工厂里那一集还在的记录（集号以工厂当前为准）；那一集被删掉了就当没导入过。 */
function liveSeriesEpisode(db, dramaId, series, workId) {
  const entry = (Array.isArray(series?.episodes) ? series.episodes : [])
    .find((item) => Number(item?.work_id) === Number(workId));
  if (!entry) return null;
  const alive = db.prepare('SELECT episode_number FROM episodes WHERE id = ? AND drama_id = ? AND deleted_at IS NULL')
    .get(Number(entry.episode_id), dramaId);
  return alive ? { ...entry, episode_number: Number(alive.episode_number) } : null;
}

// 新角色不能和项目里已有角色同名：工厂按名字认台词的说话人和音色，同名会把两个人当成一个。
function assertFreshNamesFree(db, dramaId, fresh) {
  const taken = new Set(db.prepare('SELECT name FROM characters WHERE drama_id = ? AND deleted_at IS NULL').all(dramaId)
    .map((row) => normalizedName(row.name)).filter(Boolean));
  const clash = fresh.find((character) => taken.has(normalizedName(character.name)));
  if (clash) {
    throw codedError('REDRAW_SERIES_NAME_CONFLICT',
      `本集的新角色「${clash.name}」和该短剧工厂项目里已有的角色重名，不能追加。可以先在短剧工厂里给已有角色改名，或选择新建项目导入`);
  }
}

/**
 * 把一集追加到已有工厂项目，作为第 N 集：
 * - 老角色按全剧角色键（原名）映射到已有角色，角色图和音色随之沿用；新角色才新建。
 * - 场景每集一份（工厂按集列场景）；前几集有同一地点同一时间且已出图的，直接沿用那张场景图。
 * - 道具按名字复用（工厂按分镜关联列出本集道具）。
 * 不改动已有的集和老角色：不调用会删掉其它集的 saveEpisodes，也不调用会按名字改写已有角色的 saveCharacters。
 */
function appendFactoryEpisode(db, dramaId, productionPackage, series, { storageRoot, copiedFiles }) {
  const now = new Date().toISOString();
  const episode = productionPackage.episodes[0];
  const episodeNumber = Number(db.prepare('SELECT MAX(episode_number) AS n FROM episodes WHERE drama_id = ? AND deleted_at IS NULL')
    .get(dramaId)?.n || 0) + 1;

  const characterIdByKey = new Map();
  const reused = [];
  const fresh = [];
  for (const character of productionPackage.characters) {
    const row = seriesCharacterRow(db, dramaId, series, character.series_key);
    if (row) {
      characterIdByKey.set(character.character_id, Number(row.id));
      reused.push(text(row.name) || character.name);
    } else {
      fresh.push(character);
    }
  }
  assertFreshNamesFree(db, dramaId, fresh);

  const episodeId = Number(db.prepare(`
    INSERT INTO episodes (drama_id, episode_number, title, script_content, description, duration, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `).run(dramaId, episodeNumber, `第 ${episodeNumber} 集`, episodeScript(productionPackage), episode.description || null,
    totalDuration(productionPackage), now, now).lastInsertRowid);

  if (fresh.length) {
    copiedFiles.push(...copyCharacterImagesIntoProject(db, storageRoot, dramaId, { characters: fresh }, { prefix: `redraw_ep${episodeNumber}` }));
    const insertCharacter = db.prepare(`
      INSERT INTO characters (drama_id, name, role, description, personality, appearance, image_url, local_path, negative_prompt,
        sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);
    // 本集内两个条目同名时和首集导入一样合并成一个角色。
    const insertedByName = new Map();
    for (const character of fresh) {
      const key = normalizedName(character.name);
      if (!insertedByName.has(key)) {
        insertedByName.set(key, Number(insertCharacter.run(
          dramaId, character.name, character.role ?? null, character.description ?? null, character.personality ?? null,
          character.appearance ?? null, character.image_url ?? null, character.local_path ?? null, character.negative_prompt ?? null,
          now, now,
        ).lastInsertRowid));
      }
      characterIdByKey.set(character.character_id, insertedByName.get(key));
    }
  }
  const linkCharacter = db.prepare('INSERT OR IGNORE INTO episode_characters (episode_id, character_id) VALUES (?, ?)');
  for (const characterId of new Set(characterIdByKey.values())) linkCharacter.run(episodeId, characterId);

  const sceneIdByKey = new Map();
  let reusedSceneImages = 0;
  const insertScene = db.prepare(`
    INSERT INTO scenes (drama_id, episode_id, location, time, prompt, image_url, local_path, storyboard_count, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);
  const earlierScene = db.prepare(`
    SELECT image_url, local_path, status FROM scenes
    WHERE drama_id = ? AND location = ? AND COALESCE(time, '') = ? AND deleted_at IS NULL
      AND (COALESCE(local_path, '') != '' OR COALESCE(image_url, '') != '')
    ORDER BY id ASC LIMIT 1
  `);
  for (const scene of productionPackage.scenes) {
    const same = text(scene.location) ? earlierScene.get(dramaId, scene.location, text(scene.time)) : null;
    if (same) reusedSceneImages += 1;
    sceneIdByKey.set(scene.scene_id, Number(insertScene.run(
      dramaId, episodeId, scene.location, scene.time || null, scene.prompt || null,
      same?.image_url || null, same?.local_path || null, same ? (text(same.status) || 'generated') : 'draft', now, now,
    ).lastInsertRowid));
  }

  const propIdByKey = new Map();
  let reusedProps = 0;
  const insertProp = db.prepare(`
    INSERT INTO props (drama_id, episode_id, name, type, description, prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const sameProp = db.prepare('SELECT id FROM props WHERE drama_id = ? AND name = ? AND deleted_at IS NULL ORDER BY id ASC LIMIT 1');
  for (const prop of productionPackage.props) {
    const same = sameProp.get(dramaId, prop.name);
    if (same) reusedProps += 1;
    propIdByKey.set(prop.prop_id, same ? Number(same.id) : Number(insertProp.run(
      dramaId, episodeId, prop.name, prop.type, prop.description || null, prop.prompt || null, now, now,
    ).lastInsertRowid));
  }

  const { storyboardNumber, storyboardSources } = insertStoryboards(db, {
    episodeId, episode, sceneIdByKey, characterIdByKey, propIdByKey, now,
  });
  // 老角色已有音色：新分镜写好音色快照，生成时直接带上他在前几集的声音。
  for (const item of storyboardSources) voiceLock.refreshStoryboardVoiceSnapshot(db, item.storyboardId);
  db.prepare(`
    UPDATE scenes SET storyboard_count = (
      SELECT COUNT(*) FROM storyboards WHERE storyboards.scene_id = scenes.id AND storyboards.deleted_at IS NULL
    ) WHERE drama_id = ?
  `).run(dramaId);
  const totals = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(duration), 0) AS d FROM episodes WHERE drama_id = ? AND deleted_at IS NULL')
    .get(dramaId);
  db.prepare('UPDATE dramas SET total_episodes = ?, total_duration = ?, updated_at = ? WHERE id = ?')
    .run(Number(totals.n), Number(totals.d), now, dramaId);
  return {
    episodeId,
    episodeNumber,
    counts: {
      characters: new Set(characterIdByKey.values()).size,
      reused_characters: reused.length,
      new_characters: fresh.length,
      scenes: sceneIdByKey.size,
      reused_scene_images: reusedSceneImages,
      props: propIdByKey.size,
      reused_props: reusedProps,
      storyboards: storyboardNumber,
    },
    reused_character_names: reused,
    new_character_names: fresh.map((character) => character.name),
    storyboardSources,
    characterIdByKey,
  };
}

/** 把本集的角色和集号记进工厂项目的全剧档案（metadata.redraw_series），后面的集按它认人。 */
function recordSeriesEpisode(db, dramaId, {
  work, productionPackage, characterIdByKey, episodeId, episodeNumber, importKey, locale, market, base = null,
}) {
  const drama = db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(dramaId);
  const metadata = parseJson(drama?.metadata, {}) || {};
  const previous = seriesOf(metadata) || base || {};
  const series = {
    project_id: Number(work.project_id),
    locale: previous.locale || locale || null,
    market: previous.market || market || null,
    characters: { ...(previous.characters || {}) },
    // 同一作品只留最新一条（旧的那集已从工厂删掉才会重新追加）。
    episodes: (Array.isArray(previous.episodes) ? previous.episodes : []).filter((item) => Number(item?.work_id) !== Number(work.id)),
  };
  for (const character of productionPackage.characters) {
    const characterId = characterIdByKey.get(character.character_id);
    const current = series.characters[character.series_key];
    // 档案里还没有这个人，或档案指向的角色已被删掉，就记成本集的角色。
    if (characterId && character.series_key && (!current || !activeCharacterRow(db, dramaId, current.character_id))) {
      series.characters[character.series_key] = { character_id: characterId, name: character.name };
    }
  }
  series.episodes.push({
    work_id: Number(work.id),
    episode_id: Number(episodeId),
    episode_number: Number(episodeNumber),
    import_key: importKey,
    voice_casting: productionPackage.voice_casting || [],
  });
  db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify({ ...metadata, redraw_series: series }), new Date().toISOString(), dramaId);
  return series;
}

function totalDuration(productionPackage) {
  return productionPackage.episodes[0].scenes
    .reduce((sum, group) => sum + group.shots.reduce((inner, shot) => inner + Number(shot.duration || 0), 0), 0);
}

function episodeScript(productionPackage) {
  const lines = [];
  if (productionPackage.normalized_script.summary) lines.push(productionPackage.normalized_script.summary, '');
  let shotNumber = 0;
  for (const group of productionPackage.episodes[0].scenes) {
    lines.push(`【${group.location || group.scene_id}${group.time ? ` · ${group.time}` : ''}】`);
    for (const shot of group.shots) {
      shotNumber += 1;
      lines.push(`镜头${shotNumber}：${shot.description}${shot.action ? ` ${shot.action}` : ''}`);
      if (shot.dialogue) lines.push(shot.dialogue);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function existingResult(existing, importKey) {
  return { created: false, drama_id: Number(existing.id), title: existing.title, import_key: importKey };
}

async function stageClipsForSource(db, logger, source, productionPackage, storageRoot, stagingDir) {
  if (!storageRoot || !source.work.source_asset_id) return new Map();
  const sourceAsset = db.prepare('SELECT local_path FROM assets WHERE id = ? AND deleted_at IS NULL')
    .get(Number(source.work.source_asset_id));
  const shots = productionPackage.episodes[0].scenes.flatMap((group) => group.shots.map((shot) => ({
    sourceShotId: shot.continuity.source_shot_id,
    startMs: shot.continuity.start_ms,
    endMs: shot.continuity.end_ms,
  })));
  try {
    return await stageReferenceClips({
      storageRoot,
      sourceAsset,
      sourceDurationMs: Number(source.work.duration_ms || source.sourceFacts.duration_ms || 0),
      stagingDir,
    }, shots);
  } catch (error) {
    // 样片文件不在本机（例如跨环境迁移）时仍导入剧本与资产，只是不带分镜参考片段。
    if (error?.code !== 'REDRAW_REFERENCE_SOURCE_UNREADABLE') throw error;
    logger.warn('Redraw sample unavailable; importing without reference clips', { work_id: source.work.id });
    return new Map();
  }
}

async function importRedrawWorkToFactory(db, log, {
  workId, tenantId, userId, propIds = null, storageRoot = null, localizedVersionId = null, targetDramaId = null,
}) {
  const owner = { tenantId: text(tenantId), userId: text(userId) };
  if (!owner.tenantId || !owner.userId) throw codedError('REDRAW_OWNER_REQUIRED', '缺少租户或用户身份');
  const logger = silentLogger(log);

  const source = loadRedrawSource(db, owner, workId, storageRoot, { localizedVersionId });
  const fullLocalization = Boolean(localizedVersionId && source.localizedVersion);
  const importKey = `redraw:${source.work.id}:version:${source.localizedVersion?.id || source.sourceVersion.id}:facts:${source.sourceVersion.facts_hash}`
    + (fullLocalization ? `:package:${FULL_LOCALIZATION_PACKAGE_VERSION}` : '');
  if (targetDramaId) {
    if (!fullLocalization) throw codedError('REDRAW_SERIES_TARGET_INVALID', '追加到已有项目只支持完全转绘版本');
    return appendRedrawWorkToSeries(db, logger, { owner, source, importKey, targetDramaId, propIds, storageRoot });
  }
  const existingBefore = findExistingImport(db, owner, importKey);
  if (existingBefore) return existingResult(existingBefore, importKey);

  const title = text(source.work.project_title) || `样片转绘 #${source.work.id}`;
  const productionPackage = buildRedrawFactoryPackage({
    sourceFacts: source.sourceFacts,
    localization: localizationOf(source.localizedVersion),
    analysisSettings: { ...source.analysisSettings, free_style: source.style },
    title,
    characterImages: characterImagesOf(db, owner, source.localizedVersion),
    propIds,
  });

  // 切片耗时较长：先在事务外异步切好，事务内只做复制与插入，避免阻塞事件循环和长时间持有 SQLite 写锁。
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-factory-import-'));
  const copiedFiles = [];
  try {
    const staged = await stageClipsForSource(db, logger, source, productionPackage, storageRoot, stagingDir);
    return db.transaction(() => {
      const existing = findExistingImport(db, owner, importKey);
      if (existing) return existingResult(existing, importKey);
      const drama = dramaService.createDrama(db, logger, {
        title,
        description: productionPackage.normalized_script.logline || null,
        metadata: {
          project_type: 'factory',
          aspect_ratio: text(source.analysisSettings.aspect_ratio) || undefined,
          // 分镜以全能参考模式导入，并默认提交对应样片片段作参考视频、使用模型原生音频（不烧字幕）。
          // 完全转绘换了国家与演员：原片片段会把原演员长相和硬字幕带进新视频，默认不提交（片段仍登记，可手动打开）。
          storyboard_universal_omni: true,
          video_use_storyboard_reference_video: !fullLocalization,
          video_native_audio: true,
          merge_trim_to_storyboard_duration: true,
          // 定音镜头生成后，后台从中提取角色音色，之后该角色的镜头自动沿用（redrawVoiceAutoBindService）。
          voice_auto_bind: true,
          redraw_import: {
            schema_version: IMPORT_SCHEMA_VERSION,
            import_key: importKey,
            source_work_id: Number(source.work.id),
            source_version_id: Number(source.sourceVersion.id),
            localized_version_id: source.localizedVersion ? Number(source.localizedVersion.id) : null,
            locale: source.localizedVersion?.locale || null,
            market: source.localizedVersion?.market || null,
            full_localization_package: fullLocalization ? FULL_LOCALIZATION_PACKAGE_VERSION : null,
            facts_hash: source.sourceVersion.facts_hash,
            style_preset_id: Number(source.analysisSettings.style_preset_id) || null,
            style_prompt: source.style.positive || null,
            negative_prompt: source.style.negative || null,
            locked_facts: productionPackage.source.locked_facts,
            continuity_rules: productionPackage.continuity_rules,
            voice_casting: productionPackage.voice_casting,
            imported_at: new Date().toISOString(),
          },
        },
        user_id: owner.userId,
        tenant_id: owner.tenantId,
      });
      copiedFiles.push(...copyCharacterImagesIntoProject(db, storageRoot, Number(drama.id), productionPackage));
      const { counts, storyboardSources, characterIdByKey, episodeId } = insertFactoryRows(db, logger, Number(drama.id), productionPackage);
      // 整部剧：完全转绘导入的项目建全剧档案，同一部剧后面的集可以追加进来。
      if (fullLocalization && source.work.project_id) {
        recordSeriesEpisode(db, Number(drama.id), {
          work: source.work, productionPackage, characterIdByKey, episodeId, episodeNumber: 1, importKey,
          locale: source.localizedVersion.locale, market: source.localizedVersion.market,
        });
      }
      const clips = storageRoot
        ? registerStagedReferenceClips({ db, storageRoot, dramaId: Number(drama.id) }, staged, storyboardSources)
        : { created: [], files: [] };
      copiedFiles.push(...clips.files);
      logger.info('Redraw work imported to factory', { drama_id: drama.id, work_id: source.work.id });
      return {
        created: true,
        drama_id: Number(drama.id),
        title: drama.title,
        import_key: importKey,
        counts: { ...counts, reference_clips: clips.created.length },
      };
    })();
  } catch (error) {
    for (const file of copiedFiles) {
      try { fs.rmSync(file, { force: true }); } catch (_) { /* best effort */ }
    }
    throw error;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function appendRedrawWorkToSeries(db, logger, { owner, source, importKey, targetDramaId, propIds, storageRoot }) {
  const target = () => loadSeriesTarget(db, owner, targetDramaId, source.work, source.localizedVersion, storageRoot);
  // 这一集已在该项目里：同一版本直接返回；按旧版本导入过就不重复追加。
  const alreadyThere = (current) => {
    const entry = liveSeriesEpisode(db, Number(current.drama.id), current.series, source.work.id);
    if (!entry) return null;
    if (entry.import_key === importKey) {
      return {
        created: false, appended: false, drama_id: Number(current.drama.id), title: current.drama.title,
        import_key: importKey, episode_number: entry.episode_number,
      };
    }
    throw codedError('REDRAW_SERIES_EPISODE_EXISTS',
      `这一集已经是该项目的第 ${entry.episode_number} 集（按旧版本导入）。要按新版本导入，请先在短剧工厂删除该集，或选择新建项目导入`);
  };
  const first = target();
  const existing = alreadyThere(first);
  if (existing) return existing;
  const dramaId = Number(first.drama.id);
  const productionPackage = buildRedrawFactoryPackage({
    sourceFacts: source.sourceFacts,
    localization: localizationOf(source.localizedVersion),
    analysisSettings: { ...source.analysisSettings, free_style: source.style },
    title: text(first.drama.title),
    characterImages: characterImagesOf(db, owner, source.localizedVersion),
    propIds,
    voicedCharacterIds: voicedSourceCharacterIds(db, dramaId, first.series, source.sourceFacts),
  });

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-factory-append-'));
  const copiedFiles = [];
  try {
    const staged = await stageClipsForSource(db, logger, source, productionPackage, storageRoot, stagingDir);
    return db.transaction(() => {
      const current = target();
      const again = alreadyThere(current);
      if (again) return again;
      const appended = appendFactoryEpisode(db, dramaId, productionPackage, current.series, { storageRoot, copiedFiles });
      recordSeriesEpisode(db, dramaId, {
        work: source.work,
        productionPackage,
        characterIdByKey: appended.characterIdByKey,
        episodeId: appended.episodeId,
        episodeNumber: appended.episodeNumber,
        importKey,
        locale: source.localizedVersion.locale,
        market: source.localizedVersion.market,
        base: current.series,
      });
      const clips = storageRoot
        ? registerStagedReferenceClips({ db, storageRoot, dramaId }, staged, appended.storyboardSources)
        : { created: [], files: [] };
      copiedFiles.push(...clips.files);
      logger.info('Redraw episode appended to factory series', {
        drama_id: dramaId, work_id: source.work.id, episode_number: appended.episodeNumber,
      });
      return {
        created: false,
        appended: true,
        drama_id: dramaId,
        title: current.drama.title,
        import_key: importKey,
        episode_number: appended.episodeNumber,
        reused_character_names: appended.reused_character_names,
        new_character_names: appended.new_character_names,
        voice_casting: productionPackage.voice_casting,
        counts: { ...appended.counts, reference_clips: clips.created.length },
      };
    })();
  } catch (error) {
    for (const file of copiedFiles) {
      try { fs.rmSync(file, { force: true }); } catch (_) { /* best effort */ }
    }
    throw error;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/**
 * 同一转绘项目（同一部剧）完全转绘导入过的工厂项目，供"追加到已有项目"选择（新的在前）。
 * this_work_episode：本作品已经是其中第几集（没导入过为 null）。
 */
function listSeriesTargets(db, owner, work) {
  if (!work?.project_id) return [];
  const rows = db.prepare(`
    SELECT d.id, d.title, d.metadata FROM dramas d
    WHERE d.tenant_id = ? AND d.user_id = ? AND d.deleted_at IS NULL AND json_valid(d.metadata) = 1
      AND (
        json_extract(d.metadata, '$.redraw_series.project_id') = ?
        OR (
          json_extract(d.metadata, '$.redraw_series') IS NULL
          AND json_extract(d.metadata, '$.redraw_import.full_localization_package') IS NOT NULL
          AND json_extract(d.metadata, '$.redraw_import.source_work_id') IN (
            SELECT id FROM redraw_works WHERE project_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
          )
        )
      )
    ORDER BY d.id DESC
  `).all(owner.tenantId, owner.userId, Number(work.project_id), Number(work.project_id), owner.tenantId, owner.userId);
  const liveEpisodes = db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE drama_id = ? AND deleted_at IS NULL');
  return rows.map((row) => {
    const metadata = parseJson(row.metadata, {}) || {};
    const series = seriesOf(metadata) || seriesFromImport(db, owner, row, metadata) || {};
    const entry = liveSeriesEpisode(db, Number(row.id), series, work.id);
    return {
      drama_id: Number(row.id),
      title: row.title,
      locale: series.locale || null,
      market: series.market || null,
      episodes: Number(liveEpisodes.get(Number(row.id))?.n || 0),
      this_work_episode: entry ? entry.episode_number : null,
    };
  }).filter((item) => item.locale || item.market);
}

module.exports = {
  importRedrawWorkToFactory,
  listSeriesTargets,
  loadRedrawSource,
};
