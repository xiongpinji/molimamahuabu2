'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');
// This module also registers its existing preview/blueprint tests; report them in native totals.
const { fixture: previewFixture } = require('./redrawExecutionPlanPreview.test');
const { previewVersionExecutionPlan } = require('../src/services/redrawExecutionPlanPreviewService');
const { saveExecutionPlanReview } = require('../src/services/redrawExecutionPlanReviewService');
const { prepareExecutionQueue } = require('../src/services/redrawExecutionQueueService');
const { hashPlanValue } = require('../src/services/redrawExecutionPlanService');
const service = require('../src/services/redrawExecutionRunService');

const runTable = 'redraw_execution_runs';
const attemptTable = 'redraw_execution_unit_attempts';
const stamp = '2026-09-07T00:00:00.000Z';
const runStates = ['ready', 'running', 'waiting_review', 'paused', 'failed', 'needs_attention', 'stale', 'completed'];
const attemptStates = ['claimed', 'submitting', 'running', 'waiting_review', 'approved', 'rejected', 'failed', 'needs_attention'];
const activeStates = ['claimed', 'submitting', 'running'];
const outputParameters = { resolution: '480p', aspect_ratio: '9:16' };
const migrationFile = path.join(__dirname, '../migrations/77_redraw_execution_runs.sql');
const preloadFile = path.join(__dirname, 'helpers/redrawExecutionChildPreload.cjs');
const preloadSha = createHash('sha256').update(fs.readFileSync(preloadFile)).digest('hex');

function fixture(t, { multi = false } = {}) {
  const h = previewFixture(t);
  if (multi) {
    h.capabilities['fumin-seedance-2.0-mini'].durations = [5, 6];
    h.db.prepare('UPDATE ai_service_configs SET verified_capabilities = ? WHERE id = 41').run(JSON.stringify(h.capabilities));
  }
  h.plan = previewVersionExecutionPlan(h.ctx, 10);
  h.review = saveExecutionPlanReview(h.ctx, 10, { expected_plan_hash: h.plan.plan_hash }).saved_review;
  h.queue = prepareExecutionQueue(h.ctx, 10, { expected_plan_hash: h.plan.plan_hash }).queue;
  if (multi) assert.ok(h.queue.units.length > 1);
  h.input = { expected_plan_hash: h.plan.plan_hash, expected_queue_id: h.queue.id };
  return h;
}

