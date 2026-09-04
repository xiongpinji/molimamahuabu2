const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  WAN3_CASE,
  buildWan3Evidence,
  decideWan3ResumeAction,
  runWan3SmokeImport,
  runWan3Verification,
} = require('../scripts/verify-toapis-wan3-video');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wan3-verification-'));
  const privateDir = path.join(root, 'private');
  const publicDir = path.join(root, 'public');
  fs.mkdirSync(privateDir);
  fs.mkdirSync(publicDir);
  return {
    root,
    privateDir,
    publicDir,
    env: {
      TOAPIS_WAN3_API_KEY: 'sk-test-wan3',
      TOAPIS_WAN3_VERIFY_CONFIG_ID: '99',
      TOAPIS_WAN3_VERIFY_OUTPUT_DIR: privateDir,
      TOAPIS_WAN3_VERIFY_PUBLIC_ARTIFACT_DIR: publicDir,
      TOAPIS_WAN3_VERIFY_PUBLIC_ASSET_BASE_URL: 'https://molimama.vip/verification-assets/toapis',
      TOAPIS_WAN3_EXPECTED_COST_YUAN: '0.90',
      TOAPIS_WAN3_HARD_CAP_YUAN: '1.00',
      TOAPIS_USD_CNY_RATE: '7.00',
    },
  };
}

function readState(current) {
  return JSON.parse(fs.readFileSync(path.join(current.privateDir, 'toapis-wan3-video-verification-state.json'), 'utf8'));
}

