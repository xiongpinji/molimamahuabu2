'use strict';

// Real isolated SQLite, approved multi-dialogue pack and actual media bytes.
// Provider POST and download are synthetic bottom-level fetch only; no human acceptance claim.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, makeCandidateMedia, attemptRow, runRow, hash, KEY, SECRET } = require('./helpers/redrawExecutionUnitDispatchFixture');
const runs = require('../src/services/redrawExecutionRunService');
const servicePath = path.join(__dirname, '../src/services/redrawExecutionUnitReviewService.js');
const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

function entry() {
  assert.equal(fs.existsSync(servicePath), true, 'real unit candidate read/review service entry must exist after actual dispatch');
  const service = require(servicePath);
  assert.equal(typeof service.getExecutionUnitCandidate, 'function', 'owned unit candidate read entry must exist');
  assert.equal(typeof service.reviewExecutionUnitCandidate, 'function', 'owned unit candidate review entry must exist');
  return service;
}

async function candidateFixture(t, mode = 'paid', sequential = false) {
  const h = await setup(t, mode, sequential);
  h.unitId = h.expected(0).unit_id;
  return dispatchCandidate(h);
}

async function dispatchCandidate(h, recovery = false) {
  const mediaRoot = fs.mkdtempSync(path.join(h.root, 'review-candidate-media-'));
  const bytes = await makeCandidateMedia({ ...h, root: mediaRoot });
  let posts = 0, downloads = 0;
  const runtime = {
    fetchImpl: async (_url, init) => {
      posts += 1;
      assert.equal(h.db.inTransaction, false);
      assert.equal(init.method, recovery ? 'GET' : 'POST');
      return response({ id: `synthetic-unit-review-result-${h.attemptId}`, status: 'succeeded',
        content: { video_url: `https://result.synthetic.invalid/unit-${h.attemptId}.mp4` } });
    },
    download: {
      _dnsLookupForTest: async (hostname, options) => {
        assert.equal(hostname, 'result.synthetic.invalid');
        assert.equal(options.all, true);
        return [{ address: '8.8.8.8', family: 4 }];
      },
      fetchImpl: async (_url, init) => {
        downloads += 1;
        assert.equal(h.db.inTransaction, false);
        assert.equal(init.method, 'GET');
        assert.equal(init.headers, undefined, 'provider key cannot reach the synthetic result host');
        return new Response(bytes, { status: 200, headers: { 'Content-Type': 'video/mp4' } });
      },
    },
  };
  const candidate = recovery
    ? await runs.recoverExecutionUnitTask(h.ctx, h.versionId, h.run.id, { attempt_id: h.attemptId }, runtime)
    : await runs.dispatchClaimedExecutionUnitTask(h.ctx, h.versionId, h.run.id, h.input, runtime);
  assert.equal(posts, 1); assert.equal(downloads, 1);
  assert.equal(candidate.status, 'waiting_review');
  assert.equal(attemptRow(h).output_sha256, hash(bytes));
  const asset = h.db.prepare('SELECT * FROM assets WHERE id=?').get(candidate.output_asset_id);
  assert.deepEqual(fs.readFileSync(path.join(h.root, asset.local_path)), bytes);
  h.candidateBytes = bytes;
  return h;
}

function humanChecks(candidate, result = 'passed') {
  return Object.fromEntries(candidate.required_checks.map(key => [key, {
    basis: result === 'not_checked' ? 'not_checked' : 'human_watch_listen', result,
  }]));
}

const reviewInput = (candidate, decision = 'approved', result = decision === 'approved' ? 'passed' : 'not_checked') => ({
  expected_revision: candidate.run_revision, expected_candidate_hash: candidate.candidate_hash,
  decision, checks: humanChecks(candidate, result),
});
const getCandidate = (h, ctx = h.ctx) => entry().getExecutionUnitCandidate(ctx, h.versionId, h.run.id, h.unitId);
const reviewCandidate = (h, input, ctx = h.ctx) => entry().reviewExecutionUnitCandidate(ctx, h.versionId, h.run.id, h.unitId, input);
async function inert(h, action, rejects = true) {
  const before = h.db.serialize(), changes = h.db.prepare('SELECT total_changes() n').get().n;
  const result = rejects ? await assert.rejects(action) : await action();
  assert.deepEqual(h.db.serialize(), before);
  assert.equal(h.db.prepare('SELECT total_changes() n').get().n, changes);
  return result;
}

function assertSafe(candidate) {
  const serialized = JSON.stringify(candidate);
  for (const secret of [KEY, SECRET]) assert.equal(serialized.includes(secret), false);
  assert.doesNotMatch(serialized, /claim_token|local_path|result\.synthetic\.invalid|private_binding|api_key/);
}

