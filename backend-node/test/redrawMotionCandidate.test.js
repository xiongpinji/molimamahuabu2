const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { setupRouter } = require('../src/routes');
const userAuth = require('../src/services/userAuthService');
const tenantService = require('../src/services/tenantService');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');

const NOW = '2026-09-06T00:00:00.000Z';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function probe(filename) {
  return JSON.parse(execFileSync(getFfprobePath(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename],
    { windowsHide: true, timeout: 20000, encoding: 'utf8' }));
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-motion-candidate-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const storageRoot = path.join(root, 'storage');
  const uploadTempRoot = path.join(root, 'uploads');
  fs.mkdirSync(storageRoot);
  const sourcePath = path.join(storageRoot, 'source.mp4');
  execFileSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=160x96:rate=25:duration=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath],
  { windowsHide: true, timeout: 20000 });
  const sourceBytes = fs.readFileSync(sourcePath);
  const fingerprint = sha(sourceBytes);
  const motionPaths = ['a', 'b'].map((name, index) => {
    const filename = path.join(root, `motion-${name}.mp4`);
    execFileSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-ss', String(index), '-i', sourcePath,
      '-t', '1.3', '-map', '0:v:0', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', filename],
    { windowsHide: true, timeout: 20000 });
    assert.equal(probe(filename).streams.length, 1);
    return filename;
  });
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const previous = { publicMode: process.env.PUBLIC_PLATFORM_MODE, secret: process.env.PLATFORM_JWT_SECRET };
  const secret = 'motion-candidate-local-test-secret-at-least-32-bytes';
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = secret;
  const user = userAuth.register(db, { email: `${crypto.randomUUID()}@example.test`, password: 'motion-candidate-local-123' });
  tenantService.ensurePersonalTenant(db, user);
  const tenantId = `personal:${user.id}`;
  const token = userAuth.issueToken(user, secret, 0);
  const sourceMetadata = { tenant_id: tenantId, user_id: user.id, sha256: fingerprint, source_fingerprint: fingerprint };
  const assetId = Number(db.prepare(`INSERT INTO assets
    (name, type, category, url, local_path, file_size, mime_type, width, height, duration, metadata, created_at, updated_at)
    VALUES ('source', 'video', 'redraw_source', '/static/unused', 'source.mp4', ?, 'video/mp4', 160, 96, 12, ?, ?, ?)`)
    .run(sourceBytes.length, JSON.stringify(sourceMetadata), NOW, NOW).lastInsertRowid);
  const projectId = Number(db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, created_at, updated_at) VALUES (?, ?, 'motion candidate', ?, ?)`)
    .run(tenantId, user.id, NOW, NOW).lastInsertRowid);
  const workId = Number(db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (?, ?, ?, 'motion candidate', ?, ?, 12000, ?, ?)`)
    .run(projectId, tenantId, user.id, assetId, fingerprint, NOW, NOW).lastInsertRowid);
  const versionId = Number(db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, created_at, updated_at) VALUES (?, ?, ?, 1, 'source', ?, ?)`)
    .run(workId, tenantId, user.id, NOW, NOW).lastInsertRowid);
  const shotId = Number(db.prepare(`INSERT INTO redraw_shots
    (work_id, version_id, tenant_id, user_id, batch_index, shot_index, start_ms, end_ms, duration_ms,
     preparation_state, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 1, 1000, 2300, 1300, 'parsed', ?, ?)`)
    .run(String(workId), versionId, tenantId, user.id, NOW, NOW).lastInsertRowid);
  const providerCalls = [];
  const forbidden = async () => { providerCalls.push('called'); throw new Error('unexpected provider call'); };
  const router = setupRouter({ storage: { local_path: storageRoot } }, db, { error() {}, warn() {}, info() {} }, {
    localizationProvider: forbidden, assetGenerationProvider: forbidden, dialogueProvider: forbidden,
    redrawOptions: { referenceArtifactTempRoot: uploadTempRoot },
  });
  const app = express();
  app.use('/api/v1', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    if (previous.publicMode === undefined) delete process.env.PUBLIC_PLATFORM_MODE;
    else process.env.PUBLIC_PLATFORM_MODE = previous.publicMode;
    if (previous.secret === undefined) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = previous.secret;
    assert.deepEqual(providerCalls, []);
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/redraw/shots`;
  const query = `expected_updated_at=${encodeURIComponent(NOW)}&expected_source_sha256=${fingerprint}`;
  return {
    root, storageRoot, uploadTempRoot, sourcePath, sourceBytes, fingerprint, db, user, tenantId,
    token, secret, assetId, workId, versionId, shotId, query, sourceMetadata,
    url: (q = query, suffix = '', id = shotId) => `${base}/${id}/motion-reference${suffix}?${q}`,
    get(q = query, suffix = '', headers = {}, id = shotId) {
      return fetch(`${base}/${id}/motion-reference${suffix}?${q}`, { headers: { Authorization: `Bearer ${token}`, ...headers } });
    },
    async upload(index = 0) {
      const form = new FormData();
      form.set('file', new Blob([fs.readFileSync(motionPaths[index])], { type: 'video/mp4' }), 'reviewed-motion.mp4');
      form.set('expected_updated_at', NOW);
      for (const field of ['full_frame_reviewed', 'source_identity_obscured', 'source_text_obscured', 'motion_preserved']) form.set(field, 'true');
      const result = await fetch(`${base}/${shotId}/motion-reference`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() }, body: form,
      });
      const json = await result.json();
      assert.equal(result.status, 200, JSON.stringify(json));
      const record = db.prepare('SELECT * FROM redraw_reference_artifact_imports ORDER BY id DESC LIMIT 1').get();
      const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(record.stored_asset_id);
      return { record, asset, bytes: fs.readFileSync(motionPaths[index]), file: path.join(storageRoot, asset.local_path) };
    },
  };
}

