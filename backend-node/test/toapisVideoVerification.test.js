const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  buildRequiredMatrix,
  buildReleaseEvidence,
  buildSpeedEvidenceSummary,
  buildVerificationRequest,
  buildVerifiedCapabilities,
  assertMoliPublicAssetBaseUrl,
  acquireVerificationLock,
  calculateBalanceDelta,
  canConfirmCostReview,
  decideResumeAction,
  hasCompletePricing,
  hasCompleteRequiredMatrix,
  assertPublicArtifact,
  parseFfprobeJson,
  redactEvidence,
  resolveVerificationPaths,
  requireDedicatedVerificationToken,
  requiredPriceFloors,
  safeChildProcessEnv,
  selectVerificationCases,
  processCase,
  verifyAllStoredResults,
} = require('../scripts/verify-toapis-video-models');

function completedEvidence() {
  return buildRequiredMatrix().map((item, index) => {
    const startedAt = new Date(Date.UTC(2026, 7, 7, 0, index * 2, 0));
    const generationElapsedSeconds = 60 + index;
    const completedAt = new Date(startedAt.getTime() + generationElapsedSeconds * 1000);
    return {
      id: item.id,
      model: item.model,
      mode: item.mode,
      requested_resolution: item.resolution,
      requested_duration: item.duration,
      status: 'completed',
      provider_task_id: `task-${item.id}`,
      speed: {
        submit_latency_ms: 120 + index,
        generation_elapsed_seconds: generationElapsedSeconds,
      },
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      request: buildVerificationRequest(item, {
        firstFrameUrl: 'https://assets.example/first.png',
        lastFrameUrl: 'https://assets.example/last.png',
        referenceImageUrl: 'https://assets.example/ref.png',
        referenceVideoUrl: 'https://assets.example/ref.mp4',
        referenceAudioUrl: 'https://assets.example/ref.mp3',
      }),
      artifact: {
        public_url: `https://molimama.vip/verification-assets/toapis/${item.id}.mp4`,
        output_file: `${item.id}.mp4`,
        bytes: 1024,
        sha256: crypto.createHash('sha256').update(item.id).digest('hex'),
        ffprobe: {
          width: item.resolution === '720p' ? 1280 : 864,
          height: item.resolution === '720p' ? 720 : 496,
          duration_seconds: item.duration,
          video_codec: 'h264',
          has_audio: item.generateAudio === true,
        },
      },
      billing: {
        before: {
          used_balance: Number((2.3 + index * 0.1).toFixed(1)),
          used_credits: 460 + index * 20,
          credits_per_usd: 200,
          captured_at: new Date(Date.UTC(2026, 7, 7, 0, index * 2)).toISOString(),
        },
        after: {
          used_balance: Number((2.4 + index * 0.1).toFixed(1)),
          used_credits: 480 + index * 20,
          credits_per_usd: 200,
          captured_at: new Date(Date.UTC(2026, 7, 7, 0, index * 2 + 1)).toISOString(),
        },
        debited_balance: 0.1,
        debited_credits: 20,
        usd_cny_rate: 7.2,
        cost_yuan: 0.72,
        reviewed: true,
        review_run_id: 'review-run-1',
        reviewed_at: '2026-08-07T01:00:00.000Z',
      },
    };
  });
}

function baselinePricing() {
  return [
    { model: 'seedance-2-fast', resolution: '480p', cost_yuan_per_second: 0.584, credits_per_second: 511, reviewed: true },
    { model: 'seedance-2-fast', resolution: '720p', cost_yuan_per_second: 0.584, credits_per_second: 511, reviewed: true },
    { model: 'seedance-2-mini', resolution: '480p', cost_yuan_per_second: 0.3358, credits_per_second: 294, reviewed: true },
    { model: 'seedance-2-mini', resolution: '720p', cost_yuan_per_second: 0.6789, credits_per_second: 595, reviewed: true },
  ];
}

