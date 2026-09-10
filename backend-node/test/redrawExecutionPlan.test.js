const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
let service;
try { service = require('../src/services/redrawExecutionPlanService'); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  service = {};
}

const hash = (letter = 'a') => letter.repeat(64);
const reference = (id, kind = 'image', sha256 = hash()) => ({ id, kind, sha256 });
const shot = (id, start, end, references = []) => ({ id, start_ms: start, end_ms: end, contract_hash: hash('b'), required_references: references });
const line = (id, start, end) => ({ id, start_ms: start, end_ms: end, source_text: ` 原文${id} `,
  target_text: ` 翻译${id} `, evidence_ref: `evidence-${id}`, evidence_sha256: hash('c'), estimated_duration_ms: end - start });

function input(duration = 26_000) {
  return { duration_ms: duration, parent_shots: [shot('parent-1', 0, duration)], dialogues: [],
    capability: { durations_ms: [5_000, 10_000], max_references: { image: 3, video: 1, audio: 1 }, config_hash: hash('d') },
    bindings: { version_id: 1, source_sha256: hash(), blueprint_hash: hash('b'), localization_hash: hash('c'), capability_hash: hash('d'), locale: 'ja-JP' } };
}

function build(value) {
  assert.equal(typeof service.buildExecutionPlan, 'function', 'pure execution plan preview builder must exist');
  return service.buildExecutionPlan(value);
}

function verifyReady(plan, source) {
  assert.equal(plan.schema_version, 'redraw-execution-plan-preview-v1');
  assert.equal(plan.status, 'ready');
  assert.equal(plan.executable, false);
  assert.deepEqual(plan.blocking_reasons, []);
  assert.deepEqual(plan.bindings, source.bindings);
  assert.deepEqual(plan.capability, source.capability);
  let end = 0;
  for (const unit of plan.units) {
    assert.equal(unit.source_start_ms, end);
    assert.ok(unit.source_end_ms > unit.source_start_ms);
    assert.equal(unit.retained_duration_ms, unit.source_end_ms - unit.source_start_ms);
    assert.ok(source.capability.durations_ms.includes(unit.generated_duration_ms));
    assert.equal(unit.padding_ms, unit.generated_duration_ms - unit.retained_duration_ms);
    assert.ok(unit.padding_ms >= 0);
    for (const mapping of unit.parent_shots) {
      assert.equal(mapping.source_start_ms - unit.source_start_ms, mapping.unit_start_ms);
      assert.equal(mapping.source_end_ms - unit.source_start_ms, mapping.unit_end_ms);
      assert.equal(mapping.contract_hash, source.parent_shots.find((parent) => parent.id === mapping.id).contract_hash);
    }
    for (const dialogue of unit.dialogues) {
      const { unit_start_ms: localStart, unit_end_ms: localEnd, ...original } = dialogue;
      assert.deepEqual(original, source.dialogues.find((candidate) => candidate.id === dialogue.id));
      assert.equal(dialogue.start_ms - unit.source_start_ms, localStart);
      assert.equal(dialogue.end_ms - unit.source_start_ms, localEnd);
      assert.ok(localStart >= 0 && localEnd <= unit.retained_duration_ms);
    }
    for (const kind of ['image', 'video', 'audio']) {
      assert.ok(unit.required_references.filter((ref) => ref.kind === kind).length <= source.capability.max_references[kind]);
    }
    end = unit.source_end_ms;
  }
  assert.equal(end, source.duration_ms);
  assert.deepEqual(plan.units.flatMap((unit) => unit.dialogues.map((dialogue) => dialogue.id)).sort(), source.dialogues.map((dialogue) => dialogue.id).sort());
  assert.match(plan.plan_hash, /^[a-f0-9]{64}$/);
}

function verifyBlocked(value, code) {
  const result = build(value);
  assert.equal(result.status, 'blocked');
  assert.equal(result.executable, false);
  assert.deepEqual(result.units, []);
  assert.ok(result.blocking_reasons.some((reason) => reason.code === code), JSON.stringify(result.blocking_reasons));
  assert.match(result.plan_hash, /^[a-f0-9]{64}$/);
  return result;
}