function evidence(f) {
  const files = fs.readdirSync(f.storageRoot, { recursive: true }).sort().map((relative) => {
    const absolute = path.join(f.storageRoot, relative);
    const stat = fs.lstatSync(absolute);
    return [relative, stat.isFile() ? sha(fs.readFileSync(absolute)) : 'directory'];
  });
  return { db: sha(f.db.serialize()), changes: f.db.prepare('SELECT total_changes() AS n').get().n, files };
}

const mediaQuery = (f, candidate) => `${f.query}&expected_import_id=${candidate.record.id}&expected_file_sha256=${candidate.record.file_sha256}`;

async function readState(f, expected) {
  const res = await f.get();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.status, expected);
  assert.deepEqual(Object.keys(body.data).sort(), ['candidate', 'shot_id', 'shot_updated_at', 'source_sha256', 'status', 'version_id']);
  return body.data;
}

async function error(res, status, kind) {
  assert.equal(res.status, status);
  const body = await res.json();
  assert.equal(body.error.code, `REDRAW_MOTION_CANDIDATE_${kind}`);
}

function trackHandles(t, opened) {
  const original = fs.promises.open.bind(fs.promises);
  const handles = new Set();
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await original(...args);
    handles.add(handle);
    const close = handle.close.bind(handle);
    handle.close = async () => { try { return await close(); } finally { handles.delete(handle); } };
    opened?.(handle, ...args);
    return handle;
  });
  return handles;
}

async function handlesClosed(handles) {
  for (let i = 0; handles.size && i < 100; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(handles.size, 0);
}

test('motion candidate recovers actual imported MP4 after refresh without business writes or ready promotion', async (t) => {
  const f = await fixture(t);
  let before = evidence(f);
  assert.equal((await readState(f, 'missing')).candidate, null);
  assert.deepEqual(evidence(f), before);
  const imported = await f.upload();
  const handles = trackHandles(t, (handle, filename) => {
    assert.equal(filename, imported.file);
    const read = handle.read.bind(handle);
    handle.read = (...args) => { assert.ok(args[2] <= 64 * 1024); return read(...args); };
  });
  before = evidence(f);
  for (let repeat = 0; repeat < 2; repeat += 1) {
    const state = await readState(f, 'available');
    assert.equal(state.shot_id, f.shotId);
    assert.equal(state.version_id, f.versionId);
    assert.equal(state.shot_updated_at, NOW);
    assert.equal(state.source_sha256, f.fingerprint);
    assert.deepEqual(state.candidate, { import_id: imported.record.id, asset: {
      id: imported.asset.id, type: 'video', mime_type: 'video/mp4', sha256: imported.record.file_sha256,
      duration_ms: Math.round(imported.asset.duration * 1000), width: 160, height: 96, file_size: imported.bytes.length,
    } });
    const res = await f.get(mediaQuery(f, imported), '/media');
    assert.equal(res.status, 200);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, imported.bytes);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.equal(res.headers.get('content-length'), String(bytes.length));
    assert.equal(res.headers.get('x-content-sha256'), sha(bytes));
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-disposition'), 'inline');
    const output = path.join(f.root, `received-${repeat}.mp4`);
    fs.writeFileSync(output, bytes);
    const media = probe(output);
    assert.equal(media.streams.length, 1);
    assert.equal(media.streams[0].codec_name, 'h264');
    assert.equal(media.streams[0].width, 160);
    assert.equal(media.streams[0].height, 96);
    assert.ok(Math.abs(Number(media.format.duration) * 1000 - 1300) <= 100);
    await handlesClosed(handles);
    assert.deepEqual(evidence(f), before);
  }
  assert.equal(f.db.prepare('SELECT preparation_state FROM redraw_shots WHERE id = ?').get(f.shotId).preparation_state, 'parsed');
});

