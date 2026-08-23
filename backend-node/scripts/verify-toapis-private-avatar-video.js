'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const {
  createPrivateAvatarGroup,
  createPrivateAvatarAsset,
  fetchPrivateAvatarAsset,
} = require('../src/services/toapisPrivateAvatarService');
const {
  callToapisVideoApi,
  fetchToapisTask,
} = require('../src/services/toapisVideoClient');

const CONTRACT_VERSION = 'toapis-private-avatar-video-verification-v1';
const BASE_URL = 'https://toapis.com';
const LOG = { info() {}, warn() {}, error() {} };
const CASES = Object.freeze([
  Object.freeze({ id: 'fast-avatar-480-4s', model: 'seedance-2-fast' }),
  Object.freeze({ id: 'mini-avatar-480-4s', model: 'seedance-2-mini' }),
]);

function round(value, precision = 6) {
  const factor = 10 ** precision;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function nowDate(deps = {}) {
  const value = deps.now ? deps.now() : new Date();
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error('验证时间无效');
  return result;
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/(?:authorization|api[_-]?key|access[_-]?token|^token$|source_url)/i.test(key))
      .map(([key, item]) => [key, sanitize(item)]));
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/\bBearer\s+[^\s"'<>]+/gi, '[redacted]')
    .replace(/([?&](?:provider_asset_signature|token|key)=)[^&#\s]+/gi, '$1[redacted]');
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(sanitize(payload), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function acquireLock(filePath) {
  let descriptor;
  try { descriptor = fs.openSync(filePath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('已有虚拟人像验证进程，禁止并发付费提交');
    throw error;
  }
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  return () => {
    fs.closeSync(descriptor);
    fs.unlinkSync(filePath);
  };
}

function providerName(prefix, identity, sourceSha) {
  const normalizedPrefix = String(prefix || 'moli').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 16) || 'moli';
  const identityPart = String(identity || '')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'source';
  const digest = crypto.createHash('sha256')
    .update(`${identity}\n${sourceSha || ''}`)
    .digest('hex')
    .slice(0, 16);
  return `${normalizedPrefix}-${identityPart}-${digest}`.slice(0, 64);
}

function buildCaseOptions(item, assetUrl, runId) {
  if (!CASES.some((entry) => entry.id === item?.id)) throw new Error('未知虚拟人像验证用例');
  if (!/^asset:\/\/pa_[A-Za-z0-9_-]+$/.test(String(assetUrl || ''))) {
    throw new Error('虚拟人像验证缺少可信 asset URL');
  }
  return {
    model: item.model,
    prompt: 'AI generated female explorer stands naturally, takes one slow step forward and gently turns her head toward the camera, stable cinematic motion, no text.',
    resolution: '480p',
    duration: 4,
    aspect_ratio: '16:9',
    generate_audio: false,
    reference_urls: [assetUrl],
    trusted_asset_urls: [assetUrl],
    client_business_id: `moli-avatar-${item.id}-${String(runId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)}`,
  };
}

async function fetchBalance(apiKey, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${BASE_URL}/v1/balance`, {
    method: 'GET', headers: { Authorization: `Bearer ${apiKey}` },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) throw new Error(`ToAPIs 余额查询失败 (${response.status})`);
  return {
    used_balance: Number(payload.used_balance),
    used_credits: Number(payload.used_credits),
    remain_balance: Number(payload.remain_balance),
    remain_credits: Number(payload.remain_credits),
    credits_per_usd: Number(payload.credits_per_usd),
    captured_at: new Date().toISOString(),
  };
}

function billingDelta(before, after) {
  const debitedBalance = round(Number(after.used_balance) - Number(before.used_balance));
  const debitedCredits = round(Number(after.used_credits) - Number(before.used_credits));
  if (!Number.isFinite(debitedBalance) || !Number.isFinite(debitedCredits)
      || debitedBalance <= 0 || debitedCredits <= 0) {
    throw new Error('未取得与当前视频任务对应的供应商扣费差额');
  }
  return { before, after, debited_balance: debitedBalance, debited_credits: debitedCredits };
}

function safeChildEnv(env = process.env) {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'];
  return Object.fromEntries(allowed.filter((key) => env[key] != null).map((key) => [key, env[key]]));
}

function inspectVideo(filePath) {
  const result = spawnSync(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v', 'error', '-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height,duration',
    '-of', 'json', filePath,
  ], { encoding: 'utf8', windowsHide: true, env: safeChildEnv() });
  if (result.error || result.status !== 0) throw new Error(`ffprobe 校验失败: ${result.error?.message || result.stderr}`);
  const payload = JSON.parse(result.stdout);
  const video = payload.streams?.find((item) => item.codec_type === 'video');
  const duration = Number(video?.duration ?? payload.format?.duration);
  if (!video || !Number(video.width) || !Number(video.height) || !Number.isFinite(duration)) {
    throw new Error('成品缺少有效视频流');
  }
  if (Math.min(video.width, video.height) < 400 || Math.min(video.width, video.height) > 576) {
    throw new Error(`成品不属于 480P 档位: ${video.width}x${video.height}`);
  }
  if (Math.abs(duration - 4) > 1.5) throw new Error(`成品时长与 4 秒请求不符: ${duration}`);
  return {
    width: Number(video.width), height: Number(video.height), duration_seconds: round(duration),
    video_codec: String(video.codec_name || ''),
    has_audio: Boolean(payload.streams?.some((item) => item.codec_type === 'audio')),
  };
}

async function downloadArtifact(url, filePath, item, deps = {}) {
  const response = await (deps.fetchImpl || globalThis.fetch)(url, { method: 'GET' });
  if (!response.ok) throw new Error(`视频成品下载失败 (${response.status})`);
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!contentType.startsWith('video/') && contentType !== 'application/octet-stream') {
    throw new Error(`成品 MIME 不是视频: ${contentType || '(empty)'}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024) throw new Error('视频成品为空或过小');
  fs.writeFileSync(filePath, buffer, { mode: 0o444 });
  return {
    output_file: path.basename(filePath), content_type: contentType, bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    ffprobe: (deps.inspectVideo || inspectVideo)(filePath, item),
  };
}

async function ensureAvatar(state, input, context, deps) {
  if (state.avatar?.status === 'active') return state.avatar;
  state.avatar ||= {};
  const groupName = providerName('moli-avatar-group', input.sourceIdentity, state.source?.sha256);
  const assetName = providerName('moli-avatar-asset', input.sourceIdentity, state.source?.sha256);
  if (!state.avatar.group_id) {
    if (['submitting', 'indeterminate'].includes(state.avatar.group_submission_state)) {
      throw new Error('虚拟人像素材组提交结果未知，禁止自动重复提交');
    }
    state.avatar.group_submission_state = 'submitting';
    delete state.avatar.group_error;
    context.save();
    try {
      const group = await deps.createGroup(context.config, {
        name: groupName,
        description: '茉莉妈妈 AI 生成人物真实验证',
      }, { fetchImpl: deps.fetchImpl });
      state.avatar.group_id = group.group_id;
      state.avatar.group_submission_state = 'accepted';
      context.save();
    } catch (error) {
      if (error?.code === 'TOAPIS_AVATAR_REJECTED') {
        state.avatar.group_submission_state = 'rejected';
        state.avatar.group_error = error.message;
      } else {
        state.avatar.group_submission_state = 'indeterminate';
        state.avatar.group_error = error.message;
      }
      context.save();
      throw error;
    }
  }
  if (!state.avatar.asset_id) {
    if (['submitting', 'indeterminate'].includes(state.avatar.asset_submission_state)) {
      throw new Error('虚拟人像素材提交结果未知，禁止自动重复提交');
    }
    state.avatar.asset_submission_state = 'submitting';
    delete state.avatar.asset_error;
    context.save();
    try {
      const asset = await deps.createAsset(context.config, {
        group_id: state.avatar.group_id, asset_type: 'image', source_url: input.sourceUrl,
        name: assetName,
      }, { fetchImpl: deps.fetchImpl });
      Object.assign(state.avatar, asset, { asset_submission_state: 'accepted' });
      context.save();
    } catch (error) {
      if (error?.code === 'TOAPIS_AVATAR_REJECTED') {
        state.avatar.asset_submission_state = 'rejected';
        state.avatar.asset_error = error.message;
      } else {
        state.avatar.asset_submission_state = 'indeterminate';
        state.avatar.asset_error = error.message;
      }
      context.save();
      throw error;
    }
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (state.avatar.status === 'active') return state.avatar;
    if (attempt > 0) await deps.sleep(5000);
    const asset = await deps.fetchAsset(context.config, state.avatar.asset_id, { fetchImpl: deps.fetchImpl });
    Object.assign(state.avatar, asset);
    context.save();
    if (asset.status === 'failed') throw new Error('ToAPIs 虚拟人像素材处理失败');
  }
  throw new Error('ToAPIs 虚拟人像素材等待 active 超时');
}

async function processCase(item, state, context, deps) {
  let entry = state.cases[item.id];
  if (entry?.status === 'completed') return entry;
  if (!entry) {
    entry = { id: item.id, model: item.model, resolution: '480p', duration: 4 };
    state.cases[item.id] = entry;
  }
  if (!entry.provider_task_id) {
    if (['submitting', 'indeterminate'].includes(entry.submission_state)) {
      throw new Error(`${item.id} 提交结果未知，禁止自动重复提交`);
    }
    entry.billing = { before: await deps.fetchBalance(inputApiKey(context), deps.fetchImpl) };
    entry.started_at = nowDate(deps).toISOString();
    entry.submission_state = 'submitting';
    context.save();
    const submittedAt = nowDate(deps);
    const result = await deps.callVideo(
      context.config, LOG, buildCaseOptions(item, state.avatar.asset_url, state.audit_run_id),
      { fetchImpl: deps.fetchImpl },
    );
    if (result.indeterminate) {
      entry.submission_state = 'indeterminate';
      entry.error = result.error;
      context.save();
      throw new Error(result.error);
    }
    if (result.error || !result.task_id) {
      entry.submission_state = 'rejected';
      entry.error = result.error || 'ToAPIs 未返回 task_id';
      context.save();
      throw new Error(entry.error);
    }
    entry.provider_task_id = result.task_id;
    entry.submitted_at = submittedAt.toISOString();
    entry.submission_state = 'accepted';
    entry.speed = {
      submit_latency_ms: Math.max(0, submittedAt.getTime() - Date.parse(entry.started_at)),
    };
    context.save();
  }
  let completed;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (attempt > 0) await deps.sleep(5000);
    const status = await deps.fetchTask(context.config, entry.provider_task_id, { fetchImpl: deps.fetchImpl });
    if (status.state === 'failed') throw new Error(status.error || `${item.id} 生成失败`);
    if (status.state === 'completed' && status.videoUrl) { completed = status; break; }
  }
  if (!completed) throw new Error(`${item.id} 等待视频完成超时`);
  const completedAt = nowDate(deps);
  const artifactPath = path.join(context.outputDir, `${item.id}.mp4`);
  entry.artifact = await deps.downloadArtifact(completed.videoUrl, artifactPath, item, deps);
  entry.completed_at = completedAt.toISOString();
  entry.speed.generation_elapsed_seconds = round((completedAt.getTime() - Date.parse(entry.submitted_at)) / 1000, 3);
  entry.billing = billingDelta(entry.billing.before, await deps.fetchBalance(inputApiKey(context), deps.fetchImpl));
  entry.status = 'completed';
  delete entry.error;
  context.save();
  return entry;
}

function inputApiKey(context) {
  return context.config.api_key;
}

async function runPrivateAvatarVerification(input = {}, injected = {}) {
  if (input.confirmPaidCall !== true) throw new Error('必须显式确认真实付费调用');
  if (!String(input.apiKey || '').trim()) throw new Error('缺少 ToAPIs API Key');
  if (!String(input.sourceUrl || '').startsWith('https://')) throw new Error('缺少已签名的公网 AI 图片 URL');
  if (!path.isAbsolute(String(input.sourcePath || '')) || !fs.existsSync(input.sourcePath)) throw new Error('缺少本地 AI 图片原件');
  if (!String(input.sourceIdentity || '').trim()) throw new Error('缺少平台 AI 图片来源标识');
  if (!path.isAbsolute(String(input.outputDir || ''))) throw new Error('验证输出目录必须为绝对路径');
  fs.mkdirSync(input.outputDir, { recursive: true });
  const statePath = path.join(input.outputDir, 'toapis-private-avatar-verification-state.json');
  const evidencePath = path.join(input.outputDir, 'toapis-private-avatar-verification.json');
  const release = acquireLock(path.join(input.outputDir, '.toapis-private-avatar-verification.lock'));
  const deps = {
    createGroup: createPrivateAvatarGroup,
    createAsset: createPrivateAvatarAsset,
    fetchAsset: fetchPrivateAvatarAsset,
    callVideo: callToapisVideoApi,
    fetchTask: fetchToapisTask,
    fetchBalance,
    downloadArtifact,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...injected,
  };
  try {
    const sourceBuffer = fs.readFileSync(input.sourcePath);
    const source = {
      identity: input.sourceIdentity,
      file_name: path.basename(input.sourcePath),
      bytes: sourceBuffer.length,
      sha256: crypto.createHash('sha256').update(sourceBuffer).digest('hex'),
    };
    const state = readJson(statePath, {
      contract_version: CONTRACT_VERSION,
      audit_run_id: crypto.randomUUID(),
      source,
      avatar: {},
      cases: {},
    });
    if (JSON.stringify(state.source) !== JSON.stringify(source)) throw new Error('验证来源已变化，禁止复用旧状态');
    const context = {
      config: { base_url: BASE_URL, api_key: String(input.apiKey).trim() },
      outputDir: path.resolve(input.outputDir),
      save: () => writeJsonAtomic(statePath, state),
    };
    await ensureAvatar(state, input, context, deps);
    const results = [];
    for (const item of CASES) results.push(await processCase(item, state, context, deps));
    const evidence = {
      contract_version: CONTRACT_VERSION,
      generated_at: nowDate(deps).toISOString(),
      audit_run_id: state.audit_run_id,
      source: state.source,
      avatar: {
        group_id: state.avatar.group_id,
        asset_id: state.avatar.asset_id,
        asset_url: state.avatar.asset_url,
        status: state.avatar.status,
      },
      cases: results,
      summary: {
        case_count: results.length,
        total_debited_balance: round(results.reduce((sum, item) => sum + item.billing.debited_balance, 0)),
        total_debited_credits: round(results.reduce((sum, item) => sum + item.billing.debited_credits, 0)),
      },
    };
    writeJsonAtomic(evidencePath, evidence);
    return evidence;
  } finally {
    release();
  }
}

function cliInput(argv = process.argv, env = process.env) {
  if (argv.some((value) => /(?:api[-_]?key|token)=/i.test(value))) throw new Error('禁止通过命令行参数传入供应商 Key');
  return {
    apiKey: String(env.TOAPIS_API_KEY || '').trim(),
    sourceUrl: String(env.TOAPIS_AVATAR_VERIFY_SOURCE_URL || '').trim(),
    sourcePath: String(env.TOAPIS_AVATAR_VERIFY_SOURCE_PATH || '').trim(),
    sourceIdentity: String(env.TOAPIS_AVATAR_VERIFY_SOURCE_IDENTITY || '').trim(),
    outputDir: String(env.TOAPIS_AVATAR_VERIFY_OUTPUT_DIR || '').trim(),
    confirmPaidCall: argv.includes('--confirm-paid-call'),
  };
}

if (require.main === module) {
  runPrivateAvatarVerification(cliInput()).then((evidence) => {
    for (const item of evidence.cases) {
      process.stdout.write(`VERIFIED ${item.id} task=${item.provider_task_id} speed=${item.speed.generation_elapsed_seconds}s sha256=${item.artifact.sha256}\n`);
    }
    process.stdout.write(`TOAPIS_PRIVATE_AVATAR_VERIFIED 2/2 credits=${evidence.summary.total_debited_credits}\n`);
  }).catch((error) => {
    process.stderr.write(`TOAPIS_PRIVATE_AVATAR_VERIFICATION_FAILED: ${sanitize(error.message)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CASES,
  buildCaseOptions,
  runPrivateAvatarVerification,
};
