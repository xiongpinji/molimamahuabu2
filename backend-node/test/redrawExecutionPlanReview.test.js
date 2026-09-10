'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./redrawExecutionPlanPreview.test');
const { previewVersionExecutionPlan } = require('../src/services/redrawExecutionPlanPreviewService');
const { hashPlanValue } = require('../src/services/redrawExecutionPlanService');

const table = 'redraw_execution_plan_reviews';
const owner = { tenantId: 'tenant-a', userId: 'user-a' };
const changedAt = '2026-09-05T15:00:00.000Z';
const current = (h) => previewVersionExecutionPlan(h.ctx, 10);
const count = (h) => h.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
function call(h, method, body, who, id = '10') {
  assert.equal(typeof h.handler[method], 'function', `${method} must be implemented`);
  const req = h.req(who); req.params.id = id; req.body = body;
  const res = h.res(); h.handler[method](req, res); return res;
}
const get = (h, who, id) => call(h, 'getExecutionPlanReview', undefined, who, id);
const post = (h, hash = current(h).plan_hash, who, id) => call(h, 'saveExecutionPlanReview', { expected_plan_hash: hash }, who, id);
function expectError(res, status, code) {
  assert.equal(res.statusCode, status, JSON.stringify(res.body));
  assert.equal(res.body.error.code, code);
}
function stamp(h, value) {
  h.localization.review.updated_at = value;
  h.db.prepare('UPDATE redraw_versions SET localization_review_json = ? WHERE id = 10')
    .run(JSON.stringify(h.localization));
}
function insert(h, plan, overrides = {}) {
  const row = { tenant_id: owner.tenantId, user_id: owner.userId, work_id: 1, version_id: 10,
    plan_hash: plan.plan_hash, plan_json: JSON.stringify(plan), created_at: changedAt, ...overrides };
  return h.db.prepare(`INSERT INTO ${table} (tenant_id, user_id, work_id, version_id, plan_hash, plan_json, created_at)
    VALUES (@tenant_id, @user_id, @work_id, @version_id, @plan_hash, @plan_json, @created_at)`).run(row);
}
function rehash(plan) { const { plan_hash, ...content } = plan; plan.plan_hash = hashPlanValue(content); return plan; }
function businessSnapshot(h) {
  const tables = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => name).filter((name) => name !== table);
  return tables.map((name) => [name, h.db.prepare(`SELECT * FROM "${name}"`).all()]);
}
function assertNoKeys(queries) {
  const configs = queries.filter((sql) => /FROM ai_service_configs/i.test(sql));
  assert.ok(configs.length > 0);
  assert.ok(configs.every((sql) => !/SELECT\s+\*|api_key|base_url|endpoint|(?:SELECT|,)\s*settings\s*(?:,|FROM)/i.test(sql)));
}

test('review migration reruns and enforces JSON, unique owner/version/hash and append-only rows', (t) => {
  const h = fixture(t);
  assert.ok(h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), 'review table must exist');
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/74_redraw_execution_plan_reviews.sql'), 'utf8');
  h.db.exec(sql); h.db.exec(sql);
  const plan = current(h); insert(h, plan);
  assert.throws(() => insert(h, plan), /UNIQUE/);
  assert.throws(() => insert(h, plan, { plan_hash: 'b'.repeat(64), plan_json: '{' }), /CHECK/);
  assert.throws(() => h.db.prepare(`UPDATE ${table} SET created_at = 'changed'`).run(), /immutable|append.only/i);
  assert.throws(() => h.db.prepare(`DELETE FROM ${table}`).run(), /immutable|append.only/i);
  assert.equal(count(h), 1);
  const indexes = h.db.prepare(`PRAGMA index_list(${table})`).all();
  assert.ok(indexes.some((item) => /latest/.test(item.name)));
  assert.deepEqual(h.db.prepare('PRAGMA index_info(idx_redraw_execution_plan_reviews_latest)').all()
    .map((item) => item.name), ['tenant_id', 'user_id', 'version_id', 'id']);
});

