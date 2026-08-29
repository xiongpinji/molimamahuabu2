'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  TOAPIS_WAN3_MODEL,
  buildToapisWan3VideoBody,
  callToapisWan3VideoApi,
  fetchToapisWan3Task,
} = require('../src/services/toapisWan3VideoClient');
const {
  acquireVerificationLock,
  calculateBalanceDelta,
  downloadAndInspect,
  parseFfprobeJson,
  safeChildProcessEnv,
} = require('./verify-toapis-video-models');

const BASE_URL = 'https://toapis.xyz';
const STATE_VERSION = 'toapis-wan3-video-verification-state-v1';
const EVIDENCE_VERSION = 'toapis-wan3-video-real-verification-v1';
const PUBLIC_ASSET_BASE_URL = 'https://molimama.vip/verification-assets/toapis';
const WAN3_CASE = Object.freeze({
  id: 'wan3-t2v-480p-2s-no-audio',
  model: TOAPIS_WAN3_MODEL,
  mode: 't2v',
  resolution: '480p',
  ratio: '16:9',
  duration: 2,
  audio: false,
});
const WAN3_PROMPT = 'A calm two-second cinematic shot of sunlight moving across an empty studio table, no text, no logos.';

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function nowDate(deps = {}) {
  const value = typeof deps.now === 'function' ? deps.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Wan 3.0 验证时间无效');
  return date;
}

