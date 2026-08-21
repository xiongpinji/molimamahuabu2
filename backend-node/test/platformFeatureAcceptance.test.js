const assert = require('node:assert/strict');
const test = require('node:test');

const {
  loadDefaultAcceptance,
  validateAcceptance,
} = require('../scripts/verify-platform-feature-acceptance');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function codes(result) {
  return new Set(result.errors.map((error) => error.code));
}

test('default acceptance ledger is valid but incomplete', () => {
  const {
    acceptance,
    schema,
    inventory,
    inventorySha256,
  } = loadDefaultAcceptance();
  const result = validateAcceptance(acceptance, {
    schema,
    inventory,
    inventorySha256,
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.summary, {
    total: 140,
    unverified: 124,
    blocked: 16,
    locked_pass: 0,
    locked_fixed: 0,
    not_applicable: 0,
  });
});

test('source inventory hash drift invalidates the ledger', () => {
  const {
    acceptance,
    schema,
    inventory,
    inventorySha256,
  } = loadDefaultAcceptance();
  const drifted = clone(acceptance);
  drifted.source_inventory.sha256 = '0'.repeat(64);

  const result = validateAcceptance(drifted, {
    schema,
    inventory,
    inventorySha256,
  });

  assert.equal(result.valid, false);
  assert.ok(codes(result).has('source_inventory_mismatch'));
});

test('unknown and duplicate feature decisions are rejected', () => {
  const {
    acceptance,
    schema,
    inventory,
    inventorySha256,
  } = loadDefaultAcceptance();
  const invalid = clone(acceptance);
  invalid.decisions.push({
    feature_id: 'canvas.not-real',
    status: 'blocked',
    reason: 'Feature is not present in the bound source inventory.',
    evidence: [],
  });

  const unknownResult = validateAcceptance(invalid, {
    schema,
    inventory,
    inventorySha256,
  });
  assert.ok(codes(unknownResult).has('unknown_feature'));

  invalid.decisions.push(clone(invalid.decisions[0]));
  const duplicateResult = validateAcceptance(invalid, {
    schema,
    inventory,
    inventorySha256,
  });
  assert.ok(codes(duplicateResult).has('duplicate_feature'));
});
