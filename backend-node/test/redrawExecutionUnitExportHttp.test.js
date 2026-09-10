'use strict';

// DRAFT FOR ROOT STATIC REVIEW. Run only through the approved isolated runner.
// Real local SQLite, JWT, router, unit approval, release, FFmpeg and HTTP bytes.
// Provider responses and human decisions are explicitly synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Readable } = require('node:stream');
const express = require('express');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { fixture: referenceFixture } = require('./helpers/redrawUnitReferenceFixture');
const { makeCandidateMedia, hash, runRow, KEY, SECRET, BASE_URL, NOW } = require('./helpers/redrawExecutionUnitDispatchFixture');
const { setupRouter } = require('../src/routes');
const userAuth = require('../src/services/userAuthService');
const tenantService = require('../src/services/tenantService');
const { episodeLocalizationHash } = require('../src/services/localizationService');
const { inspectUnitReferenceMaterials } = require('../src/services/redrawUnitReferenceService');
const { prepareUnitReferenceMaterials } = require('../src/services/redrawUnitReferenceDerivationService');
const { compileUnitProductionPack } = require('../src/services/redrawUnitProductionPackService');
const { canonicalModel } = require('../src/services/modelPriceService');
const ledger = require('../src/services/creditLedgerService');
const runs = require('../src/services/redrawExecutionRunService');
const reviews = require('../src/services/redrawExecutionUnitReviewService');
const { reviewCandidate } = require('../src/services/redrawCandidateReviewService');
const composition = require('../src/services/redrawCompositionService');
const { assertReleaseHash, buildEpisodeRelease } = require('../src/services/redrawEpisodeReleaseService');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');

const JWT_SECRET = 'synthetic-unit-export-http-jwt-at-least-32-bytes';
const SCHEMA = 'redraw-execution-unit-composition-v1';
const KINDS = ['mp4', 'srt', 'vtt', 'report'];
const MIME = { mp4: 'video/mp4', srt: 'application/x-subrip', vtt: 'text/vtt', report: 'application/json' };
const log = { info() {}, warn() {}, error() {} };
const runMedia = promisify(execFile);

function registerActor(db) {
  const user = userAuth.register(db, { email: `${crypto.randomUUID()}@example.test`, password: 'synthetic-unit-export-pass-123' });
  const tenant = tenantService.ensurePersonalTenant(db, user);
  return { user, tenantId: tenant.id, token: userAuth.issueToken(user, JWT_SECRET, 0) };
}

