'use strict';

// Run only through the root-approved isolated runner. Provider responses and
// unit human approvals are synthetic PRECONDITIONS, never final acceptance.
// HTTP POST, JWT, SQLite, release, Assembly, FFmpeg and the four GETs are real.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { approvedCompositionRun, compositionRequest, protectedBusinessSnapshot,
  candidateSnapshot, hash, runRow } = require('./helpers/redrawExecutionUnitCompositionFixture');
const { KEY, SECRET, BASE_URL, NOW } = require('./helpers/redrawExecutionUnitDispatchFixture');
const { setupRouter } = require('../src/routes');
const userAuth = require('../src/services/userAuthService');
const tenantService = require('../src/services/tenantService');
const composition = require('../src/services/redrawCompositionService');
const { getExecutionRun } = require('../src/services/redrawExecutionRunService');
const { getFfprobePath } = require('../src/utils/ffmpegPath');

const JWT_SECRET = 'synthetic-unit-compose-http-jwt-at-least-32-bytes';
const KINDS = ['mp4', 'srt', 'vtt', 'report'];
const MIME = { mp4: 'video/mp4', srt: 'application/x-subrip', vtt: 'text/vtt', report: 'application/json' };
const BODY_KEYS = ['schema_version', 'run_id', 'expected_plan_hash', 'expected_run_revision', 'idempotency_key'];
const log = { info() {}, warn() {}, error() {} };
const runMedia = promisify(execFile);

function registerActor(db) {
  const user = userAuth.register(db, { email: `${crypto.randomUUID()}@example.test`, password: 'synthetic-compose-http-pass-123' });
  const tenant = tenantService.ensurePersonalTenant(db, user);
  return { user, tenantId: tenant.id, token: userAuth.issueToken(user, JWT_SECRET, 0) };
}

function safe(value) {
  const serialized = JSON.stringify(value);
  for (const secret of [KEY, SECRET, JWT_SECRET]) assert.equal(serialized.includes(secret), false);
  assert.doesNotMatch(serialized, /claim_token|relative_path|local_path|absolute_path|api_key|private_binding|provider_raw|result\.synthetic\.invalid|源对白/);
}

