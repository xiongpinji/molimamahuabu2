const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');

const {
  EVIDENCE_VERSION,
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
  publishVerifiedEvidence,
  recordVerificationResult,
  requireVerificationConfigIds,
  runVerification,
  validateVerificationConfigs,
  verifyAllStoredResults,
} = require('../scripts/verify-toapis-video-models');

const log = { info() {}, warn() {}, error() {} };

function createSplitVerificationDatabase(databasePath, overrides = {}) {
  const db = new Database(databasePath);
  runMigrationsAndEnsure(db);
  const fast = aiConfigService.createConfig(db, log, {
    service_type: 'video',
    provider: 'toapis',
    api_protocol: 'toapis_video',
    name: 'ToAPIs Fast',
    base_url: 'https://toapis.cn',
    api_key: overrides.fastApiKey || 'test-fast-key',
    model: ['seedance-2-fast'],
    default_model: 'seedance-2-fast',
  });
  const mini = aiConfigService.createConfig(db, log, {
    service_type: 'video',
    provider: overrides.miniProvider || 'toapis',
    api_protocol: 'toapis_video',
    name: 'ToAPIs Mini',
    base_url: 'https://toapis.cn',
    api_key: overrides.miniApiKey || 'test-mini-key',
    model: ['seedance-2-mini'],
    default_model: 'seedance-2-mini',
  });
  db.close();
  return { fastId: fast.id, miniId: mini.id };
}

function verificationRows(databasePath, configIds) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return configIds.map((configId) => db.prepare(`SELECT id, verification_status, verified_capabilities,
        verified_at, verification_error, updated_at
      FROM ai_service_configs WHERE id = ?`).get(configId));
  } finally {
    db.close();
  }
}

