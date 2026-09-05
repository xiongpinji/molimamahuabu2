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

const BASE_URL = 'https://toapis.cn';
const STATE_VERSION = 'toapis-wan3-video-verification-state-v1';
const EVIDENCE_VERSION = 'toapis-wan3-video-real-verification-v1';
const PUBLIC_ASSET_BASE_URL = 'https://molimama.vip/verification-assets/toapis';
const IMPORT_SMOKE_VERSION = 'toapis-wan3-unlimited-smoke-v1';
const IMPORT_MANIFEST_VERSION = 'external-model-release-evidence-manifest-v1';
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

function requireAbsoluteFile(raw, label) {
  const value = String(raw || '').trim();
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} 必须是已存在的绝对文件路径`);
  const stat = fs.lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} 必须是普通文件`);
  return fs.realpathSync(value);
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

function writeBytesExclusive(filePath, bytes, mode = 0o644) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
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
    provider: 'toapis_wan3',
    model: TOAPIS_WAN3_MODEL,
    base_url: BASE_URL,
    api_key: apiKey,
  }));
}

function credentialFingerprint(apiKey) {
  return sha256(apiKey);
}

function requireConfigId(raw, label) {
  const value = String(raw || '').trim();
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label} 必须是正整数`);
  }
  return Number(value);
}

function requireTimestamp(value, label) {
  const raw = String(value || '').trim();
  const timestamp = Date.parse(raw);
  if (!raw || !Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== raw) {
    throw new Error(`${label} 必须是规范 UTC 时间`);
  }
  return timestamp;
}

function sameNumber(left, right) {
  return Number.isFinite(Number(left)) && Number.isFinite(Number(right))
    && Number(left) === Number(right);
}

function inspectWan3ImportArtifact(artifactPath, smoke, deps = {}) {
  const bytes = fs.readFileSync(artifactPath);
  if (bytes.length < 1024) throw new Error('Wan 3.0 导入成品为空或过小');
  const digest = sha256(bytes);
  if (Number(smoke?.artifact?.bytes) !== bytes.length) throw new Error('Wan 3.0 导入成品字节数与 smoke 记录不一致');
  if (String(smoke?.artifact?.sha256 || '') !== digest) throw new Error('Wan 3.0 导入成品哈希与 smoke 记录不一致');
  if (smoke?.artifact?.content_type !== 'video/mp4') throw new Error('Wan 3.0 导入成品必须是 video/mp4');
  const recordedPath = requireAbsoluteFile(smoke?.artifact?.local_path, 'smoke artifact.local_path');
  if (recordedPath !== artifactPath) throw new Error('Wan 3.0 导入成品路径与 smoke 记录不一致');

  const probe = runWan3Ffprobe(artifactPath, deps);
  const width = Number(probe?.width);
  const height = Number(probe?.height);
  const duration = Number(probe?.duration_seconds);
  const ratio = width / height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || height < 440 || height > 520
      || ratio < 1.7 || ratio > 1.85) {
    throw new Error(`Wan 3.0 导入成品不是已验证的 480p 16:9: ${width}x${height}`);
  }
  if (!Number.isFinite(duration) || duration < 1.5 || duration > 3.5) {
    throw new Error(`Wan 3.0 导入成品时长不符合约 2 秒合同: ${duration}s`);
  }
  if (!String(probe?.video_codec || '').trim()) throw new Error('Wan 3.0 导入成品缺少视频轨');
  if (probe?.has_audio !== false || (probe?.audio_codec != null && String(probe.audio_codec).trim())) {
    throw new Error('Wan 3.0 导入的无音频成品意外包含音频轨');
  }
  const recordedProbe = smoke?.artifact?.ffprobe || {};
  if (!sameNumber(recordedProbe.width, width)
      || !sameNumber(recordedProbe.height, height)
      || !sameNumber(recordedProbe.duration_seconds, duration)
      || String(recordedProbe.video_codec || '') !== String(probe.video_codec || '')
      || recordedProbe.has_audio !== false
      || (recordedProbe.audio_codec != null && String(recordedProbe.audio_codec).trim())) {
    throw new Error('Wan 3.0 导入成品 ffprobe 与 smoke 记录不一致');
  }
  return { bytes, sha256: digest, ffprobe: probe };
}

function requireUnlimitedSmokeBilling(smoke) {
  const account = smoke?.account || {};
  const before = account.before || {};
  const after = account.after || {};
  if (before.unlimited_quota !== true || after.unlimited_quota !== true) {
    throw new Error('Wan 3.0 smoke unlimited_quota 前后必须均为 true');
  }
  if (before.remain_balance !== -1 || after.remain_balance !== -1) {
    throw new Error('Wan 3.0 smoke remain_balance 前后必须均为 -1');
  }
  if (account.after_error !== null || account.billing_binding !== 'positive_usage_delta_observed') {
    throw new Error('Wan 3.0 smoke 缺少完整的正向用量差绑定');
  }
  const debitedBalanceRaw = Number(after.used_balance) - Number(before.used_balance);
  const debitedCreditsRaw = Number(after.used_credits) - Number(before.used_credits);
  if (!Number.isFinite(debitedBalanceRaw) || debitedBalanceRaw <= 0
      || !Number.isFinite(debitedCreditsRaw) || debitedCreditsRaw <= 0
      || Number(account?.delta?.used_balance) !== debitedBalanceRaw
      || Number(account?.delta?.used_credits) !== debitedCreditsRaw) {
    throw new Error('Wan 3.0 smoke 正向用量差不精确');
  }
  return {
    before,
    after,
    debitedBalance: round(debitedBalanceRaw),
    debitedCredits: round(debitedCreditsRaw),
  };
}

function validateWan3Smoke(smoke, targetConfigId, artifactPath, generatedAt, deps = {}) {
  if (smoke?.contract_version !== IMPORT_SMOKE_VERSION
      || smoke.evidence_scope !== 'provider_availability_smoke_only'
      || smoke.production_billing_evidence !== false
      || smoke.production_activation_authorized !== false) {
    throw new Error('Wan 3.0 导入源不是未升级的私有 smoke 合同');
  }
  const sourceConfigId = requireConfigId(smoke.config_id, 'Wan 3.0 smoke source config id');
  if (sourceConfigId === targetConfigId) {
    throw new Error('Wan 3.0 正式目标配置必须独立于 smoke 来源配置');
  }
  const requestSummary = smoke.request || {};
  for (const [key, value] of Object.entries({
    model: WAN3_CASE.model,
    mode: WAN3_CASE.mode,
    duration: WAN3_CASE.duration,
    resolution: WAN3_CASE.resolution,
    ratio: WAN3_CASE.ratio,
    audio: WAN3_CASE.audio,
    reference_count: 0,
  })) {
    if (requestSummary[key] !== value) throw new Error(`Wan 3.0 smoke request.${key} 不符合已实测合同`);
  }
  const submission = smoke.submission || {};
  const recoveryTaskId = String(submission.client_business_id || '');
  if (!/^molimama-wan3-smoke-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(recoveryTaskId)) {
    throw new Error('Wan 3.0 smoke client_business_id 无效');
  }
  const providerTaskId = String(submission.provider_task_id || '').trim();
  if (!providerTaskId || Number(submission.post_count) !== 1) {
    throw new Error('Wan 3.0 smoke 必须绑定且仅绑定一次已受理 POST');
  }
  const expectedSmokeFile = `wan3-480p-2s-silent-${String(providerTaskId).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}.mp4`;
  if (smoke?.artifact?.output_file !== expectedSmokeFile) throw new Error('Wan 3.0 smoke 任务与成品文件名绑定无效');

  const beforeAt = requireTimestamp(smoke?.account?.before?.captured_at, 'Wan 3.0 smoke balance before');
  const startedAt = requireTimestamp(submission.submitted_at, 'Wan 3.0 smoke submitted_at');
  const acceptedAt = requireTimestamp(submission.accepted_at, 'Wan 3.0 smoke accepted_at');
  const afterAt = requireTimestamp(smoke?.account?.after?.captured_at, 'Wan 3.0 smoke balance after');
  const smokeCompletedAt = requireTimestamp(smoke.completed_at, 'Wan 3.0 smoke completed_at');
  const generatedAtMs = requireTimestamp(generatedAt, 'Wan 3.0 import generated_at');
  if (beforeAt > startedAt || startedAt >= acceptedAt || acceptedAt >= afterAt
      || afterAt > smokeCompletedAt || smokeCompletedAt > generatedAtMs) {
    throw new Error('Wan 3.0 smoke 时间线无效');
  }
  const billing = requireUnlimitedSmokeBilling(smoke);
  const artifact = inspectWan3ImportArtifact(artifactPath, smoke, deps);
  return {
    sourceConfigId,
    submission,
    recoveryTaskId,
    providerTaskId,
    startedAt: submission.submitted_at,
    acceptedAt: submission.accepted_at,
    completedAt: smoke.account.after.captured_at,
    billing,
    artifact,
  };
}

async function runWan3SmokeImport(options = {}) {
  const env = options.env || process.env;
  const deps = options.deps || {};
  const apiKey = String(env.TOAPIS_WAN3_API_KEY || '').trim();
  const targetConfigId = requireConfigId(env.TOAPIS_WAN3_TARGET_CONFIG_ID, 'TOAPIS_WAN3_TARGET_CONFIG_ID');
  if (!apiKey) throw new Error('缺少 TOAPIS_WAN3_API_KEY');
  const usdCnyRate = requirePositiveNumber(env, 'TOAPIS_USD_CNY_RATE');
  const smokeResultPath = requireAbsoluteFile(
    env.TOAPIS_WAN3_IMPORT_SMOKE_RESULT_PATH,
    'TOAPIS_WAN3_IMPORT_SMOKE_RESULT_PATH',
  );
  const artifactPath = requireAbsoluteFile(
    env.TOAPIS_WAN3_IMPORT_ARTIFACT_PATH,
    'TOAPIS_WAN3_IMPORT_ARTIFACT_PATH',
  );
  const outputDir = requireAbsoluteDirectory(env.TOAPIS_WAN3_IMPORT_OUTPUT_DIR, 'TOAPIS_WAN3_IMPORT_OUTPUT_DIR');
  if (fs.readdirSync(outputDir).length !== 0) throw new Error('TOAPIS_WAN3_IMPORT_OUTPUT_DIR 必须为空目录');
  const smoke = JSON.parse(fs.readFileSync(smokeResultPath, 'utf8'));
  const generatedAt = nowDate(deps).toISOString();
  const checked = validateWan3Smoke(smoke, targetConfigId, artifactPath, generatedAt, deps);
  const request = buildToapisWan3VideoBody({
    model: WAN3_CASE.model,
    prompt: WAN3_PROMPT,
    duration: WAN3_CASE.duration,
    resolution: WAN3_CASE.resolution,
    ratio: WAN3_CASE.ratio,
    audio: WAN3_CASE.audio,
    client_business_id: checked.recoveryTaskId,
  });
  const outputFile = safeTaskBasename(checked.providerTaskId);
  const publicArtifactDir = path.join(outputDir, 'public', 'toapis');
  const publicArtifactPath = path.join(publicArtifactDir, outputFile);
  const evidencePath = path.join(outputDir, 'toapis-wan3-video-verification.json');
  const manifestPath = path.join(outputDir, 'manifest.json');
  const state = {
    version: STATE_VERSION,
    generated_at: generatedAt,
    run_id: typeof deps.randomUUID === 'function' ? deps.randomUUID() : crypto.randomUUID(),
    case: {
      id: WAN3_CASE.id,
      model: WAN3_CASE.model,
      mode: WAN3_CASE.mode,
      requested_resolution: WAN3_CASE.resolution,
      requested_ratio: WAN3_CASE.ratio,
      requested_duration: WAN3_CASE.duration,
      requested_audio: WAN3_CASE.audio,
      status: 'completed',
      submission_state: 'accepted',
      provider_task_id: checked.providerTaskId,
      recovery_task_id: checked.recoveryTaskId,
      post_count: 1,
      source_config_id: checked.sourceConfigId,
      target_config_id: targetConfigId,
      config_id: targetConfigId,
      credential_fingerprint: credentialFingerprint(apiKey),
      config_fingerprint: configFingerprint({ id: targetConfigId }, apiKey),
      request,
      request_sha256: sha256(JSON.stringify(request)),
      started_at: checked.startedAt,
      accepted_at: checked.acceptedAt,
      completed_at: checked.completedAt,
      artifact: {
        public_url: `${PUBLIC_ASSET_BASE_URL}/${encodeURIComponent(outputFile)}`,
        output_file: outputFile,
        content_type: 'video/mp4',
        bytes: checked.artifact.bytes.length,
        sha256: checked.artifact.sha256,
        ffprobe: checked.artifact.ffprobe,
      },
      billing: {
        evidence_mode: 'unlimited_quota_positive_usage_v1',
        expected_cost_yuan: null,
        hard_cap_yuan: null,
        before: checked.billing.before,
        after: checked.billing.after,
        debited_balance: checked.billing.debitedBalance,
        debited_credits: checked.billing.debitedCredits,
        provider_currency: 'USD',
        usd_cny_rate: usdCnyRate,
        cost_yuan: round(checked.billing.debitedBalance * usdCnyRate),
      },
    },
  };
  const evidence = buildWan3Evidence(state);
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  const manifest = {
    contract_version: IMPORT_MANIFEST_VERSION,
    evidence: {
      [EVIDENCE_VERSION]: {
        file: path.basename(evidencePath),
        sha256: sha256(evidenceBytes),
      },
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const created = [];
  try {
    fs.mkdirSync(publicArtifactDir, { recursive: true, mode: 0o755 });
    writeBytesExclusive(publicArtifactPath, checked.artifact.bytes);
    created.push(publicArtifactPath);
    writeBytesExclusive(evidencePath, evidenceBytes);
    created.push(evidencePath);
    writeBytesExclusive(manifestPath, manifestBytes);
    created.push(manifestPath);
  } catch (error) {
    for (const filePath of created.reverse()) fs.rmSync(filePath, { force: true });
    throw error;
  }
  return evidence;
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
      source_config_id: result.source_config_id,
      target_config_id: result.target_config_id,
      config_id: result.config_id,
      credential_fingerprint: result.credential_fingerprint,
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
    const configId = requireConfigId(env.TOAPIS_WAN3_VERIFY_CONFIG_ID, 'TOAPIS_WAN3_VERIFY_CONFIG_ID');
    if (!apiKey) throw new Error('缺少 TOAPIS_WAN3_API_KEY');
    const config = { id: configId, provider: 'toapis_wan3', model: TOAPIS_WAN3_MODEL, base_url: BASE_URL, api_key: apiKey };
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
          source_config_id: configId,
          target_config_id: configId,
          config_id: configId,
          credential_fingerprint: credentialFingerprint(apiKey),
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
  const importMode = process.argv.includes('--import-smoke')
    || process.env.TOAPIS_WAN3_IMPORT_MODE === '1';
  const runner = importMode ? runWan3SmokeImport : runWan3Verification;
  runner().then((evidence) => {
    const label = importMode ? 'TOAPIS_WAN3_IMPORT_COMPLETE' : 'TOAPIS_WAN3_VERIFICATION_COMPLETE';
    process.stdout.write(`${label} task_id=${evidence.results[0].provider_task_id} cost_yuan=${evidence.results[0].billing.cost_yuan}\n`);
  }).catch((error) => {
    const label = importMode ? 'TOAPIS_WAN3_IMPORT_FAILED' : 'TOAPIS_WAN3_VERIFICATION_FAILED';
    process.stderr.write(`${label}: ${error.message}\n`);
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
  runWan3SmokeImport,
  runWan3Verification,
};
