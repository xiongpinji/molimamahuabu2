'use strict';

const aiClient = require('./aiClient');
const { safeParseAIJSON } = require('../utils/safeJson');
const { resolveScriptAnalysisSkill } = require('./scriptAnalysisSkillRegistry');
const {
  compileShotPrompt,
  listStrategyPresets,
  validatePerformanceTrack,
} = require('./shortDramaProductionDirector');

const SYSTEM_PROMPT = resolveScriptAnalysisSkill().system_prompt;

const SCRIPT_ANALYSIS_LIMITS = Object.freeze({
  sourceScriptChars: 60000,
  lockedFacts: 100,
  lockedFactChars: 500,
});

function getProjectInputError({ sourceScript, lockedFacts } = {}, { requireSource = false } = {}) {
  const script = String(sourceScript || '');
  const facts = lockedFacts == null ? [] : lockedFacts;
  if (requireSource && !script.trim()) return '请先填写原始剧本，再开始分析';
  if (script.length > SCRIPT_ANALYSIS_LIMITS.sourceScriptChars) {
    return `原始剧本不能超过 ${SCRIPT_ANALYSIS_LIMITS.sourceScriptChars} 个字符，请按剧集或章节拆分后分析`;
  }
  if (!Array.isArray(facts)) return '不可改事实必须是字符串数组';
  if (facts.length > SCRIPT_ANALYSIS_LIMITS.lockedFacts) {
    return `不可改事实不能超过 ${SCRIPT_ANALYSIS_LIMITS.lockedFacts} 条，请合并重复事实后重试`;
  }
  const oversizedFactIndex = facts.findIndex(
    (fact) => String(fact || '').length > SCRIPT_ANALYSIS_LIMITS.lockedFactChars,
  );
  if (oversizedFactIndex >= 0) {
    return `第 ${oversizedFactIndex + 1} 条不可改事实不能超过 ${SCRIPT_ANALYSIS_LIMITS.lockedFactChars} 个字符`;
  }
  return '';
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readableText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(readableText).filter(Boolean).join('；');
  }
  if (typeof value === 'object') {
    return Object.values(value).map(readableText).filter(Boolean).join('；');
  }
  return String(value).trim();
}

const DESCRIPTION_FIELDS = Object.freeze({
  character: ['appearance', 'visual', 'visual_design', 'profile', 'personality', 'performance_direction', 'background', 'known_facts', 'key_facts', 'relationship'],
  scene: ['visual', 'environment', 'atmosphere', 'story_function', 'dramatic_function', 'source_basis'],
  prop: ['required_visual_features', 'appearance', 'function', 'story_function', 'purpose', 'source_basis'],
  shot: ['action', 'visual', 'shot_description', 'image_prompt', 'video_prompt', 'source_basis'],
});

function normalizeDescription(value, type) {
  const item = asObject(value);
  const description = readableText(item.description)
    || DESCRIPTION_FIELDS[type].map((field) => readableText(item[field])).filter(Boolean).join('；');
  return { ...item, description };
}

function buildUserPrompt(project, skill, { strategyPreset } = {}) {
  const selectedSkill = skill || resolveScriptAnalysisSkill();
  const schemaVersion = selectedSkill?.output_schema_version || '1.0';
  const lockedFacts = parseArray(project.locked_facts_json);
  const strategyInstruction = schemaVersion === '2.0'
    ? `\n创作策略预设：${strategyPreset || selectedSkill.default_strategy_preset || 'fusion'}\n必须原样写入 creative_strategy.preset。\n`
    : '';
  const shotDurationContract = schemaVersion === '2.0'
    ? '              "duration": 4,\n'
    : '';
  const basePrompt = `请分析以下短剧剧本并输出结构化生产包。

标题：${project.title || '未命名剧本'}

不可改动事实：
${JSON.stringify(lockedFacts, null, 2)}

原始剧本：
${project.source_script || ''}
${strategyInstruction}

输出契约：
{
  "schema_version": "${schemaVersion}",
  "source": {
    "title": "",
    "source_script": "",
    "locked_facts": []
  },
  "normalized_script": {
    "logline": "",
    "genre": "",
    "tone": "",
    "target_duration_seconds": 0,
    "story_structure": []
  },
  "character_bible": [{ "name": "", "role": "", "description": "" }],
  "scene_bible": [{ "name": "", "time": "", "description": "" }],
  "prop_bible": [{ "name": "", "description": "" }],
  "episodes": [
    {
      "episode_number": 1,
      "title": "",
      "scenes": [
        {
          "scene_number": 1,
          "shots": [
            {
              "shot_number": 1,
${shotDurationContract}              "description": "",
              "source_basis": [],
              "image_prompt": "",
              "video_prompt": "",
              "continuity": {},
              "dialogue": []
            }
          ]
        }
      ]
    }
  ],
  "continuity_rules": [],
  "review": {
    "status": "needs_review",
    "issues": []
  },
  "ai_changes": [],
  "approval_status": "draft"
}

描述要求：人物、场景、道具和每个镜头的 description 必须使用中文完整句子，
只描述原剧本已有事实和可审核的制作信息，不得用名称或提示词字段代替。`;
  return selectedSkill?.user_prompt_addendum
    ? `${basePrompt}\n\n${selectedSkill.user_prompt_addendum}`
    : basePrompt;
}