for (const mode of ['paid', 'free']) test(`actual ${mode} unit candidate read is 0 DML and requires human watch/listen after real probe`, async t => {
  const h = await candidateFixture(t, mode);
  const service = entry();
  const before = h.db.serialize();
  const changes = h.db.prepare('SELECT total_changes() n').get().n;
  const candidate = await service.getExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.unitId);
  assert.equal(candidate.schema_version, 'redraw-execution-unit-candidate-review-v1');
  assert.equal(candidate.status, 'waiting_review');
  assert.equal(candidate.candidate_hash, attemptRow(h).candidate_hash);
  assert.equal(candidate.asset.sha256, hash(h.candidateBytes));
  assert.equal(candidate.asset.bytes, h.candidateBytes.length);
  assert.equal(candidate.technical_qa.status, 'passed');
  assert.equal(candidate.technical_qa.method, 'ffprobe');
  assert.equal(candidate.content_qa.status, 'requires_human_review');
  assert.equal(candidate.review_policy.human_required, true);
  assert.ok(candidate.review_policy.reason_codes.includes('first_unit'));
  for (const key of ['scene_action_continuity', 'source_text_and_caption_residue', 'character_identity',
    'target_dialogue_complete', 'speaker_order', 'target_names', 'language_and_locale', 'voice_and_emotion',
    'no_extra_dialogue', 'lip_sync', 'ambient_audio']) assert.ok(candidate.required_checks.includes(key), key);
  assert.equal(candidate.required_checks.includes('no_dialogue'), false);
  assert.equal(candidate.billing.status, mode === 'paid' ? 'held' : 'no_charge');
  assert.equal(candidate.review, null);
  assertSafe(candidate);
  assert.deepEqual(h.db.serialize(), before);
  assert.equal(h.db.prepare('SELECT total_changes() n').get().n, changes);
});

test('actual paid unit review stores a separate human decision and confirms only its original hold', async t => {
  const h = await candidateFixture(t);
  const service = entry();
  const candidate = await service.getExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.unitId);
  const original = attemptRow(h), envelope = JSON.parse(original.quality_json);
  const reservations = h.db.prepare('SELECT count(*) n FROM tenant_usage_reservations').get().n;
  const decision = { expected_revision: candidate.run_revision, expected_candidate_hash: candidate.candidate_hash,
    decision: 'approved', checks: humanChecks(candidate) };
  const approved = await service.reviewExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.unitId, decision);
  const current = attemptRow(h), stored = JSON.parse(current.quality_json);
  assert.equal(approved.newly_reviewed, true);
  assert.equal(current.status, 'approved');
  assert.equal(current.candidate_hash, original.candidate_hash);
  assert.deepEqual(stored.submission, envelope.submission);
  assert.deepEqual(stored.observation, envelope.observation);
  assert.deepEqual(stored.candidate, envelope.candidate);
  assert.equal(stored.candidate.review_status, 'pending');
  assert.equal(stored.candidate.qa_status, 'not_checked');
  assert.equal(stored.review.decision, 'approved');
  assert.deepEqual(stored.review.checks, decision.checks);
  assert.equal(current.approved_by, h.ctx.userId);
  assert.equal(h.db.prepare('SELECT status FROM async_tasks WHERE id=?').get(current.task_id).status, 'completed');
  assert.equal(h.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id=?').get(original.reservation_id).status, 'confirmed');
  assert.equal(h.db.prepare("SELECT count(*) n FROM tenant_credit_ledger WHERE reservation_id=? AND event_type='confirm'")
    .get(original.reservation_id).n, 1);
  assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_usage_reservations').get().n, reservations);
  assert.equal(runRow(h).status, 'ready');
  assert.equal(runRow(h).revision, candidate.run_revision + 1);
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_execution_unit_attempts WHERE run_id=?').get(h.run.id).n, 1);
  assertSafe(approved);
  const replay = await inert(h, () => reviewCandidate(h, decision), false);
  assert.equal(replay.newly_reviewed, false);
  assert.equal((await inert(h, () => getCandidate(h), false)).status, 'approved');
  for (const changed of [{ ...decision, decision: 'rejected' },
    { ...decision, expected_candidate_hash: 'f'.repeat(64) }, { ...decision, expected_revision: 0 }]) {
    await inert(h, () => reviewCandidate(h, changed));
  }
});

