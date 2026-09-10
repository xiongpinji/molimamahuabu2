'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { fixture } = require('./redrawExecutionPlanPreview.test');
const { previewVersionExecutionPlan } = require('../src/services/redrawExecutionPlanPreviewService');
const { hashPlanValue } = require('../src/services/redrawExecutionPlanService');

const queues = 'redraw_execution_queues';
const units = 'redraw_execution_queue_units';
const reviews = 'redraw_execution_plan_reviews';
const owner = { tenantId: 'tenant-a', userId: 'user-a' };
const later = '2026-09-05T18:00:00.000Z';
const current = (h) => previewVersionExecutionPlan(h.ctx, 10);
const count = (h, table = queues) => h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
function call(h, method, body, who, id = '10') {
  assert.equal(typeof h.handler[method], 'function', `${method} must be implemented`);
  const req = h.req(who); req.params.id = id; req.body = body;
  const res = h.res(); h.handler[method](req, res); return res;
}
const get = (h, who, id) => call(h, 'getExecutionQueue', undefined, who, id);
const post = (h, hash = current(h).plan_hash, who, id) => call(h, 'prepareExecutionQueue', { expected_plan_hash: hash }, who, id);
function save(h) {
  const result = call(h, 'saveExecutionPlanReview', { expected_plan_hash: current(h).plan_hash });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  return result.body.data.saved_review;
}
function accepted(result) {
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  return result.body.data;
}
function error(result, status, code) {
  assert.equal(result.statusCode, status, JSON.stringify(result.body));
  assert.equal(result.body.error.code, code);
}
function stamp(h, value = later) {
  h.localization.review.updated_at = value;
  h.db.prepare('UPDATE redraw_versions SET localization_review_json = ? WHERE id = 10')
    .run(JSON.stringify(h.localization));
}
function multiFixture(t) {
  const h = fixture(t);
  h.capabilities['fumin-seedance-2.0-mini'].durations = [5, 6];
  h.db.prepare('UPDATE ai_service_configs SET verified_capabilities = ? WHERE id = 41').run(JSON.stringify(h.capabilities));
  assert.ok(current(h).units.length > 1, 'fixture must contain multiple real planned units');
  return h;
}
function businessSnapshot(h) {
  return h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().filter(({ name }) => ![queues, units].includes(name))
    .map(({ name }) => [name, h.db.prepare(`SELECT * FROM "${name}"`).all()]);
}
function noKeys(sql) {
  const configs = sql.filter((q) => /FROM ai_service_configs/i.test(q));
  assert.ok(configs.length > 0);
  assert.ok(configs.every((q) => !/SELECT\s+\*|api_key|base_url|endpoint|(?:SELECT|,)\s*settings\s*(?:,|FROM)/i.test(q)));
}
function rawQueue(h, review, overrides = {}) {
  return h.db.prepare(`INSERT INTO ${queues}
    (tenant_id,user_id,work_id,version_id,review_id,plan_hash,status,created_at)
    VALUES (@tenant_id,@user_id,@work_id,@version_id,@review_id,@plan_hash,@status,@created_at)`)
    .run({ tenant_id: owner.tenantId, user_id: owner.userId, work_id: 1, version_id: 10,
      review_id: review.id, plan_hash: review.plan_hash, status: 'waiting_readiness', created_at: later, ...overrides });
}
function rawUnit(h, queueId, unit, overrides = {}) {
  return h.db.prepare(`INSERT INTO ${units} (queue_id,unit_id,ordinal,unit_hash,unit_json,status)
    VALUES (@queue_id,@unit_id,@ordinal,@unit_hash,@unit_json,@status)`)
    .run({ queue_id: queueId, unit_id: unit.id, ordinal: 0, unit_hash: hashPlanValue(unit),
      unit_json: JSON.stringify(unit), status: 'pending', ...overrides });
}
function corrupt(h, table, sql, ...args) {
  h.db.exec(`DROP TRIGGER ${table}_immutable_update; DROP TRIGGER ${table}_immutable_delete`);
  h.db.prepare(sql).run(...args);
}

