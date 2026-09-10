'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runs = require('../src/services/redrawExecutionRunService');
const tenantService = require('../src/services/tenantService');
const { fixture, snapshot, unchanged, assertSafe, parameters } = require('./helpers/redrawExecutionRunHttpFixture');

test('local HTTP guard resolves only its literal loopback without external DNS', async () => {
  const dns = require('node:dns');
  const original = {
    lookup: dns.lookup,
    resolve4: dns.resolve4,
    promiseLookup: dns.promises.lookup,
  };
  const assertLoopback = (hostname) => {
    if (hostname !== '127.0.0.1') throw new Error('FORBIDS_DNS');
  };
  dns.lookup = function guardedLookup(hostname, ...args) {
    assertLoopback(hostname);
    return original.lookup.call(this, hostname, ...args);
  };
  dns.resolve4 = function guardedResolve4(hostname, ...args) {
    assertLoopback(hostname);
    return original.resolve4.call(this, hostname, ...args);
  };
  dns.promises.lookup = async function guardedPromiseLookup(hostname, ...args) {
    assertLoopback(hostname);
    return original.promiseLookup.call(this, hostname, ...args);
  };
  try {
    assert.deepEqual(await dns.promises.lookup('127.0.0.1', { all: true }), [{ address: '127.0.0.1', family: 4 }]);
    assert.throws(() => dns.lookup('example.com', () => {}), /FORBIDS_DNS/);
    assert.throws(() => dns.resolve4('example.com', () => {}), /FORBIDS_DNS/);
    await assert.rejects(dns.promises.lookup('example.com'), /FORBIDS_DNS/);
  } finally {
    dns.lookup = original.lookup;
    dns.resolve4 = original.resolve4;
    dns.promises.lookup = original.promiseLookup;
  }
});

test('real registered actor creates its queued execution run through authenticated HTTP', async t => {
  const h = await fixture(t);
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_execution_runs').get().n, 0);
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_execution_unit_attempts').get().n, 0);
  const res = await h.request('/execution-runs', { method: 'POST', body: h.createInput });
  assert.equal(res.status, 200, 'owned queued fixture needs the real HTTP create route');
  const { data } = await res.json();
  assertSafe(data);
  assert.equal(data.version_id, h.versionId);
  assert.equal(data.status, 'ready');
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_execution_runs').get().n, 1);
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_execution_unit_attempts').get().n, 0);
  assert.deepEqual(h.calls, { submits: 0, queries: 0, downloads: 0, other: 0 });
});

test('real JWT GET discovers its existing run without run ID or any database writes', async t => {
  const h = await fixture(t);
  const run = runs.createExecutionRun(h.ctx, h.versionId, h.createInput);
  const before = snapshot(h);
  const res = await h.request('/execution-runs');
  assert.equal(res.status, 200, 'refresh requires an authenticated read-only run discovery route');
  const { data } = await res.json();
  assertSafe(data);
  assert.equal(data.version_id, h.versionId);
  assert.equal(data.current_run_id, run.id);
  assert.deepEqual(data.runs.map(value => value.id), [run.id]);
  unchanged(h, before);
});

test('run discovery rejects a newly registered actor without initializing its personal tenant', async t => {
  const h = await fixture(t);
  const actor = h.registerActor(false);
  assert.equal(h.db.prepare('SELECT id FROM tenants WHERE id=?').get(actor.tenantId), undefined);
  const before = snapshot(h);
  const res = await h.request('/execution-runs', { headers: {
    Authorization: `Bearer ${actor.token}`, 'X-Tenant-Id': actor.tenantId,
  } });
  assert.equal(res.status, 404);
  assert.equal(h.db.prepare('SELECT id FROM tenants WHERE id=?').get(actor.tenantId), undefined,
    'read-only GET must precede tenant initialization middleware');
  unchanged(h, before);
});

const runPath = h => `/execution-runs/${h.run.id}`;
const actionInput = ready => ({ expected_revision: ready.run_revision, expected_plan_hash: ready.plan_hash,
  expected_quote_hash: ready.quote_hash, expected_confirmation_hash: ready.confirmation_hash, output_parameters: parameters });