describe('ToAPIs real video verification contract', () => {
  it('builds exactly the eight required release cases', () => {
    assert.deepEqual(buildRequiredMatrix().map((item) => item.id), [
      'fast-t2v-480', 'fast-t2v-720', 'mini-t2v-480', 'mini-t2v-720',
      'fast-first-last-480', 'mini-first-last-480',
      'fast-omni-480', 'mini-omni-480',
    ]);
    assert.equal(buildRequiredMatrix().every((item) => ['480p', '720p'].includes(item.resolution)), true);
  });

  it('selects only named missing cases and rejects duplicates or unknown cases', () => {
    assert.deepEqual(selectVerificationCases('mini-t2v-720;fast-omni-480').map((item) => item.id), [
      'mini-t2v-720', 'fast-omni-480',
    ]);
    assert.throws(() => selectVerificationCases('unknown-case'), /未知验证用例/);
    assert.throws(() => selectVerificationCases('mini-t2v-720,mini-t2v-720'), /不能重复/);
  });

  it('builds explicit first-last and omni roles without mixing modes', () => {
    const refs = {
      firstFrameUrl: 'https://assets.example/first.png',
      lastFrameUrl: 'https://assets.example/last.png',
      referenceImageUrl: 'https://assets.example/ref.png',
      referenceVideoUrl: 'https://assets.example/ref.mp4',
      referenceAudioUrl: 'https://assets.example/ref.mp3',
    };
    const firstLast = buildVerificationRequest(
      buildRequiredMatrix().find((item) => item.id === 'fast-first-last-480'), refs,
    );
    assert.deepEqual(firstLast.image_with_roles, [
      { url: refs.firstFrameUrl, role: 'first_frame' },
      { url: refs.lastFrameUrl, role: 'last_frame' },
    ]);
    assert.equal(firstLast.video_with_roles, undefined);
    assert.equal(firstLast.audio_with_roles, undefined);
    assert.equal(firstLast.generate_audio, false);

    const audioProof = buildVerificationRequest(
      buildRequiredMatrix().find((item) => item.id === 'fast-t2v-480'), refs,
    );
    assert.equal(audioProof.generate_audio, true);

    const omni = buildVerificationRequest(
      buildRequiredMatrix().find((item) => item.id === 'mini-omni-480'), refs,
    );
    assert.deepEqual(omni.image_with_roles, [{ url: refs.referenceImageUrl, role: 'reference_image' }]);
    assert.deepEqual(omni.video_with_roles, [{ url: refs.referenceVideoUrl, role: 'reference_video' }]);
    assert.deepEqual(omni.audio_with_roles, [{ url: refs.referenceAudioUrl, role: 'reference_audio' }]);
    assert.equal(omni.generate_audio, false);
  });

  it('never retries an uncertain submission and only polls a persisted task id', () => {
    assert.equal(decideResumeAction(null), 'submit');
    assert.equal(decideResumeAction({ submission_state: 'rejected' }), 'submit');
    assert.equal(decideResumeAction({ submission_state: 'submitting' }), 'stop-indeterminate');
    assert.equal(decideResumeAction({ submission_state: 'indeterminate' }), 'stop-indeterminate');
    assert.equal(decideResumeAction({ provider_task_id: 'tsk_1', status: 'processing' }), 'poll');
    assert.equal(decideResumeAction({
      status: 'completed',
      artifact: { sha256: 'a'.repeat(64) },
      billing: { debited_balance: 0.1, debited_credits: 20, cost_yuan: 0.72 },
    }), 'complete');
    assert.equal(decideResumeAction({
      status: 'completed',
      provider_task_id: 'tsk_1',
      artifact: { sha256: 'a'.repeat(64) },
      billing: { before: { used_balance: 1, used_credits: 200 } },
    }), 'finalize');
  });

  it('redacts credentials and request headers while retaining supplier task ids', () => {
    const redacted = redactEvidence({
      apiKey: 'secret-value',
      Authorization: 'Bearer secret-value',
      nested: { token: 'secret-value', request_headers: { authorization: 'Bearer secret-value' } },
      provider_task_id: 'tsk_safe',
      error: 'Authorization: Bearer secret-value',
    });
    const serialized = JSON.stringify(redacted);
    assert.doesNotMatch(serialized, /secret-value|Authorization|apiKey|request_headers/i);
    assert.match(serialized, /tsk_safe/);
  });

  it('parses ffprobe media evidence and rejects missing video streams', () => {
    assert.deepEqual(parseFfprobeJson(JSON.stringify({
      format: { duration: '4.041667', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 864, height: 496, duration: '4.041667' },
        { codec_type: 'audio', codec_name: 'aac', duration: '4.096' },
      ],
    })), {
      format: 'mov,mp4,m4a,3gp,3g2,mj2',
      width: 864,
      height: 496,
      duration_seconds: 4.041667,
      video_codec: 'h264',
      has_audio: true,
      audio_codec: 'aac',
    });
    assert.throws(() => parseFfprobeJson('{"streams":[]}'), /视频流/);
  });

  it('binds the public long-term asset bytes to the locally inspected SHA-256', async () => {
    const bytes = Buffer.from('public-video-bytes');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const fetchImpl = async () => ({ status: 200, arrayBuffer: async () => bytes });
    await assert.doesNotReject(() => assertPublicArtifact('https://molimama.vip/verification-assets/toapis/test.mp4', sha256, fetchImpl));
    await assert.rejects(
      () => assertPublicArtifact('https://molimama.vip/verification-assets/toapis/test.mp4', 'a'.repeat(64), fetchImpl),
      /哈希不一致/,
    );
    await assert.rejects(
      () => assertPublicArtifact('https://assets.molimama.vip/toapis/test.mp4', sha256, fetchImpl),
      /verification-assets\/toapis/,
    );
  });

  it('requires the fixed anonymous verification asset path on molimama.vip', () => {
    assert.equal(
      assertMoliPublicAssetBaseUrl('https://molimama.vip/verification-assets/toapis/'),
      'https://molimama.vip/verification-assets/toapis',
    );
    assert.throws(() => assertMoliPublicAssetBaseUrl('https://assets.molimama.vip/toapis/'), /verification-assets\/toapis/);
    assert.throws(() => assertMoliPublicAssetBaseUrl('https://molimama.vip/static/verification/toapis'), /verification-assets\/toapis/);
    assert.throws(() => assertMoliPublicAssetBaseUrl('https://example.com/toapis'), /molimama\.vip/);
  });

  it('keeps private verification state outside the public artifact directory', () => {
    const root = path.join(os.tmpdir(), 'toapis-verification-layout');
    const privateRoot = path.join(root, 'private-state');
    const publicRoot = path.join(root, 'release-evidence', 'public', 'toapis');
    const paths = resolveVerificationPaths({
      TOAPIS_VERIFY_OUTPUT_DIR: privateRoot,
      TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR: publicRoot,
      TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL: 'https://molimama.vip/verification-assets/toapis',
    });
    assert.equal(paths.outputDir, path.resolve(privateRoot));
    assert.equal(paths.publicArtifactDir, path.resolve(publicRoot));
    assert.equal(path.relative(paths.publicArtifactDir, paths.statePath).startsWith('..'), true);
    assert.equal(path.relative(paths.publicArtifactDir, paths.evidencePath).startsWith('..'), true);
    assert.throws(() => resolveVerificationPaths({
      TOAPIS_VERIFY_OUTPUT_DIR: root,
      TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR: root,
      TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL: 'https://molimama.vip/verification-assets/toapis',
    }), /不能与私有验证目录相同/);
    assert.throws(() => resolveVerificationPaths({
      TOAPIS_VERIFY_OUTPUT_DIR: root,
      TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR: path.join(root, 'public', 'toapis'),
      TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL: 'https://molimama.vip/verification-assets/toapis',
    }), /必须与私有验证目录分离/);
    assert.throws(() => resolveVerificationPaths({
      TOAPIS_VERIFY_OUTPUT_DIR: root,
      TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL: 'https://molimama.vip/verification-assets/toapis',
    }), /PUBLIC_ARTIFACT_DIR/);
  });

  it('emits the freshness window required by the shared release verifier', () => {
    const generatedAt = '2026-08-08T00:00:00.000Z';
    const evidence = buildReleaseEvidence(
      completedEvidence(),
      baselinePricing(),
      { run_id: 'review-run-1' },
      generatedAt,
    );
    assert.equal(evidence.contract_version, 'toapis-video-real-verification-v1');
    assert.equal(evidence.generated_at, generatedAt);
    assert.equal(
      Date.parse(evidence.valid_until) - Date.parse(evidence.generated_at),
      7 * 24 * 60 * 60 * 1000,
    );
  });

  it('includes measured per-case speed details and fast/mini summaries in release evidence', () => {
    const evidence = buildReleaseEvidence(
      completedEvidence(),
      baselinePricing(),
      { run_id: 'review-run-1' },
      '2026-08-08T00:00:00.000Z',
    );
    assert.equal(evidence.speed_evidence.measurement_basis, 'actual_verification_run_not_provider_sla');
    assert.equal(evidence.speed_evidence.cases.length, 8);
    assert.deepEqual(evidence.speed_evidence.cases[0], {
      id: 'fast-t2v-480',
      model: 'seedance-2-fast',
      resolution: '480p',
      mode: 't2v',
      submit_latency_ms: 120,
      generation_elapsed_seconds: 60,
      started_at: '2026-08-07T00:00:00.000Z',
      completed_at: '2026-08-07T00:01:00.000Z',
    });
    assert.deepEqual(evidence.speed_evidence.model_summary['seedance-2-fast'], {
      sample_count: 4,
      min_generation_elapsed_seconds: 60,
      max_generation_elapsed_seconds: 66,
      avg_generation_elapsed_seconds: 62.75,
    });
    assert.deepEqual(evidence.speed_evidence.model_summary['seedance-2-mini'], {
      sample_count: 4,
      min_generation_elapsed_seconds: 62,
      max_generation_elapsed_seconds: 67,
      avg_generation_elapsed_seconds: 64.25,
    });
    assert.deepEqual(buildSpeedEvidenceSummary(completedEvidence()), evidence.speed_evidence);
  });

  it('rejects completed matrix evidence when measured speed fields are missing', () => {
    const missingSpeed = completedEvidence();
    delete missingSpeed[0].speed;
    assert.equal(hasCompleteRequiredMatrix(missingSpeed), false);
  });

  it('records submit latency and generation elapsed time on the original paid submission only', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-speed-'));
    const statePath = path.join(outputDir, 'state.json');
    const item = buildRequiredMatrix()[0];
    const nowValues = [
      '2026-08-07T00:00:00.000Z',
      '2026-08-07T00:00:01.250Z',
      '2026-08-07T00:02:03.000Z',
    ];
    const context = {
      apiKey: 'test-key',
      config: { base_url: 'https://toapis.com', api_key: 'test-key' },
      outputDir,
      artifactOutputDir: outputDir,
      publicAssetBaseUrl: 'https://molimama.vip/verification-assets/toapis',
      statePath,
      state: { state_version: 'toapis-video-verification-state-v1', cases: {} },
      refs: {},
      submittedCaseIds: [],
    };
    const deps = {
      now: () => new Date(nowValues.shift() || '2026-08-08T00:00:00.000Z'),
      fetchBalance: async () => ({
        used_balance: context.state.cases[item.id]?.billing?.before ? 2.4 : 2.3,
        used_credits: context.state.cases[item.id]?.billing?.before ? 480 : 460,
        credits_per_usd: 200,
        captured_at: context.state.cases[item.id]?.billing?.before
          ? '2026-08-07T00:02:04.000Z'
          : '2026-08-07T00:00:00.000Z',
      }),
      createTask: async () => ({ task_id: 'task-speed-1' }),
      fetchTask: async () => ({ state: 'completed', progress: 100, videoUrl: 'https://assets.example/video.mp4' }),
      downloadAndInspect: async () => {
        const outputFile = 'fast-t2v-480-task-speed-1.mp4';
        const bytes = Buffer.alloc(2048, 1);
        fs.writeFileSync(path.join(outputDir, outputFile), bytes);
        return {
          public_url: 'https://molimama.vip/verification-assets/toapis/fast-t2v-480-task-speed-1.mp4',
          output_file: outputFile,
          bytes: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          ffprobe: { width: 864, height: 496, duration_seconds: 5, video_codec: 'h264', has_audio: true },
        };
      },
      sleep: async () => {},
    };
    const previousRate = process.env.TOAPIS_USD_CNY_RATE;
    const previousExpectedCost = process.env.TOAPIS_EXPECTED_COST_YUAN_JSON;
    process.env.TOAPIS_USD_CNY_RATE = '7.2';
    process.env.TOAPIS_EXPECTED_COST_YUAN_JSON = JSON.stringify({ [item.id]: 3.6 });
    try {
      const firstRun = await processCase(item, context, deps);
      assert.deepEqual(firstRun.speed, {
        submit_latency_ms: 1250,
        generation_elapsed_seconds: 123,
      });
      assert.equal(firstRun.started_at, '2026-08-07T00:00:00.000Z');
      assert.equal(firstRun.completed_at, '2026-08-07T00:02:03.000Z');

      const originalSpeed = { ...firstRun.speed };
      const secondRun = await processCase(item, context, {
        ...deps,
        now: () => new Date('2026-08-08T00:00:00.000Z'),
        runFfprobe: () => firstRun.artifact.ffprobe,
        assertPublicArtifact: async () => {},
      });
      assert.deepEqual(secondRun.speed, originalSpeed);
      assert.equal(secondRun.started_at, '2026-08-07T00:00:00.000Z');
      assert.equal(secondRun.completed_at, '2026-08-07T00:02:03.000Z');
      assert.deepEqual(context.submittedCaseIds, [item.id]);
    } finally {
      if (previousRate == null) delete process.env.TOAPIS_USD_CNY_RATE;
      else process.env.TOAPIS_USD_CNY_RATE = previousRate;
      if (previousExpectedCost == null) delete process.env.TOAPIS_EXPECTED_COST_YUAN_JSON;
      else process.env.TOAPIS_EXPECTED_COST_YUAN_JSON = previousExpectedCost;
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('calculates real supplier debit from before and after balance snapshots', () => {
    assert.deepEqual(calculateBalanceDelta(
      { used_balance: 2.3, used_credits: 460, credits_per_usd: 200 },
      { used_balance: 2.8, used_credits: 560, credits_per_usd: 200 },
    ), {
      debited_balance: 0.5,
      debited_credits: 100,
      credits_per_usd: 200,
    });
    assert.throws(() => calculateBalanceDelta(
      { used_balance: 2.3, used_credits: 460 },
      { used_balance: 2.3, used_credits: 460 },
    ), /扣费证据/);
  });

  it('requires an isolated verification token before any paid call', () => {
    assert.throws(() => requireDedicatedVerificationToken({}), /专用验证 Token/);
    assert.doesNotThrow(() => requireDedicatedVerificationToken({ TOAPIS_VERIFY_DEDICATED_TOKEN: '1' }));
  });

  it('allows cost confirmation only in a later run that starts with all cases complete and submits nothing', () => {
    const completedBeforeRun = buildRequiredMatrix().map((item) => item.id);
    assert.equal(canConfirmCostReview({
      confirmCostReview: true,
      completedBeforeRun,
      submittedCaseIds: [],
    }), true);
    assert.equal(canConfirmCostReview({
      confirmCostReview: true,
      completedBeforeRun,
      submittedCaseIds: ['fast-t2v-480'],
    }), false);
    assert.equal(canConfirmCostReview({
      confirmCostReview: true,
      completedBeforeRun: completedBeforeRun.slice(1),
      submittedCaseIds: [],
    }), false);
  });

  it('binds pricing to the higher of the public floor and observed real cost', () => {
    const results = completedEvidence();
    assert.deepEqual(requiredPriceFloors(results), {
      'seedance-2-fast|480p': 0.584,
      'seedance-2-fast|720p': 0.584,
      'seedance-2-mini|480p': 0.3358,
      'seedance-2-mini|720p': 0.6789,
    });
    assert.equal(hasCompletePricing(baselinePricing(), results), true);

    const tooCheap = baselinePricing();
    tooCheap[3] = { ...tooCheap[3], cost_yuan_per_second: 0.1, credits_per_second: 88 };
    assert.equal(hasCompletePricing(tooCheap, results), false);

    const tooExpensive = baselinePricing();
    tooExpensive[0] = { ...tooExpensive[0], cost_yuan_per_second: 1000, credits_per_second: 875000 };
    assert.equal(hasCompletePricing(tooExpensive, results), false);

    const fractionalBoundary = baselinePricing();
    fractionalBoundary[0] = {
      ...fractionalBoundary[0],
      cost_yuan_per_second: 0.5840000001,
      credits_per_second: 511,
    };
    assert.equal(hasCompletePricing(fractionalBoundary, results), false);

    const observedHigher = completedEvidence();
    const miniOmni = observedHigher.find((item) => item.id === 'mini-omni-480');
    miniOmni.billing.after = {
      ...miniOmni.billing.after,
      used_balance: Number((miniOmni.billing.before.used_balance + 0.6).toFixed(1)),
      used_credits: miniOmni.billing.before.used_credits + 120,
    };
    miniOmni.billing.debited_balance = 0.6;
    miniOmni.billing.debited_credits = 120;
    miniOmni.billing.cost_yuan = 4.32;
    const raisedPricing = baselinePricing();
    raisedPricing[2] = { ...raisedPricing[2], cost_yuan_per_second: 1.08, credits_per_second: 945 };
    assert.equal(hasCompleteRequiredMatrix(observedHigher), true);
    assert.equal(hasCompletePricing(baselinePricing(), observedHigher), false);
    assert.equal(hasCompletePricing(raisedPricing, observedHigher), true);
  });

  it('holds an exclusive process lock across the entire paid verification run', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-lock-'));
    const lockPath = path.join(directory, '.verification.lock');
    try {
      const release = acquireVerificationLock(lockPath);
      assert.throws(() => acquireVerificationLock(lockPath), /已有验证进程/);
      release();
      const releaseAgain = acquireVerificationLock(lockPath);
      releaseAgain();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('re-inspects all eight stored artifacts before recording verified, even for a subset resume', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-reinspect-'));
    const statePath = path.join(outputDir, 'state.json');
    const results = completedEvidence();
    fs.writeFileSync(path.join(outputDir, results[0].artifact.output_file), results[0].id);
    const context = {
      outputDir,
      artifactOutputDir: outputDir,
      statePath,
      state: { state_version: 'toapis-video-verification-state-v1', cases: Object.fromEntries(results.map((item) => [item.id, item])) },
      confirmCostReview: true,
    };
    try {
      await assert.rejects(() => verifyAllStoredResults(context, {
        runFfprobe(filePath) {
          const item = buildRequiredMatrix().find((entry) => filePath.includes(entry.id));
          return {
            width: item.resolution === '720p' ? 1280 : 864,
            height: item.resolution === '720p' ? 720 : 496,
            duration_seconds: item.duration,
            video_codec: 'h264',
            has_audio: item.generateAudio === true,
          };
        },
        async assertPublicArtifact() {},
      }), /ENOENT|找不到/);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('does not pass supplier credentials or authorization variables to ffprobe', () => {
    const env = safeChildProcessEnv({
      PATH: 'C:\\bin', SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp',
      TOAPIS_API_KEY: 'secret', Authorization: 'Bearer secret', OTHER_SECRET: 'hidden',
    });
    assert.equal(env.PATH, 'C:\\bin');
    assert.equal(env.SystemRoot, 'C:\\Windows');
    assert.equal(env.TEMP, 'C:\\Temp');
    assert.equal(Object.hasOwn(env, 'TOAPIS_API_KEY'), false);
    assert.equal(Object.hasOwn(env, 'Authorization'), false);
    assert.equal(Object.hasOwn(env, 'OTHER_SECRET'), false);
  });

  it('upgrades only a complete inspected and cost-reviewed matrix', () => {
    const results = completedEvidence();
    assert.equal(hasCompleteRequiredMatrix(results), true);
    assert.deepEqual(buildVerifiedCapabilities(results), {
      'seedance-2-fast': {
        durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        resolutions: ['480p', '720p'],
        supportsFirstFrame: true,
        supportsLastFrame: true,
        supportsImageReference: true,
        supportsVideoReference: true,
        supportsAudioReference: true,
        supportsAudio: true,
        maxReferences: 1,
        maxVideoReferences: 1,
        maxAudioReferences: 1,
      },
      'seedance-2-mini': {
        durations: [4, 8, 10, 12, 15],
        resolutions: ['480p', '720p'],
        supportsFirstFrame: true,
        supportsLastFrame: true,
        supportsImageReference: true,
        supportsVideoReference: true,
        supportsAudioReference: true,
        supportsAudio: true,
        maxReferences: 1,
        maxVideoReferences: 1,
        maxAudioReferences: 1,
      },
    });
    assert.equal(hasCompleteRequiredMatrix(results.slice(1)), false);
    assert.equal(hasCompleteRequiredMatrix(results.map((item, index) => (
      index === 0 ? { ...item, billing: { ...item.billing, reviewed: false } } : item
    ))), false);
  });

  it('rejects forged, mismatched, duplicated or role-less evidence before DB verification', () => {
    const wrong720 = completedEvidence();
    wrong720.find((item) => item.id === 'mini-t2v-720').artifact.ffprobe = {
      ...wrong720.find((item) => item.id === 'mini-t2v-720').artifact.ffprobe,
      width: 864,
      height: 496,
    };
    assert.equal(hasCompleteRequiredMatrix(wrong720), false);

    const missingRole = completedEvidence();
    missingRole.find((item) => item.id === 'fast-omni-480').request.audio_with_roles = [];
    assert.equal(hasCompleteRequiredMatrix(missingRole), false);

    const duplicateTask = completedEvidence();
    duplicateTask[1].provider_task_id = duplicateTask[0].provider_task_id;
    assert.equal(hasCompleteRequiredMatrix(duplicateTask), false);

    const duplicateBalanceWindow = completedEvidence();
    duplicateBalanceWindow[1].billing = JSON.parse(JSON.stringify(duplicateBalanceWindow[0].billing));
    assert.equal(hasCompleteRequiredMatrix(duplicateBalanceWindow), false);

    const driftingBalanceChain = completedEvidence();
    driftingBalanceChain[1].billing.before.used_balance += 0.0000001;
    driftingBalanceChain[1].billing.before.used_credits += 0.0000001;
    assert.equal(hasCompleteRequiredMatrix(driftingBalanceChain), false);

    const wrongDuration = completedEvidence();
    wrongDuration[0].request.duration = 15;
    assert.equal(hasCompleteRequiredMatrix(wrongDuration), false);

    const forgedBilling = completedEvidence();
    forgedBilling[0].billing.debited_balance = 0.2;
    assert.equal(hasCompleteRequiredMatrix(forgedBilling), false);

    for (const fileName of ['not-video.txt', 'no-extension', 'video.mp4.json']) {
      const wrongArtifactType = completedEvidence();
      wrongArtifactType[0].artifact.output_file = fileName;
      wrongArtifactType[0].artifact.public_url = `https://molimama.vip/verification-assets/toapis/${fileName}`;
      assert.equal(hasCompleteRequiredMatrix(wrongArtifactType), false);
    }

    const mismatchedArtifactName = completedEvidence();
    mismatchedArtifactName[0].artifact.public_url = 'https://molimama.vip/verification-assets/toapis/another.mp4';
    assert.equal(hasCompleteRequiredMatrix(mismatchedArtifactName), false);

    const nonCanonicalArtifactUrl = completedEvidence();
    nonCanonicalArtifactUrl[0].artifact.public_url = `https://molimama.vip/verification-assets/toapis/sub/../${nonCanonicalArtifactUrl[0].artifact.output_file}`;
    assert.equal(hasCompleteRequiredMatrix(nonCanonicalArtifactUrl), false);
  });
});
