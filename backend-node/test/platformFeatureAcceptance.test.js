const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  loadDefaultAcceptance,
  sha256NormalizedText,
  validateAcceptance,
} = require('../scripts/verify-platform-feature-acceptance');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function codes(result) {
  return new Set(result.errors.map((error) => error.code));
}

const CANDIDATE_COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const EVIDENCE_PATH = 'backend-node/test/platformFeatureAcceptance.test.js';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_ROOT = path.join(REPO_ROOT, 'backend-node');
const IMAGE_GENERATION_EVIDENCE_KINDS = [
  'contract',
  'auth',
  'api',
  'task',
  'provider',
  'artifact',
  'writeback',
  'billing',
  'ci',
  'production',
  'lock',
];

function evidence(kind, overrides = {}) {
  return {
    kind,
    path: EVIDENCE_PATH,
    result: 'pass',
    recorded_at: '2026-08-21T00:00:00.000Z',
    candidate_commit: CANDIDATE_COMMIT,
    ...overrides,
  };
}

function imageGenerationEvidence() {
  return IMAGE_GENERATION_EVIDENCE_KINDS.map((kind) => evidence(kind));
}

function validateDecision(decision) {
  const {
    acceptance,
    schema,
    inventory,
    inventorySha256,
    repoRoot,
  } = loadDefaultAcceptance();
  const changed = clone(acceptance);
  const index = changed.decisions.findIndex(
    (existing) => existing.feature_id === decision.feature_id,
  );
  if (index === -1) changed.decisions.push(decision);
  else changed.decisions[index] = decision;

  return validateAcceptance(changed, {
    schema,
    inventory,
    inventorySha256,
    repoRoot,
  });
}

function runAcceptanceCli(args = []) {
  return spawnSync(process.execPath, [
    'scripts/verify-platform-feature-acceptance.js',
    ...args,
  ], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
  });
}

function parseJsonOutput(output) {
  return JSON.parse(output.trim());
}

