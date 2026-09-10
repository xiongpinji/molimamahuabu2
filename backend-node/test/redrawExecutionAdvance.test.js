'use strict';

// Actual plan/prepared/claim/bind SQLite stages. Only the bottom transport is synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { setup, runRow, attemptRow, makeCandidateMedia, KEY, SECRET } = require('./helpers/redrawExecutionUnitDispatchFixture');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const runs = require('../src/services/redrawExecutionRunService');
const reviews = require('../src/services/redrawExecutionUnitReviewService');
const { compileUnitProductionPack } = require('../src/services/redrawUnitProductionPackService');
const { inspectPreparedUnitReferenceMaterials,
  prepareUnitReferenceMaterials } = require('../src/services/redrawUnitReferenceDerivationService');
const parameters = { resolution: '480p', aspect_ratio: '16:9' };

function entry() {
  for (const name of ['inspectExecutionRunAdvanceReadiness', 'resumeExecutionRun', 'advanceExecutionRun']) {
    assert.equal(typeof runs[name], 'function', `real ${name} entry must exist after actual persisted stage`);
  }
  return runs;
}
function inputFor(ready) {
  return { expected_revision: ready.run_revision, expected_plan_hash: ready.plan_hash,
    expected_quote_hash: ready.quote_hash, expected_confirmation_hash: ready.confirmation_hash,
    output_parameters: parameters };
}

