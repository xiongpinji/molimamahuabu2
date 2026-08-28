'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');

const {
  CASES,
  buildCaseOptions,
  runPrivateAvatarVerification,
} = require('../scripts/verify-toapis-private-avatar-video');

const log = { info() {}, warn() {}, error() {} };

function createSplitVerificationDatabase(databasePath, overrides = {}) {
  const db = new Database(databasePath);
  runMigrationsAndEnsure(db);
  const fast = aiConfigService.createConfig(db, log, {
    service_type: 'video',
    provider: 'toapis',
    api_protocol: 'toapis_video',
    name: 'ToAPIs Fast private avatar verification',
    base_url: 'https://toapis.xyz',
    api_key: overrides.fastApiKey || 'test-fast-key',
    model: ['seedance-2-fast'],
    default_model: 'seedance-2-fast',
  });
  const mini = aiConfigService.createConfig(db, log, {
    service_type: 'video',
    provider: 'toapis',
    api_protocol: 'toapis_video',
    name: 'ToAPIs Mini private avatar verification',
    base_url: 'https://toapis.xyz',
    api_key: overrides.miniApiKey || 'test-mini-key',
    model: ['seedance-2-mini'],
    default_model: 'seedance-2-mini',
  });
  db.close();
  return {
    'seedance-2-fast': fast.id,
    'seedance-2-mini': mini.id,
  };
}

function privateAvatarInput(outputDir, sourcePath, overrides = {}) {
  const databasePath = path.join(outputDir, 'verification.db');
  const configIds = createSplitVerificationDatabase(databasePath, overrides.config || {});
  return {
    databasePath,
    configIds,
    sourceUrl: 'https://molimama.vip/static/source.jpg?provider_asset_expires=1&provider_asset_signature=x',
    sourcePath,
    sourceIdentity: 'image_generation:344',
    outputDir,
    confirmPaidCall: true,
    expectedCostsYuan: {
      'fast-avatar-480-4s': 1,
      'mini-avatar-480-4s': 1,
    },
    caseHardCapsYuan: {
      'fast-avatar-480-4s': 2,
      'mini-avatar-480-4s': 2,
    },
    aggregateHardCapYuan: 4,
    usdCnyRate: 1,
    ...overrides.input,
  };
}

function balanceSnapshot(usedBalance, usedCredits = usedBalance * 200) {
  return {
    used_balance: usedBalance,
    used_credits: usedCredits,
    remain_balance: 20 - usedBalance,
    remain_credits: 4000 - usedCredits,
    credits_per_usd: 200,
  };
}

function incrementalBalanceFetcher(events = []) {
  const calls = { 'test-fast-key': 0, 'test-mini-key': 0 };
  return async (apiKey) => {
    assert.ok(Object.hasOwn(calls, apiKey), `unexpected balance key: ${apiKey}`);
    events.push(`balance:${apiKey}`);
    calls[apiKey] += 1;
    return balanceSnapshot(1 + (calls[apiKey] * 0.1));
  };
}

test('虚拟人像最小验证固定为 Fast/Mini 各 480P 4 秒且使用同一可信 asset', () => {
  assert.deepEqual(CASES, [
    { id: 'fast-avatar-480-4s', model: 'seedance-2-fast' },
    { id: 'mini-avatar-480-4s', model: 'seedance-2-mini' },
  ]);
  for (const item of CASES) {
    const options = buildCaseOptions(item, 'asset://pa_verified123', 'run-1');
    assert.equal(options.model, item.model);
    assert.equal(options.resolution, '480p');
    assert.equal(options.duration, 4);
    assert.deepEqual(options.reference_urls, ['asset://pa_verified123']);
    assert.deepEqual(options.trusted_asset_urls, ['asset://pa_verified123']);
    assert.equal(options.generate_audio, false);
  }
});

