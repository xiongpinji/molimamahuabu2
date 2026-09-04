const fs = require('node:fs');
const path = require('node:path');
const {
  hasCompletePricing,
  hasCompleteRequiredMatrix,
  validateCompletedResult,
} = require('./verify-toapis-video-models');

const REQUIRED_CASE_IDS = Object.freeze([
  'fast-t2v-480', 'fast-t2v-720', 'mini-t2v-480', 'mini-t2v-720',
  'fast-first-last-480', 'mini-first-last-480',
  'fast-omni-480', 'mini-omni-480',
]);
const REQUIRED_PRICES = Object.freeze([
  'seedance-2-fast|480p', 'seedance-2-fast|720p',
  'seedance-2-mini|480p', 'seedance-2-mini|720p',
]);

function read(root, relative, violations) {
  try { return fs.readFileSync(path.join(root, relative), 'utf8'); } catch (_) {
    violations.push(`缺少发布合同文件: ${relative}`);
    return '';
  }
}

function walkFiles(directory, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(target, output);
    else if (/\.(?:js|cjs|mjs|vue|json)$/i.test(entry.name)) output.push(target);
  }
  return output;
}

function roleSet(result) {
  const request = result?.request || {};
  return new Set([
    ...(request.image_with_roles || []).map((item) => item?.role),
    ...(request.video_with_roles || []).map((item) => item?.role),
    ...(request.audio_with_roles || []).map((item) => item?.role),
  ].filter(Boolean));
}