test('new action entries reject missing trusted context with a safe domain error before any dependency', async () => {
  const input = { expected_revision: 0, expected_plan_hash: 'a'.repeat(64), expected_quote_hash: 'b'.repeat(64),
    expected_confirmation_hash: 'c'.repeat(64), output_parameters: parameters };
  for (const ctx of [undefined, null, {}, { db: {} }]) {
    for (const method of ['inspectExecutionRunAdvanceReadiness', 'resumeExecutionRun', 'advanceExecutionRun']) {
      await assert.rejects(() => entry()[method](ctx, 1, 1, method.startsWith('inspect') ? {} : input,
        { fetchImpl: async () => { assert.fail('invalid context cannot call transport'); } }), { code: 'REDRAW_VERSION_NOT_FOUND' });
    }
  }
});
function counts(h) {
  return Object.fromEntries([
    ['attempts', 'redraw_execution_unit_attempts'], ['tasks', 'async_tasks'],
    ['reservations', 'tenant_usage_reservations'], ['ledger', 'tenant_credit_ledger'],
  ].map(([name, table]) => [name, h.db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
}
function safe(value) {
  const json = JSON.stringify(value);
  for (const secret of [KEY, SECRET]) assert.equal(json.includes(secret), false);
  assert.doesNotMatch(json, /claim_token|binding_revision|reservation_id|private_binding|api_key|local_path|https?:/);
}
async function inspect(h) {
  const before = h.db.serialize(), changes = h.db.prepare('SELECT total_changes() n').get().n;
  h.db.pragma('query_only = ON');
  let ready;
  try { ready = await entry().inspectExecutionRunAdvanceReadiness(h.ctx, h.versionId, h.run.id, { output_parameters: parameters }); }
  finally { h.db.pragma('query_only = OFF'); }
  assert.deepEqual(h.db.serialize(), before);
  assert.equal(h.db.prepare('SELECT total_changes() n').get().n, changes);
  safe(ready); return ready;
}
function acceptedRuntime(h) {
  let posts = 0;
  return { get posts() { return posts; }, runtime: { fetchImpl: async (_url, init) => {
    assert.equal(h.db.inTransaction, false); assert.equal(init.method, 'POST'); posts += 1;
    return new Response(JSON.stringify({ id: 'synthetic-advance-task', status: 'running' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  } } };
}
function absoluteBinary(file) {
  const candidates = path.isAbsolute(file) ? [file]
    : [path.resolve(file), ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, file))];
  const found = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  assert.ok(found, `local media executable must resolve: ${path.basename(file)}`); return found;
}
function child(t, h, action, input, contend = false) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-advance-child-'));
  const ownedDirectory = fs.lstatSync(cwd, { bigint: true });
  assert.equal(path.dirname(path.resolve(cwd)), path.dirname(path.resolve(h.root)));
  assert.equal(ownedDirectory.isDirectory() && !ownedDirectory.isSymbolicLink(), true);
  const env = { TEMP: cwd, TMP: cwd, TMPDIR: cwd, NODE_ENV: 'test', NODE_OPTIONS: '', PATH: '',
    FFMPEG_PATH: absoluteBinary(getFfmpegPath()), FFPROBE_PATH: absoluteBinary(getFfprobePath()) };
  if (process.platform === 'win32') for (const name of ['SystemRoot', 'WINDIR']) if (process.env[name]) env[name] = process.env[name];
  const preload = path.join(__dirname, 'helpers/redrawExecutionChildPreload.cjs');
  assert.equal(createHash('sha256').update(fs.readFileSync(preload)).digest('hex'), '4d918353b528d3457433734cdc3c5cbf1b01442cd186f3e4edb3acb57e23942e');
  const payload = { databaseFile: h.db.name, storageRoot: h.root, versionId: h.versionId, runId: h.run.id, action, input, contend };
  const proc = spawn(process.execPath, ['--require', preload, path.join(__dirname, 'helpers/redrawExecutionAdvanceChild.cjs'), JSON.stringify(payload)],
    { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', buffer = '', done = false, timedOut = false; const messages = [], waiters = [];
  let termination;
  const terminateOwnedTree = () => {
    if (done || !proc.pid) return Promise.resolve();
    if (termination) return termination;
    if (process.platform !== 'win32') {
      try { process.kill(-proc.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      termination = Promise.resolve(); return termination;
    }
    const taskkill = path.join(env.SystemRoot, 'System32', 'taskkill.exe');
    assert.ok(path.isAbsolute(taskkill) && fs.statSync(taskkill).isFile());
    termination = new Promise((resolve, reject) => {
      const killer = spawn(taskkill, ['/PID', String(proc.pid), '/T', '/F'], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      killer.stdout.on('data', bytes => { output += bytes; }); killer.stderr.on('data', bytes => { output += bytes; });
      killer.on('error', reject);
      killer.on('close', (code, signal) => {
        t.diagnostic(JSON.stringify({ type: 'owned_tree_termination', target_pid: proc.pid, code, signal, output }));
        if (code !== 0 && !done) reject(new Error('owned child tree termination failed'));
        else resolve();
      });
    });
    return termination;
  };
  const timer = setTimeout(() => {
    if (!done) { timedOut = true; terminateOwnedTree().catch(error => t.diagnostic(error.message)); }
  }, 60000);
  const result = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.stdout.on('data', bytes => {
      stdout += bytes; buffer += bytes;
      for (;;) {
        const at = buffer.indexOf('\n'); if (at < 0) break;
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (!line) continue;
        const message = JSON.parse(line); messages.push(message);
        for (const waiter of [...waiters]) if (waiter.type === message.type) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
      }
    });
    proc.stderr.on('data', bytes => { stderr += bytes; });
    proc.on('close', (code, signal) => {
      done = true; clearTimeout(timer);
      for (const waiter of waiters) waiter.reject(new Error('advance child ended before ' + waiter.type + ': ' + stdout + stderr));
      const record = { code, signal, timed_out: timedOut, node: process.execPath,
        environment_names: Object.keys(env).sort(), messages, stderr, activities_remaining: [] };
      // The native parent TAP preserves evidence after this owned fixture is cleaned.
      t.diagnostic(JSON.stringify(record));
      resolve(record);
    });
  });
  t.after(async () => {
    await terminateOwnedTree(); await result; if (termination) await termination;
    const current = fs.lstatSync(cwd, { bigint: true });
    assert.equal(path.dirname(path.resolve(cwd)), path.resolve(os.tmpdir()));
    assert.equal(path.basename(cwd).startsWith('g4-advance-child-'), true);
    assert.equal(current.isDirectory() && !current.isSymbolicLink(), true);
    assert.equal(current.dev, ownedDirectory.dev); assert.equal(current.ino, ownedDirectory.ino);
    assert.equal(current.birthtimeNs, ownedDirectory.birthtimeNs);
    fs.rmSync(cwd, { recursive: true });
  });
  return { result, wait: type => {
    const message = messages.find(value => value.type === type);
    return message ? Promise.resolve(message) : new Promise((resolve, reject) => waiters.push({ type, resolve, reject }));
  } };
}

test('actual idle pause resumes only the run; a fresh confirmation then claims, binds and dispatches once', async t => {
  const h = await setup(t, 'paid', false, 'idle');
  assert.equal(counts(h).attempts, 0);
  runs.requestExecutionRunPause(h.ctx, h.versionId, h.run.id, { expected_revision: runRow(h).revision });
  const ready = await inspect(h);
  assert.equal(ready.status, 'ready'); assert.equal(ready.phase, 'idle'); assert.equal(ready.action, 'resume');
  const before = counts(h), revision = runRow(h).revision;
  const resumed = await entry().resumeExecutionRun(h.ctx, h.versionId, h.run.id, inputFor(ready));
  assert.equal(resumed.run_revision, revision + 1); assert.equal(resumed.pause_requested, false);
  assert.deepEqual(counts(h), before); safe(resumed);
  await assert.rejects(() => entry().resumeExecutionRun(h.ctx, h.versionId, h.run.id, inputFor(ready)), { code: 'EXECUTION_RUN_CONFLICT' });
  const fresh = await inspect(h); assert.equal(fresh.action, 'advance');
  assert.notEqual(fresh.confirmation_hash, ready.confirmation_hash);
  const transport = acceptedRuntime(h);
  const result = await entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, inputFor(fresh), transport.runtime);
  h.attemptId = result.attempt_id;
  assert.equal(transport.posts, 1); assert.equal(counts(h).attempts, 1);
  assert.equal(counts(h).reservations, before.reservations + 1);
  assert.equal(attemptRow(h).quote_hash, fresh.quote_hash); assert.equal(attemptRow(h).status, 'running'); safe(result);
});

for (const [stage, phase] of [['unbound', 'claimed_unbound'], ['bound', 'claimed_bound']]) {
  test(`actual ${phase} interruption reopens SQLite and resumes the original attempt without duplicate hold`, async t => {
    const h = await setup(t, 'paid', false, stage);
    const original = attemptRow(h), before = counts(h);
    assert.equal(original.status, 'claimed'); assert.equal(original.submit_started_at, null);
    assert.equal(original.task_id === null, stage === 'unbound');
    const ready = await inspect(h);
    assert.equal(ready.phase, phase); assert.equal(ready.quote_hash, original.quote_hash);
    const reopened = await child(t, h, 'advance', inputFor(ready)).result;
    assert.equal(reopened.code, 0, JSON.stringify(reopened)); assert.equal(reopened.signal, null); assert.equal(reopened.timed_out, false);
    const reply = reopened.messages.find(value => value.type === 'result');
    assert.equal(reply.posts, 1); assert.equal(reply.result.attempt_id, original.id); safe(reply.result);
    const after = attemptRow(h);
    assert.equal(after.id, original.id); assert.equal(after.quote_hash, original.quote_hash);
    assert.equal(counts(h).attempts, before.attempts);
    assert.equal(counts(h).reservations, before.reservations + (stage === 'unbound' ? 1 : 0));
    if (stage === 'bound') { assert.equal(after.task_id, original.task_id); assert.equal(after.reservation_id, original.reservation_id); }
    assert.equal(after.status, 'running');
  });
}

async function inert(h, action, code) {
  const before = h.db.serialize(), changes = h.db.prepare('SELECT total_changes() n').get().n;
  await assert.rejects(action, code ? { code } : error => typeof error.code === 'string' && error.code !== 'ERR_ASSERTION');
  assert.deepEqual(h.db.serialize(), before);
  assert.equal(h.db.prepare('SELECT total_changes() n').get().n, changes);
}

for (const stage of ['idle', 'unbound', 'bound']) {
  test(`${stage} strictly binds owner, parameters and policy; pause/resume writes only the run`, async t => {
    const h = await setup(t, 'paid', false, stage), transport = acceptedRuntime(h);
    const ready = await inspect(h), input = inputFor(ready);
    for (const bad of [{ ...input, phase: stage }, { ...input, attempt_id: 1 }, { ...input, binding_revision: 1 },
      { ...input, key: KEY }, { ...input, runtime: {} }, { ...input, expected_confirmation_hash: '' },
      { ...input, output_parameters: { ...parameters, extra: true } }, { ...input, [Symbol('extra')]: true }]) {
      await inert(h, () => entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, bad, transport.runtime), 'EXECUTION_RUN_INPUT_INVALID');
    }
    for (const key of ['expected_revision', 'expected_plan_hash', 'expected_quote_hash', 'expected_confirmation_hash']) {
      await inert(h, () => entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id,
        { ...input, [key]: key === 'expected_revision' ? input[key] + 1 : 'f'.repeat(64) }, transport.runtime), 'EXECUTION_RUN_CONFLICT');
    }
    for (const owner of [{ tenantId: 'foreign-tenant' }, { userId: 'foreign-user' }]) {
      await inert(h, () => entry().inspectExecutionRunAdvanceReadiness({ ...h.ctx, ...owner }, h.versionId, h.run.id,
        { output_parameters: parameters }), 'REDRAW_VERSION_NOT_FOUND');
      await inert(h, () => entry().advanceExecutionRun({ ...h.ctx, ...owner }, h.versionId, h.run.id, input, transport.runtime), 'REDRAW_VERSION_NOT_FOUND');
    }
    runs.requestExecutionRunPause(h.ctx, h.versionId, h.run.id, { expected_revision: runRow(h).revision });
    await inert(h, () => entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, input, transport.runtime), 'EXECUTION_RUN_CONFLICT');
    const paused = await inspect(h), before = counts(h);
    assert.equal(paused.phase, stage === 'idle' ? 'idle' : `claimed_${stage}`);
    assert.equal(paused.action, 'resume');
    const oldAttempts = h.db.prepare('SELECT * FROM redraw_execution_unit_attempts').all();
    const oldTasks = h.db.prepare('SELECT * FROM async_tasks').all();
    const oldHolds = h.db.prepare('SELECT * FROM tenant_usage_reservations').all();
    const changes = h.db.prepare('SELECT total_changes() n').get().n;
    const resumed = await entry().resumeExecutionRun(h.ctx, h.versionId, h.run.id, inputFor(paused));
    assert.equal(resumed.run_revision, paused.run_revision + 1);
    assert.equal(h.db.prepare('SELECT total_changes() n').get().n, changes + 1);
    assert.deepEqual(counts(h), before);
    assert.deepEqual(h.db.prepare('SELECT * FROM redraw_execution_unit_attempts').all(), oldAttempts);
    assert.deepEqual(h.db.prepare('SELECT * FROM async_tasks').all(), oldTasks);
    assert.deepEqual(h.db.prepare('SELECT * FROM tenant_usage_reservations').all(), oldHolds);
    await inert(h, () => entry().resumeExecutionRun(h.ctx, h.versionId, h.run.id, inputFor(paused)), 'EXECUTION_RUN_CONFLICT');
    const fresh = await inspect(h);
    assert.notEqual(fresh.confirmation_hash, paused.confirmation_hash);
    const policy = h.db.prepare('SELECT execution_mode,policy_version FROM redraw_projects WHERE id=1').get();
    h.db.prepare("UPDATE redraw_projects SET execution_mode='auto',policy_version=policy_version+1 WHERE id=1").run();
    h.db.prepare("UPDATE redraw_projects SET execution_mode='safe',policy_version=policy_version+1 WHERE id=1").run();
    assert.equal(policy.execution_mode, 'safe');
    await inert(h, () => entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, inputFor(fresh), transport.runtime), 'EXECUTION_RUN_CONFLICT');
    const currentPolicy = await inspect(h);
    assert.equal(currentPolicy.policy.policy_version, policy.policy_version + 2);
    assert.notEqual(currentPolicy.confirmation_hash, fresh.confirmation_hash);
    assert.equal(transport.posts, 0);
  });
}

test('bound original quote, selected row and actual material bytes cannot drift into a new submission or refund', async t => {
  const h = await setup(t), ready = await inspect(h), input = inputFor(ready), transport = acceptedRuntime(h);
  const original = attemptRow(h), hold = h.db.prepare('SELECT * FROM tenant_usage_reservations WHERE id=?').get(original.reservation_id);
  const price = h.db.prepare('SELECT credits FROM model_credit_prices WHERE model=?').get(h.model);
  h.db.prepare('UPDATE model_credit_prices SET credits=credits+1 WHERE model=?').run(h.model);
  await inert(h, () => entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, input, transport.runtime));
  h.db.prepare('UPDATE model_credit_prices SET credits=? WHERE model=?').run(price.credits, h.model);
  const selected = h.db.prepare('SELECT updated_at FROM ai_service_configs WHERE id=41').get();
  h.db.prepare('UPDATE ai_service_configs SET updated_at=? WHERE id=41').run('2026-09-08T12:00:00.000Z');
  await inert(h, () => entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, input, transport.runtime));
  h.db.prepare('UPDATE ai_service_configs SET updated_at=? WHERE id=41').run(selected.updated_at);
  const reference = h.prepared.prepared_materials.references.find(value => value.kind === 'image');
  const asset = h.db.prepare('SELECT local_path FROM assets WHERE id=?').get(reference.asset_id);
  const file = path.join(h.root, asset.local_path), bytes = fs.readFileSync(file);
  fs.appendFileSync(file, Buffer.from('owned-material-drift'));
  try { await inert(h, () => entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, input, transport.runtime)); }
  finally { fs.writeFileSync(file, bytes); }
  assert.deepEqual(attemptRow(h), original);
  assert.deepEqual(h.db.prepare('SELECT * FROM tenant_usage_reservations WHERE id=?').get(original.reservation_id), hold);
  assert.equal(transport.posts, 0);
});