async function fixture(t, audioMode = 'native', redrawOptions = {}, dialogueTargets) {
  const jobs = new Set();
  const previous = { mode: process.env.PUBLIC_PLATFORM_MODE, secret: process.env.PLATFORM_JWT_SECRET };
  let server;
  // Register before the lower fixture closes SQLite/removes its owned files.
  t.after(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await Promise.allSettled([...jobs]);
    for (const [key, value] of [['PUBLIC_PLATFORM_MODE', previous.mode], ['PLATFORM_JWT_SECRET', previous.secret]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const h = await approvedCompositionRun(t, audioMode, { dialogueTargets, createActor(db) {
    assert.equal(db.prepare('SELECT count(*) n FROM redraw_projects').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM redraw_execution_plan_reviews').get().n, 0);
    return registerActor(db);
  } });
  assert.equal(h.owner.userId, h.actor.user.id);
  assert.equal(h.ctx.tenantId, h.actor.tenantId);
  for (const table of ['redraw_projects', 'redraw_shots', 'redraw_execution_plan_reviews', 'redraw_execution_runs']) {
    assert.ok(h.db.prepare(`SELECT count(*) n FROM ${table}`).get().n > 0);
    assert.equal(h.db.prepare(`SELECT count(*) n FROM ${table} WHERE tenant_id<>? OR user_id<>?`)
      .get(h.actor.tenantId, h.actor.user.id).n, 0, `${table} was seeded with the actual JWT actor`);
  }
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_exports').get().n, 0,
    'the fixture must not seed or create an export before HTTP POST');
  h.calls = { creates: 0, runs: 0, other: 0 };
  const create = composition.createComposition, run = composition.runComposition;
  t.mock.method(composition, 'createComposition', async (ctx, input) => {
    h.calls.creates += 1;
    h.lastCreate = { ctx, input };
    try { return await create(ctx, input); }
    catch (error) { h.lastCreateError = error; throw error; }
  });
  t.mock.method(composition, 'runComposition', async (ctx, id) => {
    h.calls.runs += 1;
    const job = run(ctx, id); jobs.add(job);
    try { return await job; }
    finally { jobs.delete(job); }
  });
  process.env.PUBLIC_PLATFORM_MODE = 'true'; process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
  const forbidden = async () => { h.calls.other += 1; throw new Error('unexpected provider after composition POST'); };
  const app = express(); app.use(express.json());
  app.use('/api/v1', setupRouter({ storage: { local_path: h.root, base_url: BASE_URL } }, h.db, log, {
    localizationProvider: forbidden, assetGenerationProvider: forbidden, dialogueProvider: forbidden,
    providerAssetSecret: SECRET, redrawOptions: { executionRunEnv: {}, executionRunTempRoot: h.ctx.tempRoot,
      executionRunNowMs: () => Date.parse(NOW), sourceVideoTempRoot: h.ctx.tempRoot, ...redrawOptions },
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  h.origin = `http://127.0.0.1:${server.address().port}`;
  h.endpoint = `/api/v1/redraw/versions/${h.versionId}/compose`;
  h.headers = { Authorization: `Bearer ${h.actor.token}`, 'X-Tenant-Id': h.actor.tenantId };
  h.request = (endpoint, { body, headers, ...options } = {}) => fetch(h.origin + endpoint, {
    ...options, headers: { ...h.headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  h.post = (body = h.input, options = {}) => h.request(options.endpoint || h.endpoint, { method: 'POST', body, ...options });
  const { version_id: _versionId, ...input } = compositionRequest(h, 'http-unit-composition');
  h.input = input;
  assert.deepEqual(Object.keys(h.input).sort(), [...BODY_KEYS].sort());
  return h;
}

function outputSnapshot(h) {
  const root = path.join(h.root, 'redraw', `version-${h.versionId}`, 'exports');
  try { fs.lstatSync(root); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const entries = [];
  function visit(directory) {
    const stat = fs.lstatSync(directory);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isDirectory(), true);
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      const relative = path.relative(root, file).replace(/\\/g, '/');
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) { entries.push([relative, 'directory']); visit(file); }
      else {
        assert.equal(stat.isFile(), true);
        entries.push([relative, 'file', stat.size, hash(fs.readFileSync(file))]);
      }
    }
  }
  visit(root);
  return entries;
}

function publicationSnapshot(h) {
  return { business: protectedBusinessSnapshot(h), assets: h.db.prepare('SELECT * FROM assets ORDER BY id').all(),
    candidates: candidateSnapshot(h), outputs: outputSnapshot(h), providers: { ...h.syntheticCalls } };
}

function snapshot(h) {
  return { bytes: h.db.serialize(), changes: h.db.prepare('SELECT total_changes() n').get().n,
    candidates: candidateSnapshot(h), outputs: outputSnapshot(h), providers: { ...h.syntheticCalls },
    runs: h.calls.runs, other: h.calls.other, schedules: h.scheduler?.calls ?? 0 };
}

async function rejected(h, body, status, options = {}) {
  const before = snapshot(h), response = await h.post(body, options), payload = await response.json();
  safe(payload);
  assert.equal(response.status, status, JSON.stringify(payload));
  assert.match(response.headers.get('content-type'), /^application\/json\b/);
  assert.deepEqual(snapshot(h), before, 'rejection must not write business state, output bytes or schedule work');
  return payload;
}

async function waitForExport(h, id) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const response = await h.request(`/api/v1/redraw/exports/${id}`), payload = await response.json();
    safe(payload);
    assert.equal(response.status, 200, JSON.stringify(payload));
    if (!['pending', 'processing'].includes(payload.data.status)) return payload.data;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('the actual background composition did not reach a terminal export within 120 seconds');
}

async function accepted(h, input = h.input) {
  const response = await h.post(input), payload = await response.json(); safe(payload);
  assert.equal(response.status, 202, JSON.stringify(payload));
  return payload.data;
}

async function replay(h, input, id, status) {
  const before = snapshot(h), result = await accepted(h, input);
  assert.equal(result.export_id, id);
  assert.equal(result.created, false);
  assert.equal(result.status, status);
  assert.deepEqual(snapshot(h), before, `${status} replay must preserve rows, candidate/output files and scheduler count`);
}

function pauseFirstCandidateRead(t, filename) {
  // Install only after fixture approval. Preserve the real open, stream, read
  // and callback; only delay the first physical read of this exact artifact FD.
  const entries = [], live = new Set(), byFd = new Map(), mocks = [];
  const open = fs.openSync, close = fs.closeSync, create = fs.createReadStream, read = fs.read;
  const observed = { reads: 0, resumes: 0, bytes: 0 };
  let streamFd, startRead, releaseRead, intercepted = false, stopped = false;
  const started = new Promise(resolve => { startRead = resolve; });
  mocks.push(t.mock.method(fs, 'openSync', (...args) => {
    const fd = open(...args); byFd.delete(fd);
    if (args[0] === filename) {
      const entry = { fd, closes: 0, streams: 0 }; entries.push(entry); live.add(fd); byFd.set(fd, entry);
    }
    return fd;
  }));
  mocks.push(t.mock.method(fs, 'closeSync', fd => {
    const entry = byFd.get(fd); if (entry) entry.closes += 1;
    const result = close(fd); live.delete(fd); return result;
  }));
  mocks.push(t.mock.method(fs, 'createReadStream', (file, options) => {
    const value = create(file, options);
    if (file === filename) {
      const entry = byFd.get(options.fd); assert.ok(entry);
      assert.equal(options.autoClose, false); entry.streams += 1;
      if (streamFd === undefined) streamFd = options.fd;
    }
    return value;
  }));
  mocks.push(t.mock.method(fs, 'read', (fd, ...args) => {
    if (fd !== streamFd || intercepted || stopped) return read(fd, ...args);
    intercepted = true;
    const callback = args.pop();
    return read(fd, ...args, (...result) => {
      if (stopped) return callback(...result);
      observed.reads += 1; observed.error = result[0]; observed.bytes = result[1];
      let released = false;
      releaseRead = () => {
        if (!released) { released = true; observed.resumes += 1; callback(...result); }
      };
      startRead();
    });
  }));
  return { entries, live, observed, release() { releaseRead?.(); },
    async waitForRead(request) {
      let timer;
      try {
        await Promise.race([started, request.then(({ response }) =>
          assert.fail(`composition returned ${response.status} before the controlled candidate read`)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('the actual composition plan did not reach its candidate read within 10 seconds')), 10000);
        })]);
      } finally { clearTimeout(timer); }
    },
    restore() {
      if (stopped) return;
      stopped = true; releaseRead?.();
      for (const mock of mocks.reverse()) mock.mock.restore();
    },
  };
}

for (const revocation of ['token', 'membership', 'user', 'tenant', 'none']) {
  test(`HTTP unit compose permission during plan await: ${revocation}`, { timeout: 180000 }, async t => {
    // Register before fixture teardown so a timed-out assertion cannot leave
    // a borrowed FD read held while the existing fixture drains real jobs.
    let cleanup = () => {}; t.after(() => cleanup());
    const scheduler = { calls: 0 };
    const h = await fixture(t, 'native', { compositionSchedule(job) {
      scheduler.calls += 1; queueMicrotask(job);
    } });
    h.scheduler = scheduler;
    const original = publicationSnapshot(h);
    assert.deepEqual(h.syntheticCalls, { post: 2, download: 2 }, 'synthetic generation is a fixture precondition, not a global zero');
    const hold = pauseFirstCandidateRead(t, h.candidates[0].file), controller = new AbortController();
    const requestTimer = setTimeout(() => controller.abort(), 30000);
    const creates = [], create = composition.createComposition;
    const trackedCreate = t.mock.method(composition, 'createComposition', (...args) => {
      const pending = create(...args); creates.push(pending); return pending;
    });
    let cleanupPromise;
    cleanup = () => {
      if (!cleanupPromise) cleanupPromise = (async () => {
        hold.restore(); controller.abort(); clearTimeout(requestTimer);
        await Promise.allSettled(creates);
        // An aborted client does not cancel server planning. Let composeVersion
        // finish and register its real background job before fixture drains jobs.
        await new Promise(setImmediate);
        trackedCreate.mock.restore();
      })();
      return cleanupPromise;
    };
    const request = h.post(h.input, { signal: controller.signal }).then(async response => ({ response, payload: await response.json() }));
    try {
      await hold.waitForRead(request);
      assert.ifError(hold.observed.error);
      assert.equal(hold.observed.reads, 1); assert.equal(hold.observed.resumes, 0);
      assert.ok(hold.observed.bytes > 0, 'the held callback contains real candidate bytes');
      assert.ok(hold.entries.some(entry => entry.streams === 1 && hold.live.has(entry.fd)));
      assert.deepEqual(h.calls, { creates: 1, runs: 0, other: 0 }, 'the real create chain is awaiting before dispatch');
      assert.equal(scheduler.calls, 0);
      assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_exports').get().n, 0);
      assert.deepEqual(publicationSnapshot(h), original, 'planning has not published before the actual read resumes');
      const mutations = {
        token: ['UPDATE platform_users SET token_version=token_version+1 WHERE id=?', [h.actor.user.id], 401],
        membership: ["UPDATE tenant_members SET status='disabled' WHERE tenant_id=? AND user_id=?", [h.actor.tenantId, h.actor.user.id], 404],
        user: ["UPDATE platform_users SET status='disabled' WHERE id=?", [h.actor.user.id], 401],
        tenant: ["UPDATE tenants SET status='disabled' WHERE id=?", [h.actor.tenantId], 404],
      };
      const mutation = mutations[revocation];
      if (mutation) assert.equal(h.db.prepare(mutation[0]).run(...mutation[1]).changes, 1);
      const beforeResume = snapshot(h);
      hold.release();
      const { response, payload } = await request;
      clearTimeout(requestTimer);
      const afterResponse = snapshot(h);
      const effects = { exports: h.db.prepare('SELECT count(*) n FROM redraw_exports').get().n,
        assetDelta: h.db.prepare('SELECT count(*) n FROM assets').get().n - original.assets.length,
        schedules: scheduler.calls, calls: { ...h.calls }, providers: { ...h.syntheticCalls } };
      safe(payload); assert.match(response.headers.get('content-type'), /^application\/json\b/);
      assert.equal(hold.observed.resumes, 1, 'the original read callback must resume exactly once');
      if (mutation) {
        assert.equal(response.status, mutation[2], JSON.stringify({ payload, effects }));
        if (response.status === 401) assert.equal(payload.error.code, 'UNAUTHORIZED');
        assert.deepEqual(afterResponse, beforeResume, 'revocation must prevent INSERT, assets, output writes, dispatch and provider increments');
        assert.deepEqual(effects, { exports: 0, assetDelta: 0, schedules: 0,
          calls: { creates: 1, runs: 0, other: 0 }, providers: original.providers });
        assert.deepEqual(candidateSnapshot(h), original.candidates);
      } else {
        assert.equal(response.status, 202, JSON.stringify({ payload, effects }));
        assert.equal(payload.data.created, true); assert.equal(scheduler.calls, 1);
        const completed = await waitForExport(h, payload.data.export_id);
        assert.equal(completed.status, 'completed', JSON.stringify(completed));
        assert.deepEqual(h.calls, { creates: 1, runs: 1, other: 0 });
        assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_exports').get().n, 1);
        assert.equal(h.db.prepare('SELECT count(*) n FROM assets').get().n, original.assets.length + 4);
        assert.equal(outputSnapshot(h).filter(entry => entry[1] === 'file').length, 4);
        assert.deepEqual(protectedBusinessSnapshot(h), original.business);
        assert.deepEqual(candidateSnapshot(h), original.candidates);
        assert.deepEqual(h.syntheticCalls, original.providers);
      }
      assert.equal(hold.live.size, 0, 'the real release/composition owns and closes every observed candidate FD');
      assert.ok(hold.entries.every(entry => entry.closes === 1), JSON.stringify(hold.entries));
    } finally {
      await cleanup();
      await request.catch(() => {});
    }
  });
}

for (const audioMode of ['native', 'not_required']) test(`HTTP unit compose ${audioMode}: real default scheduler creates MP4 and three sidecars`, async t => {
  const h = await fixture(t, audioMode);
  const protectedBefore = protectedBusinessSnapshot(h), candidatesBefore = candidateSnapshot(h);
  const assetsBefore = h.db.prepare('SELECT count(*) n FROM assets').get().n;
  const response = await h.post(), payload = await response.json(); safe(payload);
  assert.equal(response.status, 202, JSON.stringify(payload));
  assert.equal(payload.data.created, true);
  assert.equal(payload.data.status, 'pending');
  assert.ok(Number.isSafeInteger(payload.data.export_id) && payload.data.export_id > 0);
  assert.deepEqual(h.lastCreate.input, { ...h.input, version_id: h.versionId },
    'the service receives exactly the five body keys plus the authenticated URL version');
  assert.equal(h.lastCreate.ctx.tenantId, h.actor.tenantId);
  assert.equal(h.lastCreate.ctx.userId, h.actor.user.id);
  assert.equal(typeof h.lastCreate.ctx.canReadArtifact, 'function', 'use the real router artifact reader');
  assert.equal(h.lastCreate.ctx.canReadArtifact(2147483647), false);
  assert.equal(h.lastCreate.ctx.canReadArtifact(h.sourceAsset.id), true);
  const completed = await waitForExport(h, payload.data.export_id);
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  const row = h.db.prepare('SELECT * FROM redraw_exports WHERE id=?').get(completed.id);
  const manifest = JSON.parse(row.manifest_json);
  assert.equal(manifest.schema_version, h.input.schema_version);
  assert.equal(manifest.request.version_id, h.versionId);
  assert.equal(manifest.request.run_id, h.run.id);
  assert.equal(manifest.request.expected_run_revision, runRow(h).revision);
  assert.equal(manifest.episode_release.quality_summary.final_media_review, 'pending');
  const outputs = {};
  for (const kind of KINDS) {
    const download = await h.request(`/api/v1/redraw/exports/${row.id}/download/${kind}`);
    assert.equal(download.status, 200, kind);
    assert.equal(download.headers.get('content-type').split(';')[0], MIME[kind]);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(download.headers.get('x-content-sha256'), hash(bytes));
    assert.equal(hash(bytes), manifest.outputs.hashes[kind]);
    const asset = h.db.prepare('SELECT * FROM assets WHERE id=?').get(manifest.outputs[`${kind}_asset_id`]);
    const filename = path.resolve(h.root, asset.local_path);
    assert.deepEqual(bytes, fs.readFileSync(filename));
    outputs[kind] = { bytes, filename };
  }
  const { stdout } = await runMedia(getFfprobePath(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputs.mp4.filename],
    { windowsHide: true, timeout: 120000 });
  const probe = JSON.parse(stdout), report = JSON.parse(outputs.report.bytes);
  assert.ok(probe.streams.some(stream => stream.codec_type === 'video'));
  assert.equal(probe.streams.some(stream => stream.codec_type === 'audio'), audioMode === 'native');
  assert.ok(Math.abs(Number(probe.format.duration) - 12) < 0.25);
  assert.equal(report.media.sha256, hash(outputs.mp4.bytes));
  assert.equal(report.media.duration_ms, Math.round(Number(probe.format.duration) * 1000));
  assert.equal(report.audio.mode, audioMode);
  assert.equal(report.final_media_review, 'pending');
  assert.equal(report.dialogue_alignment, 'not_verified');
  assert.equal(outputs.srt.bytes.toString('utf8'), manifest.episode_release.subtitles.srt);
  assert.equal(outputs.vtt.bytes.toString('utf8'), manifest.episode_release.subtitles.vtt);
  if (audioMode === 'native') assert.match(outputs.srt.bytes.toString('utf8'), /Maya, bring the blue folder/);
  else {
    assert.equal(outputs.srt.bytes.length, 0);
    assert.equal(hash(outputs.srt.bytes), hash(Buffer.alloc(0)));
    assert.equal(outputs.vtt.bytes.toString('utf8'), 'WEBVTT\n\n');
  }
  safe(report);
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_exports').get().n, 1);
  assert.equal(h.db.prepare('SELECT count(*) n FROM assets').get().n, assetsBefore + 4);
  assert.equal(outputSnapshot(h).filter(entry => entry[1] === 'file').length, 4);
  assert.equal(outputSnapshot(h).filter(entry => entry[1] === 'directory').length, 1);
  assert.deepEqual(protectedBusinessSnapshot(h), protectedBefore);
  assert.deepEqual(candidateSnapshot(h), candidatesBefore);
  assert.deepEqual(h.syntheticCalls, { post: 2, download: 2 }, 'POST/GET must not call the synthetic provider again');
  assert.deepEqual(h.calls, { creates: 1, runs: 1, other: 0 });
  const beforeReplay = snapshot(h), replay = await h.post(), replayPayload = await replay.json();
  assert.equal(replay.status, 202);
  assert.equal(replayPayload.data.export_id, row.id);
  assert.equal(replayPayload.data.created, false);
  assert.equal(replayPayload.data.status, 'completed');
  assert.deepEqual(snapshot(h), beforeReplay, 'completed replay does not reschedule or re-encode');
});

test('HTTP unit compose rejects invalid shapes, stale bindings and invisible membership without outputs', async t => {
  const h = await fixture(t);
  const invalid = [
    ['array body', []],
    ['missing schema', { ...h.input, schema_version: undefined }],
    ['wrong schema', { ...h.input, schema_version: 'redraw-execution-unit-release-v1' }],
    ['null schema', { ...h.input, schema_version: null }],
    ['empty schema', { ...h.input, schema_version: '' }],
    ['unit marker without schema', { idempotency_key: h.input.idempotency_key, expected_run_revision: 0 }],
    ['missing run', { ...h.input, run_id: undefined }],
    ['missing plan hash', { ...h.input, expected_plan_hash: undefined }],
    ['missing revision', { ...h.input, expected_run_revision: undefined }],
    ['missing idempotency key', { ...h.input, idempotency_key: undefined }],
    ['string run', { ...h.input, run_id: String(h.input.run_id) }],
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null].map(run_id => [`invalid run ${run_id}`, { ...h.input, run_id }]),
    ['string revision', { ...h.input, expected_run_revision: String(h.input.expected_run_revision) }],
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null].map(expected_run_revision =>
      [`invalid revision ${expected_run_revision}`, { ...h.input, expected_run_revision }]),
    ...['', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), null].map((expected_plan_hash, index) =>
      [`invalid plan hash ${index}`, { ...h.input, expected_plan_hash }]),
    ...['', ' padded', 'padded ', 'x'.repeat(201), 'control\u0000key', 123, null].map((idempotency_key, index) =>
      [`invalid idempotency key ${index}`, { ...h.input, idempotency_key }]),
    ['client version', { ...h.input, version_id: h.versionId }],
    ['client owner', { ...h.input, tenant_id: h.actor.tenantId }],
    ['client audio', { ...h.input, audio_mode: 'replace' }],
    ['client units', { ...h.input, units: [] }],
    ['client output path', { ...h.input, local_path: 'client-output.mp4' }],
    ...['owner', 'user_id', 'versionId', 'assets', 'release', 'episode_release', 'path'].map(field =>
      [`client ${field}`, { ...h.input, [field]: 'client-controlled' }]),
  ];
  for (const [label, body] of invalid) await t.test(label, async () => {
    const creates = h.calls.creates;
    await rejected(h, body, 400);
    assert.equal(h.calls.creates, creates, 'strict HTTP shape rejection precedes the composition service');
  });
  await t.test('the shared idempotency key alone does not classify a legacy body as a unit request', async () => {
    await rejected(h, { idempotency_key: 'legacy-shape', audio_mode: 'replace' }, 400);
    assert.deepEqual(h.lastCreate.input, { versionId: h.versionId, idempotencyKey: 'legacy-shape', audioMode: 'replace' },
      'legacy input still reaches the real shot-based service, where this unit-only fixture has no approved shots');
  });
  await t.test('stale plan', () => rejected(h, { ...h.input, expected_plan_hash: 'f'.repeat(64) }, 409));
  await t.test('stale revision', () => rejected(h, { ...h.input, expected_run_revision: h.input.expected_run_revision - 1 }, 409));
  await t.test('zero revision is a valid shape but conflicts with this approved run', () => rejected(h,
    { ...h.input, expected_run_revision: 0 }, 409));
  await t.test('invisible run', () => rejected(h, { ...h.input, run_id: 2147483647 }, 404));
  await t.test('invisible URL version', () => rejected(h, h.input, 404,
    { endpoint: '/api/v1/redraw/versions/2147483647/compose' }));
  const other = registerActor(h.db);
  tenantService.addMemberByEmail(h.db, h.actor.tenantId, h.actor.user.id, { email: other.user.email });
  tenantService.addMemberByEmail(h.db, other.tenantId, other.user.id, { email: h.actor.user.email });
  await t.test('another active member of the same tenant cannot compose the owner version', () => rejected(h, h.input, 404,
    { headers: { Authorization: `Bearer ${other.token}` } }));
  await t.test('the owner cannot compose this version under a different active tenant', () => rejected(h, h.input, 404,
    { headers: { 'X-Tenant-Id': other.tenantId } }));
  await t.test('a token is still required before the unit-only tenant path', () => rejected(h, h.input, 401,
    { headers: { Authorization: '' } }));
  const sibling = Number(h.db.prepare(`INSERT INTO redraw_versions
    (work_id,tenant_id,user_id,version,locale,market,created_at,updated_at)
    SELECT work_id,tenant_id,user_id,version+1,locale,market,created_at,updated_at FROM redraw_versions WHERE id=?`)
    .run(h.versionId).lastInsertRowid);
  for (const [field, value] of [['user_id', other.user.id], ['tenant_id', other.tenantId], ['version_id', sibling]]) {
    await t.test(`an existing run bound to another ${field} is not visible`, async () => {
      const original = runRow(h);
      assert.equal(h.db.prepare(`UPDATE redraw_execution_runs SET ${field}=? WHERE id=?`).run(value, h.run.id).changes, 1);
      try { await rejected(h, h.input, 404); }
      finally {
        h.db.prepare(`UPDATE redraw_execution_runs SET ${field}=? WHERE id=?`).run(original[field], h.run.id);
        assert.deepEqual(runRow(h), original);
      }
    });
  }
  for (const [field, value] of [['status', 'rejected'], ['approved_by', other.user.id]]) {
    await t.test(`an unapproved unit ${field} cannot be composed`, async () => {
      const original = h.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=?').get(h.candidates[0].attempt.id);
      h.db.prepare(`UPDATE redraw_execution_unit_attempts SET ${field}=? WHERE id=?`).run(value, original.id);
      try { await rejected(h, h.input, 409); }
      finally {
        h.db.prepare(`UPDATE redraw_execution_unit_attempts SET ${field}=? WHERE id=?`).run(original[field], original.id);
        assert.deepEqual(h.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=?').get(original.id), original);
      }
    });
  }
  await t.test('a real SQLite insert failure is a safe internal 500 with zero publication', async () => {
    h.db.exec(`CREATE TRIGGER g55b_http_composition_insert_failure BEFORE INSERT ON redraw_exports
      BEGIN SELECT RAISE(ABORT, 'g55b-private-internal-sentinel'); END`);
    try {
      const payload = await rejected(h, h.input, 500);
      assert.equal(payload.error.code, 'INTERNAL_ERROR');
      assert.equal(JSON.stringify(payload).includes('g55b-private-internal-sentinel'), false);
    } finally { h.db.exec('DROP TRIGGER g55b_http_composition_insert_failure'); }
  });
  await t.test('an unknown composition-prefixed error is not misreported as a business conflict', async sub => {
    sub.mock.method(composition, 'createComposition', async () => {
      throw Object.assign(new Error(`${KEY} ${JWT_SECRET} ${h.root}`), { code: 'REDRAW_COMPOSITION_UNKNOWN_INTERNAL' });
    });
    const payload = await rejected(h, h.input, 500);
    assert.equal(payload.error.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(payload).includes(h.root), false);
  });
  await t.test('disabled membership', async () => {
    h.db.prepare("UPDATE tenant_members SET status='disabled' WHERE tenant_id=? AND user_id=?").run(h.actor.tenantId, h.actor.user.id);
    try { await rejected(h, h.input, 404); }
    finally { h.db.prepare("UPDATE tenant_members SET status='active' WHERE tenant_id=? AND user_id=?").run(h.actor.tenantId, h.actor.user.id); }
  });
  await t.test('missing membership is not recreated by the legacy initializer', async () => {
    h.db.prepare('DELETE FROM tenant_members WHERE tenant_id=? AND user_id=?').run(h.actor.tenantId, h.actor.user.id);
    await rejected(h, h.input, 404);
    await rejected(h, h.input, 404, { headers: { 'X-Tenant-Id': '' } });
    assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_members WHERE tenant_id=? AND user_id=?')
      .get(h.actor.tenantId, h.actor.user.id).n, 0);
  });
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_exports').get().n, 0);
  assert.equal(h.calls.runs, 0);
  assert.deepEqual(outputSnapshot(h), []);
});

