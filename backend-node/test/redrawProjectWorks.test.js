'use strict';

// Draft only until the fixed local-only launcher is reviewed. This suite uses
// real route handlers and migrated synthetic SQLite, never HTTP or real media.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const redrawRoutes = require('../src/routes/redraw');
const { setupRouter } = require('../src/routes');
const { createWorkFromSource } = require('../src/services/redrawService');

const NOW = '2026-09-08T00:00:00.000Z';
const OWNER = Object.freeze({ tenantId: 'tenant-a', userId: 'user-a' });
const ITEM_KEYS = ['id', 'project_id', 'title', 'duration_ms', 'current_step', 'status',
  'created_at', 'updated_at'].sort();

function project(db, values = {}) {
  return Number(db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, default_locale, default_market, localization_level,
      status, created_at, updated_at, deleted_at)
    VALUES (@tenant_id, @user_id, @title, 'en-US', 'US', 'faithful',
      'draft', @created_at, @updated_at, @deleted_at)`).run({
    tenant_id: OWNER.tenantId, user_id: OWNER.userId, title: 'Synthetic project',
    created_at: NOW, updated_at: NOW, deleted_at: null, ...values,
  }).lastInsertRowid);
}

function work(db, projectId, values = {}) {
  return Number(db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms,
      current_version, current_step, status, task_id, provider_task_id,
      credit_reservation_id, created_at, updated_at, deleted_at)
    VALUES (@project_id, @tenant_id, @user_id, @title, @source_asset_id, @source_fingerprint,
      @duration_ms, @current_version, @current_step, @status, @task_id, @provider_task_id,
      @credit_reservation_id, @created_at, @updated_at, @deleted_at)`).run({
    project_id: projectId, tenant_id: OWNER.tenantId, user_id: OWNER.userId,
    title: 'Synthetic source', source_asset_id: 101,
    source_fingerprint: crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
    duration_ms: 12000, current_version: 0, current_step: 1, status: 'draft',
    task_id: 'synthetic-internal-task', provider_task_id: 'synthetic-provider-task',
    credit_reservation_id: 'synthetic-reservation',
    created_at: NOW, updated_at: NOW, deleted_at: null, ...values,
  }).lastInsertRowid);
}

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const calls = [];
  const forbidden = name => () => {
    calls.push(name);
    throw new Error(`PROJECT_WORKS_MUST_NOT_${name}`);
  };
  const cfg = { storage: { local_path: path.join(os.tmpdir(), 'g3-project-works-unused-storage'),
    base_url: 'https://storage.synthetic.invalid' } };
  const options = {
    cfg,
    uploadService: { expandSourceUpload: forbidden('UPLOAD') },
    quoteAnalysis: forbidden('QUOTE_ANALYSIS'),
    orchestrator: { startAnalysis: forbidden('ANALYZE') },
    analysisOptions: { provider: { startAnalysis: forbidden('ANALYZE_PROVIDER') } },
    localizationProvider: forbidden('LOCALIZE'),
    assetGenerationProvider: forbidden('GENERATE_ASSET'),
    dialogueProvider: forbidden('GENERATE_DIALOGUE'),
    generationService: { generateShot: forbidden('GENERATE_SHOT'), generateBatch: forbidden('GENERATE_BATCH') },
    canReadArtifact: forbidden('READ_ARTIFACT'),
  };
  const log = { info() {}, warn() {}, error() {} };
  const handlers = redrawRoutes(db, log, options);
  return { db, calls, cfg, options, log, handlers, forbidden };
}

function request(projectId, { tenantId = OWNER.tenantId, userId = OWNER.userId } = {}) {
  return { params: { id: String(projectId) }, tenant: { id: tenantId }, user: { id: userId } };
}

function response() {
  return {
    statusCode: null, body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

function snapshot(h) {
  return { bytes: h.db.serialize(), changes: h.db.prepare('SELECT total_changes() AS n').get().n,
    calls: [...h.calls] };
}

function list(h, projectId, owner = OWNER, handler = h.handlers.listProjectWorks) {
  assert.equal(typeof handler, 'function', 'project works must have a real listProjectWorks handler');
  const before = snapshot(h);
  const res = response();
  handler(request(projectId, owner), res);
  assert.deepEqual(snapshot(h), before, 'listing works must be read-only and must not invoke providers');
  return res;
}

function assertItems(res, expected) {
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.data, expected);
  for (const item of res.body.data) assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS);
}

function publicWork(h, id) {
  return h.db.prepare(`SELECT id, project_id, title, duration_ms, current_step,
    status, created_at, updated_at FROM redraw_works WHERE id = ?`).get(id);
}

function assertNotFound(res) {
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, 'REDRAW_PROJECT_NOT_FOUND');
  assert.equal(res.body.data, undefined);
}

test('owned empty project returns an empty works array without creating a work', t => {
  const h = fixture(t), projectId = project(h.db);
  assertItems(list(h, projectId), []);
});