function buildRevisionPrompt(project, currentPackage, note, skill) {
  const { source: _source, ...packageWithoutDuplicatedSource } = asObject(currentPackage);
  return `${buildUserPrompt(project, skill)}

当前待修改生产包：
${JSON.stringify(packageWithoutDuplicatedSource, null, 2)}

人工审核备注：
${String(note || '').trim()}

请先逐条推理审核备注对应的修改位置，再输出修改后的完整生产包 JSON。
未被审核备注要求修改的内容必须保持不变；不得改变原剧本和不可改动事实。`;
}

function normalizeVisualDirection(value) {
  const visualDirection = asObject(value);
  if (!Object.keys(visualDirection).length) return null;
  const emotionalTone = asObject(visualDirection.emotional_tone);
  const rhythm = asObject(visualDirection.rhythm);
  return {
    emotional_tone: {
      primary: String(emotionalTone.primary || ''),
      secondary: String(emotionalTone.secondary || ''),
      evidence: parseArray(emotionalTone.evidence),
    },
    scene_profile: parseArray(visualDirection.scene_profile),
    rhythm: {
      labels: parseArray(rhythm.labels),
      evidence: parseArray(rhythm.evidence),
    },
    visual_motifs: parseArray(visualDirection.visual_motifs),
    recommendations: parseArray(visualDirection.recommendations),
  };
}

function normalizeProductionPackage(rawValue, project, { schemaVersion } = {}) {
  const raw = asObject(rawValue);
  const normalized = asObject(raw.normalized_script);
  const review = asObject(raw.review);
  const resolvedSchemaVersion = schemaVersion || raw.schema_version || '1.0';

  const result = {
    schema_version: resolvedSchemaVersion,
    source: {
      title: project.title || '',
      source_script: project.source_script || '',
      locked_facts: parseArray(project.locked_facts_json),
    },
    normalized_script: {
      logline: normalized.logline || '',
      genre: normalized.genre || '',
      tone: normalized.tone || '',
      target_duration_seconds: Number(normalized.target_duration_seconds) || 0,
      story_structure: parseArray(normalized.story_structure),
    },
    character_bible: parseArray(raw.character_bible).map((item) => normalizeDescription(item, 'character')),
    scene_bible: parseArray(raw.scene_bible).map((item) => normalizeDescription(item, 'scene')),
    prop_bible: parseArray(raw.prop_bible).map((item) => normalizeDescription(item, 'prop')),
    episodes: parseArray(raw.episodes).map((episode) => ({
      ...episode,
      scenes: parseArray(episode?.scenes).map((scene) => ({
        ...scene,
        shots: parseArray(scene?.shots).map((shot) => normalizeDescription(shot, 'shot')),
      })),
    })),
    continuity_rules: parseArray(raw.continuity_rules),
    review: {
      status: review.status || 'needs_review',
      issues: parseArray(review.issues),
    },
    ai_changes: parseArray(raw.ai_changes),
    approval_status: 'draft',
  };
  const visualDirection = normalizeVisualDirection(raw.visual_direction);
  if (visualDirection) result.visual_direction = visualDirection;
  if (resolvedSchemaVersion === '2.0') {
    result.creative_strategy = raw.creative_strategy;
    result.episodes = result.episodes.map((episode) => ({
      ...episode,
      scenes: parseArray(episode?.scenes).map((scene) => ({
        ...scene,
        shots: parseArray(scene?.shots).map((shot) => ({
          ...shot,
          prompt_compilation: {
            generic: compileShotPrompt(shot, { adapter: 'generic-video' }),
            seedance2: compileShotPrompt(shot, {
              adapter: 'seedance2',
              model: 'seedance-2.0',
            }),
          },
        })),
      })),
    }));
  }
  return result;
}