test('HTTP unit compose replace requires approved dubbing and never submits TTS', async t => {
  const h = await fixture(t, 'replace');
  const payload = await rejected(h, h.input, 409);
  assert.equal(payload.error.code, 'REDRAW_COMPOSITION_APPROVED_DUB_REQUIRED');
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_exports').get().n, 0);
  assert.equal(h.db.prepare("SELECT count(*) n FROM assets WHERE category='redraw_dialogue'").get().n, 0);
  assert.deepEqual(h.syntheticCalls, { post: 2, download: 2 });
  assert.equal(h.calls.runs, 0); assert.equal(h.calls.other, 0);
  assert.deepEqual(outputSnapshot(h), []);
});

test('HTTP unit compose reports subtitle rewrite as a business conflict', async t => {
  // One English word fits the speech estimate but cannot wrap into a 42-character subtitle line.
  const target = 'A'.repeat(43);
  const h = await fixture(t, 'native', {}, [target]);
  assert.deepEqual(h.localization.dialogue_map.map(dialogue => dialogue.target_text), [target]);
  assert.deepEqual(h.pack.dialogues.map(dialogue => dialogue.target_text), [target]);
  const current = getExecutionRun(h.ctx, h.versionId, h.run.id);
  assert.equal(current.binding_status, 'current');
  assert.equal(current.plan_hash, h.input.expected_plan_hash);
  assert.equal(current.status, 'completed');
  assert.equal(current.units.length, 2);
  assert.ok(current.units.every(unit => unit.status === 'approved'));
  const before = snapshot(h), response = await h.post(), payload = await response.json(); safe(payload);
  assert.equal(h.lastCreateError?.code, 'REDRAW_EPISODE_RELEASE_SUBTITLE_INVALID',
    'the real release/subtitle service, not an injected error, must reject this approved input');
  assert.deepEqual(snapshot(h), before);
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_exports').get().n, 0);
  assert.deepEqual(outputSnapshot(h), []);
  assert.deepEqual(h.calls, { creates: 1, runs: 0, other: 0 });
  assert.equal(response.status, 409, JSON.stringify(payload));
  assert.equal(payload.error.code, 'REDRAW_EPISODE_RELEASE_SUBTITLE_INVALID');
});

