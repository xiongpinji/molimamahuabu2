const { createHash } = require('crypto');

const REFERENCE_KINDS = ['image', 'video', 'audio'];

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item) ?? 'null').join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashPlanValue(value) {
  return createHash('sha256').update(stableStringify(value) ?? 'null').digest('hex');
}

function block(code) {
  throw Object.assign(new Error(code), { planCode: code });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniqueId(value, seen) {
  if (!validId(value)) block('EXECUTION_PLAN_ID_INVALID');
  if (seen.has(value)) block('EXECUTION_PLAN_DUPLICATE_ID');
  seen.add(value);
}

function validHash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) block('EXECUTION_PLAN_HASH_INVALID');
}

function validateBindingHashes(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/(?:^|_)(?:hash|sha256)$/.test(key)) validHash(item);
    else validateBindingHashes(item);
  }
}

function validRange(value, duration) {
  return Number.isSafeInteger(value?.start_ms) && Number.isSafeInteger(value?.end_ms)
    && value.start_ms >= 0 && value.end_ms > value.start_ms && value.end_ms <= duration;
}

function validateSource(input, maxDuration) {
  if (!Array.isArray(input.parent_shots) || input.parent_shots.length === 0) {
    block('EXECUTION_PLAN_SOURCE_COVERAGE_INVALID');
  }
  const parentIds = new Set();
  const references = new Map();
  let previousEnd = 0;
  for (const parent of input.parent_shots) {
    if (!validRange(parent, input.duration_ms) || parent.start_ms !== previousEnd) {
      block('EXECUTION_PLAN_SOURCE_COVERAGE_INVALID');
    }
    uniqueId(parent.id, parentIds);
    validHash(parent.contract_hash);
    if (!Array.isArray(parent.required_references)) block('EXECUTION_PLAN_REFERENCE_INVALID');
    for (const reference of parent.required_references) {
      if (!validId(reference?.id) || !REFERENCE_KINDS.includes(reference.kind)) block('EXECUTION_PLAN_REFERENCE_INVALID');
      validHash(reference.sha256);
      const previous = references.get(reference.id);
      if (previous && (previous.kind !== reference.kind || previous.sha256 !== reference.sha256)) {
        block('EXECUTION_PLAN_REFERENCE_CONFLICT');
      }
      references.set(reference.id, reference);
    }
    previousEnd = parent.end_ms;
  }
  if (previousEnd !== input.duration_ms) block('EXECUTION_PLAN_SOURCE_COVERAGE_INVALID');
  if (!Array.isArray(input.dialogues)) block('EXECUTION_PLAN_DIALOGUE_RANGE_INVALID');
  const dialogueIds = new Set();
  for (const dialogue of input.dialogues) {
    if (!validRange(dialogue, input.duration_ms)) block('EXECUTION_PLAN_DIALOGUE_RANGE_INVALID');
    uniqueId(dialogue.id, dialogueIds);
    if (!validId(dialogue.source_text) || !validId(dialogue.target_text) || !validId(dialogue.evidence_ref)) {
      block('EXECUTION_PLAN_DIALOGUE_TEXT_INVALID');
    }
    validHash(dialogue.evidence_sha256);
    if (!Number.isFinite(dialogue.estimated_duration_ms) || dialogue.estimated_duration_ms <= 0) {
      block('EXECUTION_PLAN_DIALOGUE_ESTIMATE_INVALID');
    }
    if (dialogue.estimated_duration_ms > dialogue.end_ms - dialogue.start_ms) block('EXECUTION_PLAN_DIALOGUE_BUDGET_EXCEEDED');
    if (dialogue.end_ms - dialogue.start_ms > maxDuration) block('EXECUTION_PLAN_DIALOGUE_TOO_LONG');
  }
}

function speechGroups(dialogues, maxDuration) {
  const groups = [];
  for (const dialogue of dialogues) {
    const last = groups.at(-1);
    if (last && dialogue.start_ms < last.end_ms) last.end_ms = Math.max(last.end_ms, dialogue.end_ms);
    else groups.push({ start_ms: dialogue.start_ms, end_ms: dialogue.end_ms });
  }
  if (groups.some((group) => group.end_ms - group.start_ms > maxDuration)) block('EXECUTION_PLAN_OVERLAP_TOO_LONG');
  return groups;
}

function referencesFor(parents, start, end) {
  const references = new Map();
  for (const parent of parents) {
    if (parent.start_ms >= end || parent.end_ms <= start) continue;
    for (const reference of parent.required_references) references.set(reference.id, reference);
  }
  return [...references.values()];
}

