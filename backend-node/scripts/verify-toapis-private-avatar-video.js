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
const {
  requireVerificationConfigIds,
  validateVerificationConfigs,
} = require('./verify-toapis-video-models');

const CONTRACT_VERSION = 'toapis-private-avatar-video-verification-v1';
const BASE_URL = 'https://toapis.xyz';
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

function normalizeCostBudget(input, state) {
  const expectedCosts = input.expectedCostsYuan;
  const caseHardCaps = input.caseHardCapsYuan;
  const aggregateHardCapYuan = Number(input.aggregateHardCapYuan);
  const usdCnyRate = Number(input.usdCnyRate);
  if (!expectedCosts || Array.isArray(expectedCosts) || typeof expectedCosts !== 'object') {
    throw new Error('缺少私人形象验证预计人民币成本');
  }
  if (!caseHardCaps || Array.isArray(caseHardCaps) || typeof caseHardCaps !== 'object') {
    throw new Error('缺少私人形象验证人民币单例硬上限');
  }
  if (!Number.isFinite(aggregateHardCapYuan) || aggregateHardCapYuan <= 0) {
    throw new Error('缺少私人形象验证人民币总成本硬上限');
  }
  if (!Number.isFinite(usdCnyRate) || usdCnyRate <= 0) {
    throw new Error('缺少 USD/CNY 汇率，无法执行人民币成本硬上限');
  }
  const normalizedExpected = {};
  const normalizedCaseCaps = {};
  for (const item of CASES) {
    const expected = Number(expectedCosts[item.id]);
    const hardCap = Number(caseHardCaps[item.id]);
    if (!Number.isFinite(expected) || expected <= 0) throw new Error(`缺少 ${item.id} 的预计人民币成本`);
    if (!Number.isFinite(hardCap) || hardCap <= 0) throw new Error(`缺少 ${item.id} 的人民币单例硬上限`);
    if (expected > hardCap) throw new Error(`${item.id} 预计人民币成本 ${expected} 超过单例硬上限 ${hardCap}`);
    const entry = state?.cases?.[item.id];
    if (entry?.status === 'completed') {
      const resumedExpected = Number(entry.billing?.expected_cost_yuan);
      const resumedActual = Number(entry.billing?.cost_yuan);
      if (!Number.isFinite(resumedExpected) || resumedExpected <= 0) throw new Error(`${item.id} 缺少人民币预计成本`);
      if (!Number.isFinite(resumedActual) || resumedActual <= 0) throw new Error(`${item.id} 缺少人民币实际成本`);
      if (resumedExpected > hardCap) throw new Error(`${item.id} 预计人民币成本 ${resumedExpected} 超过单例硬上限 ${hardCap}`);
      if (resumedActual > hardCap) throw new Error(`${item.id} 实际人民币成本 ${resumedActual} 超过单例硬上限 ${hardCap}`);
    }
    normalizedExpected[item.id] = expected;
    normalizedCaseCaps[item.id] = hardCap;
  }
  const completedActual = CASES.reduce((sum, item) => {
    const value = Number(state?.cases?.[item.id]?.billing?.cost_yuan);
    return sum + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
  const remainingExpected = CASES.reduce((sum, item) => (
    state?.cases?.[item.id]?.status === 'completed' ? sum : sum + normalizedExpected[item.id]
  ), 0);
  const projected = round(completedActual + remainingExpected);
  if (projected > aggregateHardCapYuan) {
    throw new Error(`预计人民币总成本 ${projected} 超过硬上限 ${aggregateHardCapYuan}`);
  }
  return {
    expectedCosts: normalizedExpected,
    caseHardCaps: normalizedCaseCaps,
    aggregateHardCapYuan,
    usdCnyRate,
  };
}

function configFingerprints(configSnapshots) {
  const result = Object.fromEntries(configSnapshots.map((item) => [item.model, String(item.fingerprint || '')]));
  for (const item of CASES) {
    if (!/^[a-f0-9]{64}$/i.test(result[item.model] || '')) throw new Error(`缺少 ${item.model} 验证配置指纹`);
  }
  return result;
}

function bindAndValidateState(state, configSnapshots) {
  const fingerprints = configFingerprints(configSnapshots);
  const cases = state?.cases && typeof state.cases === 'object' ? state.cases : null;
  if (!cases) throw new Error('私人形象验证状态文件不兼容');
  const hasMaterialState = Object.keys(cases).length > 0
    || Boolean(state.avatar?.group_id || state.avatar?.asset_id
      || state.avatar?.group_submission_state || state.avatar?.asset_submission_state);
  const hasBinding = Boolean(state.provider_origin || state.config_fingerprints);
  if (!hasMaterialState && !hasBinding) {
    state.provider_origin = BASE_URL;
    state.config_fingerprints = { ...fingerprints };
  }
  if (state.provider_origin !== BASE_URL) throw new Error('私人形象验证状态未绑定 ToAPIs 官方入口');
  for (const item of CASES) {
    if (state.config_fingerprints?.[item.model] !== fingerprints[item.model]) {
      throw new Error(`${item.model} 私人形象验证状态配置指纹不匹配，禁止复用旧状态`);
    }
  }
  for (const [caseId, entry] of Object.entries(cases)) {
    const expected = CASES.find((item) => item.id === caseId);
    if (!expected || entry?.model !== expected.model
        || entry?.provider_origin !== BASE_URL
        || entry?.config_fingerprint !== fingerprints[expected.model]) {
      throw new Error(`${caseId} 私人形象验证状态配置指纹不匹配`);
    }
  }
  return fingerprints;
}

function verificationClientForModel(context, model) {
  const client = context.verificationClients?.[model];
  if (!client || !String(client.apiKey || '').trim()
      || client.config?.api_key !== client.apiKey
      || client.config?.base_url !== BASE_URL) {
    throw new Error(`${model} 缺少数据库配置绑定的独立验证凭据`);
  }
  return client;
}

function assertNoUnknownSubmission(state) {
  if (['submitting', 'indeterminate'].includes(state.avatar?.group_submission_state)) {
    throw new Error('虚拟人像素材组提交结果未知，禁止自动重复提交');
  }
  if (['submitting', 'indeterminate'].includes(state.avatar?.asset_submission_state)) {
    throw new Error('虚拟人像素材提交结果未知，禁止自动重复提交');
  }
  const blocked = Object.entries(state.cases || {}).find(([, entry]) => (
    ['submitting', 'indeterminate'].includes(entry?.submission_state)
  ));
  if (blocked) throw new Error(`${blocked[0]} 提交结果未知，禁止自动重复提交`);
  const capped = Object.entries(state.cases || {}).find(([, entry]) => entry?.status === 'cost_cap_exceeded');
  if (capped) throw new Error(`${capped[0]} 已触发人民币成本硬上限，禁止继续供应商调用`);
}

function assertActualCostWithinBudget(item, context) {
  const entry = context.state.cases[item.id];
  const expected = Number(entry?.billing?.expected_cost_yuan);
  const actual = Number(entry?.billing?.cost_yuan);
  const caseCap = context.costBudget.caseHardCaps[item.id];
  if (!Number.isFinite(expected) || expected <= 0) throw new Error(`${item.id} 缺少人民币预计成本`);
  if (!Number.isFinite(actual) || actual <= 0) throw new Error(`${item.id} 缺少人民币实际成本`);
  if (expected > caseCap) throw new Error(`${item.id} 预计人民币成本 ${expected} 超过单例硬上限 ${caseCap}`);
  if (actual > caseCap) throw new Error(`${item.id} 实际人民币成本 ${actual} 超过单例硬上限 ${caseCap}`);
  const actualTotal = CASES.reduce((sum, candidate) => {
    const value = Number(context.state.cases[candidate.id]?.billing?.cost_yuan);
    return sum + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
  const remainingExpected = CASES.reduce((sum, candidate) => (
    context.state.cases[candidate.id]?.status === 'completed' || candidate.id === item.id
      ? sum
      : sum + context.costBudget.expectedCosts[candidate.id]
  ), 0);
  const projected = round(actualTotal + remainingExpected);
  if (projected > context.costBudget.aggregateHardCapYuan) {
    throw new Error(`按实际扣费重算的人民币总成本 ${projected} 超过硬上限 ${context.costBudget.aggregateHardCapYuan}`);
  }
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
  const client = verificationClientForModel(context, 'seedance-2-fast');
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
      const group = await deps.createGroup(client.config, {
        name: groupName,
        description: '茉莉妈妈 AI 生成人物真实验证',
      }, { fetchImpl: deps.fetchImpl, apiKey: client.apiKey });
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
      const asset = await deps.createAsset(client.config, {
        group_id: state.avatar.group_id, asset_type: 'image', source_url: input.sourceUrl,
        name: assetName,
      }, { fetchImpl: deps.fetchImpl, apiKey: client.apiKey });
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
    const asset = await deps.fetchAsset(client.config, state.avatar.asset_id, {
      fetchImpl: deps.fetchImpl,
      apiKey: client.apiKey,
    });
    Object.assign(state.avatar, asset);
    context.save();
    if (asset.status === 'failed') throw new Error('ToAPIs 虚拟人像素材处理失败');
  }
  throw new Error('ToAPIs 虚拟人像素材等待 active 超时');
}

async function processCase(item, state, context, deps) {
  let entry = state.cases[item.id];
  if (entry?.status === 'completed') {
    assertActualCostWithinBudget(item, context);
    entry.billing.case_hard_cap_yuan = context.costBudget.caseHardCaps[item.id];
    context.save();
    return entry;
  }
  const client = verificationClientForModel(context, item.model);
  if (!entry) {
    entry = {
      id: item.id,
      model: item.model,
      resolution: '480p',
      duration: 4,
      provider_origin: BASE_URL,
      config_fingerprint: context.configFingerprints[item.model],
    };
    state.cases[item.id] = entry;
  }
  if (!entry.provider_task_id) {
    if (['submitting', 'indeterminate'].includes(entry.submission_state)) {
      throw new Error(`${item.id} 提交结果未知，禁止自动重复提交`);
    }
    entry.billing = {
      expected_cost_yuan: context.costBudget.expectedCosts[item.id],
      case_hard_cap_yuan: context.costBudget.caseHardCaps[item.id],
      before: await deps.fetchBalance(client.apiKey, deps.fetchImpl),
    };
    entry.started_at = nowDate(deps).toISOString();
    entry.submission_state = 'submitting';
    context.save();
    const submittedAt = nowDate(deps);
    const result = await deps.callVideo(
      client.config, LOG, buildCaseOptions(item, state.avatar.asset_url, state.audit_run_id),
      { fetchImpl: deps.fetchImpl, apiKey: client.apiKey },
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
    const status = await deps.fetchTask(client.config, entry.provider_task_id, {
      fetchImpl: deps.fetchImpl,
      apiKey: client.apiKey,
    });
    if (status.state === 'failed') throw new Error(status.error || `${item.id} 生成失败`);
    if (status.state === 'completed' && status.videoUrl) { completed = status; break; }
  }
  if (!completed) throw new Error(`${item.id} 等待视频完成超时`);
  const completedAt = nowDate(deps);
  const artifactPath = path.join(context.outputDir, `${item.id}.mp4`);
  entry.artifact = await deps.downloadArtifact(completed.videoUrl, artifactPath, item, deps);
  entry.completed_at = completedAt.toISOString();
  entry.speed.generation_elapsed_seconds = round((completedAt.getTime() - Date.parse(entry.submitted_at)) / 1000, 3);
  entry.billing = {
    ...entry.billing,
    ...billingDelta(entry.billing.before, await deps.fetchBalance(client.apiKey, deps.fetchImpl)),
  };
  entry.billing.provider_currency = 'USD';
  entry.billing.usd_cny_rate = context.costBudget.usdCnyRate;
  entry.billing.cost_yuan = round(entry.billing.debited_balance * context.costBudget.usdCnyRate);
  try {
    assertActualCostWithinBudget(item, context);
  } catch (error) {
    entry.status = 'cost_cap_exceeded';
    context.save();
    throw error;
  }
  entry.status = 'completed';
  delete entry.error;
  context.save();
  return entry;
}

async function runPrivateAvatarVerification(input = {}, injected = {}) {
  if (input.confirmPaidCall !== true) throw new Error('必须显式确认真实付费调用');
  if (String(input.apiKey || '').trim()) throw new Error('私人形象验证禁止使用全局 API Key，必须绑定 FAST/MINI 独立数据库配置');
  const executionEnv = input.env || process.env;
  if (String(executionEnv.TOAPIS_API_KEY || '').trim()) {
    throw new Error('私人形象验证禁止使用全局 TOAPIS_API_KEY，必须绑定 FAST/MINI 独立数据库配置');
  }
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
    const requestedConfigIds = input.configIds;
    const configIds = requestedConfigIds
      ? requireVerificationConfigIds({
        TOAPIS_VERIFY_FAST_CONFIG_ID: requestedConfigIds['seedance-2-fast'],
        TOAPIS_VERIFY_MINI_CONFIG_ID: requestedConfigIds['seedance-2-mini'],
      })
      : requireVerificationConfigIds(executionEnv);
    const configSnapshots = (injected.validateConfigs || validateVerificationConfigs)({
      configIds,
      databasePath: input.databasePath,
    });
    const verificationClients = Object.fromEntries(configSnapshots.map(({ model, apiKey }) => [model, {
      apiKey,
      config: { base_url: BASE_URL, api_key: apiKey },
    }]));
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
    const fingerprints = bindAndValidateState(state, configSnapshots);
    assertNoUnknownSubmission(state);
    const costBudget = normalizeCostBudget(input, state);
    const context = {
      verificationClients,
      configFingerprints: fingerprints,
      costBudget,
      state,
      outputDir: path.resolve(input.outputDir),
      save: () => writeJsonAtomic(statePath, state),
    };
    context.save();
    for (const item of CASES) {
      const client = verificationClientForModel(context, item.model);
      await deps.fetchBalance(client.apiKey, deps.fetchImpl);
    }
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
        total_cost_yuan: round(results.reduce((sum, item) => sum + item.billing.cost_yuan, 0)),
        aggregate_hard_cap_yuan: costBudget.aggregateHardCapYuan,
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
  const parseObject = (name) => {
    const raw = String(env[name] || '').trim();
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
      return value;
    } catch (_) {
      throw new Error(`${name} 必须是 JSON 对象`);
    }
  };
  return {
    configIds: {
      'seedance-2-fast': Number(env.TOAPIS_VERIFY_FAST_CONFIG_ID),
      'seedance-2-mini': Number(env.TOAPIS_VERIFY_MINI_CONFIG_ID),
    },
    databasePath: String(env.TOAPIS_VERIFY_DATABASE_PATH || env.DATABASE_PATH || '').trim(),
    sourceUrl: String(env.TOAPIS_AVATAR_VERIFY_SOURCE_URL || '').trim(),
    sourcePath: String(env.TOAPIS_AVATAR_VERIFY_SOURCE_PATH || '').trim(),
    sourceIdentity: String(env.TOAPIS_AVATAR_VERIFY_SOURCE_IDENTITY || '').trim(),
    outputDir: String(env.TOAPIS_AVATAR_VERIFY_OUTPUT_DIR || '').trim(),
    expectedCostsYuan: parseObject('TOAPIS_EXPECTED_COST_YUAN_JSON'),
    caseHardCapsYuan: parseObject('TOAPIS_VERIFY_CASE_HARD_CAP_YUAN_JSON'),
    aggregateHardCapYuan: Number(env.TOAPIS_VERIFY_AGGREGATE_HARD_CAP_YUAN),
    usdCnyRate: Number(env.TOAPIS_USD_CNY_RATE),
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