test('HTTP unit compose preserves idempotency and candidates across held, interrupted and failed scheduling', async t => {
  // Only this failure/race suite pauses or rejects scheduling. It never fakes a
  // successful run; the two success suites above retain the default scheduler.
  const scheduler = { mode: 'hold', calls: 0, jobs: [] };
  const h = await fixture(t, 'native', { compositionSchedule(job) {
    scheduler.calls += 1;
    if (scheduler.mode === 'throw') throw new Error(`scheduler ${KEY} ${JWT_SECRET}`);
    if (scheduler.mode === 'reject') return Promise.reject(new Error(`scheduler ${KEY} ${JWT_SECRET}`));
    scheduler.jobs.push(job);
  } });
  h.scheduler = scheduler;
  h.input.idempotency_key = 'k'.repeat(200);
  const preserved = publicationSnapshot(h);
  let first;
  await t.test('simultaneous same-key clicks create exactly one pending export and schedule once', async () => {
    const results = await Promise.all([accepted(h), accepted(h)]);
    assert.equal(results[0].export_id, results[1].export_id);
    assert.deepEqual(results.map(result => result.created).sort(), [false, true]);
    assert.ok(results.every(result => result.status === 'pending'));
    first = results[0].export_id;
    assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_exports').get().n, 1);
    assert.equal(scheduler.calls, 1); assert.equal(scheduler.jobs.length, 1);
    assert.equal(h.calls.runs, 0);
    assert.deepEqual(publicationSnapshot(h), preserved);
  });
  await t.test('pending replay is read-only while different request or active key conflicts', async () => {
    await replay(h, h.input, first, 'pending');
    for (const change of [{ expected_run_revision: h.input.expected_run_revision + 1 },
      { expected_plan_hash: 'f'.repeat(64) }, { run_id: 2147483647 }]) {
      const payload = await rejected(h, { ...h.input, ...change }, 409);
      assert.equal(payload.error.code, 'REDRAW_COMPOSITION_IDEMPOTENCY_CONFLICT');
    }
    const payload = await rejected(h, { ...h.input, idempotency_key: 'another-active-export' }, 409);
    assert.equal(payload.error.code, 'REDRAW_COMPOSITION_ACTIVE_CONFLICT');
  });
  await t.test('processing and real restart-recovered needs_attention replays do not schedule', async () => {
    // Simulate a lost in-process job, then use the real recovery entry point.
    assert.equal(h.db.prepare("UPDATE redraw_exports SET status='processing' WHERE id=? AND status='pending'").run(first).changes, 1);
    scheduler.jobs.shift();
    await replay(h, h.input, first, 'processing');
    const payload = await rejected(h, { ...h.input, idempotency_key: 'processing-active-export' }, 409);
    assert.equal(payload.error.code, 'REDRAW_COMPOSITION_ACTIVE_CONFLICT');
    assert.equal(composition.recoverInterruptedCompositions(h.db), 1);
    await replay(h, h.input, first, 'needs_attention');
    assert.equal(scheduler.calls, 1); assert.equal(h.calls.runs, 0);
    assert.deepEqual(publicationSnapshot(h), preserved);
  });
  await t.test('binding drift before the held real job starts fails without publishing or changing candidates', async () => {
    const input = { ...h.input, idempotency_key: 'drift-before-background-start' };
    const created = await accepted(h, input);
    assert.equal(created.created, true); assert.notEqual(created.export_id, first);
    assert.equal(scheduler.calls, 2); assert.equal(scheduler.jobs.length, 1);
    const revision = runRow(h).revision;
    h.db.prepare('UPDATE redraw_execution_runs SET revision=revision+1 WHERE id=?').run(h.run.id);
    try {
      const beforeRun = publicationSnapshot(h);
      await scheduler.jobs.shift()();
      const failed = await waitForExport(h, created.export_id);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error_code, 'REDRAW_COMPOSITION_INPUT_DRIFT');
      assert.equal(h.calls.runs, 1);
      assert.deepEqual(publicationSnapshot(h), beforeRun);
      await replay(h, input, created.export_id, 'failed');
      assert.equal(scheduler.calls, 2, 'failed replay does not revalidate stale bindings or reschedule');
    } finally { h.db.prepare('UPDATE redraw_execution_runs SET revision=? WHERE id=?').run(revision, h.run.id); }
    assert.deepEqual(publicationSnapshot(h), preserved);
  });
  for (const mode of ['throw', 'reject']) await t.test(`scheduler ${mode} persists one failed export and safely replays it`, async () => {
    scheduler.mode = mode;
    const input = { ...h.input, idempotency_key: `scheduler-${mode}` };
    const schedules = scheduler.calls, runs = h.calls.runs;
    const count = h.db.prepare('SELECT count(*) n FROM redraw_exports').get().n;
    const response = await h.post(input), payload = await response.json(); safe(payload);
    assert.equal(response.status, mode === 'throw' ? 500 : 202, JSON.stringify(payload));
    if (mode === 'throw') assert.equal(payload.error.code, 'INTERNAL_ERROR');
    else assert.equal(payload.data.created, true);
    const row = h.db.prepare("SELECT * FROM redraw_exports WHERE json_extract(manifest_json,'$.idempotency_key')=?")
      .get(input.idempotency_key);
    assert.ok(row);
    const failed = await waitForExport(h, row.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_code, 'REDRAW_COMPOSITION_SCHEDULE_FAILED');
    assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_exports').get().n, count + 1);
    assert.equal(scheduler.calls, schedules + 1); assert.equal(h.calls.runs, runs);
    assert.deepEqual(publicationSnapshot(h), preserved);
    await replay(h, input, row.id, 'failed');
  });
  assert.equal(scheduler.jobs.length, 0);
  assert.equal(scheduler.calls, 4); assert.equal(h.calls.runs, 1); assert.equal(h.calls.other, 0);
  assert.deepEqual(outputSnapshot(h), []);
  assert.deepEqual(h.syntheticCalls, { post: 2, download: 2 });
});

test('composition fixture without createActor preserves its original synthetic owner contract', async t => {
  const h = await approvedCompositionRun(t);
  assert.deepEqual([h.ctx.tenantId, h.ctx.userId], ['tenant-a', 'user-a']);
  const metadata = JSON.parse(h.sourceAsset.metadata);
  assert.deepEqual([metadata.tenant_id, metadata.user_id], ['tenant-a', 'user-a']);
  assert.equal(metadata.sha256, hash(fs.readFileSync(h.sourceFile)));
  assert.equal(h.db.prepare("SELECT count(*) n FROM redraw_shots WHERE tenant_id='tenant-a' AND user_id='user-a'").get().n, 2);
  assert.equal(h.db.prepare("SELECT count(*) n FROM redraw_execution_unit_attempts WHERE run_id=? AND status='approved'").get(h.run.id).n, 2);
  assert.equal(runRow(h).status, 'completed');
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_exports').get().n, 0);
  assert.deepEqual(outputSnapshot(h), []);
  assert.deepEqual(h.syntheticCalls, { post: 2, download: 2 });
});
