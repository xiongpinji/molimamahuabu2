'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, hash } = require('./helpers/redrawUnitReferenceDerivationFixture');
const routes = require('../src/routes/redraw');
const service = require('../src/services/redrawUnitReferenceDerivationService');
const changes = db => db.prepare('SELECT total_changes() n').get().n;
function setup(h) {
  h.handler = routes(h.db, { error() {} }, { cfg: { storage: { local_path: h.root } }, canReadArtifact: h.ctx.canReadArtifact });
  return h;
}
async function call(h, method, { params, input, owner, rawQuery } = {}) {
  assert.equal(typeof h.handler[method], 'function', `${method} must expose actual unit materials service`);
  const e = h.expected(1), post = method === 'prepareUnitReferenceMaterials';
  const fields = input === undefined ? { review_id: post ? e.review_id : String(e.review_id), plan_hash: e.plan_hash, unit_hash: e.unit_hash } : input;
  const req = { params: { id: String(e.version_id), queueId: String(e.queue_id), unitId: e.unit_id, ...params },
    tenant: { id: owner?.tenantId || 'tenant-a' }, user: { id: owner?.userId || 'user-a' },
    [post ? 'body' : 'query']: fields,
    originalUrl: '/redraw/test' + (rawQuery === undefined ? '' : `?${rawQuery}`) };
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  await h.handler[method](req, res); return res;
}
const get = (h, options) => call(h, 'getUnitReferenceMaterials', options);
const post = (h, expectedHash, options = {}) => call(h, 'prepareUnitReferenceMaterials', { ...options,
  input: { review_id: h.expected(1).review_id, plan_hash: h.expected(1).plan_hash, unit_hash: h.expected(1).unit_hash,
    expected_materials_hash: expectedHash, ...options.input } });
function accepted(res) { assert.equal(res.statusCode, 200, JSON.stringify(res.body)); return res.body.data; }
function rejected(res, status) {
  assert.equal(res.statusCode, status, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body.error).sort(), ['code', 'message']);
  assert.ok(!/PRIVATE|storage|ffmpeg|\.mp4|api_key|settings|[A-Z]:\\/.test(JSON.stringify(res.body.error)));
}

test('actual GET is read-only; explicit POST prepares real media and GET recovers the identical prepared DTO', async t => {
  const h = setup(await fixture(t)), before = changes(h.db);
  h.db.pragma('query_only = ON');
  const initial = accepted(await get(h));
  assert.equal(initial.status, 'needs_preparation'); assert.equal(changes(h.db), before);
  assert.equal(fs.existsSync(path.join(h.root, 'redraw-unit-reference')), false);
  h.db.pragma('query_only = OFF');
  const prepared = accepted(await post(h, initial.materials_hash));
  assert.equal(prepared.schema_version, 'redraw-unit-prepared-reference-materials-v1');
  assert.equal(prepared.materials_hash, initial.materials_hash);
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_unit_reference_derivations').get().n, 1);
  for (const ref of prepared.references) {
    const row = h.db.prepare('SELECT local_path FROM assets WHERE id=?').get(ref.asset_id);
    const bytes = fs.readFileSync(path.join(h.root, row.local_path)); assert.equal(hash(bytes), ref.sha256);
    const prefix = process.env.G4_MATERIALS_ENTRY_EVIDENCE_PREFIX;
    if (prefix) fs.writeFileSync(`${prefix}-${ref.requirement_id}.mp4`, bytes, { flag: 'wx' });
  }
  const after = changes(h.db); h.db.pragma('query_only = ON');
  const checked = accepted(await get(h)); assert.equal(checked.status, 'prepared');
  assert.deepEqual(checked.prepared_materials, prepared);
  assert.deepEqual(accepted(await get(h)), checked); assert.equal(changes(h.db), after);
  assert.deepEqual(checked, await service.inspectPreparedUnitReferenceMaterials(h.ctx, h.expected(1)));
});

test('handler rejects unowned or deleted version/work/queue and old bindings without writes', async t => {
  const h = setup(await fixture(t)); const e = h.expected(1), before = changes(h.db);
  for (const method of ['getUnitReferenceMaterials', 'prepareUnitReferenceMaterials']) {
    const base = { review_id: method.startsWith('get') ? String(e.review_id) : e.review_id,
      plan_hash: e.plan_hash, unit_hash: e.unit_hash, ...(method.startsWith('get') ? {} : { expected_materials_hash: 'a'.repeat(64) }) };
    for (const options of [{ owner: { userId: 'other' } }, { owner: { tenantId: 'other' } },
      { params: { id: '999' } }, { params: { queueId: '999' } }, { params: { unitId: 'missing-unit' } }]) {
      rejected(await call(h, method, { input: base, ...options }), 404);
    }
    for (const input of [{ ...base, plan_hash: 'f'.repeat(64) }, { ...base, unit_hash: 'f'.repeat(64) },
      { ...base, review_id: method.startsWith('get') ? '999' : 999 }]) rejected(await call(h, method, { input }), 409);
    for (const table of ['redraw_versions', 'redraw_works']) {
      h.db.exec('SAVEPOINT hidden'); h.db.prepare(`UPDATE ${table} SET deleted_at='gone'`).run();
      rejected(await call(h, method, { input: base }), 404); h.db.exec('ROLLBACK TO hidden; RELEASE hidden');
    }
  }
  // Only the explicit visibility mutations above changed SQLite's monotonic counter.
  assert.equal(changes(h.db) - before, 4);
});