for (const [stage, trigger] of [
  ['idle', 'AFTER INSERT ON redraw_execution_unit_attempts'],
  ['unbound', 'AFTER INSERT ON async_tasks'],
  ['bound', 'AFTER UPDATE OF submit_started_at ON redraw_execution_unit_attempts WHEN NEW.submit_started_at IS NOT NULL'],
]) {
  test(`${stage} final synchronous policy trigger rolls back that local stage before transport`, async t => {
    const h = await setup(t, 'paid', false, stage), input = inputFor(await inspect(h)), transport = acceptedRuntime(h);
    h.db.exec(`CREATE TRIGGER advance_policy_drift ${trigger} BEGIN UPDATE redraw_projects SET policy_version=policy_version+1 WHERE id=1; END;`);
    const before = h.db.serialize();
    await assert.rejects(() => entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, input, transport.runtime), { code: 'EXECUTION_RUN_CONFLICT' });
    assert.deepEqual(h.db.serialize(), before); assert.equal(transport.posts, 0);
  });
}

test('policy changes during a real media await invalidate the action before bind and preserve the original claimed row', async t => {
  const h = await setup(t, 'paid', false, 'unbound'), ready = await inspect(h), original = attemptRow(h), before = counts(h);
  const transport = acceptedRuntime(h), originalOpen = fs.promises.open; let changed = false, mutationCount = 0;
  fs.promises.open = async function(file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    if (path.resolve(String(file)) === path.resolve(h.motionPath)) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        const result = await close();
        if (!changed) {
          assert.equal(h.db.inTransaction, false); changed = true; mutationCount += 1;
          h.db.prepare('UPDATE redraw_projects SET policy_version=policy_version+1 WHERE id=1').run();
        }
        return result;
      };
    }
    return handle;
  };
  try { await assert.rejects(() => entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, inputFor(ready), transport.runtime), { code: 'EXECUTION_RUN_CONFLICT' }); }
  finally { fs.promises.open = originalOpen; }
  assert.equal(changed, true); assert.equal(mutationCount, 1);
  assert.deepEqual(attemptRow(h), original); assert.deepEqual(counts(h), before); assert.equal(transport.posts, 0);
});

