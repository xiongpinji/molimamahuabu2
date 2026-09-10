'use strict';

// Query-contract tests only: every project/work/version/export below is synthetic.
// A synthetic completed row proves no composition, media download or human review.
// Run only through the root-reviewed isolated runner; no production/config/media fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { setupRouter } = require('../src/routes');
const userAuth = require('../src/services/userAuthService');
const tenantService = require('../src/services/tenantService');

const NOW = '2026-09-09T00:00:00.000Z';
const SCHEMA = 'redraw-execution-unit-composition-v1';
const RELEASE_SCHEMA = 'redraw-execution-unit-release-v1';
const JWT_SECRET = 'synthetic-export-identity-jwt-at-least-32-bytes';
const PROVIDER_SECRET = 'synthetic-export-identity-provider-secret-never-used';
const PLAN_HASH = 'ab'.repeat(32);
const log = { info() {}, warn() {}, error() {} };

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

// The stored request is flat. Deliberately retain unexpected keys when hashing
// negative fixtures so a shape error is not merely an accidental hash mismatch.
function requestHash(request) {
  return sha256(JSON.stringify(Object.fromEntries(Object.keys(request).sort().map(key => [key, request[key]]))));
}

function manifestFor(versionId, key = 'synthetic-original-export-identity-key', changes = {}) {
  const request = { schema_version: RELEASE_SCHEMA, version_id: versionId, run_id: 41,
    expected_plan_hash: PLAN_HASH, expected_run_revision: 3, ...changes };
  return { schema_version: SCHEMA, idempotency_key: key, request_hash: requestHash(request), request };
}

function registerActor(db) {
  const user = userAuth.register(db, { email: `${crypto.randomUUID()}@example.test`, password: 'synthetic-identity-password-123' });
  const tenant = tenantService.ensurePersonalTenant(db, user);
  return { user, tenantId: tenant.id, token: userAuth.issueToken(user, JWT_SECRET, 0) };
}

function seedVersion(db, scope, version = 1) {
  return Number(db.prepare(`INSERT INTO redraw_versions
    (work_id,tenant_id,user_id,version,locale,market,localization_level,status,created_at,updated_at)
    VALUES (?,?,?,?,'en-US','US','faithful','draft',?,?)`)
    .run(scope.workId, scope.actor.tenantId, scope.actor.user.id, version, NOW, NOW).lastInsertRowid);
}

function seedScope(db, actor) {
  const projectId = Number(db.prepare(`INSERT INTO redraw_projects
    (tenant_id,user_id,title,default_locale,default_market,localization_level,status,created_at,updated_at)
    VALUES (?,?,'synthetic identity query project','en-US','US','faithful','draft',?,?)`)
    .run(actor.tenantId, actor.user.id, NOW, NOW).lastInsertRowid);
  const workId = Number(db.prepare(`INSERT INTO redraw_works
    (project_id,tenant_id,user_id,title,source_asset_id,source_fingerprint,duration_ms,current_version,current_step,status,created_at,updated_at)
    VALUES (?,?,?,'synthetic identity query work',101,?,15000,1,4,'draft',?,?)`)
    .run(projectId, actor.tenantId, actor.user.id, sha256(`synthetic-source-${projectId}`), NOW, NOW).lastInsertRowid);
  const scope = { actor, projectId, workId };
  scope.versionId = seedVersion(db, scope);
  return scope;
}