test('motion candidate accepts native SQLite numeric work_id without business writes', async (t) => {
  const f = await fixture(t);
  f.db.prepare('UPDATE redraw_shots SET work_id = ? WHERE id = ?').run(f.workId, f.shotId);
  assert.deepEqual(f.db.prepare('SELECT work_id, typeof(work_id) AS storage_type FROM redraw_shots WHERE id = ?').get(f.shotId),
    { work_id: `${f.workId}.0`, storage_type: 'text' });
  let before = evidence(f);
  assert.equal((await readState(f, 'missing')).candidate, null);
  assert.deepEqual(evidence(f), before);
  const imported = await f.upload();
  before = evidence(f);
  const state = await readState(f, 'available');
  assert.equal(state.candidate.import_id, imported.record.id);
  assert.equal(state.candidate.asset.id, imported.asset.id);
  assert.equal(state.candidate.asset.sha256, imported.record.file_sha256);
  const res = await f.get(mediaQuery(f, imported), '/media');
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(bytes, imported.bytes);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('x-content-sha256'), sha(bytes));
  const output = path.join(f.root, 'received-numeric-work.mp4');
  fs.writeFileSync(output, bytes);
  const media = probe(output);
  assert.equal(media.streams.length, 1);
  assert.equal(media.streams[0].codec_type, 'video');
  assert.equal(media.streams[0].codec_name, 'h264');
  assert.equal(media.streams[0].width, 160);
  assert.equal(media.streams[0].height, 96);
  assert.ok(Math.abs(Number(media.format.duration) * 1000 - 1300) <= 100);
  assert.deepEqual(evidence(f), before);
  assert.equal(f.db.prepare('SELECT preparation_state FROM redraw_shots WHERE id = ?').get(f.shotId).preparation_state, 'parsed');
});

test('motion candidate accepts legacy empty shot work_id through its authoritative version join', async (t) => {
  const f = await fixture(t);
  const imported = await f.upload();
  f.db.prepare("UPDATE redraw_shots SET work_id = '' WHERE id = ?").run(f.shotId);
  const before = evidence(f);
  assert.equal((await readState(f, 'available')).candidate.import_id, imported.record.id);
  const res = await f.get(mediaQuery(f, imported), '/media');
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), imported.bytes);
  assert.deepEqual(evidence(f), before);
});

test('motion candidate rejects invalid or different persisted work_id without business writes', async (t) => {
  const f = await fixture(t);
  const imported = await f.upload();
  for (const workId of [String(f.workId + 1), f.workId + 1, `${f.workId}.5`, `${f.workId}.0000000000000001`,
    'not-a-number', 'NaN', 'Infinity', '9007199254740992', '9007199254740992.0',
    `0${f.workId}`, `+${f.workId}`, ` ${f.workId}`, `${f.workId} `, `${f.workId}\n`, `${f.workId}\r\n`,
    `${f.workId}e0`, `0x${f.workId.toString(16)}`, Buffer.from(String(f.workId)),
    `${f.workId}tail`, '0', '-1']) {
    f.db.prepare('UPDATE redraw_shots SET work_id = ? WHERE id = ?').run(workId, f.shotId);
    const before = evidence(f);
    await error(await f.get(), 404, 'NOT_FOUND');
    await error(await f.get(mediaQuery(f, imported), '/media'), 404, 'NOT_FOUND');
    assert.deepEqual(evidence(f), before);
  }
});

test('motion candidate binds A/B import identity despite unchanged shot CAS and does not fall back from deleted latest', async (t) => {
  const f = await fixture(t);
  const a = await f.upload();
  const b = await f.upload(1);
  assert.notEqual(a.record.file_sha256, b.record.file_sha256);
  assert.equal((await readState(f, 'available')).candidate.import_id, b.record.id);
  await error(await f.get(mediaQuery(f, a), '/media'), 409, 'CONFLICT');
  await error(await f.get(mediaQuery(f, b).replace(b.record.file_sha256, a.record.file_sha256), '/media'), 409, 'CONFLICT');
  f.db.prepare('UPDATE assets SET deleted_at = ? WHERE id = ?').run(NOW, b.asset.id);
  const before = evidence(f);
  assert.equal((await readState(f, 'unavailable')).candidate, null);
  await error(await f.get(mediaQuery(f, b), '/media'), 409, 'UNAVAILABLE');
  assert.deepEqual(evidence(f), before);
});