function referencesFit(references, limits) {
  return REFERENCE_KINDS.every((kind) => references.filter((reference) => reference.kind === kind).length <= limits[kind]);
}

function buildUnits(input, durations) {
  const maxDuration = durations.at(-1);
  validateSource(input, maxDuration);
  const dialogues = [...input.dialogues].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const groups = speechGroups(dialogues, maxDuration);
  const insideSpeech = (point) => groups.find((group) => group.start_ms < point && point < group.end_ms);
  const units = [];
  let start = 0;
  while (start < input.duration_ms) {
    let end = start + Math.min(maxDuration, input.duration_ms - start);
    const speechAtEnd = insideSpeech(end);
    if (speechAtEnd) end = speechAtEnd.start_ms;
    if (end <= start) block('EXECUTION_PLAN_OVERLAP_TOO_LONG');
    let references = referencesFor(input.parent_shots, start, end);
    if (!referencesFit(references, input.capability.max_references)) {
      const safeBoundaries = input.parent_shots.map((parent) => parent.end_ms)
        .filter((boundary) => boundary > start && boundary < end && !insideSpeech(boundary)).reverse();
      const boundary = safeBoundaries.find((point) => referencesFit(
        referencesFor(input.parent_shots, start, point), input.capability.max_references,
      ));
      if (boundary == null) block('EXECUTION_PLAN_REFERENCE_LIMIT_EXCEEDED');
      end = boundary;
      references = referencesFor(input.parent_shots, start, end);
    }
    const retained = end - start;
    const generated = durations.find((duration) => duration >= retained);
    units.push({
      id: `unit-${units.length + 1}`,
      source_start_ms: start,
      source_end_ms: end,
      retained_duration_ms: retained,
      generated_duration_ms: generated,
      padding_ms: generated - retained,
      parent_shots: input.parent_shots.filter((parent) => parent.start_ms < end && parent.end_ms > start).map((parent) => {
        const sourceStart = Math.max(start, parent.start_ms);
        const sourceEnd = Math.min(end, parent.end_ms);
        return { id: parent.id, contract_hash: parent.contract_hash, source_start_ms: sourceStart, source_end_ms: sourceEnd,
          unit_start_ms: sourceStart - start, unit_end_ms: sourceEnd - start };
      }),
      dialogues: dialogues.filter((dialogue) => dialogue.start_ms >= start && dialogue.end_ms <= end)
        .map((dialogue) => ({ ...dialogue, unit_start_ms: dialogue.start_ms - start, unit_end_ms: dialogue.end_ms - start })),
      required_references: references,
    });
    start = end;
  }
  return units;
}

function buildExecutionPlan(rawInput) {
  const plan = { schema_version: 'redraw-execution-plan-preview-v1', status: 'blocked', executable: false,
    bindings: null, capability: null, units: [], blocking_reasons: [] };
  try {
    if (!isObject(rawInput)) block('EXECUTION_PLAN_INPUT_INVALID');
    const input = JSON.parse(JSON.stringify(rawInput));
    if (!isObject(input)) block('EXECUTION_PLAN_INPUT_INVALID');
    plan.bindings = input.bindings ?? null;
    plan.capability = input.capability ?? null;
    if (!Number.isSafeInteger(input.duration_ms) || input.duration_ms <= 0) block('EXECUTION_PLAN_DURATION_INVALID');
    if (!isObject(input.bindings) || Object.keys(input.bindings).length === 0) block('EXECUTION_PLAN_BINDINGS_INVALID');
    const capability = input.capability;
    if (!isObject(capability) || !Array.isArray(capability.durations_ms) || capability.durations_ms.length === 0
      || !capability.durations_ms.every((duration) => Number.isSafeInteger(duration) && duration > 0)
      || !isObject(capability.max_references)
      || !REFERENCE_KINDS.every((kind) => Number.isSafeInteger(capability.max_references[kind]) && capability.max_references[kind] >= 0)) {
      block('EXECUTION_PLAN_CAPABILITY_INVALID');
    }
    validateBindingHashes(input.bindings);
    validateBindingHashes(capability);
    plan.units = buildUnits(input, [...new Set(capability.durations_ms)].sort((a, b) => a - b));
    plan.status = 'ready';
  } catch (error) {
    plan.units = [];
    plan.blocking_reasons = [{ code: error.planCode || 'EXECUTION_PLAN_INPUT_INVALID' }];
  }
  return { ...plan, plan_hash: hashPlanValue(plan) };
}

module.exports = { buildExecutionPlan, hashPlanValue };