test('私人形象付费验证从只读数据库拒绝共用 Key，且在任何供应商调用前停止', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-avatar-shared-key-'));
  const sourcePath = path.join(outputDir, 'source.jpg');
  fs.writeFileSync(sourcePath, Buffer.alloc(2048, 6));
  const input = privateAvatarInput(outputDir, sourcePath, {
    config: { fastApiKey: 'shared-key', miniApiKey: 'shared-key' },
  });
  let balanceCalls = 0;
  let providerCalls = 0;

  await assert.rejects(runPrivateAvatarVerification(input, {
    fetchBalance: async () => { balanceCalls += 1; },
    createGroup: async () => { providerCalls += 1; },
    callVideo: async () => { providerCalls += 1; },
  }), /FAST.*MINI.*Key.*分别|不能共用/);
  assert.equal(balanceCalls, 0);
  assert.equal(providerCalls, 0);
});

test('私人形象验证禁止回退到全局 TOAPIS_API_KEY', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-avatar-global-key-'));
  const sourcePath = path.join(outputDir, 'source.jpg');
  fs.writeFileSync(sourcePath, Buffer.alloc(2048, 4));
  const input = privateAvatarInput(outputDir, sourcePath, {
    input: { env: { TOAPIS_API_KEY: 'legacy-global-key' } },
  });
  let supplierCalls = 0;

  await assert.rejects(runPrivateAvatarVerification(input, {
    fetchBalance: async () => { supplierCalls += 1; },
    createGroup: async () => { supplierCalls += 1; },
    callVideo: async () => { supplierCalls += 1; },
  }), /禁止使用全局 TOAPIS_API_KEY/);
  assert.equal(supplierCalls, 0);
});

test('预计单例与总人民币成本超过硬上限时在余额 GET 和任何 POST 前停止', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-avatar-cost-cap-'));
  const sourcePath = path.join(outputDir, 'source.jpg');
  fs.writeFileSync(sourcePath, Buffer.alloc(2048, 5));
  const input = privateAvatarInput(outputDir, sourcePath, {
    input: {
      caseHardCapsYuan: {
        'fast-avatar-480-4s': 2,
        'mini-avatar-480-4s': 2,
      },
      aggregateHardCapYuan: 1.5,
    },
  });
  let balanceCalls = 0;
  let providerCalls = 0;

  await assert.rejects(runPrivateAvatarVerification(input, {
    fetchBalance: async () => { balanceCalls += 1; },
    createGroup: async () => { providerCalls += 1; },
    callVideo: async () => { providerCalls += 1; },
  }), /总成本.*硬上限/);
  assert.equal(balanceCalls, 0);
  assert.equal(providerCalls, 0);
});