for (const stage of ['idle', 'unbound']) test(`two actual ${stage} child lock waiters create one attempt, task, hold and POST; loser only echoes`, async t => {
  const h = await setup(t, 'paid', false, stage), ready = await inspect(h);
  h.db.pragma('journal_mode = WAL'); h.db.exec('BEGIN IMMEDIATE');
  const a = child(t, h, 'advance', inputFor(ready), true), b = child(t, h, 'advance', inputFor(ready), true);
  try {
    const barriers = await Promise.all([a.wait('transaction_waiting'), b.wait('transaction_waiting')]);
    assert.deepEqual(barriers.map(value => value.code), ['SQLITE_BUSY', 'SQLITE_BUSY']);
  } finally { h.db.exec('COMMIT'); }
  const results = await Promise.all([a.result, b.result]);
  assert.deepEqual(results.map(value => value.code), [0, 0], JSON.stringify(results));
  const replies = results.map(value => value.messages.find(message => message.type === 'result'));
  assert.equal(replies.reduce((sum, value) => sum + value.posts, 0), 1);
  assert.deepEqual(replies.map(value => value.result.changed).sort(), [false, true]);
  assert.equal(replies[0].result.attempt_id, replies[1].result.attempt_id);
  assert.equal(counts(h).attempts, 1); assert.equal(counts(h).reservations, 1);
  assert.equal(h.db.prepare("SELECT count(*) n FROM async_tasks WHERE type='redraw_execution_unit'").get().n, 1);
});

