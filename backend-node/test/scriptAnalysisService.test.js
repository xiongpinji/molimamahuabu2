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

test('buildUserPrompt includes source script and locked facts', () => {
  const prompt = buildUserPrompt(project);
  assert.match(prompt, /哥哥失踪三年/);
  assert.match(prompt, /林夏在雨夜打开门/);
  assert.match(prompt, /schema_version/);
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

test('validateProductionPackage accepts structured output with episodes', () => {
  const value = validPackage();
  assert.equal(validateProductionPackage(value), value);
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