async function completedHttpFixture(t, audioMode = 'native') {
  // Existing assemblyCase fixtures hard-code their owner. Prepare this actor in
  // the existing base fixture BEFORE any source/plan/review hashes are saved.
  const h = await referenceFixture(t, { createActor: registerActor, secondMotion: true, durations: [5, 7],
    async beforeBlueprint(h, raw) {
      if (audioMode === 'not_required') return;
      const segments = [{ id: 'http-export-dialogue', start_ms: 500, end_ms: 3500,
        source_text: '合成测试对白，不外发。', speaker_cluster_id: 'speaker-cluster-1' }];
      const audioPath = path.join(h.root, 'http-export-source-audio.wav');
      await runMedia(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', path.join(h.root, 'source/source.mp4'),
        '-vn', '-c:a', 'pcm_s16le', audioPath], { windowsHide: true, timeout: 120000 });
      const evidence = { schema_version: 'redraw-source-audio-evidence-v1', task_id: 'synthetic-http-export-evidence',
        tenant_id: h.ctx.tenantId, user_id: h.ctx.userId, work_id: 1, source_asset_id: 101,
        source_video_sha256: h.sourceFingerprint, audio_sha256: hash(fs.readFileSync(audioPath)),
        transcript_sha256: hash(JSON.stringify(segments)), source_language: 'zh', language_probability: 0.99,
        dialogue_mode: 'spoken', created_at: NOW, segments };
      const bytes = Buffer.from(JSON.stringify(evidence));
      fs.writeFileSync(path.join(h.root, 'http-export-source-evidence.json'), bytes, { flag: 'wx' });
      const metadata = { ...evidence, evidence_sha256: hash(bytes) }; delete metadata.segments;
      h.db.prepare(`INSERT INTO assets (id,type,category,local_path,metadata)
        VALUES (503,'json','redraw_source_audio_evidence','http-export-source-evidence.json',?)`).run(JSON.stringify(metadata));
      raw.evidence_manifest.items.push({ id: 'http-export-source-audio', kind: 'audio_transcript', asset_id: 503,
        sha256: hash(bytes), tool: 'synthetic-fixture-not-asr', tool_version: '1' });
      raw.shots[0].dialogue = [{ id: segments[0].id, start_ms: 500, end_ms: 3500,
        source_text: segments[0].source_text, speaker_id: 'character-001', speaker_kind: 'character', off_screen: false,
        source_language: 'zh', emotion: 'calm', evidence_refs: ['http-export-source-audio'], confidence: 0.99, review_status: 'approved' }];
      raw.shots[0].audio_contract.dialogue_mode = 'spoken';
    },
    beforeReview(h) {
      assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_execution_plan_reviews').get().n, 0);
      assert.equal(h.localization.dialogue_map.length, audioMode === 'native' ? 1 : 0);
      if (audioMode === 'native') h.localization.dialogue_map[0].target_text = 'Bring the blue folder.';
      h.localization.localization_hash = episodeLocalizationHash(h.localization);
      h.db.prepare('UPDATE redraw_versions SET localization_hash=?,localization_review_json=? WHERE id=?')
        .run(h.localization.localization_hash, JSON.stringify(h.localization), h.versionId);
      const row = h.db.prepare('SELECT * FROM ai_service_configs WHERE id=41').get();
      const settings = JSON.parse(row.settings), capabilities = JSON.parse(row.verified_capabilities);
      capabilities[row.default_model].maxVideoReferences = 1;
      if (audioMode === 'native') settings.redraw_locale_capabilities.push({ locale: 'en', language: 'en', market: '', target_locale: null,
        status: 'verified', evidence: { native_dialogue_audio: {
          contract: 'redraw-native-dialogue-audio-v1', config_id: 41, config_updated_at: row.updated_at,
          provider: row.provider, protocol: row.api_protocol, model: row.default_model,
          provider_task_id: 'synthetic-http-export-native-capability', terminal_status: 'completed',
          artifact_id: 101, artifact_sha256: h.sourceFingerprint, media: { video_stream: true, audio_stream: true },
          locale_verification: { language: 'en', language_verified: true, locale_verified: false },
          human_review: { status: 'passed', speaker_order: 'passed', lip_sync: 'passed', extra_dialogue: 'passed' },
        } } });
      h.db.prepare('UPDATE ai_service_configs SET settings=?,verified_capabilities=?,api_key=?,base_url=? WHERE id=41')
        .run(JSON.stringify(settings), JSON.stringify(capabilities), KEY, 'https://video.dispatch.synthetic.invalid');
    } });
  assert.equal(h.owner.userId, h.actor.user.id);
  assert.equal(h.ctx.tenantId, h.actor.tenantId);
  assert.equal(h.queueState.queue.units.length, 2);
  assert.equal(h.queueState.saved_review.plan.capability.audio_mode, audioMode);
  h.ctx.env = {}; h.ctx.log = log;
  h.ctx.providerAssets = { storageRoot: h.root, storageBaseUrl: BASE_URL, signingSecret: SECRET, nowMs: Date.parse(NOW) };
  h.calls = { submits: 0, downloads: 0, other: 0 };
  h.candidates = [];
  const model = canonicalModel(h.queueState.saved_review.plan.capability.model);
  h.db.prepare(`INSERT INTO model_credit_prices(model,display_name,category,credits,pricing_mode,status,billing_unit,updated_at)
    VALUES (?,'synthetic HTTP export','video',3,'paid','enabled','second',?)
    ON CONFLICT(model) DO UPDATE SET category='video',credits=3,pricing_mode='paid',status='enabled',billing_unit='second'`).run(model, NOW);
  h.db.prepare('DELETE FROM model_resolution_prices WHERE model=?').run(model);
  ledger.setTenantAccountBalance(h.db, h.ctx.tenantId, 100);
  h.run = runs.createExecutionRun(h.ctx, h.versionId,
    { expected_plan_hash: h.expected(0).plan_hash, expected_queue_id: h.expected(0).queue_id });
  for (let index = 0; index < 2; index += 1) {
    const expected = h.expected(index), material = await inspectUnitReferenceMaterials(h.ctx, expected);
    await prepareUnitReferenceMaterials(h.ctx, { ...expected, expected_materials_hash: material.materials_hash });
    const ready = await runs.inspectExecutionRunReadiness(h.ctx, h.versionId, h.run.id,
      { output_parameters: { resolution: '480p', aspect_ratio: '16:9' } });
    assert.equal(ready.status, 'ready', JSON.stringify(ready));
    const claim = await runs.claimNextUnit(h.ctx, h.versionId, h.run.id, { expected_revision: ready.revision,
      expected_plan_hash: ready.plan_hash, expected_quote_hash: ready.quote_hash,
      output_parameters: { resolution: '480p', aspect_ratio: '16:9' } });
    h.attemptId = claim.attempt_id;
    const input = { attempt_id: h.attemptId, expected_revision: runRow(h).revision,
      expected_plan_hash: ready.plan_hash, expected_quote_hash: ready.quote_hash };
    await runs.bindClaimedExecutionUnitTask(h.ctx, h.versionId, h.run.id, input);
    input.expected_revision = runRow(h).revision;
    h.pack = compileUnitProductionPack({ owner: { tenantId: h.ctx.tenantId, userId: h.ctx.userId,
      workId: 1, versionId: h.versionId }, expected, queueState: h.queueState, blueprint: h.blueprint, localization: h.localization });
    const mediaRoot = fs.mkdtempSync(path.join(h.root, 'http-export-candidate-'));
    const bytes = await makeCandidateMedia({ ...h, root: mediaRoot }, audioMode === 'native' ? 'valid-sar' : 'silent',
      { color: index ? 'blue' : 'red' });
    const result = await runs.dispatchClaimedExecutionUnitTask(h.ctx, h.versionId, h.run.id, input, {
      fetchImpl: async (_url, init) => {
        assert.equal(init.method, 'POST'); h.calls.submits += 1;
        return new Response(JSON.stringify({ id: `synthetic-http-export-${h.attemptId}`, status: 'succeeded',
          content: { video_url: 'https://result.synthetic.invalid/http-export.mp4' } }),
        { headers: { 'Content-Type': 'application/json' } });
      },
      download: {
        _dnsLookupForTest: async (hostname, options) => {
          assert.equal(hostname, 'result.synthetic.invalid'); assert.equal(options.all, true);
          return [{ address: '8.8.8.8', family: 4 }];
        },
        fetchImpl: async (url, init) => {
          assert.equal(String(url), 'https://result.synthetic.invalid/http-export.mp4');
          assert.equal(init.method, 'GET'); assert.equal(init.headers, undefined); h.calls.downloads += 1;
          return new Response(bytes, { headers: { 'Content-Type': 'video/mp4' } });
        },
      },
    });
    assert.equal(result.status, 'waiting_review');
    const candidate = await reviews.getExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, expected.unit_id);
    const approved = await reviews.reviewExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, expected.unit_id, {
      expected_revision: candidate.run_revision, expected_candidate_hash: candidate.candidate_hash, decision: 'approved',
      checks: Object.fromEntries(candidate.required_checks.map(key => [key, { basis: 'human_watch_listen', result: 'passed' }])),
    });
    assert.equal(approved.status, 'approved');
    const attempt = h.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE id=?').get(h.attemptId);
    h.candidates.push({ attempt, file: path.resolve(h.root, JSON.parse(attempt.quality_json).candidate.relative_path) });
  }
  assert.equal(runRow(h).status, 'completed');
  assert.deepEqual(h.calls, { submits: 2, downloads: 2, other: 0 });
  const created = await composition.createComposition(h.ctx, { schema_version: SCHEMA, version_id: h.versionId,
    run_id: h.run.id, expected_plan_hash: h.run.plan_hash, expected_run_revision: runRow(h).revision,
    idempotency_key: 'unit-export-http-one-actual-composition' });
  h.export = await composition.runComposition(h.ctx, created.id);
  assert.equal(h.export.status, 'completed');
  h.manifest = JSON.parse(h.export.manifest_json);
  assertReleaseHash(h.manifest.episode_release, h.export.release_hash);
  h.files = Object.fromEntries(KINDS.map(kind => {
    const asset = h.db.prepare('SELECT * FROM assets WHERE id=?').get(h.manifest.outputs[`${kind}_asset_id`]);
    const filename = path.resolve(h.root, asset.local_path), bytes = fs.readFileSync(filename);
    assert.equal(hash(bytes), h.manifest.outputs.hashes[kind]);
    return [kind, { asset, filename, bytes }];
  }));
  h.sourceFile = path.join(h.root, 'source/source.mp4');
  const previous = { mode: process.env.PUBLIC_PLATFORM_MODE, secret: process.env.PLATFORM_JWT_SECRET };
  process.env.PUBLIC_PLATFORM_MODE = 'true'; process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
  let server;
  t.after(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    for (const [key, value] of [['PUBLIC_PLATFORM_MODE', previous.mode], ['PLATFORM_JWT_SECRET', previous.secret]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const forbidden = async () => { h.calls.other += 1; throw new Error('unexpected provider in HTTP GET'); };
  const app = express(); app.use(express.json());
  app.use('/api/v1', setupRouter({ storage: { local_path: h.root, base_url: BASE_URL } }, h.db, log, {
    localizationProvider: forbidden, assetGenerationProvider: forbidden, dialogueProvider: forbidden,
    providerAssetSecret: SECRET, redrawOptions: { executionRunEnv: {}, executionRunTempRoot: h.ctx.tempRoot,
      executionRunNowMs: () => Date.parse(NOW), sourceVideoTempRoot: h.ctx.tempRoot },
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  h.origin = `http://127.0.0.1:${server.address().port}`;
  h.headers = { Authorization: `Bearer ${h.actor.token}`, 'X-Tenant-Id': h.actor.tenantId };
  h.request = (endpoint, options = {}) => fetch(h.origin + endpoint, { ...options, headers: { ...h.headers, ...options.headers } });
  h.endpoint = `/api/v1/redraw/exports/${h.export.id}`;
  h.download = kind => `${h.endpoint}/download/${kind}`;
  return h;
}

function snapshot(h) {
  return { bytes: h.db.serialize(), changes: h.db.prepare('SELECT total_changes() n').get().n, calls: { ...h.calls } };
}

function safe(value) {
  const serialized = JSON.stringify(value);
  for (const secret of [KEY, SECRET, JWT_SECRET]) assert.equal(serialized.includes(secret), false);
  assert.doesNotMatch(serialized, /claim_token|relative_path|local_path|absolute_path|api_key|private_binding|provider_raw|result\.synthetic\.invalid|合成测试对白/);
}

async function rejected(h, endpoint, status, options) {
  const before = snapshot(h), response = await h.request(endpoint, options);
  const body = await response.json(); safe(body);
  assert.equal(response.status, status, `${endpoint}: ${JSON.stringify(body)}`);
  assert.equal(response.headers.get('x-content-sha256'), null);
  assert.equal(response.headers.get('content-disposition'), null);
  assert.match(response.headers.get('content-type'), /^application\/json\b/);
  assert.deepEqual(snapshot(h), before);
  return body;
}

function trackArtifact(t, filename, { onOpen, onStream } = {}) {
  const entries = [], live = new Set(), byFd = new Map();
  const open = fs.openSync, close = fs.closeSync, create = fs.createReadStream;
  t.mock.method(fs, 'openSync', (...args) => {
    const fd = open(...args); byFd.delete(fd);
    if (args[0] === filename) {
      const entry = { fd, closes: 0, streams: 0 }; entries.push(entry); live.add(fd); byFd.set(fd, entry);
      onOpen?.(fd);
    }
    return fd;
  });
  t.mock.method(fs, 'closeSync', fd => {
    const entry = byFd.get(fd); if (entry) entry.closes += 1;
    const result = close(fd); live.delete(fd); return result;
  });
  t.mock.method(fs, 'createReadStream', (file, options) => {
    const result = create(file, options);
    if (file === filename) {
      const entry = byFd.get(options.fd); assert.ok(entry);
      assert.equal(options.autoClose, false); entry.streams += 1;
      onStream?.(options.fd, result);
    }
    return result;
  });
  return { entries, live, async closed() {
    const deadline = Date.now() + 5000;
    while (live.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(live.size, 0, 'HTTP owns and closes every retained artifact FD');
    assert.ok(entries.length > 0, 'the actual protected artifact must have been opened');
    assert.ok(entries.every(entry => entry.closes === 1), JSON.stringify(entries));
  } };
}

test('owned execution-unit exports expose safe DTOs and four actual HTTP artifacts', { timeout: 1200000 }, async t => {
  const h = await completedHttpFixture(t);

  await t.test('list and detail retain unit identity, four artifact hashes and pending final review without legacy IDs', async () => {
    const before = snapshot(h);
    for (const endpoint of [`/api/v1/redraw/versions/${h.versionId}/exports`, h.endpoint]) {
      const response = await h.request(endpoint); assert.equal(response.status, 200);
      const body = await response.json(), value = Array.isArray(body.data) ? body.data.find(row => row.id === h.export.id) : body.data;
      assert.ok(value); safe(value);
      assert.equal(value.schema_version, SCHEMA);
      assert.equal(value.run_id, h.run.id); assert.equal(value.plan_hash, h.run.plan_hash);
      assert.equal(value.release_hash, h.export.release_hash); assert.equal(value.audio_mode, 'native');
      assert.deepEqual(value.quality_summary, { decision: 'approved_inputs', approved_unit_count: 2,
        human_review_count: 2, final_media_review: 'pending', dialogue_alignment: 'not_verified' });
      assert.equal(Object.hasOwn(value, 'video_generation_ids'), false);
      assert.equal(Object.hasOwn(value, 'audio_asset_ids'), false);
      for (const kind of KINDS) {
        assert.equal(value.output_asset_ids[kind], h.files[kind].asset.id);
        assert.equal(value.hashes[kind], hash(h.files[kind].bytes));
        assert.equal(value.downloads[kind], h.download(kind));
      }
      assert.equal(value.episode_release.run_id, h.run.id);
      assert.equal(value.episode_release.plan_hash, h.run.plan_hash);
      assert.equal(Object.hasOwn(value.episode_release, 'shots'), false);
      assert.equal(Object.hasOwn(value.episode_release, 'release_hash'), false,
        'the original hash belongs to the validated stored release, not its lossy safe projection');
    }
    assert.deepEqual(snapshot(h), before);
  });

  for (const kind of KINDS) await t.test(`${kind} is a real authenticated download with exact headers and complete SHA-bound bytes`, async st => {
    const handles = trackArtifact(st, h.files[kind].filename), before = snapshot(h);
    const response = await h.request(h.download(kind));
    if (response.status !== 200) {
      const body = await response.json(); safe(body);
      if (kind === 'mp4') {
        const httpContext = { db: h.db, tenantId: h.ctx.tenantId, userId: h.ctx.userId, storageRoot: h.root,
          config: { storage: { local_path: h.root, base_url: BASE_URL } } };
        const results = {};
        // Read-only diagnosis of the real release builder, not a substituted
        // route/validator result. Emit only safe codes and hash equality.
        for (const [name, ctx] of [['fixture', h.ctx], ['http', httpContext],
          ['http_with_owned_readability', { ...httpContext, canReadArtifact: h.ctx.canReadArtifact }]]) {
          try {
            const release = await buildEpisodeRelease(ctx, h.manifest.request);
            results[name] = { ok: true, hash_matches: release.release_hash === h.export.release_hash };
          } catch (error) {
            results[name] = { ok: false, code: /^[A-Z0-9_]+$/.test(String(error.code)) ? error.code : 'UNKNOWN_ERROR' };
          }
        }
        st.diagnostic(JSON.stringify({ real_release_context_diagnosis: results }));
      }
      assert.equal(response.status, 200, `the completed server unit schema must select its protected stream: ${JSON.stringify(body)}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, h.files[kind].bytes, 'the prefetched first chunk must not be lost or duplicated');
    const [mime, ...parameters] = response.headers.get('content-type').split(';').map(value => value.trim());
    assert.equal(mime, MIME[kind]);
    assert.ok(parameters.length <= 1);
    for (const parameter of parameters) assert.match(parameter, /^charset=utf-8$/i);
    assert.equal(response.headers.get('content-length'), String(bytes.length));
    assert.equal(response.headers.get('x-content-sha256'), hash(bytes));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-disposition'),
      `attachment; filename="redraw-export-${h.export.id}.${kind === 'report' ? 'json' : kind}"`);
    if (kind === 'report') {
      const report = JSON.parse(bytes); safe(report);
      assert.equal(report.schema_version, 'redraw-execution-unit-composition-report-v1');
      assert.equal(report.export_id, h.export.id); assert.equal(report.run_id, h.run.id);
      assert.equal(report.release_hash, h.export.release_hash);
      assert.equal(report.final_media_review, 'pending'); assert.equal(report.dialogue_alignment, 'not_verified');
      assert.equal(report.audio.mode, 'native'); assert.equal(report.units.length, 2);
      assert.equal(Object.hasOwn(report.outputs, 'report'), false, 'report SHA is external, never self-referential');
      for (const media of ['mp4', 'srt', 'vtt']) assert.equal(report.outputs[media].sha256, hash(h.files[media].bytes));
    } else if (kind === 'mp4') {
      const downloaded = path.join(h.ctx.tempRoot, 'http-export-downloaded.mp4');
      fs.writeFileSync(downloaded, bytes, { flag: 'wx' });
      const { stdout } = await runMedia(getFfprobePath(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', downloaded],
        { windowsHide: true, timeout: 20000 });
      const probe = JSON.parse(stdout), video = probe.streams.find(stream => stream.codec_type === 'video');
      assert.equal(video.width, 854); assert.equal(video.height, 480);
      assert.equal(video.sample_aspect_ratio, '1280:1281'); assert.equal(video.display_aspect_ratio, '16:9');
      assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
      assert.ok(Math.abs(Number(probe.format.duration) - 12) < 0.25);
    } else {
      assert.match(bytes.toString(), /Bring the blue folder\./);
      assert.equal(bytes.toString(), h.manifest.episode_release.subtitles[kind]);
    }
    await handles.closed();
    assert.equal(handles.entries.length, 1); assert.equal(handles.entries[0].streams, 1);
    assert.deepEqual(snapshot(h), before);
  });

  await t.test('cross-owner and cross-tenant requests cannot read list, detail or artifact bytes', async () => {
    const other = registerActor(h.db);
    for (const endpoint of [`/api/v1/redraw/versions/${h.versionId}/exports`, h.endpoint, ...KINDS.map(h.download)]) {
      await rejected(h, endpoint, 404, { headers: { Authorization: `Bearer ${other.token}`, 'X-Tenant-Id': other.tenantId } });
      await rejected(h, endpoint, 404, { headers: { 'X-Tenant-Id': other.tenantId } });
    }
  });

  await t.test('foreign unit GETs cannot recreate the requesting actor membership', async st => {
    const other = registerActor(h.db);
    const member = h.db.prepare('SELECT * FROM tenant_members WHERE tenant_id=? AND user_id=?').get(other.tenantId, other.user.id);
    const targets = { list: `/api/v1/redraw/versions/${h.versionId}/exports`, detail: h.endpoint, download: h.download('report') };
    for (const [name, endpoint] of Object.entries(targets)) {
      for (const [selection, tenant] of [['default', null], ['explicit_own', other.tenantId], ['wrong_tenant', h.actor.tenantId]]) {
        await st.test(`${name}/${selection} rejects without membership repair or any business write`, async () => {
          h.db.prepare('DELETE FROM tenant_members WHERE tenant_id=? AND user_id=?').run(other.tenantId, other.user.id);
          const before = snapshot(h);
          try {
            const response = await fetch(h.origin + endpoint, { headers: { Authorization: `Bearer ${other.token}`,
              ...(tenant === null ? {} : { 'X-Tenant-Id': tenant }) } });
            const body = await response.json(); safe(body);
            assert.equal(response.status, 404, JSON.stringify(body));
            assert.equal(response.headers.get('x-content-sha256'), null);
            assert.equal(h.db.prepare('SELECT total_changes() n').get().n, before.changes,
              'a rejected unit read must not run the legacy personal-tenant initializer');
            assert.equal(hash(h.db.serialize()), hash(before.bytes));
            assert.deepEqual(h.calls, before.calls);
            assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_members WHERE tenant_id=? AND user_id=?')
              .get(other.tenantId, other.user.id).n, 0);
          } finally {
            h.db.prepare('DELETE FROM tenant_members WHERE tenant_id=? AND user_id=?').run(other.tenantId, other.user.id);
            const keys = Object.keys(member); assert.ok(keys.every(key => /^[a-z_]+$/.test(key)));
            h.db.prepare(`INSERT INTO tenant_members (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => member[key]));
          }
        });
      }
    }
  });

  await t.test('soft-deleted unit metadata still routes foreign GET rejection without recreating a missing member', async () => {
    const other = registerActor(h.db);
    const member = h.db.prepare('SELECT * FROM tenant_members WHERE tenant_id=? AND user_id=?').get(other.tenantId, other.user.id);
    const deletedAt = h.db.prepare('SELECT deleted_at FROM redraw_exports WHERE id=?').get(h.export.id).deleted_at;
    h.db.prepare('DELETE FROM tenant_members WHERE tenant_id=? AND user_id=?').run(other.tenantId, other.user.id);
    h.db.prepare('UPDATE redraw_exports SET deleted_at=? WHERE id=?').run(NOW, h.export.id);
    try {
      for (const endpoint of [`/api/v1/redraw/versions/${h.versionId}/exports`, h.endpoint, h.download('report')]) {
        const before = snapshot(h);
        const response = await fetch(h.origin + endpoint, { headers: { Authorization: `Bearer ${other.token}` } });
        const body = await response.json(); safe(body);
        assert.equal(response.status, 404, JSON.stringify(body));
        assert.equal(response.headers.get('x-content-sha256'), null);
        assert.equal(h.db.prepare('SELECT total_changes() n').get().n, before.changes,
          'soft-deleted unit metadata must not fall through to the personal-tenant initializer');
        assert.equal(hash(h.db.serialize()), hash(before.bytes));
        assert.deepEqual(h.calls, before.calls);
        assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_members WHERE tenant_id=? AND user_id=?')
          .get(other.tenantId, other.user.id).n, 0);
      }
    } finally {
      h.db.prepare('UPDATE redraw_exports SET deleted_at=? WHERE id=?').run(deletedAt, h.export.id);
      h.db.prepare('DELETE FROM tenant_members WHERE tenant_id=? AND user_id=?').run(other.tenantId, other.user.id);
      const keys = Object.keys(member); assert.ok(keys.every(key => /^[a-z_]+$/.test(key)));
      h.db.prepare(`INSERT INTO tenant_members (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => member[key]));
    }
  });

  await t.test('the default personal tenant is read-only and a deleted membership is not recreated', async () => {
    const endpoint = `/api/v1/redraw/versions/${h.versionId}/exports`, before = snapshot(h);
    const response = await fetch(h.origin + endpoint, { headers: { Authorization: h.headers.Authorization } });
    assert.equal(response.status, 200); safe(await response.json()); assert.deepEqual(snapshot(h), before);
    const member = h.db.prepare('SELECT * FROM tenant_members WHERE tenant_id=? AND user_id=?').get(h.actor.tenantId, h.actor.user.id);
    h.db.prepare('DELETE FROM tenant_members WHERE tenant_id=? AND user_id=?').run(h.actor.tenantId, h.actor.user.id);
    try {
      for (const target of [endpoint, h.endpoint, h.download('report')]) await rejected(h, target, 404);
      assert.equal(h.db.prepare('SELECT count(*) n FROM tenant_members WHERE tenant_id=? AND user_id=?')
        .get(h.actor.tenantId, h.actor.user.id).n, 0);
    } finally {
      const keys = Object.keys(member); assert.ok(keys.every(key => /^[a-z_]+$/.test(key)));
      h.db.prepare('DELETE FROM tenant_members WHERE tenant_id=? AND user_id=?').run(h.actor.tenantId, h.actor.user.id);
      h.db.prepare(`INSERT INTO tenant_members (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => member[key]));
    }
  });

  await t.test('unknown artifact kind is a safe rejection', async () => {
    const body = await rejected(h, h.download('unknown'), 422);
    assert.equal(body.error.code, 'REDRAW_EXPORT_KIND_INVALID');
  });

  await t.test('non-completed exports do not advertise ready downloads and never stream', async () => {
    for (const status of ['pending', 'processing', 'needs_attention', 'failed']) {
      h.db.prepare('UPDATE redraw_exports SET status=? WHERE id=?').run(status, h.export.id);
      try {
        const response = await h.request(h.endpoint), body = await response.json();
        assert.equal(response.status, 200); assert.equal(body.data.status, status);
        assert.equal(Object.hasOwn(body.data, 'downloads'), false); safe(body);
        const rejectedBody = await rejected(h, h.download('mp4'), 409);
        assert.equal(rejectedBody.error.code, 'REDRAW_EXPORT_NOT_READY');
      } finally { h.db.prepare("UPDATE redraw_exports SET status='completed' WHERE id=?").run(h.export.id); }
    }
  });

  await t.test('the stored exact unit release is checked before safe DTO projection', async () => {
    const tainted = structuredClone(h.manifest);
    tainted.episode_release.private_binding = { api_key: 'synthetic-never-project-this' };
    h.db.prepare('UPDATE redraw_exports SET manifest_json=? WHERE id=?').run(JSON.stringify(tainted), h.export.id);
    try {
      for (const endpoint of [`/api/v1/redraw/versions/${h.versionId}/exports`, h.endpoint]) {
        const response = await h.request(endpoint), body = await response.json();
        assert.equal(response.status, 200); safe(body);
        const value = Array.isArray(body.data) ? body.data.find(row => row.id === h.export.id) : body.data;
        assert.equal(Object.hasOwn(value, 'release_hash'), false);
        assert.equal(Object.hasOwn(value, 'quality_summary'), false);
        assert.equal(Object.hasOwn(value, 'episode_release'), false);
        assert.equal(Object.hasOwn(value, 'downloads'), false, 'invalid stored release must not advertise ready unit artifacts');
      }
      const body = await rejected(h, h.download('report'), 409);
      assert.equal(body.error.code, 'REDRAW_EXPORT_RELEASE_HASH_MISMATCH');
    } finally { h.db.prepare('UPDATE redraw_exports SET manifest_json=? WHERE id=?').run(h.export.manifest_json, h.export.id); }
  });

  await t.test('a missing or wrong stored unit schema cannot fall back to the legacy shot DTO or download', async () => {
    for (const schema of [undefined, 'redraw-episode-release-v1']) {
      const invalid = structuredClone(h.manifest); invalid.schema_version = schema;
      h.db.prepare('UPDATE redraw_exports SET manifest_json=? WHERE id=?').run(JSON.stringify(invalid), h.export.id);
      try {
        const response = await h.request(h.endpoint), body = await response.json();
        assert.equal(response.status, 200); safe(body);
        assert.equal(Object.hasOwn(body.data, 'downloads'), false);
        assert.equal(Object.hasOwn(body.data, 'video_generation_ids'), false);
        assert.equal(Object.hasOwn(body.data, 'audio_asset_ids'), false);
        const error = await rejected(h, h.download('report'), 409);
        assert.equal(error.error.code, 'REDRAW_EXPORT_RELEASE_HASH_MISMATCH');
      } finally { h.db.prepare('UPDATE redraw_exports SET manifest_json=? WHERE id=?').run(h.export.manifest_json, h.export.id); }
    }
  });

  for (const kind of ['run', 'review', 'source', 'candidate', 'output', 'asset_owner']) {
    await t.test(`${kind} drift is rejected as safe JSON before any successful download headers`, async () => {
      const first = h.candidates[0];
      let restore;
      if (kind === 'run') {
        const revision = runRow(h).revision;
        h.db.prepare('UPDATE redraw_execution_runs SET revision=revision+1 WHERE id=?').run(h.run.id);
        restore = () => h.db.prepare('UPDATE redraw_execution_runs SET revision=? WHERE id=?').run(revision, h.run.id);
      } else if (kind === 'review') {
        const envelope = JSON.parse(first.attempt.quality_json); envelope.review.reviewed_by = 'foreign-reviewer';
        h.db.prepare('UPDATE redraw_execution_unit_attempts SET quality_json=? WHERE id=?').run(JSON.stringify(envelope), first.attempt.id);
        restore = () => h.db.prepare('UPDATE redraw_execution_unit_attempts SET quality_json=? WHERE id=?').run(first.attempt.quality_json, first.attempt.id);
      } else if (kind === 'asset_owner') {
        const asset = h.files.report.asset, metadata = JSON.parse(asset.metadata); metadata.user_id = 'foreign-owner';
        h.db.prepare('UPDATE assets SET metadata=? WHERE id=?').run(JSON.stringify(metadata), asset.id);
        restore = () => h.db.prepare('UPDATE assets SET metadata=? WHERE id=?').run(asset.metadata, asset.id);
      } else {
        const file = kind === 'source' ? h.sourceFile : kind === 'candidate' ? first.file : h.files.report.filename;
        const bytes = fs.readFileSync(file), changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
        fs.writeFileSync(file, changed); restore = () => fs.writeFileSync(file, bytes);
      }
      try {
        const body = await rejected(h, h.download('report'), kind === 'output' ? 422 : 409);
        assert.equal(body.error.code, kind === 'output' ? 'REDRAW_EXPORT_CHECKSUM_MISMATCH'
          : kind === 'asset_owner' ? 'REDRAW_EXPORT_ASSET_INVALID' : 'REDRAW_EXPORT_RELEASE_HASH_MISMATCH');
      } finally { restore(); }
    });
  }

  await t.test('run drift after artifact preparation is caught by the first iterator read before headers', async st => {
    const revision = runRow(h).revision; let injected = 0;
    const handles = trackArtifact(st, h.files.report.filename, { onOpen() {
      injected += 1; h.db.prepare('UPDATE redraw_execution_runs SET revision=revision+1 WHERE id=?').run(h.run.id);
    } });
    try {
      const response = await h.request(h.download('report'));
      assert.equal(injected, 1, 'drift must occur after the first actual release rebuild opens the artifact');
      assert.equal(response.status, 409); assert.equal(response.headers.get('x-content-sha256'), null);
      const body = await response.json(); safe(body); assert.equal(body.error.code, 'REDRAW_EXPORT_RELEASE_HASH_MISMATCH');
      await handles.closed();
    } finally { h.db.prepare('UPDATE redraw_execution_runs SET revision=? WHERE id=?').run(revision, h.run.id); }
  });

  for (const [name, sql, args, reset, status] of [
    ['user', 'UPDATE platform_users SET status=? WHERE id=?', ['disabled', h.actor.user.id], 'active', 401],
    ['token', 'UPDATE platform_users SET token_version=? WHERE id=?', [1, h.actor.user.id], 0, 401],
    ['membership', 'UPDATE tenant_members SET status=? WHERE tenant_id=? AND user_id=?', ['disabled', h.actor.tenantId, h.actor.user.id], 'active', 404],
    ['tenant', 'UPDATE tenants SET status=? WHERE id=?', ['disabled', h.actor.tenantId], 'active', 404],
  ]) await t.test(`${name} revocation during actual stream preparation is checked before success headers`, async st => {
    let injected = 0, expected;
    const handles = trackArtifact(st, h.files.report.filename, { onStream() {
      injected += 1; h.db.prepare(sql).run(...args); expected = snapshot(h);
    } });
    try {
      const response = await h.request(h.download('report'));
      assert.equal(injected, 1); assert.equal(response.status, status);
      assert.equal(response.headers.get('x-content-sha256'), null);
      const body = await response.json(); safe(body);
      if (status === 401) assert.equal(body.error.code, 'UNAUTHORIZED');
      await handles.closed(); assert.deepEqual(snapshot(h), expected);
    } finally { h.db.prepare(sql).run(reset, ...args.slice(1)); }
  });

  await t.test('GET query and JSON body cannot override server schema, output path or release', async () => {
    for (const query of ['?schema_version=redraw-episode-release-v1', '?path=C%3A%5Csynthetic-client.mp4', '?run_id=1']) {
      await rejected(h, h.download('mp4') + query, 400);
    }
    for (const value of [{ path: 'C:\\synthetic-client-only.mp4', schema_version: SCHEMA }, []]) {
      const body = JSON.stringify(value), before = snapshot(h);
      const result = await new Promise((resolve, reject) => {
        const request = http.request(h.origin + h.download('mp4'), { method: 'GET', headers: { ...h.headers,
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
          const chunks = []; response.on('data', chunk => chunks.push(chunk));
          response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
          response.once('error', reject);
        });
        request.once('error', reject); request.end(body);
      });
      assert.equal(result.status, 400); assert.equal(result.headers['x-content-sha256'], undefined);
      safe(JSON.parse(result.bytes)); assert.deepEqual(snapshot(h), before);
    }
  });

  await t.test('asset-owner drift after the client receives bytes aborts HTTP when the held next read resumes', { timeout: 60000 }, async st => {
    assert.ok(h.files.mp4.bytes.length > 65536, 'the real MP4 must require more than one physical read');
    let fd, releaseRead, nextReadReady, firstBytesReceived, request, mutated = false;
    const nextRead = new Promise(resolve => { nextReadReady = resolve; });
    const firstBytes = new Promise(resolve => { firstBytesReceived = resolve; });
    const handles = trackArtifact(st, h.files.mp4.filename, { onStream(descriptor) { fd = descriptor; } });
    const read = fs.read;
    st.mock.method(fs, 'read', (descriptor, ...args) => {
      const position = args[3];
      if (descriptor !== fd || position < 65536 || releaseRead) return read(descriptor, ...args);
      const callback = args.pop();
      return read(descriptor, ...args, (...result) => {
        let released = false;
        releaseRead = () => { if (!released) { released = true; callback(...result); } };
        nextReadReady();
      });
    });
    const chunks = [], asset = h.files.mp4.asset;
    const received = new Promise((resolve, reject) => {
      request = http.get(h.origin + h.download('mp4'), { headers: h.headers }, response => {
        if (response.statusCode !== 200) {
          response.resume(); reject(new assert.AssertionError({ message: 'the real download must reach successful headers before injection',
            actual: response.statusCode, expected: 200, operator: 'strictEqual' })); return;
        }
        response.on('data', chunk => { chunks.push(chunk); firstBytesReceived(); });
        response.once('aborted', () => resolve({ complete: false, headers: response.headers }));
        response.once('error', () => resolve({ complete: false, headers: response.headers }));
        response.once('end', () => resolve({ complete: response.complete, headers: response.headers }));
      });
      request.once('error', reject);
    });
    st.after(() => { releaseRead?.(); request?.destroy(); });
    try {
      await Promise.race([Promise.all([nextRead, firstBytes]),
        received.then(() => assert.fail('HTTP terminated before both a client-visible first chunk and the held next read'))]);
      assert.ok(Buffer.concat(chunks).length > 0);
      const metadata = JSON.parse(asset.metadata); metadata.user_id = 'synthetic-post-headers-foreign-owner';
      h.db.prepare('UPDATE assets SET metadata=? WHERE id=?').run(JSON.stringify(metadata), asset.id); mutated = true;
      const expected = snapshot(h);
      releaseRead();
      const response = await received;
      assert.equal(response.complete, false, 'a stale export must destroy an already-started HTTP response');
      assert.equal(response.headers['x-content-sha256'], hash(h.files.mp4.bytes));
      const delivered = Buffer.concat(chunks);
      assert.ok(delivered.length > 0 && delivered.length < h.files.mp4.bytes.length);
      assert.deepEqual(delivered, h.files.mp4.bytes.subarray(0, delivered.length));
      await handles.closed(); assert.deepEqual(snapshot(h), expected);
    } finally {
      releaseRead?.(); request?.destroy();
      try { if (handles.entries.length) await handles.closed(); }
      finally { if (mutated) h.db.prepare('UPDATE assets SET metadata=? WHERE id=?').run(asset.metadata, asset.id); }
    }
  });

  for (const interruption of ['client_abort', 'stream_error']) {
    await t.test(`${interruption} waits for a pending physical read before exactly one FD cleanup`, { timeout: 60000 }, async st => {
      let fd, stream, publicStream, releaseRead, startRead, destroyStream;
      const publicStreams = [];
      const started = new Promise(resolve => { startRead = resolve; });
      const destroyed = new Promise(resolve => { destroyStream = resolve; });
      const handles = trackArtifact(st, h.files.mp4.filename, { onStream(descriptor, value) {
        fd = descriptor; stream = value;
        if (interruption === 'client_abort') {
          assert.equal(publicStreams.length, 1, 'exactly one protected output must precede the physical artifact stream');
          [publicStream] = publicStreams;
        }
        const observed = publicStream || value, destroy = observed.destroy.bind(observed);
        st.mock.method(observed, 'destroy', (...args) => { const result = destroy(...args); destroyStream(); return result; });
      } });
      if (interruption === 'client_abort') {
        const from = Readable.from;
        st.mock.method(Readable, 'from', function (...args) {
          const value = Reflect.apply(from, this, args);
          // The service output is created after artifact open and before its source.
          // The HTTP wrapper cannot exist until the held first read completes.
          if (handles.entries.length === 1 && handles.live.has(handles.entries[0].fd) && !stream) publicStreams.push(value);
          return value;
        });
      }
      const read = fs.read;
      st.mock.method(fs, 'read', (descriptor, ...args) => {
        if (descriptor !== fd || releaseRead) return read(descriptor, ...args);
        const callback = args.pop();
        return read(descriptor, ...args, (...result) => {
          let released = false;
          releaseRead = () => { if (!released) { released = true; callback(...result); } }; startRead();
        });
      });
      const before = snapshot(h);
      const request = http.get(h.origin + h.download('mp4'), { headers: h.headers });
      request.on('error', () => {});
      const earlyResponse = new Promise(resolve => request.once('response', response => {
        response.on('error', () => {}); response.resume(); resolve(response.statusCode);
      }));
      st.after(() => { releaseRead?.(); request.destroy(); });
      await Promise.race([started, earlyResponse.then(status => assert.fail(`download returned ${status} without the controlled artifact read`))]);
      assert.equal(handles.entries.length, 1);
      if (interruption === 'client_abort') request.destroy();
      else stream.destroy(new Error('synthetic-private-stream-failure'));
      let timeout;
      try {
        const didDestroy = await Promise.race([destroyed.then(() => true), new Promise(resolve => {
          timeout = setTimeout(() => resolve(false), 2000);
        })]);
        clearTimeout(timeout);
        assert.equal(didDestroy, true, 'abort/error must destroy the observed stream before waiting for its in-flight read');
        if (interruption === 'client_abort') assert.equal(publicStream.destroyed, true);
        await new Promise(setImmediate);
        assert.ok(handles.live.has(fd), 'cleanup cannot close a borrowed FD while its read callback is pending');
        assert.equal(handles.entries[0].closes, 0);
        assert.equal(fs.fstatSync(fd).size, h.files.mp4.bytes.length);
      }
      finally { releaseRead(); }
      await handles.closed(); assert.deepEqual(snapshot(h), before);
    });
  }

  await t.test('a separate owned legacy-v1 composition still serves its original DTO and real three-file HTTP downloads', async () => {
    // Synthetic legacy input rows and explicit synthetic human decisions only.
    // No completed export is seeded: the real old review/release/composition
    // services publish their own output through the default FFmpeg runner.
    const source = h.db.prepare('SELECT * FROM redraw_works WHERE id=(SELECT work_id FROM redraw_versions WHERE id=?)').get(h.versionId);
    const workId = Number(source.id);
    const version = h.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS next FROM redraw_versions WHERE work_id=?').get(workId).next;
    const versionId = Number(h.db.prepare(`INSERT INTO redraw_versions
      (work_id,tenant_id,user_id,version,locale,market,status,created_at,updated_at)
      VALUES (?,?,?,?,'en-US','US','ready_to_generate',?,?)`).run(workId, h.ctx.tenantId, h.ctx.userId, version, NOW, NOW).lastInsertRowid);
    const shots = [];
    for (const [index, candidate] of h.candidates.entries()) {
      const unit = h.manifest.episode_release.units[index];
      const relative = path.relative(h.root, candidate.file).replace(/\\/g, '/');
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      const videoId = Number(h.db.prepare(`INSERT INTO video_generations
        (tenant_id,user_id,local_path,status,duration,aspect_ratio,created_at,updated_at)
        VALUES (?,?,?,'completed',?,'16:9',?,?)`).run(h.ctx.tenantId, h.ctx.userId, relative,
        unit.timeline.generated_duration_ms / 1000, NOW, NOW).lastInsertRowid);
      const shotId = Number(h.db.prepare(`INSERT INTO redraw_shots
        (work_id,version_id,tenant_id,user_id,batch_index,shot_index,start_ms,end_ms,duration_ms,
         localized_dialogue_json,draft_json,video_generation_id,status,created_at,updated_at)
        VALUES (?,?,?,?,1,?,?,?,?,'[]','{}',?,'completed',?,?)`).run(String(workId), versionId, h.ctx.tenantId, h.ctx.userId,
        index + 1, unit.output_start_ms, unit.output_end_ms, unit.timeline.retained_duration_ms, videoId, NOW, NOW).lastInsertRowid);
      shots.push({ shotId, videoId, sha256: hash(fs.readFileSync(candidate.file)) });
    }
    const ctx = { db: h.db, tenantId: h.ctx.tenantId, userId: h.ctx.userId, storageRoot: h.root, clock: () => NOW };
    for (const shot of shots) {
      const approved = await reviewCandidate(ctx, { shot_id: shot.shotId, video_generation_id: shot.videoId,
        decision_source: 'human', decision: 'approved', candidate_sha256: shot.sha256, expected_updated_at: NOW });
      assert.equal(approved.decision, 'approved'); assert.equal(approved.decision_source, 'human');
    }
    const created = await composition.createComposition(ctx, { versionId, idempotencyKey: 'legacy-http-control', audioMode: 'replace' });
    assert.equal(created.status, 'pending');
    const completed = await composition.runComposition(ctx, created.id);
    assert.equal(completed.status, 'completed');
    const manifest = JSON.parse(completed.manifest_json), endpoint = `/api/v1/redraw/exports/${completed.id}`;
    assert.equal(manifest.episode_release.schema_version, 'redraw-episode-release-v1');
    assertReleaseHash(manifest.episode_release, completed.release_hash);
    const before = snapshot(h);
    for (const target of [`/api/v1/redraw/versions/${versionId}/exports`, endpoint]) {
      const response = await h.request(target), body = await response.json();
      assert.equal(response.status, 200); safe(body);
      const value = Array.isArray(body.data) ? body.data.find(row => row.id === completed.id) : body.data;
      assert.equal(value.audio_mode, 'replace'); assert.equal(value.release_hash, completed.release_hash);
      assert.equal(Object.hasOwn(value, 'schema_version'), false);
      assert.equal(Object.hasOwn(value, 'run_id'), false);
      assert.equal(value.downloads.report, endpoint, 'the historical report remains its original detail DTO');
      assert.deepEqual(value.video_generation_ids, shots.map(shot => shot.videoId));
      assert.deepEqual(value.episode_release, manifest.episode_release);
      assert.deepEqual(value.quality_summary, { decision: 'approved', approved_shot_count: 2, automatic_review_count: 0, human_review_count: 2 });
      assert.equal(Object.hasOwn(value.output_asset_ids, 'report'), false);
      assert.equal(Object.hasOwn(value.hashes, 'report'), false);
    }
    for (const kind of ['mp4', 'srt', 'vtt']) {
      const response = await h.request(`${endpoint}/download/${kind}`);
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(response.headers.get('content-type').split(';')[0], MIME[kind]);
      assert.equal(response.headers.get('content-length'), String(bytes.length));
      assert.equal(response.headers.get('x-content-sha256'), hash(bytes));
      assert.equal(hash(bytes), manifest.outputs.hashes[kind]);
      assert.deepEqual(bytes, fs.readFileSync(path.resolve(h.root, manifest.outputs[`${kind}_path`])));
    }
    assert.deepEqual(snapshot(h), before);
  });
});

test('a genuinely dialogue-free unit export serves empty SRT through the same HTTP stream contract', { timeout: 180000 }, async t => {
  const h = await completedHttpFixture(t, 'not_required');
  assert.deepEqual(h.manifest.episode_release.subtitles.cues, []);
  assert.equal(h.files.srt.bytes.length, 0);
  const before = snapshot(h), handles = trackArtifact(t, h.files.srt.filename);
  const response = await h.request(h.download('srt'));
  if (response.status !== 200) {
    const body = await response.json(); safe(body);
    assert.equal(response.status, 200, `done=true at prefetch is a valid empty SRT, not an unavailable artifact: ${JSON.stringify(body)}`);
  }
  assert.equal(response.headers.get('content-type'), MIME.srt);
  assert.equal(response.headers.get('content-length'), '0');
  assert.equal(response.headers.get('x-content-sha256'), hash(Buffer.alloc(0)));
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  await handles.closed(); assert.equal(handles.entries.length, 1);
  assert.equal(handles.entries[0].streams, 0, 'empty SRT must not create an invalid end=-1 physical ReadStream');
  assert.deepEqual(snapshot(h), before);
});
