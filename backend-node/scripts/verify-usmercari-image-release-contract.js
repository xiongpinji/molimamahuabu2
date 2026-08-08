const fs = require('node:fs');
const path = require('node:path');

const CONTRACT = 'usmercari-image-real-verification-v1';
const PROVIDER_ORIGIN = 'https://chat-ai.mercarimx.com';
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const REQUIRED_CASES = Object.freeze([
  { model: 'gpt-image-2-2-4k', capability: 'text-to-image', resolution: '1k' },
  { model: 'gpt-image-2-2-4k', capability: 'text-to-image', resolution: '2k' },
  { model: 'gpt-image-2-2-4k', capability: 'image-to-image', resolution: '1k' },
  { model: 'nano-banana-2', capability: 'text-to-image', resolution: '1k' },
  { model: 'nano-banana-2', capability: 'text-to-image', resolution: '2k' },
  { model: 'nano-banana-2', capability: 'text-to-image', resolution: '4k' },
  { model: 'nano-banana-2', capability: 'image-to-image', resolution: '1k' },
]);
const REQUIRED_PRICES = Object.freeze(new Map([
  ['gpt-image-2-2-4k|1k', { cost: 0.08, credits: 70 }],
  ['gpt-image-2-2-4k|2k', { cost: 0.10, credits: 87 }],
  ['nano-banana-2|1k', { cost: 0.08, credits: 70 }],
  ['nano-banana-2|2k', { cost: 0.10, credits: 87 }],
  ['nano-banana-2|4k', { cost: 0.12, credits: 105 }],
]));

