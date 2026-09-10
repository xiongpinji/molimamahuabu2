'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { fixture } = require('./helpers/redrawUnitReferenceDerivationFixture');
const materials = require('../src/services/redrawUnitReferenceDerivationService');
const runs = require('../src/services/redrawExecutionRunService');
const ledger = require('../src/services/creditLedgerService');
const tasks = require('../src/services/taskService');
const { canonicalModel } = require('../src/services/modelPriceService');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const parameters = { resolution: '480p', aspect_ratio: '16:9' };
const log = { info() {}, warn() {}, error() {} };
const rejected = error => /^(?:EXECUTION_|REDRAW_|SOURCE_|BLUEPRINT_|LOCALIZATION_|CREDIT_|INSUFFICIENT_)/.test(error.code || '');
const entry = () => { assert.equal(typeof runs.bindClaimedExecutionUnitTask, 'function', 'bindClaimedExecutionUnitTask must be implemented'); return runs.bindClaimedExecutionUnitTask; };
const row = h => h.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=?').get(h.attemptId);
const runRow = h => h.db.prepare('SELECT * FROM redraw_execution_runs WHERE id=?').get(h.run.id);
const count = db => db.prepare('SELECT total_changes() n').get().n;
const unitTasks = h => h.db.prepare("SELECT * FROM async_tasks WHERE type='redraw_execution_unit' ORDER BY id").all();
const reserveInput = (h, amount = 15) => ({ tenantId: h.ctx.tenantId, userId: h.ctx.userId, actorUserId: h.ctx.userId,
  operationKey: `redraw_execution_unit:${h.attemptId}`, model: h.model, resourceType: 'redraw_execution_unit', resourceId: String(h.attemptId), amount });