const create = (h, input = h.input, ctx = h.ctx, version = 10) => service.createExecutionRun(ctx, version, input);
const get = (h, id, ctx = h.ctx, version = 10) => service.getExecutionRun(ctx, version, id);
const pause = (h, run, revision = run.revision) => service.requestExecutionRunPause(h.ctx, 10, run.id, { expected_revision: revision });
const count = (h, table) => h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const noDml = (queries) => assert.ok(!queries.some((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(sql)), queries.join('\n'));
const expectCode = (fn, code) => assert.throws(fn, { code });

function assertNoKeys(queries) {
  const configQueries = queries.filter((sql) => /FROM ai_service_configs/i.test(sql));
  assert.ok(configQueries.every((sql) => !/SELECT\s+\*|api_key|base_url|endpoint|(?:SELECT|,)\s*settings\s*(?:,|FROM)/i.test(sql)));
}

function businessSnapshot(h) {
  return h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().filter(({ name }) => ![runTable, attemptTable].includes(name))
    .map(({ name }) => [name, h.db.prepare(`SELECT * FROM "${name}"`).all()]);
}

function drift(h, value = '2026-09-07T01:00:00.000Z') {
  h.localization.review.updated_at = value;
  h.db.prepare('UPDATE redraw_versions SET localization_review_json = ? WHERE id = 10').run(JSON.stringify(h.localization));
}

function seedRun(h, overrides = {}) {
  const row = { tenant_id: h.ctx.tenantId, user_id: h.ctx.userId, work_id: 1, version_id: 10,
    queue_id: h.queue.id, review_id: h.review.id, plan_hash: h.plan.plan_hash, status: 'ready', pause_requested: 0,
    revision: 0, output_parameters_json: null, output_parameters_hash: null, created_at: stamp, updated_at: stamp, ...overrides };
  const columns = Object.keys(row);
  return Number(h.db.prepare(`INSERT INTO ${runTable} (${columns.join(',')}) VALUES (${columns.map((c) => '@' + c).join(',')})`).run(row).lastInsertRowid);
}

// Seed only synthetic persisted states for storage constraints and pause/read recovery, never claim success.
function seedAttempt(h, runId, overrides = {}) {
  h.db.prepare(`UPDATE ${runTable} SET output_parameters_json=?, output_parameters_hash=? WHERE id=?`)
    .run(JSON.stringify(outputParameters), hashPlanValue(outputParameters), runId);
  const unit = h.db.prepare('SELECT id, unit_hash FROM redraw_execution_queue_units WHERE queue_id=? ORDER BY ordinal LIMIT 1').get(h.queue.id);
  const row = { run_id: runId, queue_unit_id: unit.id, attempt_no: 1, unit_hash: unit.unit_hash, status: 'claimed',
    claim_token: 'synthetic-private-claim', readiness_hash: '1'.repeat(64), quote_hash: '2'.repeat(64),
    quoted_amount: 0, billing_mode: 'no_charge', request_hash: null, task_id: null, reservation_id: null,
    provider_task_id: null, output_asset_id: null, output_sha256: null, candidate_hash: null, quality_json: null,
    approved_by: null, approved_at: null, submit_started_at: null, created_at: stamp, updated_at: stamp, ...overrides };
  const columns = Object.keys(row);
  return Number(h.db.prepare(`INSERT INTO ${attemptTable} (${columns.join(',')}) VALUES (${columns.map((c) => '@' + c).join(',')})`).run(row).lastInsertRowid);
}

test('run migration is repeatable and creates both storage tables without changing immutable queue triggers', (t) => {
  const h = fixture(t);
  const triggers = h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'redraw_execution_queue%' ORDER BY name").all();
  assert.ok(h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(runTable), 'run table must exist');
  assert.ok(h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(attemptTable), 'attempt table must exist');
  h.db.exec(fs.readFileSync(migrationFile, 'utf8')); h.db.exec(fs.readFileSync(migrationFile, 'utf8'));
  assert.deepEqual(h.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'redraw_execution_queue%' ORDER BY name").all(), triggers);
  for (const table of ['redraw_execution_queues', 'redraw_execution_queue_units']) {
    assert.throws(() => h.db.prepare(`UPDATE ${table} SET status=status`).run(), /immutable/);
    assert.throws(() => h.db.prepare(`DELETE FROM ${table}`).run(), /immutable/);
  }
});

test('run SQL rejects duplicate owner/queue, invalid FK, hashes, flags, revisions and parameter pairs', (t) => {
  const h = fixture(t); h.db.pragma('foreign_keys = ON');
  const id = seedRun(h);
  assert.throws(() => seedRun(h), /UNIQUE/);
  for (const [field, value] of [['work_id', 999], ['version_id', 999], ['queue_id', 999], ['review_id', 999]]) {
    assert.throws(() => h.db.prepare(`UPDATE ${runTable} SET ${field}=? WHERE id=?`).run(value, id), /FOREIGN KEY/);
  }
  for (const [field, value] of [['status', 'unknown'], ['plan_hash', 'z'.repeat(64)], ['pause_requested', 2],
    ['revision', -1], ['revision', 1.5], ['revision', Number.MAX_SAFE_INTEGER + 1],
    ['output_parameters_json', '{}'], ['output_parameters_hash', '3'.repeat(64)]]) {
    assert.throws(() => h.db.prepare(`UPDATE ${runTable} SET ${field}=? WHERE id=?`).run(value, id), /CHECK/);
  }
  for (const status of runStates) h.db.prepare(`UPDATE ${runTable} SET status=? WHERE id=?`).run(status, id);
});

test('attempt SQL enforces first-attempt-only, status, hashes, foreign keys and no-charge/paid facts', (t) => {
  const h = fixture(t); h.db.pragma('foreign_keys = ON'); const runId = seedRun(h); const id = seedAttempt(h, runId);
  for (const status of attemptStates) h.db.prepare(`UPDATE ${attemptTable} SET status=? WHERE id=?`).run(status, id);
  for (const [field, value, pattern] of [['run_id', 999, /FOREIGN KEY/], ['queue_unit_id', 999, /FOREIGN KEY/],
    ['attempt_no', 2, /CHECK/], ['attempt_no', 0, /CHECK/], ['status', 'pending', /CHECK/], ['claim_token', '', /CHECK/],
    ['unit_hash', 'z'.repeat(64), /CHECK/], ['readiness_hash', '', /CHECK/], ['quote_hash', 'z'.repeat(64), /CHECK/],
    ['quoted_amount', 1, /CHECK/], ['quoted_amount', null, /NOT NULL/], ['quoted_amount', -1, /CHECK/], ['quoted_amount', 0.5, /CHECK/],
    ['quoted_amount', Number.MAX_SAFE_INTEGER + 1, /CHECK/], ['reservation_id', 'synthetic-held', /CHECK/],
    ['billing_mode', 'paid', /CHECK/], ['quality_json', '{', /CHECK/], ['request_hash', 'bad', /CHECK/]]) {
    assert.throws(() => h.db.prepare(`UPDATE ${attemptTable} SET ${field}=? WHERE id=?`).run(value, id), pattern, field);
  }
  h.db.prepare(`UPDATE ${attemptTable} SET billing_mode='paid', quoted_amount=7 WHERE id=?`).run(id);
  h.db.prepare(`UPDATE ${attemptTable} SET reservation_id='synthetic-held' WHERE id=?`).run(id);
  assert.equal(h.db.prepare(`SELECT quoted_amount FROM ${attemptTable} WHERE id=?`).get(id).quoted_amount, 7);
});

test('run SQL requires exactly two concrete parameter strings when a parameter pair is present', (t) => {
  const h = fixture(t); const id = seedRun(h);
  for (const params of [null, [], '480p', {}, { resolution: '480p' }, { ...outputParameters, extra: true },
    { resolution: 480, aspect_ratio: '9:16' }, { resolution: '480p', aspect_ratio: null }]) {
    assert.throws(() => h.db.prepare(`UPDATE ${runTable} SET output_parameters_json=?,output_parameters_hash=? WHERE id=?`)
      .run(JSON.stringify(params), hashPlanValue(params), id), /CHECK/, JSON.stringify(params));
  }
  h.db.prepare(`UPDATE ${runTable} SET output_parameters_json=?,output_parameters_hash=? WHERE id=?`)
    .run(JSON.stringify(outputParameters), hashPlanValue(outputParameters), id);
  assert.deepEqual(JSON.parse(h.db.prepare(`SELECT output_parameters_json FROM ${runTable} WHERE id=?`).get(id).output_parameters_json), outputParameters);
});

test('attempt uniqueness protects active run and non-null task/reservation while allowing historical nonactive units', (t) => {
  const h = fixture(t, { multi: true }); const runId = seedRun(h); const a = seedAttempt(h, runId);
  const next = h.db.prepare('SELECT id,unit_hash FROM redraw_execution_queue_units WHERE queue_id=? AND ordinal=1').get(h.queue.id);
  assert.throws(() => seedAttempt(h, runId), /UNIQUE/);
  assert.throws(() => seedAttempt(h, runId, { queue_unit_id: next.id, unit_hash: next.unit_hash }), /UNIQUE/);
  h.db.prepare(`UPDATE ${attemptTable} SET status='approved', task_id='synthetic-task', billing_mode='paid', quoted_amount=7, reservation_id='synthetic-reservation' WHERE id=?`).run(a);
  assert.throws(() => seedAttempt(h, runId, { queue_unit_id: next.id, unit_hash: next.unit_hash, task_id: 'synthetic-task' }), /UNIQUE/);
  assert.throws(() => seedAttempt(h, runId, { queue_unit_id: next.id, unit_hash: next.unit_hash, billing_mode: 'paid', quoted_amount: 7, reservation_id: 'synthetic-reservation' }), /UNIQUE/);
  seedAttempt(h, runId, { queue_unit_id: next.id, unit_hash: next.unit_hash });
  assert.equal(count(h, attemptTable), 2);
  assert.throws(() => h.db.prepare(`UPDATE ${attemptTable} SET status='running' WHERE id=?`).run(a), /UNIQUE/);
});

test('create stores one non-executable run from real current review/queue, no attempt, task, reservation or parent writes', (t) => {
  const h = fixture(t, { multi: true }); const before = businessSnapshot(h); h.queries.length = 0;
  let run;
  assert.doesNotThrow(() => { run = create(h); }, 'valid current queue registration must succeed');
  const queries = h.queries.slice();
  assert.equal(run.status, 'ready'); assert.equal(run.binding_status, 'current'); assert.equal(run.executable, false);
  assert.equal(run.pause_requested, false); assert.equal(run.revision, 0); assert.equal(run.output_parameters, null);
  assert.equal(run.work_id, 1); assert.equal(run.version_id, 10); assert.equal(run.queue_id, h.queue.id); assert.equal(run.review_id, h.review.id);
  assert.equal(run.plan_hash, h.plan.plan_hash); assert.ok(Number.isSafeInteger(run.id));
  assert.ok(Number.isFinite(Date.parse(run.created_at))); assert.equal(run.updated_at, run.created_at);
  assert.deepEqual(run.units, h.queue.units.map((unit) => ({ id: unit.id, ordinal: unit.ordinal, unit_hash: unit.unit_hash, status: 'pending', attempts: [] })));
  assert.ok(run.execution_blockers.includes('EXECUTION_RUN_STORAGE_ONLY'));
  for (const blocker of h.queue.execution_blockers) assert.ok(run.execution_blockers.includes(blocker));
  assert.equal(count(h, runTable), 1); assert.equal(count(h, attemptTable), 0); assert.deepEqual(businessSnapshot(h), before);
  assert.match(queries.find((sql) => /^BEGIN/i.test(sql)), /^BEGIN IMMEDIATE/i);
  assert.ok(queries.findIndex((sql) => /FROM ai_service_configs/i.test(sql)) > queries.findIndex((sql) => /^BEGIN IMMEDIATE/i.test(sql)));
  const writes = queries.filter((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql));
  assert.equal(writes.length, 1); assert.match(writes[0], /^INSERT INTO redraw_execution_runs/i); assertNoKeys(queries);
  assert.deepEqual(Object.keys(service).sort(), ['advanceExecutionRun', 'bindClaimedExecutionUnitTask', 'claimNextUnit', 'createExecutionRun', 'dispatchClaimedExecutionUnitTask', 'getExecutionRun', 'inspectExecutionRunAdvanceReadiness', 'inspectExecutionRunReadiness', 'listExecutionRuns', 'recoverExecutionUnitTask', 'requestExecutionRunPause', 'resumeExecutionRun']);
});

test('duplicate create revalidates evidence then returns byte-stable run with zero DML', (t) => {
  const h = fixture(t); const run = create(h); const before = h.db.serialize(); h.queries.length = 0;
  assert.deepEqual(create(h), run); noDml(h.queries); assert.deepEqual(h.db.serialize(), before); assertNoKeys(h.queries);
});

test('post-insert validation failure rolls back run registration', (t) => {
  const h = fixture(t);
  h.db.exec(`CREATE TRIGGER invalidate_new_run AFTER INSERT ON ${runTable} BEGIN UPDATE ${runTable} SET plan_hash='${'e'.repeat(64)}' WHERE id=NEW.id; END;`);
  const before = h.db.serialize(); expectCode(() => create(h), 'EXECUTION_RUN_INVALID');
  assert.equal(count(h, runTable), 0); assert.equal(count(h, attemptTable), 0); assert.deepEqual(h.db.serialize(), before);
});

test('create rolls back a post-insert live binding drift, including trigger changes visible to a new connection', async (t) => {
  const h = fixture(t);
  h.db.exec(`CREATE TRIGGER drift_after_run_insert AFTER INSERT ON ${runTable}
    BEGIN UPDATE redraw_versions SET updated_at='2026-09-07T09:00:00.000Z' WHERE id=NEW.version_id; END;`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-run-final-cas-'));
  const filename = path.join(directory, 'synthetic.sqlite'); await h.db.backup(filename);
  const writer = new Database(filename, { fileMustExist: true }); t.after(() => writer.close());
  const ctx = { ...h.ctx, db: writer }; const before = writer.serialize();
  const versionBefore = writer.prepare('SELECT * FROM redraw_versions WHERE id=10').get();
  expectCode(() => service.createExecutionRun(ctx, 10, h.input), 'EXECUTION_RUN_CONFLICT');
  assert.deepEqual(writer.serialize(), before);
  const reader = new Database(filename, { fileMustExist: true }); t.after(() => reader.close());
  assert.equal(reader.prepare(`SELECT COUNT(*) AS n FROM ${runTable}`).get().n, 0);
  assert.equal(reader.prepare(`SELECT COUNT(*) AS n FROM ${attemptTable}`).get().n, 0);
  assert.deepEqual(reader.prepare('SELECT * FROM redraw_versions WHERE id=10').get(), versionBefore);
});

test('run SQL rejects empty and whitespace-only owner fields', (t) => {
  const h = fixture(t); const id = seedRun(h);
  for (const field of ['tenant_id', 'user_id']) for (const value of ['', '   ', '\t\r\n']) {
    assert.throws(() => h.db.prepare(`UPDATE ${runTable} SET ${field}=? WHERE id=?`).run(value, id), /CHECK/, field + JSON.stringify(value));
  }
});

test('GET is query-only, preserves historical state through A to B to A and never creates a run', (t) => {
  const h = fixture(t); const original = h.localization.review.updated_at; const a = create(h);
  const pa = pause(h, a); drift(h);
  h.plan = previewVersionExecutionPlan(h.ctx, 10); h.review = saveExecutionPlanReview(h.ctx, 10, { expected_plan_hash: h.plan.plan_hash }).saved_review;
  h.queue = prepareExecutionQueue(h.ctx, 10, { expected_plan_hash: h.plan.plan_hash }).queue;
  h.input = { expected_plan_hash: h.plan.plan_hash, expected_queue_id: h.queue.id }; const b = create(h);
  const before = h.db.serialize(); h.queries.length = 0; h.db.pragma('query_only = ON');
  const history = get(h, a.id); assert.equal(history.status, 'paused'); assert.equal(history.revision, pa.revision);
  assert.equal(history.binding_status, 'stale'); assert.equal(history.queue_id, a.queue_id); assert.deepEqual(history.units, a.units);
  assert.ok(history.execution_blockers.includes('EXECUTION_RUN_STALE')); assert.equal(get(h, b.id).binding_status, 'current');
  noDml(h.queries); assert.deepEqual(h.db.serialize(), before); h.db.pragma('query_only = OFF');
  drift(h, original); assert.deepEqual(get(h, a.id), pa); assert.equal(get(h, b.id).binding_status, 'stale');
});

for (const [name, who, mutate, version] of [
  ['foreign user', { userId: 'other' }], ['foreign tenant', { tenantId: 'other' }], ['missing user', { userId: null }],
  ['deleted work', {}, (h) => h.db.prepare('UPDATE redraw_works SET deleted_at=?').run(stamp)],
  ['deleted version', {}, (h) => h.db.prepare('UPDATE redraw_versions SET deleted_at=?').run(stamp)],
  ['foreign parent owner', {}, (h) => h.db.prepare("UPDATE redraw_works SET user_id='other'").run()],
  ['wrong version', {}, null, 999], ['invalid version', {}, null, 'not-an-id'],
]) {
  test(`run APIs deny ${name} before live config or queue reads`, (t) => {
    const h = fixture(t); const run = create(h); mutate?.(h); const ctx = { ...h.ctx, ...who }; h.queries.length = 0;
    const before = h.db.serialize();
    expectCode(() => create(h, h.input, ctx, version ?? 10), 'REDRAW_VERSION_NOT_FOUND');
    expectCode(() => get(h, run.id, ctx, version ?? 10), 'REDRAW_VERSION_NOT_FOUND');
    expectCode(() => service.requestExecutionRunPause(ctx, version ?? 10, run.id, { expected_revision: 0 }), 'REDRAW_VERSION_NOT_FOUND');
    noDml(h.queries); assert.deepEqual(h.db.serialize(), before);
    assert.ok(!h.queries.some((sql) => /FROM (?:ai_service_configs|redraw_execution_queue)/i.test(sql)));
  });
}

test('missing or foreign run IDs are concealed, without inspecting foreign snapshots', (t) => {
  const h = fixture(t); const run = create(h);
  for (const id of [999, 0, -1, 1.5, 'invalid']) {
    expectCode(() => get(h, id), 'EXECUTION_RUN_NOT_FOUND');
    expectCode(() => service.requestExecutionRunPause(h.ctx, 10, id, { expected_revision: 0 }), 'EXECUTION_RUN_NOT_FOUND');
  }
  h.db.prepare(`UPDATE ${runTable} SET user_id='other' WHERE id=?`).run(run.id); h.queries.length = 0;
  expectCode(() => get(h, run.id), 'EXECUTION_RUN_NOT_FOUND'); noDml(h.queries);
  assert.ok(!h.queries.some((sql) => /FROM ai_service_configs/i.test(sql)));
});

for (const [name, input] of [
  ['missing', undefined], ['null', null], ['array', []], ['empty', {}],
  ['bad hash', { expected_plan_hash: 'X'.repeat(64), expected_queue_id: 1 }],
  ['string queue', { expected_plan_hash: 'a'.repeat(64), expected_queue_id: '1' }],
  ['unsafe queue', { expected_plan_hash: 'a'.repeat(64), expected_queue_id: Number.MAX_SAFE_INTEGER + 1 }],
  ...['status', 'output_parameters', 'model', 'key', 'base_url', 'unit'].map((key) => [key, { expected_plan_hash: 'a'.repeat(64), expected_queue_id: 1, [key]: null }]),
]) {
  test(`create rejects ${name} input, without writes or preview access`, (t) => {
    const h = fixture(t); const before = h.db.serialize(); h.queries.length = 0;
    expectCode(() => service.createExecutionRun(h.ctx, 10, input), 'EXECUTION_RUN_INPUT_INVALID');
    noDml(h.queries); assert.deepEqual(h.db.serialize(), before);
    assert.ok(!h.queries.some((sql) => /FROM ai_service_configs/i.test(sql)));
  });
}

test('create exact queue/hash CAS and current review are mandatory even on existing runs', (t) => {
  const h = fixture(t); create(h);
  for (const input of [{ ...h.input, expected_queue_id: 999 }, { ...h.input, expected_plan_hash: 'f'.repeat(64) }]) {
    const before = h.db.serialize(); expectCode(() => create(h, input), 'EXECUTION_RUN_CONFLICT'); assert.deepEqual(h.db.serialize(), before);
  }
  drift(h); const before = h.db.serialize(); expectCode(() => create(h), 'EXECUTION_RUN_CONFLICT'); assert.deepEqual(h.db.serialize(), before);
});

for (const [name, mutate] of [
  ['run plan', (h, run) => h.db.prepare(`UPDATE ${runTable} SET plan_hash=? WHERE id=?`).run('d'.repeat(64), run.id)],
  ['run work', (h, run) => { h.db.pragma('foreign_keys = OFF'); h.db.prepare(`UPDATE ${runTable} SET work_id=999 WHERE id=?`).run(run.id); }],
  ['run review', (h, run) => { h.db.pragma('foreign_keys = OFF'); h.db.prepare(`UPDATE ${runTable} SET review_id=999 WHERE id=?`).run(run.id); }],
  ['run queue', (h, run) => { h.db.pragma('foreign_keys = OFF'); h.db.prepare(`UPDATE ${runTable} SET queue_id=999 WHERE id=?`).run(run.id); }],
  ['queue unit bytes', (h) => { h.db.exec('DROP TRIGGER redraw_execution_queue_units_immutable_update'); h.db.prepare("UPDATE redraw_execution_queue_units SET unit_json='{}' WHERE queue_id=?").run(h.queue.id); }],
  ['queue review bytes', (h) => { h.db.exec('DROP TRIGGER redraw_execution_plan_reviews_immutable_update'); h.db.prepare("UPDATE redraw_execution_plan_reviews SET plan_json='{}' WHERE id=?").run(h.review.id); }],
  ['run timestamp', (h, run) => h.db.prepare(`UPDATE ${runTable} SET updated_at='invalid' WHERE id=?`).run(run.id)],
]) {
  test(`GET and pause reject corrupt ${name} without changing state`, (t) => {
    const h = fixture(t); const run = create(h); mutate(h, run); const before = h.db.serialize(); h.queries.length = 0;
    expectCode(() => get(h, run.id), 'EXECUTION_RUN_INVALID'); expectCode(() => pause(h, run), 'EXECUTION_RUN_INVALID');
    noDml(h.queries); assert.deepEqual(h.db.serialize(), before);
  });
}

test('historical queue corruption is rejected even when a newer current queue is healthy', (t) => {
  const h = fixture(t); const run = create(h); drift(h);
  const plan = previewVersionExecutionPlan(h.ctx, 10); saveExecutionPlanReview(h.ctx, 10, { expected_plan_hash: plan.plan_hash });
  prepareExecutionQueue(h.ctx, 10, { expected_plan_hash: plan.plan_hash });
  h.db.exec('DROP TRIGGER redraw_execution_queue_units_immutable_update');
  h.db.prepare("UPDATE redraw_execution_queue_units SET unit_json='{}' WHERE queue_id=?").run(run.queue_id);
  const before = h.db.serialize(); expectCode(() => get(h, run.id), 'EXECUTION_RUN_INVALID'); assert.deepEqual(h.db.serialize(), before);
});

test('pause increments exact revision once, does not mutate queue, and stale CAS cannot repeat it', (t) => {
  const h = fixture(t); const run = create(h); const parents = businessSnapshot(h); const paused = pause(h, run);
  assert.equal(paused.status, 'paused'); assert.equal(paused.pause_requested, true); assert.equal(paused.revision, 1);
  assert.deepEqual(businessSnapshot(h), parents); assert.equal(count(h, attemptTable), 0);
  const before = h.db.serialize(); h.queries.length = 0;
  expectCode(() => pause(h, run), 'EXECUTION_RUN_CONFLICT'); noDml(h.queries); assert.deepEqual(h.db.serialize(), before);
  assert.equal(pause(h, paused).revision, 2);
});

test('pause overflow or malformed CAS is rejected with zero writes', (t) => {
  const h = fixture(t); const run = create(h);
  for (const input of [null, {}, [], { expected_revision: '0' }, { expected_revision: -1 }, { expected_revision: 0.5 },
    { expected_revision: Number.MAX_SAFE_INTEGER + 1 }, { expected_revision: 0, status: 'ready' }]) {
    h.queries.length = 0;
    expectCode(() => service.requestExecutionRunPause(h.ctx, 10, run.id, input), 'EXECUTION_RUN_INPUT_INVALID'); noDml(h.queries);
  }
  h.db.prepare(`UPDATE ${runTable} SET revision=? WHERE id=?`).run(Number.MAX_SAFE_INTEGER, run.id);
  const before = h.db.serialize(); h.queries.length = 0;
  expectCode(() => pause(h, run, Number.MAX_SAFE_INTEGER), 'EXECUTION_RUN_CONFLICT'); noDml(h.queries); assert.deepEqual(h.db.serialize(), before);
});

for (const status of activeStates) {
  test(`pause of ${status} attempt sets only the run flag and preserves submitting facts`, (t) => {
    const h = fixture(t); const run = create(h);
    h.db.prepare(`UPDATE ${runTable} SET status='running' WHERE id=?`).run(run.id);
    seedAttempt(h, run.id, { status, task_id: 'synthetic-task', billing_mode: 'paid', quoted_amount: 7,
      reservation_id: 'synthetic-held', request_hash: '4'.repeat(64), provider_task_id: 'synthetic-provider', submit_started_at: stamp });
    const before = h.db.prepare(`SELECT * FROM ${attemptTable}`).all(); const paused = pause(h, run);
    assert.equal(paused.status, 'running'); assert.equal(paused.pause_requested, true); assert.equal(paused.revision, 1);
    assert.equal(paused.units[0].status, status); assert.deepEqual(h.db.prepare(`SELECT * FROM ${attemptTable}`).all(), before);
    assert.ok(!/synthetic-private|synthetic-provider|synthetic-task|synthetic-held|claim_token|request_hash|quality_json/.test(JSON.stringify(paused)));
  });
}

for (const status of ['waiting_review', 'failed', 'needs_attention', 'stale', 'completed']) {
  test(`pause preserves stored ${status} and never converts it to ready`, (t) => {
    const h = fixture(t); const run = create(h);
    h.db.prepare(`UPDATE ${runTable} SET status=? WHERE id=?`).run(status, run.id);
    const paused = pause(h, run); assert.equal(paused.status, status); assert.equal(paused.pause_requested, true);
  });
}

test('unknown attempt remains frozen, including after live-plan drift, GET and pause', (t) => {
  const h = fixture(t); const run = create(h);
  h.db.prepare(`UPDATE ${runTable} SET status='needs_attention' WHERE id=?`).run(run.id);
  seedAttempt(h, run.id, { status: 'needs_attention', billing_mode: 'paid', quoted_amount: 7,
    reservation_id: 'synthetic-held', request_hash: '5'.repeat(64), submit_started_at: stamp });
  const before = h.db.prepare(`SELECT * FROM ${attemptTable}`).all(); drift(h); const history = get(h, run.id);
  assert.equal(history.binding_status, 'stale'); assert.equal(history.status, 'needs_attention');
  const paused = pause(h, run); assert.equal(paused.binding_status, 'stale'); assert.equal(paused.status, 'needs_attention');
  assert.equal(paused.units[0].status, 'needs_attention'); assert.deepEqual(h.db.prepare(`SELECT * FROM ${attemptTable}`).all(), before);
  expectCode(() => create(h), 'EXECUTION_RUN_CONFLICT'); assert.equal(count(h, runTable), 1);
});

test('live-stale ready run is not relabelled paused or ready by pause', (t) => {
  const h = fixture(t); const run = create(h); drift(h); const paused = pause(h, run);
  assert.equal(paused.status, 'ready'); assert.equal(paused.binding_status, 'stale'); assert.equal(paused.executable, false);
  assert.equal(paused.pause_requested, true); assert.equal(paused.revision, 1);
});

test('run GET validates exact concrete output parameter keys, allowed values and canonical hash', (t) => {
  const h = fixture(t); const run = create(h);
  for (const params of [{}, { ...outputParameters, model: 'injected' }, { resolution: '720p', aspect_ratio: '9:16' },
    { resolution: '480p', aspect_ratio: '16:9' }, { resolution: ['480p'], aspect_ratio: '9:16' }]) {
    // Bypass SQL checks solely to emulate historical storage damage.
    h.db.pragma('ignore_check_constraints = ON');
    h.db.prepare(`UPDATE ${runTable} SET output_parameters_json=?,output_parameters_hash=? WHERE id=?`).run(JSON.stringify(params), hashPlanValue(params), run.id);
    h.db.pragma('ignore_check_constraints = OFF'); expectCode(() => get(h, run.id), 'EXECUTION_RUN_INVALID');
  }
  h.db.prepare(`UPDATE ${runTable} SET output_parameters_json=?,output_parameters_hash=? WHERE id=?`).run(JSON.stringify(outputParameters), '0'.repeat(64), run.id);
  expectCode(() => get(h, run.id), 'EXECUTION_RUN_INVALID');
  h.db.prepare(`UPDATE ${runTable} SET output_parameters_hash=? WHERE id=?`).run(hashPlanValue(outputParameters), run.id);
  assert.deepEqual(get(h, run.id).output_parameters, outputParameters);
});

test('attempt unit binding and owner/queue association are validated beyond single-column FKs', (t) => {
  const h = fixture(t); const run = create(h); const id = seedAttempt(h, run.id);
  h.db.prepare(`UPDATE ${attemptTable} SET unit_hash=? WHERE id=?`).run('a'.repeat(64), id);
  expectCode(() => get(h, run.id), 'EXECUTION_RUN_INVALID');
  const oldUnit = h.db.prepare('SELECT id,unit_hash FROM redraw_execution_queue_units WHERE queue_id=?').get(h.queue.id);
  h.db.prepare(`UPDATE ${attemptTable} SET unit_hash=? WHERE id=?`).run(oldUnit.unit_hash, id);
  drift(h); const p = previewVersionExecutionPlan(h.ctx, 10); saveExecutionPlanReview(h.ctx, 10, { expected_plan_hash: p.plan_hash });
  const q = prepareExecutionQueue(h.ctx, 10, { expected_plan_hash: p.plan_hash }).queue;
  const foreignUnit = h.db.prepare('SELECT id,unit_hash FROM redraw_execution_queue_units WHERE queue_id=?').get(q.id);
  h.db.prepare(`UPDATE ${attemptTable} SET queue_unit_id=?,unit_hash=? WHERE id=?`).run(foreignUnit.id, foreignUnit.unit_hash, id);
  const before = h.db.serialize(); expectCode(() => get(h, run.id), 'EXECUTION_RUN_INVALID');
  expectCode(() => pause(h, run), 'EXECUTION_RUN_INVALID'); assert.deepEqual(h.db.serialize(), before);
});

// Each worker uses a new real SQLite connection and the same explicitly verified no-network preload.
// No test module/default config/migration/application is imported by these children.
const childCode = String.raw`
'use strict';
const { createRequire } = require('node:module');
const payload = JSON.parse(process.argv[1]);
const localRequire = createRequire(payload.packageFile);
const Database = localRequire('better-sqlite3');
const service = localRequire('./src/services/redrawExecutionRunService');
const db = new Database(payload.databaseFile, { timeout: 10000, fileMustExist: true });
db.pragma('foreign_keys = ON');
const ctx = { db, tenantId: 'tenant-a', userId: 'user-a', storageRoot: payload.storageRoot,
  canReadArtifact: (id) => [700, 701].includes(Number(id)) };
function inspectIsolation() {
  const assert = require('node:assert/strict');
  const checks = [];
  for (const [name, methods, kind] of [
    ['./src/config/index.js', ['loadConfig'], 'DEFAULT_CONFIG'],
    ['./src/db/index.js', ['getDb', 'closeDb'], 'DEFAULT_DATABASE'],
  ]) {
    // Check the preloaded cache first: a broken guard must never load a real default module.
    const cached = require.cache[localRequire.resolve(name)];
    assert.ok(cached?.loaded, 'default module must already be guarded');
    for (const method of methods) checks.push([cached.exports[method], kind]);
  }
  checks.push([global.fetch, 'NETWORK']);
  for (const name of ['node:http', 'node:https']) for (const method of ['request', 'get']) checks.push([require(name)[method], 'NETWORK']);
  for (const name of ['node:net', 'node:tls']) for (const method of ['connect', 'createConnection']) {
    if (require(name)[method]) checks.push([require(name)[method], 'NETWORK']);
  }
  for (const [fn, kind] of checks) {
    assert.equal(typeof fn, 'function');
    // Only call a verified throwing guard; never use the probe to attempt live networking.
    assert.match(fn.toString(), /REDRAW_EXECUTION_TEST_FORBIDS_/);
    assert.throws(() => fn(), { message: 'REDRAW_EXECUTION_TEST_FORBIDS_' + kind });
  }
  return { checked_guards: checks.length, node: process.execPath, cwd: process.cwd(),
    temp: require('node:os').tmpdir(), path: process.env.PATH, environment_names: Object.keys(process.env).sort() };
}
function finish() {
  try {
    const result = payload.operation === 'isolation' ? inspectIsolation()
      : payload.operation === 'get' ? service.getExecutionRun(ctx, 10, payload.runId)
      : payload.operation === 'pause' ? service.requestExecutionRunPause(ctx, 10, payload.runId, { expected_revision: 0 })
      : service.createExecutionRun(ctx, 10, payload.input);
    if (db.inTransaction) db.exec('COMMIT');
    process.stdout.write(JSON.stringify({ type: 'result', result }) + '\n');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    process.stdout.write(JSON.stringify({ type: 'failure', code: error.code }) + '\n');
    process.exitCode = 1;
  } finally { db.close(); process.stdin.destroy(); }
}
if (payload.hold) {
  db.exec('BEGIN IMMEDIATE');
  process.stdout.write(JSON.stringify({ type: 'locked' }) + '\n');
  process.stdin.once('data', finish);
} else {
  if (payload.probeLock) {
    db.pragma('busy_timeout = 0');
    try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); throw new Error('EXPECTED_REAL_LOCK_CONTENTION'); }
    catch (error) {
      if (error.code !== 'SQLITE_BUSY') throw error;
      process.stdout.write(JSON.stringify({ type: 'blocked', code: error.code }) + '\n');
    }
    db.pragma('busy_timeout = 10000');
  }
  process.stdout.write(JSON.stringify({ type: 'started' }) + '\n');
  finish();
}
`;

function childEnvironment(cwd, platform = process.platform, systemEnvironment = process.env) {
  const env = { TEMP: cwd, TMP: cwd, TMPDIR: cwd, NODE_ENV: 'test', NODE_OPTIONS: '', PATH: '' };
  if (platform === 'win32') {
    const root = path.parse(path.resolve(cwd)).root;
    Object.assign(env, { HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: path.resolve(cwd).slice(root.length - 1),
      LOGONSERVER: '\\\\SYNTHETIC', SYSTEMDRIVE: root.replace(/[\\/]$/, ''), USERDOMAIN: 'SYNTHETIC',
      USERNAME: 'g4-fixture', USERPROFILE: path.resolve(cwd) });
    for (const name of ['SystemRoot', 'WINDIR']) {
      if (systemEnvironment[name]) env[name] = systemEnvironment[name];
    }
  }
  return env;
}

function child(t, h, databaseFile, operation, { hold = false, runId, probeLock = false,
  evidenceDirectory = process.env.G4_RUN_EVIDENCE_DIR } = {}) {
  assert.equal(createHash('sha256').update(fs.readFileSync(preloadFile)).digest('hex'), preloadSha);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-run-child-'));
  const env = childEnvironment(cwd);
  const payload = { packageFile: path.join(__dirname, '../package.json'), databaseFile,
    storageRoot: h.evidence.storageRoot, input: h.input, operation, hold, runId, probeLock };
  const proc = spawn(process.execPath, ['--require', preloadFile, '-e', childCode, JSON.stringify(payload)],
    { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = []; const pending = []; let stdout = ''; let stderr = ''; let buffer = ''; let ended = false; let timedOut = false;
  const timer = setTimeout(() => { if (!ended) { timedOut = true; proc.kill(); } }, 15000);
  const result = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.stdout.on('data', (bytes) => {
      const text = bytes.toString(); stdout += text; buffer += text;
      for (;;) {
        const boundary = buffer.indexOf('\n'); if (boundary < 0) break;
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1); if (!line) continue;
        const message = JSON.parse(line); messages.push(message);
        for (const waiter of [...pending]) if (waiter.type === message.type) { pending.splice(pending.indexOf(waiter), 1); waiter.resolve(message); }
      }
    });
    proc.stderr.on('data', (bytes) => { stderr += bytes.toString(); });
    proc.on('close', (code, signal) => {
      ended = true; clearTimeout(timer);
      for (const waiter of pending) waiter.reject(new Error('worker ended before ' + waiter.type + ': ' + stderr));
      const prefix = path.join(evidenceDirectory || cwd, 'child-' + path.basename(cwd));
      fs.writeFileSync(prefix + '.stdout.jsonl', stdout, { flag: 'wx' });
      fs.writeFileSync(prefix + '.stderr.txt', stderr, { flag: 'wx' });
      fs.writeFileSync(prefix + '.native.json', JSON.stringify({ code, signal, timedOut, cwd, operation, hold, probeLock, pid: proc.pid,
        preload_sha256: preloadSha, node: process.execPath, activities_remaining: [] }), { flag: 'wx' });
      resolve({ code, signal, timedOut, stdout, stderr, messages, cwd, prefix });
    });
  });
  t.after(async () => { if (!ended) proc.kill(); await result; });
  return { proc, result, wait(type) { const message = messages.find((item) => item.type === type);
    if (message) return Promise.resolve(message);
    if (ended) return Promise.reject(new Error('worker ended before ' + type));
    return new Promise((resolve, reject) => pending.push({ type, resolve, reject })); } };
}

test('two real processes contend on SQLite and create the same run; a fresh process GET is zero-write', async (t) => {
  const h = fixture(t); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-run-concurrent-'));
  const filename = path.join(directory, 'synthetic.sqlite'); await h.db.backup(filename);
  const a = child(t, h, filename, 'create', { hold: true }); await a.wait('locked');
  const b = child(t, h, filename, 'create', { probeLock: true }); await b.wait('blocked'); a.proc.stdin.end('release\n');
  const [ra, rb] = await Promise.all([a.result, b.result]);
  for (const result of [ra, rb]) { assert.equal(result.signal, null); assert.equal(result.timedOut, false); assert.equal(result.stderr, ''); }
  assert.equal(ra.code, 0, ra.stdout + ra.stderr); assert.equal(rb.code, 0, rb.stdout + rb.stderr);
  const run = ra.messages.find((item) => item.type === 'result').result;
  assert.deepEqual(rb.messages.find((item) => item.type === 'result').result, run);
  const reopened = new Database(filename, { fileMustExist: true }); t.after(() => reopened.close());
  assert.equal(reopened.prepare(`SELECT COUNT(*) AS n FROM ${runTable}`).get().n, 1);
  assert.equal(reopened.prepare(`SELECT COUNT(*) AS n FROM ${attemptTable}`).get().n, 0);
  const before = reopened.serialize(); const reader = child(t, h, filename, 'get', { runId: run.id }); const rr = await reader.result;
  assert.equal(rr.signal, null); assert.equal(rr.timedOut, false); assert.equal(rr.stderr, '');
  assert.equal(rr.code, 0, rr.stdout + rr.stderr); assert.deepEqual(rr.messages.find((item) => item.type === 'result').result, run);
  assert.deepEqual(reopened.serialize(), before);
});

test('two real process pause calls race on revision zero and only one update commits', async (t) => {
  const h = fixture(t); const run = create(h); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-run-pause-race-'));
  const filename = path.join(directory, 'synthetic.sqlite'); await h.db.backup(filename);
  const a = child(t, h, filename, 'pause', { hold: true, runId: run.id }); await a.wait('locked');
  const b = child(t, h, filename, 'pause', { runId: run.id, probeLock: true }); await b.wait('blocked'); a.proc.stdin.end('release\n');
  const [ra, rb] = await Promise.all([a.result, b.result]); assert.equal(ra.code, 0, ra.stdout + ra.stderr);
  for (const result of [ra, rb]) { assert.equal(result.signal, null); assert.equal(result.timedOut, false); assert.equal(result.stderr, ''); }
  assert.equal(rb.code, 1, rb.stdout + rb.stderr); assert.equal(rb.messages.find((item) => item.type === 'failure').code, 'EXECUTION_RUN_CONFLICT');
  const reopened = new Database(filename, { fileMustExist: true }); t.after(() => reopened.close());
  assert.deepEqual(reopened.prepare(`SELECT status,pause_requested,revision FROM ${runTable}`).get(), { status: 'paused', pause_requested: 1, revision: 1 });
  assert.equal(reopened.prepare(`SELECT COUNT(*) AS n FROM ${attemptTable}`).get().n, 0);
});

test('formal child preload belongs to delivered test helpers, not a local audit directory', () => {
  assert.equal(preloadFile, path.join(__dirname, 'helpers/redrawExecutionChildPreload.cjs'));
});

test('formal child starts and records the actual Node executable instead of a platform-specific path', () => {
  assert.match(child.toString(), /spawn\(process\.execPath,/);
  assert.match(child.toString(), /node: process\.execPath/);
});

test('child environment is minimal on Linux and preserves only required Windows system fields', () => {
  const cwd = 'synthetic-private-temp';
  const base = { TEMP: cwd, TMP: cwd, TMPDIR: cwd, NODE_ENV: 'test', NODE_OPTIONS: '', PATH: '' };
  const parent = { SystemRoot: 'synthetic-system', WINDIR: 'synthetic-windir', PATH: 'must-not-inherit',
    NODE_OPTIONS: 'must-not-inherit', UNRELATED_PRIVATE_VALUE: 'must-not-inherit' };
  assert.deepEqual(childEnvironment(cwd, 'linux', parent), base);
  const expectedCwd = path.resolve(cwd), root = path.parse(expectedCwd).root.replace(/[\\/]$/, '');
  assert.deepEqual(childEnvironment(cwd, 'win32', parent), { ...base, HOMEDRIVE: root,
    HOMEPATH: expectedCwd.slice(root.length), LOGONSERVER: '\\\\SYNTHETIC', SYSTEMDRIVE: root,
    USERDOMAIN: 'SYNTHETIC', USERNAME: 'g4-fixture', USERPROFILE: expectedCwd,
    SystemRoot: parent.SystemRoot, WINDIR: parent.WINDIR });
});

test('delivered preload blocks default config, database and network in a fresh child with temporary default logs', async (t) => {
  const h = fixture(t); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-run-preload-'));
  const filename = path.join(directory, 'synthetic.sqlite'); await h.db.backup(filename);
  const worker = child(t, h, filename, 'isolation', { evidenceDirectory: null }); const actual = await worker.result;
  assert.equal(actual.code, 0, actual.stdout + actual.stderr); assert.equal(actual.signal, null);
  assert.equal(actual.timedOut, false); assert.equal(actual.stderr, '');
  const result = actual.messages.find((message) => message.type === 'result').result;
  assert.ok(result.checked_guards >= 10); assert.equal(result.node, process.execPath);
  assert.equal(result.cwd, actual.cwd); assert.equal(result.temp, actual.cwd);
  assert.equal(result.path, '');
  assert.deepEqual(result.environment_names, Object.keys(childEnvironment(actual.cwd)).sort());
  assert.equal(path.dirname(actual.prefix), actual.cwd);
  for (const suffix of ['.stdout.jsonl', '.stderr.txt', '.native.json']) {
    const file = actual.prefix + suffix; assert.ok(fs.existsSync(file));
    if (process.env.G4_RUN_EVIDENCE_DIR) fs.copyFileSync(file,
      path.join(process.env.G4_RUN_EVIDENCE_DIR, 'default-log-' + path.basename(file)), fs.constants.COPYFILE_EXCL);
  }
  const native = JSON.parse(fs.readFileSync(actual.prefix + '.native.json', 'utf8'));
  assert.equal(native.node, process.execPath); assert.equal(native.preload_sha256, preloadSha);
  const reopened = new Database(filename, { fileMustExist: true }); t.after(() => reopened.close());
  assert.equal(reopened.prepare(`SELECT COUNT(*) AS n FROM ${runTable}`).get().n, 0);
});

for (const field of ['work_id', 'version_id', 'review_id', 'queue_id']) {
  test(`valid individual foreign keys cannot authorize mismatched run ${field}`, (t) => {
    const h = fixture(t); h.db.pragma('foreign_keys = ON');
    h.db.prepare(`INSERT INTO redraw_projects (id,tenant_id,user_id,title,created_at,updated_at) VALUES (2,'tenant-b','user-b','foreign',?,?)`).run(stamp, stamp);
    h.db.prepare(`INSERT INTO redraw_works (id,project_id,tenant_id,user_id,title,current_version,source_asset_id,source_fingerprint,duration_ms,created_at,updated_at)
      VALUES (2,2,'tenant-b','user-b','foreign',1,91,'synthetic-foreign-source',12000,?,?)`).run(stamp, stamp);
    h.db.prepare(`INSERT INTO redraw_versions (id,work_id,tenant_id,user_id,version,locale,market,status,created_at,updated_at) VALUES (20,2,'tenant-b','user-b',1,'en','US','needs_review',?,?)`).run(stamp, stamp);
    const otherPlan = structuredClone(h.plan);
    Object.assign(otherPlan.bindings, { tenant_id: 'tenant-b', user_id: 'user-b', work_id: 2, version_id: 20 });
    const { plan_hash: ignored, ...body } = otherPlan; otherPlan.plan_hash = hashPlanValue(body);
    const reviewId = Number(h.db.prepare(`INSERT INTO redraw_execution_plan_reviews (tenant_id,user_id,work_id,version_id,plan_hash,plan_json,created_at) VALUES ('tenant-b','user-b',2,20,?,?,?)`)
      .run(otherPlan.plan_hash, JSON.stringify(otherPlan), stamp).lastInsertRowid);
    const queueId = Number(h.db.prepare(`INSERT INTO redraw_execution_queues (tenant_id,user_id,work_id,version_id,review_id,plan_hash,status,created_at) VALUES ('tenant-b','user-b',2,20,?,?,'waiting_readiness',?)`)
      .run(reviewId, otherPlan.plan_hash, stamp).lastInsertRowid);
    const id = seedRun(h, { [field]: { work_id: 2, version_id: 20, review_id: reviewId, queue_id: queueId }[field] });
    assert.deepEqual(h.db.pragma('foreign_key_check'), []);
    const before = h.db.serialize(); h.queries.length = 0;
    expectCode(() => get(h, id), field === 'version_id' ? 'EXECUTION_RUN_NOT_FOUND' : 'EXECUTION_RUN_INVALID');
    noDml(h.queries); assert.deepEqual(h.db.serialize(), before);
  });
}

test('unknown historical GET works with query_only and preserves nullable task/reservation facts', (t) => {
  const h = fixture(t, { multi: true }); const run = create(h);
  seedAttempt(h, run.id, { status: 'needs_attention' });
  const next = h.db.prepare('SELECT id,unit_hash FROM redraw_execution_queue_units WHERE queue_id=? AND ordinal=1').get(h.queue.id);
  seedAttempt(h, run.id, { queue_unit_id: next.id, unit_hash: next.unit_hash, status: 'failed', claim_token: 'another-synthetic-private' });
  h.db.prepare(`UPDATE ${runTable} SET status='needs_attention' WHERE id=?`).run(run.id); drift(h);
  h.db.pragma('query_only = ON'); const before = h.db.serialize(); h.queries.length = 0;
  const actual = get(h, run.id); assert.equal(actual.status, 'needs_attention'); assert.equal(actual.binding_status, 'stale');
  assert.equal(actual.units[0].status, 'needs_attention'); assert.equal(actual.units[1].status, 'failed');
  noDml(h.queries); assert.deepEqual(h.db.serialize(), before);
});