test('candidate authority rejects missing explicit context and pre-existing forged task results without DML', async t => {
  const h = await candidateFixture(t), service = entry();
  for (const [name, ctx] of [['missing context', undefined], ['missing db', {}], ['missing storage', { ...h.ctx, storageRoot: undefined }]]) {
    await t.test(name, async () => {
      const before = h.db.serialize();
      await assert.rejects(service.getExecutionUnitCandidate(ctx, h.versionId, h.run.id, h.unitId),
        error => error.code === 'EXECUTION_UNIT_REVIEW_INPUT_INVALID');
      assert.deepEqual(h.db.serialize(), before);
    });
  }
  const task = h.db.prepare('SELECT * FROM async_tasks WHERE id=?').get(h.binding.task_id);
  for (const result of ['{}', JSON.stringify({ schema_version: 'redraw-execution-unit-safe-receipt-v1',
    tenant_id: 'foreign-tenant', request_hash: 'f'.repeat(64) })]) {
    await t.test(`forged task result ${result === '{}' ? 'empty object' : 'wrong receipt binding'}`, async () => {
      h.db.prepare('UPDATE async_tasks SET result=? WHERE id=?').run(result, task.id);
      const before = h.db.serialize(), changes = h.db.prepare('SELECT total_changes() n').get().n;
      try {
        await assert.rejects(service.getExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.unitId),
          error => error.code === 'EXECUTION_UNIT_REVIEW_CONFLICT');
        assert.deepEqual(h.db.serialize(), before);
        assert.equal(h.db.prepare('SELECT total_changes() n').get().n, changes);
      } finally { h.db.prepare('UPDATE async_tasks SET result=? WHERE id=?').run(task.result, task.id); }
    });
  }
  const candidate = await getCandidate(h), input = reviewInput(candidate);
  for (const ctx of [{ ...h.ctx, userId: 'foreign-user' }, { ...h.ctx, tenantId: 'foreign-tenant' }]) {
    await t.test('foreign owner cannot read or decide', async () => {
      await inert(h, () => getCandidate(h, ctx)); await inert(h, () => reviewCandidate(h, input, ctx));
    });
  }
  const key = candidate.required_checks[0];
  for (const bad of [{ ...input, checks: {} }, { ...input, checks: { ...input.checks, exemption: true } },
    { ...input, checks: { ...input.checks, [key]: true } },
    { ...input, checks: { ...input.checks, [key]: { basis: 'machine', result: 'passed' } } },
    reviewInput(candidate, 'approved', 'not_checked'), reviewInput(candidate, 'approved', 'failed'),
    { ...input, automatic: true }, { ...input, expected_revision: candidate.run_revision - 1 }]) {
    await t.test('client cannot omit, fabricate or waive human checks or CAS', () => inert(h, () => reviewCandidate(h, bad)));
  }
  const original = attemptRow(h), asset = h.db.prepare('SELECT * FROM assets WHERE id=?').get(original.output_asset_id);
  const mutations = [
    ['asset owner', 'UPDATE assets SET metadata=? WHERE id=?', [JSON.stringify({ ...JSON.parse(asset.metadata), user_id: 'foreign' }), asset.id], [asset.metadata, asset.id]],
    ['task metadata', 'UPDATE async_tasks SET metadata=? WHERE id=?', ['{}', task.id], [task.metadata, task.id]],
    ['candidate hash', 'UPDATE redraw_execution_unit_attempts SET candidate_hash=? WHERE id=?', ['f'.repeat(64), original.id], [original.candidate_hash, original.id]],
    ['pack localization', 'UPDATE redraw_versions SET localization_hash=? WHERE id=?', ['f'.repeat(64), h.versionId], [h.localization.localization_hash, h.versionId]],
  ];
  for (const [name, sql, changed, restored] of mutations) await t.test(name, async () => {
    h.db.prepare(sql).run(...changed);
    try { await inert(h, () => getCandidate(h)); await inert(h, () => reviewCandidate(h, input)); }
    finally { h.db.prepare(sql).run(...restored); }
  });
  await t.test('damaged actual output cannot be approved by checkboxes', async () => {
    const file = path.join(h.root, asset.local_path), bytes = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.alloc(bytes.length));
    try { await inert(h, () => getCandidate(h)); await inert(h, () => reviewCandidate(h, input)); }
    finally { fs.writeFileSync(file, bytes); }
  });
  for (const file of [h.motionPath, path.join(h.root, 'source/source.mp4')]) await t.test('actual source or motion bytes remain authoritative', async () => {
    const bytes = fs.readFileSync(file); fs.writeFileSync(file, Buffer.alloc(bytes.length));
    try { await inert(h, () => getCandidate(h)); await inert(h, () => reviewCandidate(h, input)); }
    finally { fs.writeFileSync(file, bytes); }
  });
});

for (const mode of ['paid', 'free']) test(`${mode} rejection records not_checked honestly, preserves billing and stops successors`, async t => {
  const h = await candidateFixture(t, mode), candidate = await getCandidate(h), input = reviewInput(candidate, 'rejected');
  const original = attemptRow(h), envelope = JSON.parse(original.quality_json);
  const ledgerBefore = h.db.prepare('SELECT * FROM tenant_credit_ledger ORDER BY id').all();
  const rejected = await reviewCandidate(h, input);
  assert.equal(rejected.status, 'rejected'); assert.equal(runRow(h).status, 'needs_attention');
  assert.equal(rejected.content_qa.status, 'requires_human_review', 'an unviewed rejection is not a watched/listened content review');
  const stored = JSON.parse(attemptRow(h).quality_json);
  assert.deepEqual(stored.candidate, envelope.candidate); assert.deepEqual(stored.submission, envelope.submission);
  assert.deepEqual(stored.review.checks, input.checks);
  assert.equal(stored.review.machine_content_qa, 'not_available');
  assert.deepEqual(h.db.prepare('SELECT * FROM tenant_credit_ledger ORDER BY id').all(), ledgerBefore);
  assert.equal(rejected.billing.status, mode === 'paid' ? 'held' : 'no_charge');
  assert.equal(attemptRow(h).approved_by, null);
  assert.equal((await inert(h, () => reviewCandidate(h, input), false)).newly_reviewed, false);
  await inert(h, () => reviewCandidate(h, { ...input, checks: humanChecks(candidate, 'failed') }));
  await inert(h, () => reviewCandidate(h, reviewInput(candidate)));
  assert.equal((await runs.inspectExecutionRunReadiness(h.ctx, h.versionId, h.run.id, {})).status, 'blocked');
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_execution_unit_attempts').get().n, 1);
});

