'use strict';

// DRAFT FOR STATIC REVIEW: do not run outside the root-approved isolated entry.
// Real local media, SQLite, release, Assembly and artifact reads. Provider
// responses and human approvals are synthetic, not final content acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { approvedCompositionRun, compositionRequest, protectedBusinessSnapshot,
  candidateSnapshot, hash, runRow } = require('./helpers/redrawExecutionUnitCompositionFixture');
const composition = require('../src/services/redrawCompositionService');
const exportsService = require('../src/services/redrawExportService');
const assemblyService = require('../src/services/redrawUnitAssemblyService');
const { assertReleaseHash } = require('../src/services/redrawEpisodeReleaseService');
const { defaultCompositionRunner } = require('../src/services/redrawMediaRuntimeInternal');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');

const runMedia = promisify(execFile);
const SCHEMA = 'redraw-execution-unit-composition-v1';
const REPORT_SCHEMA = 'redraw-execution-unit-composition-report-v1';
const KINDS = ['mp4', 'srt', 'vtt', 'report'];
const exactKeys = (value, keys) => assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
const changes = h => h.db.prepare('SELECT total_changes() AS n').get().n;
const exportRow = (h, id) => h.db.prepare('SELECT * FROM redraw_exports WHERE id=?').get(id);
const assetCount = h => h.db.prepare('SELECT count(*) AS n FROM assets').get().n;
const errorCode = code => error => error?.code === code;

function exportDirectories(h) {
  const directory = path.join(h.root, 'redraw', `version-${h.versionId}`, 'exports');
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

function releaseRequest(input) {
  return { schema_version: 'redraw-execution-unit-release-v1', version_id: input.version_id,
    run_id: input.run_id, expected_plan_hash: input.expected_plan_hash,
    expected_run_revision: input.expected_run_revision };
}

function planRequest(h) {
  const { idempotency_key: _key, ...request } = compositionRequest(h);
  return request;
}

function assertNoPrivateValues(value) {
  if (Array.isArray(value)) return value.forEach(assertNoPrivateValues);
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert.doesNotMatch(key, /(?:prompt|source_text|api_key|secret|token|absolute_path|local_path|connection|^url$|_url$|_path$)/i);
      assertNoPrivateValues(item);
    }
  } else if (typeof value === 'string') {
    assert.doesNotMatch(value, /^(?:https?:\/\/|file:\/\/|[a-z]:[\\/]|\\\\|\/)/i);
    assert.doesNotMatch(value, /synthetic-dispatch-video-key|synthetic-dispatch-provider-signing-secret|源对白/);
  }
}

function publishedArtifacts(h, row) {
  const manifest = JSON.parse(row.manifest_json);
  assert.equal(manifest.schema_version, SCHEMA);
  assertReleaseHash(manifest.episode_release, row.release_hash);
  assert.equal(manifest.episode_release.schema_version, 'redraw-execution-unit-release-v1');
  assert.equal(manifest.episode_release.run_id, h.run.id);
  assert.equal(manifest.episode_release.run_revision, runRow(h).revision);
  assert.deepEqual(manifest.request, releaseRequest(compositionRequest(h)));
  assert.equal(manifest.inputs.release_hash, row.release_hash);
  assert.equal(manifest.inputs.run_id, h.run.id);
  assert.equal(manifest.inputs.plan_hash, h.run.plan_hash);
  assert.equal(Object.hasOwn(manifest.inputs, 'video_generation_ids'), false);
  assert.equal(Object.hasOwn(manifest.inputs, 'audio_asset_ids'), false);
  exactKeys(manifest.outputs.hashes, KINDS);
  const files = {};
  const expected = { mp4: ['video', 'video/mp4', 'composition_video'],
    srt: ['subtitle', 'application/x-subrip', 'subtitle_srt'],
    vtt: ['subtitle', 'text/vtt', 'subtitle_vtt'],
    report: ['json', 'application/json', 'composition_report'] };
  const ids = new Set();
  for (const kind of KINDS) {
    const id = manifest.outputs[`${kind}_asset_id`];
    assert.ok(Number.isSafeInteger(id) && id > 0);
    assert.equal(ids.has(id), false); ids.add(id);
    const asset = h.db.prepare('SELECT * FROM assets WHERE id=?').get(id);
    assert.ok(asset);
    assert.equal(asset.deleted_at, null);
    assert.deepEqual([asset.type, asset.mime_type, JSON.parse(asset.metadata).kind], expected[kind]);
    assert.equal(asset.category, 'redraw_composition');
    const metadata = JSON.parse(asset.metadata);
    assert.equal(metadata.tenant_id, h.ctx.tenantId);
    assert.equal(metadata.user_id, h.ctx.userId);
    assert.equal(metadata.version_id, h.versionId);
    assert.equal(metadata.export_id, row.id);
    assert.equal(asset.local_path, manifest.outputs[`${kind}_path`]);
    const absolute = path.resolve(h.root, asset.local_path);
    const relative = path.relative(h.root, absolute);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.equal(fs.lstatSync(absolute).isSymbolicLink(), false);
    const bytes = fs.readFileSync(absolute);
    if (kind === 'srt' && manifest.episode_release.subtitles.cues.length === 0) {
      assert.equal(bytes.length, 0, 'a genuinely dialogue-free release has an empty SRT');
    } else assert.ok(bytes.length > 0);
    assert.equal(hash(bytes), manifest.outputs.hashes[kind]);
    files[kind] = { asset, absolute, bytes, sha256: hash(bytes) };
  }
  assert.equal(row.asset_id, files.mp4.asset.id);
  assert.equal(row.subtitle_asset_id, files.srt.asset.id);
  const directory = path.dirname(files.mp4.absolute);
  for (const kind of KINDS) assert.equal(path.dirname(files[kind].absolute), directory);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['composition.mp4', 'composition.srt', 'composition.vtt', 'composition-report.json'].sort());
  const release = manifest.episode_release;
  assert.equal(files.srt.bytes.toString('utf8'), release.subtitles.srt);
  assert.equal(files.vtt.bytes.toString('utf8'), release.subtitles.vtt);
  const report = JSON.parse(files.report.bytes);
  assert.equal(report.schema_version, REPORT_SCHEMA);
  assert.equal(report.export_id, row.id);
  assert.equal(report.version_id, h.versionId);
  assert.equal(report.run_id, h.run.id);
  assert.equal(report.release_hash, row.release_hash);
  assert.equal(report.input_hash, manifest.inputs.input_hash);
  assert.equal(report.final_media_review, 'pending');
  assert.equal(report.dialogue_alignment, 'not_verified');
  assert.equal(report.audio.mode, release.audio_mode);
  exactKeys(report.outputs, ['mp4', 'srt', 'vtt']);
  for (const kind of ['mp4', 'srt', 'vtt']) {
    assert.equal(report.outputs[kind].sha256, files[kind].sha256);
    assert.equal(report.outputs[kind].bytes, files[kind].bytes.length);
  }
  assert.deepEqual(report.units.map(unit => [unit.unit_id, unit.ordinal, unit.output_start_ms, unit.output_end_ms]),
    release.units.map(unit => [unit.unit_id, unit.ordinal, unit.output_start_ms, unit.output_end_ms]));
  assert.deepEqual(report.units.map(unit => unit.timeline), release.units.map(unit => unit.timeline));
  assertNoPrivateValues(report);
  const quality = JSON.parse(row.quality_summary_json);
  assert.equal(quality.decision, 'approved_inputs');
  assert.equal(quality.final_media_review, 'pending');
  assert.equal(quality.dialogue_alignment, 'not_verified');
  return { manifest, report, files };
}

