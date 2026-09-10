const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const express = require('express');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { setupRouter } = require('../src/routes');
const userAuth = require('../src/services/userAuthService');
const tenantService = require('../src/services/tenantService');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const NOW = '2026-09-06T00:00:00.000Z';
const execAsync = promisify(execFile);

function probe(filename) {
  return JSON.parse(execFileSync(getFfprobePath(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename],
    { windowsHide: true, timeout: 20000, encoding: 'utf8' }));
}

async function fixture(t, { ext = '.mp4', width = 160, height = 96, audio = true, runner } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-motion-draft-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const storageRoot = path.join(root, 'storage');
  const tempRoot = path.join(root, 'private');
  fs.mkdirSync(storageRoot);
  fs.mkdirSync(tempRoot);
  const sourcePath = path.join(storageRoot, `source${ext}`);
  execFileSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `testsrc2=size=${width}x${height}:rate=25:duration=12`,
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=16000:duration=12', '-c:a', 'aac'] : []),
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath],
  { windowsHide: true, timeout: 20000, stdio: 'pipe' });
  const sourceBytes = fs.readFileSync(sourcePath);
  const fingerprint = sha(sourceBytes);
  assert.equal(probe(sourcePath).streams.filter((stream) => stream.codec_type === 'audio').length, audio ? 1 : 0);
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const previous = { publicMode: process.env.PUBLIC_PLATFORM_MODE, secret: process.env.PLATFORM_JWT_SECRET };
  const secret = 'motion-draft-local-test-secret-at-least-32-bytes';
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = secret;
  const user = userAuth.register(db, { email: `${crypto.randomUUID()}@example.test`, password: 'motion-draft-local-123' });
  tenantService.ensurePersonalTenant(db, user);
  const tenantId = `personal:${user.id}`;
  const token = userAuth.issueToken(user, secret, 0);
  const metadata = { tenant_id: tenantId, user_id: user.id, sha256: fingerprint, source_fingerprint: fingerprint, duration_ms: 12000 };
  const assetId = Number(db.prepare(`INSERT INTO assets
    (name, type, category, url, local_path, file_size, mime_type, width, height, duration, metadata, created_at, updated_at)
    VALUES ('source', 'video', 'redraw_source', '/static/unused', ?, ?, 'ignored/type', ?, ?, 12, ?, ?, ?)`)
    .run(path.basename(sourcePath), sourceBytes.length, width, height, JSON.stringify(metadata), NOW, NOW).lastInsertRowid);
  const projectId = Number(db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, created_at, updated_at) VALUES (?, ?, 'motion draft', ?, ?)`)
    .run(tenantId, user.id, NOW, NOW).lastInsertRowid);
  const workId = Number(db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (?, ?, ?, 'motion draft', ?, ?, 12000, ?, ?)`)
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
    redrawOptions: { sourceVideoTempRoot: tempRoot, motionDraftExecFile: runner },
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
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/redraw/shots`;
  const query = `expected_updated_at=${encodeURIComponent(NOW)}&expected_source_sha256=${fingerprint}`;
  return {
    root, storageRoot, tempRoot, sourcePath, sourceBytes, fingerprint, width, height, db,
    user, tenantId, token, secret, metadata, assetId, workId, versionId, shotId, query,
    url: (q = query, id = shotId) => `${baseUrl}/${id}/motion-draft?${q}`,
    get(q = query, headers = {}, id = shotId) {
      return fetch(`${baseUrl}/${id}/motion-draft?${q}`, { headers: { Authorization: `Bearer ${token}`, ...headers } });
    },
    update(table, values) {
      const ids = { assets: assetId, redraw_works: workId, redraw_versions: versionId, redraw_shots: shotId };
      assert.ok(Object.hasOwn(ids, table));
      for (const [key, value] of Object.entries(values)) db.prepare(`UPDATE ${table} SET ${key} = ? WHERE id = ?`).run(value, ids[table]);
    },
  };
}

function dbState(db) {
  return { sha256: sha(db.serialize()), changes: db.prepare('SELECT total_changes() AS n').get().n };
}

async function waitClean(f, expected = []) {
  for (let i = 0; i < 200; i += 1) {
    if (JSON.stringify(fs.readdirSync(f.tempRoot).sort()) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(fs.readdirSync(f.tempRoot).sort(), expected, 'only this request temporary files are removed');
}

async function assertPlayableDraft(f, res) {
  assert.equal(res.status, 200, await (res.status === 200 ? '' : res.text()));
  const received = Buffer.from(await res.arrayBuffer());
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('content-length'), String(received.length));
  assert.equal(res.headers.get('x-content-sha256'), sha(received));
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-disposition'), 'inline');
  const output = path.join(f.root, 'received.mp4');
  fs.writeFileSync(output, received);
  const media = probe(output);
  assert.equal(media.streams.length, 1);
  assert.equal(media.streams[0].codec_type, 'video');
  assert.equal(media.streams[0].codec_name, 'h264');
  assert.equal(media.streams[0].width, f.width);
  assert.equal(media.streams[0].height, f.height);
  assert.ok(Math.abs(Number(media.streams[0].duration) * 1000 - 1300) <= 100);
  await waitClean(f);
}

for (const variant of [{ ext: '.mp4', width: 160, height: 96 }, { ext: '.mov', width: 96, height: 160 }]) {
test(`motion-draft authenticated GET clips real audible ${variant.ext} ${variant.width}x${variant.height} with no business writes`, async (t) => {
  const f = await fixture(t, variant);
  const opened = [];
  const handles = trackHandles(t, f, (handle, filename, flags, mode) => {
    if (String(filename).endsWith('.mp4') && filename !== f.sourcePath) {
      opened.push({ filename, mode });
      assert.equal(mode, 0o600);
      assert.equal(fs.statSync(path.dirname(filename)).isDirectory(), true);
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.dirname(filename)).mode & 0o777, 0o700);
    }
    if (filename === f.sourcePath) {
      const read = handle.read.bind(handle);
      handle.read = (...args) => { assert.ok(args[2] <= 64 * 1024); return read(...args); };
    }
  });
  const before = dbState(f.db);
  for (let repeat = 0; repeat < 2; repeat += 1) await assertPlayableDraft(f, await f.get());
  assert.equal(opened.length, 2);
  assert.notEqual(path.dirname(opened[0].filename), path.dirname(opened[1].filename));
  assert.equal(handles.size, 0);
  assert.deepEqual(dbState(f.db), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
  for (const table of ['async_tasks', 'tenant_usage_reservations', 'video_generations', 'redraw_reference_artifact_imports']) {
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  }
  assert.equal(f.db.prepare('SELECT preparation_state FROM redraw_shots WHERE id = ?').get(f.shotId).preparation_state, 'parsed');
  assert.equal(sha(fs.readFileSync(f.sourcePath)), f.fingerprint);
});
}

async function assertError(f, res, status, code) {
  assert.equal(res.status, status);
  const body = await res.json();
  assert.equal(body.error.code, `REDRAW_MOTION_DRAFT_${code}`);
  const json = JSON.stringify(body);
  for (const hidden of [f.root, f.sourcePath, f.fingerprint]) assert.equal(json.includes(hidden), false);
  await waitClean(f);
}

test('motion-draft rejects unknown/repeated queries and noncanonical IDs/CAS without writes', async (t) => {
  const f = await fixture(t);
  const before = dbState(f.db);
  const invalid = ['', f.query + '&expected_updated_at=x', f.query + '&expected_source_sha256=' + f.fingerprint,
    f.query + '&asset_id=1', f.query + '&start_ms=0', f.query + '&end_ms=1', f.query + '&path=source.mp4',
    f.query + '&url=https://example.test', f.query + '&model=x', f.query + '&key=x', f.query + '&__proto__[path]=x',
    `expected_updated_at=&expected_source_sha256=${f.fingerprint}`,
    `expected_updated_at=%20${encodeURIComponent(NOW)}&expected_source_sha256=${f.fingerprint}`,
    `expected_updated_at=x%0Ay&expected_source_sha256=${f.fingerprint}`,
    f.query.replace(f.fingerprint, f.fingerprint.toUpperCase()), f.query.replace(f.fingerprint, 'a'.repeat(63))];
  for (const query of invalid) await assertError(f, await f.get(query), 400, 'INPUT_INVALID');
  for (const id of ['0', '01', '-1', '1e0', '1.5', '9007199254740992']) {
    await assertError(f, await f.get(undefined, {}, id), 400, 'INPUT_INVALID');
  }
  assert.deepEqual(dbState(f.db), before);
});

test('motion-draft rejects anonymous, cookie-only, foreign and uninitialized tenant without writes', async (t) => {
  const f = await fixture(t);
  const other = userAuth.register(f.db, { email: `${crypto.randomUUID()}@example.test`, password: 'motion-fresh-user-123' });
  const foreignToken = userAuth.issueToken(other, f.secret, 0);
  const before = dbState(f.db);
  assert.equal((await fetch(f.url())).status, 401);
  assert.equal((await fetch(f.url(), { headers: { Cookie: `platform_session=${f.token}` } })).status, 401);
  await assertError(f, await f.get(undefined, { 'X-Tenant-Id': 'foreign' }), 404, 'NOT_FOUND');
  await assertError(f, await f.get(undefined, { Authorization: `Bearer ${foreignToken}` }), 404, 'NOT_FOUND');
  assert.equal(f.db.prepare('SELECT id FROM tenants WHERE id = ?').get(`personal:${other.id}`), undefined);
  assert.deepEqual(dbState(f.db), before);
});

test('motion-draft checks active existing membership and tenant without initializing them', async (t) => {
  const f = await fixture(t);
  for (const table of ['tenant_members', 'tenants']) {
    f.db.prepare(`UPDATE ${table} SET status = 'disabled'`).run();
    const before = dbState(f.db);
    await assertError(f, await f.get(), 404, 'NOT_FOUND');
    assert.deepEqual(dbState(f.db), before);
    f.db.prepare(`UPDATE ${table} SET status = 'active'`).run();
  }
  f.db.prepare('DELETE FROM tenant_members').run();
  const before = dbState(f.db);
  await assertError(f, await f.get(), 404, 'NOT_FOUND');
  assert.deepEqual(dbState(f.db), before);
});

test('motion-draft verifies the complete shot/version/work owner join before CAS', async (t) => {
  const f = await fixture(t);
  for (const table of ['redraw_shots', 'redraw_versions', 'redraw_works']) {
    for (const key of ['tenant_id', 'user_id']) {
      f.update(table, { [key]: 'foreign' });
      const before = dbState(f.db);
      await assertError(f, await f.get(f.query.replace(f.fingerprint, 'f'.repeat(64))), 404, 'NOT_FOUND');
      assert.deepEqual(dbState(f.db), before);
      f.update(table, { [key]: key === 'tenant_id' ? f.tenantId : f.user.id });
    }
  }
  f.update('redraw_shots', { work_id: '999999' });
  const before = dbState(f.db);
  await assertError(f, await f.get(), 404, 'NOT_FOUND');
  assert.deepEqual(dbState(f.db), before);
});

test('motion-draft accepts legacy empty shot work_id through its authoritative version join', async (t) => {
  const f = await fixture(t);
  f.update('redraw_shots', { work_id: '' });
  const before = dbState(f.db);
  await assertPlayableDraft(f, await f.get());
  assert.deepEqual(dbState(f.db), before);
});

test('motion-draft accepts native SQLite numeric work_id without business writes', async (t) => {
  const f = await fixture(t);
  f.db.prepare('UPDATE redraw_shots SET work_id = ? WHERE id = ?').run(f.workId, f.shotId);
  assert.deepEqual(f.db.prepare('SELECT work_id, typeof(work_id) AS storage_type FROM redraw_shots WHERE id = ?').get(f.shotId),
    { work_id: `${f.workId}.0`, storage_type: 'text' });
  const before = dbState(f.db);
  await assertPlayableDraft(f, await f.get());
  assert.deepEqual(dbState(f.db), before);
  assert.equal(sha(fs.readFileSync(f.sourcePath)), f.fingerprint);
});

test('motion-draft rejects invalid or different persisted work_id without business writes', async (t) => {
  const f = await fixture(t);
  for (const workId of [String(f.workId + 1), f.workId + 1, `${f.workId}.5`, `${f.workId}.0000000000000001`,
    'not-a-number', 'NaN', 'Infinity', '9007199254740992', '9007199254740992.0',
    `0${f.workId}`, `+${f.workId}`, ` ${f.workId}`, `${f.workId} `, `${f.workId}\n`, `${f.workId}\r\n`,
    `${f.workId}e0`, `0x${f.workId.toString(16)}`, Buffer.from(String(f.workId)),
    `${f.workId}tail`, '0', '-1']) {
    f.update('redraw_shots', { work_id: workId });
    const before = dbState(f.db);
    await assertError(f, await f.get(), 404, 'NOT_FOUND');
    assert.deepEqual(dbState(f.db), before);
  }
});

test('motion-draft soft-deleted shot/version/work/source cannot be read', async (t) => {
  const f = await fixture(t);
  for (const table of ['redraw_shots', 'redraw_versions', 'redraw_works', 'assets']) {
    f.update(table, { deleted_at: NOW });
    const before = dbState(f.db);
    await assertError(f, await f.get(), 404, 'NOT_FOUND');
    assert.deepEqual(dbState(f.db), before);
    f.update(table, { deleted_at: null });
  }
});

test('motion-draft rejects both stale CAS values without writes', async (t) => {
  const f = await fixture(t);
  const before = dbState(f.db);
  await assertError(f, await f.get(f.query.replace(encodeURIComponent(NOW), 'old')), 409, 'CONFLICT');
  await assertError(f, await f.get(f.query.replace(f.fingerprint, 'f'.repeat(64))), 409, 'CONFLICT');
  assert.deepEqual(dbState(f.db), before);
});

test('motion-draft validates registered source owner/hash/size/path and exact media dimensions', async (t) => {
  const f = await fixture(t);
  const original = f.db.prepare('SELECT * FROM assets WHERE id = ?').get(f.assetId);
  const cases = [
    [{ metadata: JSON.stringify({ ...f.metadata, user_id: 'foreign' }) }, 404, 'NOT_FOUND'],
    [{ metadata: JSON.stringify({ ...f.metadata, tenant_id: 'foreign' }) }, 404, 'NOT_FOUND'],
    [{ metadata: JSON.stringify({ ...f.metadata, sha256: 'a'.repeat(64) }) }, 409, 'UNAVAILABLE'],
    [{ metadata: JSON.stringify({ ...f.metadata, sha256: null, source_fingerprint: 'b'.repeat(64) }) }, 409, 'UNAVAILABLE'],
    [{ metadata: '{broken' }, 409, 'UNAVAILABLE'],
    [{ file_size: 0 }, 409, 'UNAVAILABLE'], [{ file_size: 1 }, 409, 'UNAVAILABLE'],
    [{ local_path: f.sourcePath }, 409, 'UNAVAILABLE'], [{ local_path: '../source.mp4' }, 409, 'UNAVAILABLE'],
    [{ local_path: 'missing.mp4' }, 409, 'UNAVAILABLE'], [{ width: 162 }, 409, 'UNAVAILABLE'],
    [{ height: 98 }, 409, 'UNAVAILABLE'], [{ width: null }, 409, 'UNAVAILABLE'],
    [{ type: 'audio' }, 409, 'UNAVAILABLE'], [{ category: 'other' }, 409, 'UNAVAILABLE'],
  ];
  for (const [values, status, code] of cases) {
    f.update('assets', values);
    const before = dbState(f.db);
    await assertError(f, await f.get(), status, code);
    assert.deepEqual(dbState(f.db), before);
    f.update('assets', Object.fromEntries(Object.keys(values).map((key) => [key, original[key]])));
  }
});

test('motion-draft rejects nonnumeric persisted asset duration without business writes', async (t) => {
  const f = await fixture(t);
  f.update('assets', { duration: 'invalid-duration' });
  assert.equal(f.db.prepare('SELECT duration FROM assets WHERE id = ?').get(f.assetId).duration, 'invalid-duration');
  const before = dbState(f.db);
  await assertError(f, await f.get(), 409, 'UNAVAILABLE');
  assert.deepEqual(dbState(f.db), before);
});

test('motion-draft preserves optional null asset duration using the real source probe', async (t) => {
  const f = await fixture(t);
  f.update('assets', { duration: null });
  const before = dbState(f.db);
  await assertPlayableDraft(f, await f.get());
  assert.deepEqual(dbState(f.db), before);
});

for (const legacy of ['null-size', 'fingerprint-only', 'owner-only']) {
test(`motion-draft preserves legacy registered source ${legacy} using verified snapshot bytes`, async (t) => {
  const f = await fixture(t);
  if (legacy === 'null-size') f.update('assets', { file_size: null });
  else f.update('assets', { metadata: JSON.stringify({
    tenant_id: f.tenantId, user_id: f.user.id,
    ...(legacy === 'fingerprint-only' ? { source_fingerprint: f.fingerprint } : {}),
  }) });
  const before = dbState(f.db);
  await assertPlayableDraft(f, await f.get());
  assert.deepEqual(dbState(f.db), before);
});
}

for (const location of ['storage-root', 'ancestor', 'final']) {
test(`motion-draft rejects ${location} symlink or junction without skip`, async (t) => {
  const f = await fixture(t);
  if (location === 'storage-root') {
    const moved = path.join(f.root, 'moved');
    fs.renameSync(f.storageRoot, moved);
    fs.symlinkSync(moved, f.storageRoot, 'junction');
  } else {
    const link = path.join(f.storageRoot, location === 'ancestor' ? 'linked' : 'linked.mp4');
    fs.symlinkSync(f.root, link, 'junction');
    f.update('assets', { local_path: location === 'ancestor' ? 'linked/storage/source.mp4' : 'linked.mp4' });
  }
  const before = dbState(f.db);
  await assertError(f, await f.get(), 409, 'UNAVAILABLE');
  assert.deepEqual(dbState(f.db), before);
});
}

test('motion-draft rejects fractional/inconsistent/out-of-source shot bounds and source-duration drift', async (t) => {
  const f = await fixture(t);
  for (const values of [{ start_ms: 1000.5 }, { end_ms: 2300.5 }, { duration_ms: 999 }, { end_ms: 13000, duration_ms: 12000 }]) {
    f.update('redraw_shots', values);
    const before = dbState(f.db);
    await assertError(f, await f.get(), 409, 'UNAVAILABLE');
    assert.deepEqual(dbState(f.db), before);
    f.update('redraw_shots', { start_ms: 1000, end_ms: 2300, duration_ms: 1300 });
  }
  f.update('redraw_works', { duration_ms: 15000 });
  const before = dbState(f.db);
  await assertError(f, await f.get(), 409, 'UNAVAILABLE');
  assert.deepEqual(dbState(f.db), before);
});

function trackHandles(t, f, opened) {
  const open = fs.promises.open.bind(fs.promises);
  const handles = new Set();
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    handles.add(handle);
    const close = handle.close.bind(handle);
    handle.close = async () => { try { return await close(); } finally { handles.delete(handle); } };
    opened?.(handle, ...args);
    return handle;
  });
  return handles;
}

test('motion-draft also accepts an already silent source without adding audio or writes', async (t) => {
  const f = await fixture(t, { audio: false });
  const before = dbState(f.db);
  await assertPlayableDraft(f, await f.get());
  assert.deepEqual(dbState(f.db), before);
});

for (const drift of ['shot', 'version', 'work', 'source', 'source-file']) {
test(`motion-draft revalidates ${drift} after real ffmpeg and closes private FDs`, async (t) => {
  let f;
  let afterDrift;
  f = await fixture(t, { runner(command, args, options) {
    assert.ok(options.signal instanceof AbortSignal);
    const operation = execAsync(command, args, options);
    if (!args.includes('-c:v')) return operation;
    const changed = operation.then((result) => {
      if (drift === 'shot') f.update('redraw_shots', { start_ms: 1100, duration_ms: 1200 });
      if (drift === 'version') f.update('redraw_versions', { updated_at: 'new-version' });
      if (drift === 'work') f.update('redraw_works', { source_fingerprint: 'a'.repeat(64) });
      if (drift === 'source') f.update('assets', { local_path: 'other.mp4' });
      if (drift === 'source-file') fs.appendFileSync(f.sourcePath, 'changed-after-snapshot');
      afterDrift = dbState(f.db);
      return result;
    });
    changed.child = operation.child;
    return changed;
  } });
  const handles = trackHandles(t, f);
  await assertError(f, await f.get(), 409, 'CONFLICT');
  assert.ok(afterDrift);
  assert.deepEqual(dbState(f.db), afterDrift);
  assert.equal(handles.size, 0);
});
}

test('motion-draft rechecks owner after fixed-FD stream creation before headers', async (t) => {
  const f = await fixture(t);
  let afterDrift;
  const handles = trackHandles(t, f, (handle, filename) => {
    if (!String(filename).endsWith('.mp4') || filename === f.sourcePath) return;
    const create = handle.createReadStream.bind(handle);
    handle.createReadStream = (...args) => {
      f.update('redraw_shots', { user_id: 'foreign' });
      afterDrift = dbState(f.db);
      return create(...args);
    };
  });
  await assertError(f, await f.get(), 404, 'NOT_FOUND');
  assert.deepEqual(dbState(f.db), afterDrift);
  assert.equal(handles.size, 0);
});

test('motion-draft real ffmpeg failure leaves no draft or database writes', async (t) => {
  const f = await fixture(t, { runner(command, args, options) {
    return execAsync(command, args.includes('-c:v') ? ['-motion-draft-invalid-local-option'] : args, options);
  } });
  const handles = trackHandles(t, f);
  const before = dbState(f.db);
  await assertError(f, await f.get(), 409, 'UNAVAILABLE');
  assert.deepEqual(dbState(f.db), before);
  assert.equal(handles.size, 0);
});

test('motion-draft abort kills and awaits the child before cleaning only its own directory', { timeout: 15000 }, async (t) => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let child;
  let closed = false;
  let directoryStillExistsAtClose = false;
  const f = await fixture(t, { runner(command, args, options) {
    assert.ok(options.signal instanceof AbortSignal);
    if (!args.includes('-c:v')) return execAsync(command, args, options);
    const operation = execAsync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    child = operation.child;
    child.once('close', () => {
      closed = true;
      directoryStillExistsAtClose = fs.existsSync(path.dirname(args.at(-1)));
    });
    started('child');
    return operation;
  } });
  const unrelated = path.join(f.tempRoot, 'other-request');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'keep'), 'untouched');
  const handles = trackHandles(t, f);
  const before = dbState(f.db);
  const client = http.get(f.url(), { headers: { Authorization: `Bearer ${f.token}` } });
  client.once('response', (res) => { res.resume(); started(res.statusCode); });
  client.on('error', () => {});
  t.after(() => { client.destroy(); if (child && !closed) child.kill(); });
  assert.equal(await ready, 'child');
  client.destroy();
  await waitClean(f, ['other-request']);
  assert.equal(closed, true);
  assert.equal(directoryStillExistsAtClose, true);
  assert.equal(handles.size, 0);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep'), 'utf8'), 'untouched');
  assert.deepEqual(dbState(f.db), before);
});

for (const revoke of ['membership', 'tenant']) {
test(`motion-draft rejects ${revoke} revoked after real ffmpeg before sending media`, async (t) => {
  let f;
  let afterRevocation;
  let revocations = 0;
  f = await fixture(t, { runner(command, args, options) {
    const operation = execAsync(command, args, options);
    if (!args.includes('-c:v')) return operation;
    const revoked = operation.then((result) => {
      const update = revoke === 'membership'
        ? f.db.prepare("UPDATE tenant_members SET status = 'disabled' WHERE tenant_id = ? AND user_id = ?")
          .run(f.tenantId, f.user.id)
        : f.db.prepare("UPDATE tenants SET status = 'disabled' WHERE id = ?").run(f.tenantId);
      assert.equal(update.changes, 1);
      revocations += 1;
      afterRevocation = dbState(f.db);
      return result;
    });
    revoked.child = operation.child;
    return revoked;
  } });
  const handles = trackHandles(t, f);
  const res = await f.get();
  const bytes = Buffer.from(await res.arrayBuffer());
  await waitClean(f);
  assert.equal(revocations, 1);
  assert.equal(handles.size, 0);
  assert.deepEqual(dbState(f.db), afterRevocation);
  await assertError(f, await f.get(), 404, 'NOT_FOUND');
  assert.deepEqual(dbState(f.db), afterRevocation);
  assert.equal(res.status, 404, 'the in-flight response must also reject the revoked tenant/member');
  const body = JSON.parse(bytes.toString('utf8'));
  assert.equal(body.error.code, 'REDRAW_MOTION_DRAFT_NOT_FOUND');
  for (const hidden of [f.root, f.sourcePath, f.fingerprint]) assert.equal(bytes.toString('utf8').includes(hidden), false);
});
}