test('GET is a consistent pure read and POST appends the full server preview without self-staling or other writes', (t) => {
  const h = fixture(t); const initial = current(h); const before = h.db.serialize();
  h.queries.length = 0;
  const unsaved = get(h);
  assert.equal(unsaved.statusCode, 200); assert.deepEqual(unsaved.body.data, { preview: initial, saved_review: null });
  assert.deepEqual(h.db.serialize(), before);
  assert.ok(h.queries.some((sql) => /^BEGIN(?! IMMEDIATE)/i.test(sql)));
  assert.ok(!h.queries.some((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)));
  const business = businessSnapshot(h); h.queries.length = 0;
  const saved = post(h, initial.plan_hash);
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.data.preview, initial);
  const review = saved.body.data.saved_review;
  assert.equal(review.status, 'current'); assert.equal(review.plan_hash, initial.plan_hash);
  assert.ok(Number.isSafeInteger(review.id)); assert.ok(!Number.isNaN(Date.parse(review.saved_at)));
  assert.deepEqual(review.plan, initial); assert.equal(review.plan.executable, false);
  assert.deepEqual(review.plan.execution_blockers, initial.execution_blockers);
  assert.ok(h.queries.some((sql) => /^BEGIN IMMEDIATE/i.test(sql)));
  const writes = h.queries.filter((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql));
  assert.equal(writes.length, 1); assert.match(writes[0], /^INSERT INTO redraw_execution_plan_reviews/i);
  assertNoKeys(h.queries);
  assert.deepEqual(businessSnapshot(h), business);
  assert.deepEqual(current(h), initial);
  assert.deepEqual(get(h).body.data.saved_review, review);
});

for (const [name, who, mutate, id] of [
  ['foreign user', { ...owner, userId: 'other' }], ['foreign tenant', { ...owner, tenantId: 'other' }],
  ['missing user', { ...owner, userId: null }], ['missing tenant', { ...owner, tenantId: null }],
  ['deleted version', owner, (h) => h.db.prepare('UPDATE redraw_versions SET deleted_at = ?').run(changedAt)],
  ['deleted work', owner, (h) => h.db.prepare('UPDATE redraw_works SET deleted_at = ?').run(changedAt)],
  ['foreign work', owner, (h) => h.db.prepare("UPDATE redraw_works SET user_id = 'other'").run()],
  ['unknown version', owner, null, '999'], ['invalid version', owner, null, 'bad'],
]) {
  test(`GET and POST conceal ${name} before review/config access`, (t) => {
    const h = fixture(t); mutate?.(h); h.queries.length = 0; const before = h.db.serialize();
    expectError(get(h, who, id), 404, 'REDRAW_VERSION_NOT_FOUND');
    expectError(post(h, 'a'.repeat(64), who, id), 404, 'REDRAW_VERSION_NOT_FOUND');
    assert.deepEqual(h.db.serialize(), before);
    assert.ok(!h.queries.some((sql) => /FROM (?:redraw_execution_plan_reviews|ai_service_configs)/i.test(sql)));
  });
}

for (const body of [undefined, null, [], 'hash', {}, { expected_plan_hash: 1 },
  { expected_plan_hash: 'A'.repeat(64) }, { expected_plan_hash: 'a'.repeat(63) },
  { expected_plan_hash: ` ${'a'.repeat(64)}` },
  ...['plan', 'model', 'key', 'budget', 'other'].map((key) => ({ expected_plan_hash: 'a'.repeat(64), [key]: null }))]) {
  test(`POST strictly rejects invalid request ${JSON.stringify(body)}`, (t) => {
    const h = fixture(t); const before = h.db.serialize(); h.queries.length = 0;
    expectError(call(h, 'saveExecutionPlanReview', body), 400, 'EXECUTION_PLAN_REVIEW_INPUT_INVALID');
    assert.deepEqual(h.db.serialize(), before);
    assert.ok(!h.queries.some((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)));
  });
}

test('POST compares the expected hash with a fresh in-transaction preview, before duplicate reuse', (t) => {
  const h = fixture(t); const first = current(h); const saved = post(h, first.plan_hash);
  assert.equal(saved.statusCode, 200); stamp(h, changedAt); const before = h.db.serialize();
  h.queries.length = 0;
  expectError(post(h, first.plan_hash), 409, 'EXECUTION_PLAN_CONFLICT');
  assert.deepEqual(h.db.serialize(), before); assert.equal(count(h), 1);
  const start = h.queries.findIndex((sql) => /^BEGIN IMMEDIATE/i.test(sql));
  const previewRead = h.queries.findIndex((sql) => /FROM ai_service_configs/i.test(sql));
  assert.ok(start >= 0 && previewRead > start);
});