async function dataFor(res) {
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true); assertSafe(body.data);
  return body.data;
}

test('authenticated HTTP reads run and readiness without writes or transport', async t => {
  const h = await fixture(t, { stage: 'idle' });
  const before = snapshot(h);
  const run = await dataFor(await h.request(runPath(h)));
  assert.equal(run.id, h.run.id);
  const ready = await dataFor(await h.request(`${runPath(h)}/readiness?resolution=480p&aspect_ratio=16%3A9`));
  assert.equal(ready.status, 'ready'); assert.equal(ready.action, 'advance');
  assert.match(ready.confirmation_hash, /^[a-f0-9]{64}$/);
  unchanged(h, before);
});

test('authenticated HTTP pause persists without creating an attempt or submitting', async t => {
  const h = await fixture(t, { stage: 'idle' });
  const paused = await dataFor(await h.request(`${runPath(h)}/pause`, { method: 'POST', body: { expected_revision: h.run.revision } }));
  assert.equal(paused.pause_requested, true); assert.equal(paused.status, 'paused');
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_execution_unit_attempts').get().n, 0);
  assert.deepEqual(h.calls, { submits: 0, queries: 0, downloads: 0, other: 0 });
});

test('authenticated HTTP resumes only the paused run using its current confirmation', async t => {
  const h = await fixture(t, { stage: 'idle' });
  runs.requestExecutionRunPause(h.ctx, h.versionId, h.run.id, { expected_revision: h.run.revision });
  const ready = await runs.inspectExecutionRunAdvanceReadiness(h.ctx, h.versionId, h.run.id, { output_parameters: parameters });
  assert.equal(ready.action, 'resume');
  const resumed = await dataFor(await h.request(`${runPath(h)}/resume`, { method: 'POST', body: actionInput(ready) }));
  assert.equal(resumed.changed, true); assert.equal(resumed.pause_requested, false);
  const before = snapshot(h);
  assert.equal((await h.request(`${runPath(h)}/resume`, { method: 'POST', body: actionInput(ready) })).status, 409);
  unchanged(h, before);
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_execution_unit_attempts').get().n, 0);
});

test('HTTP advance uses the real claim binding and marker once, replay never creates a second attempt', async t => {
  const h = await fixture(t, { stage: 'idle' });
  const ready = await runs.inspectExecutionRunAdvanceReadiness(h.ctx, h.versionId, h.run.id, { output_parameters: parameters });
  const input = actionInput(ready);
  const submitted = await dataFor(await h.request(`${runPath(h)}/advance`, { method: 'POST', body: input }));
  assert.equal(submitted.provider_task_id, 'synthetic-run-http-provider-task');
  assert.equal(h.calls.submits, 1);
  const attempt = h.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=?').get(submitted.attempt_id);
  assert.ok(attempt.submit_started_at && attempt.request_hash && attempt.task_id && attempt.reservation_id);
  const before = snapshot(h);
  const replay = await dataFor(await h.request(`${runPath(h)}/advance`, { method: 'POST', body: input }));
  assert.equal(replay.attempt_id, attempt.id); assert.equal(replay.changed, false);
  unchanged(h, before);
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_execution_unit_attempts').get().n, 1);
});

test('explicit HTTP recovery queries the known provider ID once and exposes the actual candidate', async t => {
  const h = await fixture(t, { stage: 'bound' });
  const submitted = await runs.dispatchClaimedExecutionUnitTask(h.ctx, h.versionId, h.run.id, h.input, h.runtime);
  assert.equal(submitted.provider_task_id, 'synthetic-run-http-provider-task');
  await h.prepareResult();
  const candidate = await dataFor(await h.request(`${runPath(h)}/recover`, { method: 'POST', body: { attempt_id: h.attemptId } }));
  assert.equal(candidate.status, 'waiting_review');
  assert.deepEqual(h.calls, { submits: 1, queries: 1, downloads: 1, other: 0 });
  const readBefore = snapshot(h);
  const details = await dataFor(await h.request(`${runPath(h)}/units/${h.unitId}/candidate`));
  assert.equal(details.candidate_hash, h.db.prepare('SELECT candidate_hash FROM redraw_execution_unit_attempts WHERE id=?').get(h.attemptId).candidate_hash);
  unchanged(h, readBefore);
  const bytes = await h.request(`${runPath(h)}/units/${h.unitId}/candidate/media?expected_candidate_hash=${details.candidate_hash}`);
  assert.equal(bytes.status, 200); assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), h.transport.bytes);
  unchanged(h, readBefore);
});

