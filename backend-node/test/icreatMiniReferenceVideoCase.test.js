const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EXPECTED_CAST_SHA256,
  EXPECTED_SOURCE_SHA256,
  MATEO_CROP,
  applyManualReview,
  assertCaseInputContract,
  buildIcreatMiniCaseSnapshot,
  buildRedactedEvidence,
  consumeSubmissionLock,
  createSubmissionLock,
  prepareCaseMedia,
  verifyCandidateMedia,
} = require('../src/services/icreatMiniReferenceVideoCaseService');
const {
  PAID_CONFIRMATION,
  assertPaidAuthorization,
  parseArgs,
  runCase,
} = require('../scripts/run-icreat-mini-reference-video-case');

const SOURCE_PROBE = {
  durationSeconds: 68.733333,
  width: 720,
  height: 1280,
  fps: 30,
  videoCodec: 'hevc',
  audioCodec: 'aac',
  pixelFormat: 'yuv420p',
};

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('case snapshot pins the approved Mini model, live-action replacement prompt and 4-second request', () => {
  const snapshot = buildIcreatMiniCaseSnapshot({
    sourceSha256: EXPECTED_SOURCE_SHA256,
    castSha256: EXPECTED_CAST_SHA256,
    sourceProbe: SOURCE_PROBE,
    segmentUrl: 'https://case.localhost.run/a',
    mateoUrl: 'https://case.localhost.run/b',
    castUrl: 'https://case.localhost.run/c',
  });

  assert.equal(snapshot.model, 'bytedance/seedance-2-0-mini');
  assert.equal(snapshot.duration, 4);
  assert.equal(snapshot.resolution, '480p');
  assert.equal(snapshot.aspect_ratio, '9:16');
  assert.equal(snapshot.generate_audio, true);
  assert.match(snapshot.prompt, /Dude, who are you\?/);
  assert.match(snapshot.prompt, /every visible person/i);
  assert.match(snapshot.prompt, /live-action Latino students/i);
  assert.deepEqual(snapshot.reference_video_urls, ['https://case.localhost.run/a']);
  assert.deepEqual(snapshot.reference_urls, [
    'https://case.localhost.run/b',
    'https://case.localhost.run/c',
  ]);
  assert.equal(snapshot.request_sha256.length, 64);
  assert.equal(Object.isFrozen(snapshot), true);
});

test('case input contract rejects source fingerprint, media parameters and cast drift', () => {
  const valid = {
    sourceSha256: EXPECTED_SOURCE_SHA256,
    castSha256: EXPECTED_CAST_SHA256,
    sourceProbe: SOURCE_PROBE,
  };
  const invalid = [
    { sourceSha256: '0'.repeat(64) },
    { castSha256: '1'.repeat(64) },
    { sourceProbe: { ...SOURCE_PROBE, durationSeconds: 60 } },
    { sourceProbe: { ...SOURCE_PROBE, width: 1280, height: 720 } },
    { sourceProbe: { ...SOURCE_PROBE, videoCodec: 'h264' } },
    { sourceProbe: { ...SOURCE_PROBE, audioCodec: 'mp3' } },
    { sourceProbe: { ...SOURCE_PROBE, fps: 24 } },
  ];
  for (const patch of invalid) {
    assert.throws(
      () => assertCaseInputContract({ ...valid, ...patch }),
      (error) => error.code === 'ICREAT_CASE_INPUT_MISMATCH',
    );
  }
});

test('prepareCaseMedia creates only private-root copies with the fixed strip and crop contracts', async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icreat-case-fixture-'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icreat-case-output-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const sourcePath = path.join(fixtureRoot, 'source.mp4');
  const castPath = path.join(fixtureRoot, 'cast.png');
  fs.writeFileSync(sourcePath, 'source');
  fs.writeFileSync(castPath, 'cast');
  let transcodeInput;
  let cropInput;
  const result = await prepareCaseMedia({
    sourcePath,
    castPath,
    tempRoot,
    hashFile: async (filePath) => {
      if (filePath === sourcePath) return EXPECTED_SOURCE_SHA256;
      if (filePath === castPath || path.basename(filePath) === 'cast-reference.png') return EXPECTED_CAST_SHA256;
      return hashFile(filePath);
    },
    probeMedia: async (filePath) => path.basename(filePath) === 'source-shot.mp4'
      ? {
        durationSeconds: 4,
        width: 720,
        height: 1280,
        fps: 30,
        videoCodec: 'h264',
        audioCodec: null,
        pixelFormat: 'yuv420p',
      }
      : SOURCE_PROBE,
    transcodeSegment: async (input) => {
      transcodeInput = input;
      fs.writeFileSync(input.targetPath, 'segment');
    },
    cropImage: async (input) => {
      cropInput = input;
      fs.writeFileSync(input.targetPath, 'mateo');
      return { width: input.crop.width, height: input.crop.height };
    },
  });
  t.after(() => result.cleanup());

  assert.deepEqual(transcodeInput, {
    sourcePath,
    targetPath: result.segment.path,
    startMs: 0,
    endMs: 4000,
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
    audioMode: 'strip',
    fastStart: true,
  });
  assert.deepEqual(cropInput.crop, MATEO_CROP);
  for (const item of [result.segment, result.mateo, result.cast]) {
    assert.equal(path.relative(result.rootDir, item.path).startsWith('..'), false);
    assert.equal(item.sha256.length, 64);
  }
  assert.equal(result.segment.probe.audioCodec, null);
});

