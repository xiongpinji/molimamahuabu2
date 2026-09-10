const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { setupRouter } = require('../../src/routes');
const userAuth = require('../../src/services/userAuthService');
const { fixture, snapshot, sha256, probe, NOW, OWNER } = require('./redrawMotionObscurationFixture');

async function httpFixture(t, options = {}) {
  const f = await fixture(t, options.media);
  const secret = 'motion-processing-isolated-test-secret-32-bytes';
  const previous = { publicMode: process.env.PUBLIC_PLATFORM_MODE, secret: process.env.PLATFORM_JWT_SECRET };
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = secret;
  userAuth.ensureSchema(f.db);
  for (const id of [OWNER.userId, 'other-motion-user']) f.db.prepare(`INSERT INTO platform_users
    (id, email, password_hash, password_salt) VALUES (?, ?, 'unused', 'unused')`).run(id, `${id}@example.test`);
  const token = userAuth.issueToken({ id: OWNER.userId, role: 'user' }, secret, 0);
  const otherToken = userAuth.issueToken({ id: 'other-motion-user', role: 'user' }, secret, 0);
  const providerCalls = [];
  const forbidden = async () => { providerCalls.push('called'); throw new Error('unexpected provider call'); };
  const uploadRoot = path.join(f.storageRoot, 'test-uploads');
  const router = setupRouter({ storage: { local_path: f.storageRoot } }, f.db, { error() {}, warn() {}, info() {} }, {
    localizationProvider: forbidden, assetGenerationProvider: forbidden, dialogueProvider: forbidden,
    redrawOptions: { sourceVideoTempRoot: f.tempRoot, referenceArtifactTempRoot: uploadRoot, ...options.routes },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previous.publicMode === undefined) delete process.env.PUBLIC_PLATFORM_MODE;
    else process.env.PUBLIC_PLATFORM_MODE = previous.publicMode;
    if (previous.secret === undefined) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = previous.secret;
    assert.deepEqual(providerCalls, []);
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const headers = { Authorization: `Bearer ${token}`, 'x-tenant-id': OWNER.tenantId };
  const query = `expected_updated_at=${encodeURIComponent(NOW)}&expected_source_sha256=${f.fingerprint}`;
  return { ...f, ctx: { ...f.ctx, log: { error() {}, warn() {}, info() {} } }, base, headers, query, token, otherToken, server, uploadRoot,
    url: (q = query) => `${base}/redraw/shots/${f.input.shot_id}/motion-processing?${q}`,
    get(q = query, extraHeaders = {}) { return fetch(this.url(q), { headers: { ...headers, ...extraHeaders } }); },
  };
}

async function envelope(f, response) {
  assert.equal(response.status, 200, response.status === 200 ? '' : await response.text());
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get('content-type'), 'application/vnd.moli.redraw-motion-processing.v1');
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(bytes.subarray(0, 8).toString('ascii'), 'RDMO0001');
  const length = bytes.readUInt32BE(8);
  assert.ok(length > 0 && length <= 8 * 1024 * 1024);
  const rawReport = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(12, 12 + length));
  const report = JSON.parse(rawReport);
  const video = bytes.subarray(12 + length);
  assert.equal(video.length, report.output.size);
  assert.equal(sha256(video), report.output.sha256);
  assert.equal(report.source_fingerprint, f.fingerprint);
  assert.equal(report.shot_id, f.input.shot_id);
  assert.equal(report.shot.expected_updated_at, NOW);
  assert.equal(report.approval_status, 'pending');
  assert.ok(!rawReport.includes(f.storageRoot) && !rawReport.includes(f.tempRoot));
  assert.ok(!/"(?:path|identity_obscured|source_identity_obscured|source_text_obscured|motion_preserved)"/.test(rawReport));
  for (let i = 0; i < 200 && fs.readdirSync(f.tempRoot).length; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fs.readdirSync(f.tempRoot), []);
  return { bytes, report, rawReport, video };
}

function importInput(result, overrides = {}) {
  return { shotId: result.report.shot_id, expectedUpdatedAt: NOW, idempotencyKey: 'local-motion-processing-import',
    fullFrameReviewed: true, sourceIdentityObscured: true, sourceTextObscured: true, motionPreserved: true,
    processingReport: result.rawReport,
    file: { originalname: 'processed.mp4', mimetype: 'video/mp4', size: result.video.length, buffer: result.video },
    ...overrides };
}

module.exports = { httpFixture, envelope, importInput, snapshot, sha256, probe, NOW, OWNER };