function requirePositiveNumber(env, name) {
  const raw = String(env[name] || '').trim();
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须是正数`);
  return value;
}

function requireAbsoluteDirectory(raw, label) {
  const value = String(raw || '').trim();
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} 必须是已存在的绝对目录`);
  const resolved = fs.realpathSync(value);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} 必须是目录`);
  return resolved;
}

function resolveWan3VerificationPaths(env = process.env) {
  const outputDir = requireAbsoluteDirectory(env.TOAPIS_WAN3_VERIFY_OUTPUT_DIR, 'TOAPIS_WAN3_VERIFY_OUTPUT_DIR');
  const publicArtifactDir = requireAbsoluteDirectory(
    env.TOAPIS_WAN3_VERIFY_PUBLIC_ARTIFACT_DIR,
    'TOAPIS_WAN3_VERIFY_PUBLIC_ARTIFACT_DIR',
  );
  const publicAssetBaseUrl = String(env.TOAPIS_WAN3_VERIFY_PUBLIC_ASSET_BASE_URL || '').replace(/\/+$/, '');
  if (publicAssetBaseUrl !== PUBLIC_ASSET_BASE_URL) {
    throw new Error(`TOAPIS_WAN3_VERIFY_PUBLIC_ASSET_BASE_URL 必须固定为 ${PUBLIC_ASSET_BASE_URL}`);
  }
  if (outputDir === publicArtifactDir) throw new Error('Wan 3.0 私有验证状态与公共成品目录必须分离');
  return {
    outputDir,
    publicArtifactDir,
    publicAssetBaseUrl,
    statePath: path.join(outputDir, 'toapis-wan3-video-verification-state.json'),
    evidencePath: path.join(outputDir, 'toapis-wan3-video-verification.json'),
    lockPath: path.join(outputDir, '.toapis-wan3-video-verification.lock'),
  };
}

function writeJsonAtomic(filePath, payload) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, filePath);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function hasCompleteWan3Artifact(artifact) {
  const fileName = String(artifact?.output_file || '');
  return /^[A-Za-z0-9][A-Za-z0-9._~-]*\.mp4$/.test(fileName)
    && path.basename(fileName) === fileName
    && String(artifact?.public_url || '') === `${PUBLIC_ASSET_BASE_URL}/${encodeURIComponent(fileName)}`
    && /^[a-f0-9]{64}$/.test(String(artifact?.sha256 || ''));
}

function hasWan3BillingCheckpoint(billing) {
  return billing?.after && typeof billing.after === 'object'
    && Number.isFinite(Number(billing.debited_balance)) && Number(billing.debited_balance) > 0
    && Number.isFinite(Number(billing.debited_credits)) && Number(billing.debited_credits) > 0
    && Number.isFinite(Number(billing.usd_cny_rate)) && Number(billing.usd_cny_rate) > 0
    && Number.isFinite(Number(billing.cost_yuan)) && Number(billing.cost_yuan) > 0;
}

function decideWan3ResumeAction(entry) {
  if (!entry) return 'submit';
  if (entry.status === 'completed' && hasCompleteWan3Artifact(entry.artifact)) return 'complete';
  if (['submitting', 'indeterminate', 'rejected', 'failed', 'cost_cap_exceeded'].includes(entry.status)) return 'stop';
  if (String(entry.provider_task_id || '').trim() && hasCompleteWan3Artifact(entry.artifact)) return 'finalize';
  if (String(entry.provider_task_id || '').trim()) return 'poll';
  return 'stop';
}

function configFingerprint(config, apiKey) {
  return sha256(JSON.stringify({
    id: String(config.id),
    provider: 'toapis',
    model: TOAPIS_WAN3_MODEL,
    base_url: BASE_URL,
    api_key: apiKey,
  }));
}

async function fetchBalance(apiKey, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('ToAPIs 余额查询 fetch 不可用');
  const response = await fetchImpl(`${BASE_URL}/v1/balance`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) throw new Error(`ToAPIs 余额查询失败 (${response.status})`);
  const usedBalance = Number(payload.used_balance);
  const usedCredits = Number(payload.used_credits);
  if (!Number.isFinite(usedBalance) || usedBalance < 0
      || !Number.isFinite(usedCredits) || usedCredits < 0) {
    throw new Error('ToAPIs 余额响应缺少有效 used_balance/used_credits');
  }
  return {
    used_balance: usedBalance,
    used_credits: usedCredits,
    remain_balance: Number(payload.remain_balance),
    remain_credits: Number(payload.remain_credits),
    credits_per_usd: Number(payload.credits_per_usd),
    unlimited_quota: payload.unlimited_quota === true,
    captured_at: new Date().toISOString(),
  };
}

function requireBudget(env) {
  const expectedCostYuan = requirePositiveNumber(env, 'TOAPIS_WAN3_EXPECTED_COST_YUAN');
  const hardCapYuan = requirePositiveNumber(env, 'TOAPIS_WAN3_HARD_CAP_YUAN');
  const usdCnyRate = requirePositiveNumber(env, 'TOAPIS_USD_CNY_RATE');
  if (expectedCostYuan > hardCapYuan) {
    throw new Error(`Wan 3.0 预计成本 ${expectedCostYuan} 超过硬上限 ${hardCapYuan}`);
  }
  return { expectedCostYuan, hardCapYuan, usdCnyRate };
}

function assertBalanceCanCover(balance, budget) {
  const remain = Number(balance?.remain_balance);
  const expectedUsd = budget.expectedCostYuan / budget.usdCnyRate;
  if (!Number.isFinite(remain)) {
    throw new Error('ToAPIs 可用余额语义不明确，禁止 Wan 3.0 付费提交');
  }
  if (Number.isFinite(remain) && remain >= 0 && remain < expectedUsd) {
    throw new Error('ToAPIs 余额不足，禁止 Wan 3.0 付费提交');
  }
  if (remain < 0 && balance?.unlimited_quota !== true) {
    throw new Error('ToAPIs 可用余额语义不明确，禁止 Wan 3.0 付费提交');
  }
}

function safeTaskBasename(taskId) {
  const value = String(taskId || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!value) throw new Error('Wan 3.0 provider task id 无法生成安全文件名');
  return `${WAN3_CASE.id}-${value}.mp4`;
}

function publicArtifactUrl(paths, fileName) {
  return `${paths.publicAssetBaseUrl}/${encodeURIComponent(fileName)}`;
}

function runWan3Ffprobe(filePath, deps = {}) {
  if (typeof deps.runFfprobe === 'function') return deps.runFfprobe(filePath);
  const executable = process.env.FFPROBE_PATH || 'ffprobe';
  const result = spawnSync(executable, [
    '-v', 'error', '-show_entries',
    'format=format_name,duration:stream=codec_type,codec_name,width,height,duration',
    '-of', 'json', filePath,
  ], { encoding: 'utf8', windowsHide: true, env: safeChildProcessEnv(process.env) });
  if (result.error) throw new Error(`ffprobe 执行失败: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffprobe 校验失败: ${String(result.stderr || '').trim().slice(0, 300)}`);
  return parseFfprobeJson(result.stdout);
}

function inspectExistingWan3Artifact(paths, taskId, expectedArtifact, deps = {}) {
  const fileName = safeTaskBasename(taskId);
  const filePath = path.join(paths.publicArtifactDir, fileName);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Wan 3.0 本地成品必须是普通 MP4 文件');
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 1024) throw new Error('Wan 3.0 本地成品为空或过小');
  const digest = sha256(buffer);
  if (expectedArtifact?.sha256 && expectedArtifact.sha256 !== digest) {
    throw new Error('Wan 3.0 本地成品哈希与已保存状态不一致');
  }
  const ffprobe = runWan3Ffprobe(filePath, deps);
  const shortEdge = Math.min(Number(ffprobe?.width) || 0, Number(ffprobe?.height) || 0);
  if (shortEdge < 400 || shortEdge > 576) {
    throw new Error(`Wan 3.0 480p 成品尺寸不合规: ${ffprobe?.width}x${ffprobe?.height}`);
  }
  if (Math.abs(Number(ffprobe?.duration_seconds) - WAN3_CASE.duration) > 1.5) {
    throw new Error(`Wan 3.0 成品时长不合规: ${ffprobe?.duration_seconds}s`);
  }
  if (ffprobe?.has_audio !== false) throw new Error('Wan 3.0 无音频验证成品意外包含音轨');
  const publicUrl = publicArtifactUrl(paths, fileName);
  if (expectedArtifact?.public_url && expectedArtifact.public_url !== publicUrl) {
    throw new Error('Wan 3.0 本地成品 URL 与已保存状态不一致');
  }
  return {
    public_url: publicUrl,
    output_file: fileName,
    content_type: 'video/mp4',
    bytes: buffer.length,
    sha256: digest,
    ffprobe,
  };
}

function buildWan3Evidence(state) {
  if (state?.version !== STATE_VERSION || state?.case?.status !== 'completed') {
    throw new Error('Wan 3.0 验证尚未完成，不能生成证据');
  }
  const result = state.case;
  return {
    contract_version: EVIDENCE_VERSION,
    provider_origin: BASE_URL,
    generated_at: state.generated_at,
    run_id: state.run_id,
    results: [{
      id: result.id,
      model: result.model,
      mode: result.mode,
      requested_resolution: result.requested_resolution,
      requested_ratio: result.requested_ratio,
      requested_duration: result.requested_duration,
      requested_audio: result.requested_audio,
      status: result.status,
      submission_state: result.submission_state,
      provider_task_id: result.provider_task_id,
      recovery_task_id: result.recovery_task_id,
      post_count: result.post_count,
      config_id: result.config_id,
      config_fingerprint: result.config_fingerprint,
      request: result.request,
      request_sha256: result.request_sha256,
      started_at: result.started_at,
      accepted_at: result.accepted_at,
      completed_at: result.completed_at,
      artifact: result.artifact,
      billing: result.billing,
    }],
    verified_capabilities: {
      model: TOAPIS_WAN3_MODEL,
      text_to_video: true,
      resolutions: ['480p'],
      durations: [2],
      ratios: ['16:9'],
      audio_values: [false],
    },
  };
}

async function waitForTask(config, taskId, state, paths, deps = {}) {
  const maxPolls = Number(deps.maxPolls || process.env.TOAPIS_WAN3_VERIFY_MAX_POLLS || 180);
  const pollMs = Number(deps.pollMs ?? process.env.TOAPIS_WAN3_VERIFY_POLL_MS ?? 10000);
  const fetchTask = deps.fetchTask || fetchToapisWan3Task;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const result = await fetchTask(config, taskId, { fetchImpl: deps.fetchImpl, apiKey: deps.apiKey });
    state.case.provider_state = result.state;
    state.case.progress = result.progress;
    writeJsonAtomic(paths.statePath, state);
    if (result.state === 'completed') return result;
    if (result.state === 'failed') throw new Error(result.error || 'ToAPIs Wan 3.0 任务失败');
    if (attempt + 1 < maxPolls) {
      await (deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(pollMs);
    }
  }
  throw new Error('ToAPIs Wan 3.0 任务轮询超时；已知 task_id 可安全人工续查，禁止重新提交');
}

async function runWan3Verification(options = {}) {
  const env = options.env || process.env;
  const deps = options.deps || {};
  const paths = resolveWan3VerificationPaths(env);
  const releaseLock = acquireVerificationLock(paths.lockPath);
  try {
    let state = readJson(paths.statePath);
    let action = decideWan3ResumeAction(state?.case);
    if (action === 'stop') {
      throw new Error(`Wan 3.0 已存在 ${state?.case?.status || 'unknown'} 状态，禁止再次提交；请人工核对原任务`);
    }
    if (action !== 'submit') {
      const fileName = safeTaskBasename(state.case.provider_task_id);
      const filePath = path.join(paths.publicArtifactDir, fileName);
      if (fs.existsSync(filePath)) {
        state.case.artifact = inspectExistingWan3Artifact(paths, state.case.provider_task_id, state.case.artifact, deps);
        writeJsonAtomic(paths.statePath, state);
        if (action === 'complete') {
          const evidence = buildWan3Evidence(state);
          writeJsonAtomic(paths.evidencePath, evidence);
          return evidence;
        }
        action = 'finalize';
      } else if (action === 'complete' || action === 'finalize') {
        throw new Error('Wan 3.0 已保存成品不存在，禁止生成证据');
      }
    }

    const apiKey = String(env.TOAPIS_WAN3_API_KEY || '').trim();
    const configId = String(env.TOAPIS_WAN3_VERIFY_CONFIG_ID || '').trim();
    if (!apiKey) throw new Error('缺少 TOAPIS_WAN3_API_KEY');
    if (!configId) throw new Error('缺少 TOAPIS_WAN3_VERIFY_CONFIG_ID');
    const config = { id: configId, provider: 'toapis', model: TOAPIS_WAN3_MODEL, base_url: BASE_URL, api_key: apiKey };
    const budget = requireBudget(env);

    if (action === 'submit') {
      const balanceBefore = await (deps.fetchBalance || fetchBalance)(apiKey, deps.fetchImpl);
      assertBalanceCanCover(balanceBefore, budget);
      const runId = crypto.randomUUID();
      const recoveryTaskId = `wan3-verify-${runId}`;
      const requestOptions = {
        model: TOAPIS_WAN3_MODEL,
        prompt: WAN3_PROMPT,
        duration: WAN3_CASE.duration,
        resolution: WAN3_CASE.resolution,
        ratio: WAN3_CASE.ratio,
        audio: WAN3_CASE.audio,
        client_business_id: recoveryTaskId,
      };
      const request = buildToapisWan3VideoBody(requestOptions);
      state = {
        version: STATE_VERSION,
        run_id: runId,
        case: {
          id: WAN3_CASE.id,
          model: WAN3_CASE.model,
          mode: WAN3_CASE.mode,
          requested_resolution: WAN3_CASE.resolution,
          requested_ratio: WAN3_CASE.ratio,
          requested_duration: WAN3_CASE.duration,
          requested_audio: WAN3_CASE.audio,
          status: 'submitting',
          submission_state: 'submitting',
          recovery_task_id: recoveryTaskId,
          post_count: 0,
          config_id: configId,
          config_fingerprint: configFingerprint(config, apiKey),
          request,
          request_sha256: sha256(JSON.stringify(request)),
          billing: {
            expected_cost_yuan: budget.expectedCostYuan,
            hard_cap_yuan: budget.hardCapYuan,
            before: balanceBefore,
          },
          started_at: nowDate(deps).toISOString(),
        },
      };
      writeJsonAtomic(paths.statePath, state);
      state.case.post_count = 1;
      const created = await (deps.createTask || callToapisWan3VideoApi)(
        config,
        console,
        requestOptions,
        { apiKey, fetchImpl: deps.fetchImpl },
      );
      if (created?.indeterminate) {
        state.case.status = 'indeterminate';
        state.case.submission_state = 'indeterminate';
        state.case.error = created.error;
        state.case.route_meta = created.route_meta;
        writeJsonAtomic(paths.statePath, state);
        throw new Error(created.error || 'ToAPIs Wan 3.0 提交结果未知');
      }
      if (created?.error || !created?.task_id) {
        state.case.status = 'rejected';
        state.case.submission_state = 'rejected';
        state.case.error = created?.error || 'ToAPIs Wan 3.0 未返回 task_id';
        state.case.route_meta = created?.route_meta;
        writeJsonAtomic(paths.statePath, state);
        throw new Error(state.case.error);
      }
      state.case.provider_task_id = String(created.task_id);
      state.case.status = 'processing';
      state.case.submission_state = 'accepted';
      state.case.accepted_at = nowDate(deps).toISOString();
      writeJsonAtomic(paths.statePath, state);
    }

    if (action !== 'finalize') {
      const completed = await waitForTask(config, state.case.provider_task_id, state, paths, {
        ...deps,
        apiKey,
      });
      const fileName = safeTaskBasename(state.case.provider_task_id);
      state.case.artifact = await (deps.downloadAndInspect || downloadAndInspect)(
        completed.videoUrl,
        path.join(paths.publicArtifactDir, fileName),
        WAN3_CASE,
        publicArtifactUrl(paths, fileName),
        deps,
      );
      writeJsonAtomic(paths.statePath, state);
    }
    if (!hasWan3BillingCheckpoint(state.case.billing)) {
      const balanceAfter = await (deps.fetchBalance || fetchBalance)(apiKey, deps.fetchImpl);
      const delta = calculateBalanceDelta(state.case.billing.before, balanceAfter);
      state.case.billing = {
        ...state.case.billing,
        after: balanceAfter,
        ...delta,
        provider_currency: 'USD',
        usd_cny_rate: budget.usdCnyRate,
        cost_yuan: round(delta.debited_balance * budget.usdCnyRate),
      };
      writeJsonAtomic(paths.statePath, state);
    }
    const costYuan = Number(state.case.billing.cost_yuan);
    if (costYuan > budget.hardCapYuan) {
      state.case.status = 'cost_cap_exceeded';
      writeJsonAtomic(paths.statePath, state);
      throw new Error(`Wan 3.0 实际人民币成本 ${costYuan} 超过硬上限 ${budget.hardCapYuan}`);
    }
    state.case.status = 'completed';
    state.case.completed_at = nowDate(deps).toISOString();
    state.generated_at = nowDate(deps).toISOString();
    writeJsonAtomic(paths.statePath, state);
    const evidence = buildWan3Evidence(state);
    writeJsonAtomic(paths.evidencePath, evidence);
    return evidence;
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  runWan3Verification().then((evidence) => {
    process.stdout.write(`TOAPIS_WAN3_VERIFICATION_COMPLETE task_id=${evidence.results[0].provider_task_id} cost_yuan=${evidence.results[0].billing.cost_yuan}\n`);
  }).catch((error) => {
    process.stderr.write(`TOAPIS_WAN3_VERIFICATION_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EVIDENCE_VERSION,
  STATE_VERSION,
  WAN3_CASE,
  buildWan3Evidence,
  decideWan3ResumeAction,
  fetchBalance,
  resolveWan3VerificationPaths,
  runWan3Verification,
};
