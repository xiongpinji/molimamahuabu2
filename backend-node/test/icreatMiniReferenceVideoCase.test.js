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
  });
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes('must-not-appear'), false);
  assert.equal(serialized.includes('provider-task-secret'), false);
  assert.equal(manifest.provider_task_id_sha256.length, 64);
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