function round(value, precision = 6) {
  const factor = 10 ** precision;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function speedStats(values) {
  return {
    sample_count: values.length,
    min_generation_elapsed_seconds: Math.min(...values),
    max_generation_elapsed_seconds: Math.max(...values),
    avg_generation_elapsed_seconds: round(values.reduce((sum, value) => sum + value, 0) / values.length, 3),
  };
}

function expectedSpeedEvidence(results) {
  const cases = REQUIRED_CASE_IDS.map((id) => {
    const result = results.find((item) => item?.id === id);
    return {
      id,
      model: result?.model,
      resolution: result?.requested_resolution,
      mode: result?.mode,
      submit_latency_ms: Number(result?.speed?.submit_latency_ms),
      generation_elapsed_seconds: Number(result?.speed?.generation_elapsed_seconds),
      started_at: result?.started_at,
      completed_at: result?.completed_at,
    };
  });
  return {
    measurement_basis: 'actual_verification_run_not_provider_sla',
    cases,
    model_summary: Object.fromEntries(['seedance-2-fast', 'seedance-2-mini'].map((model) => {
      const values = cases
        .filter((item) => item.model === model && Number.isFinite(item.generation_elapsed_seconds))
        .map((item) => item.generation_elapsed_seconds);
      return [model, values.length ? speedStats(values) : {
        sample_count: 0,
        min_generation_elapsed_seconds: null,
        max_generation_elapsed_seconds: null,
        avg_generation_elapsed_seconds: null,
      }];
    })),
  };
}

function hasMatchingSpeedEvidence(evidence, results) {
  return JSON.stringify(evidence?.speed_evidence || null) === JSON.stringify(expectedSpeedEvidence(results));
}

function auditEvidence(evidence, violations) {
  if (evidence?.contract_version !== 'toapis-video-real-verification-v1'
      || evidence?.provider_origin !== 'https://toapis.cn') {
    violations.push('真实验证证据版本或 ToAPIs 官方域名不正确');
  }
  const results = Array.isArray(evidence?.results) ? evidence.results : [];
  const byId = new Map(results.map((item) => [item?.id, item]));
  if (!hasMatchingSpeedEvidence(evidence, results)) {
    violations.push('ToAPIs 真实速度 evidence 明细或 fast/mini 汇总不匹配');
  }
  for (const id of REQUIRED_CASE_IDS) {
    const result = byId.get(id);
    if (!validateCompletedResult(result)) violations.push(`真实验证组合与请求、媒体或账单不匹配: ${id}`);
  }
  if (!hasCompleteRequiredMatrix(results)) violations.push('8 个真实验证组合未形成一一绑定的完整发布矩阵');
  if (new Set(results.map((item) => item?.provider_task_id)).size !== results.length) {
    violations.push('真实验证证据包含重复供应商任务，禁止复用成品冒充不同组合');
  }
  const costReview = evidence?.cost_review || {};
  const completedBeforeRun = Array.isArray(costReview.completed_before_run) ? costReview.completed_before_run : [];
  const reviewRunIds = new Set(results.map((item) => item?.billing?.review_run_id));
  if (!String(costReview.run_id || '').trim()
      || !Number.isFinite(Date.parse(String(costReview.reviewed_at || '')))
      || !Array.isArray(costReview.submitted_case_ids) || costReview.submitted_case_ids.length !== 0
      || completedBeforeRun.length !== REQUIRED_CASE_IDS.length
      || !REQUIRED_CASE_IDS.every((id) => completedBeforeRun.includes(id))
      || reviewRunIds.size !== 1 || !reviewRunIds.has(costReview.run_id)) {
    violations.push('费用复核必须来自 8 个组合运行前已完成且本轮零 POST 的独立复核运行');
  }
  for (const result of results) {
    if (!['480p', '720p'].includes(String(result?.requested_resolution || '').toLowerCase())) {
      violations.push(`ToAPIs 证据包含未开放分辨率: ${result?.requested_resolution || '(empty)'}`);
    }
  }
  for (const id of ['fast-first-last-480', 'mini-first-last-480']) {
    const roles = roleSet(byId.get(id));
    if (!roles.has('first_frame') || !roles.has('last_frame')
        || roles.has('reference_image') || roles.has('reference_video') || roles.has('reference_audio')) {
      violations.push(`首尾帧参考合同缺失或混发参考素材: ${id}`);
    }
  }
  for (const id of ['fast-omni-480', 'mini-omni-480']) {
    const roles = roleSet(byId.get(id));
    if (!roles.has('reference_image') || !roles.has('reference_video') || !roles.has('reference_audio')
        || roles.has('first_frame') || roles.has('last_frame')) {
      violations.push(`全能参考真实证据不完整或与首尾帧混发: ${id}`);
    }
  }
  for (const model of ['seedance-2-fast', 'seedance-2-mini']) {
    const audioProof = results.some((item) => item?.model === model
      && item?.request?.generate_audio === true
      && item?.artifact?.ffprobe?.has_audio === true);
    if (!audioProof) violations.push(`缺少同步音频真实证据: ${model}`);
  }
  const pricing = Array.isArray(evidence?.pricing) ? evidence.pricing : [];
  const prices = new Map(pricing
    .map((item) => [`${item?.model}|${String(item?.resolution || '').toLowerCase()}`, item]));
  for (const key of REQUIRED_PRICES) {
    const item = prices.get(key);
    if (!item || item.reviewed !== true || Number(item.credits_per_second) <= 0
        || Number(item.cost_yuan_per_second) <= 0) {
      violations.push(`缺少已复核的分辨率价格: ${key}`);
    }
  }
  for (const key of prices.keys()) {
    if (!REQUIRED_PRICES.includes(key)) violations.push(`ToAPIs 价格包含未开放档位: ${key}`);
  }
  if (!hasCompletePricing(pricing, results)) {
    violations.push('ToAPIs 分辨率价格低于公开价或真实扣费成本，或积分未按 875 积分/元向上取整');
  }
}

function auditSecrets(root, evidencePath, violations) {
  const files = [
    ...walkFiles(path.join(root, 'backend-node/src')),
    ...walkFiles(path.join(root, 'backend-node/scripts')),
    ...walkFiles(path.join(root, 'frontweb/src')),
    evidencePath,
  ];
  for (const file of [...new Set(files)]) {
    if (!file || !fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(source)
        || /Bearer\s+[A-Za-z0-9._~-]{20,}/i.test(source)) {
      violations.push(`发现疑似 Key 或 Bearer 凭据: ${path.relative(root, file)}`);
    }
  }
}

function auditReleaseContract(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..', '..'));
  const evidencePath = path.resolve(options.evidencePath
    || process.env.TOAPIS_VIDEO_EVIDENCE_PATH
    || path.join(root, 'docs/evidence/toapis-video-verification.json'));
  const violations = [];
  const toapisClient = read(root, 'backend-node/src/services/toapisVideoClient.js', violations);
  const videoClient = read(root, 'backend-node/src/services/videoClient.js', violations);
  const videoService = read(root, 'backend-node/src/services/videoService.js', violations);
  const catalog = read(root, 'backend-node/src/services/canvasModelCatalogService.js', violations);
  const homeCanvas = read(root, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue', violations);
  const filmCreate = read(root, 'frontweb/src/views/FilmCreate.vue', violations);

  if (!/toapis_video/.test(videoClient) || !/callToapisVideoApi/.test(videoClient)) {
    violations.push('缺少 toapis_video 显式协议分发');
  }
  if (!/seedance-2-fast/.test(toapisClient) || !/seedance-2-mini/.test(toapisClient)
      || !/['"]480p['"]/.test(toapisClient) || !/['"]720p['"]/.test(toapisClient)
      || /['"]1080p['"]/.test(toapisClient) || /['"]4k['"]/.test(toapisClient)) {
    violations.push('ToAPIs 模型分辨率源码合同必须严格为 480P/720P');
  }
  if (!/STRICT_VERIFIED_PROTOCOLS/.test(catalog) || !/toapis_video/.test(catalog)
      || !/verification_status/.test(catalog) || !/verified_capabilities/.test(catalog)) {
    violations.push('缺少 ToAPIs 严格验证目录门禁');
  }
  if (!/toapisReadyState/.test(videoService) || !/requireVerifiedToapisReferenceCapabilities/.test(videoService)) {
    violations.push('缺少创建前 ToAPIs 验证与参考能力门禁');
  }
  if (!/canvas-credit-callout-v1/.test(homeCanvas) || !/canvas-credit-callout-v1/.test(filmCreate)) {
    violations.push('缺少受保护 canvas-credit-callout-v1 积分合同');
  }

  let evidence = null;
  try { evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')); } catch (_) {
    violations.push(`缺少或无法解析脱敏真实验证证据: ${path.relative(root, evidencePath)}`);
  }
  if (evidence) auditEvidence(evidence, violations);
  auditSecrets(root, evidencePath, violations);
  return [...new Set(violations)];
}

function main() {
  const violations = auditReleaseContract();
  if (violations.length) {
    process.stderr.write(`TOAPIS_VIDEO_RELEASE_CONTRACT_FAILED:\n${violations.map((item) => `- ${item}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('TOAPIS_VIDEO_RELEASE_CONTRACT_OK\n');
}

if (require.main === module) main();

module.exports = { REQUIRED_CASE_IDS, auditReleaseContract };
