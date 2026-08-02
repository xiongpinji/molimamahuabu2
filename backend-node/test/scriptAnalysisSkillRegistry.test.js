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
  assert.equal(skills.length, 1);
  assert.deepEqual(skills[0], {
    id: 'short-drama-director',
    name: '专业短剧导演',
    version: '1.0.0',
    description: '从原始剧本生成角色、场景、道具和分镜生产包',
    module: 'script_analysis',
    output_schema_version: '1.0',
    is_default: true,
  });
  assert.equal(Object.hasOwn(skills[0], 'system_prompt'), false);
});

test('剧本分析 Skill 支持默认解析并生成不可变版本快照', () => {
  const selected = resolveScriptAnalysisSkill();
  assert.equal(selected.id, 'short-drama-director');
  assert.match(selected.system_prompt, /不得修改 source_script/);
  assert.deepEqual(snapshotScriptAnalysisSkill(selected), {
    id: 'short-drama-director',
    name: '专业短剧导演',
    version: '1.0.0',
    module: 'script_analysis',
    output_schema_version: '1.0',
  });
  assert.equal(resolveScriptAnalysisSkill('not-installed'), null);
});
