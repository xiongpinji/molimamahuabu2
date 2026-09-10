'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile, ChildProcess } = require('node:child_process');
const { promisify } = require('node:util');
const { getFfprobePath } = require('../src/utils/ffmpegPath');
const { fixture, snapshot, unchanged, assertSafe } = require('./helpers/redrawExecutionRunHttpFixture');
const { openExecutionUnitCandidate } = require('../src/services/redrawSourceConditioningService');
const { prepareExecutionUnitCandidateMedia } = require('../src/services/redrawExecutionUnitReviewService');

function candidateHandles(t, filename, onStream) {
  const live = new Set(), entries = [], records = new Map(); let opens = 0, waiters = [];
  const open = fs.openSync, close = fs.closeSync, closeAsync = fs.close, stream = fs.createReadStream;
  const settled = () => live.size === 0 && entries.every(entry => entry.pending === 0);
  const notify = () => { if (settled()) { for (const resolve of waiters) resolve(); waiters = []; } };
  t.mock.method(fs, 'openSync', (...args) => {
    const fd = open(...args);
    records.delete(fd);
    if (args[0] === filename) {
      live.add(fd); opens += 1;
      const entry = { fd, closes: 0, pending: 0 }; entries.push(entry); records.set(fd, entry);
    }
    return fd;
  });
  t.mock.method(fs, 'closeSync', fd => {
    const entry = records.get(fd); if (entry) entry.closes += 1;
    const result = close(fd); live.delete(fd);
    notify();
    return result;
  });
  t.mock.method(fs, 'close', (fd, callback) => {
    const entry = records.get(fd);
    if (entry) { entry.closes += 1; entry.pending += 1; }
    return closeAsync(fd, error => {
      if (entry) { entry.pending -= 1; live.delete(fd); }
      callback(error); notify();
    });
  });
  t.mock.method(fs, 'createReadStream', (file, options) => {
    const result = stream(file, options);
    if (file === filename) {
      assert.ok(live.has(options.fd)); assert.equal(options.autoClose, false);
      onStream?.(options.fd, result);
    }
    return result;
  });
  return { live, entries, get opens() { return opens; }, async closed() {
    if (!settled()) await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('candidate FD not closed')), 5000);
      waiters.push(() => { clearTimeout(timeout); resolve(); });
    });
    assert.equal(live.size, 0);
  } };
}

function privateCandidate(h) {
  const attempt = h.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=?').get(h.attemptId);
  const artifact = JSON.parse(attempt.quality_json).candidate;
  const filename = path.join(h.root, artifact.relative_path);
  assert.ok(filename.startsWith(h.root + path.sep));
  return { attempt, artifact, filename };
}

test('real owned unit candidate bytes are served through its authenticated media route', async t => {
  const h = await fixture(t, { stage: 'bound' });
  const candidate = await h.makeCandidate();
  const handles = candidateHandles(t, privateCandidate(h).filename);
  const before = snapshot(h);
  const suffix = `/execution-runs/${h.run.id}/units/${encodeURIComponent(h.unitId)}/candidate/media`
    + `?expected_candidate_hash=${candidate.candidate_hash}`;
  const res = await h.request(suffix);
  assert.equal(res.status, 200, 'actual dispatched candidate needs its owned unit HTTP media route');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(bytes, h.transport.bytes);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('content-length'), String(bytes.length));
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-content-sha256'), createHash('sha256').update(bytes).digest('hex'));
  const downloaded = path.join(h.ctx.tempRoot, 'http-downloaded-candidate.mp4');
  fs.writeFileSync(downloaded, bytes, { flag: 'wx' });
  const { stdout } = await promisify(execFile)(getFfprobePath(),
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', downloaded],
    { windowsHide: true, timeout: 20000 });
  const probe = JSON.parse(stdout);
  assert.ok(probe.streams.some(stream => stream.codec_type === 'video'));
  assert.ok(Number(probe.format.duration) > 0);
  await handles.closed();
  assert.ok(handles.opens > 0);
  assert.ok(handles.entries.every(entry => entry.closes === 1), JSON.stringify(handles.entries));
  unchanged(h, before);
});