function writeState(current, state) {
  fs.writeFileSync(
    path.join(current.privateDir, 'toapis-wan3-video-verification-state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

function smokeImportFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wan3-smoke-import-'));
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(root, 'formal');
  fs.mkdirSync(inputDir);
  fs.mkdirSync(outputDir);
  const taskId = 'tsk_vid_01M18AGA9YSCSHX96QE86B6AVS';
  const clientBusinessId = 'molimama-wan3-smoke-cf19e73a-f272-4d94-84c9-48908ef29b2a';
  const artifactPath = path.join(inputDir, `wan3-480p-2s-silent-${taskId}.mp4`);
  const artifactBytes = Buffer.alloc(4096, 17);
  fs.writeFileSync(artifactPath, artifactBytes);
  const smoke = {
    contract_version: 'toapis-wan3-unlimited-smoke-v1',
    evidence_scope: 'provider_availability_smoke_only',
    production_billing_evidence: false,
    production_activation_authorized: false,
    config_id: 16,
    request: {
      model: 'wan3.0-video',
      mode: 't2v',
      duration: 2,
      resolution: '480p',
      ratio: '16:9',
      audio: false,
      reference_count: 0,
    },
    submission: {
      client_business_id: clientBusinessId,
      provider_task_id: taskId,
      post_count: 1,
      submitted_at: '2026-08-30T03:12:30.385Z',
      accepted_at: '2026-08-30T03:12:32.607Z',
    },
    artifact: {
      output_file: path.basename(artifactPath),
      local_path: artifactPath,
      content_type: 'video/mp4',
      bytes: artifactBytes.length,
      sha256: crypto.createHash('sha256').update(artifactBytes).digest('hex'),
      ffprobe: {
        format: 'mov,mp4,m4a,3gp,3g2,mj2',
        width: 832,
        height: 480,
        duration_seconds: 2,
        video_codec: 'h264',
        has_audio: false,
        audio_codec: null,
      },
    },
    account: {
      before: {
        used_balance: 1.2,
        used_credits: 240,
        remain_balance: -1,
        remain_credits: 0,
        credits_per_usd: 200,
        unlimited_quota: true,
        captured_at: '2026-08-30T03:12:30.382Z',
      },
      after: {
        used_balance: 1.3,
        used_credits: 260,
        remain_balance: -1,
        remain_credits: 0,
        credits_per_usd: 200,
        unlimited_quota: true,
        captured_at: '2026-08-30T03:14:55.583Z',
      },
      after_error: null,
      delta: { used_balance: 0.10000000000000009, used_credits: 20 },
      billing_binding: 'positive_usage_delta_observed',
    },
    completed_at: '2026-08-30T03:14:55.584Z',
  };
  const smokeResultPath = path.join(inputDir, 'toapis-wan3-unlimited-smoke.json');
  fs.writeFileSync(smokeResultPath, `${JSON.stringify(smoke, null, 2)}\n`);
  return {
    root,
    outputDir,
    artifactPath,
    smokeResultPath,
    smoke,
    taskId,
    clientBusinessId,
    env: {
      TOAPIS_WAN3_API_KEY: 'sk-runtime-secret-never-persist',
      TOAPIS_WAN3_TARGET_CONFIG_ID: '99',
      TOAPIS_WAN3_IMPORT_SMOKE_RESULT_PATH: smokeResultPath,
      TOAPIS_WAN3_IMPORT_ARTIFACT_PATH: artifactPath,
      TOAPIS_WAN3_IMPORT_OUTPUT_DIR: outputDir,
      TOAPIS_USD_CNY_RATE: '7.00',
    },
  };
}

test('import mode promotes one completed unlimited smoke without provider I/O', async () => {
  const current = smokeImportFixture();
  try {
    const evidence = await runWan3SmokeImport({
      env: current.env,
      deps: {
        now: () => new Date('2026-08-30T04:00:00.000Z'),
        randomUUID: () => 'd7cf6cdd-f106-46b2-8ee1-cfdc6cc42d80',
        fetchImpl: async () => { throw new Error('import must not GET or POST'); },
        createTask: async () => { throw new Error('import must not submit'); },
        runFfprobe: () => ({
          format: 'mov,mp4,m4a,3gp,3g2,mj2',
          width: 832,
          height: 480,
          duration_seconds: 2,
          video_codec: 'h264',
          has_audio: false,
          audio_codec: null,
        }),
      },
    });

    const outputFile = `${WAN3_CASE.id}-${current.taskId}.mp4`;
    const evidencePath = path.join(current.outputDir, 'toapis-wan3-video-verification.json');
    const manifestPath = path.join(current.outputDir, 'manifest.json');
    const publicArtifactPath = path.join(current.outputDir, 'public', 'toapis', outputFile);
    const persistedEvidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.deepEqual(evidence, persistedEvidence);
    assert.equal(JSON.parse(fs.readFileSync(current.smokeResultPath, 'utf8')).config_id, 16);
    assert.equal(evidence.run_id, 'd7cf6cdd-f106-46b2-8ee1-cfdc6cc42d80');
    assert.equal(evidence.results[0].recovery_task_id, current.clientBusinessId);
    assert.equal(evidence.results[0].request.client_business_id, current.clientBusinessId);
    assert.equal(evidence.results[0].request.prompt, 'A calm two-second cinematic shot of sunlight moving across an empty studio table, no text, no logos.');
    assert.equal(evidence.results[0].source_config_id, 16);
    assert.equal(evidence.results[0].target_config_id, 99);
    assert.equal(evidence.results[0].config_id, 99);
    assert.equal(
      evidence.results[0].credential_fingerprint,
      crypto.createHash('sha256').update('sk-runtime-secret-never-persist').digest('hex'),
    );
    assert.equal(evidence.results[0].config_fingerprint, crypto.createHash('sha256').update(JSON.stringify({
      id: '99',
      provider: 'toapis_wan3',
      model: 'wan3.0-video',
      base_url: 'https://toapis.cn',
      api_key: 'sk-runtime-secret-never-persist',
    })).digest('hex'));
    assert.equal(
      evidence.results[0].request_sha256,
      crypto.createHash('sha256').update(JSON.stringify(evidence.results[0].request)).digest('hex'),
    );
    assert.equal(evidence.results[0].artifact.output_file, outputFile);
    assert.equal(evidence.results[0].artifact.bytes, current.smoke.artifact.bytes);
    assert.equal(evidence.results[0].artifact.sha256, current.smoke.artifact.sha256);
    assert.deepEqual(fs.readFileSync(publicArtifactPath), fs.readFileSync(current.artifactPath));
    assert.deepEqual(evidence.results[0].billing, {
      evidence_mode: 'unlimited_quota_positive_usage_v1',
      expected_cost_yuan: null,
      hard_cap_yuan: null,
      before: current.smoke.account.before,
      after: current.smoke.account.after,
      debited_balance: 0.1,
      debited_credits: 20,
      provider_currency: 'USD',
      usd_cny_rate: 7,
      cost_yuan: 0.7,
    });
    const evidenceBytes = fs.readFileSync(evidencePath);
    assert.deepEqual(manifest, {
      contract_version: 'external-model-release-evidence-manifest-v1',
      evidence: {
        'toapis-wan3-video-real-verification-v1': {
          file: 'toapis-wan3-video-verification.json',
          sha256: crypto.createHash('sha256').update(evidenceBytes).digest('hex'),
        },
      },
    });
    assert.doesNotMatch(JSON.stringify({ evidence, manifest }), /sk-runtime-secret-never-persist/);
    for (const persistedPath of [evidencePath, manifestPath, publicArtifactPath]) {
      assert.doesNotMatch(fs.readFileSync(persistedPath).toString('latin1'), /sk-runtime-secret-never-persist/);
    }
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('import mode rejects non-exact unlimited billing before writing formal evidence', async () => {
  for (const mutate of [
    (smoke) => { smoke.account.after.unlimited_quota = false; },
    (smoke) => { smoke.account.after.remain_balance = 0; },
    (smoke) => { smoke.account.delta.used_credits = 19; },
    (smoke) => { smoke.account.delta.used_balance = 0.2; },
  ]) {
    const current = smokeImportFixture();
    mutate(current.smoke);
    fs.writeFileSync(current.smokeResultPath, `${JSON.stringify(current.smoke, null, 2)}\n`);
    try {
      await assert.rejects(() => runWan3SmokeImport({
        env: current.env,
        deps: {
          now: () => new Date('2026-08-30T04:00:00.000Z'),
          randomUUID: () => 'd7cf6cdd-f106-46b2-8ee1-cfdc6cc42d80',
          runFfprobe: () => current.smoke.artifact.ffprobe,
        },
      }), /unlimited|remain_balance|用量差/);
      assert.equal(fs.readdirSync(current.outputDir).length, 0);
    } finally {
      fs.rmSync(current.root, { recursive: true, force: true });
    }
  }
});

test('import mode rejects request task or target config drift before writing formal evidence', async () => {
  for (const scenario of [
    {
      mutate: (current) => { current.smoke.request.resolution = '720p'; },
      pattern: /request\.resolution/,
    },
    {
      mutate: (current) => { current.smoke.submission.post_count = 2; },
      pattern: /一次已受理 POST/,
    },
    {
      mutate: (current) => { delete current.env.TOAPIS_WAN3_TARGET_CONFIG_ID; },
      pattern: /TARGET_CONFIG_ID/,
    },
    {
      mutate: (current) => { current.env.TOAPIS_WAN3_TARGET_CONFIG_ID = '16'; },
      pattern: /source.*target|目标.*来源|独立/i,
    },
    {
      mutate: (current) => { current.env.TOAPIS_WAN3_TARGET_CONFIG_ID = 'wan-config-99'; },
      pattern: /TARGET_CONFIG_ID|正整数/,
    },
  ]) {
    const current = smokeImportFixture();
    scenario.mutate(current);
    fs.writeFileSync(current.smokeResultPath, `${JSON.stringify(current.smoke, null, 2)}\n`);
    try {
      await assert.rejects(() => runWan3SmokeImport({
        env: current.env,
        deps: {
          now: () => new Date('2026-08-30T04:00:00.000Z'),
          randomUUID: () => 'd7cf6cdd-f106-46b2-8ee1-cfdc6cc42d80',
          runFfprobe: () => current.smoke.artifact.ffprobe,
        },
      }), scenario.pattern);
      assert.equal(fs.readdirSync(current.outputDir).length, 0);
    } finally {
      fs.rmSync(current.root, { recursive: true, force: true });
    }
  }
});

test('import mode rejects artifact or media drift before writing formal evidence', async () => {
  for (const scenario of [
    {
      mutate: (current) => fs.appendFileSync(current.artifactPath, Buffer.from('drift')),
      probe: (current) => current.smoke.artifact.ffprobe,
      pattern: /哈希|字节/,
    },
    {
      mutate: () => {},
      probe: (current) => ({ ...current.smoke.artifact.ffprobe, has_audio: true, audio_codec: 'aac' }),
      pattern: /音频/,
    },
    {
      mutate: () => {},
      probe: (current) => ({ ...current.smoke.artifact.ffprobe, duration_seconds: 5 }),
      pattern: /时长/,
    },
  ]) {
    const current = smokeImportFixture();
    scenario.mutate(current);
    try {
      await assert.rejects(() => runWan3SmokeImport({
        env: current.env,
        deps: {
          now: () => new Date('2026-08-30T04:00:00.000Z'),
          randomUUID: () => 'd7cf6cdd-f106-46b2-8ee1-cfdc6cc42d80',
          runFfprobe: () => scenario.probe(current),
        },
      }), scenario.pattern);
      assert.equal(fs.readdirSync(current.outputDir).length, 0);
    } finally {
      fs.rmSync(current.root, { recursive: true, force: true });
    }
  }
});

test('Wan3 verification case is the minimum-cost explicit contract', () => {
  assert.deepEqual(WAN3_CASE, {
    id: 'wan3-t2v-480p-2s-no-audio',
    model: 'wan3.0-video',
    mode: 't2v',
    resolution: '480p',
    ratio: '16:9',
    duration: 2,
    audio: false,
  });
  assert.equal(decideWan3ResumeAction(null), 'submit');
  for (const status of ['submitting', 'indeterminate', 'rejected', 'failed', 'cost_cap_exceeded']) {
    assert.equal(decideWan3ResumeAction({ status }), 'stop');
  }
  assert.equal(decideWan3ResumeAction({ status: 'processing', provider_task_id: 'task-1' }), 'poll');
  assert.equal(decideWan3ResumeAction({ status: 'completed', provider_task_id: 'task-1', artifact: {} }), 'poll');
  assert.equal(decideWan3ResumeAction({
    status: 'completed',
    provider_task_id: 'task-1',
    artifact: {
      output_file: 'wan3-t2v-480p-2s-no-audio-task-1.mp4',
      public_url: 'https://molimama.vip/verification-assets/toapis/wan3-t2v-480p-2s-no-audio-task-1.mp4',
      sha256: 'a'.repeat(64),
    },
  }), 'complete');
});

test('downloaded artifact is durable before the post-generation balance query', async () => {
  const current = fixture();
  let balanceCalls = 0;
  try {
    await assert.rejects(() => runWan3Verification({
      env: current.env,
      deps: {
        fetchBalance: async () => {
          balanceCalls += 1;
          if (balanceCalls === 1) {
            return { used_balance: 10, used_credits: 100, remain_balance: 100 };
          }
          throw new Error('post-generation balance unavailable');
        },
        createTask: async () => ({ task_id: 'wan-task-durable' }),
        fetchTask: async () => ({ state: 'completed', videoUrl: 'https://cdn.example/wan.mp4' }),
        downloadAndInspect: async (_url, filePath, _item, publicUrl) => {
          const buffer = Buffer.alloc(2048, 7);
          fs.writeFileSync(filePath, buffer);
          return {
            public_url: publicUrl,
            output_file: path.basename(filePath),
            content_type: 'video/mp4',
            bytes: buffer.length,
            sha256: 'c'.repeat(64),
            ffprobe: { width: 854, height: 480, duration_seconds: 2, video_codec: 'h264', has_audio: false, audio_codec: null, format: 'mp4' },
          };
        },
      },
    }), /post-generation balance unavailable/);

    const state = readState(current);
    assert.equal(state.case.status, 'processing');
    assert.equal(state.case.provider_state, 'completed');
    assert.equal(state.case.post_count, 1);
    assert.equal(state.case.artifact.output_file, 'wan3-t2v-480p-2s-no-audio-wan-task-durable.mp4');
    assert.equal(state.case.artifact.sha256, 'c'.repeat(64));
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('known task recovers a deterministic local artifact without POST poll or download', async () => {
  const current = fixture();
  const taskId = 'wan-task-existing';
  const fileName = `wan3-t2v-480p-2s-no-audio-${taskId}.mp4`;
  const artifactBytes = Buffer.alloc(2048, 9);
  fs.writeFileSync(path.join(current.publicDir, fileName), artifactBytes);
  writeState(current, {
    version: 'toapis-wan3-video-verification-state-v1',
    run_id: 'existing-run',
    case: {
      id: WAN3_CASE.id,
      model: WAN3_CASE.model,
      mode: WAN3_CASE.mode,
      requested_resolution: WAN3_CASE.resolution,
      requested_ratio: WAN3_CASE.ratio,
      requested_duration: WAN3_CASE.duration,
      requested_audio: WAN3_CASE.audio,
      status: 'processing',
      submission_state: 'accepted',
      provider_state: 'completed',
      provider_task_id: taskId,
      recovery_task_id: 'wan3-verify-existing-run',
      post_count: 1,
      source_config_id: 99,
      target_config_id: 99,
      config_id: 99,
      credential_fingerprint: 'c'.repeat(64),
      config_fingerprint: 'd'.repeat(64),
      request: { model: WAN3_CASE.model },
      request_sha256: 'e'.repeat(64),
      billing: {
        expected_cost_yuan: 0.9,
        hard_cap_yuan: 1,
        before: { used_balance: 10, used_credits: 100, remain_balance: 100 },
      },
      started_at: '2026-08-29T00:00:00.000Z',
      accepted_at: '2026-08-29T00:00:01.000Z',
    },
  });
  try {
    const evidence = await runWan3Verification({
      env: current.env,
      deps: {
        fetchBalance: async () => ({ used_balance: 10.1, used_credits: 187.5, remain_balance: 99.9 }),
        createTask: async () => { throw new Error('must not POST'); },
        fetchTask: async () => { throw new Error('must not poll'); },
        downloadAndInspect: async () => { throw new Error('must not download'); },
        runFfprobe: () => ({
          width: 854,
          height: 480,
          duration_seconds: 2,
          video_codec: 'h264',
          has_audio: false,
          audio_codec: null,
          format: 'mp4',
        }),
      },
    });

    assert.equal(evidence.results[0].status, 'completed');
    assert.equal(evidence.results[0].post_count, 1);
    assert.equal(evidence.results[0].artifact.bytes, artifactBytes.length);
    assert.equal(evidence.results[0].artifact.sha256, crypto.createHash('sha256').update(artifactBytes).digest('hex'));
    assert.equal(readState(current).case.status, 'completed');

    const evidencePath = path.join(current.privateDir, 'toapis-wan3-video-verification.json');
    fs.rmSync(evidencePath);
    const completedEvidence = await runWan3Verification({
      env: current.env,
      deps: {
        fetchBalance: async () => { throw new Error('must not query balance'); },
        createTask: async () => { throw new Error('must not POST'); },
        fetchTask: async () => { throw new Error('must not poll'); },
        downloadAndInspect: async () => { throw new Error('must not download'); },
        runFfprobe: () => evidence.results[0].artifact.ffprobe,
      },
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(evidencePath, 'utf8')), completedEvidence);

    const checkpointState = readState(current);
    checkpointState.case.status = 'processing';
    delete checkpointState.generated_at;
    writeState(current, checkpointState);
    fs.rmSync(evidencePath);
    const resumedFromBilling = await runWan3Verification({
      env: current.env,
      deps: {
        fetchBalance: async () => { throw new Error('must not query balance'); },
        createTask: async () => { throw new Error('must not POST'); },
        fetchTask: async () => { throw new Error('must not poll'); },
        downloadAndInspect: async () => { throw new Error('must not download'); },
        runFfprobe: () => evidence.results[0].artifact.ffprobe,
      },
    });
    assert.equal(resumedFromBilling.results[0].status, 'completed');
    assert.equal(resumedFromBilling.results[0].post_count, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(evidencePath, 'utf8')), resumedFromBilling);

    fs.writeFileSync(path.join(current.publicDir, fileName), Buffer.alloc(2048, 10));
    await assert.rejects(() => runWan3Verification({
      env: current.env,
      deps: {
        fetchBalance: async () => { throw new Error('must not query balance'); },
        createTask: async () => { throw new Error('must not POST'); },
        fetchTask: async () => { throw new Error('must not poll'); },
        downloadAndInspect: async () => { throw new Error('must not download'); },
        runFfprobe: () => { throw new Error('must reject hash before ffprobe'); },
      },
    }), /哈希与已保存状态不一致/);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('balance preflight failure performs zero POST and leaves no submitting state', async () => {
  const current = fixture();
  let postCount = 0;
  try {
    await assert.rejects(() => runWan3Verification({
      env: current.env,
      deps: {
        fetchBalance: async () => { throw new Error('balance unavailable'); },
        createTask: async () => { postCount += 1; return { task_id: 'must-not-run' }; },
      },
    }), /balance unavailable/);
    assert.equal(postCount, 0);
    assert.equal(fs.existsSync(path.join(current.privateDir, 'toapis-wan3-video-verification-state.json')), false);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('missing or ambiguous remaining balance performs zero POST', async () => {
  for (const balance of [
    { used_balance: 10, used_credits: 100, captured_at: '2026-08-29T00:00:00.000Z' },
    { used_balance: 10, used_credits: 100, remain_balance: -1, unlimited_quota: false },
  ]) {
    const current = fixture();
    let postCount = 0;
    try {
      await assert.rejects(() => runWan3Verification({
        env: current.env,
        deps: {
          fetchBalance: async () => balance,
          createTask: async () => { postCount += 1; return { task_id: 'must-not-run' }; },
        },
      }), /可用余额语义不明确/);
      assert.equal(postCount, 0);
      assert.equal(fs.existsSync(path.join(current.privateDir, 'toapis-wan3-video-verification-state.json')), false);
    } finally {
      fs.rmSync(current.root, { recursive: true, force: true });
    }
  }
});

test('submitting state is durable before POST and unknown result is never resubmitted', async () => {
  const current = fixture();
  let postCount = 0;
  try {
    await assert.rejects(() => runWan3Verification({
      env: current.env,
      deps: {
        fetchBalance: async () => ({ used_balance: 10, used_credits: 100, remain_balance: 100, captured_at: '2026-08-29T00:00:00.000Z' }),
        createTask: async () => {
          postCount += 1;
          const state = readState(current);
          assert.equal(state.case.status, 'submitting');
          assert.equal(state.case.submission_state, 'submitting');
          assert.match(state.case.recovery_task_id, /^wan3-verify-/);
          return {
            indeterminate: true,
            error: 'unknown',
            route_meta: { requestBodySent: true, recoveryTaskId: state.case.recovery_task_id },
          };
        },
      },
    }), /unknown/);
    assert.equal(postCount, 1);
    assert.equal(readState(current).case.status, 'indeterminate');

    await assert.rejects(() => runWan3Verification({
      env: current.env,
      deps: {
        fetchBalance: async () => ({ used_balance: 10, used_credits: 100, remain_balance: 100 }),
        createTask: async () => { postCount += 1; return { task_id: 'duplicate' }; },
      },
    }), /禁止再次提交/);
    assert.equal(postCount, 1);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('successful task records readable artifact, exact billing and redacted evidence', async () => {
  const current = fixture();
  const balances = [
    { used_balance: 10, used_credits: 100, remain_balance: 100, captured_at: '2026-08-29T00:00:00.000Z' },
    { used_balance: 10.1, used_credits: 187.5, remain_balance: 99.9, captured_at: '2026-08-29T00:01:00.000Z' },
  ];
  try {
    const evidence = await runWan3Verification({
      env: current.env,
      deps: {
        now: (() => {
          const values = [
            new Date('2026-08-29T00:00:01.000Z'),
            new Date('2026-08-29T00:00:02.000Z'),
            new Date('2026-08-29T00:00:05.000Z'),
          ];
          return () => values.shift() || new Date('2026-08-29T00:00:05.000Z');
        })(),
        fetchBalance: async () => balances.shift(),
        createTask: async (_config, _log, options) => {
          assert.equal(options.model, 'wan3.0-video');
          assert.equal(options.duration, 2);
          assert.equal(options.resolution, '480p');
          assert.equal(options.audio, false);
          assert.match(options.client_business_id, /^wan3-verify-/);
          return { task_id: 'wan-task-1', status: 'processing' };
        },
        fetchTask: async () => ({ state: 'completed', videoUrl: 'https://cdn.example/wan.mp4' }),
        downloadAndInspect: async (_url, filePath, item, publicUrl) => {
          fs.writeFileSync(filePath, Buffer.alloc(2048, 1));
          assert.equal(item.resolution, '480p');
          return {
            public_url: publicUrl,
            output_file: path.basename(filePath),
            content_type: 'video/mp4',
            bytes: 2048,
            sha256: 'a'.repeat(64),
            ffprobe: {
              width: 854,
              height: 480,
              duration_seconds: 2,
              video_codec: 'h264',
              has_audio: false,
              audio_codec: null,
              format: 'mov,mp4',
            },
          };
        },
      },
    });
    assert.equal(evidence.contract_version, 'toapis-wan3-video-real-verification-v1');
    assert.equal(evidence.results.length, 1);
    assert.equal(evidence.results[0].provider_task_id, 'wan-task-1');
    assert.equal(evidence.results[0].billing.debited_balance, 0.1);
    assert.equal(evidence.results[0].billing.debited_credits, 87.5);
    assert.equal(evidence.results[0].billing.cost_yuan, 0.7);
    assert.equal(evidence.results[0].billing.hard_cap_yuan, 1);
    assert.equal(evidence.results[0].status, 'completed');
    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, /sk-test-wan3/);
    assert.match(evidence.results[0].config_fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      buildWan3Evidence(readState(current)).results,
      evidence.results,
    );
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('actual cost above hard cap is persisted and cannot trigger another POST', async () => {
  const current = fixture();
  let postCount = 0;
  const balances = [
    { used_balance: 10, used_credits: 100, remain_balance: 100, captured_at: '2026-08-29T00:00:00.000Z' },
    { used_balance: 10.2, used_credits: 275, remain_balance: 99.8, captured_at: '2026-08-29T00:01:00.000Z' },
  ];
  try {
    await assert.rejects(() => runWan3Verification({
      env: current.env,
      deps: {
        fetchBalance: async () => balances.shift(),
        createTask: async () => { postCount += 1; return { task_id: 'wan-task-over-cap' }; },
        fetchTask: async () => ({ state: 'completed', videoUrl: 'https://cdn.example/wan.mp4' }),
        downloadAndInspect: async (_url, filePath, _item, publicUrl) => {
          fs.writeFileSync(filePath, Buffer.alloc(2048, 1));
          return {
            public_url: publicUrl, output_file: path.basename(filePath), content_type: 'video/mp4',
            bytes: 2048, sha256: 'b'.repeat(64),
            ffprobe: { width: 854, height: 480, duration_seconds: 2, video_codec: 'h264', has_audio: false, format: 'mp4' },
          };
        },
      },
    }), /实际人民币成本 1\.4 超过硬上限 1/);
    assert.equal(postCount, 1);
    const checkpoint = readState(current).case;
    assert.equal(checkpoint.status, 'cost_cap_exceeded');
    assert.equal(checkpoint.billing.after.used_balance, 10.2);
    assert.equal(checkpoint.billing.debited_balance, 0.2);
    assert.equal(checkpoint.billing.debited_credits, 175);
    assert.equal(checkpoint.billing.cost_yuan, 1.4);
    await assert.rejects(() => runWan3Verification({ env: current.env, deps: {} }), /禁止再次提交/);
    assert.equal(postCount, 1);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});