function requireNonBlankArray(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !String(item || '').trim())) {
    throw new Error(`模型返回的 ${field} 必须是非空依据数组`);
  }
}

function validateCreativeStrategy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('模型返回的 creative_strategy 必须是对象');
  }
  const presetIds = new Set(listStrategyPresets().map((preset) => preset.id));
  if (!presetIds.has(value.preset)) {
    throw new Error('模型返回的 creative_strategy.preset 无效');
  }
  for (const field of ['audience', 'story_engine']) {
    if (!String(value[field] || '').trim()) {
      throw new Error(`模型返回的 creative_strategy.${field} 不能为空`);
    }
  }
  for (const field of ['genre_tracks', 'season_arc', 'episode_beats']) {
    if (!Array.isArray(value[field])) {
      throw new Error(`模型返回的 creative_strategy.${field} 必须是数组`);
    }
  }
  requireNonBlankArray(value.source_basis, 'creative_strategy.source_basis');
  if (!value.commercial_beats || typeof value.commercial_beats !== 'object'
    || Array.isArray(value.commercial_beats)
    || typeof value.commercial_beats.enabled !== 'boolean'
    || !Array.isArray(value.commercial_beats.items)) {
    throw new Error('模型返回的 creative_strategy.commercial_beats 无效');
  }
  if (!value.audit || typeof value.audit !== 'object' || Array.isArray(value.audit)
    || !Array.isArray(value.audit.issues)) {
    throw new Error('模型返回的 creative_strategy.audit.issues 必须是数组');
  }
}

function validatePromptIR(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('模型返回的 prompt_ir 必须是对象');
  }
  for (const field of ['subject_anchors', 'references', 'negative_constraints', 'safety_tags']) {
    if (!Array.isArray(value[field])) {
      throw new Error(`模型返回的 prompt_ir.${field} 必须是数组`);
    }
  }
  for (const field of ['primary_action', 'scene', 'lighting', 'style']) {
    if (!String(value[field] || '').trim()) {
      throw new Error(`模型返回的 prompt_ir.${field} 不能为空`);
    }
  }
  if (!value.camera || typeof value.camera !== 'object' || Array.isArray(value.camera)) {
    throw new Error('模型返回的 prompt_ir.camera 必须是对象');
  }
  for (const field of ['shot_type', 'angle', 'movement', 'composition']) {
    if (!String(value.camera[field] || '').trim()) {
      throw new Error(`模型返回的 prompt_ir.camera.${field} 不能为空`);
    }
  }
  if (!value.continuity || typeof value.continuity !== 'object' || Array.isArray(value.continuity)) {
    throw new Error('模型返回的 prompt_ir.continuity 必须是对象');
  }
}

