'use strict';

const STRATEGY_PRESETS = Object.freeze([
  Object.freeze({
    id: 'male',
    name: '男频策略',
    description: '侧重成长、身份反转、目标推进和阶段性胜利。',
    is_default: false,
  }),
  Object.freeze({
    id: 'female',
    name: '女频策略',
    description: '侧重人物关系、能力成长、情绪递进和关系转折。',
    is_default: false,
  }),
  Object.freeze({
    id: 'fusion',
    name: '融合策略',
    description: '根据剧本事实组合成长、关系、悬念和反转机制。',
    is_default: true,
  }),
  Object.freeze({
    id: 'custom',
    name: '自定义策略',
    description: '仅使用用户明确提供的题材、受众和节奏要求。',
    is_default: false,
  }),
]);

function listStrategyPresets() {
  return STRATEGY_PRESETS.map((preset) => ({ ...preset }));
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasPerformanceCue(beat) {
  const face = beat?.face;
  const hasFaceCue = face && typeof face === 'object' && !Array.isArray(face)
    && Object.values(face).some(nonBlank);
  return hasFaceCue || ['breath', 'voice', 'body', 'hands', 'prop']
    .some((field) => nonBlank(beat?.[field]));
}

function validatePerformanceTrack(track, { durationMs } = {}) {
  if (!track || typeof track !== 'object' || Array.isArray(track)) {
    throw new Error('表演轨必须是对象');
  }
  for (const field of ['character_ref', 'initial_state', 'trigger', 'final_state']) {
    if (!nonBlank(track[field])) throw new Error(`表演轨缺少 ${field}`);
  }
  if (!Array.isArray(track.source_basis) || track.source_basis.length === 0
    || track.source_basis.some((item) => !nonBlank(item))) {
    throw new Error('表演轨 source_basis 必须是非空依据数组');
  }
  if (!Array.isArray(track.constraints)) throw new Error('表演轨 constraints 必须是数组');
  if (!Array.isArray(track.beats) || track.beats.length === 0) {
    throw new Error('表演轨 beats 必须是非空数组');
  }

  const duration = Number(durationMs);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('镜头时长必须大于 0');
  let previousEnd = 0;
  track.beats.forEach((beat, index) => {
    const start = Number(beat?.start_ms);
    const end = Number(beat?.end_ms);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error(`表演轨 beats[${index}] 时间范围无效`);
    }
    if (start < previousEnd) throw new Error(`表演轨 beats[${index}] 与上一阶段重叠`);
    if (end > duration) throw new Error(`表演轨 beats[${index}] 超出镜头时长`);
    if (!nonBlank(beat.emotion)) throw new Error(`表演轨 beats[${index}] 缺少 emotion`);
    const intensity = Number(beat.intensity);
    if (!Number.isInteger(intensity) || intensity < 0 || intensity > 5) {
      throw new Error(`表演轨 beats[${index}] intensity 必须是 0 到 5 的整数`);
    }
    if (!hasPerformanceCue(beat)) throw new Error(`表演轨 beats[${index}] 缺少可执行表演动作`);
    previousEnd = end;
  });
  return track;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
  return value;
}

function performanceBeatText(beat) {
  const seconds = (value) => Number(value) / 1000;
  const cues = [];
  if (beat.face && typeof beat.face === 'object' && !Array.isArray(beat.face)) {
    for (const [key, value] of Object.entries(beat.face)) {
      if (nonBlank(value)) cues.push(`${key}: ${value.trim()}`);
    }
  }
  for (const field of ['breath', 'voice', 'body', 'hands', 'prop']) {
    if (nonBlank(beat[field])) cues.push(`${field}: ${beat[field].trim()}`);
  }
  return `${seconds(beat.start_ms)}-${seconds(beat.end_ms)}秒 ${beat.emotion}（强度${beat.intensity}/5）：${cues.join('；')}`;
}

function performanceTrackText(track) {
  return [
    `${track.character_ref} 初态：${track.initial_state}`,
    `触发：${track.trigger}`,
    ...track.beats.map(performanceBeatText),
    `终态：${track.final_state}`,
    track.constraints.length ? `表演约束：${track.constraints.join('、')}` : '',
  ].filter(Boolean).join('；');
}

function cameraText(camera) {
  return ['shot_type', 'angle', 'movement', 'composition']
    .map((field) => nonBlank(camera?.[field]) ? `${field}: ${camera[field].trim()}` : '')
    .filter(Boolean)
    .join('；');
}

