const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateAutomationDecision,
  requiredAnalysisConfidenceKeys,
} = require('../src/services/redrawAutomationPolicyService');

function autoInput(overrides = {}) {
  return {
    execution_mode: 'auto',
    gates: { media: true, timeline: true, facts: true },
    confidence: { character_mapping: 0.99, speaker_mapping: 0.99, text_regions: 0.99, shot_boundary: 0.99 },
    thresholds: { character_mapping: 0.95, speaker_mapping: 0.90, text_regions: 0.95, shot_boundary: 0.95 },
    ...overrides,
  };
}

test('auto 任一必需置信度不足时降级 safe，不产生付费动作', () => {
  const decision = evaluateAutomationDecision(autoInput({
    confidence: { character_mapping: 0.99, speaker_mapping: 0.71, text_regions: 0.98, shot_boundary: 0.99 },
  }));
  assert.deepEqual(decision, {
    action: 'needs_review',
    effective_mode: 'safe',
    reason_codes: ['speaker_mapping_low_confidence'],
  });
});

test('safe gates全真时永远等待人工确认且不需要阈值', () => {
  assert.deepEqual(evaluateAutomationDecision({
    execution_mode: 'safe',
    gates: { media: true, timeline: true, facts: true },
  }), {
    action: 'needs_review',
    effective_mode: 'safe',
    reason_codes: ['safe_mode_requires_review'],
  });
});

test('auto 全部通过时自动推进', () => {
  assert.deepEqual(evaluateAutomationDecision(autoInput()), {
    action: 'advance',
    effective_mode: 'auto',
    reason_codes: [],
  });
});

test('缺阈值阻断 auto 且逐 key 返回稳定 reason', () => {
  const decision = evaluateAutomationDecision(autoInput({
    thresholds: { character_mapping: 0.95, shot_boundary: 0.95 },
  }));
  assert.deepEqual(decision, {
    action: 'blocked',
    effective_mode: 'safe',
    reason_codes: ['speaker_mapping_threshold_missing', 'text_regions_threshold_missing'],
  });
});

test('缺置信度降级 safe 并稳定排序', () => {
  const decision = evaluateAutomationDecision(autoInput({
    confidence: { shot_boundary: 0.99, character_mapping: 0.99 },
  }));
  assert.deepEqual(decision, {
    action: 'needs_review',
    effective_mode: 'safe',
    reason_codes: ['speaker_mapping_confidence_missing', 'text_regions_confidence_missing'],
  });
});

test('deterministic gate 失败阻断且 reason 稳定排序', () => {
  const decision = evaluateAutomationDecision(autoInput({
    gates: { facts: false, timeline: false, media: true },
  }));
  assert.deepEqual(decision, {
    action: 'blocked',
    effective_mode: 'safe',
    reason_codes: ['facts_gate_failed', 'timeline_gate_failed'],
  });
});

test('auto 预算显式未配置时阻断，省略预算字段不阻断纯函数示例', () => {
  assert.equal(evaluateAutomationDecision(autoInput()).action, 'advance');
  assert.deepEqual(evaluateAutomationDecision(autoInput({ budget_configured: false })), {
    action: 'blocked',
    effective_mode: 'safe',
    reason_codes: ['budget_not_configured'],
  });
});

test('置信度等于阈值允许通过', () => {
  assert.deepEqual(evaluateAutomationDecision(autoInput({
    confidence: { character_mapping: 0.95, speaker_mapping: 0.90, text_regions: 0.95, shot_boundary: 0.95 },
  })), {
    action: 'advance',
    effective_mode: 'auto',
    reason_codes: [],
  });
});

test('NaN、Infinity、unknown 和 inherited/prototype 字段稳定拒绝', () => {
  assert.throws(() => evaluateAutomationDecision(autoInput({
    confidence: { character_mapping: Number.NaN, speaker_mapping: 0.9, text_regions: 0.9, shot_boundary: 0.9 },
  })), (error) => error.code === 'INPUT_INVALID');
  assert.throws(() => evaluateAutomationDecision(autoInput({
    thresholds: { character_mapping: 0.9, speaker_mapping: Infinity, text_regions: 0.9, shot_boundary: 0.9 },
  })), (error) => error.code === 'INPUT_INVALID');
  assert.throws(() => evaluateAutomationDecision(autoInput({ extra: true })), (error) => error.code === 'INPUT_INVALID');

  const inherited = Object.create({ media: true });
  inherited.timeline = true;
  inherited.facts = true;
  assert.throws(() => evaluateAutomationDecision(autoInput({ gates: inherited })), (error) => error.code === 'INPUT_INVALID');
  assert.throws(() => evaluateAutomationDecision(autoInput({
    confidence: { __proto__: { polluted: true }, character_mapping: 0.9, speaker_mapping: 0.9, text_regions: 0.9, shot_boundary: 0.9 },
  })), (error) => error.code === 'INPUT_INVALID');
});

test('导出必需置信度 keys 且输出不可变异', () => {
  assert.deepEqual(requiredAnalysisConfidenceKeys, [
    'character_mapping',
    'speaker_mapping',
    'text_regions',
    'shot_boundary',
  ]);
  assert.equal(Object.isFrozen(requiredAnalysisConfidenceKeys), true);
  const decision = evaluateAutomationDecision(autoInput());
  assert.equal(Object.isFrozen(decision), true);
  assert.equal(Object.isFrozen(decision.reason_codes), true);
});