test('queue migration reruns, enforces JSON/hash/FK/uniqueness, and both tables reject UPDATE/DELETE', (t) => {
  const h = fixture(t);
  assert.ok(h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(queues), 'queue table must exist');
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/75_redraw_execution_queues.sql'), 'utf8');
  h.db.exec(sql); h.db.exec(sql); h.db.pragma('foreign_keys = ON');
  const review = save(h); const id = Number(rawQueue(h, review).lastInsertRowid); const unit = review.plan.units[0];
  rawUnit(h, id, unit);
  assert.throws(() => rawQueue(h, review), /UNIQUE/);
  assert.throws(() => rawQueue(h, review, { plan_hash: 'z'.repeat(64) }), /CHECK/);
  assert.throws(() => rawQueue(h, review, { plan_hash: 'b'.repeat(64), review_id: 999 }), /FOREIGN KEY/);
  assert.throws(() => rawQueue(h, review, { plan_hash: 'b'.repeat(64), work_id: 999 }), /FOREIGN KEY/);
  assert.throws(() => rawQueue(h, review, { plan_hash: 'b'.repeat(64), version_id: 999 }), /FOREIGN KEY/);
  assert.throws(() => rawQueue(h, review, { plan_hash: 'b'.repeat(64), status: 'running' }), /CHECK/);
  assert.throws(() => rawUnit(h, id, unit), /UNIQUE/);
  assert.throws(() => rawUnit(h, id, unit, { ordinal: 1 }), /UNIQUE/);
  assert.throws(() => rawUnit(h, id, unit, { unit_id: 'other' }), /UNIQUE/);
  assert.throws(() => rawUnit(h, id, unit, { unit_id: 'other', ordinal: 1, unit_json: '{' }), /CHECK/);
  assert.throws(() => rawUnit(h, id, unit, { unit_id: 'other', ordinal: 1, unit_hash: 'z'.repeat(64) }), /CHECK/);
  assert.throws(() => rawUnit(h, 999, unit), /FOREIGN KEY/);
  assert.throws(() => rawUnit(h, id, unit, { unit_id: 'other', ordinal: 1, status: 'running' }), /CHECK/);
  for (const table of [queues, units]) {
    assert.throws(() => h.db.prepare(`UPDATE ${table} SET status = status`).run(), /immutable/i);
    assert.throws(() => h.db.prepare(`DELETE FROM ${table}`).run(), /immutable/i);
  }
  assert.deepEqual(h.db.prepare('PRAGMA index_info(idx_redraw_execution_queues_latest)').all()
    .map((item) => item.name), ['tenant_id', 'user_id', 'version_id', 'id']);
});

test('GET without a queue is pure read and does not auto-save review', (t) => {
  const h = fixture(t); const plan = current(h); const before = h.db.serialize(); h.queries.length = 0;
  assert.deepEqual(accepted(get(h)), { preview: plan, saved_review: null, queue: null });
  assert.deepEqual(h.db.serialize(), before);
  assert.ok(!h.queries.some((q) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(q)));
  noKeys(h.queries);
});

test('POST persists every full plan unit atomically, survives reopening, and changes no business/review state', async (t) => {
  const h = multiFixture(t); const review = save(h); const before = businessSnapshot(h); h.queries.length = 0;
  const data = accepted(post(h, review.plan_hash)); const sql = h.queries.slice();
  assert.deepEqual(data.saved_review, review); assert.deepEqual(data.preview, review.plan);
  const q = data.queue;
  assert.equal(q.status, 'waiting_readiness'); assert.equal(q.executable, false);
  assert.equal(q.work_id, 1); assert.equal(q.version_id, 10); assert.equal(q.plan_hash, review.plan_hash);
  assert.ok(Number.isSafeInteger(q.id)); assert.ok(Number.isFinite(Date.parse(q.created_at)));
  assert.deepEqual(q.execution_blockers, review.plan.execution_blockers);
  assert.deepEqual(q.units, review.plan.units.map((unit, ordinal) => ({ id: unit.id, ordinal, status: 'pending',
    unit_hash: hashPlanValue(unit), plan_unit: unit })));
  assert.equal(count(h), 1); assert.equal(count(h, units), review.plan.units.length);
  assert.ok(sql.some((q) => /^BEGIN IMMEDIATE/i.test(q)));
  assert.ok(sql.some((q) => /^SAVEPOINT/i.test(q)));
  assert.ok(sql.findIndex((q) => /FROM ai_service_configs/i.test(q)) > sql.findIndex((q) => /^BEGIN IMMEDIATE/i.test(q)));
  const writes = sql.filter((q) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(q));
  assert.equal(writes.length, review.plan.units.length + 1);
  assert.ok(writes.every((q) => /^INSERT INTO redraw_execution_queue(?:s|_units)\b/i.test(q)));
  noKeys(sql); assert.deepEqual(businessSnapshot(h), before);
  const stored = h.db.serialize(); h.queries.length = 0;
  assert.deepEqual(accepted(get(h)).queue, q); assert.deepEqual(h.db.serialize(), stored);
  assert.ok(!h.queries.some((q) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(q)));
  const filename = path.join(h.evidence.storageRoot, 'execution-queue-reopen.sqlite');
  await h.db.backup(filename);
  const reopened = new Database(filename);
  try {
    const result = require('../src/services/redrawExecutionQueueService').getExecutionQueue({ ...h.ctx, db: reopened }, 10);
    assert.deepEqual(result, data);
  } finally { reopened.close(); }
});

