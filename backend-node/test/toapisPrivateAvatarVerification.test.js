'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CASES,
  buildCaseOptions,
  runPrivateAvatarVerification,
} = require('../scripts/verify-toapis-private-avatar-video');

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

test('真实验证只创建一次虚拟人像素材并各提交一次 Fast/Mini，记录速度、扣费和成品', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-avatar-verify-'));
  const sourcePath = path.join(outputDir, 'source.jpg');
  fs.writeFileSync(sourcePath, Buffer.alloc(2048, 7));
  const calls = { group: 0, asset: 0, submit: [], balance: 0 };
  const balances = [
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
  const result = await runPrivateAvatarVerification({
    apiKey: 'secret',
    sourceUrl: 'https://molimama.vip/static/source.jpg?provider_asset_expires=1&provider_asset_signature=x',
    sourcePath,
    sourceIdentity: 'image_generation:344',
    outputDir,
    confirmPaidCall: true,
  }, {
    createGroup: async () => { calls.group += 1; return { group_id: 'pg_group1' }; },
    createAsset: async () => {
      calls.asset += 1;
      return { group_id: 'pg_group1', asset_id: 'pa_asset1', asset_url: 'asset://pa_asset1', status: 'processing' };
    },
    fetchAsset: async () => ({ group_id: 'pg_group1', asset_id: 'pa_asset1', asset_url: 'asset://pa_asset1', status: 'active' }),
    callVideo: async (_config, _log, options) => {
      calls.submit.push(options.model);
      return { task_id: `task-${options.model}` };
    },
    fetchTask: async (_config, taskId) => ({ state: 'completed', videoUrl: `https://provider.example/${taskId}.mp4` }),
    fetchBalance: async () => ({ ...balances[calls.balance++] }),
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
  assert.deepEqual(calls.submit, ['seedance-2-fast', 'seedance-2-mini']);
  assert.equal(result.avatar.asset_id, 'pa_asset1');
  assert.equal(result.cases.length, 2);
  assert.equal(result.cases[0].billing.debited_credits, 64);
  assert.equal(result.cases[1].billing.debited_credits, 37.2);
  assert.ok(result.cases.every((item) => item.speed.generation_elapsed_seconds > 0));
  assert.ok(fs.existsSync(path.join(outputDir, 'toapis-private-avatar-verification.json')));
});

test('虚拟人像素材名称由长来源标识稳定压缩到 64 字符以内', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-avatar-long-name-'));
  const sourcePath = path.join(outputDir, 'source.jpg');
  fs.writeFileSync(sourcePath, Buffer.alloc(2048, 9));
  const names = [];
  let balance = 0;
  const balances = [
    { used_balance: 1, used_credits: 200, remain_balance: 9, remain_credits: 1800, credits_per_usd: 200 },
    { used_balance: 1.1, used_credits: 220, remain_balance: 8.9, remain_credits: 1780, credits_per_usd: 200 },
    { used_balance: 1.1, used_credits: 220, remain_balance: 8.9, remain_credits: 1780, credits_per_usd: 200 },
    { used_balance: 1.2, used_credits: 240, remain_balance: 8.8, remain_credits: 1760, credits_per_usd: 200 },
  ];

  await runPrivateAvatarVerification({
    apiKey: 'secret',
    sourceUrl: 'https://molimama.vip/static/source.jpg',
    sourcePath,
    sourceIdentity: `image_generation:${'a'.repeat(96)}:${'b'.repeat(96)}`,
    outputDir,
    confirmPaidCall: true,
  }, {
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
  let balance = 0;
  const balances = [
    { used_balance: 1, used_credits: 200, remain_balance: 9, remain_credits: 1800, credits_per_usd: 200 },
    { used_balance: 1.1, used_credits: 220, remain_balance: 8.9, remain_credits: 1780, credits_per_usd: 200 },
    { used_balance: 1.1, used_credits: 220, remain_balance: 8.9, remain_credits: 1780, credits_per_usd: 200 },
    { used_balance: 1.2, used_credits: 240, remain_balance: 8.8, remain_credits: 1760, credits_per_usd: 200 },
  ];
  const input = {
    apiKey: 'secret',
    sourceUrl: 'https://molimama.vip/static/source.jpg',
    sourcePath,
    sourceIdentity: 'image_generation:344',
    outputDir,
    confirmPaidCall: true,
  };
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
    now: () => new Date(),
    sleep: async () => {},
  };
  const input = {
    apiKey: 'secret', sourceUrl: 'https://molimama.vip/static/source.jpg', sourcePath,
    sourceIdentity: 'image_generation:344', outputDir, confirmPaidCall: true,
  };

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
    fetchBalance: async () => ({ used_balance: 1, used_credits: 200, remain_balance: 9, remain_credits: 1800, credits_per_usd: 200 }),
    callVideo: async () => { submits += 1; return { indeterminate: true, error: '结果未知' }; },
    now: () => new Date(),
    sleep: async () => {},
  };
  const input = {
    apiKey: 'secret', sourceUrl: 'https://molimama.vip/static/source.jpg', sourcePath,
    sourceIdentity: 'image_generation:344', outputDir, confirmPaidCall: true,
  };
  await assert.rejects(runPrivateAvatarVerification(input, deps), /结果未知/);
  await assert.rejects(runPrivateAvatarVerification(input, deps), /禁止自动重复提交/);
  assert.equal(submits, 1);
});
