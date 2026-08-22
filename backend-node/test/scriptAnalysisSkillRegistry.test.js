'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listScriptAnalysisSkills,
  resolveScriptAnalysisSkill,
  snapshotScriptAnalysisSkill,
} = require('../src/services/scriptAnalysisSkillRegistry');

test('剧本分析 Skill 清单只暴露安全元数据', () => {
  const skills = listScriptAnalysisSkills();
  assert.equal(skills.length, 3);
  assert.deepEqual(skills[0], {
    id: 'short-drama-director',
    name: '专业短剧导演',
    version: '1.0.0',
    description: '从原始剧本生成角色、场景、道具和分镜生产包',
    module: 'script_analysis',
    output_schema_version: '1.0',
    is_default: false,
  });
  assert.equal(Object.hasOwn(skills[0], 'system_prompt'), false);
  assert.deepEqual(skills[1], {
    id: 'cinematic-visual-director',
    name: '电影化视觉导演',
    version: '1.0.0',
    description: '在现有生产包上增加情绪、节奏、视觉母题和客观风格建议',
    module: 'script_analysis',
    output_schema_version: '1.0',
    is_default: false,
  });
  assert.equal(Object.hasOwn(skills[1], 'system_prompt'), false);
  assert.equal(Object.hasOwn(skills[1], 'user_prompt_addendum'), false);
  assert.deepEqual(skills[2], {
    id: 'short-drama-production-director',
    name: '短剧一体化生产导演',
    version: '2.0.0',
    description: '整合创作策略、导演故事板、表演轨和模型提示词结构',
    module: 'script_analysis',
    output_schema_version: '2.0',
    is_default: true,
  });
  assert.equal(Object.hasOwn(skills[2], 'system_prompt'), false);
});
test('剧本分析 Skill 支持默认解析并生成不可变版本快照', () => {
  const selected = resolveScriptAnalysisSkill();
  assert.equal(selected.id, 'short-drama-production-director');
  assert.match(selected.system_prompt, /不得修改 source_script/);
  assert.deepEqual(snapshotScriptAnalysisSkill(selected), {
    id: 'short-drama-production-director',
    name: '短剧一体化生产导演',
    version: '2.0.0',
    module: 'script_analysis',
    output_schema_version: '2.0',
  });
  assert.equal(resolveScriptAnalysisSkill('not-installed'), null);
});

test('电影化视觉导演是可选增强且不会替换现有默认 Skill', () => {
  const selected = resolveScriptAnalysisSkill('cinematic-visual-director');
  assert.equal(resolveScriptAnalysisSkill().id, 'short-drama-production-director');
  assert.equal(selected.is_default, false);
  assert.equal(selected.require_visual_direction, true);
  assert.match(selected.system_prompt, /情绪基调/);
  assert.match(selected.user_prompt_addendum, /visual_direction/);
  assert.deepEqual(snapshotScriptAnalysisSkill(selected), {
    id: 'cinematic-visual-director',
    name: '电影化视觉导演',
    version: '1.0.0',
    module: 'script_analysis',
    output_schema_version: '1.0',
  });
});
