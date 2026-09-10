'use strict';

// Test-only synthetic provider responses and human decisions. All SQLite,
// reference preparation, dispatch, candidate media and approvals are real local code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, makeCandidateMedia, attemptRow, runRow, hash } = require('./redrawExecutionUnitDispatchFixture');
const runs = require('../../src/services/redrawExecutionRunService');
const reviews = require('../../src/services/redrawExecutionUnitReviewService');
const { inspectUnitReferenceMaterials } = require('../../src/services/redrawUnitReferenceService');
const { prepareUnitReferenceMaterials } = require('../../src/services/redrawUnitReferenceDerivationService');
const { compileUnitProductionPack } = require('../../src/services/redrawUnitProductionPackService');

const response = value => new Response(JSON.stringify(value), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

async function dispatchAndApprove(h, index, silent) {
  const mediaRoot = fs.mkdtempSync(path.join(h.root, 'composition-candidate-media-'));
  const bytes = await makeCandidateMedia({ ...h, root: mediaRoot }, silent ? 'silent' : 'valid', {
    color: index ? 'blue' : 'red', frequency: index ? 880 : 440,
  });
  const candidate = await runs.dispatchClaimedExecutionUnitTask(h.ctx, h.versionId, h.run.id, h.input, {
    fetchImpl: async (_url, init) => {
      h.syntheticCalls.post += 1;
      assert.equal(h.db.inTransaction, false);
      assert.equal(init.method, 'POST');
      return response({ id: `synthetic-unit-composition-${h.attemptId}`, status: 'succeeded',
        content: { video_url: `https://result.synthetic.invalid/composition-${h.attemptId}.mp4` } });
    },
    download: {
      _dnsLookupForTest: async (hostname, options) => {
        assert.equal(hostname, 'result.synthetic.invalid');
        assert.equal(options.all, true);
        return [{ address: '8.8.8.8', family: 4 }];
      },
      fetchImpl: async (_url, init) => {
        h.syntheticCalls.download += 1;
        assert.equal(h.db.inTransaction, false);
        assert.equal(init.method, 'GET');
        assert.equal(init.headers, undefined);
        return new Response(bytes, { status: 200, headers: { 'Content-Type': 'video/mp4' } });
      },
    },
  });
  assert.equal(candidate.status, 'waiting_review');
  assert.equal(attemptRow(h).output_sha256, hash(bytes));
  const publicCandidate = await reviews.getExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.unitId);
  const approved = await reviews.reviewExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.unitId, {
    expected_revision: publicCandidate.run_revision,
    expected_candidate_hash: publicCandidate.candidate_hash,
    decision: 'approved',
    checks: Object.fromEntries(publicCandidate.required_checks.map(key => [key,
      { basis: 'human_watch_listen', result: 'passed' }])),
  });
  assert.equal(approved.status, 'approved');
  const attempt = attemptRow(h);
  const envelope = JSON.parse(attempt.quality_json);
  return { attempt, bytes, file: path.resolve(h.root, envelope.candidate.relative_path) };
}

async function bindNextUnit(h, index) {
  const expected = h.expected(index);
  const material = await inspectUnitReferenceMaterials(h.ctx, expected);
  await prepareUnitReferenceMaterials(h.ctx, { ...expected, expected_materials_hash: material.materials_hash });
  const ready = await runs.inspectExecutionRunReadiness(h.ctx, h.versionId, h.run.id, {});
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  assert.equal(ready.unit.id, expected.unit_id);
  const claim = await runs.claimNextUnit(h.ctx, h.versionId, h.run.id, {
    expected_revision: ready.revision, expected_plan_hash: ready.plan_hash, expected_quote_hash: ready.quote_hash,
  });
  h.attemptId = claim.attempt_id;
  h.unitId = expected.unit_id;
  const binding = { attempt_id: h.attemptId, expected_revision: runRow(h).revision,
    expected_plan_hash: ready.plan_hash, expected_quote_hash: ready.quote_hash };
  h.binding = await runs.bindClaimedExecutionUnitTask(h.ctx, h.versionId, h.run.id, binding);
  h.input = { ...binding, expected_revision: runRow(h).revision };
  h.pack = compileUnitProductionPack({
    owner: { tenantId: h.ctx.tenantId, userId: h.ctx.userId, workId: 1, versionId: h.versionId },
    expected, queueState: h.queueState, blueprint: h.blueprint, localization: h.localization,
  });
}

async function approvedCompositionRun(t, audioMode = 'native', { createActor, dialogueTargets } = {}) {
  const h = await setup(t, 'paid', true, 'bound', { assemblyCase: true, audioMode, createActor, dialogueTargets });
  if (audioMode === 'not_required') {
    assert.deepEqual(h.blueprint.shots.flatMap(shot => shot.dialogue), []);
    assert.deepEqual(h.localization.dialogue_map, []);
    assert.deepEqual(h.queueState.saved_review.plan.units.flatMap(unit => unit.dialogues), []);
  }
  h.syntheticCalls = { post: 0, download: 0 };
  h.unitId = h.expected(0).unit_id;
  h.candidates = [await dispatchAndApprove(h, 0, audioMode === 'not_required')];
  await bindNextUnit(h, 1);
  h.candidates.push(await dispatchAndApprove(h, 1, audioMode === 'not_required'));
  assert.equal(runRow(h).status, 'completed');
  assert.deepEqual(h.syntheticCalls, { post: 2, download: 2 });
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM redraw_candidate_reviews').get().n, 0);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM video_generations').get().n, 0);
  h.sourceAsset = h.db.prepare(`SELECT a.* FROM assets a JOIN redraw_works w ON w.source_asset_id=a.id
    JOIN redraw_versions v ON v.work_id=w.id WHERE v.id=?`).get(h.versionId);
  h.sourceFile = path.resolve(h.root, h.sourceAsset.local_path);
  return h;
}

function compositionRequest(h, key = 'unit-composition-1') {
  return { schema_version: 'redraw-execution-unit-composition-v1', version_id: h.versionId,
    run_id: h.run.id, expected_plan_hash: h.run.plan_hash,
    expected_run_revision: runRow(h).revision, idempotency_key: key };
}

function protectedBusinessSnapshot(h) {
  // Only exports and their assets may be written by this package. Compare every
  // other actual business table, including generation tasks and the credit ledger.
  return h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .filter(row => !['assets', 'redraw_exports'].includes(row.name))
    .map(row => {
      assert.match(row.name, /^[a-zA-Z0-9_]+$/);
      const values = h.db.prepare(`SELECT * FROM "${row.name}"`).all().map(value => JSON.stringify(value)).sort();
      return [row.name, values];
    });
}

function candidateSnapshot(h) {
  return h.candidates.map(candidate => [candidate.file, fs.statSync(candidate.file).size,
    hash(fs.readFileSync(candidate.file))]);
}

module.exports = { approvedCompositionRun, compositionRequest, protectedBusinessSnapshot,
  candidateSnapshot, hash, runRow };
