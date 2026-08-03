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
          description: '林夏在雨夜打开门，看见失踪三年的哥哥。',
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

function validV2Package() {
  const value = validPackage();
  value.schema_version = '2.0';
  value.visual_direction = validVisualDirection();
  value.creative_strategy = {
    preset: 'fusion',
    audience: '喜欢悬疑和人物关系推进的短剧观众',
    genre_tracks: ['悬疑', '亲情'],
    story_engine: '失踪亲人回归推动旧案重启',
    season_arc: ['重逢', '查明失踪真相'],
    episode_beats: ['雨夜重逢钩子'],
    commercial_beats: { enabled: false, items: [] },
    source_basis: ['林夏在雨夜打开门，看见失踪三年的哥哥。'],
    audit: { issues: [] },
  };
  const shot = value.episodes[0].scenes[0].shots[0];
  shot.duration = 4;
  shot.performance = {
    tracks: [{
      character_ref: 'character:lin-xia',
      initial_state: '保持戒备',
      trigger: '看见失踪三年的哥哥',
      beats: [{
        start_ms: 0,
        end_ms: 4000,
        emotion: '震惊转为悲伤',
        intensity: 4,
        face: { gaze: '视线锁定门外' },
        breath: '短暂屏息后缓慢呼气',
      }],
      final_state: '眼眶湿润但仍站在门内',
      constraints: ['不夸张嚎哭'],
      source_basis: ['林夏打开门，看见失踪三年的哥哥。'],
    }],
  };
  shot.prompt_ir = {
    subject_anchors: ['林夏，短发，深色家居服'],
    primary_action: '林夏打开门后停住',
    scene: '雨夜公寓门厅',
    camera: {
      shot_type: '近景',
      angle: '平视',
      movement: '缓慢推进后停止',
      composition: '门框形成画中框',
    },
    lighting: '室外冷光与室内暖光对照',
    style: '写实电影质感',
    references: [],
    continuity: { start: '右手握门把手', end: '仍站在门内' },
    negative_constraints: ['身份漂移'],
    safety_tags: [],
  };
  return value;
}

test('buildUserPrompt includes source script and locked facts', () => {
  const prompt = buildUserPrompt(project, resolveScriptAnalysisSkill('short-drama-director'));
  assert.match(prompt, /哥哥失踪三年/);
  assert.match(prompt, /林夏在雨夜打开门/);
  assert.match(prompt, /schema_version/);
  assert.doesNotMatch(prompt, /"visual_direction"/);
});

test('buildUserPrompt requires readable descriptions for production entities', () => {
  const prompt = buildUserPrompt(project);

  assert.match(prompt, /"character_bible": \[\{[\s\S]*"description": ""/);
  assert.match(prompt, /"scene_bible": \[\{[\s\S]*"description": ""/);
  assert.match(prompt, /"prop_bible": \[\{[\s\S]*"description": ""/);
  assert.match(prompt, /"shot_number": 1,[\s\S]*"description": ""/);
});

test('V2 production director prompt locks schema and selected creative strategy', () => {
  const skill = resolveScriptAnalysisSkill('short-drama-production-director');
  const prompt = buildUserPrompt(project, skill, { strategyPreset: 'female' });

  assert.match(prompt, /"schema_version": "2\.0"/);
  assert.match(prompt, /创作策略预设：female/);
  assert.match(prompt, /"creative_strategy"/);
  assert.match(prompt, /"performance"/);
  assert.match(prompt, /"prompt_ir"/);
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

test('normalizeProductionPackage derives descriptions from existing production fields', () => {
  const result = normalizeProductionPackage({
    normalized_script: {},
    character_bible: [{
      name: '林夏',
      appearance: '短发，深色外套',
      personality: '警惕但克制',
    }],
    scene_bible: [{
      name: '雨夜站台',
      environment: '雨水打湿站台，冷色灯光映在铁轨上',
    }],
    prop_bible: [{
      name: '旧信封',
      required_visual_features: ['边缘磨损', '火漆已开裂'],
      story_function: '触发母女和解',
    }],
    episodes: [{
      episode_number: 1,
      scenes: [{
        scene_number: 1,
        shots: [{
          shot_number: 1,
          source_basis: ['原剧本第 1 段'],
          image_prompt: '母女在雨夜站台隔着车窗对视',
          video_prompt: '镜头缓慢推进，母亲抬手触碰车窗',
          continuity: {},
          dialogue: [],
        }],
      }],
    }],
  }, project);

  assert.equal(result.character_bible[0].description, '短发，深色外套；警惕但克制');
  assert.equal(result.scene_bible[0].description, '雨水打湿站台，冷色灯光映在铁轨上');
  assert.equal(result.prop_bible[0].description, '边缘磨损；火漆已开裂；触发母女和解');
  assert.equal(
    result.episodes[0].scenes[0].shots[0].description,
    '母女在雨夜站台隔着车窗对视；镜头缓慢推进，母亲抬手触碰车窗；原剧本第 1 段',
  );
});

test('validateProductionPackage rejects entities without readable descriptions', () => {
  const value = validPackage();
  value.character_bible = [{ name: '林夏' }];
  value.scene_bible = [{ name: '雨夜站台' }];
  value.prop_bible = [{ name: '旧信封' }];

  assert.throws(
    () => validateProductionPackage(value),
    /description/,
  );
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

test('validateProductionPackage accepts complete V2 director storyboard package', () => {
  const value = validV2Package();
  assert.equal(
    validateProductionPackage(value, {
      expectedSchemaVersion: '2.0',
      requireVisualDirection: true,
      requireProductionDirection: true,
    }),
    value,
  );

  const normalized = normalizeProductionPackage(value, project, { schemaVersion: '2.0' });
  assert.equal(normalized.schema_version, '2.0');
  assert.equal(normalized.creative_strategy.preset, 'fusion');
  assert.deepEqual(normalized.episodes[0].scenes[0].shots[0].performance, value.episodes[0].scenes[0].shots[0].performance);
  assert.equal(
    normalized.episodes[0].scenes[0].shots[0].prompt_compilation.generic.adapter,
    'generic-video@1.0',
  );
  assert.equal(
    normalized.episodes[0].scenes[0].shots[0].prompt_compilation.seedance2.adapter,
    'seedance2@2.0',
  );
  assert.equal(
    normalized.episodes[0].scenes[0].shots[0].prompt_compilation.seedance2.generation_ready,
    true,
  );
  assert.equal(normalized.source.source_script, project.source_script);
});

test('validateProductionPackage rejects V2 performance timing outside shot duration', () => {
  const value = validV2Package();
  value.episodes[0].scenes[0].shots[0].performance.tracks[0].beats[0].end_ms = 4100;

  assert.throws(
    () => validateProductionPackage(value, { requireProductionDirection: true }),
    /超出镜头时长/,
  );
});

test('validateProductionPackage rejects incomplete V2 prompt IR', () => {
  const value = validV2Package();
  value.episodes[0].scenes[0].shots[0].prompt_ir.primary_action = '';

  assert.throws(
    () => validateProductionPackage(value, { requireProductionDirection: true }),
    /prompt_ir\.primary_action/,
  );
});

test('validateProductionPackage rejects a V2 strategy that differs from the user selection', () => {
  const value = validV2Package();
  value.creative_strategy.preset = 'male';

  assert.throws(
    () => validateProductionPackage(value, {
      requireProductionDirection: true,
      expectedStrategyPreset: 'female',
    }),
    /必须与用户选择的 female 一致/,
  );
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
