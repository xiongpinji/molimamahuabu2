const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  EVIDENCE_VERSION,
  buildRequiredMatrix,
  buildReleaseEvidence,
  buildSpeedEvidenceSummary,
  buildVerificationRequest,
  decideResumeAction,
  hasCompleteRequiredMatrix,
  parseFfprobeJson,
  redactEvidence,
  validateCompletedResult,
} = require('../scripts/verify-feituo-video-models');

function completed(caseItem, overrides = {}) {
  const resolution = caseItem.resolution;
  const ffprobe = resolution === '2k'
    ? { width: 2048, height: 1152, duration_seconds: caseItem.duration, video_codec: 'h264' }
    : resolution === '720p'
      ? { width: 1280, height: 720, duration_seconds: caseItem.duration, video_codec: 'h264' }
      : { width: 864, height: 480, duration_seconds: caseItem.duration, video_codec: 'h264' };
  return {
    id: caseItem.id,
    model: caseItem.model,
    requested_resolution: caseItem.resolution,
    requested_duration: caseItem.duration,
    status: 'completed',
    submission_state: 'accepted',
    provider_task_id: `task-${caseItem.id}`,
    started_at: '2026-08-08T01:00:00.000Z',
    completed_at: '2026-08-08T01:02:00.000Z',
    speed: {
      submit_latency_ms: 321,
      generation_elapsed_seconds: 120,
      download_latency_ms: 456,
      total_elapsed_seconds: 120.456,
    },
    artifact: {
      public_url: `https://molimama.vip/verification-assets/feituo/${caseItem.id}.mp4`,
      output_file: `${caseItem.id}.mp4`,
      bytes: 4096,
      sha256: 'a'.repeat(64),
      ffprobe,
    },
    ...overrides,
  };
}

test('real verification matrix contains only approved upstream model ids and both Seedance tiers', () => {
  const matrix = buildRequiredMatrix();
  assert.deepEqual(matrix.map(({ id, model, resolution, duration }) => ({ id, model, resolution, duration })), [
    { id: 'h3-2k', model: 'xuan-video-v1-6e7b4763634e6206', resolution: '2k', duration: 15 },
    { id: 'seedance25-480', model: 'xuan-seedance-2.5', resolution: '480p', duration: 4 },
    { id: 'seedance25-720', model: 'xuan-seedance-2.5', resolution: '720p', duration: 4 },
  ]);
  assert.ok(!JSON.stringify(matrix).includes('"seedance-2.5"'));
});

test('verification requests are conservative text-only exact requests', () => {
  const [h3, seed480, seed720] = buildRequiredMatrix().map(buildVerificationRequest);
  assert.deepEqual(
    [h3.model, h3.resolution, h3.duration, h3.imageUrls.length, h3.videoUrls.length, h3.audioUrls.length],
    ['xuan-video-v1-6e7b4763634e6206', '2k', 15, 0, 0, 0],
  );
  assert.deepEqual([seed480.resolution, seed720.resolution], ['480p', '720p']);
  assert.equal(seed480.model, 'xuan-seedance-2.5');
  assert.equal(seed720.model, 'xuan-seedance-2.5');
});

test('resume policy never automatically retries rejected or indeterminate paid submissions', () => {
  assert.equal(decideResumeAction(null), 'submit');
  assert.equal(decideResumeAction({ submission_state: 'submitting' }), 'stop-indeterminate');
  assert.equal(decideResumeAction({ submission_state: 'indeterminate' }), 'stop-indeterminate');
  assert.equal(decideResumeAction({ status: 'rejected', submission_state: 'rejected' }), 'stop-rejected');
  assert.equal(decideResumeAction({ status: 'failed', submission_state: 'accepted' }), 'stop-rejected');
  assert.equal(decideResumeAction({ provider_task_id: 'task-1' }), 'poll');
  assert.equal(decideResumeAction({ status: 'completed', artifact: { sha256: 'a'.repeat(64) } }), 'finalize');
});

test('ffprobe parser and result validator enforce exact output bands', () => {
  const parsed = parseFfprobeJson({
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, duration: '4.04' }],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '4.04' },
  });
  assert.equal(parsed.width, 1280);
  assert.equal(parsed.height, 720);
  const item = buildRequiredMatrix()[2];
  assert.equal(validateCompletedResult(completed(item, { artifact: { ...completed(item).artifact, ffprobe: parsed } })), true);
  assert.equal(validateCompletedResult(completed(item, {
    artifact: { ...completed(item).artifact, ffprobe: { ...parsed, width: 864, height: 480 } },
  })), false);
  const h3 = buildRequiredMatrix()[0];
  assert.equal(validateCompletedResult(completed(h3, {
    artifact: {
      ...completed(h3).artifact,
      ffprobe: { width: 2560, height: 1440, duration_seconds: 15, video_codec: 'h264' },
    },
  })), true);
});

