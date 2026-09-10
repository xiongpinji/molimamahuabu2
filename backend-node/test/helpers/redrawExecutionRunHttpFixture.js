'use strict';

// Real actor, owned SQLite, Express, JWT and execution services. Only provider
// transport and result download are synthetic; they never contact their URLs.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { setup, makeCandidateMedia, hash, KEY, SECRET, BASE_URL, NOW } = require('./redrawExecutionUnitDispatchFixture');
const { setupRouter } = require('../../src/routes');
const userAuth = require('../../src/services/userAuthService');
const tenantService = require('../../src/services/tenantService');
const runs = require('../../src/services/redrawExecutionRunService');
const review = require('../../src/services/redrawExecutionUnitReviewService');

const JWT_SECRET = 'synthetic-g4-run-http-jwt-secret-at-least-32-bytes';
const parameters = { resolution: '480p', aspect_ratio: '16:9' };
const log = { info() {}, warn() {}, error() {} };
const jsonResponse = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

function registerActor(db, personalTenant = true) {
  const user = userAuth.register(db, { email: `${crypto.randomUUID()}@example.test`, password: 'synthetic-run-http-pass-123' });
  const tenant = personalTenant ? tenantService.ensurePersonalTenant(db, user) : null;
  return { user, tenantId: tenant?.id ?? `personal:${user.id}`, token: userAuth.issueToken(user, JWT_SECRET, 0) };
}

async function fixture(t, { stage = 'queued', sequential = false, mode = 'paid' } = {}) {
  let h, server;
  const previous = { mode: process.env.PUBLIC_PLATFORM_MODE, secret: process.env.PLATFORM_JWT_SECRET };
  t.after(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    if (previous.mode === undefined) delete process.env.PUBLIC_PLATFORM_MODE;
    else process.env.PUBLIC_PLATFORM_MODE = previous.mode;
    if (previous.secret === undefined) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = previous.secret;
  });
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
  h = await setup(t, mode, sequential, stage, { createActor(db) {
    assert.equal(db.prepare('SELECT count(*) n FROM redraw_projects').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM redraw_execution_plan_reviews').get().n, 0);
    return registerActor(db);
  } });
  assert.equal(h.owner.userId, h.actor.user.id);
  assert.equal(h.ctx.tenantId, h.actor.tenantId);
  assert.equal(h.db.prepare('SELECT user_id FROM redraw_projects LIMIT 1').get().user_id, h.actor.user.id);
  assert.equal(h.db.prepare('SELECT user_id FROM redraw_execution_plan_reviews LIMIT 1').get().user_id,
    h.actor.user.id);
  h.registerActor = personalTenant => registerActor(h.db, personalTenant);
  h.unitId = h.expected(0).unit_id;
  h.calls = { submits: 0, queries: 0, downloads: 0, other: 0 };
  h.transport = { status: 'accepted', bytes: null };
  h.runtime = {
    fetchImpl: async (_url, init) => {
      assert.equal(h.db.inTransaction, false);
      assert.ok(['POST', 'GET'].includes(init.method));
      h.calls[init.method === 'POST' ? 'submits' : 'queries'] += 1;
      if (h.transport.responseLost) throw new Error('synthetic response lost after submission');
      return jsonResponse({ id: 'synthetic-run-http-provider-task', status: h.transport.status,
        ...(h.transport.status === 'succeeded' ? { content: { video_url: 'https://result.synthetic.invalid/run-http.mp4' } } : {}) });
    },
    download: {
      _dnsLookupForTest: async (hostname, options) => {
        assert.equal(hostname, 'result.synthetic.invalid');
        assert.equal(options.all, true);
        return [{ address: '8.8.8.8', family: 4 }];
      },
      fetchImpl: async (url, init) => {
        h.calls.downloads += 1;
        assert.equal(String(url), 'https://result.synthetic.invalid/run-http.mp4');
        assert.equal(init.method, 'GET');
        assert.equal(init.headers, undefined);
        assert.equal(h.db.inTransaction, false);
        assert.ok(Buffer.isBuffer(h.transport.bytes));
        return new Response(h.transport.bytes, { status: 200, headers: { 'Content-Type': 'video/mp4' } });
      },
    },
  };
  const forbidden = async () => { h.calls.other += 1; throw new Error('unexpected non-unit provider'); };
  async function listen() {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', setupRouter({ storage: { local_path: h.root, base_url: BASE_URL } }, h.db, log, {
      localizationProvider: forbidden, assetGenerationProvider: forbidden, dialogueProvider: forbidden,
      providerAssetSecret: SECRET,
      redrawOptions: { executionRunEnv: {}, executionRunRuntime: h.runtime, executionRunTempRoot: h.ctx.tempRoot,
        executionRunNowMs: () => Date.parse(NOW), sourceVideoTempRoot: h.ctx.tempRoot,
        referenceArtifactTempRoot: h.ctx.tempRoot },
    }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    return `http://127.0.0.1:${server.address().port}/api/v1/redraw/versions/${h.versionId}`;
  }
  let base = await listen();
  h.reopen = async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const filename = h.db.name;
    assert.equal(filename, path.join(h.root, 'fixture.sqlite'));
    h.db.close();
    h.db = new Database(filename);
    h.ctx.db = h.db;
    base = await listen();
  };
  h.url = suffix => `${base}${suffix}`;
  h.request = (suffix, { method = 'GET', body, headers = {} } = {}) => fetch(h.url(suffix), {
    method, headers: { Authorization: `Bearer ${h.actor.token}`, 'X-Tenant-Id': h.actor.tenantId,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  h.createInput = { expected_plan_hash: h.expected(0).plan_hash, expected_queue_id: h.expected(0).queue_id };
  h.prepareResult = async () => {
    const mediaRoot = fs.mkdtempSync(path.join(h.ctx.tempRoot, 'http-candidate-'));
    h.transport.bytes = await makeCandidateMedia({ ...h, root: mediaRoot });
    h.transport.status = 'succeeded';
  };
  h.makeCandidate = async () => {
    assert.ok(h.run && h.input, 'candidate setup requires an actual bound run');
    await h.prepareResult();
    const receipt = await runs.dispatchClaimedExecutionUnitTask(h.ctx, h.versionId, h.run.id, h.input, h.runtime);
    assert.equal(receipt.status, 'waiting_review', JSON.stringify({ receipt, calls: h.calls }));
    const candidate = await review.getExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.unitId);
    assert.equal(candidate.asset.sha256, hash(h.transport.bytes));
    assert.equal(h.calls.submits, 1);
    assert.equal(h.calls.downloads, 1);
    return candidate;
  };
  return h;
}

function snapshot(h) {
  return { bytes: h.db.serialize(), changes: h.db.prepare('SELECT total_changes() n').get().n, calls: { ...h.calls } };
}

function unchanged(h, before) {
  assert.deepEqual(snapshot(h), before);
}

function assertSafe(value) {
  const serialized = JSON.stringify(value);
  for (const secret of [KEY, SECRET, JWT_SECRET]) assert.equal(serialized.includes(secret), false);
  assert.doesNotMatch(serialized, /claim_token|relative_path|local_path|api_key|private_binding|result\.synthetic\.invalid/);
}

module.exports = { fixture, snapshot, unchanged, assertSafe, parameters };