function validateVisualDirection(value) {
  function requireEvidence(items, field) {
    if (!Array.isArray(items) || items.length === 0 || items.some((item) => !String(item || '').trim())) {
      throw new Error(`模型返回的 ${field} 必须是非空依据数组`);
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('模型返回的 visual_direction 必须是对象');
  }
  if (!value.emotional_tone || typeof value.emotional_tone !== 'object' || Array.isArray(value.emotional_tone)) {
    throw new Error('模型返回的 visual_direction.emotional_tone 必须是对象');
  }
  if (!String(value.emotional_tone.primary || '').trim()) {
    throw new Error('模型返回的 visual_direction.emotional_tone.primary 不能为空');
  }
  requireEvidence(
    value.emotional_tone.evidence,
    'visual_direction.emotional_tone.evidence',
  );
  if (!value.rhythm || typeof value.rhythm !== 'object' || Array.isArray(value.rhythm)) {
    throw new Error('模型返回的 visual_direction.rhythm 必须是对象');
  }
  for (const key of ['scene_profile', 'visual_motifs', 'recommendations']) {
    if (!Array.isArray(value[key])) {
      throw new Error(`模型返回的 visual_direction.${key} 必须是数组`);
    }
  }
  if (!Array.isArray(value.rhythm.labels) || !Array.isArray(value.rhythm.evidence)) {
    throw new Error('模型返回的 visual_direction.rhythm.labels 和 evidence 必须是数组');
  }
  if (value.rhythm.labels.length === 0 || value.rhythm.labels.some((item) => !String(item || '').trim())) {
    throw new Error('模型返回的 visual_direction.rhythm.labels 必须是非空标签数组');
  }
  requireEvidence(value.rhythm.evidence, 'visual_direction.rhythm.evidence');
  value.scene_profile.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !String(item.type || '').trim()) {
      throw new Error(`模型返回的 visual_direction.scene_profile[${index}] 必须包含 type`);
    }
    requireEvidence(item.evidence, `visual_direction.scene_profile[${index}].evidence`);
  });
  value.visual_motifs.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !String(item.motif || '').trim()) {
      throw new Error(`模型返回的 visual_direction.visual_motifs[${index}] 必须包含 motif`);
    }
    requireEvidence(item.evidence, `visual_direction.visual_motifs[${index}].evidence`);
  });
  if (value.recommendations.length === 0) {
    throw new Error('模型返回的 visual_direction.recommendations 不能为空');
  }
  value.recommendations.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !String(item.name || '').trim() || !String(item.objective_style || '').trim()) {
      throw new Error(`模型返回的 visual_direction.recommendations[${index}] 缺少名称或客观视觉语言`);
    }
    requireEvidence(
      item.match_reasons,
      `visual_direction.recommendations[${index}].match_reasons`,
    );
    if (!Array.isArray(item.risks)) {
      throw new Error(`模型返回的 visual_direction.recommendations[${index}].risks 必须是数组`);
    }
  });
}

function validateProductionPackage(value, {
  requireVisualDirection = false,
  requireProductionDirection = false,
  expectedSchemaVersion,
  expectedStrategyPreset,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('模型未返回有效的剧本分析结构，请调整模型配置后重试');
  }
  if (!['1.0', '2.0'].includes(value.schema_version)) {
    throw new Error('模型返回的 schema_version 必须是 1.0 或 2.0');
  }
  if (expectedSchemaVersion && value.schema_version !== expectedSchemaVersion) {
    throw new Error(`模型返回的 schema_version 必须是 ${expectedSchemaVersion}`);
  }
  if (requireProductionDirection && value.schema_version !== '2.0') {
    throw new Error('模型返回的 schema_version 必须是 2.0');
  }
  if (!value.normalized_script || typeof value.normalized_script !== 'object' || Array.isArray(value.normalized_script)) {
    throw new Error('模型返回的 normalized_script 必须是对象');
  }
  for (const key of ['character_bible', 'scene_bible', 'prop_bible', 'episodes', 'continuity_rules', 'ai_changes']) {
    if (!Array.isArray(value[key])) {
      throw new Error(`模型返回的 ${key} 必须是数组`);
    }
  }
  for (const key of ['character_bible', 'scene_bible', 'prop_bible']) {
    value[key].forEach((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || !String(item.description || '').trim()) {
        throw new Error(`模型返回的 ${key}[${index}].description 不能为空`);
      }
    });
  }
  if (!value.review || typeof value.review !== 'object' || Array.isArray(value.review)) {
    throw new Error('模型返回的 review 必须是对象');
  }
  if (!Array.isArray(value.review.issues)) {
    throw new Error('模型返回的 review.issues 必须是数组');
  }
  if (requireVisualDirection && !value.visual_direction) {
    throw new Error('模型未返回电影化视觉导演所需的 visual_direction');
  }
  if (value.visual_direction !== undefined) {
    validateVisualDirection(value.visual_direction);
  }
  if (value.schema_version === '2.0') {
    validateCreativeStrategy(value.creative_strategy);
    if (expectedStrategyPreset && value.creative_strategy.preset !== expectedStrategyPreset) {
      throw new Error(`模型返回的 creative_strategy.preset 必须与用户选择的 ${expectedStrategyPreset} 一致`);
    }
  }
  if (value.episodes.length === 0) {
    throw new Error('模型返回的 episodes 不能为空');
  }
  for (const episode of value.episodes) {
    if (!episode?.episode_number || !Array.isArray(episode.scenes) || episode.scenes.length === 0) {
      throw new Error('每一集必须包含 episode_number 和非空 scenes');
    }
    for (const scene of episode.scenes) {
      if (!scene?.scene_number || !Array.isArray(scene.shots) || scene.shots.length === 0) {
        throw new Error('每个场景必须包含 scene_number 和非空 shots');
      }
      for (const shot of scene.shots) {
        if (!shot?.shot_number) throw new Error('每个镜头必须包含 shot_number');
        if (!String(shot.description || '').trim()) {
          throw new Error('每个镜头必须包含非空 description');
        }
        if (!Array.isArray(shot.source_basis) || shot.source_basis.length === 0) {
          throw new Error('每个镜头必须包含非空 source_basis');
        }
        if (!String(shot.image_prompt || '').trim()) {
          throw new Error('每个镜头必须包含 image_prompt');
        }
        if (!String(shot.video_prompt || '').trim()) {
          throw new Error('每个镜头必须包含 video_prompt');
        }
        if (!shot.continuity || typeof shot.continuity !== 'object' || Array.isArray(shot.continuity)) {
          throw new Error('每个镜头必须包含 continuity 对象');
        }
        if (!Array.isArray(shot.dialogue)) {
          throw new Error('每个镜头必须包含 dialogue 数组');
        }
        if (value.schema_version === '2.0') {
          const duration = Number(shot.duration);
          if (!Number.isFinite(duration) || duration <= 0) {
            throw new Error('V2 每个镜头的 duration 必须大于 0');
          }
          if (!shot.performance || typeof shot.performance !== 'object'
            || Array.isArray(shot.performance) || !Array.isArray(shot.performance.tracks)) {
            throw new Error('V2 每个镜头必须包含 performance.tracks 数组');
          }
          shot.performance.tracks.forEach((track) => {
            validatePerformanceTrack(track, { durationMs: duration * 1000 });
          });
          validatePromptIR(shot.prompt_ir);
        }
      }
    }
  }
  return value;
}