test('release evidence requires three unique completed tasks and records measured speed', () => {
  const results = buildRequiredMatrix().map(completed);
  assert.equal(hasCompleteRequiredMatrix(results), true);
  assert.equal(hasCompleteRequiredMatrix(results.slice(0, 2)), false);
  assert.equal(hasCompleteRequiredMatrix(results.map((item) => ({ ...item, provider_task_id: 'same-task' }))), false);
  const speed = buildSpeedEvidenceSummary(results);
  assert.equal(speed.cases.length, 3);
  assert.equal(speed.model_summary['xuan-seedance-2.5'].sample_count, 2);
  const evidence = buildReleaseEvidence(results, new Date('2026-08-08T01:05:00.000Z'));
  assert.equal(evidence.contract_version, EVIDENCE_VERSION);
  assert.equal(evidence.results.length, 3);
  assert.equal(evidence.verification_scope.reference_inputs, 'not_verified_text_only');
});

test('evidence redaction removes credentials', () => {
  const redacted = redactEvidence({
    authorization: 'Bearer secret',
    api_key: 'secret',
    error: 'Authorization: Bearer abcdef api_key=abcdef',
  });
  assert.equal(redacted.authorization, undefined);
  assert.equal(redacted.api_key, undefined);
  assert.ok(!JSON.stringify(redacted).includes('abcdef'));
});

test('indeterminate create is persisted and cannot cause a second paid POST', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feituo-verify-no-retry-'));
  let fetchCalls = 0;
  const context = {
    config: { base_url: 'https://feituokuajing.com', api_key: 'test-secret' },
    state: { state_version: 'feituo-video-verification-state-v1', cases: {} },
    statePath: path.join(root, 'state.json'),
    publicDir: path.join(root, 'public'),
    publicBaseUrl: 'https://molimama.vip/verification-assets/feituo',
  };
  fs.mkdirSync(context.publicDir);
  const item = buildRequiredMatrix()[0];
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error('socket reset after write');
  };
  try {
    await assert.rejects(() => require('../scripts/verify-feituo-video-models').processCase(item, context, { fetchImpl }), /不得自动重试/);
    assert.equal(fetchCalls, 1);
    assert.equal(context.state.cases[item.id].submission_state, 'indeterminate');
    await assert.rejects(() => require('../scripts/verify-feituo-video-models').processCase(item, context, { fetchImpl }), /禁止自动重试/);
    assert.equal(fetchCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('completed task reuses the existing downloaded artifact without provider fetch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feituo-verify-artifact-resume-'));
  const publicDir = path.join(root, 'public');
  fs.mkdirSync(publicDir);
  const item = buildRequiredMatrix()[0];
  const providerTaskId = 'task-existing-h3';
  const fileName = `${item.id}-${providerTaskId}.mp4`;
  const filePath = path.join(publicDir, fileName);
  fs.writeFileSync(filePath, Buffer.alloc(4096, 3));
  const completedAt = new Date('2026-08-08T01:06:00.000Z');
  fs.utimesSync(filePath, completedAt, completedAt);
  const context = {
    config: { base_url: 'https://feituokuajing.com', api_key: 'test-secret' },
    state: {
      state_version: 'feituo-video-verification-state-v1',
      cases: {
        [item.id]: {
          id: item.id,
          model: item.model,
          requested_resolution: item.resolution,
          requested_duration: item.duration,
          status: 'completed',
          submission_state: 'accepted',
          provider_task_id: providerTaskId,
          started_at: '2026-08-08T01:00:00.000Z',
          speed: { submit_latency_ms: 200 },
        },
      },
    },
    statePath: path.join(root, 'state.json'),
    publicDir,
    publicBaseUrl: 'https://molimama.vip/verification-assets/feituo',
  };
  let fetchCalls = 0;
  try {
    const result = await require('../scripts/verify-feituo-video-models').processCase(item, context, {
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('provider URL expired');
      },
      runFfprobe: () => ({ width: 2560, height: 1440, duration_seconds: 15, video_codec: 'h264' }),
      assertPublicArtifact: async () => {},
    });
    assert.equal(fetchCalls, 0);
    assert.equal(result.artifact.output_file, fileName);
    assert.equal(result.speed.artifact_reused_after_validation_failure, true);
    assert.equal(result.speed.generation_elapsed_seconds, 360);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
