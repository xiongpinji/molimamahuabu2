'use strict';

// Real isolated SQLite, dispatch, candidate bytes, human review, FFmpeg and ffprobe.
// Only the bottom-level provider POST/download are synthetic. This does not claim
// post-assembly language, character, dialogue placement or ambient-audio acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setup, makeCandidateMedia, attemptRow, runRow, hash } = require('./helpers/redrawExecutionUnitDispatchFixture');
const runs = require('../src/services/redrawExecutionRunService');
const reviews = require('../src/services/redrawExecutionUnitReviewService');
const { inspectUnitReferenceMaterials } = require('../src/services/redrawUnitReferenceService');
const { prepareUnitReferenceMaterials } = require('../src/services/redrawUnitReferenceDerivationService');
const { compileUnitProductionPack } = require('../src/services/redrawUnitProductionPackService');
const { defaultCompositionRunner } = require('../src/services/redrawMediaRuntimeInternal');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');

const runMedia = promisify(execFile);
const assemblyPath = path.join(__dirname, '../src/services/redrawUnitAssemblyService.js');
const response = value => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

function reviewInput(candidate) {
  return {
    expected_revision: candidate.run_revision,
    expected_candidate_hash: candidate.candidate_hash,
    decision: 'approved',
    checks: Object.fromEntries(candidate.required_checks.map(key => [key, {
      basis: 'human_watch_listen',
      result: 'passed',
    }])),
  };
}

async function dispatchAndApprove(h, profile, variant = 'valid') {
  const mediaRoot = fs.mkdtempSync(path.join(h.root, 'assembly-candidate-media-'));
  const bytes = await makeCandidateMedia({ ...h, root: mediaRoot }, variant, profile);
  let posts = 0;
  let downloads = 0;
  const candidate = await runs.dispatchClaimedExecutionUnitTask(h.ctx, h.versionId, h.run.id, h.input, {
    fetchImpl: async (_url, init) => {
      posts += 1;
      assert.equal(h.db.inTransaction, false);
      assert.equal(init.method, 'POST');
      return response({ id: `synthetic-unit-assembly-${h.attemptId}`, status: 'succeeded',
        content: { video_url: `https://result.synthetic.invalid/assembly-${h.attemptId}.mp4` } });
    },
    download: {
      _dnsLookupForTest: async (hostname, options) => {
        assert.equal(hostname, 'result.synthetic.invalid');
        assert.equal(options.all, true);
        return [{ address: '8.8.8.8', family: 4 }];
      },
      fetchImpl: async (_url, init) => {
        downloads += 1;
        assert.equal(h.db.inTransaction, false);
        assert.equal(init.method, 'GET');
        assert.equal(init.headers, undefined);
        return new Response(bytes, { status: 200, headers: { 'Content-Type': 'video/mp4' } });
      },
    },
  });
  assert.equal(posts, 1);
  assert.equal(downloads, 1);
  assert.equal(candidate.status, 'waiting_review');
  assert.equal(attemptRow(h).output_sha256, hash(bytes));
  const publicCandidate = await reviews.getExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.unitId);
  const approved = await reviews.reviewExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.unitId,
    reviewInput(publicCandidate));
  assert.equal(approved.status, 'approved');
  assert.equal(attemptRow(h).status, 'approved');
  return approved;
}

async function bindNextUnit(h, index) {
  const expected = h.expected(index);
  const material = await inspectUnitReferenceMaterials(h.ctx, expected);
  await prepareUnitReferenceMaterials(h.ctx, { ...expected, expected_materials_hash: material.materials_hash });
  const ready = await runs.inspectExecutionRunReadiness(h.ctx, h.versionId, h.run.id, {});
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  assert.equal(ready.unit.id, expected.unit_id);
  const claim = await runs.claimNextUnit(h.ctx, h.versionId, h.run.id, {
    expected_revision: ready.revision,
    expected_plan_hash: ready.plan_hash,
    expected_quote_hash: ready.quote_hash,
  });
  h.attemptId = claim.attempt_id;
  h.unitId = expected.unit_id;
  const binding = { attempt_id: h.attemptId, expected_revision: runRow(h).revision,
    expected_plan_hash: ready.plan_hash, expected_quote_hash: ready.quote_hash };
  h.binding = await runs.bindClaimedExecutionUnitTask(h.ctx, h.versionId, h.run.id, binding);
  h.input = { ...binding, expected_revision: runRow(h).revision };
  h.pack = compileUnitProductionPack({
    owner: { tenantId: h.ctx.tenantId, userId: h.ctx.userId, workId: 1, versionId: h.versionId },
    expected,
    queueState: h.queueState,
    blueprint: h.blueprint,
    localization: h.localization,
  });
}