test('HTTP candidate review confirms only its original held credits once', async t => {
  const h = await fixture(t, { stage: 'bound' });
  const candidate = await h.makeCandidate();
  const attempt = h.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=?').get(h.attemptId);
  const checks = Object.fromEntries(candidate.required_checks.map(key => [key, { basis: 'human_watch_listen', result: 'passed' }]));
  const input = { expected_revision: h.db.prepare('SELECT revision FROM redraw_execution_runs WHERE id=?').get(h.run.id).revision,
    expected_candidate_hash: candidate.candidate_hash, decision: 'approved', checks };
  const url = `${runPath(h)}/units/${h.unitId}/review`;
  const result = await dataFor(await h.request(url, { method: 'POST', body: input }));
  assert.equal(result.review.decision, 'approved');
  assert.equal(h.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id=?').get(attempt.reservation_id).status, 'confirmed');
  const before = snapshot(h);
  await dataFor(await h.request(url, { method: 'POST', body: input }));
  unchanged(h, before);
});

test('HTTP rejection preserves the candidate and original hold and cannot advance a successor', async t => {
  const h = await fixture(t, { stage: 'bound', sequential: true });
  const candidate = await h.makeCandidate();
  const original = h.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=?').get(h.attemptId);
  const ledger = h.db.prepare('SELECT * FROM tenant_credit_ledger ORDER BY id').all();
  const input = { expected_revision: candidate.run_revision, expected_candidate_hash: candidate.candidate_hash,
    decision: 'rejected', checks: Object.fromEntries(candidate.required_checks.map(key =>
      [key, { basis: 'not_checked', result: 'not_checked' }])) };
  const url = `${runPath(h)}/units/${h.unitId}/review`;
  const rejected = await dataFor(await h.request(url, { method: 'POST', body: input }));
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.newly_reviewed, true);
  assert.equal(rejected.billing.status, 'held');
  assert.equal(rejected.content_qa.status, 'requires_human_review');
  const current = h.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=?').get(original.id);
  assert.deepEqual(JSON.parse(current.quality_json).candidate, JSON.parse(original.quality_json).candidate);
  assert.deepEqual(h.db.prepare('SELECT * FROM tenant_credit_ledger ORDER BY id').all(), ledger);
  const before = snapshot(h);
  assert.equal((await dataFor(await h.request(url, { method: 'POST', body: input }))).newly_reviewed, false);
  const ready = await dataFor(await h.request(`${runPath(h)}/readiness?resolution=480p&aspect_ratio=16%3A9`));
  assert.equal(ready.status, 'blocked'); assert.equal(Object.hasOwn(ready, 'confirmation_hash'), false);
  const media = await h.request(`${runPath(h)}/units/${h.unitId}/candidate/media?expected_candidate_hash=${candidate.candidate_hash}`);
  assert.equal(media.status, 200); assert.deepEqual(Buffer.from(await media.arrayBuffer()), h.transport.bytes);
  unchanged(h, before);
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_execution_unit_attempts').get().n, 1);
  assert.deepEqual(h.calls, { submits: 1, queries: 0, downloads: 1, other: 0 });
});

