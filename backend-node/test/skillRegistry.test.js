'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getSkillDefinition,
  listSkillsForModule,
  resolveSkillForModule,
  snapshotSkill,
} = require('../src/services/skillRegistry');

test('共享 Skill 注册表如实区分执行、消费和预览能力', () => {
  const skill = getSkillDefinition('cinematic-visual-director');

  assert.equal(skill.module_capabilities.script_analysis, 'execute');
  assert.equal(skill.module_capabilities.canvas, 'consume');
  assert.equal(skill.module_capabilities.factory, 'preview');
  assert.equal(resolveSkillForModule(skill.id, 'script_analysis', 'execute')?.id, skill.id);
  assert.equal(resolveSkillForModule(skill.id, 'canvas', 'execute'), null);
  assert.equal(resolveSkillForModule(skill.id, 'factory', 'execute'), null);
  assert.equal(resolveSkillForModule(skill.id, 'factory', 'preview')?.id, skill.id);
});

test('共享 Skill 注册项保留治理边界且不暴露系统提示词快照', () => {
  const skill = getSkillDefinition('short-drama-director');
  const snapshot = snapshotSkill(skill, 'script_analysis');

  assert.equal(skill.source.kind, 'built_in');
  assert.equal(skill.license, 'internal');
  assert.deepEqual(skill.permissions, ['ai:invoke']);
  assert.equal(skill.input_schema.id, 'script-analysis-input@1.0');
  assert.equal(skill.output_schema.id, 'script-analysis-production-package@1.0');
  assert.deepEqual(skill.runtime_policy, {
    billing: 'inherit_module_policy',
    timeout: 'inherit_module_policy',
    retry: 'inherit_module_policy',
    refund: 'inherit_module_policy',
  });
  assert.deepEqual(snapshot, {
    id: 'short-drama-director',
    name: '专业短剧导演',
    version: '1.0.0',
    module: 'script_analysis',
    output_schema_version: '1.0',
  });
  assert.equal(Object.hasOwn(snapshot, 'system_prompt'), false);
});

test('模块 Skill 清单只返回已启用且具备目标能力的注册项', () => {
  assert.equal(listSkillsForModule('script_analysis', 'execute').length, 3);
  assert.equal(listSkillsForModule('canvas', 'consume').length, 2);
  assert.equal(listSkillsForModule('factory', 'preview').length, 1);
  assert.equal(listSkillsForModule('factory', 'execute').length, 0);
});