test('submission lock is consumed before POST and an unknown result can never be retried', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'icreat-case-lock-'));
  const statePath = path.join(directory, 'private-state.json');
  const requestHash = 'a'.repeat(64);
  try {
    const lock = createSubmissionLock(statePath, requestHash);
    assert.equal(lock.consumed, false);
    const consumed = consumeSubmissionLock(statePath, requestHash, {
      attempted_at: '2026-08-11T08:00:00.000Z',
    });
    assert.equal(consumed.consumed, true);
    assert.equal(consumed.status, 'submission_unknown');
    assert.throws(
      () => consumeSubmissionLock(statePath, requestHash, { attempted_at: '2026-08-11T08:00:01.000Z' }),
      (error) => error.code === 'ICREAT_CASE_ALREADY_SUBMITTED',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('redacted evidence never contains credentials, task IDs or signed media URLs', () => {
  const manifest = buildRedactedEvidence({
    api_key: 'must-not-appear',
    task_id: 'provider-task-secret',
    signed_urls: ['https://case.localhost.run/a?token=must-not-appear'],
    status: 'submission_unknown',
    media: { segment: { sha256: 'a'.repeat(64), audio_codec: null, audio_mode: 'strip' } },
  });
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes('must-not-appear'), false);
  assert.equal(serialized.includes('provider-task-secret'), false);
  assert.equal(manifest.provider_task_id_sha256.length, 64);
  assert.equal(manifest.media.segment.audio_codec, null);
  assert.equal(manifest.media.segment.audio_mode, 'strip');
  assert.equal(manifest.visual_actor_replacement_verified, false);
  assert.equal(Object.values(manifest.manual_review).every((value) => value === 'uncertain'), true);
});

test('candidate media requires a readable non-silent 480p portrait MP4 with video and audio', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'icreat-case-candidate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, 'candidate.mp4');
  fs.writeFileSync(outputPath, 'candidate');
  const verified = await verifyCandidateMedia({
    outputPath,
    probeMedia: async () => ({
      durationSeconds: 4.02,
      audioDurationSeconds: 4.01,
      width: 480,
      height: 854,
      videoCodec: 'h264',
      audioCodec: 'aac',
    }),
    analyzeAudio: async () => ({ nonSilent: true, maxVolumeDb: -8 }),
  });
  assert.equal(verified.sha256.length, 64);
  assert.equal(verified.non_silent, true);

  await assert.rejects(
    () => verifyCandidateMedia({
      outputPath,
      probeMedia: async () => ({
        durationSeconds: 4,
        width: 480,
        height: 854,
        videoCodec: 'h264',
        audioCodec: null,
      }),
      analyzeAudio: async () => ({ nonSilent: false }),
    }),
    (error) => error.code === 'ICREAT_CASE_CANDIDATE_INVALID',
  );
});

test('visual verification becomes true only after all seven manual checks pass', () => {
  const manifest = buildRedactedEvidence({ status: 'succeeded' });
  const partial = applyManualReview(manifest, { live_action_humans: 'passed' });
  assert.equal(partial.visual_actor_replacement_verified, false);
  const allPassed = applyManualReview(manifest, Object.fromEntries(
    Object.keys(manifest.manual_review).map((key) => [key, 'passed']),
  ));
  assert.equal(allPassed.visual_actor_replacement_verified, true);
});