for (const outcome of ['unknown', 'known', 'failed']) test(`submitted ${outcome} fact never re-POSTs or queries on read/advance; known ID requires explicit recover`, async t => {
  const h = await setup(t), ready = await inspect(h), input = inputFor(ready); let posts = 0, queries = 0;
  const runtime = { fetchImpl: async (_url, init) => {
    assert.equal(h.db.inTransaction, false);
    if (init.method === 'POST') {
      posts += 1;
      if (outcome === 'unknown') throw new Error('synthetic response lost after acceptance');
    } else { assert.equal(init.method, 'GET'); queries += 1; }
    return new Response(JSON.stringify({ id: 'synthetic-known-advance', status: outcome === 'failed' ? 'failed' : 'running' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  } };
  const result = await entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, input, runtime);
  assert.equal(result.attempt_id, h.attemptId);
  assert.equal(attemptRow(h).status, outcome === 'unknown' ? 'needs_attention' : outcome === 'failed' ? 'failed' : 'running');
  assert.ok(attemptRow(h).request_hash && attemptRow(h).submit_started_at);
  const before = h.db.serialize(), changes = h.db.prepare('SELECT total_changes() n').get().n;
  const repeated = await entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, input, runtime);
  assert.equal(repeated.changed, false); assert.equal(repeated.attempt_id, h.attemptId);
  assert.equal((await inspect(h)).status, 'blocked');
  runs.getExecutionRun(h.ctx, h.versionId, h.run.id);
  assert.deepEqual(h.db.serialize(), before); assert.equal(h.db.prepare('SELECT total_changes() n').get().n, changes);
  assert.equal(posts, 1); assert.equal(queries, 0);
  const recovered = await runs.recoverExecutionUnitTask(h.ctx, h.versionId, h.run.id, { attempt_id: h.attemptId }, runtime);
  assert.equal(recovered.attempt_id, h.attemptId); assert.equal(posts, 1); assert.equal(queries, outcome === 'known' ? 1 : 0);
  assert.equal(h.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id=?').get(attemptRow(h).reservation_id).status,
    outcome === 'failed' ? 'refunded' : 'held');
});

for (const stage of ['idle', 'unbound', 'bound']) test(`free ${stage} advance has one real task and zero reservation or ledger write`, async t => {
  const h = await setup(t, 'free', false, stage), before = counts(h), transport = acceptedRuntime(h);
  const original = stage === 'idle' ? null : attemptRow(h);
  if (stage !== 'idle') {
    runs.requestExecutionRunPause(h.ctx, h.versionId, h.run.id, { expected_revision: runRow(h).revision });
    const paused = await inspect(h), changes = h.db.prepare('SELECT total_changes() n').get().n;
    const resumed = await entry().resumeExecutionRun(h.ctx, h.versionId, h.run.id, inputFor(paused));
    assert.equal(resumed.pause_requested, false); assert.equal(resumed.run_revision, paused.run_revision + 1);
    assert.equal(h.db.prepare('SELECT total_changes() n').get().n, changes + 1);
    assert.deepEqual(attemptRow(h), original); assert.deepEqual(counts(h), before);
    await inert(h, () => entry().resumeExecutionRun(h.ctx, h.versionId, h.run.id, inputFor(paused)), 'EXECUTION_RUN_CONFLICT');
  }
  const ready = await inspect(h);
  assert.equal(ready.amount, 0); assert.equal(ready.billing_mode, 'no_charge');
  const result = await entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, inputFor(ready), transport.runtime);
  h.attemptId = result.attempt_id;
  assert.equal(transport.posts, 1); assert.equal(attemptRow(h).reservation_id, null);
  assert.equal(h.db.prepare("SELECT count(*) n FROM async_tasks WHERE type='redraw_execution_unit'").get().n, 1);
  if (original) assert.equal(h.attemptId, original.id);
  if (stage === 'bound') assert.equal(attemptRow(h).task_id, original.task_id);
  assert.equal(counts(h).reservations, before.reservations); assert.equal(counts(h).ledger, before.ledger);
});