test('free approval while paused cannot clear pause or create a charge', async t => {
  const h = await candidateFixture(t, 'free');
  runs.requestExecutionRunPause(h.ctx, h.versionId, h.run.id, { expected_revision: runRow(h).revision });
  const candidate = await getCandidate(h), input = reviewInput(candidate);
  const approved = await reviewCandidate(h, input);
  assert.equal(approved.billing.status, 'no_charge'); assert.equal(runRow(h).status, 'paused');
  assert.equal(runRow(h).pause_requested, 1); assert.equal(attemptRow(h).reservation_id, null);
  assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_usage_reservations').get().n, 0);
  assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_credit_ledger').get().n, 0);
  assert.equal((await inert(h, () => reviewCandidate(h, input), false)).newly_reviewed, false);
});

test('paid approval rolls back confirmation and all projections after later write failure or drift', async t => {
  const h = await candidateFixture(t), candidate = await getCandidate(h), input = reviewInput(candidate);
  for (const [name, statement] of [
    ['task abort', "CREATE TEMP TRIGGER review_failure BEFORE UPDATE OF status ON async_tasks BEGIN SELECT RAISE(ABORT,'synthetic task failure'); END"],
    ['attempt abort', "CREATE TEMP TRIGGER review_failure BEFORE UPDATE OF status ON redraw_execution_unit_attempts BEGIN SELECT RAISE(ABORT,'synthetic attempt failure'); END"],
    ['run abort', "CREATE TEMP TRIGGER review_failure BEFORE UPDATE OF status ON redraw_execution_runs BEGIN SELECT RAISE(ABORT,'synthetic run failure'); END"],
    ['silent postwrite drift', "CREATE TEMP TRIGGER review_failure AFTER UPDATE OF status ON redraw_execution_runs BEGIN UPDATE async_tasks SET result='{}'; END"],
    ['ledger silent drift', "CREATE TEMP TRIGGER review_failure AFTER UPDATE OF status ON redraw_execution_runs BEGIN UPDATE tenant_credit_accounts SET available=available+1; END"],
    ['upstream postwrite drift', "CREATE TEMP TRIGGER review_failure AFTER UPDATE OF status ON redraw_execution_runs BEGIN UPDATE redraw_assets SET approval_status='pending' WHERE id=205; END"],
  ]) await t.test(name, async () => {
    h.db.exec(statement); const before = h.db.serialize();
    try { await assert.rejects(reviewCandidate(h, input)); assert.deepEqual(h.db.serialize(), before); }
    finally { h.db.exec('DROP TRIGGER review_failure'); }
  });
  const reservation = h.db.prepare('SELECT * FROM tenant_usage_reservations WHERE id=?').get(attemptRow(h).reservation_id);
  for (const [column, value] of [['status', 'confirmed'], ['status', 'refunded'], ['actor_user_id', 'foreign'],
    ['model', 'wrong-model'], ['amount', reservation.amount + 1], ['operation_key', 'wrong-operation']]) await t.test(`invalid original hold ${column}:${value}`, async () => {
    h.db.prepare(`UPDATE tenant_usage_reservations SET ${column}=? WHERE id=?`).run(value, reservation.id);
    try { await inert(h, () => reviewCandidate(h, input)); }
    finally { h.db.prepare(`UPDATE tenant_usage_reservations SET ${column}=? WHERE id=?`).run(reservation[column], reservation.id); }
  });
  assert.equal((await reviewCandidate(h, input)).billing.status, 'confirmed');
});