test('failure inserting the second unit rolls back the queue and all preceding units', (t) => {
  const h = multiFixture(t); const review = save(h);
  h.db.exec(`CREATE TRIGGER fail_second_queue_unit BEFORE INSERT ON ${units} WHEN NEW.ordinal=1
    BEGIN SELECT RAISE(ABORT, 'PRIVATE_DATABASE_SENTINEL'); END;`);
  const before = h.db.serialize(); const result = post(h, review.plan_hash);
  error(result, 500, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_DATABASE_SENTINEL'));
  assert.equal(count(h), 0); assert.equal(count(h, units), 0); assert.deepEqual(h.db.serialize(), before);
});

test('repeated POST is idempotent and A -> B -> A preserves both historical queues and reuses A', (t) => {
  const h = multiFixture(t); const original = h.localization.review.updated_at;
  const aReview = save(h); const a = accepted(post(h)).queue; const before = h.db.serialize(); h.queries.length = 0;
  assert.deepEqual(accepted(post(h)).queue, a); assert.deepEqual(h.db.serialize(), before);
  assert.ok(!h.queries.some((q) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(q)));
  stamp(h); const bReview = save(h);
  assert.equal(accepted(get(h)).queue.status, 'stale');
  assert.equal(accepted(get(h)).saved_review.id, bReview.id);
  const b = accepted(post(h)).queue; assert.notEqual(a.id, b.id);
  stamp(h, original); assert.equal(current(h).plan_hash, aReview.plan_hash);
  assert.deepEqual(accepted(get(h)).queue, a); assert.deepEqual(accepted(post(h)).queue, a);
  assert.equal(count(h), 2); assert.equal(count(h, units), a.units.length + b.units.length);
});

test('latest history is selected by append id despite clock rollback, not by created_at', (t) => {
  const h = fixture(t); save(h); const a = accepted(post(h)).queue;
  stamp(h); const review = save(h);
  const b = Number(rawQueue(h, review, { created_at: '2000-01-01T00:00:00.000Z' }).lastInsertRowid);
  review.plan.units.forEach((unit, ordinal) => rawUnit(h, b, unit, { ordinal }));
  stamp(h, '2026-09-05T19:00:00.000Z'); const q = accepted(get(h)).queue;
  assert.ok(b > a.id); assert.equal(q.id, b); assert.equal(q.status, 'stale');
});

test('POST cannot hide a damaged latest B queue behind healthy current A after A -> B -> A', (t) => {
  const h = multiFixture(t); const original = h.localization.review.updated_at;
  save(h); const a = accepted(post(h)).queue;
  stamp(h); save(h); const b = accepted(post(h)).queue;
  assert.ok(b.id > a.id);
  corrupt(h, units, `UPDATE ${units} SET unit_hash=? WHERE queue_id=? AND ordinal=0`, 'f'.repeat(64), b.id);
  stamp(h, original); const before = h.db.serialize(); h.queries.length = 0;
  assert.deepEqual(accepted(get(h)).queue, a, 'GET still prefers the valid current hash');
  error(post(h, a.plan_hash), 409, 'EXECUTION_QUEUE_INVALID');
  assert.deepEqual(h.db.serialize(), before);
  assert.ok(!h.queries.some((q) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(q)));
  assert.equal(count(h), 2);
});

for (const [name, who, mutate, id] of [
  ['foreign user', { ...owner, userId: 'other' }], ['foreign tenant', { ...owner, tenantId: 'other' }],
  ['missing user', { ...owner, userId: null }], ['missing tenant', { ...owner, tenantId: null }],
  ['deleted version', owner, (h) => h.db.prepare('UPDATE redraw_versions SET deleted_at = ?').run(later)],
  ['deleted work', owner, (h) => h.db.prepare('UPDATE redraw_works SET deleted_at = ?').run(later)],
  ['foreign work', owner, (h) => h.db.prepare("UPDATE redraw_works SET user_id = 'other'").run()],
  ['unknown version', owner, null, '999'], ['invalid version', owner, null, 'bad'],
]) {
  test(`GET/POST reject ${name} before configuration, review or queue access`, (t) => {
    const h = fixture(t); mutate?.(h); const before = h.db.serialize(); h.queries.length = 0;
    error(get(h, who, id), 404, 'REDRAW_VERSION_NOT_FOUND');
    error(post(h, 'a'.repeat(64), who, id), 404, 'REDRAW_VERSION_NOT_FOUND');
    assert.deepEqual(h.db.serialize(), before);
    assert.ok(!h.queries.some((q) => /FROM (?:ai_service_configs|redraw_execution_plan_reviews|redraw_execution_queue)/i.test(q)));
  });
}

for (const body of [undefined, null, [], 'hash', {}, { expected_plan_hash: 1 },
  { expected_plan_hash: 'A'.repeat(64) }, { expected_plan_hash: 'a'.repeat(63) },
  { expected_plan_hash: ` ${'a'.repeat(64)}` },
  ...['plan', 'model', 'key', 'budget', 'status'].map((key) => ({ expected_plan_hash: 'a'.repeat(64), [key]: null }))]) {
  test(`queue POST rejects noncanonical or extra input ${JSON.stringify(body)}`, (t) => {
    const h = fixture(t); const before = h.db.serialize(); h.queries.length = 0;
    error(call(h, 'prepareExecutionQueue', body), 400, 'EXECUTION_QUEUE_INPUT_INVALID');
    assert.deepEqual(h.db.serialize(), before);
    assert.ok(!h.queries.some((q) => /FROM (?:ai_service_configs|redraw_execution_plan_reviews|redraw_execution_queue)/i.test(q)));
  });
}

test('unreviewed preview cannot register or silently create review', (t) => {
  const h = fixture(t); const before = h.db.serialize();
  error(post(h), 409, 'EXECUTION_PLAN_REVIEW_REQUIRED');
  assert.equal(count(h, reviews), 0); assert.equal(count(h), 0); assert.deepEqual(h.db.serialize(), before);
});

test('hash drift and stale saved review are separate explicit conflicts with zero writes', (t) => {
  const h = fixture(t); const review = save(h); accepted(post(h)); stamp(h); const before = h.db.serialize();
  error(post(h, review.plan_hash), 409, 'EXECUTION_PLAN_CONFLICT');
  error(post(h), 409, 'EXECUTION_PLAN_REVIEW_STALE');
  assert.deepEqual(h.db.serialize(), before); assert.equal(count(h), 1);
});

for (const [name, mutate] of [
  ['paused capability', (h) => h.db.prepare('UPDATE ai_service_configs SET canary_paused = 1 WHERE id = 41').run()],
  ['source evidence bytes drift', (h) => fs.appendFileSync(h.evidence.evidencePath, ' ')],
]) {
  test(`blocked ${name} prevents duplicate registration and exposes only stale queue`, (t) => {
    const h = fixture(t); const review = save(h); accepted(post(h)); mutate(h); const before = h.db.serialize();
    const data = accepted(get(h)); assert.equal(data.preview.status, 'blocked'); assert.equal(data.queue.status, 'stale');
    error(post(h, review.plan_hash), 409, 'EXECUTION_PLAN_BLOCKED'); assert.deepEqual(h.db.serialize(), before);
  });
}

for (const [name, mutate] of [
  ['missing unit', (h) => corrupt(h, units, `DELETE FROM ${units} WHERE ordinal=1`)],
  ['extra unit', (h) => rawUnit(h, h.db.prepare(`SELECT id FROM ${queues}`).get().id, current(h).units[0], { unit_id: 'extra', ordinal: 2 })],
  ['unit body mismatch', (h) => { const p = structuredClone(current(h).units[0]); p.dialogues[0].target_text = 'CORRUPT_PRIVATE_SENTINEL';
    corrupt(h, units, `UPDATE ${units} SET unit_json=? WHERE ordinal=0`, JSON.stringify(p)); }],
  ['resigned unit body mismatch', (h) => { const p = structuredClone(current(h).units[0]); p.dialogues[0].target_text = 'CORRUPT_PRIVATE_SENTINEL';
    corrupt(h, units, `UPDATE ${units} SET unit_json=?,unit_hash=? WHERE ordinal=0`, JSON.stringify(p), hashPlanValue(p)); }],
  ['unit id mismatch', (h) => corrupt(h, units, `UPDATE ${units} SET unit_id='wrong' WHERE ordinal=0`)],
  ['unit order mismatch', (h) => corrupt(h, units, `UPDATE ${units} SET ordinal=7 WHERE ordinal=0`)],
  ['unit hash mismatch', (h) => corrupt(h, units, `UPDATE ${units} SET unit_hash=? WHERE ordinal=0`, 'f'.repeat(64))],
  ['non-object unit JSON', (h) => corrupt(h, units, `UPDATE ${units} SET unit_json='null' WHERE ordinal=0`)],
  ['missing historical review', (h) => { h.db.pragma('foreign_keys=OFF'); corrupt(h, reviews, `DELETE FROM ${reviews}`); h.db.pragma('foreign_keys=ON'); }],
]) {
  test(`queue integrity rejects ${name} without exposing damaged units or repairing evidence`, (t) => {
    const h = multiFixture(t); const review = save(h); accepted(post(h)); mutate(h); const before = h.db.serialize();
    const data = accepted(get(h)); assert.equal(data.queue.status, 'invalid'); assert.deepEqual(data.queue.units, []);
    assert.equal(data.queue.executable, false); assert.ok(!JSON.stringify(data).includes('CORRUPT_PRIVATE_SENTINEL'));
    error(post(h, review.plan_hash), 409, 'EXECUTION_QUEUE_INVALID'); assert.deepEqual(h.db.serialize(), before);
  });
}

test('historical queue validates its own linked review when selected saved review has moved on', (t) => {
  const h = fixture(t); const a = save(h); accepted(post(h)); stamp(h); const b = save(h);
  const healthy = accepted(get(h)); assert.equal(healthy.saved_review.id, b.id); assert.equal(healthy.queue.status, 'stale');
  const damaged = structuredClone(a.plan); damaged.units[0].dialogues[0].target_text = 'CORRUPT_PRIVATE_SENTINEL';
  corrupt(h, reviews, `UPDATE ${reviews} SET plan_json=? WHERE id=?`, JSON.stringify(damaged), a.id);
  const before = h.db.serialize(); const data = accepted(get(h));
  assert.equal(data.saved_review.status, 'current'); assert.equal(data.queue.status, 'invalid');
  assert.deepEqual(data.queue.units, []); assert.ok(!JSON.stringify(data).includes('CORRUPT_PRIVATE_SENTINEL'));
  error(post(h), 409, 'EXECUTION_QUEUE_INVALID'); assert.deepEqual(h.db.serialize(), before);
});

for (const [name, mutate] of [
  ['wrong review id', (h, a, b) => corrupt(h, queues, `UPDATE ${queues} SET review_id=?`, b.id)],
  ['foreign review owner', (h, a) => corrupt(h, reviews, `UPDATE ${reviews} SET user_id='other' WHERE id=?`, a.id)],
  ['foreign review tenant', (h, a) => corrupt(h, reviews, `UPDATE ${reviews} SET tenant_id='other' WHERE id=?`, a.id)],
  ['wrong review work', (h, a) => { h.db.pragma('foreign_keys=OFF'); corrupt(h, reviews, `UPDATE ${reviews} SET work_id=999 WHERE id=?`, a.id); h.db.pragma('foreign_keys=ON'); }],
  ['wrong review version', (h, a) => { h.db.pragma('foreign_keys=OFF'); corrupt(h, reviews, `UPDATE ${reviews} SET version_id=999 WHERE id=?`, a.id); h.db.pragma('foreign_keys=ON'); }],
  ['wrong queue work', (h) => { h.db.pragma('foreign_keys=OFF'); corrupt(h, queues, `UPDATE ${queues} SET work_id=999`); h.db.pragma('foreign_keys=ON'); }],
]) {
  test(`queue rejects ${name} even when a different healthy review is current`, (t) => {
    const h = fixture(t); const a = save(h); accepted(post(h)); stamp(h); const b = save(h); mutate(h, a, b);
    const before = h.db.serialize(); const data = accepted(get(h));
    assert.equal(data.queue.status, 'invalid'); assert.deepEqual(data.queue.units, []);
    error(post(h), 409, 'EXECUTION_QUEUE_INVALID'); assert.deepEqual(h.db.serialize(), before);
  });
}

test('invalid selected review is rejected even without any registered queue', (t) => {
  const h = fixture(t); const review = save(h);
  corrupt(h, reviews, `UPDATE ${reviews} SET plan_json='null'`); const before = h.db.serialize();
  error(post(h, review.plan_hash), 409, 'EXECUTION_PLAN_REVIEW_INVALID');
  assert.equal(count(h), 0); assert.deepEqual(h.db.serialize(), before);
});

test('registered queue endpoints do not introduce task execution, update or delete routes', () => {
  const source = fs.readFileSync(require.resolve('../src/routes/index'), 'utf8');
  assert.match(source, /r\.get\('\/redraw\/versions\/:id\/execution-queue', redraw\.getExecutionQueue\)/);
  assert.match(source, /r\.post\('\/redraw\/versions\/:id\/execution-queue', redraw\.prepareExecutionQueue\)/);
  assert.doesNotMatch(source, /r\.(?:put|patch|delete)\('\/redraw\/versions\/:id\/execution-queue'/);
});

test('exact queue snapshot reuses current and historical validation with zero DML', (t) => {
  const h = fixture(t); save(h); const a = accepted(post(h));
  const snapshot = require('../src/services/redrawExecutionQueueService').getExecutionQueueSnapshot;
  assert.deepEqual(snapshot(h.ctx, 10, a.queue.id), a);
  stamp(h); save(h); const b = accepted(post(h));
  const before = h.db.serialize(); h.queries.length = 0; h.db.pragma('query_only = ON');
  const result = snapshot(h.ctx, 10, a.queue.id);
  assert.deepEqual(result, { preview: b.preview, saved_review: b.saved_review, queue: { ...a.queue, status: 'stale' } });
  assert.deepEqual(snapshot(h.ctx, 10, b.queue.id), b);
  assert.deepEqual(h.db.serialize(), before);
  assert.ok(!h.queries.some((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql))); noKeys(h.queries);
});

test('exact queue snapshot conceals missing and cross-owner or version identifiers', (t) => {
  const h = fixture(t); save(h); const a = accepted(post(h));
  const snapshot = require('../src/services/redrawExecutionQueueService').getExecutionQueueSnapshot;
  for (const id of [999, 0, -1, 1.5, 'not-an-id']) assert.throws(() => snapshot(h.ctx, 10, id), { code: 'EXECUTION_QUEUE_NOT_FOUND' });
  assert.throws(() => snapshot({ ...h.ctx, userId: 'other' }, 10, a.queue.id), { code: 'REDRAW_VERSION_NOT_FOUND' });
  h.db.prepare(`INSERT INTO redraw_versions (id,work_id,tenant_id,user_id,version,locale,market,status,created_at,updated_at)
    VALUES (11,1,'tenant-a','user-a',2,'en','US','needs_review',?,?)`).run(later, later);
  h.queries.length = 0;
  assert.throws(() => snapshot(h.ctx, 11, a.queue.id), { code: 'EXECUTION_QUEUE_NOT_FOUND' });
  assert.ok(!h.queries.some((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)));
});

test('exact historical queue snapshot returns invalid without hiding damaged immutable content', (t) => {
  const h = fixture(t); save(h); const a = accepted(post(h)); stamp(h); save(h); accepted(post(h));
  corrupt(h, units, `UPDATE ${units} SET unit_json='{}' WHERE queue_id=?`, a.queue.id);
  const before = h.db.serialize(); const snapshot = require('../src/services/redrawExecutionQueueService').getExecutionQueueSnapshot;
  const result = snapshot(h.ctx, 10, a.queue.id);
  assert.equal(result.queue.status, 'invalid'); assert.deepEqual(result.queue.units, []);
  assert.deepEqual(h.db.serialize(), before);
});
