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

const IMPORT_SCHEMA_VERSION = 'redraw-factory-import@1';
// 完全转绘生产包的版本：提示词写法变了（带目标语言台词、去掉字幕描述、不提交原片参考），
// 同一版本号的旧导入不再复用，重新导入会建新项目。
const FULL_LOCALIZATION_PACKAGE_VERSION = 2;

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

function copyCharacterImagesIntoProject(db, storageRoot, dramaId, productionPackage) {
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
    const targetRel = `${projectDir}/redraw_${character.character_id}_${path.basename(sourceRel)}`;
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
  };
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
  workId, tenantId, userId, propIds = null, storageRoot = null, localizedVersionId = null,
}) {
  const owner = { tenantId: text(tenantId), userId: text(userId) };
  if (!owner.tenantId || !owner.userId) throw codedError('REDRAW_OWNER_REQUIRED', '缺少租户或用户身份');
  const logger = silentLogger(log);

  const source = loadRedrawSource(db, owner, workId, storageRoot, { localizedVersionId });
  const fullLocalization = Boolean(localizedVersionId && source.localizedVersion);
  const importKey = `redraw:${source.work.id}:version:${source.localizedVersion?.id || source.sourceVersion.id}:facts:${source.sourceVersion.facts_hash}`
    + (fullLocalization ? `:package:${FULL_LOCALIZATION_PACKAGE_VERSION}` : '');
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
            imported_at: new Date().toISOString(),
          },
        },
        user_id: owner.userId,
        tenant_id: owner.tenantId,
      });
      copiedFiles.push(...copyCharacterImagesIntoProject(db, storageRoot, Number(drama.id), productionPackage));
      const { counts, storyboardSources } = insertFactoryRows(db, logger, Number(drama.id), productionPackage);
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

module.exports = {
  importRedrawWorkToFactory,
  loadRedrawSource,
};