function compileShotPrompt(shot, {
  adapter = 'generic-video',
  model = '',
  capabilities = {},
} = {}) {
  const adapterVersions = {
    'generic-video': 'generic-video@1.0',
    seedance2: 'seedance2@2.0',
  };
  if (!adapterVersions[adapter]) throw new Error(`不支持的提示词适配器：${adapter}`);
  if (!shot || typeof shot !== 'object' || Array.isArray(shot)) throw new Error('镜头必须是对象');
  const durationMs = Number(shot.duration) * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('镜头 duration 必须大于 0');
  const performance = shot.performance && typeof shot.performance === 'object' ? shot.performance : {};
  const tracks = requireArray(performance.tracks || [], 'performance.tracks');
  tracks.forEach((track) => validatePerformanceTrack(track, { durationMs }));

  const ir = shot.prompt_ir;
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) throw new Error('prompt_ir 必须是对象');
  const subjects = requireArray(ir.subject_anchors, 'prompt_ir.subject_anchors').filter(nonBlank);
  const references = requireArray(ir.references, 'prompt_ir.references');
  const negative = requireArray(ir.negative_constraints, 'prompt_ir.negative_constraints').filter(nonBlank);
  requireArray(ir.safety_tags, 'prompt_ir.safety_tags');
  const continuity = ir.continuity && typeof ir.continuity === 'object' && !Array.isArray(ir.continuity)
    ? ir.continuity
    : {};
  const camera = ir.camera && typeof ir.camera === 'object' && !Array.isArray(ir.camera) ? ir.camera : {};

  const continuityText = Object.entries(continuity)
    .filter(([, value]) => nonBlank(value))
    .map(([key, value]) => `${key}: ${value.trim()}`)
    .join('；');
  const referenceText = references
    .map((reference) => `${reference?.slot || ''}=${reference?.role || 'reference'}`)
    .filter((value) => !value.startsWith('='))
    .join('；');
  const prompt = [
    subjects.length ? `主体：${subjects.join('；')}` : '',
    nonBlank(ir.primary_action) ? `主动作：${ir.primary_action.trim()}` : '',
    tracks.length ? `表演：${tracks.map(performanceTrackText).join('｜')}` : '',
    nonBlank(ir.scene) ? `场景：${ir.scene.trim()}` : '',
    cameraText(camera) ? `镜头：${cameraText(camera)}` : '',
    nonBlank(ir.lighting) ? `灯光：${ir.lighting.trim()}` : '',
    nonBlank(ir.style) ? `风格：${ir.style.trim()}` : '',
    continuityText ? `连续性：${continuityText}` : '',
    referenceText ? `参考：${referenceText}` : '',
    `时长：${Number(shot.duration)}秒`,
  ].filter(Boolean).join('\n');

  const cameraFields = ['shot_type', 'angle', 'movement', 'composition'].filter((field) => nonBlank(camera[field])).length;
  const scoreDimensions = {
    subject: subjects.length ? 2 : 0,
    action: nonBlank(ir.primary_action) ? 2 : 0,
    camera: cameraFields >= 3 ? 2 : (cameraFields ? 1 : 0),
    scene_lighting: nonBlank(ir.scene) && nonBlank(ir.lighting) ? 2 : (nonBlank(ir.scene) || nonBlank(ir.lighting) ? 1 : 0),
    continuity_constraints: continuityText && negative.length ? 2 : (continuityText || negative.length ? 1 : 0),
  };
  const score = Object.values(scoreDimensions).reduce((sum, value) => sum + value, 0);
  const maxReferences = Number(
    capabilities.max_reference_images ?? (adapter === 'seedance2' ? 9 : NaN)
  );
  const unsupported = [];
  if (Number.isFinite(maxReferences) && references.length > maxReferences) {
    unsupported.push(`参考图数量 ${references.length} 超过模型上限 ${maxReferences}`);
  }
  if (adapter === 'seedance2') {
    const minimumDuration = Number(capabilities.min_duration_seconds ?? 4);
    const maximumDuration = Number(capabilities.max_duration_seconds ?? 15);
    if (Number(shot.duration) < minimumDuration) {
      unsupported.push(`时长 ${Number(shot.duration)} 秒低于 Seedance 2 下限 ${minimumDuration} 秒`);
    }
    if (Number(shot.duration) > maximumDuration) {
      unsupported.push(`时长 ${Number(shot.duration)} 秒超过 Seedance 2 上限 ${maximumDuration} 秒`);
    }
  }

  return {
    schema_version: 'compiled-shot-prompt@1.0',
    adapter: adapterVersions[adapter],
    model: String(model || ''),
    prompt,
    negative_prompt: negative.join('，'),
    score_dimensions: scoreDimensions,
    score,
    unsupported,
    warnings: unsupported.slice(),
    generation_ready: score >= 8 && unsupported.length === 0,
  };
}

module.exports = {
  listStrategyPresets,
  validatePerformanceTrack,
  compileShotPrompt,
};