test('queued HTTP workflow survives listener and SQLite reopen, then recovers and reviews its original result', async t => {
  const h = await fixture(t);
  assert.deepEqual((await dataFor(await h.request('/execution-runs'))).runs, []);
  h.run = await dataFor(await h.request('/execution-runs', { method: 'POST', body: h.createInput }));
  const paused = await dataFor(await h.request(`${runPath(h)}/pause`, { method: 'POST', body: { expected_revision: h.run.revision } }));
  await h.reopen();
  const before = snapshot(h);
  const discovered = await dataFor(await h.request('/execution-runs'));
  assert.equal(discovered.current_run_id, h.run.id);
  assert.equal(discovered.runs[0].pause_requested, true);
  assert.equal(discovered.runs[0].revision, paused.revision);
  const readiness = `${runPath(h)}/readiness?resolution=480p&aspect_ratio=16%3A9`;
  const resumeReady = await dataFor(await h.request(readiness));
  unchanged(h, before);
  assert.equal(resumeReady.action, 'resume');
  await dataFor(await h.request(`${runPath(h)}/resume`, { method: 'POST', body: actionInput(resumeReady) }));
  const advanceReady = await dataFor(await h.request(readiness));
  assert.equal(advanceReady.action, 'advance');
  const submitted = await dataFor(await h.request(`${runPath(h)}/advance`, { method: 'POST', body: actionInput(advanceReady) }));
  const original = h.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=?').get(submitted.attempt_id);
  await h.reopen();
  assert.deepEqual(h.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=?').get(original.id), original);
  assert.equal((await dataFor(await h.request('/execution-runs'))).current_run_id, h.run.id);
  assert.deepEqual(h.calls, { submits: 1, queries: 0, downloads: 0, other: 0 });
  await h.prepareResult();
  await dataFor(await h.request(`${runPath(h)}/recover`, { method: 'POST', body: { attempt_id: original.id } }));
  const candidate = await dataFor(await h.request(`${runPath(h)}/units/${h.unitId}/candidate`));
  const media = await h.request(`${runPath(h)}/units/${h.unitId}/candidate/media?expected_candidate_hash=${candidate.candidate_hash}`);
  assert.equal(media.status, 200);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), h.transport.bytes);
  const current = await dataFor(await h.request(runPath(h)));
  await dataFor(await h.request(`${runPath(h)}/units/${h.unitId}/review`, { method: 'POST', body: {
    expected_revision: current.revision, expected_candidate_hash: candidate.candidate_hash, decision: 'approved',
    checks: Object.fromEntries(candidate.required_checks.map(key => [key, { basis: 'human_watch_listen', result: 'passed' }])),
  } }));
  assert.equal(h.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id=?').get(original.reservation_id).status, 'confirmed');
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_execution_unit_attempts').get().n, 1);
  assert.deepEqual(h.calls, { submits: 1, queries: 1, downloads: 1, other: 0 });
});

