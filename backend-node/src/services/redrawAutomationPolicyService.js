'use strict';

const requiredAnalysisConfidenceKeys = Object.freeze([
  'character_mapping',
  'speaker_mapping',
  'text_regions',
  'shot_boundary',
]);

const REQUIRED_GATES = Object.freeze(['media', 'timeline', 'facts']);
const TOP_LEVEL_FIELDS = new Set(['execution_mode', 'gates', 'confidence', 'thresholds', 'budget_configured']);
const DANGEROUS_FIELDS = new Set(['__proto__', 'constructor', 'prototype']);

function invalid() {
  const error = new Error('INPUT_INVALID');
  error.code = 'INPUT_INVALID';
  throw error;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
}

function assertAllowedObject(value, allowed) {
  assertPlainObject(value);
  for (const key in value) {
    if (!hasOwn(value, key)) invalid();
  }
  for (const key of Object.keys(value)) {
    if (DANGEROUS_FIELDS.has(key) || !allowed.has(key)) invalid();
  }
}

function assertFiniteUnit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid();
}

function sortedDecision(action, effectiveMode, reasonCodes) {
  const reason_codes = Object.freeze([...reasonCodes].sort());
  return Object.freeze({ action, effective_mode: effectiveMode, reason_codes });
}

function normalizeInput(input) {
  assertAllowedObject(input, TOP_LEVEL_FIELDS);
  const executionMode = input.execution_mode;
  if (executionMode !== 'safe' && executionMode !== 'auto') invalid();
  if (!hasOwn(input, 'gates')) invalid();
  assertAllowedObject(input.gates, new Set(REQUIRED_GATES));
  for (const key of REQUIRED_GATES) {
    if (!hasOwn(input.gates, key) || typeof input.gates[key] !== 'boolean') invalid();
  }
  if (hasOwn(input, 'budget_configured') && typeof input.budget_configured !== 'boolean') invalid();
  if (hasOwn(input, 'confidence')) {
    assertAllowedObject(input.confidence, new Set(requiredAnalysisConfidenceKeys));
    for (const key of Object.keys(input.confidence)) assertFiniteUnit(input.confidence[key]);
  }
  if (hasOwn(input, 'thresholds')) {
    assertAllowedObject(input.thresholds, new Set(requiredAnalysisConfidenceKeys));
    for (const key of Object.keys(input.thresholds)) assertFiniteUnit(input.thresholds[key]);
  }
  return input;
}

function evaluateAutomationDecision(rawInput = {}) {
  const input = normalizeInput(rawInput);
  const gateFailures = REQUIRED_GATES
    .filter((key) => input.gates[key] === false)
    .map((key) => `${key}_gate_failed`);
  if (gateFailures.length > 0) return sortedDecision('blocked', 'safe', gateFailures);

  if (input.execution_mode === 'safe') {
    return sortedDecision('needs_review', 'safe', ['safe_mode_requires_review']);
  }

  if (input.budget_configured === false) {
    return sortedDecision('blocked', 'safe', ['budget_not_configured']);
  }

  const thresholds = hasOwn(input, 'thresholds') ? input.thresholds : {};
  const missingThresholds = requiredAnalysisConfidenceKeys
    .filter((key) => !hasOwn(thresholds, key))
    .map((key) => `${key}_threshold_missing`);
  if (missingThresholds.length > 0) return sortedDecision('blocked', 'safe', missingThresholds);

  const confidence = hasOwn(input, 'confidence') ? input.confidence : {};
  const confidenceReasons = [];
  for (const key of requiredAnalysisConfidenceKeys) {
    if (!hasOwn(confidence, key)) {
      confidenceReasons.push(`${key}_confidence_missing`);
    } else if (confidence[key] < thresholds[key]) {
      confidenceReasons.push(`${key}_low_confidence`);
    }
  }
  if (confidenceReasons.length > 0) return sortedDecision('needs_review', 'safe', confidenceReasons);

  return sortedDecision('advance', 'auto', []);
}

module.exports = {
  evaluateAutomationDecision,
  requiredAnalysisConfidenceKeys,
};
