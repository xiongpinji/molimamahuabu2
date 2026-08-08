const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const Database = require('better-sqlite3');

const { callUsmercariImageApi } = require('../src/services/usmercariImageClient');
const { loadConfig } = require('../src/config');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const aiConfigService = require('../src/services/aiConfigService');

const BASE_URL = String(process.env.USMERCARI_IMAGE_BASE_URL || 'https://chat-ai.mercarimx.com').replace(/\/+$/, '');
const MODELS = ['gpt-image-2-2-4k', 'nano-banana-2'];
const RESOLUTIONS_BY_MODEL = Object.freeze({
  'gpt-image-2-2-4k': Object.freeze(['1k', '2k']),
  'nano-banana-2': Object.freeze(['1k', '2k', '4k']),
});
const APPROVED_MATRIX = Object.freeze([
  ['gpt-image-2-2-4k', 'text-to-image', '1k'],
  ['gpt-image-2-2-4k', 'text-to-image', '2k'],
  ['gpt-image-2-2-4k', 'image-to-image', '1k'],
  ['nano-banana-2', 'text-to-image', '1k'],
  ['nano-banana-2', 'text-to-image', '2k'],
  ['nano-banana-2', 'text-to-image', '4k'],
  ['nano-banana-2', 'image-to-image', '1k'],
]);
const log = { info() {}, warn() {}, error() {} };

function buildVerificationCases(selector = process.env.USMERCARI_VERIFY_CASES) {
  const cases = MODELS.flatMap((model) => [
    ...RESOLUTIONS_BY_MODEL[model].map((resolution) => ({ model, capability: 'text-to-image', resolution })),
    { model, capability: 'image-to-image', resolution: '1k' },
  ]);
  const requested = String(selector || '').split(/[;,]/).map((value) => value.trim()).filter(Boolean);
  if (!requested.length) return cases;

  const allowed = new Map(cases.map((item) => [`${item.model}|${item.capability}|${item.resolution}`, item]));
  const selected = requested.map((key) => {
    const item = allowed.get(key);
    if (!item) throw new Error(`未知验证用例: ${key}`);
    return item;
  });
  if (new Set(requested).size !== requested.length) throw new Error('验证用例不能重复');
  return selected;
}

function requiresReferenceUrl(cases) {
  return (Array.isArray(cases) ? cases : []).some((item) => item.capability === 'image-to-image');
}

function buildVerifiedCapabilities(results) {
  const capabilities = {};
  for (const item of Array.isArray(results) ? results : []) {
    const model = String(item.model || '').trim();
    const capability = String(item.capability || '').trim();
    const resolution = String(item.requested_resolution || '').trim().toLowerCase();
    if (!model || !resolution || !Number(item.width) || !Number(item.height)) continue;
    const current = capabilities[model] || {
      supportsTextToImage: false,
      supportsImageReference: false,
      maxReferences: 0,
      resolutions: [],
    };
    if (capability === 'text-to-image') current.supportsTextToImage = true;
    if (capability === 'image-to-image') {
      current.supportsImageReference = true;
      const referenceCount = Number(item.reference_count);
      current.maxReferences = Math.max(
        current.maxReferences,
        Number.isSafeInteger(referenceCount) && referenceCount > 0 ? referenceCount : 1,
      );
    }
    if (!current.resolutions.includes(resolution)) current.resolutions.push(resolution);
    capabilities[model] = current;
  }
  for (const item of Object.values(capabilities)) item.resolutions.sort();
  return capabilities;
}

function hasCompleteApprovedMatrix(results) {
  const completed = new Set();
  for (const item of Array.isArray(results) ? results : []) {
    const model = String(item.model || '').trim();
    const capability = String(item.capability || '').trim();
    const resolution = String(item.requested_resolution || '').trim().toLowerCase();
    if (!Number(item.width) || !Number(item.height)) continue;
    completed.add(`${model}|${capability}|${resolution}`);
  }
  return APPROVED_MATRIX.every(([model, capability, resolution]) => (
    completed.has(`${model}|${capability}|${resolution}`)
  ));
}

function openVerificationDb() {
  const dbPath = String(process.env.USMERCARI_VERIFY_DATABASE_PATH || process.env.DATABASE_PATH || '').trim()
    || loadConfig().database?.path;
  if (!dbPath || dbPath === ':memory:') throw new Error('缺少可写入验证状态的数据库路径');
  const absolute = path.resolve(process.cwd(), dbPath);
  const db = new Database(absolute);
  runMigrationsAndEnsure(db);
  return db;
}

function recordVerificationResult(results, error = null) {
  const configId = Number(process.env.USMERCARI_VERIFY_CONFIG_ID || 0);
  if (!configId) return null;
  const db = openVerificationDb();
  try {
    if (error) {
      return aiConfigService.recordVerification(db, configId, {
        status: 'failed',
        error: error.message || error,
      });
    }
    if (!hasCompleteApprovedMatrix(results)) return null;
    return aiConfigService.recordVerification(db, configId, {
      status: 'verified',
      verifiedAt: new Date().toISOString(),
      capabilities: buildVerifiedCapabilities(results),
    });
  } finally {
    db.close();
  }
}

function requireApiKey() {
  if (process.argv.some((value) => /(?:api[-_]?key|token)=/i.test(value))) {
    throw new Error('禁止通过命令行参数传入供应商 Key');
  }
  const apiKey = String(process.env.USMERCARI_IMAGE_API_KEY || process.env.USMERCARI_API_KEY || '').trim();
  if (!apiKey) throw new Error('缺少 USMERCARI_IMAGE_API_KEY');
  return apiKey;
}