function assertSafeCliOutput(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(output, /at\s+.+\(.+:\d+:\d+\)/);
  assert.doesNotMatch(output, /sk-[A-Za-z0-9]/);
  assert.doesNotMatch(output, /https?:\/\//);
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

test('CLI accepts structurally valid incomplete ledger', () => {
  const result = runAcceptanceCli();

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  assertSafeCliOutput(result);
  const report = parseJsonOutput(result.stdout);
  assert.equal(report.valid, true);
  assert.equal(report.complete, false);
  assert.deepEqual(report.summary, {
    total: 140,
    unverified: 124,
    blocked: 16,
    locked_pass: 0,
    locked_fixed: 0,
    not_applicable: 0,
  });
});

test('--require-complete rejects current incomplete ledger without printing ready', () => {
  const result = runAcceptanceCli(['--require-complete']);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assertSafeCliOutput(result);
  const report = parseJsonOutput(result.stderr);
  assert.equal(report.valid, true);
  assert.equal(report.complete, false);
  assert.equal(report.error, 'ACCEPTANCE_INCOMPLETE');
  assert.equal(report.summary.unverified, 124);
  assert.equal(report.summary.blocked, 16);
});

test('CLI rejects help, unknown, missing-value, invalid-value, and multi-arg inputs safely', () => {
  for (const args of [
    ['--help'],
    ['--unknown'],
    ['--ledger'],
    ['--require-complete=true'],
    ['--require-complete', '--unknown'],
  ]) {
    const result = runAcceptanceCli(args);

    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assertSafeCliOutput(result);
    const report = parseJsonOutput(result.stderr);
    assert.equal(report.valid, false);
    assert.equal(report.error, 'INVALID_ARGUMENTS');
  }
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

test('source inventory hash is stable across LF and CRLF checkouts', () => {
  const lf = '{\n  "features": []\n}\n';
  const crlf = lf.replaceAll('\n', '\r\n');

  assert.equal(sha256NormalizedText(lf), sha256NormalizedText(crlf));
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

test('locked_pass cannot lock image generation without evidence', () => {
  const result = validateDecision({
    feature_id: 'canvas.api.image_generation',
    status: 'locked_pass',
    candidate_commit: CANDIDATE_COMMIT,
    evidence: [],
  });

  assert.equal(result.valid, false);
  assert.ok(codes(result).has('missing_evidence'));
});

test('locked_fixed requires defect and fix commit metadata', () => {
  const result = validateDecision({
    feature_id: 'canvas.api.image_generation',
    status: 'locked_fixed',
    candidate_commit: CANDIDATE_COMMIT,
    evidence: [],
  });

  assert.equal(result.valid, false);
  assert.ok(codes(result).has('missing_fix_metadata'));
});

test('not_applicable requires product approval and a passing lock decision', () => {
  const result = validateDecision({
    feature_id: 'canvas.share.link',
    status: 'not_applicable',
    reason: 'The product does not expose this capability.',
    evidence: [],
  });

  assert.equal(result.valid, false);
  assert.ok(codes(result).has('missing_approval'));
  assert.equal(codes(result).has('duplicate_feature'), false);
});

test('evidence paths must point to existing files', () => {
  const result = validateDecision({
    feature_id: 'canvas.share.link',
    status: 'blocked',
    reason: 'Independent acceptance coverage is unavailable.',
    evidence: [evidence('lock', {
      path: 'backend-node/test/platform-feature-evidence-does-not-exist.txt',
    })],
  });

  assert.equal(result.valid, false);
  assert.ok(codes(result).has('missing_evidence_path'));
});

test('absolute evidence paths use the stable missing path error', () => {
  const result = validateDecision({
    feature_id: 'canvas.share.link',
    status: 'blocked',
    reason: 'Independent acceptance coverage is unavailable.',
    evidence: [evidence('lock', {
      path: path.resolve(__dirname, 'platformFeatureAcceptance.test.js'),
    })],
  });

  assert.equal(result.valid, false);
  assert.deepEqual(codes(result), new Set(['missing_evidence_path']));
});

test('evidence paths cannot escape the repository with dot-dot', () => {
  const result = validateDecision({
    feature_id: 'canvas.share.link',
    status: 'blocked',
    reason: 'Independent acceptance coverage is unavailable.',
    evidence: [evidence('lock', { path: '../outside-evidence.txt' })],
  });

  assert.equal(result.valid, false);
  assert.deepEqual(codes(result), new Set(['missing_evidence_path']));
});

test('evidence paths cannot point to directories', () => {
  const result = validateDecision({
    feature_id: 'canvas.share.link',
    status: 'blocked',
    reason: 'Independent acceptance coverage is unavailable.',
    evidence: [evidence('lock', { path: 'backend-node/test' })],
  });

  assert.equal(result.valid, false);
  assert.deepEqual(codes(result), new Set(['missing_evidence_path']));
});

test('evidence paths cannot escape through an in-repo filesystem link', (t) => {
  const { repoRoot } = loadDefaultAcceptance();
  const outsideDirectory = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'moli-platform-evidence-outside-',
  ));
  const outsideFile = path.join(outsideDirectory, 'outside-evidence.txt');
  const linkPath = path.join(
    repoRoot,
    'backend-node',
    'test',
    `.platform-evidence-link-${process.pid}-${Date.now()}`,
  );
  fs.writeFileSync(outsideFile, 'outside evidence', 'utf8');
  t.after(() => {
    try {
      fs.unlinkSync(linkPath);
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EISDIR') {
        fs.rmdirSync(linkPath);
      } else if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    fs.unlinkSync(outsideFile);
    fs.rmdirSync(outsideDirectory);
  });

  fs.symlinkSync(
    outsideDirectory,
    linkPath,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const linkedEvidencePath = path.relative(
    repoRoot,
    path.join(linkPath, path.basename(outsideFile)),
  );
  const result = validateDecision({
    feature_id: 'canvas.share.link',
    status: 'blocked',
    reason: 'Independent acceptance coverage is unavailable.',
    evidence: [evidence('lock', { path: linkedEvidencePath })],
  });

  assert.equal(fs.realpathSync.native(path.join(linkPath, path.basename(outsideFile))), outsideFile);
  assert.equal(result.valid, false);
  assert.deepEqual(codes(result), new Set(['missing_evidence_path']));
});

test('ordinary in-repo evidence files remain valid', () => {
  const result = validateDecision({
    feature_id: 'canvas.share.link',
    status: 'blocked',
    reason: 'Independent acceptance coverage is unavailable.',
    evidence: [evidence('lock')],
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('locked evidence cannot contain fail or blocked results', () => {
  for (const evidenceResult of ['fail', 'blocked']) {
    const completeEvidence = imageGenerationEvidence();
    completeEvidence[0].result = evidenceResult;
    const result = validateDecision({
      feature_id: 'canvas.api.image_generation',
      status: 'locked_pass',
      candidate_commit: CANDIDATE_COMMIT,
      evidence: completeEvidence,
    });

    assert.equal(result.valid, false);
    assert.ok(codes(result).has('non_passing_evidence'));
  }
});

test('locked evidence must bind every record to one candidate commit', () => {
  const completeEvidence = imageGenerationEvidence();
  completeEvidence[1].candidate_commit = OTHER_COMMIT;
  const result = validateDecision({
    feature_id: 'canvas.api.image_generation',
    status: 'locked_pass',
    candidate_commit: CANDIDATE_COMMIT,
    evidence: completeEvidence,
  });

  assert.equal(result.valid, false);
  assert.ok(codes(result).has('candidate_mismatch'));
});

test('locked_pass rejects defect and fix metadata as schema invalid', () => {
  const result = validateDecision({
    feature_id: 'canvas.api.image_generation',
    status: 'locked_pass',
    defect_id: 'DEF-1',
    fix_commit: OTHER_COMMIT,
    candidate_commit: CANDIDATE_COMMIT,
    evidence: imageGenerationEvidence(),
  });

  assert.equal(result.valid, false);
  assert.deepEqual(codes(result), new Set(['schema']));
});

test('blocked decisions without a reason fail schema validation', () => {
  const result = validateDecision({
    feature_id: 'canvas.share.link',
    status: 'blocked',
    evidence: [],
  });

  assert.equal(result.valid, false);
  assert.ok(codes(result).has('schema'));
});