test('repeated saves preserve id/time; A -> B -> A reuses and prefers A instead of latest B', (t) => {
  const h = fixture(t); const a = current(h); const aSaved = post(h, a.plan_hash).body.data.saved_review;
  const before = h.db.serialize();
  assert.deepEqual(post(h, a.plan_hash).body.data.saved_review, aSaved);
  assert.deepEqual(h.db.serialize(), before);
  const originalStamp = h.localization.review.updated_at; stamp(h, changedAt);
  const b = current(h); assert.notEqual(b.plan_hash, a.plan_hash);
  assert.equal(get(h).body.data.saved_review.status, 'stale');
  const bSaved = post(h, b.plan_hash).body.data.saved_review; assert.notEqual(bSaved.id, aSaved.id);
  stamp(h, originalStamp);
  assert.deepEqual(current(h), a);
  assert.deepEqual(get(h).body.data.saved_review, aSaved);
  assert.deepEqual(post(h, a.plan_hash).body.data.saved_review, aSaved); assert.equal(count(h), 2);
});

for (const [name, mutate, blocked] of [
  ['localization timestamp', (h) => stamp(h, changedAt), false],
  ['version timestamp', (h) => h.db.prepare('UPDATE redraw_versions SET updated_at = ?').run(changedAt), false],
  ['source bytes', (h) => fs.appendFileSync(h.evidence.evidencePath, ' '), true],
  ['blueprint hash', (h) => h.db.prepare('UPDATE redraw_versions SET blueprint_hash = ?').run('f'.repeat(64)), true],
  ['localization hash', (h) => h.db.prepare('UPDATE redraw_versions SET localization_hash = ?').run('f'.repeat(64)), true],
  ['capability pause', (h) => h.db.prepare('UPDATE ai_service_configs SET canary_paused = 1 WHERE id = 41').run(), true],
]) {
  test(`saved snapshot is stale after ${name} drift; save fails without writes`, (t) => {
    const h = fixture(t); const a = current(h); const saved = post(h, a.plan_hash).body.data.saved_review;
    mutate(h); const before = h.db.serialize();
    const result = get(h).body.data;
    assert.equal(result.saved_review.status, 'stale'); assert.deepEqual(result.saved_review.plan, saved.plan);
    assert.equal(result.preview.status, blocked ? 'blocked' : 'ready');
    expectError(post(h, a.plan_hash), 409, blocked ? 'EXECUTION_PLAN_BLOCKED' : 'EXECUTION_PLAN_CONFLICT');
    assert.deepEqual(h.db.serialize(), before); assert.equal(count(h), 1);
  });
}

test('blocked first save inserts nothing and does not return a partial executable plan', (t) => {
  const h = fixture(t); const expected = current(h).plan_hash;
  h.db.prepare('UPDATE ai_service_configs SET canary_paused = 1 WHERE id = 41').run();
  const before = h.db.serialize();
  expectError(post(h, expected), 409, 'EXECUTION_PLAN_BLOCKED');
  assert.equal(count(h), 0); assert.deepEqual(h.db.serialize(), before);
  assert.equal(get(h).body.data.preview.executable, false);
});

for (const [name, mutate, resign = false] of [
  ['body tamper', (p) => { p.units[0].dialogues[0].target_text = 'CORRUPT_PRIVATE_SENTINEL'; }],
  ['foreign binding', (p) => { p.bindings.user_id = 'other'; }, true],
  ['foreign tenant binding', (p) => { p.bindings.tenant_id = 'other'; }, true],
  ['wrong work binding', (p) => { p.bindings.work_id = 999; }, true],
  ['wrong version binding', (p) => { p.bindings.version_id = 999; }, true],
  ['executable flag', (p) => { p.executable = true; }, true],
  ['schema mismatch', (p) => { p.schema_version = 'unknown'; }, true],
  ['missing units', (p) => { delete p.units; }, true],
  ['missing blockers', (p) => { p.execution_blockers = []; }, true],
  ['broken capability hash', (p) => { p.capability.model = 'tampered'; }, true],
]) {
  test(`GET marks ${name} invalid and never exposes the corrupt plan`, (t) => {
    const h = fixture(t); const p = structuredClone(current(h)); mutate(p); if (resign) rehash(p);
    insert(h, p); const before = h.db.serialize();
    const result = get(h).body.data;
    assert.equal(result.saved_review.status, 'invalid'); assert.equal(result.saved_review.plan, null);
    assert.ok(!JSON.stringify(result).includes('CORRUPT_PRIVATE_SENTINEL'));
    assert.deepEqual(h.db.serialize(), before);
  });
}