test('motion candidate permits preview of an already bound candidate without calling binding writes', async (t) => {
  const f = await fixture(t);
  const imported = await f.upload();
  const metadata = JSON.parse(imported.asset.metadata);
  metadata.redraw_motion_reference = { schema_version: 'redraw-motion-reference-v1', bound_by: f.user.id };
  f.db.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), imported.asset.id);
  const before = evidence(f);
  assert.equal((await readState(f, 'available')).candidate.asset.id, imported.asset.id);
  assert.equal((await f.get(mediaQuery(f, imported), '/media')).status, 200);
  assert.deepEqual(evidence(f), before);
});

test('motion candidate rejects malformed IDs, repeated/unknown fields and incomplete media CAS', async (t) => {
  const f = await fixture(t);
  const before = evidence(f);
  for (const q of ['', `${f.query}&expected_updated_at=x`, `${f.query}&expected_source_sha256=${f.fingerprint}`,
    ...['asset_id=1', 'version_id=1', 'path=source.mp4', 'url=https://example.test', 'model=x', 'key=x', '__proto__[path]=x'].map((x) => `${f.query}&${x}`),
    f.query.replace(f.fingerprint, f.fingerprint.toUpperCase()),
    `expected_updated_at=%20${encodeURIComponent(NOW)}&expected_source_sha256=${f.fingerprint}`]) {
    await error(await f.get(q), 400, 'INPUT_INVALID');
  }
  for (const id of ['0', '01', '-1', '1e0', '1.5', '9007199254740992']) await error(await f.get(undefined, '', {}, id), 400, 'INPUT_INVALID');
  for (const q of [f.query, `${f.query}&expected_import_id=1`, `${f.query}&expected_import_id=01&expected_file_sha256=${f.fingerprint}`,
    `${f.query}&expected_import_id=1&expected_file_sha256=${f.fingerprint}&expected_import_id=1`]) await error(await f.get(q, '/media'), 400, 'INPUT_INVALID');
  assert.deepEqual(evidence(f), before);
});

test('motion candidate rejects anonymous/cookie-only/foreign/fresh tenants without lazy tenant writes', async (t) => {
  const f = await fixture(t);
  const other = userAuth.register(f.db, { email: `${crypto.randomUUID()}@example.test`, password: 'candidate-other-user-123' });
  const otherToken = userAuth.issueToken(other, f.secret, 0);
  const before = evidence(f);
  assert.equal((await fetch(f.url())).status, 401);
  assert.equal((await fetch(f.url(), { headers: { Cookie: `platform_session=${f.token}` } })).status, 401);
  await error(await f.get(undefined, '', { Authorization: `Bearer ${otherToken}` }), 404, 'NOT_FOUND');
  await error(await f.get(undefined, '', { 'X-Tenant-Id': 'foreign' }), 404, 'NOT_FOUND');
  assert.equal(f.db.prepare('SELECT id FROM tenants WHERE id = ?').get(`personal:${other.id}`), undefined);
  assert.deepEqual(evidence(f), before);
});

test('motion candidate fails closed for disabled membership/tenant and stale source or shot CAS', async (t) => {
  const f = await fixture(t);
  for (const table of ['tenants', 'tenant_members']) {
    f.db.prepare(`UPDATE ${table} SET status = 'disabled'`).run();
    const before = evidence(f);
    await error(await f.get(), 404, 'NOT_FOUND');
    assert.deepEqual(evidence(f), before);
    f.db.prepare(`UPDATE ${table} SET status = 'active'`).run();
  }
  await error(await f.get(f.query.replace(encodeURIComponent(NOW), 'new-cas')), 409, 'CONFLICT');
  await error(await f.get(f.query.replace(f.fingerprint, 'a'.repeat(64))), 409, 'CONFLICT');
});

