'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCRIPT_ANALYSIS_LIMITS,
  buildUserPrompt,
  getProjectInputError,
  normalizeProductionPackage,
  validateProductionPackage,
} = require('../src/services/scriptAnalysisService');
const { resolveScriptAnalysisSkill } = require('../src/services/scriptAnalysisSkillRegistry');

const project = {
  title: '雨夜来客',
  source_script: '林夏在雨夜打开门，看见失踪三年的哥哥。',
  locked_facts_json: JSON.stringify(['哥哥失踪三年', '故事发生在雨夜']),
};

function validPackage() {
  return {
    schema_version: '1.0',
    normalized_script: {},
    character_bible: [],
    scene_bible: [],
    prop_bible: [],
    episodes: [{
      episode_number: 1,
      scenes: [{
        scene_number: 1,
        shots: [{
          shot_number: 1,
          source_basis: ['原剧本第 1 段'],
          image_prompt: '雨夜门口，林夏开门',
          video_prompt: '镜头缓慢推进，林夏打开门',
          continuity: {},
          dialogue: [],
        }],
      }],
    }],
    continuity_rules: [],
    review: {
      status: 'needs_review',
      issues: [],
    },
    ai_changes: [],
  };
}

function validVisualDirection() {
  return {
    emotional_tone: {
      primary: '克制悬疑',
      secondary: '亲情压抑',
      evidence: ['哥哥失踪三年', '故事发生在雨夜'],
    },
    scene_profile: [{ type: '夜景外景', ratio_percent: 100, evidence: ['雨夜'] }],
    rhythm: {
      labels: ['缓慢铺垫', '门开启时骤停'],
      evidence: ['林夏在雨夜打开门'],
    },
    visual_motifs: [{ motif: '雨水反光', evidence: ['雨夜'], application: '贯穿重逢场景' }],
    recommendations: [{
      rank: 1,
      name: '冷峻自然主义',
      objective_style: '低照度自然光与克制机位',
      match_reasons: ['适合雨夜悬疑与亲情压抑'],
      composition: '门框形成画中框',
      camera_movement: '缓慢推进后静止',
      lighting: '冷色环境光与室内暖光对照',
      color: '低饱和蓝灰色',
      risks: ['避免过暗导致人物表情丢失'],
    }],
  };
}

test('buildUserPrompt includes source script and locked facts', () => {
  const prompt = buildUserPrompt(project);
  assert.match(prompt, /哥哥失踪三年/);
  assert.match(prompt, /林夏在雨夜打开门/);
  assert.match(prompt, /schema_version/);
  assert.doesNotMatch(prompt, /"visual_direction"/);
});

test('buildUserPrompt only adds visual direction contract for the optional enhanced Skill', () => {
  const skill = resolveScriptAnalysisSkill('cinematic-visual-director');
  const prompt = buildUserPrompt(project, skill);
  assert.match(prompt, /"visual_direction"/);
  assert.match(prompt, /"recommendations"/);
  assert.match(prompt, /所有 evidence 必须可回溯到原始剧本/);
});

test('normalizeProductionPackage preserves source truth and defaults review state', () => {
  const result = normalizeProductionPackage({
    normalized_script: {
      logline: '雨夜重逢揭开旧案',
      target_duration_seconds: 90,
    },
    character_bible: [{ name: '林夏' }],
    episodes: [{ episode_number: 1, scenes: [] }],
  }, project);

  assert.equal(result.schema_version, '1.0');
  assert.equal(result.source.source_script, project.source_script);
  assert.deepEqual(result.source.locked_facts, ['哥哥失踪三年', '故事发生在雨夜']);
  assert.equal(result.normalized_script.target_duration_seconds, 90);
  assert.equal(result.review.status, 'needs_review');
  assert.equal(result.approval_status, 'draft');
});

test('normalizeProductionPackage preserves the optional visual direction sidecar', () => {
  const visualDirection = validVisualDirection();
  const result = normalizeProductionPackage({
    ...validPackage(),
    visual_direction: visualDirection,
  }, project);

  assert.deepEqual(result.visual_direction, visualDirection);
});

test('validateProductionPackage accepts structured output with episodes', () => {
  const value = validPackage();
  assert.equal(validateProductionPackage(value), value);
});

test('validateProductionPackage keeps legacy output valid and enforces visual direction only when requested', () => {
  const legacy = validPackage();
  assert.equal(validateProductionPackage(legacy), legacy);
  assert.throws(
    () => validateProductionPackage(legacy, { requireVisualDirection: true }),
    /visual_direction/,
  );

  const enhanced = { ...validPackage(), visual_direction: validVisualDirection() };
  assert.equal(
    validateProductionPackage(enhanced, { requireVisualDirection: true }),
    enhanced,
  );
});

test('validateProductionPackage rejects enhanced output without traceable evidence', () => {
  const enhanced = { ...validPackage(), visual_direction: validVisualDirection() };
  enhanced.visual_direction.emotional_tone.evidence = [];
  assert.throws(
    () => validateProductionPackage(enhanced, { requireVisualDirection: true }),
    /emotional_tone\.evidence/,
  );
});

test('validateProductionPackage rejects malformed model output', () => {
  assert.throws(
    () => validateProductionPackage({ characters: [] }),
    /schema_version/,
  );
});

test('validateProductionPackage rejects shots without source basis', () => {
  const value = validPackage();
  value.episodes[0].scenes[0].shots[0].source_basis = [];
  assert.throws(
    () => validateProductionPackage(value),
    /source_basis/,
  );
});

test('validateProductionPackage rejects blank video prompts', () => {
  const value = validPackage();
  value.episodes[0].scenes[0].shots[0].video_prompt = ' ';
  assert.throws(
    () => validateProductionPackage(value),
    /video_prompt/,
  );
});

test('getProjectInputError enforces script and locked fact limits', () => {
  assert.match(
    getProjectInputError({
      sourceScript: '字'.repeat(SCRIPT_ANALYSIS_LIMITS.sourceScriptChars + 1),
      lockedFacts: [],
    }),
    /原始剧本不能超过/,
  );
  assert.match(
    getProjectInputError({
      sourceScript: '短剧',
      lockedFacts: ['字'.repeat(SCRIPT_ANALYSIS_LIMITS.lockedFactChars + 1)],
    }),
    /不可改事实不能超过/,
  );
  assert.match(
    getProjectInputError({
      sourceScript: '短剧',
      lockedFacts: '不是数组',
    }),
    /字符串数组/,
  );
});