async function withProcessEnv(values, task) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value == null) delete process.env[key];
      else process.env[key] = String(value);
    }
    return await task();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function completedEvidence() {
  const accountState = {
    'seedance-2-fast': { balance: 1, credits: 200, fingerprint: 'a'.repeat(64) },
    'seedance-2-mini': { balance: 10, credits: 2000, fingerprint: 'b'.repeat(64) },
  };
  return buildRequiredMatrix().map((item, index) => {
    const startedAt = new Date(Date.UTC(2026, 7, 7, 0, index * 2, 0));
    const generationElapsedSeconds = 60 + index;
    const completedAt = new Date(startedAt.getTime() + generationElapsedSeconds * 1000);
    const account = accountState[item.model];
    const usedBalanceBefore = account.balance;
    const usedCreditsBefore = account.credits;
    account.balance = Number((account.balance + 0.1).toFixed(1));
    account.credits += 20;
    return {
      id: item.id,
      model: item.model,
      config_fingerprint: account.fingerprint,
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
          used_balance: usedBalanceBefore,
          used_credits: usedCreditsBefore,
          credits_per_usd: 200,
          captured_at: new Date(Date.UTC(2026, 7, 7, 0, index * 2)).toISOString(),
        },
        after: {
          used_balance: account.balance,
          used_credits: account.credits,
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
      verificationClients: {
        'seedance-2-fast': {
          apiKey: 'test-key',
          config: { base_url: 'https://toapis.cn', api_key: 'test-key' },
        },
      },
      outputDir,
      artifactOutputDir: outputDir,
      publicAssetBaseUrl: 'https://molimama.vip/verification-assets/toapis',
      statePath,
      state: {
        state_version: 'toapis-video-verification-state-v1',
        provider_origin: 'https://toapis.cn',
        config_fingerprints: {
          'seedance-2-fast': 'a'.repeat(64),
          'seedance-2-mini': 'b'.repeat(64),
        },
        cases: {},
      },
      configFingerprints: {
        'seedance-2-fast': 'a'.repeat(64),
        'seedance-2-mini': 'b'.repeat(64),
      },
      costBudget: {
        expectedCosts: { [item.id]: 3.6 },
        aggregateHardCapYuan: 9.2,
        perCaseHardCaps: {},
      },
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

  it('requires two distinct verification config ids for the split Fast and Mini routes', () => {
    assert.deepEqual(requireVerificationConfigIds({
      TOAPIS_VERIFY_FAST_CONFIG_ID: '16',
      TOAPIS_VERIFY_MINI_CONFIG_ID: '27',
    }), {
      'seedance-2-fast': 16,
      'seedance-2-mini': 27,
    });
    assert.throws(() => requireVerificationConfigIds({
      TOAPIS_VERIFY_FAST_CONFIG_ID: '16',
      TOAPIS_VERIFY_MINI_CONFIG_ID: '16',
    }), /必须分别指向两个配置/);
    assert.throws(() => requireVerificationConfigIds({
      TOAPIS_VERIFY_FAST_CONFIG_ID: '16',
    }), /MINI_CONFIG_ID/);
  });

  it('rejects swapped split routes before a paid verification can start', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-split-preflight-'));
    const databasePath = path.join(directory, 'verification.db');
    try {
      const configIds = createSplitVerificationDatabase(databasePath);
      assert.throws(() => validateVerificationConfigs({
        databasePath,
        configIds: {
          'seedance-2-fast': configIds.miniId,
          'seedance-2-mini': configIds.fastId,
        },
      }), /seedance-2-fast/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs the split-config preflight before any balance or paid provider call', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-run-preflight-'));
    const databasePath = path.join(directory, 'verification.db');
    try {
      const configIds = createSplitVerificationDatabase(databasePath);
      let balanceCalls = 0;
      let createCalls = 0;
      await assert.rejects(() => withProcessEnv({
        TOAPIS_BASE_URL: 'https://toapis.cn',
        TOAPIS_VERIFY_DEDICATED_TOKEN: '1',
        TOAPIS_VERIFY_FAST_CONFIG_ID: configIds.miniId,
        TOAPIS_VERIFY_MINI_CONFIG_ID: configIds.fastId,
        TOAPIS_VERIFY_DATABASE_PATH: databasePath,
        TOAPIS_VERIFY_OUTPUT_DIR: path.join(directory, 'private'),
        TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR: path.join(directory, 'public'),
        TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL: 'https://molimama.vip/verification-assets/toapis',
        TOAPIS_API_KEY: 'test-provider-key',
      }, () => runVerification({
        async fetchBalance() { balanceCalls += 1; },
        async createTask() { createCalls += 1; },
      })), /seedance-2-fast/);
      assert.equal(balanceCalls, 0);
      assert.equal(createCalls, 0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects split verification configs that reuse the same provider key', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-shared-key-preflight-'));
    const databasePath = path.join(directory, 'verification.db');
    try {
      const configIds = createSplitVerificationDatabase(databasePath, {
        fastApiKey: 'shared-provider-key',
        miniApiKey: 'shared-provider-key',
      });
      assert.throws(() => validateVerificationConfigs({
        databasePath,
        configIds: {
          'seedance-2-fast': configIds.fastId,
          'seedance-2-mini': configIds.miniId,
        },
      }), /FAST.*MINI.*Key.*分别|不能共用/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preflights both config-bound balances before the first paid POST', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-split-key-balance-'));
    const databasePath = path.join(directory, 'verification.db');
    try {
      const configIds = createSplitVerificationDatabase(databasePath);
      const balanceKeys = [];
      let createCalls = 0;
      await assert.rejects(() => withProcessEnv({
        TOAPIS_BASE_URL: 'https://toapis.cn',
        TOAPIS_VERIFY_DEDICATED_TOKEN: '1',
        TOAPIS_VERIFY_FAST_CONFIG_ID: configIds.fastId,
        TOAPIS_VERIFY_MINI_CONFIG_ID: configIds.miniId,
        TOAPIS_VERIFY_DATABASE_PATH: databasePath,
        TOAPIS_VERIFY_OUTPUT_DIR: path.join(directory, 'private'),
        TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR: path.join(directory, 'public'),
        TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL: 'https://molimama.vip/verification-assets/toapis',
        TOAPIS_VERIFY_CASES: 'fast-t2v-480,mini-t2v-480',
        TOAPIS_EXPECTED_COST_YUAN_JSON: JSON.stringify({
          'fast-t2v-480': 1,
          'mini-t2v-480': 1,
        }),
        TOAPIS_VERIFY_AGGREGATE_HARD_CAP_YUAN: '9.20',
        TOAPIS_API_KEY: 'wrong-global-key',
      }, () => runVerification({
        assertFfprobeAvailable() {},
        async fetchBalance(apiKey) {
          balanceKeys.push(apiKey);
          if (apiKey === 'test-fast-key') {
            return { used_balance: 1, used_credits: 100, credits_per_usd: 200 };
          }
          if (apiKey === 'test-mini-key') throw new Error('MINI 余额预检失败');
          throw new Error('使用了非配置绑定 Key');
        },
        async createTask() {
          createCalls += 1;
          throw new Error('不应触发 POST');
        },
      })), /MINI 余额预检失败/);
      assert.deepEqual(balanceKeys, ['test-fast-key', 'test-mini-key']);
      assert.equal(createCalls, 0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('submits, polls and measures each model with its own config-bound key', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-split-key-routing-'));
    const databasePath = path.join(directory, 'verification.db');
    try {
      const configIds = createSplitVerificationDatabase(databasePath);
      const balanceKeys = [];
      const submitKeys = [];
      const pollKeys = [];
      await assert.rejects(() => withProcessEnv({
        TOAPIS_BASE_URL: 'https://toapis.cn',
        TOAPIS_VERIFY_DEDICATED_TOKEN: '1',
        TOAPIS_VERIFY_FAST_CONFIG_ID: configIds.fastId,
        TOAPIS_VERIFY_MINI_CONFIG_ID: configIds.miniId,
        TOAPIS_VERIFY_DATABASE_PATH: databasePath,
        TOAPIS_VERIFY_OUTPUT_DIR: path.join(directory, 'private'),
        TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR: path.join(directory, 'public'),
        TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL: 'https://molimama.vip/verification-assets/toapis',
        TOAPIS_VERIFY_CASES: 'fast-t2v-480,mini-t2v-480',
        TOAPIS_EXPECTED_COST_YUAN_JSON: JSON.stringify({
          'fast-t2v-480': 1,
          'mini-t2v-480': 1,
        }),
        TOAPIS_VERIFY_AGGREGATE_HARD_CAP_YUAN: '9.20',
        TOAPIS_USD_CNY_RATE: '7.2',
        TOAPIS_VERIFY_MAX_POLLS: '1',
        TOAPIS_VERIFY_POLL_MS: '0',
        TOAPIS_API_KEY: null,
      }, () => runVerification({
        assertFfprobeAvailable() {},
        async fetchBalance(apiKey) {
          balanceKeys.push(apiKey);
          const modelCallCount = balanceKeys.filter((value) => value === apiKey).length;
          return {
            used_balance: modelCallCount > 2 ? 1.1 : 1,
            used_credits: modelCallCount > 2 ? 120 : 100,
            credits_per_usd: 200,
          };
        },
        async createTask(config, _log, _opts, requestOpts) {
          submitKeys.push(requestOpts.apiKey);
          assert.equal(config.api_key, requestOpts.apiKey);
          return { task_id: `task-${submitKeys.length}` };
        },
        async fetchTask(config, _taskId, requestOpts) {
          pollKeys.push(requestOpts.apiKey);
          assert.equal(config.api_key, requestOpts.apiKey);
          if (requestOpts.apiKey === 'test-mini-key') return { state: 'failed', error: 'MINI 任务明确失败' };
          return { state: 'completed', progress: 100, videoUrl: 'https://assets.example/video.mp4' };
        },
        async downloadAndInspect(_url, filePath, item, publicUrl) {
          const bytes = Buffer.alloc(2048, 1);
          fs.writeFileSync(filePath, bytes);
          return {
            public_url: publicUrl,
            output_file: path.basename(filePath),
            bytes: bytes.length,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            ffprobe: { width: 864, height: 496, duration_seconds: item.duration, video_codec: 'h264', has_audio: true },
          };
        },
        async sleep() {},
      })), /MINI 任务明确失败/);
      assert.deepEqual(submitKeys, ['test-fast-key', 'test-mini-key']);
      assert.deepEqual(pollKeys, ['test-fast-key', 'test-mini-key']);
      assert.deepEqual(balanceKeys, [
        'test-fast-key', 'test-mini-key',
        'test-fast-key', 'test-fast-key',
        'test-mini-key',
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('captures a fresh config-bound before and after balance for all eight paid cases', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-eight-case-billing-'));
    const matrix = buildRequiredMatrix();
    const fingerprints = {
      'seedance-2-fast': 'a'.repeat(64),
      'seedance-2-mini': 'b'.repeat(64),
    };
    const accountState = {
      'test-fast-key': { balance: 1, credits: 200 },
      'test-mini-key': { balance: 10, credits: 2000 },
    };
    const context = {
      verificationClients: {
        'seedance-2-fast': {
          apiKey: 'test-fast-key',
          config: { base_url: 'https://toapis.cn', api_key: 'test-fast-key' },
        },
        'seedance-2-mini': {
          apiKey: 'test-mini-key',
          config: { base_url: 'https://toapis.cn', api_key: 'test-mini-key' },
        },
      },
      outputDir,
      artifactOutputDir: outputDir,
      publicAssetBaseUrl: 'https://molimama.vip/verification-assets/toapis',
      statePath: path.join(outputDir, 'state.json'),
      state: {
        state_version: 'toapis-video-verification-state-v1',
        provider_origin: 'https://toapis.cn',
        config_fingerprints: fingerprints,
        cases: {},
      },
      configFingerprints: fingerprints,
      costBudget: {
        expectedCosts: Object.fromEntries(matrix.map((item) => [item.id, 0.72])),
        aggregateHardCapYuan: 9.2,
        perCaseHardCaps: {},
      },
      refs: {
        firstFrameUrl: 'https://assets.example/first.png',
        lastFrameUrl: 'https://assets.example/last.png',
        referenceImageUrl: 'https://assets.example/ref.png',
        referenceVideoUrl: 'https://assets.example/ref.mp4',
        referenceAudioUrl: 'https://assets.example/ref.mp3',
      },
      runId: 'eight-case-billing-run',
      submittedCaseIds: [],
      preflightBalances: {
        'seedance-2-fast': {
          used_balance: 1,
          used_credits: 200,
          credits_per_usd: 200,
          captured_at: '2026-08-28T00:00:00.000Z',
        },
        'seedance-2-mini': {
          used_balance: 10,
          used_credits: 2000,
          credits_per_usd: 200,
          captured_at: '2026-08-28T00:00:01.000Z',
        },
      },
    };
    const balanceKeys = [];
    let clock = Date.parse('2026-08-28T01:00:00.000Z');
    const nextIso = () => {
      const value = new Date(clock).toISOString();
      clock += 1000;
      return value;
    };
    const deps = {
      now: () => {
        const value = new Date(clock);
        clock += 1000;
        return value;
      },
      async fetchBalance(apiKey) {
        balanceKeys.push(apiKey);
        const account = accountState[apiKey];
        const caseId = context.submittedCaseIds.at(-1);
        const isAfter = Boolean(context.state.cases[caseId]?.billing?.before);
        if (isAfter) {
          account.balance = Number((account.balance + 0.1).toFixed(1));
          account.credits += 20;
        }
        return {
          used_balance: account.balance,
          used_credits: account.credits,
          credits_per_usd: 200,
          captured_at: nextIso(),
        };
      },
      async createTask(_config, _log, _options, requestOptions) {
        return { task_id: `task-${requestOptions.apiKey}-${context.submittedCaseIds.at(-1)}` };
      },
      async fetchTask() {
        return { state: 'completed', progress: 100, videoUrl: 'https://assets.example/video.mp4' };
      },
      async downloadAndInspect(_url, filePath, item, publicUrl) {
        const bytes = Buffer.alloc(2048, 1);
        return {
          public_url: publicUrl,
          output_file: path.basename(filePath),
          bytes: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          ffprobe: {
            width: item.resolution === '720p' ? 1280 : 864,
            height: item.resolution === '720p' ? 720 : 496,
            duration_seconds: item.duration,
            video_codec: 'h264',
            has_audio: item.generateAudio === true,
          },
        };
      },
      async sleep() {},
    };
    const previousRate = process.env.TOAPIS_USD_CNY_RATE;
    process.env.TOAPIS_USD_CNY_RATE = '7.2';
    try {
      for (const item of matrix) await processCase(item, context, deps);
      assert.equal(context.submittedCaseIds.length, 8);
      assert.equal(balanceKeys.filter((key) => key === 'test-fast-key').length, 8);
      assert.equal(balanceKeys.filter((key) => key === 'test-mini-key').length, 8);
      for (const item of matrix) {
        assert.ok(Date.parse(context.state.cases[item.id].billing.before.captured_at)
          >= Date.parse('2026-08-28T01:00:00.000Z'));
      }
    } finally {
      if (previousRate == null) delete process.env.TOAPIS_USD_CNY_RATE;
      else process.env.TOAPIS_USD_CNY_RATE = previousRate;
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('stops before POST when the supplier balance snapshot is not numeric', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-invalid-balance-'));
    const databasePath = path.join(directory, 'verification.db');
    try {
      const configIds = createSplitVerificationDatabase(databasePath);
      let getCalls = 0;
      let postCalls = 0;
      await assert.rejects(() => withProcessEnv({
        TOAPIS_BASE_URL: 'https://toapis.cn',
        TOAPIS_VERIFY_DEDICATED_TOKEN: '1',
        TOAPIS_VERIFY_FAST_CONFIG_ID: configIds.fastId,
        TOAPIS_VERIFY_MINI_CONFIG_ID: configIds.miniId,
        TOAPIS_VERIFY_DATABASE_PATH: databasePath,
        TOAPIS_VERIFY_OUTPUT_DIR: path.join(directory, 'private'),
        TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR: path.join(directory, 'public'),
        TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL: 'https://molimama.vip/verification-assets/toapis',
        TOAPIS_VERIFY_CASES: 'fast-t2v-480',
        TOAPIS_EXPECTED_COST_YUAN_JSON: JSON.stringify({ 'fast-t2v-480': 1 }),
        TOAPIS_VERIFY_AGGREGATE_HARD_CAP_YUAN: '9.20',
        TOAPIS_API_KEY: 'test-provider-key',
      }, () => runVerification({
        assertFfprobeAvailable() {},
        async fetchImpl(_url, options = {}) {
          if (options.method === 'GET') {
            getCalls += 1;
            return {
              ok: true,
              async json() {
                return { success: true, used_balance: 'invalid', used_credits: 100, remain_balance: -1 };
              },
            };
          }
          postCalls += 1;
          throw new Error('unexpected provider POST');
        },
      })), /used_balance.*有效数字/);
      assert.equal(getCalls, 1);
      assert.equal(postCalls, 0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preflights every selected case cost, reference and ffprobe dependency before any supplier call', async () => {
    const scenarios = [
      {
        name: 'later-cost',
        selector: 'fast-t2v-480,mini-t2v-480',
        expectedCosts: { 'fast-t2v-480': 1 },
        refs: {},
        deps: { assertFfprobeAvailable() {} },
        error: /mini-t2v-480.*预计人民币成本/,
      },
      {
        name: 'later-reference',
        selector: 'fast-t2v-480,mini-omni-480',
        expectedCosts: { 'fast-t2v-480': 1, 'mini-omni-480': 1 },
        refs: {},
        deps: { assertFfprobeAvailable() {} },
        error: /mini-omni-480.*参考图片/,
      },
      {
        name: 'ffprobe',
        selector: 'fast-t2v-480',
        expectedCosts: { 'fast-t2v-480': 1 },
        refs: {},
        deps: { assertFfprobeAvailable() { throw new Error('ffprobe unavailable'); } },
        error: /ffprobe unavailable/,
      },
    ];

    for (const scenario of scenarios) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `toapis-full-preflight-${scenario.name}-`));
      const databasePath = path.join(directory, 'verification.db');
      try {
        const configIds = createSplitVerificationDatabase(databasePath);
        let balanceCalls = 0;
        let createCalls = 0;
        await assert.rejects(() => withProcessEnv({
          TOAPIS_BASE_URL: 'https://toapis.cn',
          TOAPIS_VERIFY_DEDICATED_TOKEN: '1',
          TOAPIS_VERIFY_FAST_CONFIG_ID: configIds.fastId,
          TOAPIS_VERIFY_MINI_CONFIG_ID: configIds.miniId,
          TOAPIS_VERIFY_DATABASE_PATH: databasePath,
          TOAPIS_VERIFY_OUTPUT_DIR: path.join(directory, 'private'),
          TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR: path.join(directory, 'public'),
          TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL: 'https://molimama.vip/verification-assets/toapis',
          TOAPIS_VERIFY_CASES: scenario.selector,
          TOAPIS_EXPECTED_COST_YUAN_JSON: JSON.stringify(scenario.expectedCosts),
          TOAPIS_VERIFY_AGGREGATE_HARD_CAP_YUAN: '9.20',
          TOAPIS_VERIFY_FIRST_FRAME_URL: scenario.refs.firstFrameUrl,
          TOAPIS_VERIFY_LAST_FRAME_URL: scenario.refs.lastFrameUrl,
          TOAPIS_VERIFY_REFERENCE_IMAGE_URL: scenario.refs.referenceImageUrl,
          TOAPIS_VERIFY_REFERENCE_VIDEO_URL: scenario.refs.referenceVideoUrl,
          TOAPIS_VERIFY_REFERENCE_AUDIO_URL: scenario.refs.referenceAudioUrl,
          TOAPIS_API_KEY: 'test-provider-key',
        }, () => runVerification({
          async fetchBalance() { balanceCalls += 1; return { used_balance: 1, used_credits: 100 }; },
          async createTask() { createCalls += 1; return { indeterminate: true, error: 'must not submit' }; },
          ...scenario.deps,
        })), scenario.error);
        assert.equal(balanceCalls, 0);
        assert.equal(createCalls, 0);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('refuses direct paid case processing without the bound run budget before any supplier call', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-direct-budget-'));
    const item = buildRequiredMatrix()[0];
    let balanceCalls = 0;
    let createCalls = 0;
    try {
      await assert.rejects(() => withProcessEnv({
        TOAPIS_EXPECTED_COST_YUAN_JSON: JSON.stringify({ [item.id]: 1 }),
      }, () => processCase(item, {
        verificationClients: {
          'seedance-2-fast': {
            apiKey: 'test-key',
            config: { base_url: 'https://toapis.cn', api_key: 'test-key' },
          },
        },
        outputDir,
        artifactOutputDir: outputDir,
        publicAssetBaseUrl: 'https://molimama.vip/verification-assets/toapis',
        statePath: path.join(outputDir, 'state.json'),
        state: { state_version: 'toapis-video-verification-state-v1', cases: {} },
        refs: {},
        submittedCaseIds: [],
      }, {
        async fetchBalance() { balanceCalls += 1; return { used_balance: 1, used_credits: 100 }; },
        async createTask() { createCalls += 1; return { indeterminate: true, error: 'must not submit' }; },
      })), /整轮成本预检/);
      assert.equal(balanceCalls, 0);
      assert.equal(createCalls, 0);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('requires an aggregate RMB hard cap and rejects an over-budget matrix before any supplier call', async () => {
    const scenarios = [
      { name: 'missing', hardCap: null, error: /AGGREGATE_HARD_CAP_YUAN/ },
      { name: 'exceeded', hardCap: '1.99', error: /预计人民币总成本.*硬上限/ },
    ];
    for (const scenario of scenarios) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `toapis-hard-cap-${scenario.name}-`));
      const databasePath = path.join(directory, 'verification.db');
      try {
        const configIds = createSplitVerificationDatabase(databasePath);
        let balanceCalls = 0;
        let createCalls = 0;
        await assert.rejects(() => withProcessEnv({
          TOAPIS_BASE_URL: 'https://toapis.cn',
          TOAPIS_VERIFY_DEDICATED_TOKEN: '1',
          TOAPIS_VERIFY_FAST_CONFIG_ID: configIds.fastId,
          TOAPIS_VERIFY_MINI_CONFIG_ID: configIds.miniId,
          TOAPIS_VERIFY_DATABASE_PATH: databasePath,
          TOAPIS_VERIFY_OUTPUT_DIR: path.join(directory, 'private'),
          TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR: path.join(directory, 'public'),
          TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL: 'https://molimama.vip/verification-assets/toapis',
          TOAPIS_VERIFY_CASES: 'fast-t2v-480,mini-t2v-480',
          TOAPIS_EXPECTED_COST_YUAN_JSON: JSON.stringify({ 'fast-t2v-480': 1, 'mini-t2v-480': 1 }),
          TOAPIS_VERIFY_AGGREGATE_HARD_CAP_YUAN: scenario.hardCap,
          TOAPIS_API_KEY: 'test-provider-key',
        }, () => runVerification({
          assertFfprobeAvailable() {},
          async fetchBalance() { balanceCalls += 1; return { used_balance: 1, used_credits: 100 }; },
          async createTask() { createCalls += 1; return { indeterminate: true, error: 'must not submit' }; },
        })), scenario.error);
        assert.equal(balanceCalls, 0);
        assert.equal(createCalls, 0);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('stops the matrix after a real debit exceeds the aggregate hard cap', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-actual-hard-cap-'));
    const databasePath = path.join(directory, 'verification.db');
    const outputDir = path.join(directory, 'private');
    const publicArtifactDir = path.join(directory, 'public');
    try {
      const configIds = createSplitVerificationDatabase(databasePath);
      let balanceCalls = 0;
      const balanceCallsByKey = new Map();
      let createCalls = 0;
      await assert.rejects(() => withProcessEnv({
        TOAPIS_BASE_URL: 'https://toapis.cn',
        TOAPIS_VERIFY_DEDICATED_TOKEN: '1',
        TOAPIS_VERIFY_FAST_CONFIG_ID: configIds.fastId,
        TOAPIS_VERIFY_MINI_CONFIG_ID: configIds.miniId,
        TOAPIS_VERIFY_DATABASE_PATH: databasePath,
        TOAPIS_VERIFY_OUTPUT_DIR: outputDir,
        TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR: publicArtifactDir,
        TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL: 'https://molimama.vip/verification-assets/toapis',
        TOAPIS_VERIFY_CASES: 'fast-t2v-480,mini-t2v-480',
        TOAPIS_EXPECTED_COST_YUAN_JSON: JSON.stringify({ 'fast-t2v-480': 1, 'mini-t2v-480': 1 }),
        TOAPIS_VERIFY_AGGREGATE_HARD_CAP_YUAN: '2.50',
        TOAPIS_USD_CNY_RATE: '7.2',
        TOAPIS_API_KEY: 'test-provider-key',
      }, () => runVerification({
        assertFfprobeAvailable() {},
        async fetchBalance(apiKey) {
          balanceCalls += 1;
          const modelCallCount = (balanceCallsByKey.get(apiKey) || 0) + 1;
          balanceCallsByKey.set(apiKey, modelCallCount);
          return apiKey === 'test-fast-key' && modelCallCount > 2
            ? { used_balance: 1.4, used_credits: 140, captured_at: '2026-08-28T00:01:00.000Z' }
            : { used_balance: 1, used_credits: 100, captured_at: '2026-08-28T00:00:00.000Z' };
        },
        async createTask() { createCalls += 1; return { task_id: 'task-over-cap' }; },
        async fetchTask() { return { state: 'completed', progress: 100, videoUrl: 'https://assets.example/video.mp4' }; },
        async downloadAndInspect(_url, filePath, item, publicUrl) {
          const bytes = Buffer.alloc(2048, 1);
          fs.writeFileSync(filePath, bytes);
          return {
            public_url: publicUrl,
            output_file: path.basename(filePath),
            bytes: bytes.length,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            ffprobe: { width: 864, height: 496, duration_seconds: item.duration, video_codec: 'h264', has_audio: true },
          };
        },
        async sleep() {},
      })), /实际人民币总成本.*硬上限/);
      assert.equal(createCalls, 1);
      assert.equal(balanceCalls, 4);
      const state = JSON.parse(fs.readFileSync(path.join(outputDir, 'toapis-video-verification-state.json')));
      assert.equal(state.cases['fast-t2v-480'].status, 'cost_cap_exceeded');
      assert.equal(state.cases['fast-t2v-480'].billing.cost_yuan, 2.88);
      assert.equal(state.cases['mini-t2v-480'], undefined);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects legacy or fingerprint-mismatched state before replaying any selected case', async () => {
    const stateVariants = [
      {
        name: 'legacy-origin',
        state: {
          state_version: 'toapis-video-verification-state-v1',
          provider_origin: 'https://toapis.com',
          cases: { 'mini-t2v-480': { id: 'mini-t2v-480', submission_state: 'indeterminate' } },
        },
        error: /状态.*官方入口|版本不兼容/,
      },
      {
        name: 'legacy-v1-origin',
        state: {
          state_version: 'toapis-video-verification-state-v1',
          provider_origin: 'https://toapis.cn/v1',
          cases: {},
        },
        error: /状态.*官方入口|版本不兼容/,
      },
      {
        name: 'fingerprint',
        state: {
          state_version: 'toapis-video-verification-state-v1',
          provider_origin: 'https://toapis.cn',
          config_fingerprints: { 'seedance-2-fast': 'old-fast', 'seedance-2-mini': 'old-mini' },
          cases: {},
        },
        error: /配置指纹/,
      },
      {
        name: 'case-fingerprint',
        buildState(fingerprints) {
          return {
            state_version: 'toapis-video-verification-state-v1',
            provider_origin: 'https://toapis.cn',
            config_fingerprints: fingerprints,
            cases: {
              'fast-t2v-480': {
                id: 'fast-t2v-480',
                model: 'seedance-2-fast',
                provider_origin: 'https://toapis.cn',
                config_fingerprint: '0'.repeat(64),
                submission_state: 'accepted',
                provider_task_id: 'task-old-config',
              },
            },
          };
        },
        error: /fast-t2v-480.*配置指纹/,
      },
    ];
    for (const variant of stateVariants) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `toapis-state-binding-${variant.name}-`));
      const databasePath = path.join(directory, 'verification.db');
      const outputDir = path.join(directory, 'private');
      try {
        const configIds = createSplitVerificationDatabase(databasePath);
        const snapshots = validateVerificationConfigs({
          databasePath,
          configIds: { 'seedance-2-fast': configIds.fastId, 'seedance-2-mini': configIds.miniId },
        });
        const fingerprints = Object.fromEntries(snapshots.map((item) => [item.model, item.fingerprint]));
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(
          path.join(outputDir, 'toapis-video-verification-state.json'),
          JSON.stringify(variant.buildState ? variant.buildState(fingerprints) : variant.state),
        );
        let balanceCalls = 0;
        let createCalls = 0;
        await assert.rejects(() => withProcessEnv({
          TOAPIS_BASE_URL: 'https://toapis.cn',
          TOAPIS_VERIFY_DEDICATED_TOKEN: '1',
          TOAPIS_VERIFY_FAST_CONFIG_ID: configIds.fastId,
          TOAPIS_VERIFY_MINI_CONFIG_ID: configIds.miniId,
          TOAPIS_VERIFY_DATABASE_PATH: databasePath,
          TOAPIS_VERIFY_OUTPUT_DIR: outputDir,
          TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR: path.join(directory, 'public'),
          TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL: 'https://molimama.vip/verification-assets/toapis',
          TOAPIS_VERIFY_CASES: 'fast-t2v-480',
          TOAPIS_EXPECTED_COST_YUAN_JSON: JSON.stringify({ 'fast-t2v-480': 1 }),
          TOAPIS_VERIFY_AGGREGATE_HARD_CAP_YUAN: '9.20',
          TOAPIS_API_KEY: 'test-provider-key',
        }, () => runVerification({
          assertFfprobeAvailable() {},
          async fetchBalance() { balanceCalls += 1; },
          async createTask() { createCalls += 1; },
        })), variant.error);
        assert.equal(balanceCalls, 0);
        assert.equal(createCalls, 0);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('blocks every selector when any state case is submitting or indeterminate', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-global-indeterminate-'));
    const databasePath = path.join(directory, 'verification.db');
    const outputDir = path.join(directory, 'private');
    try {
      const configIds = createSplitVerificationDatabase(databasePath);
      const snapshots = validateVerificationConfigs({
        databasePath,
        configIds: { 'seedance-2-fast': configIds.fastId, 'seedance-2-mini': configIds.miniId },
      });
      const fingerprints = Object.fromEntries(snapshots.map((item) => [item.model, item.fingerprint]));
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'toapis-video-verification-state.json'), JSON.stringify({
        state_version: 'toapis-video-verification-state-v1',
        provider_origin: 'https://toapis.cn',
        config_fingerprints: fingerprints,
        cases: {
          'mini-omni-480': {
            id: 'mini-omni-480',
            model: 'seedance-2-mini',
            provider_origin: 'https://toapis.cn',
            config_fingerprint: fingerprints['seedance-2-mini'],
            submission_state: 'indeterminate',
          },
        },
      }));
      let balanceCalls = 0;
      let createCalls = 0;
      await assert.rejects(() => withProcessEnv({
        TOAPIS_BASE_URL: 'https://toapis.cn',
        TOAPIS_VERIFY_DEDICATED_TOKEN: '1',
        TOAPIS_VERIFY_FAST_CONFIG_ID: configIds.fastId,
        TOAPIS_VERIFY_MINI_CONFIG_ID: configIds.miniId,
        TOAPIS_VERIFY_DATABASE_PATH: databasePath,
        TOAPIS_VERIFY_OUTPUT_DIR: outputDir,
        TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR: path.join(directory, 'public'),
        TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL: 'https://molimama.vip/verification-assets/toapis',
        TOAPIS_VERIFY_CASES: 'fast-t2v-480',
        TOAPIS_EXPECTED_COST_YUAN_JSON: JSON.stringify({ 'fast-t2v-480': 1 }),
        TOAPIS_VERIFY_AGGREGATE_HARD_CAP_YUAN: '9.20',
        TOAPIS_API_KEY: 'test-provider-key',
      }, () => runVerification({
        assertFfprobeAvailable() {},
        async fetchBalance() { balanceCalls += 1; },
        async createTask() { createCalls += 1; },
      })), /mini-omni-480.*结果未知/);
      assert.equal(balanceCalls, 0);
      assert.equal(createCalls, 0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes the verified matrix atomically to the dedicated Fast and Mini configs', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-split-config-'));
    const databasePath = path.join(directory, 'verification.db');
    const evidencePath = path.join(directory, 'toapis-video-verification.json');
    try {
      const configIds = createSplitVerificationDatabase(databasePath);
      const idsByModel = {
        'seedance-2-fast': configIds.fastId,
        'seedance-2-mini': configIds.miniId,
      };
      const configSnapshots = validateVerificationConfigs({ databasePath, configIds: idsByModel });
      fs.writeFileSync(evidencePath, JSON.stringify({ contract_version: EVIDENCE_VERSION, marker: 'split-config' }));
      const evidenceSha256 = crypto.createHash('sha256').update(fs.readFileSync(evidencePath)).digest('hex');
      const updated = recordVerificationResult(completedEvidence(), null, {
        databasePath,
        evidencePath,
        configIds: idsByModel,
        configSnapshots,
      });
      assert.deepEqual(updated.map((item) => item.id), [configIds.fastId, configIds.miniId]);

      const db = new Database(databasePath, { readonly: true, fileMustExist: true });
      const fast = aiConfigService.getConfig(db, configIds.fastId);
      const mini = aiConfigService.getConfig(db, configIds.miniId);
      db.close();
      assert.equal(fast.verification_status, 'verified');
      assert.deepEqual(Object.keys(fast.verified_capabilities), ['seedance-2-fast']);
      assert.equal(fast.verified_capabilities['seedance-2-fast'].evidence_contract, EVIDENCE_VERSION);
      assert.equal(fast.verified_capabilities['seedance-2-fast'].evidence_sha256, evidenceSha256);
      assert.equal(mini.verification_status, 'verified');
      assert.deepEqual(Object.keys(mini.verified_capabilities), ['seedance-2-mini']);
      assert.equal(mini.verified_capabilities['seedance-2-mini'].evidence_contract, EVIDENCE_VERSION);
      assert.equal(mini.verified_capabilities['seedance-2-mini'].evidence_sha256, evidenceSha256);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rolls back both rows if the second config write fails after Fast was updated', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-split-rollback-'));
    const databasePath = path.join(directory, 'verification.db');
    const evidencePath = path.join(directory, 'toapis-video-verification.json');
    try {
      const configIds = createSplitVerificationDatabase(databasePath);
      const idsByModel = {
        'seedance-2-fast': configIds.fastId,
        'seedance-2-mini': configIds.miniId,
      };
      const configSnapshots = validateVerificationConfigs({ databasePath, configIds: idsByModel });
      fs.writeFileSync(evidencePath, JSON.stringify({ contract_version: EVIDENCE_VERSION, marker: 'rollback' }));
      const ids = [configIds.fastId, configIds.miniId];
      const before = verificationRows(databasePath, ids);
      let writes = 0;
      assert.throws(() => recordVerificationResult(completedEvidence(), null, {
        databasePath,
        evidencePath,
        configIds: idsByModel,
        configSnapshots,
        recordVerification(db, configId, result) {
          writes += 1;
          if (writes === 2) throw new Error('injected Mini write failure');
          return aiConfigService.recordVerification(db, configId, result);
        },
      }), /injected Mini write failure/);
      assert.equal(writes, 2);
      assert.deepEqual(verificationRows(databasePath, ids), before);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves both trusted config rows when a submission is unknown or the matrix is incomplete', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-split-preserve-'));
    const databasePath = path.join(directory, 'verification.db');
    try {
      const configIds = createSplitVerificationDatabase(databasePath);
      const ids = [configIds.fastId, configIds.miniId];
      const db = new Database(databasePath);
      aiConfigService.recordVerification(db, configIds.fastId, {
        status: 'verified',
        verifiedAt: '2026-08-27T00:00:00.000Z',
        capabilities: { 'seedance-2-fast': { marker: 'trusted-fast' } },
      });
      aiConfigService.recordVerification(db, configIds.miniId, {
        status: 'verified',
        verifiedAt: '2026-08-27T00:00:00.000Z',
        capabilities: { 'seedance-2-mini': { marker: 'trusted-mini' } },
      });
      db.close();
      const before = verificationRows(databasePath, ids);
      const options = {
        databasePath,
        configIds: {
          'seedance-2-fast': configIds.fastId,
          'seedance-2-mini': configIds.miniId,
        },
      };

      assert.equal(recordVerificationResult(completedEvidence(), new Error('submission unknown'), options), null);
      assert.equal(recordVerificationResult(completedEvidence().slice(1), null, options), null);
      assert.deepEqual(verificationRows(databasePath, ids), before);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps trusted split configs unchanged across submission, polling and artifact failures', async () => {
    const scenarios = [
      {
        name: 'indeterminate',
        deps: { async createTask() { return { indeterminate: true, error: 'submission unknown' }; } },
        error: /submission unknown/,
      },
      {
        name: 'rejected',
        deps: { async createTask() { return { error: 'provider rejected' }; } },
        error: /provider rejected/,
      },
      {
        name: 'failed',
        deps: {
          async createTask() { return { task_id: 'task-failed' }; },
          async fetchTask() { return { state: 'failed', error: 'provider task failed' }; },
        },
        error: /provider task failed/,
      },
      {
        name: 'timeout',
        deps: {
          async createTask() { return { task_id: 'task-timeout' }; },
          async fetchTask() { return { state: 'processing', progress: 5 }; },
          async sleep() {},
        },
        error: /任务轮询超时/,
      },
      {
        name: 'artifact',
        deps: {
          async createTask() { return { task_id: 'task-artifact' }; },
          async fetchTask() {
            return { state: 'completed', progress: 100, videoUrl: 'https://assets.example/result.mp4' };
          },
          async downloadAndInspect() { throw new Error('public artifact sha mismatch'); },
        },
        error: /public artifact sha mismatch/,
      },
    ];

    for (const scenario of scenarios) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `toapis-run-${scenario.name}-`));
      const databasePath = path.join(directory, 'verification.db');
      try {
        const configIds = createSplitVerificationDatabase(databasePath);
        const ids = [configIds.fastId, configIds.miniId];
        const db = new Database(databasePath);
        aiConfigService.recordVerification(db, configIds.fastId, {
          status: 'verified',
          verifiedAt: '2026-08-27T00:00:00.000Z',
          capabilities: { 'seedance-2-fast': { marker: 'trusted-fast' } },
        });
        aiConfigService.recordVerification(db, configIds.miniId, {
          status: 'verified',
          verifiedAt: '2026-08-27T00:00:00.000Z',
          capabilities: { 'seedance-2-mini': { marker: 'trusted-mini' } },
        });
        db.close();
        const before = verificationRows(databasePath, ids);
        let balanceCalls = 0;
        const deps = {
          assertFfprobeAvailable() {},
          async fetchBalance() {
            balanceCalls += 1;
            return { used_balance: 1, used_credits: 100 };
          },
          ...scenario.deps,
        };

        await assert.rejects(() => withProcessEnv({
          TOAPIS_BASE_URL: 'https://toapis.cn',
          TOAPIS_VERIFY_DEDICATED_TOKEN: '1',
          TOAPIS_VERIFY_FAST_CONFIG_ID: configIds.fastId,
          TOAPIS_VERIFY_MINI_CONFIG_ID: configIds.miniId,
          TOAPIS_VERIFY_DATABASE_PATH: databasePath,
          TOAPIS_VERIFY_OUTPUT_DIR: path.join(directory, 'private'),
          TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR: path.join(directory, 'public'),
          TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL: 'https://molimama.vip/verification-assets/toapis',
          TOAPIS_VERIFY_CASES: 'fast-t2v-480',
          TOAPIS_EXPECTED_COST_YUAN_JSON: JSON.stringify({ 'fast-t2v-480': 1 }),
          TOAPIS_VERIFY_AGGREGATE_HARD_CAP_YUAN: '9.20',
          TOAPIS_VERIFY_MAX_POLLS: '1',
          TOAPIS_VERIFY_POLL_MS: '0',
          TOAPIS_API_KEY: 'test-provider-key',
        }, () => runVerification(deps)), scenario.error);
        assert.equal(balanceCalls, 2);
        assert.deepEqual(verificationRows(databasePath, ids), before);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('publishes a zero-POST completed run to both split configs through the full orchestrator', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-run-success-'));
    const databasePath = path.join(directory, 'verification.db');
    const outputDir = path.join(directory, 'private');
    const publicArtifactDir = path.join(directory, 'public');
    const statePath = path.join(outputDir, 'toapis-video-verification-state.json');
    try {
      const configIds = createSplitVerificationDatabase(databasePath);
      const results = completedEvidence();
      const snapshots = validateVerificationConfigs({
        databasePath,
        configIds: { 'seedance-2-fast': configIds.fastId, 'seedance-2-mini': configIds.miniId },
      });
      const fingerprints = Object.fromEntries(snapshots.map((item) => [item.model, item.fingerprint]));
      for (const item of results) {
        item.provider_origin = 'https://toapis.cn';
        item.config_fingerprint = fingerprints[item.model];
      }
      fs.mkdirSync(outputDir, { recursive: true });
      fs.mkdirSync(publicArtifactDir, { recursive: true });
      for (const [index, item] of results.entries()) {
        const bytes = Buffer.alloc(2048, index + 1);
        item.artifact.bytes = bytes.length;
        item.artifact.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        fs.writeFileSync(path.join(publicArtifactDir, item.artifact.output_file), bytes);
      }
      fs.writeFileSync(statePath, JSON.stringify({
        state_version: 'toapis-video-verification-state-v1',
        provider_origin: 'https://toapis.cn',
        config_fingerprints: fingerprints,
        cases: Object.fromEntries(results.map((item) => [item.id, item])),
      }));
      const byFile = new Map(results.map((item) => [item.artifact.output_file, item]));
      let balanceCalls = 0;
      let createCalls = 0;

      const run = await withProcessEnv({
        TOAPIS_BASE_URL: 'https://toapis.cn',
        TOAPIS_VERIFY_DEDICATED_TOKEN: '1',
        TOAPIS_VERIFY_FAST_CONFIG_ID: configIds.fastId,
        TOAPIS_VERIFY_MINI_CONFIG_ID: configIds.miniId,
        TOAPIS_VERIFY_DATABASE_PATH: databasePath,
        TOAPIS_VERIFY_OUTPUT_DIR: outputDir,
        TOAPIS_VERIFY_PUBLIC_ARTIFACT_DIR: publicArtifactDir,
        TOAPIS_VERIFY_PUBLIC_ASSET_BASE_URL: 'https://molimama.vip/verification-assets/toapis',
        TOAPIS_VERIFY_CASES: null,
        TOAPIS_VERIFY_CONFIRM_COST: '1',
        TOAPIS_VERIFIED_PRICING_JSON: JSON.stringify(baselinePricing()),
        TOAPIS_EXPECTED_COST_YUAN_JSON: null,
        TOAPIS_API_KEY: 'test-provider-key',
      }, () => runVerification({
        async fetchBalance() { balanceCalls += 1; },
        async createTask() { createCalls += 1; },
        runFfprobe(filePath) { return byFile.get(path.basename(filePath)).artifact.ffprobe; },
        async assertPublicArtifact() {},
      }));

      assert.equal(balanceCalls, 0);
      assert.equal(createCalls, 0);
      assert.equal(run.results.length, 8);
      const evidenceBytes = fs.readFileSync(run.evidencePath);
      const evidenceSha256 = crypto.createHash('sha256').update(evidenceBytes).digest('hex');
      const db = new Database(databasePath, { readonly: true, fileMustExist: true });
      const fast = aiConfigService.getConfig(db, configIds.fastId);
      const mini = aiConfigService.getConfig(db, configIds.miniId);
      db.close();
      assert.equal(fast.verification_status, 'verified');
      assert.deepEqual(Object.keys(fast.verified_capabilities), ['seedance-2-fast']);
      assert.equal(fast.verified_capabilities['seedance-2-fast'].evidence_sha256, evidenceSha256);
      assert.equal(mini.verification_status, 'verified');
      assert.deepEqual(Object.keys(mini.verified_capabilities), ['seedance-2-mini']);
      assert.equal(mini.verified_capabilities['seedance-2-mini'].evidence_sha256, evidenceSha256);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects evidence writeback when a verified route changes after the paid-run preflight', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-split-drift-'));
    const databasePath = path.join(directory, 'verification.db');
    const evidencePath = path.join(directory, 'toapis-video-verification.json');
    try {
      const configIds = createSplitVerificationDatabase(databasePath);
      const idsByModel = {
        'seedance-2-fast': configIds.fastId,
        'seedance-2-mini': configIds.miniId,
      };
      const configSnapshots = validateVerificationConfigs({ databasePath, configIds: idsByModel });
      const db = new Database(databasePath);
      db.prepare('UPDATE ai_service_configs SET api_key = ?, updated_at = ? WHERE id = ?')
        .run('rotated-fast-key', '2026-08-27T01:00:00.000Z', configIds.fastId);
      db.close();
      fs.writeFileSync(evidencePath, JSON.stringify({ contract_version: EVIDENCE_VERSION, marker: 'drift' }));
      const before = verificationRows(databasePath, [configIds.fastId, configIds.miniId]);

      assert.throws(() => recordVerificationResult(completedEvidence(), null, {
        databasePath,
        evidencePath,
        configIds: idsByModel,
        configSnapshots,
      }), /配置已在验证期间发生变化/);
      assert.deepEqual(verificationRows(databasePath, [configIds.fastId, configIds.miniId]), before);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('restores the previous evidence bytes when split config publication fails', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-evidence-rollback-'));
    const databasePath = path.join(directory, 'verification.db');
    const evidencePath = path.join(directory, 'toapis-video-verification.json');
    const previousBytes = Buffer.from('{"contract_version":"previous-contract","marker":"keep"}\n');
    fs.writeFileSync(evidencePath, previousBytes);
    try {
      const configIds = createSplitVerificationDatabase(databasePath);
      const idsByModel = {
        'seedance-2-fast': configIds.fastId,
        'seedance-2-mini': configIds.miniId,
      };
      const configSnapshots = validateVerificationConfigs({ databasePath, configIds: idsByModel });
      const before = verificationRows(databasePath, [configIds.fastId, configIds.miniId]);
      const results = completedEvidence();
      const evidence = buildReleaseEvidence(results, baselinePricing(), {
        run_id: 'review-run-1',
        reviewed_at: '2026-08-07T01:00:00.000Z',
        completed_before_run: buildRequiredMatrix().map((item) => item.id),
        submitted_case_ids: [],
      });
      let writes = 0;
      assert.throws(() => publishVerifiedEvidence(results, baselinePricing(), evidence, {
        databasePath,
        evidencePath,
        configIds: idsByModel,
        configSnapshots,
        recordVerification(db, configId, result) {
          writes += 1;
          if (writes === 2) throw new Error('injected split DB publication failure');
          return aiConfigService.recordVerification(db, configId, result);
        },
      }), /injected split DB publication failure/);
      assert.equal(writes, 2);
      assert.deepEqual(fs.readFileSync(evidencePath), previousBytes);
      assert.deepEqual(verificationRows(databasePath, [configIds.fastId, configIds.miniId]), before);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
    const binding = {
      evidence_contract: EVIDENCE_VERSION,
      evidence_sha256: 'a'.repeat(64),
    };
    assert.equal(hasCompleteRequiredMatrix(results), true);
    assert.deepEqual(buildVerifiedCapabilities(results, binding), {
      'seedance-2-fast': {
        durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        resolutions: ['480p', '720p'],
        supportsFirstFrame: true,
        supportsLastFrame: true,
        supportsImageReference: true,
        supportsVideoReference: true,
        supportsAudioReference: true,
        supportsAudio: true,
        maxReferences: 9,
        maxVideoReferences: 3,
        maxAudioReferences: 3,
        ...binding,
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
        maxReferences: 9,
        maxVideoReferences: 3,
        maxAudioReferences: 3,
        ...binding,
      },
    });
    assert.equal(hasCompleteRequiredMatrix(results.slice(1)), false);
    assert.equal(hasCompleteRequiredMatrix(results.map((item, index) => (
      index === 0 ? { ...item, billing: { ...item.billing, reviewed: false } } : item
    ))), false);
  });

  it('validates billing continuity independently for each model and config fingerprint', () => {
    assert.equal(hasCompleteRequiredMatrix(completedEvidence()), true);
  });

  it('rejects FAST and MINI evidence that shares one config fingerprint', () => {
    const sharedFingerprint = completedEvidence();
    const fastFingerprint = sharedFingerprint.find((item) => item.model === 'seedance-2-fast').config_fingerprint;
    for (const item of sharedFingerprint) {
      if (item.model === 'seedance-2-mini') item.config_fingerprint = fastFingerprint;
    }
    assert.equal(hasCompleteRequiredMatrix(sharedFingerprint), false);
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