test('real first candidate approval preserves original replay and only a fresh confirmation advances the next unit', async t => {
  const h = await setup(t, 'paid', true, 'idle'), ready = await inspect(h), input = inputFor(ready);
  assert.equal(h.queueState.queue.units.length, 2);
  let media = await makeCandidateMedia(h), posts = 0, downloads = 0;
  const runtime = { fetchImpl: async (_url, init) => {
    posts += 1; assert.equal(init.method, 'POST'); assert.equal(h.db.inTransaction, false);
    return new Response(JSON.stringify({ id: `synthetic-advance-candidate-${posts}`, status: 'succeeded',
      content: { video_url: `https://result.synthetic.invalid/advance-${posts}.mp4` } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, download: { _dnsLookupForTest: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async (_url, init) => { downloads += 1; assert.equal(init.method, 'GET'); assert.equal(init.headers, undefined);
      return new Response(media, { status: 200, headers: { 'Content-Type': 'video/mp4' } }); } } };
  const first = await entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, input, runtime);
  h.attemptId = first.attempt_id;
  assert.equal(first.attempt_status, 'waiting_review'); assert.equal(posts, 1); assert.equal(downloads, 1);
  const candidate = await reviews.getExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.expected(0).unit_id);
  assert.equal(candidate.review_policy.human_required, true);
  await reviews.reviewExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.expected(0).unit_id, {
    expected_revision: candidate.run_revision, expected_candidate_hash: candidate.candidate_hash, decision: 'approved',
    checks: Object.fromEntries(candidate.required_checks.map(key => [key, { basis: 'human_watch_listen', result: 'passed' }])),
  });
  assert.equal(attemptRow(h).status, 'approved');
  const before = h.db.serialize(), changes = h.db.prepare('SELECT total_changes() n').get().n;
  const replay = await entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, input, runtime);
  assert.equal(replay.attempt_id, first.attempt_id); assert.equal(replay.attempt_status, 'approved'); assert.equal(replay.changed, false);
  assert.deepEqual(h.db.serialize(), before); assert.equal(h.db.prepare('SELECT total_changes() n').get().n, changes);
  assert.equal(posts, 1); assert.equal(downloads, 1); assert.equal(counts(h).attempts, 1);
  const next = await inspect(h); assert.equal(next.phase, 'idle'); assert.equal(next.unit_id, h.expected(1).unit_id);
  h.pack = compileUnitProductionPack({ owner: { tenantId: h.ctx.tenantId, userId: h.ctx.userId, workId: 1, versionId: h.versionId },
    expected: h.expected(1), queueState: h.queueState, blueprint: h.blueprint, localization: h.localization });
  assert.equal(h.pack.timeline.generated_duration_ms, 7000);
  const mediaRoot = fs.mkdtempSync(path.join(h.root, 'second-advance-media-'));
  media = await makeCandidateMedia({ ...h, root: mediaRoot });
  const second = await entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, inputFor(next), runtime);
  assert.notEqual(second.attempt_id, first.attempt_id); assert.equal(second.attempt_status, 'waiting_review');
  assert.equal(posts, 2); assert.equal(downloads, 2); assert.equal(counts(h).attempts, 2); assert.equal(counts(h).reservations, 2);
});