test('all works from a two-source registration stay individually discoverable', t => {
  const h = fixture(t), projectId = project(h.db);
  // Actual registration service, not ZIP/media validation: those have their own suite.
  const items = h.db.transaction(() => ['First source.mp4', 'Second source.mov'].map((name, index) =>
    createWorkFromSource(h.db, OWNER, projectId, {
      id: 101 + index, name, duration_ms: 12000 + index * 1000,
      source_fingerprint: String(index + 1).repeat(64),
    })))();
  assert.notEqual(items[0].id, items[1].id);
  assertItems(list(h, projectId), items.map(item => publicWork(h, item.id)));
  assertItems(list(h, projectId), items.map(item => publicWork(h, item.id)));
});

test('works are scoped by project as well as both owner dimensions and deletion status', t => {
  const h = fixture(t), projectId = project(h.db), otherProjectId = project(h.db);
  const wanted = work(h.db, projectId);
  work(h.db, otherProjectId, { title: 'Another project' });
  work(h.db, projectId, { tenant_id: 'tenant-b', title: 'Foreign tenant' });
  work(h.db, projectId, { user_id: 'user-b', title: 'Foreign user' });
  work(h.db, projectId, { deleted_at: NOW, title: 'Deleted work' });
  assertItems(list(h, projectId), [publicWork(h, wanted)]);
});

test('creation order is deterministic and does not reorder works after status updates', t => {
  const h = fixture(t), projectId = project(h.db);
  const later = work(h.db, projectId, { created_at: '2026-09-08T00:00:02.000Z' });
  const first = work(h.db, projectId, { updated_at: '2026-09-08T23:00:00.000Z' });
  const sameTimeNext = work(h.db, projectId, { updated_at: '2026-09-08T22:00:00.000Z' });
  assertItems(list(h, projectId), [first, sameTimeNext, later].map(id => publicWork(h, id)));
});

test('lightweight work items omit source, provider, billing and version internals', t => {
  const h = fixture(t), projectId = project(h.db);
  const id = work(h.db, projectId, { title: 'Current work', current_version: 7,
    current_step: 4, status: 'completed', duration_ms: 3600000 });
  const res = list(h, projectId);
  assertItems(res, [publicWork(h, id)]);
  assert.doesNotMatch(JSON.stringify(res.body.data),
    /tenant_id|user_id|source_asset|fingerprint|version_id|current_version|local_path|https?:|task_id|reservation|analysis_quote/);
});

for (const [label, owner] of [
  ['another tenant', { tenantId: 'tenant-b', userId: OWNER.userId }],
  ['another user in the same tenant', { tenantId: OWNER.tenantId, userId: 'user-b' }],
  ['missing tenant', { tenantId: null, userId: OWNER.userId }],
  ['missing user', { tenantId: OWNER.tenantId, userId: null }],
]) {
  test(`project works returns uniform 404 for ${label}`, t => {
    const h = fixture(t), projectId = project(h.db);
    work(h.db, projectId);
    assertNotFound(list(h, projectId, owner));
  });
}

test('a deleted project is not enumerable even when its work remains undeleted', t => {
  const h = fixture(t), projectId = project(h.db, { deleted_at: NOW });
  work(h.db, projectId);
  assertNotFound(list(h, projectId));
});

test('nonexistent or malformed project identifiers never return another project list', t => {
  const h = fixture(t), projectId = project(h.db);
  work(h.db, projectId);
  for (const id of [999999, '0', '-1', '1.5', 'not-an-id', '9007199254740993']) {
    assertNotFound(list(h, id));
  }
});

test('real router exposes one GET list without replacing POST upload or GET work', t => {
  const h = fixture(t), projectId = project(h.db);
  const id = work(h.db, projectId);
  const router = setupRouter(h.cfg, h.db, h.log, {
    localizationProvider: h.forbidden('LOCALIZE'),
    assetGenerationProvider: h.forbidden('GENERATE_ASSET'),
    dialogueProvider: h.forbidden('GENERATE_DIALOGUE'),
    providerAssetSecret: 'synthetic-project-works-provider-secret-32-bytes',
    localeRegistry: { assertReady: h.forbidden('LOCALE_REGISTRY') },
    localeVerifier: { verifyLocalVoice: h.forbidden('VOICE_VERIFIER') },
    redrawOptions: h.options,
  });
  const routes = router.stack.filter(layer => layer.route).map(layer => layer.route);
  const matches = routes.filter(route => route.path === '/redraw/projects/:id/works' && route.methods.get);
  assert.equal(matches.length, 1, 'GET project works must be registered exactly once');
  assert.equal(matches[0].stack.length, 1, 'list route must not run multipart upload middleware');
  assertItems(list(h, projectId, OWNER, matches[0].stack[0].handle), [publicWork(h, id)]);
  assert.equal(routes.some(route => route.path === '/redraw/projects/:id/works' && route.methods.post), true);
  assert.equal(routes.some(route => route.path === '/redraw/works/:id' && route.methods.get), true);
});