test('long silent parent maps to three or more dynamic units with explicit tail padding', () => {
  const source = input();
  const plan = build(source);
  verifyReady(plan, source);
  assert.deepEqual(plan.units.map((unit) => [unit.source_start_ms, unit.source_end_ms, unit.generated_duration_ms, unit.padding_ms]),
    [[0, 10_000, 10_000, 0], [10_000, 20_000, 10_000, 0], [20_000, 26_000, 10_000, 4_000]]);
  assert.deepEqual(plan.units.map((unit) => unit.parent_shots[0].id), ['parent-1', 'parent-1', 'parent-1']);
});

test('whole dialogue crossing multiple parents occurs exactly once with exact original fields', () => {
  const source = input(14_000);
  source.parent_shots = [shot('p1', 0, 3_000), shot('p2', 3_000, 7_000), shot('p3', 7_000, 14_000)];
  source.dialogues = [line('cross', 1_000, 9_000), line('later', 10_000, 13_000)];
  const plan = build(source);
  verifyReady(plan, source);
  assert.deepEqual(plan.units[0].parent_shots.map((parent) => parent.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(plan.units[0].dialogues.map((dialogue) => dialogue.id), ['cross']);
});

test('maximum boundary inside a sentence backs up to sentence start without acceleration', () => {
  const source = input(18_000);
  source.dialogues = [line('cross-max', 8_000, 15_000)];
  const plan = build(source);
  verifyReady(plan, source);
  assert.deepEqual(plan.units.map((unit) => [unit.source_start_ms, unit.source_end_ms]), [[0, 8_000], [8_000, 18_000]]);
  assert.equal(plan.units[0].padding_ms, 2_000);
  assert.equal(plan.units[1].dialogues[0].estimated_duration_ms, 7_000);
});

test('overlapping dialogue connected components remain intact across unit boundaries', () => {
  const source = input(18_000);
  source.dialogues = [line('a', 7_000, 11_000), line('b', 10_000, 15_000)];
  const plan = build(source);
  verifyReady(plan, source);
  assert.equal(plan.units[0].source_end_ms, 7_000);
  assert.deepEqual(plan.units[1].dialogues.map((dialogue) => dialogue.id), ['a', 'b']);
});

test('single dialogue longer than the maximum blocks the entire preview', () => {
  const source = input(20_000);
  source.dialogues = [line('too-long', 0, 10_001)];
  verifyBlocked(source, 'EXECUTION_PLAN_DIALOGUE_TOO_LONG');
});

test('overlap chain longer than maximum blocks even when individual lines fit', () => {
  const source = input(20_000);
  source.dialogues = [line('a', 0, 4_000), line('b', 3_000, 8_000), line('c', 7_000, 11_000)];
  verifyBlocked(source, 'EXECUTION_PLAN_OVERLAP_TOO_LONG');
});

test('touching but non-overlapping sentences allow a cut exactly at the maximum', () => {
  const source = input(20_000);
  source.dialogues = [line('a', 0, 10_000), line('b', 10_000, 20_000)];
  verifyReady(build(source), source);
});

test('unusual validated duration sets and one millisecond tail are not hardcoded to five seconds', () => {
  const source = input(21_001);
  source.capability.durations_ms = [3_000, 7_000];
  const plan = build(source);
  verifyReady(plan, source);
  assert.equal(plan.units.length, 4);
  assert.equal(plan.units.at(-1).retained_duration_ms, 1);
  assert.equal(plan.units.at(-1).generated_duration_ms, 3_000);
  assert.equal(plan.units.at(-1).padding_ms, 2_999);
});

test('reference union deduplicates identical bindings across parents and preserves every kind', () => {
  const source = input(10_000);
  const shared = [reference('face'), reference('motion', 'video'), reference('voice', 'audio')];
  source.parent_shots = [shot('a', 0, 5_000, shared), shot('b', 5_000, 10_000, structuredClone(shared))];
  source.capability.max_references = { image: 1, video: 1, audio: 1 };
  const plan = build(source);
  verifyReady(plan, source);
  assert.deepEqual(plan.units[0].required_references, shared);
});

test('reference overflow splits early only at a safe parent boundary', () => {
  const source = input(12_000);
  source.capability.max_references.image = 1;
  source.parent_shots = [shot('a', 0, 4_000, [reference('r1')]), shot('b', 4_000, 8_000, [reference('r2', 'image', hash('b'))]),
    shot('c', 8_000, 12_000, [reference('r3', 'image', hash('c'))])];
  const plan = build(source);
  verifyReady(plan, source);
  assert.deepEqual(plan.units.map((unit) => [unit.source_start_ms, unit.source_end_ms]), [[0, 4_000], [4_000, 8_000], [8_000, 12_000]]);
});

test('reference overflow across an uncuttable whole sentence blocks all units', () => {
  const source = input(8_000);
  source.capability.max_references.image = 1;
  source.parent_shots = [shot('a', 0, 4_000, [reference('r1')]), shot('b', 4_000, 8_000, [reference('r2')])];
  source.dialogues = [line('whole', 1_000, 7_000)];
  verifyBlocked(source, 'EXECUTION_PLAN_REFERENCE_LIMIT_EXCEEDED');
});

test('a parent whose own reference set exceeds capability cannot be made valid by cutting it', () => {
  const source = input(30_000);
  source.parent_shots[0].required_references = [reference('r1'), reference('r2')];
  source.capability.max_references.image = 1;
  verifyBlocked(source, 'EXECUTION_PLAN_REFERENCE_LIMIT_EXCEEDED');
});

test('reused reference ID with different content is a binding conflict, not silent deduplication', () => {
  const source = input(10_000);
  source.parent_shots = [shot('a', 0, 5_000, [reference('r')]), shot('b', 5_000, 10_000, [reference('r', 'image', hash('b'))])];
  verifyBlocked(source, 'EXECUTION_PLAN_REFERENCE_CONFLICT');
});

for (const [name, mutate, code] of [
  ['zero duration', (value) => { value.duration_ms = 0; }, 'EXECUTION_PLAN_DURATION_INVALID'],
  ['float duration', (value) => { value.duration_ms = 1.5; }, 'EXECUTION_PLAN_DURATION_INVALID'],
  ['unsafe duration', (value) => { value.duration_ms = Number.MAX_SAFE_INTEGER + 1; }, 'EXECUTION_PLAN_DURATION_INVALID'],
  ['empty parents', (value) => { value.parent_shots = []; }, 'EXECUTION_PLAN_SOURCE_COVERAGE_INVALID'],
  ['parent gap', (value) => { value.parent_shots = [shot('a', 0, 9), shot('b', 10, 26_000)]; }, 'EXECUTION_PLAN_SOURCE_COVERAGE_INVALID'],
  ['parent overlap', (value) => { value.parent_shots = [shot('a', 0, 10), shot('b', 9, 26_000)]; }, 'EXECUTION_PLAN_SOURCE_COVERAGE_INVALID'],
  ['parent range float', (value) => { value.parent_shots[0].start_ms = 0.5; }, 'EXECUTION_PLAN_SOURCE_COVERAGE_INVALID'],
  ['duplicate parent', (value) => { value.parent_shots = [shot('a', 0, 10), shot('a', 10, 26_000)]; }, 'EXECUTION_PLAN_DUPLICATE_ID'],
  ['duplicate dialogue', (value) => { value.dialogues = [line('a', 0, 10), line('a', 10, 20)]; }, 'EXECUTION_PLAN_DUPLICATE_ID'],
  ['parent contract hash', (value) => { value.parent_shots[0].contract_hash = 'bad'; }, 'EXECUTION_PLAN_HASH_INVALID'],
  ['reference hash', (value) => { value.parent_shots[0].required_references = [reference('bad', 'image', 'bad')]; }, 'EXECUTION_PLAN_HASH_INVALID'],
  ['reference kind', (value) => { value.parent_shots[0].required_references = [reference('bad', 'document')]; }, 'EXECUTION_PLAN_REFERENCE_INVALID'],
  ['negative dialogue', (value) => { value.dialogues = [line('a', -1, 10)]; }, 'EXECUTION_PLAN_DIALOGUE_RANGE_INVALID'],
  ['dialogue out of range', (value) => { value.dialogues = [line('a', 25_000, 26_001)]; }, 'EXECUTION_PLAN_DIALOGUE_RANGE_INVALID'],
  ['dialogue time float', (value) => { value.dialogues = [line('a', 0.5, 10)]; }, 'EXECUTION_PLAN_DIALOGUE_RANGE_INVALID'],
  ['blank translated line', (value) => { value.dialogues = [{ ...line('a', 0, 10), target_text: '' }]; }, 'EXECUTION_PLAN_DIALOGUE_TEXT_INVALID'],
  ['zero estimate', (value) => { value.dialogues = [{ ...line('a', 0, 10), estimated_duration_ms: 0 }]; }, 'EXECUTION_PLAN_DIALOGUE_ESTIMATE_INVALID'],
  ['infinite estimate', (value) => { value.dialogues = [{ ...line('a', 0, 10), estimated_duration_ms: Infinity }]; }, 'EXECUTION_PLAN_DIALOGUE_ESTIMATE_INVALID'],
  ['translation exceeds source budget', (value) => { value.dialogues = [{ ...line('a', 0, 10), estimated_duration_ms: 11 }]; }, 'EXECUTION_PLAN_DIALOGUE_BUDGET_EXCEEDED'],
  ['dialogue evidence hash', (value) => { value.dialogues = [{ ...line('a', 0, 10), evidence_sha256: 'bad' }]; }, 'EXECUTION_PLAN_HASH_INVALID'],
  ['missing capability', (value) => { delete value.capability; }, 'EXECUTION_PLAN_CAPABILITY_INVALID'],
  ['empty duration choices', (value) => { value.capability.durations_ms = []; }, 'EXECUTION_PLAN_CAPABILITY_INVALID'],
  ['zero model duration', (value) => { value.capability.durations_ms = [0]; }, 'EXECUTION_PLAN_CAPABILITY_INVALID'],
  ['float model duration', (value) => { value.capability.durations_ms = [1000.5]; }, 'EXECUTION_PLAN_CAPABILITY_INVALID'],
  ['unsafe model duration', (value) => { value.capability.durations_ms = [Number.MAX_SAFE_INTEGER + 1]; }, 'EXECUTION_PLAN_CAPABILITY_INVALID'],
  ['missing reference ceiling', (value) => { delete value.capability.max_references.audio; }, 'EXECUTION_PLAN_CAPABILITY_INVALID'],
  ['negative reference ceiling', (value) => { value.capability.max_references.image = -1; }, 'EXECUTION_PLAN_CAPABILITY_INVALID'],
  ['missing bindings', (value) => { delete value.bindings; }, 'EXECUTION_PLAN_BINDINGS_INVALID'],
  ['binding hash', (value) => { value.bindings.source_sha256 = 'bad'; }, 'EXECUTION_PLAN_HASH_INVALID'],
]) {
  test(`invalid ${name} returns a wholly blocked nonexecutable preview`, () => {
    const source = input();
    mutate(source);
    verifyBlocked(source, code);
  });
}

test('stable hash sorts object keys without reordering arrays and binds plan contents', () => {
  assert.equal(typeof service.hashPlanValue, 'function');
  assert.equal(service.hashPlanValue({ b: 2, a: [{ z: 1, a: 2 }] }), service.hashPlanValue({ a: [{ a: 2, z: 1 }], b: 2 }));
  assert.notEqual(service.hashPlanValue([1, 2]), service.hashPlanValue([2, 1]));
  assert.equal(service.hashPlanValue({ b: 2, a: 1 }), crypto.createHash('sha256').update('{"a":1,"b":2}').digest('hex'));
  const source = input();
  const baseline = build(source);
  const { plan_hash: actualHash, ...payload } = baseline;
  assert.equal(actualHash, service.hashPlanValue(payload));
  assert.deepEqual(build(structuredClone(source)), baseline);
  for (const mutate of [
    (value) => { value.bindings.source_sha256 = hash('e'); },
    (value) => { value.bindings.localization_hash = hash('e'); },
    (value) => { value.capability.config_hash = hash('e'); },
    (value) => { value.parent_shots[0].contract_hash = hash('e'); },
  ]) {
    const changed = structuredClone(source);
    mutate(changed);
    assert.notEqual(build(changed).plan_hash, baseline.plan_hash);
  }
});

test('read-only preview does not mutate input and repeated small units always make progress', () => {
  const source = input(20_001);
  source.capability.durations_ms = [997];
  source.dialogues = [line('brief', 500, 996)];
  const before = JSON.stringify(source);
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  const plan = build(freeze(source));
  verifyReady(plan, source);
  assert.ok(plan.units.length > 20);
  assert.equal(JSON.stringify(source), before);
});

test('invalid primitive input blocks without exposing caught exceptions', () => {
  for (const value of [null, undefined, 2, 'raw exception SECRET']) {
    const result = verifyBlocked(value, 'EXECUTION_PLAN_INPUT_INVALID');
    assert.doesNotMatch(JSON.stringify(result), /SECRET|stack|TypeError|SyntaxError/);
  }
});