async function runAnalysis({ db, log, project, skill, strategyPreset, generationOptions = {} }) {
  const selectedSkill = skill || resolveScriptAnalysisSkill();
  const raw = await aiClient.generateText(
    db,
    log,
    'text',
    buildUserPrompt(project, selectedSkill, { strategyPreset }),
    selectedSkill.system_prompt,
    {
      scene_key: 'story_generation',
      temperature: 0.3,
      json_mode: true,
      max_tokens: 12000,
      ...generationOptions,
    },
  );
  const normalized = normalizeProductionPackage(
    safeParseAIJSON(raw, {}, log),
    project,
    { schemaVersion: selectedSkill.output_schema_version },
  );
  return validateProductionPackage(normalized, {
    expectedSchemaVersion: selectedSkill.output_schema_version,
    requireVisualDirection: Boolean(
      selectedSkill.require_visual_direction || selectedSkill.require_production_direction
    ),
    requireProductionDirection: Boolean(selectedSkill.require_production_direction),
    expectedStrategyPreset: selectedSkill.require_production_direction
      ? (strategyPreset || selectedSkill.default_strategy_preset || 'fusion')
      : undefined,
  });
}

async function runRevision({
  db,
  log,
  project,
  currentPackage,
  note,
  skill,
  generationOptions = {},
}) {
  const selectedSkill = skill || resolveScriptAnalysisSkill();
  const raw = await aiClient.generateText(
    db,
    log,
    'text',
    buildRevisionPrompt(project, currentPackage, note, selectedSkill),
    selectedSkill.system_prompt,
    {
      scene_key: 'story_generation',
      temperature: 0.2,
      json_mode: true,
      max_tokens: 12000,
      ...generationOptions,
    },
  );
  const normalized = normalizeProductionPackage(
    safeParseAIJSON(raw, {}, log),
    project,
    { schemaVersion: selectedSkill.output_schema_version },
  );
  return validateProductionPackage(normalized, {
    expectedSchemaVersion: selectedSkill.output_schema_version,
    requireVisualDirection: Boolean(
      selectedSkill.require_visual_direction || selectedSkill.require_production_direction
    ),
    requireProductionDirection: Boolean(selectedSkill.require_production_direction),
    expectedStrategyPreset: selectedSkill.require_production_direction
      ? (currentPackage?.creative_strategy?.preset
        || selectedSkill.default_strategy_preset
        || 'fusion')
      : undefined,
  });
}

module.exports = {
  SYSTEM_PROMPT,
  SCRIPT_ANALYSIS_LIMITS,
  getProjectInputError,
  buildUserPrompt,
  buildRevisionPrompt,
  normalizeProductionPackage,
  validateProductionPackage,
  runAnalysis,
  runRevision,
};
