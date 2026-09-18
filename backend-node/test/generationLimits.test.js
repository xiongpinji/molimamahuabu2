const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveGenerationSubmitLimitPerMinute,
  resolvePipelineConcurrencyMax,
  DEFAULT_GENERATION_SUBMIT_LIMIT_PER_MINUTE,
  DEFAULT_PIPELINE_CONCURRENCY_MAX,
} = require('../src/services/generationLimits');

test('默认每用户每分钟可发起 300 次生成提交', () => {
  assert.equal(resolveGenerationSubmitLimitPerMinute({}), DEFAULT_GENERATION_SUBMIT_LIMIT_PER_MINUTE);
  assert.equal(DEFAULT_GENERATION_SUBMIT_LIMIT_PER_MINUTE, 300);
});

test('可通过环境变量覆盖生成提交限流与并发上限', () => {
  assert.equal(resolveGenerationSubmitLimitPerMinute({ GENERATION_SUBMIT_LIMIT_PER_MINUTE: '120' }), 120);
  assert.equal(resolvePipelineConcurrencyMax({ PIPELINE_CONCURRENCY_MAX: '80' }), 80);
  assert.equal(resolvePipelineConcurrencyMax({}), DEFAULT_PIPELINE_CONCURRENCY_MAX);
});

test('非法或过大的环境值回退或封顶', () => {
  assert.equal(resolveGenerationSubmitLimitPerMinute({ GENERATION_SUBMIT_LIMIT_PER_MINUTE: '0' }), 300);
  assert.equal(resolveGenerationSubmitLimitPerMinute({ GENERATION_SUBMIT_LIMIT_PER_MINUTE: 'abc' }), 300);
  assert.equal(resolvePipelineConcurrencyMax({ PIPELINE_CONCURRENCY_MAX: '5000' }), 1000);
});