test('unknown HTTP submission stays held after reopen, reads, replay and explicit recovery without another transport', async t => {
  const h = await fixture(t, { stage: 'idle' });
  const readiness = `${runPath(h)}/readiness?resolution=480p&aspect_ratio=16%3A9`;
  const input = actionInput(await dataFor(await h.request(readiness)));
  h.transport.responseLost = true;
  const submitted = await dataFor(await h.request(`${runPath(h)}/advance`, { method: 'POST', body: input }));
  const attempt = h.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=?').get(submitted.attempt_id);
  assert.equal(attempt.status, 'needs_attention'); assert.equal(attempt.provider_task_id, null);
  assert.ok(attempt.submit_started_at && attempt.request_hash);
  await h.reopen();
  const before = snapshot(h);
  const discovered = await dataFor(await h.request('/execution-runs'));
  assert.equal(discovered.current_run_id, h.run.id);
  const ready = await dataFor(await h.request(readiness));
  assert.equal(ready.status, 'blocked'); assert.equal(Object.hasOwn(ready, 'confirmation_hash'), false);
  const replay = await dataFor(await h.request(`${runPath(h)}/advance`, { method: 'POST', body: input }));
  assert.equal(replay.changed, false); assert.equal(replay.attempt_id, attempt.id);
  await dataFor(await h.request(`${runPath(h)}/recover`, { method: 'POST', body: { attempt_id: attempt.id } }));
  unchanged(h, before);
  assert.equal(h.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id=?').get(attempt.reservation_id).status, 'held');
  assert.deepEqual(h.calls, { submits: 1, queries: 0, downloads: 0, other: 0 });
});

test('real HTTP owner and authentication boundaries reject access without changing any rows or calling transport', async t => {
  const h = await fixture(t, { stage: 'idle' });
  const outsider = h.registerActor(true);
  const endpoints = ['/execution-runs', runPath(h), `${runPath(h)}/readiness`, `${runPath(h)}/units/${h.unitId}/candidate`,
    `${runPath(h)}/units/${h.unitId}/candidate/media?expected_candidate_hash=${'a'.repeat(64)}`];
  async function denied(headers, status) {
    const before = snapshot(h);
    for (const endpoint of endpoints) {
      const response = await h.request(endpoint, { headers });
      assert.equal(response.status, status, endpoint); assertSafe(await response.json());
    }
    for (const [endpoint, body] of [['/execution-runs', h.createInput], [`${runPath(h)}/pause`, { expected_revision: h.run.revision }]]) {
      const response = await h.request(endpoint, { method: 'POST', body, headers });
      assert.equal(response.status, status, endpoint); assertSafe(await response.json());
    }
    unchanged(h, before);
  }
  await denied({ Authorization: '' }, 401);
  await denied({ Authorization: 'Bearer invalid-synthetic-token' }, 401);
  await denied({ Authorization: `Bearer ${outsider.token}`, 'X-Tenant-Id': outsider.tenantId }, 404);
  tenantService.addMemberByEmail(h.db, h.actor.tenantId, h.actor.user.id, { email: outsider.user.email, role: 'member' });
  await denied({ Authorization: `Bearer ${outsider.token}` }, 404);
  for (const [sql, args, reset, status] of [
    ['UPDATE platform_users SET status=? WHERE id=?', ['disabled', h.actor.user.id], 'active', 401],
    ['UPDATE platform_users SET token_version=? WHERE id=?', [1, h.actor.user.id], 0, 401],
    ['UPDATE tenants SET status=? WHERE id=?', ['disabled', h.actor.tenantId], 'active', 404],
    ['UPDATE tenant_members SET status=? WHERE tenant_id=? AND user_id=?', ['disabled', h.actor.tenantId, h.actor.user.id], 'active', 404],
    ['UPDATE redraw_projects SET deleted_at=? WHERE user_id=?', ['2026-09-08T00:00:00Z', h.actor.user.id], null, 404],
  ]) {
    h.db.prepare(sql).run(...args);
    await denied({}, status);
    h.db.prepare(sql).run(reset, ...args.slice(1));
  }
});

test('HTTP paths, duplicate queries and private runtime injection are rejected before submission', async t => {
  const h = await fixture(t, { stage: 'idle' });
  const before = snapshot(h);
  for (const suffix of ['/execution-runs/01', '/execution-runs/9007199254740992', '/execution-runs?runtime=evil',
    `${runPath(h)}/readiness?resolution=480p`, `${runPath(h)}/readiness?resolution=480p&resolution=480p&aspect_ratio=16:9`,
    `${runPath(h)}/readiness?resolution=480p&aspect_ratio=16:9&env=evil`]) {
    const res = await h.request(suffix); assert.equal(res.status, 400, suffix); assertSafe(await res.json());
  }
  for (const key of ['api_key', 'env', 'runtime', 'storageRoot', 'phase', 'model', 'provider_task_id']) {
    const res = await h.request(`${runPath(h)}/pause`, { method: 'POST', body: { expected_revision: h.run.revision, [key]: 'injected' } });
    assert.equal(res.status, 400, key); assertSafe(await res.json());
  }
  unchanged(h, before);
});

test('new read-only run wrapper hides tenant lookup failures instead of delegating raw database errors', async t => {
  const h = await fixture(t, { stage: 'idle' });
  const prepare = h.db.prepare.bind(h.db);
  t.mock.method(h.db, 'prepare', sql => {
    if (sql.includes('SELECT t.id, t.name, t.slug, m.role')) throw new Error('synthetic-private-db-path-and-secret');
    return prepare(sql);
  });
  const before = snapshot(h), res = await h.request('/execution-runs');
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json(); assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(body), /synthetic-private|SELECT|Error:|\.js:/); assertSafe(body);
  unchanged(h, before);
});