test('handler exact query/body contract rejects duplicate, unknown and malformed values before service work', async t => {
  const h = setup(await fixture(t)), e = h.expected(1), before = changes(h.db);
  for (const method of ['getUnitReferenceMaterials', 'prepareUnitReferenceMaterials']) {
    const postMethod = method.startsWith('prepare');
    const base = { review_id: postMethod ? e.review_id : String(e.review_id), plan_hash: e.plan_hash, unit_hash: e.unit_hash,
      ...(postMethod ? { expected_materials_hash: 'a'.repeat(64) } : {}) };
    for (const extra of [{ path: h.root }, { model: 'client' }, { unit: {} }, { prepared_materials: {} }])
      rejected(await call(h, method, { input: { ...base, ...extra } }), 400);
    for (const [key, value] of [['review_id', [base.review_id]], ['review_id', postMethod ? '1' : 1],
      ['review_id', postMethod ? 1.1 : '1.1'], ['plan_hash', [e.plan_hash]], ['unit_hash', {}]])
      rejected(await call(h, method, { input: { ...base, [key]: value } }), 400);
    for (const params of [{ id: '1e1' }, { queueId: '1.2' }, { unitId: ['bad'] }])
      rejected(await call(h, method, { input: base, params }), 400);
  }
  rejected(await get(h, { rawQuery: `review_id=${e.review_id}&review_id=${e.review_id}&plan_hash=${e.plan_hash}&unit_hash=${e.unit_hash}` }), 400);
  assert.equal(changes(h.db), before);
});

test('stale material hash and actual damaged output reject safely; unexpected database failure is sanitized', async t => {
  const h = setup(await fixture(t)); const initial = accepted(await get(h)), before = changes(h.db);
  rejected(await post(h, 'f'.repeat(64)), 409); assert.equal(changes(h.db), before);
  const prepared = accepted(await post(h, initial.materials_hash));
  const row = h.db.prepare('SELECT local_path FROM assets WHERE id=?').get(prepared.references[0].asset_id);
  fs.unlinkSync(path.join(h.root, row.local_path)); rejected(await get(h), 409);
  const broken = { ...h, handler: routes({ prepare() { throw new Error('PRIVATE database path C:\\storage\\key'); } },
    { error() {} }, { cfg: { storage: { local_path: h.root } }, canReadArtifact: h.ctx.canReadArtifact }) };
  const result = await get(broken); rejected(result, 500); assert.equal(result.body.error.code, 'INTERNAL_ERROR');
});

test('router registers both methods at the ordinary-user unit materials path', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/index.js'), 'utf8');
  const route = '/redraw/versions/:id/execution-queues/:queueId/units/:unitId/reference-materials';
  assert.ok(source.includes(`r.get('${route}', redraw.getUnitReferenceMaterials)`));
  assert.ok(source.includes(`r.post('${route}', redraw.prepareUnitReferenceMaterials)`));
});

test('stale stored processing approval is a safe conflict, while media execution failures are internal', async t => {
  const h = setup(await fixture(t)), assetId = h.processed[0].imported.asset.id;
  h.db.exec('SAVEPOINT stale_processing');
  h.db.prepare("UPDATE assets SET metadata=json_set(metadata, '$.redraw_motion_processing.verified.material_binding_sha256', ?) WHERE id=?")
    .run('f'.repeat(64), assetId);
  try {
    await assert.rejects(service.inspectPreparedUnitReferenceMaterials(h.ctx, h.expected(1)), { code: 'REDRAW_MOTION_PROCESSING_CONFLICT' });
    rejected(await get(h), 409);
  } finally { h.db.exec('ROLLBACK TO stale_processing; RELEASE stale_processing'); }
  // Only failure injection: successful paths above always execute actual services/media.
  const original = service.inspectPreparedUnitReferenceMaterials;
  try {
    for (const code of ['REDRAW_UNIT_REFERENCE_DERIVATION_MEDIA_FAILED', 'REDRAW_UNIT_REFERENCE_DERIVATION_CLEANUP_FAILED', 'EACCES']) {
      service.inspectPreparedUnitReferenceMaterials = async () => { throw Object.assign(new Error('PRIVATE ffmpeg C:\\storage\\secret'), { code }); };
      const result = await get(h); rejected(result, 500); assert.equal(result.body.error.code, 'INTERNAL_ERROR');
    }
  } finally { service.inspectPreparedUnitReferenceMaterials = original; }
});

test('source-only operational filesystem failures are sanitized 500 with no material writes', async t => {
  const h = setup(await fixture(t)), source = path.resolve(h.root, 'source/source.mp4'), original = fs.promises.open;
  for (const code of ['EACCES', 'EIO']) await t.test(code, async () => {
    const before = changes(h.db); let injected = 0;
    fs.promises.open = async function(file, ...args) {
      if (path.resolve(String(file)) === source) {
        injected++; throw Object.assign(new Error('PRIVATE source path and filesystem detail'), { code });
      }
      return original.call(this, file, ...args);
    };
    try { rejected(await get(h), 500); }
    finally { fs.promises.open = original; }
    assert.equal(injected, 1); assert.equal(changes(h.db), before);
    assert.equal(fs.existsSync(path.join(h.root, 'redraw-unit-reference')), false);
  });
});
