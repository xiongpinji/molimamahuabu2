'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildUserPrompt } = require('../src/services/scriptAnalysisService');
const { getSkillDefinition } = require('../src/services/skillRegistry');

function buildV2Prompt() {
  return buildUserPrompt(
    {
      title: '契约测试',
      source_script: '角色走进房间。',
      locked_facts_json: '[]',
    },
    getSkillDefinition('short-drama-production-director'),
    { strategyPreset: 'fusion' },
  );
}

test('V2 production prompt requires integer performance intensity', () => {
  assert.match(
    buildV2Prompt(),
    /intensity 只能使用 0、1、2、3、4、5 六个整数值，禁止小数/,
  );
});

test('V2 production prompt prioritizes a complete closed JSON document', () => {
  const prompt = buildV2Prompt();
  assert.match(prompt, /不得扩写原剧本中未发生的动作/);
  assert.match(prompt, /必须优先压缩描述并保证 JSON 完整闭合/);
});