test('real reader cleanup is outside transactions and final recheck rejects material and ledger drift', async t => {
  const h = await candidateFixture(t), candidate = await getCandidate(h), input = reviewInput(candidate);
  const source = path.resolve(h.motionPath);
  const reservation = h.db.prepare('SELECT * FROM tenant_usage_reservations WHERE id=?').get(attemptRow(h).reservation_id);
  const originalRun = runRow(h);
  for (const [name, change, restore] of [
    ['material approval', () => h.db.prepare("UPDATE redraw_assets SET approval_status='pending' WHERE id=205").run(),
      () => h.db.prepare("UPDATE redraw_assets SET approval_status='approved' WHERE id=205").run()],
    ['pause request', () => runs.requestExecutionRunPause(h.ctx, h.versionId, h.run.id, { expected_revision: originalRun.revision }),
      () => h.db.prepare('UPDATE redraw_execution_runs SET status=?,revision=?,pause_requested=?,updated_at=? WHERE id=?')
        .run(originalRun.status, originalRun.revision, originalRun.pause_requested, originalRun.updated_at, originalRun.id)],
    ['original reservation timestamp', () => h.db.prepare('UPDATE tenant_usage_reservations SET updated_at=? WHERE id=?').run('2026-09-08T12:34:56.000Z', reservation.id),
      () => h.db.prepare('UPDATE tenant_usage_reservations SET updated_at=? WHERE id=?').run(reservation.updated_at, reservation.id)],
  ]) await t.test(name, async () => {
    const originalOpen = fs.promises.open; let changed = false, before;
    fs.promises.open = async function(file, ...args) {
      assert.equal(h.db.inTransaction, false);
      const handle = await originalOpen.call(this, file, ...args);
      if (path.resolve(String(file)) === source) {
        const close = handle.close.bind(handle);
        handle.close = async () => { const value = await close(); if (!changed) {
          assert.equal(h.db.inTransaction, false); changed = true; change(); before = h.db.serialize();
        } return value; };
      }
      return handle;
    };
    try { await assert.rejects(reviewCandidate(h, input)); assert.equal(changed, true); assert.deepEqual(h.db.serialize(), before); }
    finally { fs.promises.open = originalOpen; restore(); }
  });
  // Unrelated work in this same tenant does not invalidate this reservation's review.
  const other = require('../src/services/creditLedgerService').reserve(h.db, { tenantId: h.ctx.tenantId,
    actorUserId: h.ctx.userId, operationKey: 'synthetic-unrelated-work', amount: 1, model: h.model,
    resourceType: 'synthetic_unrelated_work', resourceId: 'other' });
  const originalOpen = fs.promises.open; let changed = false;
  fs.promises.open = async function(file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    if (path.resolve(String(file)) === source) {
      const close = handle.close.bind(handle);
      handle.close = async () => { const result = await close(); if (!changed) {
        assert.equal(h.db.inTransaction, false); changed = true;
        h.db.prepare('UPDATE tenant_usage_reservations SET updated_at=? WHERE id=?').run('2026-09-08T01:23:45.000Z', other.id);
      } return result; };
    }
    return handle;
  };
  try { assert.equal((await reviewCandidate(h, input)).status, 'approved'); assert.equal(changed, true); }
  finally { fs.promises.open = originalOpen; }
  assert.equal(h.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id=?').get(other.id).status, 'held');
});

test('real fallback safe receipt survives known-ID recovery, candidate inspection and human approval', async t => {
  const h = await setup(t); h.unitId = h.expected(0).unit_id;
  h.db.exec(`CREATE TRIGGER fail_attempt_receipt BEFORE UPDATE OF provider_task_id ON redraw_execution_unit_attempts
    WHEN NEW.provider_task_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END`);
  let posts = 0;
  const submitted = await runs.dispatchClaimedExecutionUnitTask(h.ctx, h.versionId, h.run.id, h.input, {
    fetchImpl: async (_url, init) => { posts += 1; assert.equal(init.method, 'POST');
      return response({ id: `synthetic-unit-review-result-${h.attemptId}`, status: 'running' }); },
  });
  assert.equal(submitted.receipt_persisted, false); assert.equal(submitted.fallback_receipt_persisted, true);
  h.db.exec('DROP TRIGGER fail_attempt_receipt');
  const taskResult = h.db.prepare('SELECT result FROM async_tasks WHERE id=?').get(h.binding.task_id).result;
  assert.equal(JSON.parse(taskResult).schema_version, 'redraw-execution-unit-safe-receipt-v1');
  await dispatchCandidate(h, true);
  const candidate = await getCandidate(h);
  assert.equal(candidate.billing.status, 'held');
  assert.equal((await reviewCandidate(h, reviewInput(candidate))).billing.status, 'confirmed');
  assert.equal(h.db.prepare('SELECT result FROM async_tasks WHERE id=?').get(h.binding.task_id).result, taskResult);
  assert.equal(posts, 1);
  assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_usage_reservations').get().n, 1);
});

test('actual replace-mode candidate has visual checks while final audio and lip sync stay deferred to composition', async t => {
  const { fixture } = require('./helpers/redrawUnitReferenceFixture');
  const { BASE_URL, NOW } = require('./helpers/redrawExecutionUnitDispatchFixture');
  const h = await fixture(t, { durations: [15], crossParent: true, secondMotion: true, beforeReview: h => {
    h.db.prepare('UPDATE ai_service_configs SET api_key=?,base_url=? WHERE id=41').run(KEY, 'https://video.dispatch.synthetic.invalid');
    h.db.prepare('UPDATE ai_service_configs SET api_key=?,base_url=? WHERE id=42').run('synthetic-review-tts-key', 'https://tts.synthetic.invalid');
  } });
  assert.equal(h.queueState.saved_review.plan.capability.audio_mode, 'replace');
  h.ctx.env = {}; h.ctx.log = { info() {}, warn() {}, error() {} };
  h.ctx.providerAssets = { storageRoot: h.root, storageBaseUrl: BASE_URL, signingSecret: SECRET, nowMs: Date.parse(NOW) };
  const expected = h.expected(0); h.unitId = expected.unit_id;
  h.pack = require('../src/services/redrawUnitProductionPackService').compileUnitProductionPack({
    owner: { tenantId: h.ctx.tenantId, userId: h.ctx.userId, workId: 1, versionId: h.versionId },
    expected, queueState: h.queueState, blueprint: h.blueprint, localization: h.localization });
  assert.ok(h.pack.dialogues.length > 0);
  const materials = await require('../src/services/redrawUnitReferenceService').inspectUnitReferenceMaterials(h.ctx, expected);
  await require('../src/services/redrawUnitReferenceDerivationService').prepareUnitReferenceMaterials(h.ctx,
    { ...expected, expected_materials_hash: materials.materials_hash });
  const model = require('../src/services/modelPriceService').canonicalModel(h.queueState.saved_review.plan.capability.model);
  h.db.prepare(`INSERT INTO model_credit_prices(model,display_name,category,credits,pricing_mode,status,billing_unit,updated_at)
    VALUES (?,'synthetic replace','video',3,'paid','enabled','second',?) ON CONFLICT(model) DO UPDATE SET
    category='video',credits=3,pricing_mode='paid',status='enabled',billing_unit='second'`).run(model, NOW);
  h.db.prepare('DELETE FROM model_resolution_prices WHERE model=?').run(model);
  require('../src/services/creditLedgerService').setTenantAccountBalance(h.db, h.ctx.tenantId, 100);
  const bonus = require('../src/services/dailyRechargeBonusService');
  bonus.createMembership(h.db, { tenantId: h.ctx.tenantId, orderId: 'synthetic-review-bonus-order',
    packageId: 'synthetic-review-package', packageName: 'synthetic local only', dailyBonusCredits: 20 });
  h.run = runs.createExecutionRun(h.ctx, h.versionId, { expected_plan_hash: expected.plan_hash, expected_queue_id: expected.queue_id });
  const parameters = { resolution: '480p', aspect_ratio: '16:9' };
  const ready = await runs.inspectExecutionRunReadiness(h.ctx, h.versionId, h.run.id, { output_parameters: parameters });
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  const claim = await runs.claimNextUnit(h.ctx, h.versionId, h.run.id, { expected_revision: ready.revision,
    expected_plan_hash: ready.plan_hash, expected_quote_hash: ready.quote_hash, output_parameters: parameters });
  h.attemptId = claim.attempt_id;
  const binding = { attempt_id: h.attemptId, expected_revision: runRow(h).revision,
    expected_plan_hash: ready.plan_hash, expected_quote_hash: ready.quote_hash };
  h.binding = await runs.bindClaimedExecutionUnitTask(h.ctx, h.versionId, h.run.id, binding);
  h.input = { ...binding, expected_revision: runRow(h).revision };
  await dispatchCandidate(h);
  const candidate = await getCandidate(h);
  assert.deepEqual(candidate.required_checks, ['scene_action_continuity', 'source_text_and_caption_residue', 'character_identity']);
  assert.equal(candidate.content_qa.final_audio_review, 'deferred_to_composition');
  assert.equal(candidate.content_qa.machine_evidence, 'not_available');
  assert.equal(candidate.output_contract.audioMode, 'replace');
  const reservationId = attemptRow(h).reservation_id;
  const allocation = h.db.prepare('SELECT * FROM tenant_usage_reservation_allocations WHERE reservation_id=?').get(reservationId);
  assert.equal(allocation.bonus_amount, 20); assert.equal(allocation.permanent_amount, 25);
  const bucket = h.db.prepare('SELECT * FROM tenant_daily_bonus_buckets WHERE id=?').get(allocation.bonus_bucket_id);
  assert.equal(bucket.held, 20);
  bonus.createMembership(h.db, { tenantId: 'synthetic-foreign-tenant', orderId: 'synthetic-foreign-bonus-order',
    packageId: 'synthetic-review-package', packageName: 'synthetic local only', dailyBonusCredits: 20 });
  const foreign = bonus.getDailyBonusState(h.db, 'synthetic-foreign-tenant');
  require('../src/services/creditLedgerService').reserve(h.db, { tenantId: 'synthetic-foreign-tenant',
    actorUserId: 'synthetic-foreign-user', operationKey: 'synthetic-foreign-reserve', amount: 20, model,
    resourceType: 'synthetic_foreign_work', resourceId: 'foreign' });
  assert.equal(h.db.prepare('SELECT held FROM tenant_daily_bonus_buckets WHERE id=?').get(foreign.bucketId).held, 20);
  const input = reviewInput(candidate);
  for (const [column, value] of [['tenant_id', 'synthetic-foreign-tenant'], ['bonus_amount', 19], ['bonus_bucket_id', foreign.bucketId]]) {
    await t.test(`allocation ${column} drift blocks confirmation`, async () => {
      h.db.prepare(`UPDATE tenant_usage_reservation_allocations SET ${column}=? WHERE reservation_id=?`).run(value, reservationId);
      try { await inert(h, () => reviewCandidate(h, input)); }
      finally { h.db.prepare(`UPDATE tenant_usage_reservation_allocations SET ${column}=? WHERE reservation_id=?`).run(allocation[column], reservationId); }
    });
  }
  const account = h.db.prepare('SELECT * FROM tenant_credit_accounts WHERE tenant_id=?').get(h.ctx.tenantId);
  const foreignBefore = h.db.prepare('SELECT * FROM tenant_daily_bonus_buckets WHERE id=?').get(foreign.bucketId);
  const approved = await reviewCandidate(h, reviewInput(candidate));
  assert.equal(approved.billing.status, 'confirmed');
  const finalBucket = h.db.prepare('SELECT * FROM tenant_daily_bonus_buckets WHERE id=?').get(bucket.id);
  assert.equal(finalBucket.held, 0); assert.equal(finalBucket.spent, 20); assert.equal(finalBucket.available, bucket.available);
  const finalAccount = h.db.prepare('SELECT * FROM tenant_credit_accounts WHERE tenant_id=?').get(h.ctx.tenantId);
  assert.equal(finalAccount.held, account.held - 45); assert.equal(finalAccount.spent, account.spent + 45);
  assert.equal(finalAccount.available, account.available);
  assert.deepEqual(h.db.prepare('SELECT * FROM tenant_usage_reservation_allocations WHERE reservation_id=?').get(reservationId), allocation);
  assert.deepEqual(h.db.prepare('SELECT * FROM tenant_daily_bonus_buckets WHERE id=?').get(foreign.bucketId), foreignBefore);
  assert.equal(approved.content_qa.final_audio_review, 'deferred_to_composition');
  assert.equal(approved.content_qa.machine_evidence, 'not_available');
});

test('real approved first unit gates the next claim; synthetic labels and changed reviewer cannot authorize it', async t => {
  const h = await candidateFixture(t, 'paid', true), service = entry();
  const planUnits = h.queueState.saved_review.plan.units;
  assert.equal(planUnits.length, 2);
  assert.deepEqual(planUnits.map(unit => [unit.source_start_ms, unit.source_end_ms, unit.retained_duration_ms, unit.generated_duration_ms]),
    [[0, 5000, 5000, 5000], [5000, 12000, 7000, 7000]]);
  assert.deepEqual(planUnits.map(unit => unit.parent_shots.map(parent => [parent.source_start_ms, parent.source_end_ms])),
    [[[0, 5000]], [[5000, 12000]]]);
  const candidate = await service.getExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.unitId);
  await service.reviewExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.unitId, {
    expected_revision: candidate.run_revision, expected_candidate_hash: candidate.candidate_hash,
    decision: 'approved', checks: humanChecks(candidate) });
  const { inspectUnitReferenceMaterials } = require('../src/services/redrawUnitReferenceService');
  const { prepareUnitReferenceMaterials } = require('../src/services/redrawUnitReferenceDerivationService');
  const nextExpected = h.expected(1), material = await inspectUnitReferenceMaterials(h.ctx, nextExpected);
  await prepareUnitReferenceMaterials(h.ctx, { ...nextExpected, expected_materials_hash: material.materials_hash });
  const inspect = () => runs.inspectExecutionRunReadiness(h.ctx, h.versionId, h.run.id, {});
  const ready = await inspect();
  assert.equal(ready.status, 'ready'); assert.equal(ready.unit.id, nextExpected.unit_id);
  const request = { expected_revision: ready.revision, expected_plan_hash: ready.plan_hash, expected_quote_hash: ready.quote_hash };
  const first = attemptRow(h);
  await t.test('a nonempty synthetic quality label is not an approval chain', async () => {
    h.db.prepare('UPDATE redraw_execution_unit_attempts SET quality_json=? WHERE id=?').run('{"synthetic":true}', first.id);
    try {
      assert.equal((await inspect()).status, 'blocked');
      await assert.rejects(runs.claimNextUnit(h.ctx, h.versionId, h.run.id, request));
    } finally { h.db.prepare('UPDATE redraw_execution_unit_attempts SET quality_json=? WHERE id=?').run(first.quality_json, first.id); }
  });
  await t.test('changed reviewer invalidates the original readiness and claim CAS', async () => {
    h.db.prepare("UPDATE redraw_execution_unit_attempts SET approved_by='changed-reviewer' WHERE id=?").run(first.id);
    try {
      assert.notEqual((await inspect()).readiness_hash, ready.readiness_hash);
      await assert.rejects(runs.claimNextUnit(h.ctx, h.versionId, h.run.id, request));
    } finally { h.db.prepare('UPDATE redraw_execution_unit_attempts SET approved_by=? WHERE id=?').run(first.approved_by, first.id); }
  });
  const second = await runs.claimNextUnit(h.ctx, h.versionId, h.run.id, request);
  assert.equal(second.newly_claimed, true);
  const attempts = h.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE run_id=? ORDER BY id').all(h.run.id);
  assert.equal(attempts.length, 2); assert.equal(attempts[1].queue_unit_id, ready.unit.queue_unit_id);
  assert.equal(runRow(h).revision, ready.revision + 1);
  const binding = { attempt_id: second.attempt_id, expected_revision: runRow(h).revision,
    expected_plan_hash: ready.plan_hash, expected_quote_hash: ready.quote_hash };
  for (const status of ['waiting_review', 'failed', 'needs_attention']) await t.test(`real second binding rejects predecessor ${status}`, async () => {
    h.db.prepare('UPDATE redraw_execution_unit_attempts SET status=? WHERE id=?').run(status, first.id);
    try { await inert(h, () => assert.rejects(runs.bindClaimedExecutionUnitTask(h.ctx, h.versionId, h.run.id, binding),
      { code: 'EXECUTION_RUN_APPROVAL_REQUIRED' }), false); }
    finally { h.db.prepare('UPDATE redraw_execution_unit_attempts SET status=? WHERE id=?').run(first.status, first.id); }
  });
  h.binding = await runs.bindClaimedExecutionUnitTask(h.ctx, h.versionId, h.run.id, binding);
  assert.equal(h.binding.newly_bound, true); assert.equal(h.binding.attempt_id, second.attempt_id);
  assert.equal(h.binding.run_revision, binding.expected_revision + 1);
  assert.equal(h.binding.executable, false); assertSafe(h.binding);
  assert.doesNotMatch(JSON.stringify(h.binding), /reservation_id|operation_key|actor_user_id|request_hash|private|https?:/);
  h.attemptId = second.attempt_id; h.unitId = nextExpected.unit_id;
  h.input = { ...binding, expected_revision: runRow(h).revision };
  h.pack = require('../src/services/redrawUnitProductionPackService').compileUnitProductionPack({
    owner: { tenantId: h.ctx.tenantId, userId: h.ctx.userId, workId: 1, versionId: h.versionId },
    expected: nextExpected, queueState: h.queueState, blueprint: h.blueprint, localization: h.localization });
  await dispatchCandidate(h);
  assert.equal(JSON.parse(attemptRow(h).quality_json).candidate.duration_ms, 7000);
  assert.equal(JSON.parse(attemptRow(h).quality_json).submission.output_contract.durationMs, 7000);
  runs.requestExecutionRunPause(h.ctx, h.versionId, h.run.id, { expected_revision: runRow(h).revision });
  const finalCandidate = await service.getExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.unitId);
  const finalInput = { expected_revision: finalCandidate.run_revision, expected_candidate_hash: finalCandidate.candidate_hash,
    decision: 'approved', checks: humanChecks(finalCandidate) };
  assert.ok(finalCandidate.required_checks.includes('no_dialogue'));
  assert.equal(finalCandidate.required_checks.includes('target_dialogue_complete'), false);
  const firstFile = path.join(h.root, JSON.parse(first.quality_json).candidate.relative_path), firstBytes = fs.readFileSync(firstFile);
  for (const damage of ['review', 'output bytes']) {
    if (damage === 'review') h.db.prepare('UPDATE redraw_execution_unit_attempts SET quality_json=? WHERE id=?').run('{"synthetic":true}', first.id);
    else fs.writeFileSync(firstFile, Buffer.concat([firstBytes, Buffer.from('drift')]));
    const before = h.db.serialize();
    try {
      await assert.rejects(service.reviewExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.unitId, finalInput),
        error => /^EXECUTION_|^REDRAW_/.test(error.code || ''), `damaged first ${damage} cannot confirm final hold or complete run`);
      assert.deepEqual(h.db.serialize(), before);
    } finally {
      if (damage === 'review') h.db.prepare('UPDATE redraw_execution_unit_attempts SET quality_json=? WHERE id=?').run(first.quality_json, first.id);
      else fs.writeFileSync(firstFile, firstBytes);
    }
  }
  const completed = await service.reviewExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.unitId, finalInput);
  assert.equal(completed.status, 'approved'); assert.equal(runRow(h).status, 'completed');
  assert.equal(runRow(h).pause_requested, 1, 'final unit completion must preserve the existing pause request');
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_execution_unit_attempts WHERE run_id=?').get(h.run.id).n, 2);
});