test('HTTP readiness classifies a real stale parent material as conflict without writes or transport', async t => {
  const h = await fixture(t, { stage: 'idle' });
  h.db.prepare('UPDATE redraw_shots SET duration_ms=duration_ms+1 WHERE id=?').run(h.shotId);
  const before = snapshot(h);
  const res = await h.request(`${runPath(h)}/readiness?resolution=480p&aspect_ratio=16%3A9`);
  assert.equal(res.status, 409);
  const body = await res.json(); assertSafe(body);
  assert.equal(body.error.code, 'REDRAW_UNIT_REFERENCE_MATERIALS_STALE');
  unchanged(h, before);
});

test('HTTP readiness reports source binding drift during the real snapshot as conflict, not internal failure', async t => {
  const h = await fixture(t, { stage: 'idle' });
  const source = path.join(h.root, 'source/source.mp4'), open = fs.promises.open;
  let changed = false, expected;
  t.mock.method(fs.promises, 'open', async function(file, ...args) {
    const handle = await open.call(this, file, ...args);
    if (file === source && !changed) {
      changed = true;
      h.db.prepare("UPDATE assets SET metadata=json_set(metadata, '$.synthetic_binding_revision', 1) WHERE id=101").run();
      expected = snapshot(h);
    }
    return handle;
  });
  const res = await h.request(`${runPath(h)}/readiness?resolution=480p&aspect_ratio=16%3A9`);
  assert.equal(changed, true); assert.equal(res.status, 409);
  const body = await res.json(); assertSafe(body);
  assert.equal(body.error.code, 'REDRAW_SOURCE_VIDEO_CONFLICT');
  unchanged(h, expected);
});

test('HTTP readiness keeps operational source I/O failures as sanitized internal errors with no writes', async t => {
  const h = await fixture(t, { stage: 'idle' });
  const source = path.join(h.root, 'source/source.mp4'), open = fs.promises.open;
  let injected = 0;
  t.mock.method(fs.promises, 'open', async function(file, ...args) {
    if (file === source) {
      injected += 1;
      throw Object.assign(new Error('synthetic private source I/O path'), { code: 'EIO' });
    }
    return open.call(this, file, ...args);
  });
  const before = snapshot(h);
  const res = await h.request(`${runPath(h)}/readiness?resolution=480p&aspect_ratio=16%3A9`);
  assert.equal(injected, 1); assert.equal(res.status, 500);
  const body = await res.json(); assertSafe(body);
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(body), /synthetic private|EIO|\.mp4/);
  unchanged(h, before);
});

