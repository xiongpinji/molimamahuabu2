'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  hasCompleteRequiredMatrix,
  validateCompletedResult,
  validatePricingSnapshot,
} = require('./verify-lingjing-video-model');

const EXPECTED_DURATIONS = Object.freeze([4, 5, 6, 8, 10, 11, 15]);
const EXPECTED_RATIOS = Object.freeze(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']);

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

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function auditEvidence(evidence, violations) {
  if (evidence?.contract_version !== 'lingjing-video-real-verification-v1'
      || evidence?.provider_origin !== 'https://seed.alimyun.xyz') {
    violations.push('灵境真实验证证据版本或供应商域名不正确');
  }
  const results = Array.isArray(evidence?.results) ? evidence.results : [];
  if (results.length !== 1 || !hasCompleteRequiredMatrix(results)) {
    violations.push('灵境必须只有一个完整的 4 秒单图真实验证用例');
  }
  const result = results[0];
  if (!validateCompletedResult(result)) violations.push('灵境真实验证请求、任务或成品绑定不完整');

  const scope = evidence?.verification_scope || {};
  const capabilities = scope.documented_capabilities || {};
  if (scope.public_model !== 'lingjing-video-v1' || scope.upstream_model !== 'relay'
      || !sameJson(scope.real_case, { duration: 4, aspect_ratio: '16:9', reference_images: 1, resolution: null })
      || !sameJson(capabilities.durations, EXPECTED_DURATIONS)
      || !sameJson(capabilities.aspect_ratios, EXPECTED_RATIOS)
      || !sameJson(capabilities.resolutions, [])
      || Number(capabilities.max_image_references) !== 9
      || Number(capabilities.max_video_references) !== 0
      || Number(capabilities.max_audio_references) !== 0
      || capabilities.supports_first_frame !== false
      || capabilities.supports_last_frame !== false
      || capabilities.supports_audio !== false
      || !/^[a-f0-9]{64}$/.test(String(scope.reference_image_sha256 || ''))) {
    violations.push('灵境能力证据与供应商公开 relay 合同不一致');
  }
  if (result?.provider_audit?.uploads?.[0]?.reference_sha256 !== scope.reference_image_sha256) {
    violations.push('灵境上传路径与本次参考图 SHA-256 绑定不一致');
  }

  if (!validatePricingSnapshot(evidence?.pricing)
      || Number(evidence?.pricing?.credits_per_second) !== Math.ceil(0.17 * 875)) {
    violations.push('灵境价格必须精确为 0.17 元/秒并按 875 积分/元向上取整');
  }

  const expectedSpeed = result ? [{
    id: result.id,
    model: result.model,
    submit_latency_ms: result.speed?.submit_latency_ms,
    generation_elapsed_seconds: result.speed?.generation_elapsed_seconds,
    download_latency_ms: result.speed?.download_latency_ms,
    total_elapsed_seconds: result.speed?.total_elapsed_seconds,
  }] : [];
  if (evidence?.speed_evidence?.measurement_basis !== 'actual_paid_verification_run_not_provider_sla'
      || !sameJson(evidence?.speed_evidence?.cases, expectedSpeed)) {
    violations.push('灵境真实生成速度证据与任务结果不一致');
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
    || process.env.LINGJING_VIDEO_EVIDENCE_PATH
    || path.join(root, 'docs/evidence/lingjing-video-verification.json'));
  const violations = [];
  const client = read(root, 'backend-node/src/services/lingjingVideoClient.js', violations);
  const videoClient = read(root, 'backend-node/src/services/videoClient.js', violations);
  const videoService = read(root, 'backend-node/src/services/videoService.js', violations);
  const catalog = read(root, 'backend-node/src/services/canvasModelCatalogService.js', violations);
  const pricing = read(root, 'backend-node/src/services/modelPriceService.js', violations);
  const homeCanvas = read(root, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue', violations);
  const filmCreate = read(root, 'frontweb/src/views/FilmCreate.vue', violations);

  if (!/lingjing_open/.test(videoClient) || !/callLingjingVideoApi/.test(videoClient)
      || !/assertLingjingVideoSubmitReady/.test(videoClient)) {
    violations.push('缺少灵境独立协议分发或供应商提交前门禁');
  }
  const officialEndpointIsPinned = /OFFICIAL_ORIGIN\s*=\s*['"]https:\/\/seed\.alimyun\.xyz['"]/.test(client)
    && /OFFICIAL_BASE_URL\s*=\s*`\$\{OFFICIAL_ORIGIN\}\/api\/open\/v1`/.test(client);
  if (!/lingjing-video-v1/.test(client) || !/['"]relay['"]/.test(client)
      || !officialEndpointIsPinned
      || !/MAX_IMAGE_REFERENCES\s*=\s*9/.test(client)
      || !/callLingjingVideoApi/.test(client) || !/fetchLingjingTask/.test(client)) {
    violations.push('灵境客户端模型、域名、参考上限或异步任务合同不正确');
  }
  if (!/lingjingReadyState/.test(videoService)
      || !/hasTrustedEvidenceBinding/.test(videoService)
      || !/maxReferences\s*<=\s*lingjingVideoClient\.MAX_IMAGE_REFERENCES/.test(videoService)) {
    violations.push('缺少创建前灵境证据与参考能力门禁');
  }
  if (!/STRICT_VERIFIED_PROTOCOLS/.test(catalog) || !/lingjing_open/.test(catalog)
      || !/verification_status/.test(catalog) || !/verified_capabilities/.test(catalog)) {
    violations.push('缺少灵境严格验证目录门禁');
  }
  if (!/STRICT_VERIFIED_PROTOCOLS/.test(pricing) || !/lingjing_open/.test(pricing)
      || !/category\s*===\s*['"]video['"]/.test(pricing)) {
    violations.push('缺少灵境视频精确定价门禁');
  }
  if (!/canvas-credit-callout-v1/.test(homeCanvas) || !/canvas-credit-callout-v1/.test(filmCreate)) {
    violations.push('缺少受保护 canvas-credit-callout-v1 积分合同');
  }

  let evidence = null;
  try { evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')); } catch (_) {
    violations.push(`缺少或无法解析灵境脱敏真实验证证据: ${path.relative(root, evidencePath)}`);
  }
  if (evidence) auditEvidence(evidence, violations);
  auditSecrets(root, evidencePath, violations);
  return [...new Set(violations)];
}

function main() {
  const violations = auditReleaseContract();
  if (violations.length) {
    process.stderr.write(`LINGJING_VIDEO_RELEASE_CONTRACT_FAILED:\n${violations.map((item) => `- ${item}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('LINGJING_VIDEO_RELEASE_CONTRACT_OK\n');
}

if (require.main === module) main();

module.exports = { auditReleaseContract };
