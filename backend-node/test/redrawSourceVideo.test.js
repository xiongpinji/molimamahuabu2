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

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const NOW = '2026-09-05T00:00:00.000Z';
// These bytes exercise binding/race checks only, not video decoding.
const RACE_BYTES = Buffer.concat([Buffer.from('0000ftypisom'), Buffer.alloc(150000, 7)]);

async function fixture(t, { ext = '.mp4', decode = false, size = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-source-video-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storageRoot = path.join(root, 'storage');
  const tempRoot = path.join(root, 'private');
  fs.mkdirSync(storageRoot);
  fs.mkdirSync(tempRoot);
  const sourcePath = path.join(storageRoot, `source${ext}`);
  if (decode) {
    execFileSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'color=c=blue:s=64x64:r=5', '-t', '0.4', '-c:v', 'mpeg4', sourcePath],
    { windowsHide: true, timeout: 20000 });
  } else fs.writeFileSync(sourcePath, size ? Buffer.alloc(size, 7) : RACE_BYTES);
  const bytes = fs.readFileSync(sourcePath);
  const fingerprint = sha(bytes);
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const previous = { publicMode: process.env.PUBLIC_PLATFORM_MODE, secret: process.env.PLATFORM_JWT_SECRET };
  const secret = 'redraw-source-video-test-secret-at-least-32-bytes';
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = secret;
  const user = userAuth.register(db, {
    email: `${crypto.randomUUID()}@example.test`, password: 'source-video-fixture-123',
  });
  tenantService.ensurePersonalTenant(db, user);
  const tenantId = `personal:${user.id}`;
  const token = userAuth.issueToken(user, secret, 0);
  const metadata = { tenant_id: tenantId, user_id: user.id, sha256: fingerprint, source_fingerprint: fingerprint };
  const assetId = Number(db.prepare(`INSERT INTO assets
    (name, type, category, url, local_path, file_size, mime_type, metadata, created_at, updated_at)
    VALUES ('source', 'video', 'redraw_source', '/static/not-used', ?, ?, ?, ?, ?, ?)`)
    .run(path.basename(sourcePath), bytes.length, 'malicious/type', JSON.stringify(metadata), NOW, NOW).lastInsertRowid);
  const projectId = Number(db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, created_at, updated_at) VALUES (?, ?, 'source-video', ?, ?)`)
    .run(tenantId, user.id, NOW, NOW).lastInsertRowid);
  const workId = Number(db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (?, ?, ?, 'source-video', ?, ?, 12000, ?, ?)`)
    .run(projectId, tenantId, user.id, assetId, fingerprint, NOW, NOW).lastInsertRowid);
  const providerCalls = [];
  const forbiddenProvider = async () => { providerCalls.push('called'); throw new Error('unexpected provider call'); };
  const router = setupRouter({ storage: { local_path: storageRoot } }, db, {
    error() {}, warn() {}, info() {},
  }, {
    localizationProvider: forbiddenProvider, assetGenerationProvider: forbiddenProvider,
    dialogueProvider: forbiddenProvider, redrawOptions: { sourceVideoTempRoot: tempRoot },
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
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/redraw/works`;
  const query = `expected_source_asset_id=${assetId}&expected_source_sha256=${fingerprint}`;
  return {
    root, storageRoot, tempRoot, sourcePath, bytes, fingerprint, db, user, tenantId, token, secret,
    assetId, workId, metadata, router, query,
    url: (q = query, id = workId) => `${baseUrl}/${id}/source-video?${q}`,
    get(q = query, headers = {}, id = workId) {
      return fetch(`${baseUrl}/${id}/source-video?${q}`, { headers: { Authorization: `Bearer ${token}`, ...headers } });
    },
    updateAsset(values) {
      for (const [key, value] of Object.entries(values)) db.prepare(`UPDATE assets SET ${key} = ? WHERE id = ?`).run(value, assetId);
    },
    updateWork(values) {
      for (const [key, value] of Object.entries(values)) db.prepare(`UPDATE redraw_works SET ${key} = ? WHERE id = ?`).run(value, workId);
    },
  };
}

async function waitClean(f) {
  for (let i = 0; i < 100; i += 1) {
    if (fs.readdirSync(f.tempRoot).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(fs.readdirSync(f.tempRoot), [], 'request snapshots were removed');
}

test('source snapshot privately retains an operational I/O cause without changing its public error', async t => {
  const f = await fixture(t), { prepareSourceVideo } = require('../src/services/redrawSourceVideoService');
  const original = fs.promises.open, injected = Object.assign(new Error('PRIVATE filesystem path'), { code: 'EACCES' });
  fs.promises.open = async function(file, ...args) {
    if (path.resolve(String(file)) === path.resolve(f.sourcePath)) throw injected;
    return original.call(this, file, ...args);
  };
  try {
    await assert.rejects(prepareSourceVideo({ db: f.db, storageRoot: f.storageRoot, tempRoot: f.tempRoot },
      { tenantId: f.tenantId, userId: f.user.id, workId: f.workId, expectedSourceAssetId: f.assetId, expectedSourceSha256: f.fingerprint }), error => {
      assert.equal(error.code, 'REDRAW_SOURCE_VIDEO_UNAVAILABLE');
      assert.equal(error.message, 'REDRAW_SOURCE_VIDEO_UNAVAILABLE');
      assert.equal(error.cause, injected);
      assert.equal(Object.getOwnPropertyDescriptor(error, 'cause').enumerable, false);
      assert.equal(JSON.stringify(error).includes('PRIVATE'), false); return true;
    });
  } finally { fs.promises.open = original; }
  await waitClean(f);
});

async function assertError(f, response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.code, code);
  const json = JSON.stringify(body);
  assert.equal(json.includes(f.root), false);
  assert.equal(json.includes(f.sourcePath), false);
  assert.equal(json.includes(f.fingerprint), false);
  await waitClean(f);
}

for (const [ext, mime] of [['.mp4', 'video/mp4'], ['.mov', 'video/quicktime']]) {
  test(`source-video real authenticated GET returns decodable ${ext} snapshot and no business writes`, async (t) => {
    const f = await fixture(t, { ext, decode: true });
    const before = sha(f.db.serialize());
    const beforeChanges = f.db.prepare('SELECT total_changes() AS count').get().count;
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const res = await f.get(undefined, { Range: 'bytes=0-20' });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), mime);
      assert.equal(res.headers.get('content-length'), String(f.bytes.length));
      assert.equal(res.headers.get('content-disposition'), 'inline');
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-content-sha256'), f.fingerprint);
      const received = Buffer.from(await res.arrayBuffer());
      assert.deepEqual(received, f.bytes);
      assert.equal(sha(received), f.fingerprint);
      const playback = path.join(f.root, `received-${repeat}${ext}`);
      fs.writeFileSync(playback, received);
      const probe = JSON.parse(execFileSync(getFfprobePath(), ['-v', 'error', '-show_streams', '-of', 'json', playback],
        { windowsHide: true, timeout: 20000, encoding: 'utf8' }));
      assert.equal(probe.streams.some((stream) => stream.codec_type === 'video' && stream.width === 64), true);
      await waitClean(f);
    }
    assert.equal(sha(f.db.serialize()), before);
    assert.equal(f.db.prepare('SELECT total_changes() AS count').get().count, beforeChanges);
  });
}

test('source-video rejects unauthenticated/cookie-only and foreign tenant/user requests', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url())).status, 401);
  assert.equal((await fetch(f.url(), { headers: { Cookie: `platform_session=${f.token}` } })).status, 401);
  assert.equal((await f.get(undefined, { 'X-Tenant-Id': 'foreign' })).status, 404);
  const other = userAuth.register(f.db, { email: `${crypto.randomUUID()}@example.test`, password: 'source-video-fixture-456' });
  await assertError(f, await f.get(undefined, { Authorization: `Bearer ${userAuth.issueToken(other, f.secret, 0)}` }),
    404, 'REDRAW_SOURCE_VIDEO_NOT_FOUND');
  f.updateWork({ user_id: other.id });
  await assertError(f, await f.get(), 404, 'REDRAW_SOURCE_VIDEO_NOT_FOUND');
});

function databaseState(db) {
  return {
    sha256: sha(db.serialize()),
    changes: db.prepare('SELECT total_changes() AS count').get().count,
    tenants: db.prepare('SELECT count(*) AS count FROM tenants').get().count,
    memberships: db.prepare('SELECT count(*) AS count FROM tenant_members').get().count,
  };
}

test('source-video fresh foreign user without personal tenant is rejected with zero database writes', async (t) => {
  const f = await fixture(t);
  const other = userAuth.register(f.db, { email: `${crypto.randomUUID()}@example.test`, password: 'source-video-fresh-123' });
  const token = userAuth.issueToken(other, f.secret, 0);
  const before = databaseState(f.db);
  await assertError(f, await f.get(undefined, { Authorization: `Bearer ${token}` }), 404, 'REDRAW_SOURCE_VIDEO_NOT_FOUND');
  assert.deepEqual(databaseState(f.db), before);
});

test('source-video existing active team membership can read its owned source without database writes', async (t) => {
  const f = await fixture(t);
  const tenant = tenantService.createTenant(f.db, f.user.id, { name: 'Source video team', slug: `video-${crypto.randomUUID()}` });
  f.updateWork({ tenant_id: tenant.id });
  f.updateAsset({ metadata: JSON.stringify({ ...f.metadata, tenant_id: tenant.id }) });
  const before = databaseState(f.db);
  const res = await f.get(undefined, { 'X-Tenant-Id': tenant.id });
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), f.bytes);
  await waitClean(f);
  assert.deepEqual(databaseState(f.db), before);
});

for (const state of ['no-membership', 'disabled-member', 'disabled-tenant']) {
  test(`source-video ${state} is rejected with zero database writes`, async (t) => {
    const f = await fixture(t);
    if (state === 'no-membership') f.db.prepare('DELETE FROM tenant_members WHERE tenant_id = ? AND user_id = ?').run(f.tenantId, f.user.id);
    if (state === 'disabled-member') f.db.prepare("UPDATE tenant_members SET status = 'disabled' WHERE tenant_id = ? AND user_id = ?").run(f.tenantId, f.user.id);
    if (state === 'disabled-tenant') f.db.prepare("UPDATE tenants SET status = 'disabled' WHERE id = ?").run(f.tenantId);
    const before = databaseState(f.db);
    const res = await f.get();
    assert.equal(res.status, 404);
    await res.arrayBuffer();
    await waitClean(f);
    assert.deepEqual(databaseState(f.db), before);
  });
}

test('source-video read-only tenant entry leaves adjacent routes personal-tenant initialization unchanged', async (t) => {
  const f = await fixture(t);
  const other = userAuth.register(f.db, { email: `${crypto.randomUUID()}@example.test`, password: 'source-video-adjacent-123' });
  const token = userAuth.issueToken(other, f.secret, 0);
  assert.equal(f.db.prepare('SELECT id FROM tenants WHERE id = ?').get(`personal:${other.id}`), undefined);
  const projectsUrl = f.url().replace(/\/redraw\/works\/.*$/, '/redraw/projects');
  const res = await fetch(projectsUrl, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  assert.ok(f.db.prepare('SELECT id FROM tenants WHERE id = ?').get(`personal:${other.id}`));
  assert.ok(f.db.prepare('SELECT tenant_id FROM tenant_members WHERE tenant_id = ? AND user_id = ?').get(`personal:${other.id}`, other.id));
});

test('source-video rejects unknown, repeated, noncanonical, missing query and invalid work IDs', async (t) => {
  const f = await fixture(t);
  const invalid = ['', f.query + '&path=source.mp4', f.query + '&url=https://example.test',
    f.query + '&__proto__[path]=source.mp4', f.query + '&expected_source_asset_id=1',
    f.query + '&expected_source_sha256=' + f.fingerprint, f.query + '&tenant_id=foreign',
    `expected_source_asset_id=01&expected_source_sha256=${f.fingerprint}`,
    `expected_source_asset_id=9007199254740992&expected_source_sha256=${f.fingerprint}`,
    `expected_source_asset_id=1e0&expected_source_sha256=${f.fingerprint}`,
    `expected_source_asset_id=-1&expected_source_sha256=${f.fingerprint}`,
    `expected_source_asset_id=1&expected_source_sha256=${f.fingerprint.toUpperCase()}`,
    `expected_source_asset_id=1&expected_source_sha256=${'a'.repeat(63)}`];
  for (const query of invalid) await assertError(f, await f.get(query), 400, 'REDRAW_SOURCE_VIDEO_INPUT_INVALID');
  for (const id of ['0', '01', '1e0', '9007199254740992']) {
    await assertError(f, await f.get(undefined, {}, id), 400, 'REDRAW_SOURCE_VIDEO_INPUT_INVALID');
  }
});

test('source-video checks owner before expected CAS and rejects stale expected source bindings', async (t) => {
  const f = await fixture(t);
  await assertError(f, await f.get(f.query.replace(`asset_id=${f.assetId}`, 'asset_id=9999')), 409, 'REDRAW_SOURCE_VIDEO_CONFLICT');
  await assertError(f, await f.get(f.query.replace(f.fingerprint, 'f'.repeat(64))), 409, 'REDRAW_SOURCE_VIDEO_CONFLICT');
  f.updateWork({ user_id: 'not-current-user' });
  await assertError(f, await f.get(f.query.replace(f.fingerprint, 'f'.repeat(64))), 404, 'REDRAW_SOURCE_VIDEO_NOT_FOUND');
});

for (const target of ['work', 'asset']) {
  test(`source-video treats soft-deleted ${target} as missing`, async (t) => {
    const f = await fixture(t);
    (target === 'work' ? f.updateWork : f.updateAsset)({ deleted_at: NOW });
    await assertError(f, await f.get(), 404, 'REDRAW_SOURCE_VIDEO_NOT_FOUND');
  });
}

const invalidAssets = {
  tenant: (f) => ({ metadata: JSON.stringify({ ...f.metadata, tenant_id: 'other' }) }),
  user: (f) => ({ metadata: JSON.stringify({ ...f.metadata, user_id: 'other' }) }),
  hash: (f) => ({ metadata: JSON.stringify({ ...f.metadata, sha256: 'b'.repeat(64) }) }),
  fingerprint: (f) => ({ metadata: JSON.stringify({ ...f.metadata, source_fingerprint: 'B'.repeat(64) }) }),
  metadata: () => ({ metadata: '{broken' }),
  type: () => ({ type: 'audio' }),
  category: () => ({ category: 'other' }),
  size: () => ({ file_size: 1 }),
  negativeSize: () => ({ file_size: -1 }),
  fractionalSize: () => ({ file_size: 1.5 }),
  missing: () => ({ local_path: 'missing.mp4' }),
  absolute: (f) => ({ local_path: f.sourcePath }),
  traversal: () => ({ local_path: '../storage/source.mp4' }),
  windowsAbsolute: () => ({ local_path: 'C:\\source.mp4' }),
  unsupported: () => ({ local_path: 'source.webm' }),
};
for (const [name, values] of Object.entries(invalidAssets)) {
  test(`source-video safely rejects invalid registered asset ${name}`, async (t) => {
    const f = await fixture(t);
    f.updateAsset(values(f));
    await assertError(f, await f.get(), ['tenant', 'user'].includes(name) ? 404 : 409,
      ['tenant', 'user'].includes(name) ? 'REDRAW_SOURCE_VIDEO_NOT_FOUND' : 'REDRAW_SOURCE_VIDEO_UNAVAILABLE');
  });
}

test('source-video requires canonical work fingerprint and rejects file content drift', async (t) => {
  const f = await fixture(t);
  for (const fingerprint of ['', 'f'.repeat(63), f.fingerprint.toUpperCase()]) {
    f.updateWork({ source_fingerprint: fingerprint });
    await assertError(f, await f.get(), 409, 'REDRAW_SOURCE_VIDEO_UNAVAILABLE');
  }
  f.updateWork({ source_fingerprint: f.fingerprint });
  fs.writeFileSync(f.sourcePath, Buffer.alloc(f.bytes.length, 9));
  await assertError(f, await f.get(), 409, 'REDRAW_SOURCE_VIDEO_UNAVAILABLE');
});

test('source-video preserves registered legacy upload with null file_size', async (t) => {
  const f = await fixture(t);
  f.updateAsset({ file_size: null });
  const res = await f.get();
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), f.bytes);
  await waitClean(f);
});

for (const location of ['storage-root', 'ancestor', 'final']) {
  test(`source-video rejects ${location} symlink or Windows junction without skipping`, async (t) => {
    const f = await fixture(t);
    if (location === 'storage-root') {
      const moved = path.join(f.root, 'moved');
      fs.renameSync(f.storageRoot, moved);
      fs.symlinkSync(moved, f.storageRoot, 'junction');
    } else {
      const link = path.join(f.storageRoot, location === 'ancestor' ? 'linked' : 'linked.mp4');
      fs.symlinkSync(f.root, link, 'junction');
      f.updateAsset({ local_path: location === 'ancestor' ? 'linked/storage/source.mp4' : 'linked.mp4' });
    }
    await assertError(f, await f.get(), 409, 'REDRAW_SOURCE_VIDEO_UNAVAILABLE');
  });
}

function interceptOpen(t, f, onSource, onSnapshot) {
  const originalOpen = fs.promises.open.bind(fs.promises);
  const handles = new Set();
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    handles.add(handle);
    const close = handle.close.bind(handle);
    handle.close = async () => { try { return await close(); } finally { handles.delete(handle); } };
    if (args[0] === f.sourcePath) await onSource?.(handle);
    if (String(args[0]).endsWith('source.snapshot')) await onSnapshot?.(handle);
    return handle;
  });
  return handles;
}

test('source-video rejects a path replacement between lstat and opened FD validation', async (t) => {
  const f = await fixture(t);
  const handles = interceptOpen(t, f, () => {
    fs.renameSync(f.sourcePath, path.join(f.storageRoot, 'old.mp4'));
    fs.writeFileSync(f.sourcePath, f.bytes);
  });
  await assertError(f, await f.get(), 409, 'REDRAW_SOURCE_VIDEO_UNAVAILABLE');
  assert.equal(handles.size, 0);
});

for (const mutation of ['write', 'replace', 'grow', 'missing']) {
  test(`source-video rejects source ${mutation} during bounded copying and closes both FDs`, async (t) => {
    const f = await fixture(t);
    let readCount = 0;
    const handles = interceptOpen(t, f, (handle) => {
      const read = handle.read.bind(handle);
      handle.read = async (...args) => {
        assert.ok(args[2] <= 64 * 1024);
        const result = await read(...args);
        if (readCount++ === 0) {
          if (mutation === 'write') fs.writeFileSync(f.sourcePath, Buffer.alloc(f.bytes.length, 5));
          if (mutation === 'replace') {
            fs.renameSync(f.sourcePath, path.join(f.storageRoot, 'old.mp4'));
            fs.writeFileSync(f.sourcePath, f.bytes);
          }
          if (mutation === 'grow') fs.appendFileSync(f.sourcePath, f.bytes);
          if (mutation === 'missing') fs.unlinkSync(f.sourcePath);
        }
        return result;
      };
    });
    await assertError(f, await f.get(), 409, 'REDRAW_SOURCE_VIDEO_UNAVAILABLE');
    assert.equal(handles.size, 0);
    assert.ok(readCount <= Math.ceil(f.bytes.length / (64 * 1024)));
  });
}

test('source-video emits the exact authorized snapshot if original changes after snapshot verification', async (t) => {
  const f = await fixture(t);
  const handles = interceptOpen(t, f, (handle) => {
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      fs.writeFileSync(f.sourcePath, Buffer.alloc(f.bytes.length, 4));
    };
  });
  const res = await f.get();
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), f.bytes);
  assert.notEqual(sha(fs.readFileSync(f.sourcePath)), res.headers.get('x-content-sha256'));
  await waitClean(f);
  assert.equal(handles.size, 0);
});

const dbDrifts = {
  workOwner: { change: (f) => f.updateWork({ user_id: 'foreign' }), status: 404, code: 'NOT_FOUND' },
  workTenant: { change: (f) => f.updateWork({ tenant_id: 'foreign' }), status: 404, code: 'NOT_FOUND' },
  workDelete: { change: (f) => f.updateWork({ deleted_at: NOW }), status: 404, code: 'NOT_FOUND' },
  sourceCas: { change: (f) => f.updateWork({ source_asset_id: 9999 }), status: 409, code: 'CONFLICT' },
  hashCas: { change: (f) => f.updateWork({ source_fingerprint: 'a'.repeat(64) }), status: 409, code: 'CONFLICT' },
  assetDelete: { change: (f) => f.updateAsset({ deleted_at: NOW }), status: 404, code: 'NOT_FOUND' },
  assetOwner: { change: (f) => f.updateAsset({ metadata: JSON.stringify({ ...f.metadata, user_id: 'foreign' }) }), status: 404, code: 'NOT_FOUND' },
  assetPath: { change: (f) => f.updateAsset({ local_path: 'other.mp4' }), status: 409, code: 'CONFLICT' },
  assetSize: { change: (f) => f.updateAsset({ file_size: f.bytes.length + 1 }), status: 409, code: 'CONFLICT' },
  assetHash: { change: (f) => f.updateAsset({ metadata: JSON.stringify({ ...f.metadata, sha256: 'a'.repeat(64) }) }), status: 409, code: 'UNAVAILABLE' },
};
for (const [name, drift] of Object.entries(dbDrifts)) {
  test(`source-video rechecks ${name} DB binding after asynchronous copying`, async (t) => {
    const f = await fixture(t);
    const handles = interceptOpen(t, f, (handle) => {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); drift.change(f); };
    });
    await assertError(f, await f.get(), drift.status, `REDRAW_SOURCE_VIDEO_${drift.code}`);
    assert.equal(handles.size, 0);
  });
}

test('source-video rechecks ownership at the stream creation boundary before sending headers', async (t) => {
  const f = await fixture(t);
  const handles = interceptOpen(t, f, null, (handle) => {
    const create = handle.createReadStream.bind(handle);
    handle.createReadStream = (...args) => {
      f.updateWork({ user_id: 'foreign' });
      return create(...args);
    };
  });
  await assertError(f, await f.get(), 404, 'REDRAW_SOURCE_VIDEO_NOT_FOUND');
  assert.equal(handles.size, 0);
});

test('source-video abort during snapshot preparation stops copying and removes only that request snapshot', async (t) => {
  const f = await fixture(t, { size: 8 * 1024 * 1024 });
  const unrelated = path.join(f.tempRoot, 'other-request');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'keep'), 'untouched');
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  let firstRead;
  const started = new Promise((resolve) => { firstRead = resolve; });
  let reads = 0;
  const handles = interceptOpen(t, f, (handle) => {
    const read = handle.read.bind(handle);
    handle.read = async (...args) => {
      reads += 1;
      const result = await read(...args);
      firstRead();
      await gate;
      return result;
    };
  });
  const client = http.get(f.url(), { headers: { Authorization: `Bearer ${f.token}` } });
  client.on('error', () => {});
  await started;
  client.destroy();
  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseRead();
  for (let i = 0; i < 100 && handles.size; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(handles.size, 0);
  assert.equal(reads, 1);
  for (let i = 0; i < 100 && fs.readdirSync(f.tempRoot).length !== 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fs.readdirSync(f.tempRoot), ['other-request']);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep'), 'utf8'), 'untouched');
});

test('source-video abort after response starts closes snapshot FD and cleans request directory', async (t) => {
  const f = await fixture(t, { size: 8 * 1024 * 1024 });
  const handles = interceptOpen(t, f);
  await new Promise((resolve, reject) => {
    const client = http.get(f.url(), { headers: { Authorization: `Bearer ${f.token}` } }, (res) => {
      res.once('data', () => { client.destroy(); resolve(); });
    });
    client.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
  });
  await waitClean(f);
  assert.equal(handles.size, 0);
});
