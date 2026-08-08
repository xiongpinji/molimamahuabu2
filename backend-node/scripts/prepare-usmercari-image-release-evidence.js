const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const CONTRACT_VERSION = 'usmercari-image-real-verification-v1';
const PROVIDER_ORIGIN = 'https://chat-ai.mercarimx.com';
const PUBLIC_ASSET_BASE = 'https://molimama.vip/verification-assets/usmercari';
const VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const GPT_4K_CASE = 'gpt-image-2-2-4k|text-to-image|4k';

const REQUIRED_CASES = Object.freeze([
  Object.freeze(['gpt-image-2-2-4k', 'text-to-image', '1k']),
  Object.freeze(['gpt-image-2-2-4k', 'text-to-image', '2k']),
  Object.freeze(['gpt-image-2-2-4k', 'image-to-image', '1k']),
  Object.freeze(['nano-banana-2', 'text-to-image', '1k']),
  Object.freeze(['nano-banana-2', 'text-to-image', '2k']),
  Object.freeze(['nano-banana-2', 'text-to-image', '4k']),
  Object.freeze(['nano-banana-2', 'image-to-image', '1k']),
]);

const PRICING = Object.freeze([
  Object.freeze(['gpt-image-2-2-4k', '1k', 0.08, 70]),
  Object.freeze(['gpt-image-2-2-4k', '2k', 0.10, 87]),
  Object.freeze(['nano-banana-2', '1k', 0.08, 70]),
  Object.freeze(['nano-banana-2', '2k', 0.10, 87]),
  Object.freeze(['nano-banana-2', '4k', 0.12, 105]),
]);

const REQUIRED_KEYS = new Set(REQUIRED_CASES.map((item) => item.join('|')));

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizedPath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function requireArray(value, label, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum) fail(`${label} must contain at least ${minimum} item(s)`);
  return value;
}

function secureFile(input, label) {
  if (typeof input !== 'string' || !input.trim()) fail(`${label} path is required`);
  const target = path.resolve(input);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular file, not a symlink`);
  const real = fs.realpathSync.native(target);
  if (!samePath(real, target)) fail(`${label} real path does not match the supplied path`);
  return real;
}

function secureDirectory(input, label) {
  if (typeof input !== 'string' || !input.trim()) fail(`${label} path is required`);
  const target = path.resolve(input);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a regular directory, not a symlink`);
  const real = fs.realpathSync.native(target);
  if (!samePath(real, target)) fail(`${label} real path does not match the supplied path`);
  return real;
}

function readRecord(input, label) {
  const file = secureFile(input, label);
  const bytes = fs.readFileSync(file);
  let record;
  try {
    record = JSON.parse(bytes.toString('utf8'));
  } catch (_) {
    fail(`${label} is not valid JSON`);
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail(`${label} must contain one JSON object`);
  requireOfficialBaseUrl(record.base_url, `${label} provider base URL`);
  return { file, record, rawSha256: sha256(bytes) };
}

function requireOfficialBaseUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch (_) {
    fail(`${label} must use the official provider origin`);
  }
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  if (parsed.origin !== PROVIDER_ORIGIN || parsed.username || parsed.password
      || parsed.search || parsed.hash || !['/', '/v1'].includes(pathname)) {
    fail(`${label} must use the official provider origin`);
  }
}

function canonicalTimestamp(value, label) {
  const raw = String(value || '');
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== raw) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
  return milliseconds;
}

function safeBasename(value, label) {
  const output = String(value || '');
  if (!output || output !== path.basename(output) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(output)) {
    fail(`${label} must be a safe basename`);
  }
  return output;
}

function resultKey(item) {
  return [
    String(item?.model || '').trim(),
    String(item?.capability || '').trim(),
    String(item?.requested_resolution || '').trim().toLowerCase(),
  ].join('|');
}

function validateImageBand(resolution, width, height, label) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    fail(`${label} image dimensions are invalid`);
  }
  if (width !== height) fail(`${label} does not match the requested 1:1 aspect ratio`);
  const edge = Math.max(width, height);
  if (resolution === '1k' && edge <= 1024) return;
  if (resolution === '2k' && edge > 1024 && edge <= 2048) return;
  if (resolution === '4k' && edge > 2048 && edge <= 4096) return;
  fail(`${label} does not match the requested ${resolution.toUpperCase()} size band`);
}