test('an explicit second-unit provider failure stops the run and never submits another unit', async t => {
  const h = await setup(t, 'paid', false, 'idle', { assemblyCase: true, audioMode: 'not_required',
    assemblyParentRanges: [[0, 4000], [4000, 8000], [8000, 12000]], assemblyDurations: [5] });
  assert.equal(h.queueState.queue.units.length, 3);
  let media = await makeCandidateMedia(h), posts = 0, downloads = 0;
  const runtime = { fetchImpl: async (_url, init) => {
    posts += 1; assert.equal(init.method, 'POST'); assert.equal(h.db.inTransaction, false);
    return new Response(JSON.stringify(posts === 1
      ? { id: 'synthetic-first-candidate', status: 'succeeded',
        content: { video_url: 'https://result.synthetic.invalid/first.mp4' } }
      : { id: 'synthetic-second-failure', status: 'failed', error: { message: 'synthetic explicit failure' } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, download: { _dnsLookupForTest: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async (_url, init) => { downloads += 1; assert.equal(init.method, 'GET');
      return new Response(media, { status: 200, headers: { 'Content-Type': 'video/mp4' } }); } } };

  const firstReady = await inspect(h);
  const first = await entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, inputFor(firstReady), runtime);
  h.attemptId = first.attempt_id;
  assert.equal(first.attempt_status, 'waiting_review');
  const candidate = await reviews.getExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.expected(0).unit_id);
  await reviews.reviewExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.expected(0).unit_id, {
    expected_revision: candidate.run_revision, expected_candidate_hash: candidate.candidate_hash, decision: 'approved',
    checks: Object.fromEntries(candidate.required_checks.map(key => [key, { basis: 'human_watch_listen', result: 'passed' }])),
  });

  const secondMaterials = await inspectPreparedUnitReferenceMaterials(h.ctx, h.expected(1));
  assert.equal(secondMaterials.status, 'needs_preparation');
  await prepareUnitReferenceMaterials(h.ctx, { ...h.expected(1), expected_materials_hash: secondMaterials.materials_hash });
  const secondReady = await inspect(h);
  assert.equal(secondReady.status, 'ready', JSON.stringify(secondReady));
  h.pack = compileUnitProductionPack({ owner: { tenantId: h.ctx.tenantId, userId: h.ctx.userId, workId: 1, versionId: h.versionId },
    expected: h.expected(1), queueState: h.queueState, blueprint: h.blueprint, localization: h.localization });
  const second = await entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, inputFor(secondReady), runtime);
  h.attemptId = second.attempt_id;
  assert.equal(second.attempt_status, 'failed');
  assert.equal(runRow(h).status, 'failed');
  assert.equal(posts, 2); assert.equal(downloads, 1);
  assert.equal(counts(h).attempts, 2); assert.equal(counts(h).reservations, 2);
  assert.equal(h.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id=?')
    .get(attemptRow(h).reservation_id).status, 'refunded');
  const thirdUnitId = h.expected(2).unit_id;
  assert.equal(h.db.prepare(`SELECT COUNT(*) n FROM redraw_execution_unit_attempts a
    JOIN redraw_execution_queue_units q ON q.id=a.queue_unit_id WHERE q.unit_id=?`).get(thirdUnitId).n, 0);

  const before = h.db.serialize(), changes = h.db.prepare('SELECT total_changes() n').get().n;
  const replay = await entry().advanceExecutionRun(h.ctx, h.versionId, h.run.id, inputFor(secondReady), runtime);
  assert.equal(replay.changed, false); assert.equal(replay.attempt_id, second.attempt_id);
  assert.equal(posts, 2); assert.equal(downloads, 1);
  assert.equal(counts(h).attempts, 2); assert.equal(counts(h).tasks, 2); assert.equal(counts(h).reservations, 2);
  assert.deepEqual(h.db.serialize(), before);
  assert.equal(h.db.prepare('SELECT total_changes() n').get().n, changes);
});