function seedExport(h, manifest, { scope = h.scope, status = 'pending', exportType = 'video' } = {}) {
  const versionNumber = h.db.prepare('SELECT COALESCE(MAX(version_number),0)+1 n FROM redraw_exports WHERE version_id=?')
    .get(scope.versionId).n;
  return Number(h.db.prepare(`INSERT INTO redraw_exports
    (version_id,tenant_id,user_id,export_type,version_number,manifest_json,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(scope.versionId, scope.actor.tenantId, scope.actor.user.id, exportType, versionNumber, JSON.stringify(manifest), status, NOW, NOW)
    .lastInsertRowid);
}

function snapshot(h) {
  return { bytes: h.db.serialize(), changes: h.db.prepare('SELECT total_changes() n').get().n,
    assets: h.db.prepare('SELECT count(*) n FROM assets').get().n, calls: { ...h.calls } };
}

function safeBody(body) {
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /"(?:idempotency_key|manifest_json|request|local_path|absolute_path|api_key)"\s*:/);
  for (const secret of [JWT_SECRET, PROVIDER_SECRET]) assert.equal(serialized.includes(secret), false);
}

async function queryFixture(t) {
  const previous = Object.fromEntries(['PUBLIC_PLATFORM_MODE', 'PLATFORM_JWT_SECRET', 'PLATFORM_JWT_TTL']
    .map(key => [key, process.env[key]]));
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
  process.env.PLATFORM_JWT_TTL = '1h';
  const db = new Database(':memory:');
  let server;
  t.after(async () => {
    try {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    } finally {
      db.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  runMigrationsAndEnsure(db);
  const actor = registerActor(db), otherActor = registerActor(db);
  const h = { db, actor, otherActor, scope: seedScope(db, actor),
    calls: { create: 0, run: 0, scheduler: 0, localization: 0, assetGeneration: 0, dialogue: 0 } };
  // These unused side-effect boundaries fail closed; authentication and the
  // final GET handlers are real. No media producer is needed to read a DTO.
  const forbidden = name => () => { h.calls[name] += 1; throw new Error(`unexpected ${name} during identity GET`); };
  const app = express();
  app.use(express.json());
  app.use('/api/v1', setupRouter({ storage: {
    local_path: path.join(os.tmpdir(), `redraw-identity-query-not-created-${crypto.randomUUID()}`),
    base_url: 'http://127.0.0.1:1/synthetic-unused-storage',
  } }, db, log, {
    providerAssetSecret: PROVIDER_SECRET,
    localizationProvider: forbidden('localization'), assetGenerationProvider: forbidden('assetGeneration'), dialogueProvider: forbidden('dialogue'),
    redrawOptions: { executionRunEnv: {}, compositionService: { createComposition: forbidden('create'), runComposition: forbidden('run') },
      compositionSchedule: forbidden('scheduler') },
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  h.get = async (endpoint, { actor: reader = actor, status = 200, headers = {} } = {}) => {
    const before = snapshot(h);
    try {
      const response = await fetch(origin + endpoint, { method: 'GET', headers: {
        Authorization: `Bearer ${reader.token}`, 'X-Tenant-Id': reader.tenantId, ...headers,
      }, signal: AbortSignal.timeout(10000) });
      const body = await response.json();
      safeBody(body);
      assert.equal(response.status, status, `${endpoint}: ${JSON.stringify(body)}`);
      assert.match(response.headers.get('content-type'), /^application\/json\b/);
      assert.equal(response.headers.get('content-disposition'), null);
      assert.equal(response.headers.get('x-content-sha256'), null);
      return body;
    } finally {
      assert.deepEqual(snapshot(h), before, 'each GET preserves database bytes, DML, assets and call counters');
      assert.deepEqual(h.calls, { create: 0, run: 0, scheduler: 0, localization: 0, assetGeneration: 0, dialogue: 0 });
    }
  };
  return h;
}

async function readIdentity(h, exportId, expected, scope = h.scope) {
  const detail = await h.get(`/api/v1/redraw/exports/${exportId}`, { actor: scope.actor });
  const list = await h.get(`/api/v1/redraw/versions/${scope.versionId}/exports`, { actor: scope.actor });
  assert.equal(detail.success, true);
  assert.equal(list.success, true);
  assert.ok(Array.isArray(list.data));
  const matches = list.data.filter(row => row.id === exportId);
  assert.equal(matches.length, 1, 'match the requested export id, not the latest/first row');
  assert.deepEqual(matches[0], detail.data, 'list and detail expose the same stored identity');
  const stored = JSON.parse(h.db.prepare('SELECT manifest_json FROM redraw_exports WHERE id=?').get(exportId).manifest_json);
  if (typeof stored.idempotency_key === 'string') {
    assert.equal(JSON.stringify(detail.data).includes(JSON.stringify(stored.idempotency_key)), false, 'the original key is not a public string value');
  }
  assert.equal(detail.data.idempotency_key_sha256, expected);
  if (expected !== null) assert.match(detail.data.idempotency_key_sha256, /^[a-f0-9]{64}$/);
  return detail.data;
}

test('unit export identity GET contract with synthetic rows and real JWT/SQLite/router', async t => {
  const h = await queryFixture(t);
  const keyA = 'synthetic-unknown-submit-original-key-A', keyB = 'synthetic-unknown-submit-original-key-B';
  const manifestA = manifestFor(h.scope.versionId, keyA), manifestB = manifestFor(h.scope.versionId, keyB);
  const exportA = seedExport(h, manifestA), exportB = seedExport(h, manifestB);

  await t.test('same release request with distinct original keys has one request hash and distinct fingerprints', async () => {
    const a = await readIdentity(h, exportA, sha256(keyA)), b = await readIdentity(h, exportB, sha256(keyB));
    const canonical = JSON.stringify({ expected_plan_hash: PLAN_HASH, expected_run_revision: 3,
      run_id: 41, schema_version: RELEASE_SCHEMA, version_id: h.scope.versionId });
    assert.equal(a.request_hash, sha256(canonical));
    assert.equal(b.request_hash, a.request_hash);
    assert.notEqual(a.idempotency_key_sha256, b.idempotency_key_sha256);
    assert.notEqual(a.request_hash, requestHash({ ...manifestA.request, idempotency_key: keyA }));
    for (const key of [keyA, keyB]) assert.equal(JSON.stringify([a, b]).includes(key), false);
  });

  for (const status of ['pending', 'processing', 'failed', 'needs_attention', 'completed']) {
    await t.test(`the same synthetic export keeps identity across ${status} list/detail reads`, async () => {
      assert.equal(h.db.prepare('UPDATE redraw_exports SET status=? WHERE id=?').run(status, exportA).changes, 1);
      const row = await readIdentity(h, exportA, sha256(keyA));
      assert.equal(row.status, status);
      assert.equal(row.request_hash, manifestA.request_hash);
      assert.equal(Object.hasOwn(row, 'downloads'), false, 'a seeded completed identity is not validated media');
      assert.equal(Object.hasOwn(row, 'quality_summary'), false, 'no synthetic row claims a human media verdict');
    });
  }

  for (const [name, key] of [['one character', 'x'], ['200 characters', 'x'.repeat(200)],
    ['paired surrogate at 200 UTF-16 code units', '😀'.repeat(100)], ['Unicode', '原始提交-转绘-😀'],
    ['internal spaces', 'synthetic key with internal spaces'], ['composed Unicode', 'é'], ['decomposed Unicode', 'e\u0301']]) {
    await t.test(`valid original key preserves exact UTF-8 bytes: ${name}`, async () => {
      assert.equal(Buffer.from(key, 'utf8').toString('utf8'), key);
      const manifest = manifestFor(h.scope.versionId, key);
      await readIdentity(h, seedExport(h, manifest), sha256(key));
    });
  }

  for (const [name, changes] of [['minimum run/revision', { run_id: 1, expected_run_revision: 0 }],
    ['maximum safe run/revision', { run_id: Number.MAX_SAFE_INTEGER, expected_run_revision: Number.MAX_SAFE_INTEGER }]]) {
    await t.test(`valid stored integer boundary: ${name}`, async () => {
      const manifest = manifestFor(h.scope.versionId, keyA, changes);
      const row = await readIdentity(h, seedExport(h, manifest), sha256(keyA));
      assert.equal(row.request_hash, manifest.request_hash);
    });
  }

  await t.test('request key insertion order does not change the canonical request hash', async () => {
    const manifest = manifestFor(h.scope.versionId, keyA);
    manifest.request = Object.fromEntries(Object.entries(manifest.request).reverse());
    const row = await readIdentity(h, seedExport(h, manifest), sha256(keyA));
    assert.equal(row.request_hash, manifestA.request_hash);
  });

  const invalidKeys = [['missing', undefined], ['null', null], ['empty', ''], ['201 characters', 'x'.repeat(201)],
    ['number', 123], ['boolean', true], ['array', ['synthetic-key']], ['object', { value: 'synthetic-key' }],
    ['leading space', ' key'], ['trailing space', 'key '], ['leading nonbreaking space', '\u00a0key'],
    ['trailing nonbreaking space', 'key\u00a0'], ['unpaired high surrogate', 'key-\ud800'],
    ['unpaired low surrogate', 'key-\udc00'], ['paired plus unpaired surrogate', '😀-key-\ud800']];
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    invalidKeys.push([`embedded control U+${code.toString(16).padStart(4, '0')}`, `key-${String.fromCharCode(code)}-inside`]);
  }
  for (const [name, key] of invalidKeys) {
    await t.test(`invalid stored key has explicit null fingerprint: ${name}`, async () => {
      const manifest = manifestFor(h.scope.versionId);
      if (key === undefined) delete manifest.idempotency_key; else manifest.idempotency_key = key;
      await readIdentity(h, seedExport(h, manifest), null);
    });
  }

  for (const schema of [undefined, null, 1, RELEASE_SCHEMA, 'redraw-execution-unit-composition-v2']) {
    await t.test(`invalid outer unit schema has null fingerprint: ${String(schema)}`, async () => {
      const manifest = manifestFor(h.scope.versionId);
      if (schema === undefined) delete manifest.schema_version; else manifest.schema_version = schema;
      await readIdentity(h, seedExport(h, manifest), null);
    });
  }
  await t.test('unit marker on a non-video export does not qualify for an identity fingerprint', async () => {
    await readIdentity(h, seedExport(h, manifestFor(h.scope.versionId), { exportType: 'subtitle_srt' }), null);
  });

  const invalidRequests = [
    ['missing request', manifest => { delete manifest.request; }],
    ...[null, 'request', 1, true, []].map(value => [`non-object request ${JSON.stringify(value)}`, manifest => { manifest.request = value; }]),
    ...['schema_version', 'version_id', 'run_id', 'expected_plan_hash', 'expected_run_revision']
      .map(key => [`missing ${key}`, manifest => { delete manifest.request[key]; }]),
    ...['idempotency_key', 'owner', 'audio_mode', 'local_path'].map(key => [`extra ${key}`, manifest => { manifest.request[key] = 'synthetic-extra'; }]),
    ...[SCHEMA, 'redraw-execution-unit-release-v2', null, 1, ['redraw-execution-unit-release-v1']]
      .map(value => [`wrong release schema ${JSON.stringify(value)}`, manifest => { manifest.request.schema_version = value; }]),
  ];
  for (const field of ['version_id', 'run_id', 'expected_run_revision']) {
    const invalidValues = ['1', ' 1 ', null, true, [], {}, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];
    if (field !== 'expected_run_revision') invalidValues.push(0);
    for (const value of invalidValues) {
      invalidRequests.push([`${field} invalid raw ${JSON.stringify(value)}`, manifest => { manifest.request[field] = value; }]);
    }
  }
  invalidRequests.push(['request version differs from owner-scoped export row', manifest => { manifest.request.version_id = h.scope.versionId + 100; }]);
  for (const value of [PLAN_HASH.toUpperCase(), ` ${PLAN_HASH}`, `${PLAN_HASH} `, `${PLAN_HASH}\n`, 'a'.repeat(63), 'a'.repeat(65),
    'g'.repeat(64), `${'a'.repeat(63)}\n`, 12, null, true, [PLAN_HASH], { hash: PLAN_HASH }]) {
    invalidRequests.push([`expected_plan_hash invalid raw ${JSON.stringify(value)}`, manifest => { manifest.request.expected_plan_hash = value; }]);
  }
  for (const [name, mutate] of invalidRequests) {
    await t.test(`invalid stored release request has null fingerprint: ${name}`, async () => {
      const manifest = manifestFor(h.scope.versionId);
      mutate(manifest);
      if (manifest.request && typeof manifest.request === 'object' && !Array.isArray(manifest.request)) {
        manifest.request_hash = requestHash(manifest.request);
      }
      await readIdentity(h, seedExport(h, manifest), null);
    });
  }

  for (const [name, change] of [['missing', () => undefined], ['null', () => null], ['wrong digest', () => 'c'.repeat(64)],
    ['uppercase', manifest => manifest.request_hash.toUpperCase()], ['leading space', manifest => ` ${manifest.request_hash}`],
    ['trailing space', manifest => `${manifest.request_hash} `], ['64 hex plus trailing LF', manifest => `${manifest.request_hash}\n`],
    ['number', () => 123], ['array', manifest => [manifest.request_hash]],
    ['includes idempotency key', manifest => requestHash({ ...manifest.request, idempotency_key: manifest.idempotency_key })],
    ['unsorted request bytes', manifest => sha256(JSON.stringify(manifest.request))]]) {
    await t.test(`invalid stored request hash has null fingerprint: ${name}`, async () => {
      const manifest = manifestFor(h.scope.versionId);
      const digest = change(manifest);
      if (digest === undefined) delete manifest.request_hash; else manifest.request_hash = digest;
      await readIdentity(h, seedExport(h, manifest), null);
    });
  }

  await t.test('same key with a different run, revision or plan remains distinct through request_hash', async () => {
    const identities = [];
    for (const changes of [{}, { run_id: 42 }, { expected_run_revision: 4 }, { expected_plan_hash: 'cd'.repeat(32) }]) {
      const manifest = manifestFor(h.scope.versionId, keyA, changes);
      const row = await readIdentity(h, seedExport(h, manifest), sha256(keyA));
      assert.equal(row.request_hash, manifest.request_hash);
      identities.push(row.request_hash);
    }
    assert.equal(new Set(identities).size, 4);
  });

  await t.test('duplicate stored identities remain two distinct exports in GET results', async () => {
    // DTO prerequisite only; this does not exercise the later UI unknown-state decision.
    const key = 'synthetic-ambiguous-duplicate-original-key';
    const manifest = manifestFor(h.scope.versionId, key);
    const ids = [seedExport(h, manifest), seedExport(h, manifest)];
    assert.notEqual(ids[0], ids[1]);
    for (const id of ids) {
      const row = await readIdentity(h, id, sha256(key));
      assert.equal(row.request_hash, manifest.request_hash);
    }
    const list = await h.get(`/api/v1/redraw/versions/${h.scope.versionId}/exports`);
    const matches = list.data.filter(row => row.idempotency_key_sha256 === sha256(key) && row.request_hash === manifest.request_hash);
    assert.equal(matches.length, 2, 'the DTO must not silently deduplicate to a first/latest export');
    assert.deepEqual(matches.map(row => row.id).sort((a, b) => a - b), ids);
  });

  await t.test('same key across version, user and tenant has the same fingerprint without granting cross-scope access', async () => {
    const secondVersion = { ...h.scope, versionId: seedVersion(h.db, h.scope, 2) };
    for (const [userId, tenantId] of [[h.actor.user.id, h.otherActor.tenantId], [h.otherActor.user.id, h.actor.tenantId]]) {
      h.db.prepare(`INSERT INTO tenant_members (tenant_id,user_id,role,status,created_at,updated_at)
        VALUES (?,?,'member','active',?,?)`).run(tenantId, userId, NOW, NOW);
    }
    const sameUserOtherTenant = seedScope(h.db, { ...h.actor, tenantId: h.otherActor.tenantId });
    const otherUserSameTenant = seedScope(h.db, { ...h.otherActor, tenantId: h.actor.tenantId });
    const scopes = [h.scope, secondVersion, sameUserOtherTenant, otherUserSameTenant];
    const saved = [];
    for (const scope of scopes) {
      const manifest = manifestFor(scope.versionId, keyA);
      const id = seedExport(h, manifest, { scope });
      const row = await readIdentity(h, id, sha256(keyA), scope);
      assert.equal(row.request_hash, manifest.request_hash);
      saved.push({ id, row, scope });
    }
    assert.equal(new Set(saved.map(item => item.row.request_hash)).size, scopes.length);
    for (const item of saved) {
      const crossScope = item.scope.actor.user.id === h.actor.user.id && item.scope.actor.tenantId === h.actor.tenantId
        ? sameUserOtherTenant.actor : h.actor;
      await h.get(`/api/v1/redraw/exports/${item.id}`, { actor: crossScope, status: 404 });
      await h.get(`/api/v1/redraw/versions/${item.scope.versionId}/exports`, { actor: crossScope, status: 404 });
    }
    const ownList = await h.get(`/api/v1/redraw/versions/${h.scope.versionId}/exports`);
    for (const item of saved.slice(1)) assert.equal(ownList.data.some(row => row.id === item.id), false);
  });

  const member = h.db.prepare('SELECT * FROM tenant_members WHERE tenant_id=? AND user_id=?').get(h.actor.tenantId, h.actor.user.id);
  const accessCases = [
    ['disabled member', 404,
      () => h.db.prepare("UPDATE tenant_members SET status='disabled' WHERE tenant_id=? AND user_id=?").run(h.actor.tenantId, h.actor.user.id),
      () => h.db.prepare("UPDATE tenant_members SET status='active' WHERE tenant_id=? AND user_id=?").run(h.actor.tenantId, h.actor.user.id)],
    ['missing member', 404,
      () => h.db.prepare('DELETE FROM tenant_members WHERE tenant_id=? AND user_id=?').run(h.actor.tenantId, h.actor.user.id),
      () => h.db.prepare(`INSERT INTO tenant_members (tenant_id,user_id,role,status,created_at,updated_at)
        VALUES (@tenant_id,@user_id,@role,@status,@created_at,@updated_at)`).run(member)],
    ['disabled tenant', 404,
      () => h.db.prepare("UPDATE tenants SET status='disabled' WHERE id=?").run(h.actor.tenantId),
      () => h.db.prepare("UPDATE tenants SET status='active' WHERE id=?").run(h.actor.tenantId)],
    ['invalidated token version', 401,
      () => h.db.prepare('UPDATE platform_users SET token_version=token_version+1 WHERE id=?').run(h.actor.user.id),
      () => h.db.prepare('UPDATE platform_users SET token_version=0 WHERE id=?').run(h.actor.user.id)],
    ['disabled user', 401,
      () => h.db.prepare("UPDATE platform_users SET status='disabled' WHERE id=?").run(h.actor.user.id),
      () => h.db.prepare("UPDATE platform_users SET status='active' WHERE id=?").run(h.actor.user.id)],
  ];
  for (const [name, status, revoke, restore] of accessCases) {
    await t.test(`GET cannot disclose identity or repair access after ${name}`, async () => {
      assert.equal(revoke().changes, 1);
      try {
        await h.get(`/api/v1/redraw/exports/${exportA}`, { status });
        await h.get(`/api/v1/redraw/versions/${h.scope.versionId}/exports`, { status });
      } finally { assert.equal(restore().changes, 1); }
    });
  }
  for (const [name, headers, status] of [['missing bearer', { Authorization: '' }, 401],
    ['incorrect signature', { Authorization: `Bearer ${userAuth.issueToken(h.actor.user, 'another-synthetic-signature-secret-32-bytes', 0)}` }, 401],
    ['unowned tenant', { 'X-Tenant-Id': 'synthetic-missing-tenant' }, 404]]) {
    await t.test(`real auth rejects ${name} before identity projection`, async () => {
      await h.get(`/api/v1/redraw/exports/${exportA}`, { headers, status });
      await h.get(`/api/v1/redraw/versions/${h.scope.versionId}/exports`, { headers, status });
    });
  }

  await t.test('soft-deleted export is absent from list and detail, without changing any other row', async () => {
    assert.equal(h.db.prepare('UPDATE redraw_exports SET deleted_at=? WHERE id=?').run(NOW, exportA).changes, 1);
    try {
      await h.get(`/api/v1/redraw/exports/${exportA}`, { status: 404 });
      const list = await h.get(`/api/v1/redraw/versions/${h.scope.versionId}/exports`);
      assert.equal(list.data.some(row => row.id === exportA), false);
      assert.equal(list.data.some(row => row.id === exportB), true);
    } finally { h.db.prepare('UPDATE redraw_exports SET deleted_at=NULL WHERE id=?').run(exportA); }
  });
  await t.test('soft-deleted version blocks unit export list and detail', async () => {
    assert.equal(h.db.prepare('UPDATE redraw_versions SET deleted_at=? WHERE id=?').run(NOW, h.scope.versionId).changes, 1);
    try {
      await h.get(`/api/v1/redraw/exports/${exportA}`, { status: 404 });
      await h.get(`/api/v1/redraw/versions/${h.scope.versionId}/exports`, { status: 404 });
    } finally { h.db.prepare('UPDATE redraw_versions SET deleted_at=NULL WHERE id=?').run(h.scope.versionId); }
  });

  await t.test('legacy-only version uses the unchanged legacy DTO with no identity fingerprint field', async () => {
    const scope = { ...h.scope, versionId: seedVersion(h.db, h.scope, 3) };
    const id = seedExport(h, { idempotency_key: 'synthetic-legacy-key-not-public', request_hash: 'legacy-opaque-request-hash',
      audio_mode: 'native', plan: { input_hash: 'legacy-input-hash' } }, { scope });
    const detail = await h.get(`/api/v1/redraw/exports/${id}`);
    const list = await h.get(`/api/v1/redraw/versions/${scope.versionId}/exports`);
    const expected = { id, version_id: scope.versionId, export_type: 'video', version_number: 1, status: 'pending',
      asset_id: null, subtitle_asset_id: null, project_asset_id: null, request_hash: 'legacy-opaque-request-hash',
      audio_mode: 'native', input_hash: 'legacy-input-hash', timeline: [], video_generation_ids: [], audio_asset_ids: [],
      output_asset_ids: { mp4: null, srt: null, vtt: null }, hashes: {}, probe: null,
      error_code: null, error_message: null, created_at: NOW, updated_at: NOW };
    assert.deepEqual(detail.data, expected);
    assert.deepEqual(list.data, [expected]);
    assert.equal(Object.hasOwn(detail.data, 'idempotency_key_sha256'), false);
    assert.equal(JSON.stringify([detail, list]).includes('synthetic-legacy-key-not-public'), false);
  });
});