test('真实验证只创建一次虚拟人像素材并各提交一次 Fast/Mini，记录速度、扣费和成品', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-avatar-verify-'));
  const sourcePath = path.join(outputDir, 'source.jpg');
  fs.writeFileSync(sourcePath, Buffer.alloc(2048, 7));
  const calls = { group: 0, asset: 0, submit: [], poll: [], balance: 0, events: [] };
  const balances = [
    { used_balance: 1, used_credits: 200, remain_balance: 9, remain_credits: 1800, credits_per_usd: 200 },
    { used_balance: 1, used_credits: 200, remain_balance: 9, remain_credits: 1800, credits_per_usd: 200 },
    { used_balance: 1, used_credits: 200, remain_balance: 9, remain_credits: 1800, credits_per_usd: 200 },
    { used_balance: 1.32, used_credits: 264, remain_balance: 8.68, remain_credits: 1736, credits_per_usd: 200 },
    { used_balance: 1.32, used_credits: 264, remain_balance: 8.68, remain_credits: 1736, credits_per_usd: 200 },
    { used_balance: 1.506, used_credits: 301.2, remain_balance: 8.494, remain_credits: 1698.8, credits_per_usd: 200 },
  ];
  const nowValues = [
    '2026-08-11T05:00:00.000Z', '2026-08-11T05:00:01.000Z',
    '2026-08-11T05:00:10.000Z', '2026-08-11T05:00:11.000Z',
    '2026-08-11T05:00:30.000Z', '2026-08-11T05:00:31.000Z',
    '2026-08-11T05:00:45.000Z', '2026-08-11T05:00:46.000Z',
  ].map((value) => new Date(value));
  const input = privateAvatarInput(outputDir, sourcePath);
  const result = await runPrivateAvatarVerification(input, {
    createGroup: async (config) => {
      calls.group += 1;
      calls.events.push(`group:${config.api_key}`);
      return { group_id: 'pg_group1' };
    },
    createAsset: async (config) => {
      calls.asset += 1;
      calls.events.push(`asset:${config.api_key}`);
      return { group_id: 'pg_group1', asset_id: 'pa_asset1', asset_url: 'asset://pa_asset1', status: 'processing' };
    },
    fetchAsset: async (config) => {
      calls.events.push(`asset-get:${config.api_key}`);
      return { group_id: 'pg_group1', asset_id: 'pa_asset1', asset_url: 'asset://pa_asset1', status: 'active' };
    },
    callVideo: async (config, _log, options) => {
      calls.submit.push([options.model, config.api_key]);
      calls.events.push(`submit:${config.api_key}`);
      return { task_id: `task-${options.model}` };
    },
    fetchTask: async (config, taskId) => {
      calls.poll.push([taskId, config.api_key]);
      return { state: 'completed', videoUrl: `https://provider.example/${taskId}.mp4` };
    },
    fetchBalance: async (apiKey) => {
      calls.events.push(`balance:${apiKey}`);
      return { ...balances[calls.balance++] };
    },
    downloadArtifact: async (_url, filePath, item) => {
      fs.writeFileSync(filePath, Buffer.alloc(4096, item.model.endsWith('fast') ? 1 : 2));
      return {
        output_file: path.basename(filePath), content_type: 'video/mp4', bytes: 4096,
        sha256: item.model.endsWith('fast') ? 'a'.repeat(64) : 'b'.repeat(64),
        ffprobe: { width: 864, height: 480, duration_seconds: 4, video_codec: 'h264', has_audio: false },
      };
    },
    now: () => nowValues.shift() || new Date('2026-08-11T05:01:00.000Z'),
    sleep: async () => {},
  });

  assert.equal(calls.group, 1);
  assert.equal(calls.asset, 1);
  assert.deepEqual(calls.events.slice(0, 2), ['balance:test-fast-key', 'balance:test-mini-key']);
  assert.ok(calls.events.indexOf('group:test-fast-key') > 1);
  assert.deepEqual(calls.submit, [
    ['seedance-2-fast', 'test-fast-key'],
    ['seedance-2-mini', 'test-mini-key'],
  ]);
  assert.deepEqual(calls.poll, [
    ['task-seedance-2-fast', 'test-fast-key'],
    ['task-seedance-2-mini', 'test-mini-key'],
  ]);
  assert.equal(result.avatar.asset_id, 'pa_asset1');
  assert.equal(result.cases.length, 2);
  assert.equal(result.cases[0].billing.debited_credits, 64);
  assert.equal(result.cases[1].billing.debited_credits, 37.2);
  assert.equal(result.cases[0].billing.cost_yuan, 0.32);
  assert.equal(result.cases[1].billing.cost_yuan, 0.186);
  assert.equal(result.cases[0].billing.case_hard_cap_yuan, 2);
  assert.equal(result.cases[1].billing.case_hard_cap_yuan, 2);
  assert.ok(result.cases.every((item) => item.speed.generation_elapsed_seconds > 0));
  assert.ok(fs.existsSync(path.join(outputDir, 'toapis-private-avatar-verification.json')));
  const persisted = `${fs.readFileSync(path.join(outputDir, 'toapis-private-avatar-verification-state.json'), 'utf8')}\n${fs.readFileSync(path.join(outputDir, 'toapis-private-avatar-verification.json'), 'utf8')}`;
  assert.equal(persisted.includes('test-fast-key'), false);
  assert.equal(persisted.includes('test-mini-key'), false);
});