for (const failure of ['attempt_write', 'all_receipt_writes', 'unreadable_after_fallback']) {
  test(`advance preserves the only safe known-ID receipt after ${failure} without another database read or POST`, async t => {
    const h = await setup(t), input = inputFor(await inspect(h)); let posts = 0, refuseReads = false, deniedReads = 0;
    h.db.exec(`CREATE TRIGGER fail_advance_attempt_receipt BEFORE UPDATE OF provider_task_id ON redraw_execution_unit_attempts
      WHEN NEW.provider_task_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic observation failure'); END;`);
    if (failure === 'all_receipt_writes') h.db.exec(`CREATE TRIGGER fail_advance_task_receipt BEFORE UPDATE OF result ON async_tasks
      WHEN NEW.result IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic fallback failure'); END;`);
    const db = failure !== 'unreadable_after_fallback' ? h.db : new Proxy(h.db, { get(target, key) {
      if (key === 'prepare') return sql => {
        if (refuseReads) { deniedReads += 1; throw Object.assign(new Error('synthetic database unreadable'), { code: 'SQLITE_IOERR' }); }
        if (sql.startsWith('UPDATE async_tasks SET result=')) {
          refuseReads = true;
          throw Object.assign(new Error('synthetic last fallback write failed'), { code: 'SQLITE_IOERR' });
        }
        return target.prepare(sql);
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const result = await entry().advanceExecutionRun({ ...h.ctx, db }, h.versionId, h.run.id, input, { fetchImpl: async (_url, init) => {
      posts += 1; assert.equal(init.method, 'POST'); assert.equal(h.db.inTransaction, false);
      return new Response(JSON.stringify({ id: 'only-safe-advance-id', status: 'running' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    } });
    assert.equal(result.receipt_persisted, false);
    assert.equal(result.fallback_receipt_persisted, failure === 'attempt_write');
    assert.equal(result.provider_task_id, 'only-safe-advance-id');
    assert.equal(result.recovery_receipt.provider_task_id, 'only-safe-advance-id');
    assert.equal(result.recovery_receipt.request_hash, attemptRow(h).request_hash);
    assert.equal(result.attempt_status, 'needs_attention'); assert.equal(result.changed, true);
    assert.equal(posts, 1); assert.equal(deniedReads, 0); safe(result);
    assert.equal(attemptRow(h).provider_task_id, null); assert.equal(attemptRow(h).status, 'submitting');
    assert.equal(h.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id=?').get(attemptRow(h).reservation_id).status, 'held');
    const task = h.db.prepare('SELECT provider_task_id,result FROM async_tasks WHERE id=?').get(attemptRow(h).task_id);
    assert.equal(task.provider_task_id, failure === 'attempt_write' ? 'only-safe-advance-id' : null);
    if (failure === 'unreadable_after_fallback') assert.equal(refuseReads, true);
  });
}