test('HTTP candidate media rejects mismatched hashes, binding changes and missing or changed bytes without writes', async t => {
  const h = await fixture(t, { stage: 'bound' });
  const candidate = await h.makeCandidate();
  const { attempt, artifact, filename } = privateCandidate(h);
  const endpoint = `/execution-runs/${h.run.id}/units/${h.unitId}/candidate/media`;
  const query = `?expected_candidate_hash=${candidate.candidate_hash}`;
  const handles = candidateHandles(t, filename);
  async function rejected(suffix, status) {
    const before = snapshot(h), res = await h.request(suffix);
    assert.equal(res.status, status, suffix); assertSafe(await res.json());
    await handles.closed(); unchanged(h, before);
  }
  await rejected(endpoint, 400);
  await rejected(endpoint + query + query.replace('?', '&'), 400);
  await rejected(`${endpoint}?expected_candidate_hash=${'0'.repeat(64)}`, 409);
  const asset = h.db.prepare('SELECT metadata FROM assets WHERE id=?').get(artifact.asset_id);
  h.db.prepare('UPDATE assets SET metadata=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(asset.metadata), user_id: 'foreign' }), artifact.asset_id);
  await rejected(endpoint + query, 409);
  h.db.prepare('UPDATE assets SET metadata=? WHERE id=?').run(asset.metadata, artifact.asset_id);
  h.db.prepare("UPDATE tenant_usage_reservations SET status='refunded' WHERE id=?").run(attempt.reservation_id);
  await rejected(endpoint + query, 409);
  h.db.prepare("UPDATE tenant_usage_reservations SET status='held' WHERE id=?").run(attempt.reservation_id);
  const bytes = fs.readFileSync(filename), changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
  fs.writeFileSync(filename, changed);
  await rejected(endpoint + query, 409);
  fs.writeFileSync(filename, bytes);
  const retained = filename + '.retained-test';
  fs.renameSync(filename, retained);
  try { await rejected(endpoint + query, 409); }
  finally { fs.renameSync(retained, filename); }
  assert.ok(handles.opens > 0);
});

test('candidate probe sees real post-read file loss or corruption as conflict while unchanged-file tool failure stays internal', async t => {
  const h = await fixture(t, { stage: 'bound' });
  const candidate = await h.makeCandidate();
  const { filename } = privateCandidate(h), bytes = fs.readFileSync(filename);
  const endpoint = `/execution-runs/${h.run.id}/units/${h.unitId}/candidate/media?expected_candidate_hash=${candidate.candidate_hash}`;
  const handles = candidateHandles(t, filename);
  for (const kind of ['missing', 'corrupt', 'tool_failure']) {
    const spawn = ChildProcess.prototype.spawn; let injected = 0;
    const retained = filename + '.retained-probe-test';
    const fault = t.mock.method(ChildProcess.prototype, 'spawn', function(options) {
      if (options.file === getFfprobePath() && options.args.includes(filename)) {
        injected += 1;
        assert.equal(injected, 1);
        if (kind === 'missing') fs.renameSync(filename, retained);
        else if (kind === 'corrupt') fs.writeFileSync(filename, Buffer.alloc(bytes.length));
        else throw Object.assign(new Error('synthetic private probe execution failure'), { code: 'EIO' });
      }
      return spawn.call(this, options);
    });
    const before = snapshot(h);
    try {
      const res = await h.request(endpoint);
      assert.equal(injected, 1, 'fault must occur at the actual candidate ffprobe spawn after its initial file check');
      assert.equal(res.status, kind === 'tool_failure' ? 500 : 409, kind);
      const body = await res.json(); assertSafe(body);
      assert.equal(body.error.code, kind === 'tool_failure' ? 'INTERNAL_ERROR' : 'REDRAW_UNIT_RESULT_INVALID');
      assert.doesNotMatch(JSON.stringify(body), /synthetic private|ffprobe|\.mp4/);
      await handles.closed(); unchanged(h, before);
    } finally {
      fault.mock.restore();
      if (kind === 'missing' && fs.existsSync(retained)) fs.renameSync(retained, filename);
      if (kind === 'corrupt') fs.writeFileSync(filename, bytes);
    }
  }
  assert.ok(handles.entries.every(entry => entry.closes === 1), JSON.stringify(handles.entries));
});

test('candidate media rechecks active user, token, membership and tenant after stream creation before headers', async t => {
  const h = await fixture(t, { stage: 'bound' });
  const candidate = await h.makeCandidate();
  const { filename } = privateCandidate(h);
  const endpoint = `/execution-runs/${h.run.id}/units/${h.unitId}/candidate/media?expected_candidate_hash=${candidate.candidate_hash}`;
  let mutate;
  const handles = candidateHandles(t, filename, () => { const fn = mutate; mutate = null; fn?.(); });
  for (const [sql, args, reset, status] of [
    ['UPDATE tenant_members SET status=? WHERE tenant_id=? AND user_id=?', ['disabled', h.actor.tenantId, h.actor.user.id], 'active', 404],
    ['UPDATE tenants SET status=? WHERE id=?', ['disabled', h.actor.tenantId], 'active', 404],
    ['UPDATE platform_users SET status=? WHERE id=?', ['disabled', h.actor.user.id], 'active', 401],
    ['UPDATE platform_users SET token_version=? WHERE id=?', [1, h.actor.user.id], 0, 401],
  ]) {
    let expected;
    mutate = () => { h.db.prepare(sql).run(...args); expected = snapshot(h); };
    const res = await h.request(endpoint);
    assert.equal(res.status, status, sql); assertSafe(await res.json());
    await handles.closed(); assert.ok(expected); unchanged(h, expected);
    h.db.prepare(sql).run(reset, ...args.slice(1));
  }
});

test('retained candidate FD rejects identical path replacement and closes once without consuming another stream', async t => {
  const h = await fixture(t, { stage: 'bound' });
  await h.makeCandidate();
  const { artifact, filename } = privateCandidate(h);
  const handles = candidateHandles(t, filename);
  const media = openExecutionUnitCandidate({ storageRoot: h.root, runId: h.run.id, attemptId: h.attemptId }, artifact);
  const retained = filename + '.retained-fd-test';
  fs.renameSync(filename, retained);
  fs.copyFileSync(retained, filename, fs.constants.COPYFILE_EXCL);
  try {
    assert.throws(() => media.assertCurrentBinding(), { code: 'REDRAW_UNIT_RESULT_INVALID' });
    assert.throws(() => media.createReadStream(), { code: 'REDRAW_UNIT_RESULT_INVALID' });
  } finally {
    media.cleanup(); media.cleanup();
    fs.renameSync(retained, filename);
  }
  await handles.closed(); assert.equal(handles.opens, 1);
});

for (const interruption of ['client_abort', 'stream_error']) test(`${interruption} waits for an in-flight candidate read callback before closing its borrowed FD`, { timeout: 60000 }, async t => {
  const h = await fixture(t, { stage: 'bound' });
  const candidate = await h.makeCandidate();
  const { filename } = privateCandidate(h);
  let fd, activeStream, releaseRead, startedRead, destroyedStream;
  const started = new Promise(resolve => { startedRead = resolve; });
  const destroyed = new Promise(resolve => { destroyedStream = resolve; });
  t.after(() => releaseRead?.());
  const handles = candidateHandles(t, filename, (descriptor, stream) => {
    fd = descriptor; activeStream = stream;
    const destroy = stream.destroy.bind(stream);
    t.mock.method(stream, 'destroy', (...args) => { const result = destroy(...args); destroyedStream(); return result; });
  });
  const read = fs.read;
  t.mock.method(fs, 'read', (descriptor, ...args) => {
    if (descriptor !== fd || releaseRead) return read(descriptor, ...args);
    const callback = args.pop();
    return read(descriptor, ...args, (...result) => {
      let released = false;
      releaseRead = () => { if (!released) { released = true; callback(...result); } };
      startedRead();
    });
  });
  const before = snapshot(h);
  const request = http.get(h.url(`/execution-runs/${h.run.id}/units/${h.unitId}/candidate/media?expected_candidate_hash=${candidate.candidate_hash}`),
    { headers: { Authorization: `Bearer ${h.actor.token}`, 'X-Tenant-Id': h.actor.tenantId } });
  request.on('error', () => {});
  t.after(() => request.destroy());
  await started;
  if (interruption === 'client_abort') request.destroy();
  else activeStream.destroy(new Error('synthetic candidate stream error'));
  await destroyed;
  await new Promise(setImmediate);
  try { assert.ok(handles.live.has(fd), 'physical FD must stay open until its pending read callback returns'); }
  finally { releaseRead(); }
  await handles.closed();
  assert.ok(handles.entries.every(entry => entry.closes === 1), JSON.stringify(handles.entries));
  unchanged(h, before);
});

test('a final prepare database failure closes the retained candidate FD before it can escape to the route', async t => {
  const h = await fixture(t, { stage: 'bound' });
  const candidate = await h.makeCandidate();
  const handles = candidateHandles(t, privateCandidate(h).filename);
  const before = snapshot(h), prepare = h.db.prepare.bind(h.db); let denied = 0;
  const fault = t.mock.method(h.db, 'prepare', sql => {
    if (handles.live.size) { denied += 1; throw Object.assign(new Error('synthetic final material read'), { code: 'SQLITE_IOERR' }); }
    return prepare(sql);
  });
  try {
    await assert.rejects(prepareExecutionUnitCandidateMedia(h.ctx, h.versionId, h.run.id, h.unitId, candidate.candidate_hash),
      { code: 'SQLITE_IOERR' });
  } finally { fault.mock.restore(); }
  assert.ok(denied > 0); assert.ok(handles.opens > 0);
  await handles.closed();
  assert.ok(handles.entries.every(entry => entry.closes === 1), JSON.stringify(handles.entries));
  unchanged(h, before);
});