test('duplicate hash with corrupt content rejects POST without replacing immutable evidence', (t) => {
  const h = fixture(t); const plan = current(h); const damaged = structuredClone(plan);
  damaged.units[0].dialogues[0].target_text = 'CORRUPT_PRIVATE_SENTINEL'; insert(h, damaged);
  const before = h.db.serialize();
  expectError(post(h, plan.plan_hash), 409, 'EXECUTION_PLAN_REVIEW_INVALID');
  assert.deepEqual(h.db.serialize(), before); assert.equal(count(h), 1);
});

test('a corrupt latest snapshot cannot be hidden by saving a different fresh hash', (t) => {
  const h = fixture(t); const damaged = structuredClone(current(h));
  damaged.units[0].dialogues[0].target_text = 'CORRUPT_PRIVATE_SENTINEL'; insert(h, damaged);
  stamp(h, changedAt); const fresh = current(h); assert.notEqual(fresh.plan_hash, damaged.plan_hash);
  const before = h.db.serialize();
  expectError(post(h, fresh.plan_hash), 409, 'EXECUTION_PLAN_REVIEW_INVALID');
  assert.deepEqual(h.db.serialize(), before); assert.equal(count(h), 1);
});

test('valid JSON with a non-object plan is invalid and never echoed', (t) => {
  const h = fixture(t); const plan = current(h); insert(h, plan, { plan_json: 'null' });
  const result = get(h).body.data.saved_review;
  assert.equal(result.status, 'invalid'); assert.equal(result.plan, null);
  expectError(post(h, plan.plan_hash), 409, 'EXECUTION_PLAN_REVIEW_INVALID');
});

test('GET returns the latest saved snapshot when none matches fresh preview, with id tie-breaking', (t) => {
  const h = fixture(t); const a = current(h); insert(h, a);
  stamp(h, changedAt); const b = current(h); insert(h, b);
  stamp(h, '2026-09-05T16:00:00.000Z');
  const result = get(h).body.data.saved_review;
  assert.equal(result.status, 'stale'); assert.equal(result.plan_hash, b.plan_hash);
  assert.deepEqual(result.plan, b);
});

test('clock rollback cannot outrank the latest append, while a matching fresh hash still wins', (t) => {
  const h = fixture(t); const originalStamp = h.localization.review.updated_at;
  const a = current(h); const aSaved = post(h, a.plan_hash).body.data.saved_review;
  stamp(h, changedAt); const b = current(h);
  const bSaved = insert(h, b, { created_at: '2000-01-01T00:00:00.000Z' });
  assert.ok(Number(bSaved.lastInsertRowid) > aSaved.id);
  stamp(h, '2026-09-05T16:00:00.000Z'); const before = h.db.serialize();
  const historical = get(h).body.data.saved_review;
  assert.equal(historical.status, 'stale'); assert.equal(historical.plan_hash, b.plan_hash);
  assert.equal(historical.id, Number(bSaved.lastInsertRowid));
  assert.deepEqual(h.db.serialize(), before);
  stamp(h, originalStamp);
  assert.deepEqual(get(h).body.data.saved_review, aSaved);
});

test('owner-qualified lookup never selects snapshots belonging to a different user or tenant', (t) => {
  const h = fixture(t); const plan = current(h);
  insert(h, plan, { user_id: 'other' }); insert(h, plan, { tenant_id: 'other' });
  assert.equal(get(h).body.data.saved_review, null);
  assert.equal(post(h, plan.plan_hash).body.data.saved_review.status, 'current');
  assert.equal(count(h), 3);
});

test('HTTP review endpoints are separate from the existing GET-only plan preview', () => {
  const source = fs.readFileSync(require.resolve('../src/routes/index'), 'utf8');
  assert.match(source, /r\.get\('\/redraw\/versions\/:id\/execution-plan\/review', redraw\.getExecutionPlanReview\)/);
  assert.match(source, /r\.post\('\/redraw\/versions\/:id\/execution-plan\/review', redraw\.saveExecutionPlanReview\)/);
  assert.doesNotMatch(source, /r\.(?:post|put|patch)\('\/redraw\/versions\/:id\/execution-plan'/);
});