function assertResolutionBand(resolution, width, height) {
  const longEdge = Math.max(Number(width) || 0, Number(height) || 0);
  if (!longEdge) throw new Error('结果图片缺少有效尺寸');
  if (resolution === '1k' && longEdge <= 1024) return;
  if (resolution === '2k' && longEdge > 1024 && longEdge <= 2048) return;
  if (resolution === '4k' && longEdge > 2048) return;
  throw new Error(`${resolution} 结果尺寸不在对应档位: ${width}x${height}`);
}

async function downloadAndInspect(url, outputPath, resolution) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`结果下载失败 (${response.status})`);
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error(`结果 MIME 不是图片: ${contentType || '(empty)'}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('结果图片为空');
  const metadata = await sharp(buffer).metadata();
  assertResolutionBand(resolution, metadata.width, metadata.height);
  await fs.promises.writeFile(outputPath, buffer);
  return {
    content_type: contentType,
    bytes: buffer.length,
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

async function verificationReferenceSource(_tempDir, explicitUrl = process.env.USMERCARI_VERIFY_REFERENCE_URL) {
  const value = String(explicitUrl || '').trim();
  if (!/^https:\/\//i.test(value)) throw new Error('USMERCARI_VERIFY_REFERENCE_URL 必须是 HTTPS 公网地址');
  return value;
}

function buildVerificationReferences(capability, referenceUrl) {
  if (capability !== 'image-to-image') return { reference_image_urls: [] };
  return {
    reference_image_urls: [referenceUrl],
    allowed_reference_base_url: referenceUrl,
  };
}

async function verifyOne({ apiKey, outputDir, model, resolution, capability, referenceDataUri }) {
  const startedAt = new Date().toISOString();
  const result = await callUsmercariImageApi({ base_url: BASE_URL, api_key: apiKey }, log, {
    model,
    prompt: capability === 'image-to-image'
      ? '保持参考图的深蓝圆形主体和橙色背景，生成干净的电影感立体图标，单幅画面，无文字'
      : `单幅电影感产品图，一枚深蓝色圆形徽章放在橙色背景中央，清晰细节，无文字，${resolution}`,
    n: 1,
    aspect_ratio: '1:1',
    resolution,
    ...buildVerificationReferences(capability, referenceDataUri),
  });
  if (result.indeterminate) throw new Error(result.error);
  if (result.error) throw new Error(result.error);

  const fileName = `${model}-${capability}-${resolution}.png`.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const inspected = await downloadAndInspect(result.image_url, path.join(outputDir, fileName), resolution);
  return {
    marker: `${model}|${capability}|${resolution}|verified`,
    model,
    capability,
    requested_resolution: resolution,
    requested_aspect_ratio: '1:1',
    quantity: 1,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    provider_credits_used: result.provider?.credits_used ?? null,
    provider_model_id: result.provider?.model_id ?? null,
    result_url_origin: new URL(result.image_url).origin,
    output_file: fileName,
    ...inspected,
  };
}

async function runVerification() {
  const apiKey = requireApiKey();
  const cases = buildVerificationCases();
  const temporaryRoot = !process.env.USMERCARI_VERIFY_OUTPUT_DIR;
  const outputDir = process.env.USMERCARI_VERIFY_OUTPUT_DIR
    ? path.resolve(process.env.USMERCARI_VERIFY_OUTPUT_DIR)
    : await fs.promises.mkdtemp(path.join(os.tmpdir(), 'usmercari-image-verify-'));
  await fs.promises.mkdir(outputDir, { recursive: true });
  const referenceDataUri = requiresReferenceUrl(cases)
    ? await verificationReferenceSource(outputDir)
    : '';
  const results = [];
  let activeCase = null;
  try {
    for (const item of cases) {
      activeCase = `${item.model}|${item.capability}|${item.resolution}`;
      const verified = await verifyOne({ apiKey, outputDir, ...item, referenceDataUri });
      results.push(verified);
      process.stdout.write(`${verified.marker} ${verified.width}x${verified.height} ${verified.sha256}\n`);
    }
    const evidencePath = path.join(outputDir, 'verification-results.json');
    await fs.promises.writeFile(evidencePath, `${JSON.stringify({
      base_url: BASE_URL,
      generated_at: new Date().toISOString(),
      selected_cases: cases.map((item) => `${item.model}|${item.capability}|${item.resolution}`),
      results,
    }, null, 2)}\n`);
    recordVerificationResult(results);
    process.stdout.write(`VERIFIED ${results.length}/${cases.length} evidence=${evidencePath}\n`);
    return { outputDir, results, temporaryRoot };
  } catch (error) {
    const failurePath = path.join(outputDir, 'verification-failure.json');
    await fs.promises.writeFile(failurePath, `${JSON.stringify({
      base_url: BASE_URL,
      failed_at: new Date().toISOString(),
      failed_case: activeCase,
      completed_results: results,
      error: String(error.message || error).slice(0, 800),
    }, null, 2)}\n`);
    error.message = `${error.message}；脱敏失败证据: ${failurePath}`;
    recordVerificationResult(results, error);
    throw error;
  }
}

if (require.main === module) {
  runVerification().catch((error) => {
    process.stderr.write(`USMERCARI_IMAGE_VERIFICATION_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertResolutionBand,
  buildVerifiedCapabilities,
  hasCompleteApprovedMatrix,
  buildVerificationCases,
  buildVerificationReferences,
  downloadAndInspect,
  requiresReferenceUrl,
  recordVerificationResult,
  runVerification,
  verificationReferenceSource,
};