function expectedContentType(format) {
  const formats = {
    avif: 'image/avif',
    gif: 'image/gif',
    heif: 'image/heif',
    jpeg: 'image/jpeg',
    png: 'image/png',
    tiff: 'image/tiff',
    webp: 'image/webp',
  };
  return formats[format] || '';
}

function publicationExtension(format) {
  const extensions = {
    avif: 'avif',
    gif: 'gif',
    heif: 'heif',
    jpeg: 'jpg',
    png: 'png',
    tiff: 'tiff',
    webp: 'webp',
  };
  return extensions[format] || '';
}

function findUniqueAsset(assetRoots, outputFile, label) {
  const matches = [];
  for (const root of assetRoots) {
    const candidate = path.join(root, outputFile);
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} local artifact must be a regular file, not a symlink`);
    const real = fs.realpathSync.native(candidate);
    if (!samePath(real, candidate) || !samePath(path.dirname(real), root)) {
      fail(`${label} local artifact escapes its asset root`);
    }
    matches.push(real);
  }
  if (matches.length !== 1) fail(`${label} must resolve to exactly one local artifact`);
  return matches[0];
}

async function validateResult(item, rawSha256, assetRoots) {
  const key = resultKey(item);
  if (!REQUIRED_KEYS.has(key) || item.marker !== `${key}|verified`) fail(`unexpected or malformed real image case: ${key}`);
  if (Number(item.quantity) !== 1 || !Number.isSafeInteger(Number(item.quantity))) fail(`${key} quantity must be exactly 1`);
  if (item.requested_aspect_ratio !== '1:1') fail(`${key} requested aspect ratio must be 1:1`);
  if (String(item.result_url_origin || '').trim() !== PROVIDER_ORIGIN) {
    fail(`${key} result origin must be the exact official provider origin`);
  }
  const startedAt = canonicalTimestamp(item.started_at, `${key} started_at`);
  const completedAt = canonicalTimestamp(item.completed_at, `${key} completed_at`);
  if (completedAt < startedAt) fail(`${key} completed_at precedes started_at`);

  const providerModelId = String(item.provider_model_id || '').trim();
  if (!providerModelId) fail(`${key} provider_model_id is required`);
  const sourceOutputFile = safeBasename(item.output_file, `${key} output_file`);
  const rawBytes = Number(item.bytes);
  if (!Number.isSafeInteger(rawBytes) || rawBytes <= 0) fail(`${key} bytes must be a positive safe integer`);
  const rawSha = String(item.sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(rawSha)) fail(`${key} SHA-256 is invalid`);
  if (!/^image\/[a-z0-9.+-]+$/i.test(String(item.content_type || ''))) fail(`${key} content type is invalid`);
  const assetPath = findUniqueAsset(assetRoots, sourceOutputFile, key);
  const bytes = fs.readFileSync(assetPath);
  if (bytes.length !== rawBytes) fail(`${key} bytes do not match the real artifact`);
  const actualSha = sha256(bytes);
  if (actualSha !== rawSha) fail(`${key} SHA-256 does not match the real artifact`);

  let metadata;
  try {
    metadata = await sharp(bytes, { failOn: 'error' }).metadata();
  } catch (_) {
    fail(`${key} cannot be decoded by Sharp as an image`);
  }
  const format = String(metadata.format || '').toLowerCase();
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  validateImageBand(key.split('|')[2], width, height, key);
  if (String(item.format || '').trim().toLowerCase() !== format
      || Number(item.width) !== width || Number(item.height) !== height) {
    fail(`${key} Sharp dimensions or format do not match the source record`);
  }
  if (expectedContentType(format) !== String(item.content_type).toLowerCase()) {
    fail(`${key} content type does not match the Sharp format`);
  }
  const extension = publicationExtension(format);
  if (!extension) fail(`${key} Sharp format cannot be published safely`);
  const outputFile = safeBasename(
    `${path.parse(sourceOutputFile).name}.${extension}`,
    `${key} published output_file`,
  );
  const providerCreditsUsed = Number(item.provider_credits_used);
  if (!Number.isFinite(providerCreditsUsed) || providerCreditsUsed < 0) fail(`${key} provider credits are invalid`);
  const capability = key.split('|')[1];

  return {
    evidence: {
      marker: `${key}|verified`,
      model: key.split('|')[0],
      capability,
      requested_resolution: key.split('|')[2],
      requested_aspect_ratio: '1:1',
      quantity: 1,
      reference_count: capability === 'image-to-image' ? 1 : 0,
      started_at: item.started_at,
      completed_at: item.completed_at,
      provider_credits_used: providerCreditsUsed,
      provider_model_id: providerModelId,
      result_url_origin: PROVIDER_ORIGIN,
      public_url: `${PUBLIC_ASSET_BASE}/${encodeURIComponent(outputFile)}`,
      output_file: outputFile,
      content_type: expectedContentType(format),
      bytes: bytes.length,
      width,
      height,
      format,
      sha256: actualSha,
      raw_source_sha256: rawSha256,
    },
    assetBytes: bytes,
    completedAt,
  };
}

function rejectionStatus(record) {
  const direct = Number(record.http_status ?? record.status);
  if (Number.isSafeInteger(direct)) return direct;
  const match = String(record.error || '').match(/(?:^|\D)(400|422)(?:\D|$)/);
  return match ? Number(match[1]) : 0;
}

function validateRejections(inputs) {
  if (inputs.length !== 2) fail('two independent GPT 4K rejection records are required');
  const paths = new Set(inputs.map((item) => normalizedPath(item.file)));
  const hashes = new Set(inputs.map((item) => item.rawSha256));
  if (paths.size !== 2 || hashes.size !== 2) fail('two independent GPT 4K rejection records are required');

  let exactCount = 0;
  const failedTimes = [];
  for (const input of inputs) {
    const { record } = input;
    const status = rejectionStatus(record);
    if (status !== 400) fail('each GPT 4K rejection record must prove HTTP 400');
    failedTimes.push(canonicalTimestamp(record.failed_at, 'GPT 4K rejection failed_at'));
    const failedCase = String(record.failed_case || '').trim();
    const errorText = String(record.error || '');
    if (failedCase) {
      if (failedCase !== GPT_4K_CASE || !/PROVIDER_INVALID_REQUEST/.test(errorText)) {
        fail('explicit GPT 4K rejection must bind failed_case to PROVIDER_INVALID_REQUEST');
      }
      exactCount += 1;
      continue;
    }
    const completed = Array.isArray(record.completed_results) ? record.completed_results : [];
    const completedKeys = completed.map(resultKey);
    if (completedKeys.length !== 2
        || completedKeys[0] !== 'gpt-image-2-2-4k|text-to-image|1k'
        || completedKeys[1] !== 'gpt-image-2-2-4k|text-to-image|2k') {
      fail('legacy GPT 4K rejection can only be inferred after completed GPT 1K and 2K cases');
    }
  }
  if (exactCount < 1) fail('at least one GPT 4K rejection must explicitly prove PROVIDER_INVALID_REQUEST');
  return {
    evidence: {
      marker: `${GPT_4K_CASE}|failed`,
      attempts: 2,
      http_status: 400,
      error_code: 'PROVIDER_INVALID_REQUEST',
      first_failed_at: new Date(Math.min(...failedTimes)).toISOString(),
      last_failed_at: new Date(Math.max(...failedTimes)).toISOString(),
      raw_source_sha256: inputs.map((item) => item.rawSha256),
    },
    failedTimes,
  };
}

function validateProviderModelIds(results) {
  const byModel = new Map();
  const byProviderId = new Map();
  for (const item of results) {
    const priorId = byModel.get(item.model);
    if (priorId && priorId !== item.provider_model_id) fail(`provider_model_id is inconsistent for ${item.model}`);
    const priorModel = byProviderId.get(item.provider_model_id);
    if (priorModel && priorModel !== item.model) fail('provider_model_id is reused across requested models');
    byModel.set(item.model, item.provider_model_id);
    byProviderId.set(item.provider_model_id, item.model);
  }
}

function verifiedCapabilities() {
  return {
    'gpt-image-2-2-4k': {
      supportsTextToImage: true,
      supportsImageReference: true,
      maxReferences: 1,
      resolutions: ['1k', '2k'],
      quantities: [1],
      aspectRatios: ['1:1'],
    },
    'nano-banana-2': {
      supportsTextToImage: true,
      supportsImageReference: true,
      maxReferences: 1,
      resolutions: ['1k', '2k', '4k'],
      quantities: [1],
      aspectRatios: ['1:1'],
    },
  };
}

async function prepareUsmercariImageReleaseEvidence(options = {}) {
  const sourceFiles = requireArray(options.sourceFiles, 'sourceFiles');
  const rejectionFiles = requireArray(options.rejectionFiles, 'rejectionFiles', 2);
  const assetRootInputs = requireArray(options.assetRoots, 'assetRoots');
  if (typeof options.outputRoot !== 'string' || !options.outputRoot.trim()) fail('outputRoot path is required');
  const outputRoot = path.resolve(options.outputRoot);
  if (fs.existsSync(outputRoot)) fail('outputRoot must not already exist');

  const assetRoots = assetRootInputs.map((item, index) => secureDirectory(item, `assetRoots[${index}]`));
  if (new Set(assetRoots.map(normalizedPath)).size !== assetRoots.length) fail('assetRoots must be unique');
  const sources = sourceFiles.map((item, index) => readRecord(item, `sourceFiles[${index}]`));
  const sourcePaths = new Set(sources.map((item) => normalizedPath(item.file)));
  if (sourcePaths.size !== sources.length) fail('sourceFiles must be unique');

  const collected = [];
  for (const source of sources) {
    const rawResults = [
      ...(Array.isArray(source.record.completed_results) ? source.record.completed_results : []),
      ...(Array.isArray(source.record.results) ? source.record.results : []),
    ];
    for (const item of rawResults) collected.push(await validateResult(item, source.rawSha256, assetRoots));
  }
  const keys = collected.map((item) => resultKey(item.evidence));
  if (collected.length !== REQUIRED_CASES.length || new Set(keys).size !== REQUIRED_CASES.length
      || keys.some((key) => !REQUIRED_KEYS.has(key))) {
    fail('real image results must contain the exact seven-case matrix with no duplicates or extras');
  }
  const byKey = new Map(collected.map((item) => [resultKey(item.evidence), item]));
  const ordered = REQUIRED_CASES.map((item) => byKey.get(item.join('|')));
  if (ordered.some((item) => !item)) fail('real image results are missing a required case');
  validateProviderModelIds(ordered.map((item) => item.evidence));
  const outputs = new Set(ordered.map((item) => item.evidence.output_file));
  const artifactHashes = new Set(ordered.map((item) => item.evidence.sha256));
  if (outputs.size !== ordered.length || artifactHashes.size !== ordered.length) fail('every real image case must use a unique artifact');

  const rejectionRecords = rejectionFiles.map((item, index) => readRecord(item, `rejectionFiles[${index}]`));
  const rejection = validateRejections(rejectionRecords);
  const generatedMilliseconds = Math.max(
    ...ordered.map((item) => item.completedAt),
    ...rejection.failedTimes,
  );
  const generatedAt = new Date(generatedMilliseconds).toISOString();
  const evidence = {
    contract_version: CONTRACT_VERSION,
    provider_origin: PROVIDER_ORIGIN,
    generated_at: generatedAt,
    valid_until: new Date(generatedMilliseconds + VALIDITY_MS).toISOString(),
    results: ordered.map((item) => item.evidence),
    rejected_capabilities: [rejection.evidence],
    verified_capabilities: verifiedCapabilities(),
    pricing: PRICING.map(([model, resolution, cost, credits]) => ({
      model,
      resolution,
      cost_yuan_per_image: cost,
      credits_per_image: credits,
      reviewed: true,
    })),
  };

  const parent = path.dirname(outputRoot);
  fs.mkdirSync(parent, { recursive: true });
  const stagingRoot = path.join(parent, `.${path.basename(outputRoot)}.staging-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  try {
    const publicRoot = path.join(stagingRoot, 'public', 'usmercari');
    fs.mkdirSync(publicRoot, { recursive: true });
    for (const item of ordered) {
      fs.writeFileSync(
        path.join(publicRoot, item.evidence.output_file),
        item.assetBytes,
        { flag: 'wx' },
      );
    }
    fs.writeFileSync(
      path.join(stagingRoot, 'usmercari-image-verification.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: 'wx' },
    );
    fs.renameSync(stagingRoot, outputRoot);
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  return evidence;
}

module.exports = {
  CONTRACT_VERSION,
  REQUIRED_CASES,
  prepareUsmercariImageReleaseEvidence,
};