test('验证状态绑定 FAST/MINI 配置指纹，轮换 Key 后禁止复用旧提交状态', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-avatar-fingerprint-'));
  const sourcePath = path.join(outputDir, 'source.jpg');
  fs.writeFileSync(sourcePath, Buffer.alloc(2048, 12));
  const input = privateAvatarInput(outputDir, sourcePath);
  let submits = 0;
  let balanceCalls = 0;
  const deps = {
    createGroup: async () => ({ group_id: 'pg_group1' }),
    createAsset: async () => ({ group_id: 'pg_group1', asset_id: 'pa_asset1', asset_url: 'asset://pa_asset1', status: 'active' }),
    fetchAsset: async () => ({ group_id: 'pg_group1', asset_id: 'pa_asset1', asset_url: 'asset://pa_asset1', status: 'active' }),
    fetchBalance: async (apiKey) => {
      balanceCalls += 1;
      return incrementalBalanceFetcher()(apiKey);
    },
    callVideo: async () => { submits += 1; return { indeterminate: true, error: '结果未知' }; },
    now: () => new Date('2026-08-11T05:00:00.000Z'),
    sleep: async () => {},
  };

  await assert.rejects(runPrivateAvatarVerification(input, deps), /结果未知/);
  assert.equal(submits, 1);
  const callsBeforeRotation = balanceCalls;
  const db = new Database(input.databasePath);
  db.prepare('UPDATE ai_service_configs SET api_key = ? WHERE id = ?')
    .run('rotated-mini-key', input.configIds['seedance-2-mini']);
  db.close();

  await assert.rejects(runPrivateAvatarVerification(input, deps), /配置指纹/);
  assert.equal(submits, 1);
  assert.equal(balanceCalls, callsBeforeRotation);
});

test('FAST 实际人民币成本超过单例硬上限后停止，不提交 MINI', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-avatar-actual-cap-'));
  const sourcePath = path.join(outputDir, 'source.jpg');
  fs.writeFileSync(sourcePath, Buffer.alloc(2048, 13));
  const input = privateAvatarInput(outputDir, sourcePath, {
    input: { aggregateHardCapYuan: 10 },
  });
  const balances = [
    balanceSnapshot(1),
    balanceSnapshot(1),
    balanceSnapshot(1),
    balanceSnapshot(4),
  ];
  const submitted = [];
  let balanceIndex = 0;

  await assert.rejects(runPrivateAvatarVerification(input, {
    createGroup: async () => ({ group_id: 'pg_group1' }),
    createAsset: async () => ({ group_id: 'pg_group1', asset_id: 'pa_asset1', asset_url: 'asset://pa_asset1', status: 'active' }),
    fetchAsset: async () => ({ group_id: 'pg_group1', asset_id: 'pa_asset1', asset_url: 'asset://pa_asset1', status: 'active' }),
    fetchBalance: async () => balances[balanceIndex++],
    callVideo: async (_config, _log, options) => {
      submitted.push(options.model);
      return { task_id: `task-${options.model}` };
    },
    fetchTask: async (_config, taskId) => ({ state: 'completed', videoUrl: `https://provider.example/${taskId}.mp4` }),
    downloadArtifact: async (_url, filePath) => {
      fs.writeFileSync(filePath, Buffer.alloc(4096, 1));
      return {
        output_file: path.basename(filePath), content_type: 'video/mp4', bytes: 4096,
        sha256: 'c'.repeat(64),
        ffprobe: { width: 864, height: 480, duration_seconds: 4, video_codec: 'h264', has_audio: false },
      };
    },
    now: () => new Date('2026-08-11T05:00:00.000Z'),
    sleep: async () => {},
  }), /实际人民币成本.*单例硬上限/);
  assert.deepEqual(submitted, ['seedance-2-fast']);
  const state = JSON.parse(fs.readFileSync(path.join(outputDir, 'toapis-private-avatar-verification-state.json'), 'utf8'));
  assert.equal(state.cases['fast-avatar-480-4s'].status, 'cost_cap_exceeded');
  assert.equal(state.cases['mini-avatar-480-4s'], undefined);
});