test('CLI defaults to dry-run and paid mode requires the exact phrase and bounded caps', () => {
  const dryRun = parseArgs([]);
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.submitPaidOnce, false);

  const paid = parseArgs([
    '--submit-paid-once',
    '--max-credits', '50',
    '--max-usd', '0.25',
    '--confirm', PAID_CONFIRMATION,
  ]);
  assert.equal(paid.mode, 'paid-once');
  assert.equal(paid.maxCredits, 50);
  assert.equal(paid.maxUsd, 0.25);

  const verified = {
    priceConfirmed: true,
    keyGroupAuthorized: true,
    balanceSufficient: true,
    expectedCredits: 40,
    expectedUsd: 0.2,
  };
  assert.doesNotThrow(() => assertPaidAuthorization(paid, verified));
  for (const patch of [
    { ...paid, confirmation: 'wrong' },
    { ...paid, maxCredits: 51 },
    { ...paid, maxUsd: 0.26 },
  ]) {
    assert.throws(
      () => assertPaidAuthorization(patch, verified),
      (error) => error.code === 'ICREAT_PAID_AUTHORIZATION_REQUIRED',
    );
  }
  for (const patch of [
    { priceConfirmed: false },
    { keyGroupAuthorized: false },
    { balanceSufficient: false },
    { expectedCredits: 0 },
    { expectedCredits: 51 },
    { expectedUsd: 0.26 },
  ]) {
    assert.throws(
      () => assertPaidAuthorization(paid, { ...verified, ...patch }),
      (error) => error.code === 'ICREAT_PAID_PREFLIGHT_FAILED',
    );
  }
});

test('paid orchestration fails closed before callVideoApi when access, HEAD or lock gates fail', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'icreat-case-paid-gates-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const media = {
    rootDir: directory,
    source: { path: 'source', sha256: EXPECTED_SOURCE_SHA256, probe: SOURCE_PROBE },
    segment: { path: 'segment', sha256: '2'.repeat(64) },
    mateo: { path: 'mateo', sha256: '3'.repeat(64) },
    cast: { path: 'cast', sha256: EXPECTED_CAST_SHA256 },
    cleanup: async () => {},
  };
  const args = {
    ...parseArgs([
      '--submit-paid-once', '--max-credits', '50', '--max-usd', '0.25',
      '--confirm', PAID_CONFIRMATION,
    ]),
    outputDir: directory,
    statePath: path.join(directory, 'submission-state.json'),
  };
  const validPreflight = {
    priceConfirmed: true,
    keyGroupAuthorized: true,
    balanceSufficient: true,
    expectedCredits: 40,
    expectedUsd: 0.2,
  };
  let providerCalls = 0;
  const baseDeps = {
    prepareCaseMedia: async () => media,
    loadLocalIcreatConfig: async () => ({ db: { close() {} }, config: { id: 7 } }),
    callVideoApi: async () => { providerCalls += 1; return { task_id: 'must-not-run' }; },
    writeEvidence: async () => {},
  };

  await assert.rejects(
    () => runCase(args, {
      ...baseDeps,
      runReadOnlyPreflight: async () => ({ ...validPreflight, keyGroupAuthorized: false }),
    }),
    (error) => error.code === 'ICREAT_PAID_PREFLIGHT_FAILED',
  );
  assert.equal(providerCalls, 0);

  await assert.rejects(
    () => runCase(args, {
      ...baseDeps,
      runReadOnlyPreflight: async () => validPreflight,
      startTemporaryMediaTunnel: async () => {
        const error = new Error('HEAD failed');
        error.code = 'TEMP_MEDIA_TUNNEL_UNAVAILABLE';
        throw error;
      },
    }),
    (error) => error.code === 'TEMP_MEDIA_TUNNEL_UNAVAILABLE',
  );
  assert.equal(providerCalls, 0);

  createSubmissionLock(args.statePath, '4'.repeat(64));
  consumeSubmissionLock(args.statePath, '4'.repeat(64));
  await assert.rejects(
    () => runCase(args, {
      ...baseDeps,
      runReadOnlyPreflight: async () => validPreflight,
      startTemporaryMediaTunnel: async () => ({
        urls: [
          { id: 'shot', url: 'https://case.localhost.run/a', head_ok: true },
          { id: 'mateo', url: 'https://case.localhost.run/b', head_ok: true },
          { id: 'cast', url: 'https://case.localhost.run/c', head_ok: true },
        ],
        close: async () => {},
      }),
      requestHashForTest: '4'.repeat(64),
    }),
    (error) => ['ICREAT_CASE_LOCK_EXISTS', 'ICREAT_CASE_ALREADY_SUBMITTED'].includes(error.code),
  );
  assert.equal(providerCalls, 0);
});