function read(root, relative, violations) {
  try {
    return fs.readFileSync(path.join(root, relative), 'utf8');
  } catch (_) {
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

function caseKey(item) {
  return `${String(item?.model || '').trim()}|${String(item?.capability || '').trim()}|${String(item?.requested_resolution || '').trim().toLowerCase()}`;
}

function validPublicUrl(value, outputFile) {
  const raw = String(value || '').trim();
  const basename = String(outputFile || '').trim();
  if (!basename || path.basename(basename) !== basename
      || !/^[A-Za-z0-9._-]+\.(?:png|jpe?g|webp)$/i.test(basename)) return false;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:'
      && !parsed.username && !parsed.password
      && !parsed.port && !parsed.search && !parsed.hash
      && parsed.href === raw
      && host === 'molimama.vip'
      && parsed.pathname === `/verification-assets/usmercari/${encodeURIComponent(basename)}`;
  } catch (_) {
    return false;
  }
}

function canonicalTimestamp(value) {
  const raw = String(value || '');
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === raw
    ? timestamp
    : NaN;
}

function auditFreshness(evidence, violations, now = Date.now()) {
  const generatedAt = canonicalTimestamp(evidence?.generated_at);
  const validUntil = canonicalTimestamp(evidence?.valid_until);
  if (!Number.isFinite(generatedAt) || !Number.isFinite(validUntil)) {
    violations.push('真实验证证据缺少规范的 UTC 生成时间与有效期');
    return;
  }
  if (generatedAt > now) violations.push('真实验证证据生成时间位于未来');
  if (now - generatedAt > MAX_EVIDENCE_AGE_MS) violations.push('真实验证证据已超过 24 小时');
  if (validUntil <= now) violations.push('真实验证证据已过期');
  if (validUntil <= generatedAt) violations.push('真实验证证据有效期必须晚于生成时间');
  if (validUntil - generatedAt > MAX_EVIDENCE_VALIDITY_MS) {
    violations.push('真实验证证据有效期不得超过 7 天');
  }
}

function validImageBand(resolution, width, height) {
  const longEdge = Math.max(Number(width) || 0, Number(height) || 0);
  if (resolution === '1k') return longEdge > 0 && longEdge <= 1024;
  if (resolution === '2k') return longEdge > 1024 && longEdge <= 2048;
  if (resolution === '4k') return longEdge > 2048;
  return false;
}

function auditEvidence(evidence, violations, now) {
  if (evidence?.contract_version !== CONTRACT) violations.push('真实验证证据版本不正确');
  if (evidence?.provider_origin !== PROVIDER_ORIGIN) violations.push('USMercari 图片官方域名不正确');
  auditFreshness(evidence, violations, now);

  const results = Array.isArray(evidence?.results) ? evidence.results : [];
  const expectedKeys = new Set(REQUIRED_CASES.map(({ model, capability, resolution }) => `${model}|${capability}|${resolution}`));
  const byKey = new Map(results.map((item) => [caseKey(item), item]));
  if (results.length !== REQUIRED_CASES.length || byKey.size !== results.length
      || [...byKey.keys()].some((key) => !expectedKeys.has(key))) {
    violations.push('USMercari 图片真实验证组合必须严格为允许开放的 7 项，GPT 4K 禁止开放');
  }
  const artifactKeys = new Set();
  for (const key of expectedKeys) {
    const item = byKey.get(key);
    if (!item) {
      violations.push(`缺少真实验证组合: ${key}`);
      continue;
    }
    const resolution = key.split('|')[2];
    const artifactKey = `${item.output_file}|${item.public_url}|${item.sha256}`;
    if (artifactKeys.has(artifactKey)) violations.push(`真实成品被重复用于多个组合: ${key}`);
    artifactKeys.add(artifactKey);
    if (item.marker !== `${key}|verified`
        || item.quantity !== 1
        || !validImageBand(resolution, item.width, item.height)
        || !/^image\//i.test(String(item.content_type || ''))
        || !Number.isSafeInteger(Number(item.bytes)) || Number(item.bytes) <= 0
        || !/^[a-f0-9]{64}$/i.test(String(item.sha256 || ''))
        || !validPublicUrl(item.public_url, item.output_file)) {
      violations.push(`真实成品字段、尺寸或公网绑定不完整: ${key}`);
    }
    if (item.capability === 'image-to-image' && Number(item.reference_count) < 1) {
      violations.push(`参考图能力证据不完整: ${key}`);
    }
  }

  const rejected = Array.isArray(evidence?.rejected_capabilities) ? evidence.rejected_capabilities : [];
  const gpt4k = rejected.find((item) => item?.marker === 'gpt-image-2-2-4k|text-to-image|4k|failed');
  if (!gpt4k || Number(gpt4k.attempts) < 2 || Number(gpt4k.http_status) !== 400
      || String(gpt4k.error_code || '') !== 'PROVIDER_INVALID_REQUEST') {
    violations.push('缺少 GPT 4K 明确拒绝证据，禁止推断开放');
  }

  const pricing = Array.isArray(evidence?.pricing) ? evidence.pricing : [];
  const prices = new Map(pricing.map((item) => [
    `${String(item?.model || '').trim()}|${String(item?.resolution || '').trim().toLowerCase()}`,
    item,
  ]));
  if (pricing.length !== REQUIRED_PRICES.size || prices.size !== pricing.length) {
    violations.push('USMercari 图片价格必须严格覆盖 5 个已开放模型档位');
  }
  for (const [key, expected] of REQUIRED_PRICES) {
    const item = prices.get(key);
    if (!item || item.reviewed !== true
        || Number(item.cost_yuan_per_image) !== expected.cost
        || Number(item.credits_per_image) !== expected.credits) {
      violations.push(`USMercari 图片价格不匹配: ${key}`);
    }
  }
  for (const key of prices.keys()) {
    if (!REQUIRED_PRICES.has(key)) violations.push(`USMercari 图片价格包含未开放档位: ${key}`);
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
    || path.join(root, 'docs/evidence/usmercari-image-verification.json'));
  const violations = [];
  const client = read(root, 'backend-node/src/services/usmercariImageClient.js', violations);
  const imageClient = read(root, 'backend-node/src/services/imageClient.js', violations);
  const imageService = read(root, 'backend-node/src/services/imageService.js', violations);
  const catalog = read(root, 'backend-node/src/services/canvasModelCatalogService.js', violations);
  const priceService = read(root, 'backend-node/src/services/modelPriceService.js', violations);
  const homeCanvas = read(root, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue', violations);
  const filmCreate = read(root, 'frontweb/src/views/FilmCreate.vue', violations);

  if (!/USMERCARI_IMAGE_MODELS/.test(client)
      || !/'gpt-image-2-2-4k'[\s\S]*?\['1k',\s*'2k'\]/.test(client)
      || !/'nano-banana-2'[\s\S]*?\['1k',\s*'2k',\s*'4k'\]/.test(client)
      || !/maxReferences:\s*6/.test(client)) {
    violations.push('USMercari 图片源码能力必须为 GPT 1K/2K、Nano 1K/2K/4K 和最多 6 张参考图');
  }
  if (!/protocol\s*===\s*['"]usmercari_image['"]/.test(imageClient)
      || !/callUsmercariImageApi/.test(imageClient)) {
    violations.push('缺少 usmercari_image 显式协议分发');
  }
  if (!/verification_status\s*!==\s*['"]verified['"]/.test(imageService)
      || !/MODEL_NOT_VERIFIED/.test(imageService)
      || !/verified_capabilities/.test(imageService)) {
    violations.push('缺少任务入库和预扣前的 USMercari 图片生成前验证门禁');
  }
  if (!/STRICT_VERIFIED_PROTOCOLS/.test(catalog) || !/usmercari_image/.test(catalog)
      || !/verification_status/.test(catalog) || !/verified_capabilities/.test(catalog)
      || !/resolution_prices/.test(catalog)) {
    violations.push('缺少 USMercari 图片严格验证、凭据与分档价格目录门禁');
  }
  if (!/STRICT_VERIFIED_PROTOCOLS/.test(priceService) || !/usmercari_image/.test(priceService)
      || !/verification_status/.test(priceService)) {
    violations.push('缺少 USMercari 图片预扣前分档价格门禁');
  }
  if (!/canvas-credit-callout-v1/.test(homeCanvas) || !/canvas-credit-callout-v1/.test(filmCreate)) {
    violations.push('缺少受保护 canvas-credit-callout-v1 积分合同');
  }

  let evidence = null;
  try {
    evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  } catch (_) {
    violations.push(`缺少或无法解析脱敏图片真实验证证据: ${path.relative(root, evidencePath)}`);
  }
  if (evidence) auditEvidence(evidence, violations, options.now ?? Date.now());
  auditSecrets(root, evidencePath, violations);
  return [...new Set(violations)];
}

function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', '..');
  const evidencePath = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(root, 'docs/evidence/usmercari-image-verification.json');
  const violations = auditReleaseContract({ root, evidencePath });
  if (violations.length > 0) {
    process.stderr.write(`USMERCARI_IMAGE_RELEASE_CONTRACT_FAILED:\n${violations.map((item) => `- ${item}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('USMERCARI_IMAGE_RELEASE_CONTRACT_OK\n');
}

if (require.main === module) main();

module.exports = {
  CONTRACT,
  REQUIRED_CASES,
  REQUIRED_PRICES,
  auditReleaseContract,
};