test('恢复已完成状态时仍校验当前单例人民币硬上限，不提交后续用例', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-avatar-resume-cap-'));
  const sourcePath = path.join(outputDir, 'source.jpg');
  fs.writeFileSync(sourcePath, Buffer.alloc(2048, 14));
  const input = privateAvatarInput(outputDir, sourcePath, {
    input: { aggregateHardCapYuan: 10 },
  });
  const sourceBuffer = fs.readFileSync(sourcePath);
  const fastFingerprint = 'a'.repeat(64);
  const miniFingerprint = 'b'.repeat(64);
  fs.writeFileSync(path.join(outputDir, 'toapis-private-avatar-verification-state.json'), JSON.stringify({
    contract_version: 'toapis-private-avatar-video-verification-v1',
    audit_run_id: 'resume-cap-run',
    provider_origin: 'https://toapis.xyz',
    config_fingerprints: {
      'seedance-2-fast': fastFingerprint,
      'seedance-2-mini': miniFingerprint,
    },
    source: {
      identity: input.sourceIdentity,
      file_name: path.basename(sourcePath),
      bytes: sourceBuffer.length,
      sha256: require('node:crypto').createHash('sha256').update(sourceBuffer).digest('hex'),
    },
    avatar: {
      group_id: 'pg_group1',
      asset_id: 'pa_asset1',
      asset_url: 'asset://pa_asset1',
      status: 'active',
    },
    cases: {
      'fast-avatar-480-4s': {
        id: 'fast-avatar-480-4s',
        model: 'seedance-2-fast',
        resolution: '480p',
        duration: 4,
        provider_origin: 'https://toapis.xyz',
        config_fingerprint: fastFingerprint,
        status: 'completed',
        billing: {
          expected_cost_yuan: 1,
          case_hard_cap_yuan: 2,
          debited_balance: 3,
          debited_credits: 600,
          cost_yuan: 3,
        },
      },
    },
  }, null, 2));
  let balanceCalls = 0;
  let submits = 0;

  await assert.rejects(runPrivateAvatarVerification(input, {
    validateConfigs: () => [
      { model: 'seedance-2-fast', apiKey: 'test-fast-key', fingerprint: fastFingerprint },
      { model: 'seedance-2-mini', apiKey: 'test-mini-key', fingerprint: miniFingerprint },
    ],
    fetchBalance: async () => {
      balanceCalls += 1;
      return balanceSnapshot(1);
    },
    callVideo: async () => {
      submits += 1;
      return { task_id: 'should-not-submit' };
    },
    fetchTask: async () => ({ state: 'completed', videoUrl: 'https://provider.example/should-not-submit.mp4' }),
    downloadArtifact: async (_url, filePath) => {
      fs.writeFileSync(filePath, Buffer.alloc(4096, 1));
      return {
        output_file: path.basename(filePath), content_type: 'video/mp4', bytes: 4096,
        sha256: 'd'.repeat(64),
        ffprobe: { width: 864, height: 480, duration_seconds: 4, video_codec: 'h264', has_audio: false },
      };
    },
    now: () => new Date('2026-08-11T05:00:00.000Z'),
    sleep: async () => {},
  }), /实际人民币成本.*单例硬上限/);
  assert.equal(balanceCalls, 0);
  assert.equal(submits, 0);
});