async function probeFile(file) {
  const { stdout } = await runMedia(getFfprobePath(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
    { windowsHide: true, timeout: 120000 });
  return JSON.parse(stdout);
}

function assertReportedMedia(result, probe) {
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  assert.ok(video);
  assert.deepEqual(result.report.media, {
    mime_type: 'video/mp4', bytes: result.files.mp4.bytes.length, sha256: result.files.mp4.sha256,
    duration_ms: Math.round(Number(probe.format.duration) * 1000), width: video.width, height: video.height,
    sample_aspect_ratio: video.sample_aspect_ratio, display_aspect_ratio: video.display_aspect_ratio,
    has_audio: probe.streams.some(stream => stream.codec_type === 'audio'),
  }, 'safe report media must match the independently probed published MP4');
}

async function sampleColor(file, second) {
  const { stdout } = await runMedia(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-ss', String(second),
    '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
  { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' });
  assert.ok(stdout.length > 0);
  const sums = [0, 0, 0];
  for (let i = 0; i < stdout.length; i += 3) {
    sums[0] += stdout[i]; sums[1] += stdout[i + 1]; sums[2] += stdout[i + 2];
  }
  return sums.map(value => value / (stdout.length / 3));
}

async function sampleFrequency(file, second) {
  const { stdout } = await runMedia(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-ss', String(second),
    '-i', file, '-t', '0.5', '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'],
  { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer' });
  assert.ok(stdout.length >= 48000);
  let crossings = 0;
  for (let offset = 2; offset + 1 < stdout.length; offset += 2) {
    const before = stdout.readInt16LE(offset - 2), current = stdout.readInt16LE(offset);
    if ((before < 0 && current >= 0) || (before >= 0 && current < 0)) crossings += 1;
  }
  return crossings / (stdout.length / 2 / 48000 * 2);
}

async function readArtifact(h, exportId, kind) {
  assert.equal(typeof exportsService.prepareExecutionUnitExportArtifact, 'function',
    'unit artifacts need an explicit protected-read interface, not a path-only descriptor');
  const before = changes(h);
  const artifact = await exportsService.prepareExecutionUnitExportArtifact(h.ctx, { exportId, kind });
  try {
    assert.equal(Object.hasOwn(artifact, 'absolute_path'), false);
    assert.equal(Object.hasOwn(artifact, 'download_url'), false);
    assert.equal(typeof artifact.createReadStream, 'function');
    assert.equal(typeof artifact.cleanup, 'function');
    const chunks = [];
    for await (const chunk of artifact.createReadStream()) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length, artifact.size);
    assert.equal(hash(bytes), artifact.sha256);
    assert.equal(changes(h), before);
    return { bytes, sha256: artifact.sha256, size: artifact.size };
  } finally {
    await artifact.cleanup();
    await artifact.cleanup();
    assert.throws(() => artifact.createReadStream());
  }
}

test('five-key unit composition plan is server-derived, read-only and shared with creation', async t => {
  const h = await approvedCompositionRun(t);
  const input = planRequest(h);
  const before = changes(h), assets = assetCount(h), rows = protectedBusinessSnapshot(h);
  const directories = exportDirectories(h), candidates = candidateSnapshot(h);
  const ctx = { ...h.ctx, assemblyRunner: () => assert.fail('planning must not assemble'),
    compositionRunner: () => assert.fail('planning must not encode') };
  const plan = await composition.buildCompositionPlan(ctx, input);
  assert.equal(plan.schema_version, SCHEMA);
  assert.deepEqual(plan.request, releaseRequest(input));
  assert.equal(plan.version_id, h.versionId);
  assert.equal(plan.run_id, h.run.id);
  assert.equal(plan.audio_mode, 'native');
  assert.equal(plan.audio_mode, plan.episode_release.audio_mode);
  assert.equal(plan.total_duration_ms, 12000);
  assert.equal(plan.total_duration_ms, plan.episode_release.duration_ms);
  assert.equal(plan.release_hash, plan.episode_release.release_hash);
  assert.match(plan.input_hash, /^[a-f0-9]{64}$/);
  assertReleaseHash(plan.episode_release, plan.release_hash);
  assert.equal(plan.episode_release.units.length, 2);
  assert.equal(plan.episode_release.quality_summary.final_media_review, 'pending');
  assert.equal(plan.episode_release.subtitles.cues[0].text, 'Maya, bring the blue folder. Do not leave anything behind.');
  assert.deepEqual(await composition.buildCompositionPlan(ctx, input), plan);
  const noRead = { ...ctx, db: { prepare() { assert.fail('invalid plan input must fail before DB reads'); } } };
  for (const invalid of [
    { ...input, schema_version: undefined }, { ...input, schema_version: 'redraw-execution-unit-release-v1' },
    { ...input, version_id: String(input.version_id) }, { ...input, run_id: 0 },
    { ...input, expected_plan_hash: 'invalid' }, { ...input, expected_run_revision: String(input.expected_run_revision) },
    { ...input, idempotency_key: 'create-only' }, { ...input, units: [] }, { ...input, audio_mode: 'replace' },
    { ...input, subtitles: 'client text' }, { ...input, episode_release: plan.episode_release }, { ...input, video_inputs: [] },
  ]) await assert.rejects(composition.buildCompositionPlan(noRead, invalid), errorCode('REDRAW_COMPOSITION_INPUT_INVALID'));
  await assert.rejects(composition.buildCompositionPlan({ ...ctx, userId: 'not-the-owner' }, input),
    errorCode('REDRAW_COMPOSITION_VERSION_NOT_FOUND'));
  assert.equal(changes(h), before);
  assert.equal(assetCount(h), assets);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM redraw_exports').get().n, 0);
  assert.deepEqual(exportDirectories(h), directories);
  assert.deepEqual(candidateSnapshot(h), candidates);
  assert.deepEqual(protectedBusinessSnapshot(h), rows);
  assert.deepEqual(h.syntheticCalls, { post: 2, download: 2 });
  const created = await composition.createComposition(ctx, compositionRequest(h));
  const stored = JSON.parse(created.manifest_json);
  assert.equal(created.release_hash, plan.release_hash);
  assert.deepEqual(stored.request, plan.request);
  assert.deepEqual(stored.episode_release, plan.episode_release);
});

test('unit composition persists one retained native MP4, complete subtitles and an immutable safe report', async t => {
  const h = await approvedCompositionRun(t);
  const protectedBefore = protectedBusinessSnapshot(h);
  const candidatesBefore = candidateSnapshot(h);
  const input = compositionRequest(h);
  const initialAssetCount = assetCount(h);
  const created = await composition.createComposition(h.ctx, input);
  assert.equal(created.created, true);
  assert.equal(created.status, 'pending');
  assert.equal(assetCount(h), initialAssetCount);
  const pending = JSON.parse(created.manifest_json);
  assert.equal(pending.schema_version, SCHEMA);
  assert.deepEqual(pending.request, releaseRequest(input));
  assertReleaseHash(pending.episode_release, created.release_hash);
  assert.equal(pending.episode_release.units.length, 2);

  await t.test('same key replays one row and a different key cannot create an active export', async () => {
    const count = h.db.prepare('SELECT count(*) AS n FROM redraw_exports').get().n;
    const before = changes(h);
    const replay = await composition.createComposition(h.ctx, input);
    assert.equal(replay.id, created.id); assert.equal(replay.created, false);
    assert.equal(changes(h), before);
    await assert.rejects(composition.createComposition(h.ctx, {
      ...input, expected_run_revision: input.expected_run_revision + 1,
    }), errorCode('REDRAW_COMPOSITION_IDEMPOTENCY_CONFLICT'));
    await assert.rejects(composition.createComposition(h.ctx, compositionRequest(h, 'other-active-key')),
      errorCode('REDRAW_COMPOSITION_ACTIVE_CONFLICT'));
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM redraw_exports').get().n, count);
  });

  await t.test('strict unit request and owner checks cannot downgrade into the historical shot branch', async () => {
    const invalid = [
      { ...input, schema_version: undefined }, { ...input, schema_version: 'redraw-episode-release-v1' },
      { ...input, version_id: String(input.version_id) }, { ...input, run_id: 0 },
      { ...input, expected_run_revision: String(input.expected_run_revision) },
      { ...input, expected_plan_hash: 'invalid' }, { ...input, idempotency_key: '' },
      { ...input, audio_mode: 'replace' }, { ...input, video_inputs: [] }, { ...input, subtitles: 'client text' },
      { ...input, episode_release: pending.episode_release },
    ];
    const noRead = { ...h.ctx, db: { prepare() { assert.fail('invalid input must fail before DB reads'); } } };
    for (const value of invalid) await assert.rejects(composition.createComposition(noRead, value),
      errorCode('REDRAW_COMPOSITION_INPUT_INVALID'));
    const before = changes(h);
    await assert.rejects(composition.createComposition({ ...h.ctx, userId: 'not-the-owner' }, input),
      errorCode('REDRAW_COMPOSITION_VERSION_NOT_FOUND'));
    await assert.rejects(composition.runComposition({ ...h.ctx, tenantId: 'different-tenant' }, created.id),
      errorCode('REDRAW_COMPOSITION_EXPORT_NOT_FOUND'));
    assert.equal(changes(h), before);
  });

  const assetsBefore = assetCount(h);
  let actualEncodes = 0;
  const completed = await composition.runComposition({ ...h.ctx, assemblyRunner: async options => {
    actualEncodes += 1;
    return defaultCompositionRunner(options);
  } }, created.id);
  assert.equal(completed.status, 'completed');
  assert.equal(actualEncodes, 1);
  assert.equal(assetCount(h), assetsBefore + 4);
  const published = publishedArtifacts(h, completed);
  assert.deepEqual(published.manifest.episode_release.units.map(unit => [unit.timeline.retained_duration_ms,
    unit.timeline.generated_duration_ms, unit.timeline.padding_ms]), [[8000, 10000, 2000], [4000, 5000, 1000]]);
  const probe = await probeFile(published.files.mp4.absolute);
  assertReportedMedia(published, probe);
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  assert.ok(video);
  assert.equal(video.width, 854); assert.equal(video.height, 480);
  assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
  assert.ok(Math.abs(Number(probe.format.duration) - 12) < 0.25);
  const red = await sampleColor(published.files.mp4.absolute, 1);
  const blue = await sampleColor(published.files.mp4.absolute, 9);
  assert.ok(red[0] > 150 && red[2] < 50, JSON.stringify(red));
  assert.ok(blue[2] > 150 && blue[0] < 50, JSON.stringify(blue));
  assert.ok(Math.abs(await sampleFrequency(published.files.mp4.absolute, 1) - 440) < 15);
  assert.ok(Math.abs(await sampleFrequency(published.files.mp4.absolute, 9) - 880) < 15);
  const cue = published.manifest.episode_release.subtitles.cues[0];
  assert.deepEqual([cue.start_ms, cue.end_ms], [8000, 11000]);
  assert.equal(cue.text, 'Maya, bring the blue folder. Do not leave anything behind.');
  assert.deepEqual(protectedBusinessSnapshot(h), protectedBefore);
  assert.deepEqual(candidateSnapshot(h), candidatesBefore);
  assert.deepEqual(h.syntheticCalls, { post: 2, download: 2 });

  await t.test('completed replay never re-encodes or writes, and the old handler cannot advertise unsafe unit downloads', async () => {
    const before = changes(h);
    const replay = await composition.runComposition({ ...h.ctx,
      assemblyRunner: () => assert.fail('completed export must not encode again') }, completed.id);
    assert.deepEqual(replay, exportRow(h, completed.id));
    for (const kind of KINDS) {
      await assert.rejects(exportsService.resolveDownloadArtifact(h.ctx, { exportId: completed.id, kind }),
        errorCode('REDRAW_EXPORT_UNIT_DOWNLOAD_NOT_CONNECTED'));
      await assert.rejects(exportsService.getDownloadDescriptor(h.ctx, { exportId: completed.id, kind }),
        errorCode('REDRAW_EXPORT_UNIT_DOWNLOAD_NOT_CONNECTED'));
    }
    assert.equal(changes(h), before);
  });

  await t.test('all four artifacts read the verified bytes and reject foreign owner, stale release and changed files', async () => {
    for (const kind of KINDS) {
      const actual = await readArtifact(h, completed.id, kind);
      assert.deepEqual(actual.bytes, published.files[kind].bytes);
    }
    await assert.rejects(exportsService.prepareExecutionUnitExportArtifact({ ...h.ctx, userId: 'different-owner' },
      { exportId: completed.id, kind: 'mp4' }), errorCode('REDRAW_EXPORT_NOT_FOUND'));
    const revision = runRow(h).revision;
    h.db.prepare('UPDATE redraw_execution_runs SET revision=revision+1 WHERE id=?').run(h.run.id);
    try {
      await assert.rejects(exportsService.prepareExecutionUnitExportArtifact(h.ctx, { exportId: completed.id, kind: 'mp4' }),
        errorCode('REDRAW_EXPORT_RELEASE_HASH_MISMATCH'));
    } finally { h.db.prepare('UPDATE redraw_execution_runs SET revision=? WHERE id=?').run(revision, h.run.id); }
    for (const kind of KINDS) {
      const file = published.files[kind];
      const changed = Buffer.from(file.bytes); changed[changed.length - 1] ^= 1;
      fs.writeFileSync(file.absolute, changed);
      try {
        await assert.rejects(exportsService.prepareExecutionUnitExportArtifact(h.ctx, { exportId: completed.id, kind }),
          errorCode('REDRAW_EXPORT_CHECKSUM_MISMATCH'));
      } finally { fs.writeFileSync(file.absolute, file.bytes); }
    }
    const held = await exportsService.prepareExecutionUnitExportArtifact(h.ctx, { exportId: completed.id, kind: 'mp4' });
    try {
      const changed = Buffer.from(published.files.mp4.bytes); changed[changed.length - 1] ^= 1;
      fs.writeFileSync(published.files.mp4.absolute, changed);
      await assert.rejects(async () => { for await (const _chunk of held.createReadStream()) {} });
    } finally {
      await held.cleanup();
      fs.writeFileSync(published.files.mp4.absolute, published.files.mp4.bytes);
    }
    for (const mutation of [
      { apply: () => h.db.prepare('UPDATE redraw_execution_runs SET revision=revision+1 WHERE id=?').run(h.run.id),
        restore: () => h.db.prepare('UPDATE redraw_execution_runs SET revision=? WHERE id=?').run(revision, h.run.id) },
      { apply: () => h.db.prepare("UPDATE redraw_execution_unit_attempts SET approved_by='different-owner' WHERE id=?")
        .run(h.candidates[0].attempt.id),
      restore: () => h.db.prepare('UPDATE redraw_execution_unit_attempts SET approved_by=? WHERE id=?')
        .run(h.candidates[0].attempt.approved_by, h.candidates[0].attempt.id) },
    ]) {
      const beforeDrift = await exportsService.prepareExecutionUnitExportArtifact(h.ctx, { exportId: completed.id, kind: 'mp4' });
      let emittedBytes = 0;
      try {
        mutation.apply();
        await assert.rejects(async () => {
          for await (const chunk of beforeDrift.createReadStream()) emittedBytes += chunk.length;
        }, errorCode('REDRAW_EXPORT_RELEASE_HASH_MISMATCH'));
        assert.equal(emittedBytes, 0, 'release drift must reject before the first download byte');
      } finally { mutation.restore(); await beforeDrift.cleanup(); }
      const restored = await readArtifact(h, completed.id, 'mp4');
      assert.deepEqual(restored.bytes, published.files.mp4.bytes);
    }
  });

  await t.test('input drift after create becomes failed instead of leaving a blocking pending export', async () => {
    const next = await composition.createComposition(h.ctx, compositionRequest(h, 'pre-run-drift'));
    const count = assetCount(h), revision = runRow(h).revision;
    const directories = exportDirectories(h);
    h.db.prepare('UPDATE redraw_execution_runs SET revision=revision+1 WHERE id=?').run(h.run.id);
    try {
      await assert.rejects(composition.runComposition(h.ctx, next.id), errorCode('REDRAW_COMPOSITION_INPUT_DRIFT'));
      assert.equal(exportRow(h, next.id).status, 'failed');
      assert.equal(assetCount(h), count);
      assert.deepEqual(exportDirectories(h), directories);
    } finally { h.db.prepare('UPDATE redraw_execution_runs SET revision=? WHERE id=?').run(revision, h.run.id); }
    assert.equal(h.db.prepare("SELECT count(*) AS n FROM redraw_exports WHERE status IN ('pending','processing')").get().n, 0);
  });

  await t.test('source bytes, source asset path and metadata drift after actual encoding publish zero assets', async () => {
    for (const kind of ['source-bytes', 'source-path', 'source-metadata']) {
      const next = await composition.createComposition(h.ctx, compositionRequest(h, `after-encode-${kind}`));
      const count = assetCount(h);
      const directories = exportDirectories(h);
      const originalSource = fs.readFileSync(h.sourceFile);
      const alternate = path.join(h.root, `source-copy-${next.id}.mp4`);
      let injected = 0;
      try {
        await assert.rejects(composition.runComposition({ ...h.ctx, assemblyRunner: async options => {
          await defaultCompositionRunner(options);
          injected += 1;
          if (kind === 'source-bytes') {
            const changed = Buffer.from(originalSource); changed[changed.length - 1] ^= 1;
            fs.writeFileSync(h.sourceFile, changed);
            assert.equal(fs.statSync(h.sourceFile).size, originalSource.length);
          } else if (kind === 'source-path') {
            fs.writeFileSync(alternate, originalSource, { flag: 'wx' });
            h.db.prepare('UPDATE assets SET local_path=? WHERE id=?')
              .run(path.relative(h.root, alternate).replace(/\\/g, '/'), h.sourceAsset.id);
          } else {
            h.db.prepare('UPDATE assets SET metadata=? WHERE id=?').run(JSON.stringify({
              ...JSON.parse(h.sourceAsset.metadata), owner_snapshot_nonce: 'changed-after-encoding',
            }), h.sourceAsset.id);
          }
        } }, next.id), error => /^(?:REDRAW_COMPOSITION_INPUT_DRIFT|REDRAW_SOURCE_VIDEO_(?:CONFLICT|UNAVAILABLE))$/.test(error?.code || ''));
        assert.equal(injected, 1);
        assert.equal(exportRow(h, next.id).status, 'failed');
        assert.equal(assetCount(h), count);
        assert.deepEqual(exportDirectories(h), directories);
      } finally {
        fs.writeFileSync(h.sourceFile, originalSource);
        h.db.prepare('UPDATE assets SET local_path=?,metadata=? WHERE id=?')
          .run(h.sourceAsset.local_path, h.sourceAsset.metadata, h.sourceAsset.id);
      }
      assert.deepEqual(candidateSnapshot(h), candidatesBefore);
      for (const file of Object.values(published.files)) assert.equal(hash(fs.readFileSync(file.absolute)), file.sha256);
    }
  });

  await t.test('an actual SQLite completion failure rolls back all four assets without deleting a prior export', async () => {
    const next = await composition.createComposition(h.ctx, compositionRequest(h, 'sqlite-completion-failure'));
    const count = assetCount(h);
    const directories = exportDirectories(h);
    h.db.exec(`CREATE TEMP TRIGGER g5_unit_composition_reject_completion
      BEFORE UPDATE OF status ON redraw_exports WHEN NEW.id=${Number(next.id)} AND NEW.status='completed'
      BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_UNIT_COMPLETION_FAILURE'); END`);
    try {
      await assert.rejects(composition.runComposition(h.ctx, next.id),
        error => /SYNTHETIC_UNIT_COMPLETION_FAILURE/.test(error?.message || ''));
      assert.equal(exportRow(h, next.id).status, 'failed');
      assert.equal(assetCount(h), count);
      assert.deepEqual(exportDirectories(h), directories);
    } finally { h.db.exec('DROP TRIGGER g5_unit_composition_reject_completion'); }
    assert.equal(exportRow(h, completed.id).status, 'completed');
    for (const file of Object.values(published.files)) assert.equal(hash(fs.readFileSync(file.absolute)), file.sha256);
    assert.deepEqual(candidateSnapshot(h), candidatesBefore);
  });

  await t.test('restart recovery preserves needs_attention and an explicit new export only reuses approved units', async () => {
    const stopped = await composition.createComposition(h.ctx, compositionRequest(h, 'interrupted-export'));
    h.db.prepare("UPDATE redraw_exports SET status='processing' WHERE id=?").run(stopped.id);
    assert.equal(composition.recoverInterruptedCompositions(h.db), 1);
    assert.equal(exportRow(h, stopped.id).status, 'needs_attention');
    const before = changes(h);
    await assert.rejects(composition.runComposition(h.ctx, stopped.id),
      errorCode('REDRAW_COMPOSITION_EXPORT_STATE_INVALID'));
    assert.equal(changes(h), before);
    const retry = await composition.createComposition(h.ctx, compositionRequest(h, 'explicit-local-rebuild'));
    assert.notEqual(retry.id, stopped.id);
    const rebuilt = await composition.runComposition(h.ctx, retry.id);
    assert.equal(rebuilt.status, 'completed');
    assert.ok(rebuilt.version_number > stopped.version_number);
    publishedArtifacts(h, rebuilt);
    assert.deepEqual(protectedBusinessSnapshot(h), protectedBefore);
    assert.deepEqual(candidateSnapshot(h), candidatesBefore);
    assert.deepEqual(h.syntheticCalls, { post: 2, download: 2 });
  });
});

test('completion final checks after source cleanup reject real drift and a zero-row CAS atomically', async t => {
  const h = await approvedCompositionRun(t);
  const historical = await composition.createComposition(h.ctx, compositionRequest(h, 'final-check-history'));
  const completed = await composition.runComposition(h.ctx, historical.id);
  const published = publishedArtifacts(h, completed);
  const protectedBefore = protectedBusinessSnapshot(h), candidatesBefore = candidateSnapshot(h);
  const originalSource = fs.readFileSync(h.sourceFile);
  const names = { mp4: 'composition.mp4', srt: 'composition.srt', vtt: 'composition.vtt', report: 'composition-report.json' };
  const assertHistoryPreserved = () => {
    assert.deepEqual(exportRow(h, completed.id), completed);
    for (const file of Object.values(published.files)) {
      assert.deepEqual(h.db.prepare('SELECT * FROM assets WHERE id=?').get(file.asset.id), file.asset);
      assert.deepEqual(fs.readFileSync(file.absolute), file.bytes);
    }
    assert.deepEqual(protectedBusinessSnapshot(h), protectedBefore);
    assert.deepEqual(candidateSnapshot(h), candidatesBefore);
    assert.deepEqual(fs.readFileSync(h.sourceFile), originalSource);
    assert.deepEqual(h.syntheticCalls, { post: 2, download: 2 });
  };
  const mutations = [
    ['approval', 'EXECUTION_UNIT_REVIEW_CONFLICT'],
    ['source', 'REDRAW_COMPOSITION_INPUT_DRIFT'],
    ['candidate', 'REDRAW_UNIT_RESULT_INVALID'],
    ...KINDS.map(kind => [kind, 'REDRAW_COMPOSITION_OUTPUT_INVALID']),
  ];
  for (const [kind, code] of mutations) {
    await t.test(`last-await completion transaction rejects ${kind} drift`, async () => {
      const next = await composition.createComposition(h.ctx, compositionRequest(h, `final-check-${kind}`));
      const assetsBefore = h.db.prepare('SELECT * FROM assets ORDER BY id').all();
      const directories = exportDirectories(h);
      let injected = 0, mutatedFile, originalBytes;
      try {
        await assert.rejects(composition.runComposition({ ...h.ctx, clock: () => {
          const timestamp = h.ctx.clock ? h.ctx.clock() : new Date().toISOString();
          if (injected || !h.db.inTransaction || exportRow(h, next.id).status !== 'processing') return timestamp;
          const own = exportDirectories(h).filter(name => name.startsWith(`export-${next.id}-`));
          if (own.length !== 1) return timestamp;
          const directory = path.join(h.root, 'redraw', `version-${h.versionId}`, 'exports', own[0]);
          if (!Object.values(names).every(name => fs.existsSync(path.join(directory, name)))) return timestamp;
          // This existing clock is inside the publication transaction, after the
          // actual last await (source cleanup) and before the final input check.
          assert.deepEqual(fs.readdirSync(directory).sort(), Object.values(names).sort());
          injected += 1;
          if (kind === 'approval') {
            const updated = h.db.prepare("UPDATE redraw_execution_unit_attempts SET approved_by='different-owner' WHERE id=?")
              .run(h.candidates[0].attempt.id);
            assert.equal(updated.changes, 1);
          } else {
            mutatedFile = kind === 'source' ? h.sourceFile : kind === 'candidate' ? h.candidates[0].file
              : path.join(directory, names[kind]);
            originalBytes = fs.readFileSync(mutatedFile);
            assert.ok(originalBytes.length > 0);
            const changed = Buffer.from(originalBytes); changed[changed.length - 1] ^= 1;
            fs.writeFileSync(mutatedFile, changed);
            assert.equal(fs.statSync(mutatedFile).size, originalBytes.length);
            assert.notEqual(hash(fs.readFileSync(mutatedFile)), hash(originalBytes));
          }
          return timestamp;
        } }, next.id), errorCode(code));
        assert.equal(injected, 1, 'the mutation must occur once at the real final transaction clock');
        assert.equal(exportRow(h, next.id).status, 'failed');
        assert.equal(exportRow(h, next.id).error_code, code);
        assert.deepEqual(h.db.prepare('SELECT * FROM assets ORDER BY id').all(), assetsBefore);
        assert.deepEqual(exportDirectories(h), directories, 'only this failed export workspace must be removed');
        assert.deepEqual(protectedBusinessSnapshot(h), protectedBefore, 'transactional approval drift must roll back without fixture repair');
      } finally {
        if (originalBytes && ['source', 'candidate'].includes(kind)) fs.writeFileSync(mutatedFile, originalBytes);
      }
      assertHistoryPreserved();
    });
  }
  await t.test('completion UPDATE RAISE(IGNORE) has a real zero changes count and rolls back four assets', async () => {
    const next = await composition.createComposition(h.ctx, compositionRequest(h, 'final-check-cas-zero'));
    const assetsBefore = h.db.prepare('SELECT * FROM assets ORDER BY id').all();
    const directories = exportDirectories(h);
    h.db.exec(`CREATE TEMP TRIGGER g5_unit_composition_ignore_completion
      BEFORE UPDATE OF status ON redraw_exports WHEN NEW.id=${Number(next.id)} AND NEW.status='completed'
      BEGIN SELECT RAISE(IGNORE); END`);
    try {
      await assert.rejects(composition.runComposition(h.ctx, next.id), errorCode('REDRAW_COMPOSITION_EXPORT_STATE_INVALID'));
      assert.equal(exportRow(h, next.id).status, 'failed');
      assert.equal(exportRow(h, next.id).error_code, 'REDRAW_COMPOSITION_EXPORT_STATE_INVALID');
      assert.deepEqual(h.db.prepare('SELECT * FROM assets ORDER BY id').all(), assetsBefore);
      assert.deepEqual(exportDirectories(h), directories);
    } finally { h.db.exec('DROP TRIGGER g5_unit_composition_ignore_completion'); }
    assertHistoryPreserved();
  });
});

test('the Assembly synchronous binding assertion throws inside a real transaction and rolls every write back', async t => {
  const h = await approvedCompositionRun(t);
  const input = compositionRequest(h);
  const assembly = await assemblyService.assembleApprovedExecutionUnits(h.ctx, {
    version_id: input.version_id, run_id: input.run_id, expected_plan_hash: input.expected_plan_hash,
    expected_run_revision: input.expected_run_revision,
  });
  const before = protectedBusinessSnapshot(h);
  const candidates = candidateSnapshot(h);
  try {
    assert.equal(typeof assembly.assertCurrentBindingSync, 'function');
    assert.equal(assembly.assertCurrentBindingSync(), undefined);
    const oldAsync = assembly.assertCurrentBinding();
    assert.equal(typeof oldAsync?.then, 'function');
    await oldAsync;
    const mutations = [
      ['run revision', () => h.db.prepare('UPDATE redraw_execution_runs SET revision=revision+1 WHERE id=?').run(h.run.id),
        'REDRAW_UNIT_ASSEMBLY_CONFLICT'],
      ['version owner', () => h.db.prepare("UPDATE redraw_versions SET user_id='different-owner' WHERE id=?").run(h.versionId),
        'REDRAW_VERSION_NOT_FOUND'],
      ['version locale', () => h.db.prepare("UPDATE redraw_versions SET locale='ar-SA' WHERE id=?").run(h.versionId),
        'EXECUTION_UNIT_REVIEW_CONFLICT'],
      ['version market', () => h.db.prepare("UPDATE redraw_versions SET market='SA' WHERE id=?").run(h.versionId),
        'EXECUTION_UNIT_REVIEW_CONFLICT'],
      ['approved reviewer', () => h.db.prepare("UPDATE redraw_execution_unit_attempts SET approved_by='different-owner' WHERE id=?")
        .run(h.candidates[0].attempt.id), 'EXECUTION_UNIT_REVIEW_CONFLICT'],
      ['confirmed reservation', () => h.db.prepare("UPDATE tenant_usage_reservations SET status='held' WHERE id=?")
        .run(h.candidates[0].attempt.reservation_id), 'EXECUTION_UNIT_REVIEW_CONFLICT'],
    ];
    for (const [label, mutate, code] of mutations) {
      assert.throws(() => h.db.transaction(() => {
        mutate();
        assembly.assertCurrentBindingSync();
        assert.fail(`${label}: drift must throw before the transaction can commit`);
      }).immediate(), errorCode(code), label);
      assert.deepEqual(protectedBusinessSnapshot(h), before, `${label}: rollback must restore business rows`);
      assert.deepEqual(candidateSnapshot(h), candidates);
    }
    const rollback = new Error('synthetic fixture rollback after observing the legacy promise');
    let legacyRejection;
    assert.throws(() => h.db.transaction(() => {
      mutations[0][1]();
      legacyRejection = assembly.assertCurrentBinding();
      assert.equal(typeof legacyRejection?.then, 'function', 'the old API must still reject asynchronously');
      throw rollback;
    }).immediate(), error => error === rollback);
    await assert.rejects(legacyRejection, errorCode('REDRAW_UNIT_ASSEMBLY_CONFLICT'));
    assert.deepEqual(protectedBusinessSnapshot(h), before);
    assert.equal(assembly.assertCurrentBindingSync(), undefined);
  } finally { assembly.cleanup(); }
});

test('not_required with no dialogues persists an empty SRT, valid VTT and video-only MP4', async t => {
  const h = await approvedCompositionRun(t, 'not_required');
  assert.deepEqual(h.blueprint.shots.flatMap(shot => shot.dialogue), []);
  assert.deepEqual(h.localization.dialogue_map, []);
  assert.deepEqual(h.queueState.saved_review.plan.units.flatMap(unit => unit.dialogues), []);
  const before = protectedBusinessSnapshot(h);
  const created = await composition.createComposition(h.ctx, compositionRequest(h));
  const release = JSON.parse(created.manifest_json).episode_release;
  assert.deepEqual(release.subtitles.cues, []);
  assert.equal(release.subtitles.srt, '');
  assert.equal(release.subtitles.vtt, 'WEBVTT\n\n');
  const completed = await composition.runComposition(h.ctx, created.id);
  const result = publishedArtifacts(h, completed);
  const probe = await probeFile(result.files.mp4.absolute);
  assertReportedMedia(result, probe);
  assert.ok(probe.streams.some(stream => stream.codec_type === 'video'));
  assert.equal(probe.streams.some(stream => stream.codec_type === 'audio'), false);
  assert.ok(Math.abs(Number(probe.format.duration) - 12) < 0.25);
  assert.equal(result.report.audio.mode, 'not_required');
  assert.equal(result.report.final_media_review, 'pending');
  assert.equal(result.files.srt.bytes.length, 0);
  assert.equal(result.files.srt.sha256, hash(Buffer.alloc(0)));
  assert.equal(result.files.vtt.bytes.toString('utf8'), 'WEBVTT\n\n');
  const downloadedSrt = await readArtifact(h, completed.id, 'srt');
  assert.equal(downloadedSrt.size, 0);
  assert.equal(downloadedSrt.bytes.length, 0);
  assert.equal(downloadedSrt.sha256, hash(Buffer.alloc(0)));
  for (const kind of ['mp4', 'report']) {
    assert.ok(result.files[kind].bytes.length > 0);
    fs.writeFileSync(result.files[kind].absolute, Buffer.alloc(0));
    try {
      await assert.rejects(exportsService.prepareExecutionUnitExportArtifact(h.ctx, { exportId: completed.id, kind }),
        errorCode('REDRAW_EXPORT_CHECKSUM_MISMATCH'));
    } finally { fs.writeFileSync(result.files[kind].absolute, result.files[kind].bytes); }
  }
  assert.deepEqual(protectedBusinessSnapshot(h), before);
  assert.deepEqual(h.syntheticCalls, { post: 2, download: 2 });
});

test('replace cannot create a composition until real approved dubbing is connected', async t => {
  const h = await approvedCompositionRun(t, 'replace');
  const before = changes(h), count = assetCount(h), rows = protectedBusinessSnapshot(h);
  await assert.rejects(composition.createComposition(h.ctx, compositionRequest(h)),
    errorCode('REDRAW_COMPOSITION_APPROVED_DUB_REQUIRED'));
  assert.equal(changes(h), before);
  assert.equal(assetCount(h), count);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM redraw_exports').get().n, 0);
  assert.equal(h.db.prepare("SELECT count(*) AS n FROM assets WHERE category='redraw_dialogue'").get().n, 0);
  assert.deepEqual(protectedBusinessSnapshot(h), rows);
  assert.deepEqual(h.syntheticCalls, { post: 2, download: 2 });
});