const bind = (h, input = h.input, ctx = h.ctx) => entry()(ctx, h.versionId, h.run.id, input);
function snapshot(h) {
  const names = ['redraw_execution_runs', 'redraw_execution_unit_attempts', 'async_tasks', 'credit_accounts', 'usage_reservations',
    'credit_ledger', 'tenant_credit_accounts', 'tenant_usage_reservations', 'tenant_credit_ledger', 'tenant_usage_reservation_allocations',
    'tenant_daily_bonus_buckets', 'tenant_recharge_memberships', 'billing_reconciliation_events', 'audit_events', 'provider_stability_events', 'model_credit_prices', 'assets'];
  return Object.fromEntries(names.filter(name => h.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
    .map(name => [name, h.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
}
async function branch(h, action) {
  h.db.exec('SAVEPOINT task_binding_case');
  try { return await action(); } finally { h.db.pragma('query_only=OFF'); h.db.exec('ROLLBACK TO task_binding_case; RELEASE task_binding_case'); }
}
async function setup(t, mode = 'paid') {
  const h = await fixture(t);
  h.ctx.env = {}; h.ctx.log = log;
  h.db.prepare("UPDATE ai_service_configs SET api_key='synthetic-binding-key',base_url='https://binding.synthetic.invalid' WHERE id=41").run();
  h.model = canonicalModel(h.queueState.saved_review.plan.capability.model);
  h.db.prepare(`INSERT INTO model_credit_prices(model,display_name,category,credits,pricing_mode,status,billing_unit,updated_at)
    VALUES (?,'synthetic local binding','video',?,?, 'enabled','second','2026-09-07T00:00:00.000Z')
    ON CONFLICT(model) DO UPDATE SET category='video',credits=excluded.credits,pricing_mode=excluded.pricing_mode,status='enabled',billing_unit='second'`)
    .run(h.model, mode === 'free' ? 0 : 3, mode);
  h.db.prepare('DELETE FROM model_resolution_prices WHERE model=?').run(h.model);
  ledger.setTenantAccountBalance(h.db, h.ctx.tenantId, 100);
  // A freshly migrated synthetic tenant has no membership or reward bucket on any date.
  assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_recharge_memberships').get().n, 0);
  assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_daily_bonus_buckets').get().n, 0);
  h.run = runs.createExecutionRun(h.ctx, h.versionId, { expected_plan_hash: h.expected(0).plan_hash, expected_queue_id: h.expected(0).queue_id });
  h.prepared = await materials.prepareUnitReferenceMaterials(h.ctx, { ...h.expected(0), expected_materials_hash: (await h.materials(0)).materials_hash });
  const ready = await runs.inspectExecutionRunReadiness(h.ctx, h.versionId, h.run.id, { output_parameters: parameters });
  assert.equal(ready.status, 'ready');
  const claim = await runs.claimNextUnit(h.ctx, h.versionId, h.run.id, { expected_revision: ready.revision,
    expected_plan_hash: ready.plan_hash, expected_quote_hash: ready.quote_hash, output_parameters: parameters });
  h.attemptId = claim.attempt_id;
  h.input = { attempt_id: h.attemptId, expected_revision: runRow(h).revision, expected_plan_hash: ready.plan_hash, expected_quote_hash: ready.quote_hash };
  return h;
}
function assertSafe(result) {
  assert.equal(result.executable, false);
  assert.doesNotMatch(JSON.stringify(result), /claim_token|reservation_id|operation_key|actor_user_id|request_hash|private|synthetic-binding-key|https?:|local_path/);
}
function assertBound(h, result, mode = 'paid') {
  const attempt = row(h), run = runRow(h), task = h.db.prepare('SELECT * FROM async_tasks WHERE id=?').get(result.task_id);
  assert.equal(result.newly_bound, true); assert.equal(result.attempt_id, h.attemptId); assert.equal(result.run_revision, 2);
  assert.equal(result.billing_mode, mode === 'paid' ? 'paid' : 'no_charge'); assert.equal(result.quoted_amount, mode === 'paid' ? 15 : 0);
  assertSafe(result); assert.equal(attempt.status, 'claimed'); assert.equal(attempt.task_id, task.id); assert.equal(run.revision, 2);
  assert.equal(task.type, 'redraw_execution_unit'); assert.equal(task.status, 'pending'); assert.equal(task.resource_id, String(attempt.id));
  assert.equal(task.tenant_id, h.ctx.tenantId); assert.equal(task.user_id, h.ctx.userId); assert.equal(task.model, h.queueState.saved_review.plan.capability.model);
  assert.equal(attempt.request_hash, null); assert.equal(attempt.submit_started_at, null); assert.equal(attempt.provider_task_id, null);
  assert.equal(task.provider_task_id, null);
  const metadata = JSON.parse(task.metadata), unit = h.db.prepare('SELECT * FROM redraw_execution_queue_units WHERE id=?').get(attempt.queue_unit_id);
  assert.equal(metadata.schema_version, 'redraw-execution-unit-task-binding-v1');
  for (const [key, value] of Object.entries({ tenant_id: h.ctx.tenantId, user_id: h.ctx.userId, work_id: run.work_id,
    version_id: h.versionId, run_id: run.id, attempt_id: attempt.id, queue_id: run.queue_id, queue_unit_id: unit.id,
    unit_id: unit.unit_id, unit_hash: unit.unit_hash, review_id: run.review_id, plan_hash: run.plan_hash,
    quote_hash: h.input.expected_quote_hash, binding_revision: h.input.expected_revision })) assert.equal(metadata[key], value, key);
  assert.doesNotMatch(task.metadata, /request_hash|claim_token|api_key|https?:|private_binding|local_path/);
  const account = h.db.prepare('SELECT * FROM tenant_credit_accounts WHERE tenant_id=?').get(h.ctx.tenantId);
  assert.equal(account.available, mode === 'paid' ? 85 : 100); assert.equal(account.held, mode === 'paid' ? 15 : 0); assert.equal(account.spent, 0);
  if (mode === 'paid') {
    const reservation = h.db.prepare('SELECT * FROM tenant_usage_reservations WHERE id=?').get(attempt.reservation_id);
    assert.equal(task.credit_reservation_id, reservation.id); assert.equal(reservation.status, 'held'); assert.equal(reservation.amount, 15);
    assert.equal(reservation.tenant_id, h.ctx.tenantId); assert.equal(reservation.actor_user_id, h.ctx.userId);
    assert.equal(reservation.resource_type, 'redraw_execution_unit'); assert.equal(reservation.resource_id, String(attempt.id));
    assert.equal(reservation.model, task.model); assert.equal(reservation.operation_key, reserveInput(h).operationKey);
    assert.deepEqual(result.billing, { status: 'held', amount: 15 });
    assert.equal(h.db.prepare("SELECT count(*) n FROM tenant_credit_ledger WHERE reservation_id=? AND event_type='reserve'").get(reservation.id).n, 1);
  } else {
    assert.equal(attempt.reservation_id, null); assert.equal(task.credit_reservation_id, null);
    assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_usage_reservations').get().n, 0);
    assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_credit_ledger').get().n, 0);
    assert.deepEqual(result.billing, { status: 'no_charge', amount: 0 });
  }
  assert.equal(unitTasks(h).length, 1);
}

test('real claimed-unit task binding is atomic, owner-scoped, replay-only and quote-bound', async t => {
  entry();
  const h = await setup(t);
  await t.test('paid binding creates one real task, held reservation and ledger event without provider intent', () => branch(h, async () => assertBound(h, await bind(h))));
  await t.test('strict safe IDs, plain input, Reflect whitelist and original claim quote', () => branch(h, async () => {
    const before = snapshot(h), changed = count(h.db);
    for (const value of ['1', true, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(entry()(h.ctx, value, h.run.id, h.input), rejected);
      await assert.rejects(entry()(h.ctx, h.versionId, value, h.input), rejected);
      await assert.rejects(bind(h, { ...h.input, attempt_id: value }), rejected);
    }
    for (const extra of [{ request_hash: 'f'.repeat(64) }, { model: 'client' }, { [Symbol('hidden')]: true }]) await assert.rejects(bind(h, { ...h.input, ...extra }), rejected);
    await assert.rejects(bind(h, Object.assign(Object.create({ hidden: true }), h.input)), rejected);
    for (const key of Object.keys(h.input)) { const input = { ...h.input }; delete input[key]; await assert.rejects(bind(h, input), rejected); }
    for (const changedInput of [{ expected_revision: 0 }, { expected_revision: Number.MAX_SAFE_INTEGER + 1 },
      { expected_revision: '1' }, { expected_plan_hash: 'e'.repeat(64) }, { expected_quote_hash: 'f'.repeat(64) }, { attempt_id: h.attemptId + 1 }]) {
      await assert.rejects(bind(h, { ...h.input, ...changedInput }), rejected);
    }
    for (const foreign of [{ userId: 'foreign' }, { tenantId: 'foreign' }]) await assert.rejects(bind(h, h.input, { ...h.ctx, ...foreign }), rejected);
    assert.deepEqual(snapshot(h), before); assert.equal(count(h.db), changed);
  }));
  for (const [name, sql] of [
    ['paused run', "UPDATE redraw_execution_runs SET status='paused',pause_requested=1"],
    ['revision drift', 'UPDATE redraw_execution_runs SET revision=revision+1'],
    ['unknown run', "UPDATE redraw_execution_runs SET status='needs_attention'"],
    ['unknown target', "UPDATE redraw_execution_unit_attempts SET status='needs_attention'"],
    ['submit marker', "UPDATE redraw_execution_unit_attempts SET submit_started_at='2026-09-07T01:00:00.000Z'"],
    ['provider marker', "UPDATE redraw_execution_unit_attempts SET provider_task_id='synthetic-provider-marker'"],
    ['request marker', "UPDATE redraw_execution_unit_attempts SET request_hash='" + 'a'.repeat(64) + "'"],
    ['price drift', 'UPDATE model_credit_prices SET credits=credits+1'],
    ['claimed amount drift', 'UPDATE redraw_execution_unit_attempts SET quoted_amount=quoted_amount+1'],
    ['material registration drift', "UPDATE assets SET metadata='{}' WHERE id IN (SELECT output_asset_id FROM redraw_unit_reference_derivations)"],
  ]) await t.test(name + ' rejects without side effects', () => branch(h, async () => {
    h.db.exec(sql); const before = snapshot(h), changed = count(h.db);
    await assert.rejects(bind(h), rejected); assert.deepEqual(snapshot(h), before); assert.equal(count(h.db), changed);
  }));
  await t.test('insufficient credit rolls back account, task, reservation, ledger and binding', () => branch(h, async () => {
    ledger.setTenantAccountBalance(h.db, h.ctx.tenantId, 14); const before = snapshot(h);
    await assert.rejects(bind(h), { code: 'INSUFFICIENT_CREDITS' }); assert.deepEqual(snapshot(h), before);
  }));
  for (const [name, changedInput, settle] of [
    ['amount', { amount: 16 }], ['actor', { actorUserId: 'foreign' }], ['model', { model: 'foreign' }],
    ['resource', { resourceId: '999' }], ['non-held', {}, true],
  ]) await t.test('existing reservation with wrong ' + name + ' cannot be reused', () => branch(h, async () => {
    const reservation = ledger.reserve(h.db, { ...reserveInput(h), ...changedInput });
    if (settle) ledger.confirm(h.db, reservation.id);
    const before = snapshot(h); await assert.rejects(bind(h), rejected); assert.deepEqual(snapshot(h), before);
  }));
  for (const [name, trigger] of [
    ['task insert abort', "AFTER INSERT ON async_tasks WHEN NEW.type='redraw_execution_unit' BEGIN SELECT RAISE(ABORT,'synthetic-task-insert-failure'); END"],
    ['run CAS abort', "AFTER UPDATE OF revision ON redraw_execution_runs WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'synthetic-run-cas-failure'); END"],
    ['task owner trigger drift', "AFTER UPDATE OF tenant_id ON async_tasks WHEN NEW.type='redraw_execution_unit' BEGIN UPDATE async_tasks SET user_id='foreign' WHERE id=NEW.id; END"],
    ['reservation amount trigger drift', "AFTER UPDATE OF revision ON redraw_execution_runs WHEN NEW.revision=2 BEGIN UPDATE tenant_usage_reservations SET amount=amount+1 WHERE resource_type='redraw_execution_unit'; END"],
    ['pause trigger drift', "AFTER INSERT ON async_tasks WHEN NEW.type='redraw_execution_unit' BEGIN UPDATE redraw_execution_runs SET pause_requested=1; END"],
    ['price trigger drift', "AFTER UPDATE OF revision ON redraw_execution_runs WHEN NEW.revision=2 BEGIN UPDATE model_credit_prices SET credits=credits+1; END"],
  ]) await t.test(name + ' rolls back every related table', () => branch(h, async () => {
    h.db.exec('CREATE TRIGGER synthetic_binding_fault ' + trigger); const before = snapshot(h);
    await assert.rejects(bind(h)); assert.deepEqual(snapshot(h), before);
  }));
  await t.test('exact duplicate reads real task and billing facts without media, reserve, DML or resume', () => branch(h, async () => {
    const first = await bind(h); assertBound(h, first);
    const oldOpen = fs.promises.open, oldReserve = ledger.reserve, oldCreate = tasks.createTask;
    fs.promises.open = async () => assert.fail('replay must not open media');
    ledger.reserve = () => assert.fail('replay must not reserve'); tasks.createTask = () => assert.fail('replay must not create a task');
    try {
      for (const status of ['claimed', 'needs_attention', 'failed', 'waiting_review']) {
        h.db.prepare('UPDATE redraw_execution_unit_attempts SET status=? WHERE id=?').run(status, h.attemptId);
        h.db.prepare("UPDATE redraw_execution_runs SET status='paused',pause_requested=1,revision=revision+3 WHERE id=?").run(h.run.id);
        h.db.prepare("UPDATE async_tasks SET status='needs_attention' WHERE id=?").run(first.task_id);
        const before = snapshot(h), changed = count(h.db), result = await bind(h);
        assert.equal(result.newly_bound, false); assert.equal(result.task_id, first.task_id); assert.equal(result.run_revision, runRow(h).revision);
        assert.deepEqual(result.billing, { status: 'held', amount: 15 }); assertSafe(result);
        assert.deepEqual(snapshot(h), before); assert.equal(count(h.db), changed);
      }
      ledger.confirm(h.db, row(h).reservation_id);
      const before = snapshot(h), changed = count(h.db);
      assert.deepEqual((await bind(h)).billing, { status: 'confirmed', amount: 15 });
      assert.deepEqual(snapshot(h), before); assert.equal(count(h.db), changed);
      for (const input of [{ expected_revision: 2 }, { expected_quote_hash: 'd'.repeat(64) }, { expected_plan_hash: 'e'.repeat(64) }]) {
        await assert.rejects(bind(h, { ...h.input, ...input }), rejected);
      }
    } finally { fs.promises.open = oldOpen; ledger.reserve = oldReserve; tasks.createTask = oldCreate; }
  }));
  for (const [name, sql] of [
    ['task owner', "UPDATE async_tasks SET user_id='foreign' WHERE type='redraw_execution_unit'"],
    ['task type', "UPDATE async_tasks SET type='other' WHERE type='redraw_execution_unit'"],
    ['task resource', "UPDATE async_tasks SET resource_id='999' WHERE type='redraw_execution_unit'"],
    ['task metadata', "UPDATE async_tasks SET metadata='{}' WHERE type='redraw_execution_unit'"],
    ['missing task', "DELETE FROM async_tasks WHERE type='redraw_execution_unit'"],
    ['reservation amount', "UPDATE tenant_usage_reservations SET amount=amount+1 WHERE resource_type='redraw_execution_unit'"],
    ['reservation owner', "UPDATE tenant_usage_reservations SET actor_user_id='foreign' WHERE resource_type='redraw_execution_unit'"],
    ['missing reservation link', "UPDATE async_tasks SET credit_reservation_id=NULL WHERE type='redraw_execution_unit'"],
  ]) await t.test('damaged replay ' + name + ' rejects without repair', () => branch(h, async () => {
    await bind(h); h.db.exec(sql); const before = snapshot(h), changed = count(h.db);
    await assert.rejects(bind(h), rejected); assert.deepEqual(snapshot(h), before); assert.equal(count(h.db), changed);
  }));
  await t.test('a target beyond the first pending unit is rejected before any media probe', () => branch(h, async () => {
    const second = h.db.prepare('SELECT * FROM redraw_execution_queue_units WHERE queue_id=? ORDER BY ordinal LIMIT 1 OFFSET 1').get(h.run.queue_id);
    h.db.prepare('UPDATE redraw_execution_unit_attempts SET queue_unit_id=?,unit_hash=? WHERE id=?').run(second.id, second.unit_hash, h.attemptId);
    const before = snapshot(h), changed = count(h.db), original = h.ctx.execFile;
    h.ctx.execFile = () => assert.fail('first pending rule must reject before media');
    try { await assert.rejects(bind(h), { code: 'EXECUTION_RUN_CONFLICT' }); }
    finally { h.ctx.execFile = original; }
    assert.deepEqual(snapshot(h), before); assert.equal(count(h.db), changed);
  }));
  for (const [name, sql] of [
    ['pause', 'UPDATE redraw_execution_runs SET pause_requested=1'],
    ['revision', 'UPDATE redraw_execution_runs SET revision=revision+1'],
  ]) await t.test('final transaction detects ' + name + ' introduced during real media await', () => branch(h, async () => {
    const original = h.ctx.execFile; let expected, changed;
    h.ctx.execFile = (binary, args, options, callback) => execFile(binary, args, options, (error, stdout, stderr) => {
      if (!error && !expected) { h.db.exec(sql); expected = snapshot(h); changed = count(h.db); }
      callback(error, stdout, stderr);
    });
    try { await assert.rejects(bind(h), rejected); assert.ok(expected, 'real media callback must have run');
      assert.deepEqual(snapshot(h), expected); assert.equal(count(h.db), changed);
    } finally { h.ctx.execFile = original; }
  }));
  await t.test('synthetic approval cannot authorize a second task binding', () => branch(h, async () => {
    const firstId = h.attemptId, reference = h.prepared.references[0];
    // The real second claim/bind and predecessor-status checks live in UnitReview.test.
    h.db.prepare(`UPDATE redraw_execution_unit_attempts SET status='approved',output_asset_id=?,output_sha256=?,
      candidate_hash=?,quality_json='{"synthetic_authoritative_state":true}',approved_by='synthetic-reviewer',approved_at='2026-09-07T01:00:00.000Z' WHERE id=?`)
      .run(reference.asset_id, reference.sha256, 'b'.repeat(64), firstId);
    await materials.prepareUnitReferenceMaterials(h.ctx, { ...h.expected(1), expected_materials_hash: (await h.materials(1)).materials_hash });
    const before = snapshot(h), changed = count(h.db);
    const ready = await runs.inspectExecutionRunReadiness(h.ctx, h.versionId, h.run.id, {});
    assert.equal(ready.status, 'blocked');
    assert.deepEqual(snapshot(h), before); assert.equal(count(h.db), changed);
  }));
});

test('free claimed unit creates a real pending task with no reservation or ledger call', async t => {
  entry(); const h = await setup(t, 'free'), oldReserve = ledger.reserve;
  ledger.reserve = () => assert.fail('free binding must not call ledger.reserve');
  try { assertBound(h, await bind(h), 'free'); const before = snapshot(h), changed = count(h.db);
    assert.equal((await bind(h)).newly_bound, false); assert.deepEqual(snapshot(h), before); assert.equal(count(h.db), changed);
  } finally { ledger.reserve = oldReserve; }
});

test('damaged stored task binding is INVALID before comparing caller CAS', async t => {
  entry(); const h = await setup(t);
  for (const [name, sql] of [
    ['metadata parse', "UPDATE async_tasks SET metadata='{' WHERE type='redraw_execution_unit'"],
    ['metadata shape', "UPDATE async_tasks SET metadata='{}' WHERE type='redraw_execution_unit'"],
    ['metadata revision', "UPDATE async_tasks SET metadata=json_set(metadata,'$.binding_revision',-1) WHERE type='redraw_execution_unit'"],
    ['metadata quote', "UPDATE async_tasks SET metadata=json_set(metadata,'$.quote_hash','wrong') WHERE type='redraw_execution_unit'"],
    ['task owner', "UPDATE async_tasks SET tenant_id='foreign' WHERE type='redraw_execution_unit'"],
    ['task model', "UPDATE async_tasks SET model='foreign' WHERE type='redraw_execution_unit'"],
    ['missing task', "DELETE FROM async_tasks WHERE type='redraw_execution_unit'"],
    ['task reservation link', "UPDATE async_tasks SET credit_reservation_id=NULL WHERE type='redraw_execution_unit'"],
    ['reservation owner', "UPDATE tenant_usage_reservations SET actor_user_id='foreign' WHERE resource_type='redraw_execution_unit'"],
    ['reservation amount', "UPDATE tenant_usage_reservations SET amount=amount+1 WHERE resource_type='redraw_execution_unit'"],
    ['partial attempt link', 'UPDATE redraw_execution_unit_attempts SET task_id=NULL'],
    ['erased attempt links', 'UPDATE redraw_execution_unit_attempts SET task_id=NULL,reservation_id=NULL'],
  ]) await t.test(name, () => branch(h, async () => {
    await bind(h); h.db.exec(sql); const before = snapshot(h), changed = count(h.db);
    for (const expected_revision of [h.input.expected_revision, h.input.expected_revision + 99]) {
      await assert.rejects(bind(h, { ...h.input, expected_revision }), { code: 'EXECUTION_RUN_INVALID' });
    }
    assert.deepEqual(snapshot(h), before); assert.equal(count(h.db), changed);
  }));
  await t.test('intact stored binding with non-exact input remains CONFLICT', () => branch(h, async () => {
    await bind(h); const before = snapshot(h), changed = count(h.db);
    for (const altered of [{ expected_revision: 2 }, { expected_plan_hash: 'e'.repeat(64) }, { expected_quote_hash: 'f'.repeat(64) }]) {
      await assert.rejects(bind(h, { ...h.input, ...altered }), { code: 'EXECUTION_RUN_CONFLICT' });
    }
    assert.deepEqual(snapshot(h), before); assert.equal(count(h.db), changed);
  }));
});

function absoluteBinary(file) {
  const candidates = path.isAbsolute(file) ? [file]
    : [path.resolve(file), ...String(process.env.PATH || '').split(path.delimiter)
      .filter(Boolean).map(directory => path.join(directory, file))];
  const absolute = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  assert.ok(absolute, `local media executable must resolve: ${path.basename(file)}`);
  return path.resolve(absolute);
}
function child(t, h) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-binding-child-'));
  const env = { TEMP: cwd, TMP: cwd, TMPDIR: cwd, NODE_ENV: 'test', NODE_OPTIONS: '', PATH: '',
    FFMPEG_PATH: absoluteBinary(getFfmpegPath()), FFPROBE_PATH: absoluteBinary(getFfprobePath()) };
  if (process.platform === 'win32') for (const name of ['SystemRoot', 'WINDIR']) if (process.env[name]) env[name] = process.env[name];
  const preload = path.join(__dirname, 'helpers/redrawExecutionChildPreload.cjs');
  assert.equal(createHash('sha256').update(fs.readFileSync(preload)).digest('hex'), '4d918353b528d3457433734cdc3c5cbf1b01442cd186f3e4edb3acb57e23942e');
  const payload = { databaseFile: h.db.name, storageRoot: h.root, versionId: h.versionId, runId: h.run.id, input: h.input };
  const proc = spawn(process.execPath, ['--require', preload, path.join(__dirname, 'helpers/redrawExecutionTaskBindingChild.cjs'), JSON.stringify(payload)],
    { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', buffer = '', done = false, timedOut = false; const messages = [], waiters = [];
  const timer = setTimeout(() => { if (!done) { timedOut = true; proc.kill(); } }, 60000);
  const result = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.stdout.on('data', bytes => { stdout += bytes; buffer += bytes;
      for (;;) { const at = buffer.indexOf('\n'); if (at < 0) break; const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (!line) continue;
        const message = JSON.parse(line); messages.push(message);
        for (const waiter of [...waiters]) if (waiter.type === message.type) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
      }
    });
    proc.stderr.on('data', bytes => { stderr += bytes; });
    proc.on('close', (code, signal) => {
      done = true; clearTimeout(timer);
      for (const waiter of waiters) waiter.reject(new Error('binding child ended before ' + waiter.type + ': ' + stdout + ' ' + stderr));
      const prefix = path.join(process.env.G4_TASK_BINDING_EVIDENCE_DIR || cwd, path.basename(cwd));
      fs.writeFileSync(prefix + '.stdout.jsonl', stdout, { flag: 'wx' }); fs.writeFileSync(prefix + '.stderr.txt', stderr, { flag: 'wx' });
      fs.writeFileSync(prefix + '.native.json', JSON.stringify({ code, signal, timed_out: timedOut, cwd, node: process.execPath,
        environment_names: Object.keys(env).sort(), activities_remaining: [] }), { flag: 'wx' });
      resolve({ code, signal, timedOut, messages, stderr });
    });
  });
  t.after(async () => { if (!done) proc.kill(); await result; });
  return { result, wait: type => { const message = messages.find(value => value.type === type);
    return message ? Promise.resolve(message) : new Promise((resolve, reject) => waiters.push({ type, resolve, reject })); } };
}
test('two real guarded child processes bind one task and one reservation after a real WAL writer lock', async t => {
  entry(); const h = await setup(t);
  assert.equal(h.db.pragma('journal_mode=WAL', { simple: true }), 'wal'); h.db.exec('BEGIN IMMEDIATE');
  const a = child(t, h), b = child(t, h);
  try { const barriers = await Promise.all([a.wait('binding_transaction_waiting'), b.wait('binding_transaction_waiting')]);
    assert.ok(barriers.every(value => value.contention === 'SQLITE_BUSY' && value.initial_tasks === 0 && value.probes >= 3), JSON.stringify(barriers));
  } finally { h.db.exec('COMMIT'); }
  const results = await Promise.all([a.result, b.result]);
  assert.deepEqual(results.map(value => value.code), [0, 0], JSON.stringify(results));
  assert.ok(results.every(value => value.timedOut === false && value.signal === null));
  const bindings = results.map(value => value.messages.find(message => message.type === 'result').result);
  assert.deepEqual(bindings.map(value => value.newly_bound).sort(), [false, true]); assert.equal(bindings[0].task_id, bindings[1].task_id);
  assertBound(h, bindings.find(value => value.newly_bound));
  assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_usage_reservations').get().n, 1);
  assert.ok(results.every(value => value.messages.find(message => message.type === 'started').guard_count === 11));
});