test('虚拟人像素材名称由长来源标识稳定压缩到 64 字符以内', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-avatar-long-name-'));
  const sourcePath = path.join(outputDir, 'source.jpg');
  fs.writeFileSync(sourcePath, Buffer.alloc(2048, 9));
  const names = [];
  let balance = 0;
  const balances = [
    { used_balance: 1, used_credits: 200, remain_balance: 9, remain_credits: 1800, credits_per_usd: 200 },
    { used_balance: 1, used_credits: 200, remain_balance: 9, remain_credits: 1800, credits_per_usd: 200 },
    { used_balance: 1, used_credits: 200, remain_balance: 9, remain_credits: 1800, credits_per_usd: 200 },
    { used_balance: 1.1, used_credits: 220, remain_balance: 8.9, remain_credits: 1780, credits_per_usd: 200 },
    { used_balance: 1.1, used_credits: 220, remain_balance: 8.9, remain_credits: 1780, credits_per_usd: 200 },
    { used_balance: 1.2, used_credits: 240, remain_balance: 8.8, remain_credits: 1760, credits_per_usd: 200 },
  ];

  const input = privateAvatarInput(outputDir, sourcePath, {
    input: { sourceIdentity: `image_generation:${'a'.repeat(96)}:${'b'.repeat(96)}` },
  });
  await runPrivateAvatarVerification(input, {
    createGroup: async (_config, body) => {
      names.push(body.name);
      return { group_id: 'pg_group1' };
    },
    createAsset: async (_config, body) => {
      names.push(body.name);
      return { group_id: 'pg_group1', asset_id: 'pa_asset1', asset_url: 'asset://pa_asset1', status: 'active' };
    },
    fetchAsset: async () => ({ group_id: 'pg_group1', asset_id: 'pa_asset1', asset_url: 'asset://pa_asset1', status: 'active' }),
    callVideo: async (_config, _log, options) => ({ task_id: `task-${options.model}` }),
    fetchTask: async (_config, taskId) => ({ state: 'completed', videoUrl: `https://provider.example/${taskId}.mp4` }),
    fetchBalance: async () => ({ ...balances[balance++] }),
    downloadArtifact: async (_url, filePath, item) => {
      fs.writeFileSync(filePath, Buffer.alloc(4096, 1));
      return {
        output_file: path.basename(filePath), content_type: 'video/mp4', bytes: 4096,
        sha256: item.model.endsWith('fast') ? 'a'.repeat(64) : 'b'.repeat(64),
        ffprobe: { width: 864, height: 480, duration_seconds: 4, video_codec: 'h264', has_audio: false },
      };
    },
    now: () => new Date('2026-08-11T05:00:00.000Z'),
    sleep: async () => {},
  });

  assert.equal(names.length, 2);
  assert.ok(names.every((name) => name.length <= 64), names.join('\n'));
  assert.notEqual(names[0], names[1]);
});