for (const kind of ['motion_record', 'localization', 'blueprint']) test(`HTTP readiness rejects ${kind} drift after a real file open with an explicit conflict`, async t => {
  const h = await fixture(t, { stage: 'idle' });
  const motion = h.db.prepare(`SELECT a.id, a.local_path FROM redraw_reference_artifact_imports i
    JOIN assets a ON a.id=i.stored_asset_id WHERE i.tenant_id=? AND i.user_id=? AND i.version_id=?
    AND i.scope_type='shot' AND i.scope_id=? AND i.purpose='motion' AND i.status='completed'
    ORDER BY i.id DESC LIMIT 1`).get(h.ctx.tenantId, h.ctx.userId, h.versionId, h.shotId);
  assert.ok(motion);
  const target = path.join(h.root, kind === 'motion_record' ? motion.local_path : 'source/source.mp4');
  const open = fs.promises.open; let changed = false, expected, sourceOpened = false, injectionError;
  if (kind === 'blueprint') {
    const prepare = h.db.prepare.bind(h.db);
    t.mock.method(h.db, 'prepare', (sql, ...args) => {
      const statement = prepare(sql, ...args);
      if (sql.startsWith('SELECT v.* FROM redraw_versions v JOIN redraw_works')) {
        const get = statement.get.bind(statement);
        t.mock.method(statement, 'get', (...params) => {
          const row = get(...params);
          if (sourceOpened && !changed) {
            try {
              // Interleave a real mutable version update between the two actual SELECTs.
              // Locked blueprint rows and their immutable trigger remain untouched.
              const result = prepare('UPDATE redraw_versions SET blueprint_hash=? WHERE id=?')
                .run('f'.repeat(64), h.versionId);
              assert.equal(result.changes, 1); changed = true; expected = snapshot(h);
            } catch (error) { injectionError = error; throw error; }
          }
          return row;
        });
      }
      return statement;
    });
  }
  const opened = [];
  t.mock.method(fs.promises, 'open', async function(file, ...args) {
    const handle = await open.call(this, file, ...args);
    const item = { handle, closed: 0 }, close = handle.close;
    opened.push(item);
    t.mock.method(handle, 'close', async function(...closeArgs) {
      const result = await close.apply(this, closeArgs); item.closed += 1; return result;
    });
    try {
      if (file === target && !changed) {
        if (kind === 'motion_record') {
          assert.equal(h.db.prepare("UPDATE assets SET metadata=json_set(metadata, '$.synthetic_binding_revision', 1) WHERE id=?").run(motion.id).changes, 1);
          changed = true; expected = snapshot(h);
        } else if (kind === 'localization') {
          assert.equal(h.db.prepare("UPDATE redraw_versions SET localization_review_json='{}' WHERE id=?").run(h.versionId).changes, 1);
          changed = true; expected = snapshot(h);
        } else {
          sourceOpened = true;
        }
      }
      return handle;
    } catch (error) {
      injectionError = error;
      await handle.close(); throw error;
    }
  });
  t.after(async () => { for (const item of opened) if (!item.closed) await item.handle.close(); });
  const res = await h.request(`${runPath(h)}/readiness?resolution=480p&aspect_ratio=16%3A9`);
  assert.ifError(injectionError);
  assert.equal(changed, true); assert.equal(res.status, 409);
  const body = await res.json(); assertSafe(body);
  assert.equal(body.error.code, { motion_record: 'REDRAW_MOTION_CANDIDATE_CONFLICT',
    localization: 'LOCALIZATION_NOT_FOUND', blueprint: 'BLUEPRINT_HASH_MISMATCH' }[kind]);
  unchanged(h, expected);
  assert.ok(opened.length > 0);
  for (const item of opened) assert.equal(item.closed, 1, 'each real file handle closed exactly once before the HTTP response');
});

test('HTTP advance preserves its only known provider receipt when both persistence paths fail and subsequent DB reads are impossible', async t => {
  const h = await fixture(t, { stage: 'idle' });
  const input = actionInput(await dataFor(await h.request(`${runPath(h)}/readiness?resolution=480p&aspect_ratio=16%3A9`)));
  h.db.exec(`CREATE TRIGGER fail_http_attempt_receipt BEFORE UPDATE OF provider_task_id ON redraw_execution_unit_attempts
    WHEN NEW.provider_task_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic observation failure'); END;`);
  const prepare = h.db.prepare.bind(h.db); let unavailable = false, forbiddenReads = 0;
  const fault = t.mock.method(h.db, 'prepare', sql => {
    if (unavailable) { forbiddenReads += 1; throw Object.assign(new Error('synthetic private unreadable DB'), { code: 'SQLITE_IOERR' }); }
    if (sql.startsWith('UPDATE async_tasks SET result=')) {
      unavailable = true; throw Object.assign(new Error('synthetic private fallback failure'), { code: 'SQLITE_IOERR' });
    }
    return prepare(sql);
  });
  let result;
  try {
    result = await dataFor(await h.request(`${runPath(h)}/advance`, { method: 'POST', body: input }));
    assert.equal(unavailable, true); assert.equal(forbiddenReads, 0);
  } finally { fault.mock.restore(); }
  assert.equal(result.receipt_persisted, false); assert.equal(result.fallback_receipt_persisted, false);
  assert.equal(result.provider_task_id, 'synthetic-run-http-provider-task');
  assert.equal(result.recovery_receipt.provider_task_id, result.provider_task_id);
  const attempt = h.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=?').get(result.attempt_id);
  assert.equal(result.recovery_receipt.request_hash, attempt.request_hash);
  assert.equal(attempt.status, 'submitting'); assert.equal(attempt.provider_task_id, null);
  assert.equal(h.db.prepare('SELECT status FROM tenant_usage_reservations WHERE id=?').get(attempt.reservation_id).status, 'held');
  assert.deepEqual(h.calls, { submits: 1, queries: 0, downloads: 0, other: 0 });
});