for (const change of ['reviewer', 'review', 'source-dimensions', 'duration-nan', 'asset-duration-nan', 'metadata-owner', 'path', 'file-size', 'file-sha', 'deleted-shot', 'deleted-version', 'deleted-work', 'source-owner']) {
test(`motion candidate rejects ${change} instead of exposing a stale candidate`, async (t) => {
  const f = await fixture(t);
  const imported = await f.upload();
  const metadata = JSON.parse(imported.asset.metadata);
  let scopeMissing = false;
  if (change === 'reviewer') metadata.redraw_motion_import.reviewed_by = 'foreign';
  if (change === 'review') metadata.redraw_motion_import.review.source_text_obscured = false;
  if (change === 'duration-nan') metadata.redraw_motion_import.duration_ms = 'invalid-duration';
  if (change === 'metadata-owner') metadata.user_id = 'foreign';
  f.db.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), imported.asset.id);
  if (change === 'source-dimensions') f.db.prepare('UPDATE assets SET width = 320 WHERE id = ?').run(f.assetId);
  if (change === 'asset-duration-nan') f.db.prepare("UPDATE assets SET duration = 'invalid-duration' WHERE id = ?").run(imported.asset.id);
  if (change === 'path') f.db.prepare("UPDATE assets SET local_path = '../outside.mp4' WHERE id = ?").run(imported.asset.id);
  if (change === 'file-size') f.db.prepare('UPDATE assets SET file_size = file_size + 1 WHERE id = ?').run(imported.asset.id);
  if (change === 'file-sha') fs.appendFileSync(imported.file, 'tampered');
  if (change.startsWith('deleted-')) {
    const table = { 'deleted-shot': ['redraw_shots', f.shotId], 'deleted-version': ['redraw_versions', f.versionId], 'deleted-work': ['redraw_works', f.workId] }[change];
    f.db.prepare(`UPDATE ${table[0]} SET deleted_at = ? WHERE id = ?`).run(NOW, table[1]);
    scopeMissing = true;
  }
  if (change === 'source-owner') {
    f.db.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify({ ...f.sourceMetadata, user_id: 'foreign' }), f.assetId);
    scopeMissing = true;
  }
  const before = evidence(f);
  if (scopeMissing) await error(await f.get(), 404, 'NOT_FOUND');
  else assert.equal((await readState(f, 'unavailable')).candidate, null);
  await error(await f.get(mediaQuery(f, imported), '/media'), scopeMissing ? 404 : 409, scopeMissing ? 'NOT_FOUND' : 'UNAVAILABLE');
  assert.deepEqual(evidence(f), before);
});
}

test('motion candidate rejects symlinked storage directories without following them', async (t) => {
  const f = await fixture(t);
  const imported = await f.upload();
  const originalDirectory = path.dirname(imported.file);
  const heldDirectory = path.join(f.root, 'held-candidate-files');
  fs.renameSync(originalDirectory, heldDirectory);
  fs.symlinkSync(heldDirectory, originalDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await readState(f, 'unavailable')).candidate, null);
  await error(await f.get(mediaQuery(f, imported), '/media'), 409, 'UNAVAILABLE');
});

for (const mutation of ['candidate', 'membership', 'tenant', 'source', 'file']) {
test(`motion candidate rechecks ${mutation} after fixed-FD stream creation before headers`, async (t) => {
  const f = await fixture(t);
  const imported = await f.upload();
  let expectedEvidence;
  const handles = trackHandles(t, (handle, filename) => {
    if (filename !== imported.file) return;
    const create = handle.createReadStream.bind(handle);
    handle.createReadStream = (...args) => {
      if (mutation === 'candidate') f.db.prepare('UPDATE redraw_reference_artifact_imports SET file_sha256 = ? WHERE id = ?').run('a'.repeat(64), imported.record.id);
      if (mutation === 'membership') f.db.prepare("UPDATE tenant_members SET status = 'disabled'").run();
      if (mutation === 'tenant') f.db.prepare("UPDATE tenants SET status = 'disabled'").run();
      if (mutation === 'source') f.db.prepare('UPDATE assets SET width = 320 WHERE id = ?').run(f.assetId);
      if (mutation === 'file') fs.appendFileSync(imported.file, 'changed-after-hash');
      expectedEvidence = evidence(f);
      return create(...args);
    };
  });
  await error(await f.get(mediaQuery(f, imported), '/media'), ['membership', 'tenant'].includes(mutation) ? 404 : 409,
    ['membership', 'tenant'].includes(mutation) ? 'NOT_FOUND' : 'CONFLICT');
  await handlesClosed(handles);
  assert.deepEqual(evidence(f), expectedEvidence);
});
}

test('motion candidate abort closes its held file without deleting assets or writing state', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const imported = await f.upload();
  let readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  const handles = trackHandles(t, (handle, filename) => {
    if (filename !== imported.file) return;
    const read = handle.read.bind(handle);
    handle.read = async (...args) => { readStarted(); await gate; return read(...args); };
  });
  const before = evidence(f);
  const request = http.get(f.url(mediaQuery(f, imported), '/media'), { headers: { Authorization: `Bearer ${f.token}` } });
  request.on('error', () => {});
  await started;
  request.destroy();
  releaseRead();
  await handlesClosed(handles);
  assert.deepEqual(evidence(f), before);
});