test('虚拟人像素材明确 400 拒绝后可复用已创建 group 重新提交素材', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-avatar-rejected-'));
  const sourcePath = path.join(outputDir, 'source.jpg');
  fs.writeFileSync(sourcePath, Buffer.alloc(2048, 10));
  let groups = 0;
  let assets = 0;
  const input = privateAvatarInput(outputDir, sourcePath);
  const deps = {
    createGroup: async () => { groups += 1; return { group_id: 'pg_group1' }; },
    createAsset: async () => {
      assets += 1;
      if (assets === 1) {
        throw Object.assign(new Error('ToAPIs 虚拟人像请求失败 (HTTP 400): InvalidParameter.Name'), {
          code: 'TOAPIS_AVATAR_REJECTED',
        });
      }
      return { group_id: 'pg_group1', asset_id: 'pa_asset1', asset_url: 'asset://pa_asset1', status: 'active' };
    },
    fetchAsset: async () => ({ group_id: 'pg_group1', asset_id: 'pa_asset1', asset_url: 'asset://pa_asset1', status: 'active' }),
    callVideo: async (_config, _log, options) => ({ task_id: `task-${options.model}` }),
    fetchTask: async (_config, taskId) => ({ state: 'completed', videoUrl: `https://provider.example/${taskId}.mp4` }),
    fetchBalance: incrementalBalanceFetcher(),
    downloadArtifact: async (_url, filePath, item) => {
      fs.writeFileSync(filePath, Buffer.alloc(4096, 1));
      return {
        output_file: path.basename(filePath), content_type: 'video/mp4', bytes: 4096,
        sha256: item.model.endsWith('fast') ? 'a'.repeat(64) : 'b'.repeat(64),
        ffprobe: { width: 864, height: 480, duration_seconds: 4, video_codec: 'h264', has_audio: false },
      };
    },
    now: () => new Date('2026-08-11T05:00:00.000Z'),
    sleep: async () => {},
  };

  await assert.rejects(runPrivateAvatarVerification(input, deps), /InvalidParameter\.Name/);
  const rejectedState = JSON.parse(fs.readFileSync(path.join(outputDir, 'toapis-private-avatar-verification-state.json'), 'utf8'));
  assert.equal(rejectedState.avatar.group_id, 'pg_group1');
  assert.equal(rejectedState.avatar.asset_submission_state, 'rejected');

  const result = await runPrivateAvatarVerification(input, deps);
  assert.equal(groups, 1);
  assert.equal(assets, 2);
  assert.equal(result.avatar.asset_id, 'pa_asset1');
});

test('虚拟人像素材提交结果未知时仍禁止自动重复提交', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-avatar-asset-unknown-'));
  const sourcePath = path.join(outputDir, 'source.jpg');
  fs.writeFileSync(sourcePath, Buffer.alloc(2048, 11));
  let assets = 0;
  const deps = {
    createGroup: async () => ({ group_id: 'pg_group1' }),
    createAsset: async () => {
      assets += 1;
      throw Object.assign(new Error('ToAPIs 虚拟人像提交结果未知 (HTTP 502)'), {
        code: 'TOAPIS_AVATAR_SUBMISSION_INDETERMINATE',
      });
    },
    fetchAsset: async () => ({ group_id: 'pg_group1', asset_id: 'pa_asset1', asset_url: 'asset://pa_asset1', status: 'active' }),
    fetchBalance: incrementalBalanceFetcher(),
    now: () => new Date(),
    sleep: async () => {},
  };
  const input = privateAvatarInput(outputDir, sourcePath);

  await assert.rejects(runPrivateAvatarVerification(input, deps), /结果未知/);
  await assert.rejects(runPrivateAvatarVerification(input, deps), /禁止自动重复提交/);
  assert.equal(assets, 1);
});

test('提交结果不确定时停止且再次运行不自动重复 POST', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-avatar-indeterminate-'));
  const sourcePath = path.join(outputDir, 'source.jpg');
  fs.writeFileSync(sourcePath, Buffer.alloc(2048, 8));
  let submits = 0;
  const deps = {
    createGroup: async () => ({ group_id: 'pg_group1' }),
    createAsset: async () => ({ group_id: 'pg_group1', asset_id: 'pa_asset1', asset_url: 'asset://pa_asset1', status: 'active' }),
    fetchAsset: async () => ({ group_id: 'pg_group1', asset_id: 'pa_asset1', asset_url: 'asset://pa_asset1', status: 'active' }),
    fetchBalance: incrementalBalanceFetcher(),
    callVideo: async () => { submits += 1; return { indeterminate: true, error: '结果未知' }; },
    now: () => new Date(),
    sleep: async () => {},
  };
  const input = privateAvatarInput(outputDir, sourcePath);
  await assert.rejects(runPrivateAvatarVerification(input, deps), /结果未知/);
  await assert.rejects(runPrivateAvatarVerification(input, deps), /禁止自动重复提交/);
  assert.equal(submits, 1);
});