async function streamBytes(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function sampleRgb(file, second) {
  const { stdout } = await runMedia(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-ss', String(second),
    '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
  { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' });
  const sums = [0, 0, 0];
  for (let index = 0; index < stdout.length; index += 3) {
    sums[0] += stdout[index]; sums[1] += stdout[index + 1]; sums[2] += stdout[index + 2];
  }
  return sums.map(value => value / (stdout.length / 3));
}

async function sampleFrequency(file, second) {
  const seconds = 0.5;
  const { stdout } = await runMedia(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-ss', String(second),
    '-i', file, '-t', String(seconds), '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'],
  { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer' });
  let crossings = 0;
  let previous = stdout.readInt16LE(0);
  for (let offset = 2; offset + 1 < stdout.length; offset += 2) {
    const current = stdout.readInt16LE(offset);
    if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) crossings += 1;
    previous = current;
  }
  return crossings / (seconds * 2);
}

async function sampleStereo(file, second) {
  const { stdout } = await runMedia(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-ss', String(second),
    '-i', file, '-t', '0.25', '-vn', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1'],
  { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer' });
  let leftSquare = 0;
  let rightSquare = 0;
  let cross = 0;
  let samples = 0;
  for (let offset = 0; offset + 3 < stdout.length; offset += 4) {
    const left = stdout.readInt16LE(offset);
    const right = stdout.readInt16LE(offset + 2);
    leftSquare += left * left;
    rightSquare += right * right;
    cross += left * right;
    samples += 1;
  }
  return { leftRms: Math.sqrt(leftSquare / samples), rightRms: Math.sqrt(rightSquare / samples),
    correlation: cross / Math.sqrt(leftSquare * rightSquare) };
}

test('approved native units remove every local padding interval before source-order audiovisual assembly', async t => {
  const h = await setup(t, 'free', true, 'bound', { assemblyCase: true });
  const service = require(assemblyPath);
  const units = h.queueState.saved_review.plan.units;
  assert.deepEqual(units.map(unit => [unit.source_start_ms, unit.source_end_ms, unit.retained_duration_ms,
    unit.generated_duration_ms, unit.padding_ms]), [[0, 8000, 8000, 10000, 2000], [8000, 12000, 4000, 5000, 1000]]);
  assert.deepEqual(units.flatMap(unit => unit.dialogues.map(dialogue => dialogue.id)), ['assembly-dialogue-cross-max']);

  h.unitId = h.expected(0).unit_id;
  await dispatchAndApprove(h, { color: 'red', frequency: 440 });
  await bindNextUnit(h, 1);
  await assert.rejects(service.assembleApprovedExecutionUnits(h.ctx, {
    version_id: h.versionId,
    run_id: h.run.id,
    expected_plan_hash: h.run.plan_hash,
    expected_run_revision: runRow(h).revision,
  }), error => error.code === 'REDRAW_UNIT_ASSEMBLY_CONFLICT');
  await dispatchAndApprove(h, { color: 'blue', frequency: 880 });
  assert.equal(runRow(h).status, 'completed');
  const approvedAttempts = h.db.prepare('SELECT * FROM redraw_execution_unit_attempts WHERE run_id=? ORDER BY id').all(h.run.id);
  assert.equal(approvedAttempts.length, 2);
  assert.deepEqual(approvedAttempts.map(attempt => attempt.status), ['approved', 'approved']);
  const assemblyInput = { version_id: h.versionId, run_id: h.run.id, expected_plan_hash: h.run.plan_hash,
    expected_run_revision: runRow(h).revision };
  await assert.rejects(service.assembleApprovedExecutionUnits(h.ctx, { ...assemblyInput, extra: true }),
    error => error.code === 'REDRAW_UNIT_ASSEMBLY_INPUT_INVALID');
  await assert.rejects(service.assembleApprovedExecutionUnits({ ...h.ctx, userId: 'different-owner' }, assemblyInput),
    error => error.code === 'REDRAW_VERSION_NOT_FOUND');

  const approvedSnapshot = await reviews.prepareApprovedExecutionUnitMedia(h.ctx, h.versionId, h.run.id,
    h.expected(0).unit_id, approvedAttempts[0].candidate_hash);
  try {
    assert.equal(Object.isFrozen(approvedSnapshot), true);
    assert.equal(Object.isFrozen(approvedSnapshot.bindings), true);
    assert.equal(Object.isFrozen(approvedSnapshot.candidate), true);
    assert.equal(Object.isFrozen(approvedSnapshot.timeline), true);
    assert.equal(Object.hasOwn(approvedSnapshot.candidate, 'relative_path'), false);
    assert.throws(() => { approvedSnapshot.timeline.padding_ms = 0; }, TypeError);
  } finally {
    approvedSnapshot.cleanup();
  }

  assert.equal(fs.existsSync(assemblyPath), true,
    'approved multi-unit fixture chain completed; the missing product assembly service is the expected RED');
  assert.equal(typeof service.assembleApprovedExecutionUnits, 'function', 'owned unit assembly entry must exist');
  const assembliesRoot = path.join(h.root, 'redraw/unit-assemblies');
  const workspacesBefore = fs.existsSync(assembliesRoot) ? fs.readdirSync(assembliesRoot).sort() : [];
  const before = h.db.serialize();
  const changes = h.db.prepare('SELECT total_changes() n').get().n;
  const assembled = await service.assembleApprovedExecutionUnits(h.ctx, assemblyInput);
  try {
    assert.deepEqual(h.db.serialize(), before);
    assert.equal(h.db.prepare('SELECT total_changes() n').get().n, changes, 'assembly must perform 0 DML');
    assert.equal(assembled.manifest.schema_version, 'redraw-execution-unit-assembly-v1');
    assert.deepEqual(assembled.manifest.units.map(unit => [unit.source_start_ms, unit.source_end_ms,
      unit.retained_duration_ms, unit.generated_duration_ms, unit.padding_ms]),
    [[0, 8000, 8000, 10000, 2000], [8000, 12000, 4000, 5000, 1000]]);
    assert.deepEqual(assembled.manifest.units.map(unit => [unit.candidate_sha256, unit.review_hash]),
      approvedAttempts.map(attempt => [attempt.output_sha256, JSON.parse(attempt.quality_json).review.review_hash]));
    assert.deepEqual(assembled.manifest.units.flatMap(unit => unit.dialogues.map(dialogue => dialogue.id)),
      ['assembly-dialogue-cross-max'], 'the source-mapped dialogue must occur exactly once');
    assert.equal(assembled.manifest.audio.mode, 'native');
    assert.equal(assembled.manifest.audio.disposition, 'approved_unit_tracks_preserved');
    assert.deepEqual(assembled.manifest.audio.units.map(unit => unit.input_has_audio), [true, true]);
    assert.equal(assembled.manifest.review_status, 'requires_post_assembly_human_review');
    assert.ok(Math.abs(assembled.manifest.output.duration_ms - 12000) < 250,
      'actual assembled duration must remain within the existing media tolerance');
    assert.equal(assembled.manifest.output.has_audio, true);
    assert.match(assembled.manifest.output.sha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof assembled.assertCurrentBinding, 'function');
    assert.equal(typeof assembled.cleanup, 'function');
    await assembled.assertCurrentBinding();

    const output = await streamBytes(assembled.files.video.createReadStream());
    assert.equal(hash(output), assembled.files.video.sha256);
    assert.equal(assembled.files.video.sha256, assembled.manifest.output.sha256);
    const manifestBytes = await streamBytes(assembled.files.manifest.createReadStream());
    assert.equal(hash(manifestBytes), assembled.files.manifest.sha256);
    assert.deepEqual(JSON.parse(manifestBytes), assembled.manifest);
    const outputPath = path.join(h.root, 'verified-unit-assembly.mp4');
    fs.writeFileSync(outputPath, output, { flag: 'wx' });
    const { stdout } = await runMedia(getFfprobePath(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath],
      { windowsHide: true, timeout: 120000 });
    const probe = JSON.parse(stdout);
    assert.ok(probe.streams.some(stream => stream.codec_type === 'video'));
    assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
    const actualDurationMs = Math.round(Number(probe.format.duration) * 1000);
    assert.ok(Math.abs(actualDurationMs - 12000) < 250);
    assert.equal(assembled.manifest.output.duration_ms, actualDurationMs,
      'manifest duration must be the actual post-write ffprobe measurement');
    const early = await sampleRgb(outputPath, 1);
    const afterFirstRetainedRange = await sampleRgb(outputPath, 9);
    assert.ok(early[0] > early[2] * 3, `expected first approved red unit at 1s: ${early}`);
    assert.ok(afterFirstRetainedRange[2] > afterFirstRetainedRange[0] * 3,
      `expected second approved blue unit at 9s, not first-unit padding: ${afterFirstRetainedRange}`);
    assert.ok(Math.abs(await sampleFrequency(outputPath, 1) - 440) < 30, 'first native audio interval must survive');
    assert.ok(Math.abs(await sampleFrequency(outputPath, 9) - 880) < 40, 'second native audio interval must start at source 8s');
  } finally {
    assembled.cleanup();
    assert.throws(() => assembled.files.video.assertCurrentBinding(), error => error.code === 'REDRAW_UNIT_ASSEMBLY_OUTPUT_INVALID');
    assert.throws(() => assembled.files.manifest.assertCurrentBinding(), error => error.code === 'REDRAW_UNIT_ASSEMBLY_OUTPUT_INVALID');
    assert.deepEqual(fs.readdirSync(assembliesRoot).sort(), workspacesBefore,
      'cleanup must remove only its owned assembly workspace');
    const originalCandidate = await reviews.getExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.expected(0).unit_id);
    assert.equal(originalCandidate.status, 'approved', 'cleanup must not remove or rewrite approved candidate evidence');
  }
});

test('native assembly preserves audible anti-phase stereo channels instead of cancelling them during normalization', async t => {
  const h = await setup(t, 'free', true, 'bound', { assemblyCase: true });
  h.unitId = h.expected(0).unit_id;
  await dispatchAndApprove(h, { color: 'red', frequency: 440, antiPhaseStereo: true });
  await bindNextUnit(h, 1);
  await dispatchAndApprove(h, { color: 'blue', frequency: 880, antiPhaseStereo: true });
  const service = require(assemblyPath);
  const assembled = await service.assembleApprovedExecutionUnits(h.ctx, {
    version_id: h.versionId,
    run_id: h.run.id,
    expected_plan_hash: h.run.plan_hash,
    expected_run_revision: runRow(h).revision,
  });
  try {
    const output = await streamBytes(assembled.files.video.createReadStream());
    const outputPath = path.join(h.root, 'verified-anti-phase-stereo-assembly.mp4');
    fs.writeFileSync(outputPath, output, { flag: 'wx' });
    for (const second of [1, 9]) {
      const stereo = await sampleStereo(outputPath, second);
      assert.ok(stereo.leftRms > 4000 && stereo.rightRms > 4000,
        `both approved native channels must remain audible at ${second}s: ${JSON.stringify(stereo)}`);
      assert.ok(stereo.correlation < -0.8,
        `approved anti-phase channel relationship must survive at ${second}s: ${JSON.stringify(stereo)}`);
    }
  } finally {
    assembled.cleanup();
  }
});

for (const commonStartMs of [0, 1000]) {
  test(`native assembly preserves each audio delay relative to video with common start ${commonStartMs}ms`, async t => {
    const h = await setup(t, 'free', true, 'bound', { assemblyCase: true });
    const profile = { audioDelayMs: 500, ...(commonStartMs ? { commonStartMs } : {}) };
    h.unitId = h.expected(0).unit_id;
    await dispatchAndApprove(h, { color: 'red', frequency: 440, ...profile });
    await bindNextUnit(h, 1);
    await dispatchAndApprove(h, { color: 'blue', frequency: 880, ...profile });
    const before = h.db.serialize();
    const changes = h.db.prepare('SELECT total_changes() n').get().n;
    const assembled = await require(assemblyPath).assembleApprovedExecutionUnits(h.ctx, {
      version_id: h.versionId, run_id: h.run.id, expected_plan_hash: h.run.plan_hash,
      expected_run_revision: runRow(h).revision,
    });
    try {
      assert.deepEqual(h.db.serialize(), before);
      assert.equal(h.db.prepare('SELECT total_changes() n').get().n, changes);
      const output = await streamBytes(assembled.files.video.createReadStream());
      assert.equal(hash(output), assembled.manifest.output.sha256);
      const file = path.join(h.root, 'verified-delayed-native-assembly.mp4');
      fs.writeFileSync(file, output, { flag: 'wx' });
      const { stdout } = await runMedia(getFfprobePath(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
        { windowsHide: true, timeout: 120000 });
      const probe = JSON.parse(stdout);
      assert.equal(Number(probe.streams.find(stream => stream.codec_type === 'video').start_time), 0);
      assert.ok(Math.abs(Number(probe.format.duration) * 1000 - 12000) < 250);
      for (const unitStart of [0, 8]) {
        const silent = await sampleStereo(file, unitStart + 0.2);
        const audible = await sampleStereo(file, unitStart + 0.8);
        assert.ok(silent.leftRms < 50 && silent.rightRms < 50,
          `unit ${unitStart}s must preserve its leading audio gap: ${JSON.stringify(silent)}`);
        assert.ok(audible.leftRms > 500 && audible.rightRms > 500,
          `unit ${unitStart}s must retain its delayed native sound: ${JSON.stringify(audible)}`);
      }
      assert.ok(Math.abs(assembled.manifest.output.duration_ms - 12000) < 250);
      await assembled.assertCurrentBinding();
    } finally { assembled.cleanup(); }
  });
}

test('assembly manifest records actual non-square input and output SAR/DAR', async t => {
  const h = await setup(t, 'free', true, 'bound', { assemblyCase: true });
  h.unitId = h.expected(0).unit_id;
  await dispatchAndApprove(h, { color: 'red', frequency: 440 }, 'valid-sar');
  await bindNextUnit(h, 1);
  await dispatchAndApprove(h, { color: 'blue', frequency: 880 }, 'valid-sar');
  const assembled = await require(assemblyPath).assembleApprovedExecutionUnits(h.ctx, {
    version_id: h.versionId, run_id: h.run.id, expected_plan_hash: h.run.plan_hash,
    expected_run_revision: runRow(h).revision,
  });
  try {
    const output = await streamBytes(assembled.files.video.createReadStream());
    const file = path.join(h.root, 'verified-non-square-assembly.mp4');
    fs.writeFileSync(file, output, { flag: 'wx' });
    const { stdout } = await runMedia(getFfprobePath(), ['-v', 'error', '-show_streams', '-of', 'json', file],
      { windowsHide: true, timeout: 120000 });
    const video = JSON.parse(stdout).streams.find(stream => stream.codec_type === 'video');
    assert.equal(video.width, 854); assert.equal(video.height, 480);
    assert.equal(video.sample_aspect_ratio, '1280:1281');
    assert.equal(video.display_aspect_ratio, '16:9');
    assert.equal(assembled.manifest.output.sample_aspect_ratio, video.sample_aspect_ratio);
    assert.equal(assembled.manifest.output.display_aspect_ratio, video.display_aspect_ratio);
    assert.deepEqual(assembled.manifest.units.map(unit => [unit.input_sample_aspect_ratio, unit.input_display_aspect_ratio]),
      [['1280:1281', '16:9'], ['1280:1281', '16:9']]);
    const manifestBytes = await streamBytes(assembled.files.manifest.createReadStream());
    assert.equal(hash(manifestBytes), assembled.files.manifest.sha256);
    assert.deepEqual(JSON.parse(manifestBytes), assembled.manifest);
  } finally { assembled.cleanup(); }
});

for (const { mode, variants, disposition } of [
  { mode: 'replace', variants: ['valid', 'valid'], disposition: 'approved_dub_required' },
  { mode: 'not_required', variants: ['silent', 'silent'], disposition: 'video_only_no_unit_tracks' },
  { mode: 'not_required', variants: ['valid', 'silent'], disposition: 'available_unit_tracks_preserved_with_missing_intervals_silenced' },
]) {
  test(`actual ${mode} assembly handles ${variants.join('/')} candidate tracks without implying final audio approval`, async t => {
    const h = await setup(t, 'free', true, 'bound', { assemblyCase: true, audioMode: mode });
    const units = h.queueState.saved_review.plan.units;
    assert.equal(units.length, 2);
    assert.equal(units.flatMap(unit => unit.dialogues).length === 0, mode === 'not_required');
    h.unitId = h.expected(0).unit_id;
    await dispatchAndApprove(h, { color: 'red', frequency: 440 }, variants[0]);
    await bindNextUnit(h, 1);
    await dispatchAndApprove(h, { color: 'blue', frequency: 880 }, variants[1]);
    assert.equal(runRow(h).status, 'completed');
    const before = h.db.serialize();
    const changes = h.db.prepare('SELECT total_changes() n').get().n;
    const assembled = await require(assemblyPath).assembleApprovedExecutionUnits(h.ctx, {
      version_id: h.versionId, run_id: h.run.id, expected_plan_hash: h.run.plan_hash,
      expected_run_revision: runRow(h).revision,
    });
    try {
      assert.deepEqual(h.db.serialize(), before);
      assert.equal(h.db.prepare('SELECT total_changes() n').get().n, changes);
      const inputAudio = variants.map(variant => variant !== 'silent');
      const outputAudio = mode !== 'replace' && inputAudio.some(Boolean);
      assert.equal(assembled.manifest.audio.mode, mode);
      assert.equal(assembled.manifest.audio.disposition, disposition);
      assert.equal(assembled.manifest.audio.approved_dub_required, mode === 'replace');
      assert.equal(assembled.manifest.audio.no_dialogue_required, mode === 'not_required');
      assert.equal(assembled.manifest.audio.post_assembly_ambient_and_extra_dialogue_review_required, true);
      assert.equal(assembled.manifest.review_status, 'requires_post_assembly_human_review');
      assert.deepEqual(assembled.manifest.audio.units.map(unit => unit.input_has_audio), inputAudio);
      assert.deepEqual(assembled.manifest.audio.units.map(unit => unit.silence_placeholder),
        inputAudio.map(hasAudio => mode === 'not_required' && outputAudio && !hasAudio));
      const output = await streamBytes(assembled.files.video.createReadStream());
      assert.equal(hash(output), assembled.manifest.output.sha256);
      const file = path.join(h.root, 'verified-audio-mode-assembly.mp4');
      fs.writeFileSync(file, output, { flag: 'wx' });
      const { stdout } = await runMedia(getFfprobePath(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
        { windowsHide: true, timeout: 120000 });
      const probe = JSON.parse(stdout);
      assert.ok(probe.streams.some(stream => stream.codec_type === 'video'));
      assert.equal(probe.streams.some(stream => stream.codec_type === 'audio'), outputAudio);
      assert.equal(assembled.manifest.output.has_audio, outputAudio);
      assert.ok(Math.abs(Number(probe.format.duration) * 1000 - 12000) < 250);
      if (outputAudio) for (const [index, unit] of units.entries()) {
        const second = unit.source_start_ms / 1000 + 0.5;
        const sample = await sampleStereo(file, second);
        assert.ok(inputAudio[index]
          ? sample.leftRms > 500 && sample.rightRms > 500
          : sample.leftRms < 50 && sample.rightRms < 50,
        `only the unit without an original track may be silenced: ${JSON.stringify(sample)}`);
        if (inputAudio[index]) assert.ok(Math.abs(await sampleFrequency(file, second) - 440) < 30);
      }
      const manifestBytes = await streamBytes(assembled.files.manifest.createReadStream());
      assert.equal(hash(manifestBytes), assembled.files.manifest.sha256);
      assert.deepEqual(JSON.parse(manifestBytes), assembled.manifest);
      await assembled.assertCurrentBinding();
    } finally { assembled.cleanup(); }
  });
}

test('assembly rejects output-byte and approved-binding drift across asynchronous finalization', async t => {
  const h = await setup(t, 'free', true, 'bound', { assemblyCase: true });
  h.unitId = h.expected(0).unit_id;
  await dispatchAndApprove(h, { color: 'red', frequency: 440 });
  await bindNextUnit(h, 1);
  await dispatchAndApprove(h, { color: 'blue', frequency: 880 });
  const service = require(assemblyPath);
  const input = { version_id: h.versionId, run_id: h.run.id, expected_plan_hash: h.run.plan_hash,
    expected_run_revision: runRow(h).revision };

  let outputPath;
  let unitOneHashReads = 0;
  let outputMutated = false;
  let unexpected;
  let failure;
  const createReadStream = fs.createReadStream;
  const assemblyRoot = path.join(h.ctx.storageRoot, 'redraw', 'unit-assemblies') + path.sep;
  fs.createReadStream = function guardedCreateReadStream(file, ...args) {
    if (String(file).startsWith(assemblyRoot) && path.basename(String(file)) === 'unit-1.mp4'
      && ++unitOneHashReads === 3) {
      const bytes = fs.readFileSync(outputPath);
      bytes[Math.floor(bytes.length / 2)] ^= 1;
      fs.writeFileSync(outputPath, bytes);
      outputMutated = true;
    }
    return createReadStream.call(this, file, ...args);
  };
  try {
    unexpected = await service.assembleApprovedExecutionUnits({ ...h.ctx, assemblyRunner: async job => {
      outputPath = job.outputPath;
      return defaultCompositionRunner(job);
    } }, input);
  } catch (error) {
    failure = error;
  } finally {
    fs.createReadStream = createReadStream;
    unexpected?.cleanup();
  }
  assert.equal(outputMutated, true, 'test must mutate same-length output bytes during the final input hash pass');
  assert.equal(failure?.code, 'REDRAW_UNIT_ASSEMBLY_OUTPUT_INVALID',
    'the returned output handle must bind the manifest hash to the bytes after the last asynchronous input check');

  let probeTouched = false;
  unexpected = undefined;
  failure = undefined;
  try {
    unexpected = await service.assembleApprovedExecutionUnits({ ...h.ctx, execFile: (bin, args, options, callback) => {
      return execFile(bin, args, options, (error, stdout, stderr) => {
        if (!error && bin === getFfprobePath() && String(args.at(-1)).startsWith(assemblyRoot)
          && path.basename(args.at(-1)) === 'assembly.mp4') {
          probeTouched = true;
          h.db.prepare('UPDATE redraw_execution_runs SET revision=revision+1 WHERE id=?').run(h.run.id);
        }
        callback(error, stdout, stderr);
      });
    } }, input);
  } catch (error) {
    failure = error;
  } finally {
    unexpected?.cleanup();
  }
  assert.equal(probeTouched, true,
    `test must reach the output probe before changing the approved run; caught ${failure?.code || failure?.name}: ${failure?.message}`);
  assert.equal(failure?.code, 'EXECUTION_UNIT_REVIEW_CONFLICT',
    'assembly must revalidate the approved review and run after output probing');
});
