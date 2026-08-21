const crypto = require('node:crypto');
const fs = require('node:fs');

const SUPPORTED_LOCALE = 'en-US';
const SUPPORTED_PACK = 'en-US@1';

function createRedrawLocalePackRegistry(options = {}) {
  if (options.enabled === false) {
    return createDisabledRedrawLocaleVerifier();
  }
  const deps = {
    fs: options.fs || fs,
    now: options.now || Date.now,
    isProcessAlive: options.isProcessAlive || isProcessAlive,
    isSocketPath: options.isSocketPath || ((socketPath) => deps.fs.statSync(socketPath).isSocket()),
  };
  const paths = {
    registryPath: options.registryPath,
    signaturePath: options.signaturePath,
    publicKeyPath: options.publicKeyPath,
    readyPath: options.readyPath,
    socketPath: options.socketPath,
  };

  function assertReady(locale) {
    const pack = requireEnabledPack(locale);
    const ready = readJson(paths.readyPath);
    const currentSeconds = Math.floor(Number(deps.now()) / 1000);
    if (Number(ready.expires_at) <= currentSeconds
      || ready.locale_pack !== pack.id
      || ready.model_manifest_sha256 !== pack.model_manifest_sha256
      || ready.calibration_manifest_sha256 !== pack.calibration_manifest_sha256
      || (ready.manifest_sha256 && ready.manifest_sha256 !== manifestHash())
      || !deps.isProcessAlive(Number(ready.pid))
      || !deps.isSocketPath(paths.socketPath)) {
      throw notReady();
    }
    return { ...pack };
  }

  function requireEnabledPack(locale) {
    if (locale !== SUPPORTED_LOCALE) {
      throw notReady();
    }
    const manifest = verifiedManifest();
    if (!Array.isArray(manifest.enabled_packs)) {
      throw notReady();
    }
    const packs = manifest.enabled_packs.filter((pack) => pack && pack.id === SUPPORTED_PACK);
    if (packs.length !== 1) {
      throw notReady();
    }
    const pack = packs[0];
    if (pack.locale !== SUPPORTED_LOCALE
      || !isHexSha256(pack.model_manifest_sha256)
      || !isHexSha256(pack.calibration_manifest_sha256)
      || manifest.enabled_packs.some((item) => item && item.id !== SUPPORTED_PACK)) {
      throw notReady();
    }
    return {
      id: pack.id,
      locale: pack.locale,
      model_manifest_sha256: pack.model_manifest_sha256,
      calibration_manifest_sha256: pack.calibration_manifest_sha256,
    };
  }

  function assertEvidenceTrusted(evidence = {}) {
    const pack = requireEnabledPack(SUPPORTED_LOCALE);
    if (evidence.source !== 'offline-worker'
      || evidence.locale_pack !== pack.id
      || evidence.model_manifest_sha256 !== pack.model_manifest_sha256
      || evidence.calibration_manifest_sha256 !== pack.calibration_manifest_sha256) {
      throw notReady();
    }
    return evidence;
  }

  function verifiedManifest() {
    try {
      const manifest = readJson(paths.registryPath);
      const signature = Buffer.from(String(deps.fs.readFileSync(paths.signaturePath, 'utf8')).trim(), 'base64');
      const publicKey = deps.fs.readFileSync(paths.publicKeyPath);
      if (!crypto.verify(null, canonicalPayload(manifest), publicKey, signature)) {
        throw notReady();
      }
      return manifest;
    } catch {
      throw notReady();
    }
  }

  function manifestHash() {
    return crypto.createHash('sha256').update(canonicalPayload(verifiedManifest())).digest('hex');
  }

  function readJson(filePath) {
    try {
      return JSON.parse(deps.fs.readFileSync(filePath, 'utf8'));
    } catch {
      throw notReady();
    }
  }

  return {
    assertReady,
    requireEnabledPack,
    assertEvidenceTrusted,
  };
}

function createDisabledRedrawLocaleVerifier() {
  return {
    assertReady() {
      throw codedError('REDRAW_LOCALE_VERIFIER_DISABLED', '语言验证 Worker 已关闭');
    },
    async verify() {
      throw codedError('REDRAW_LOCALE_VERIFIER_DISABLED', '语言验证 Worker 已关闭');
    },
    assertEvidenceTrusted() {
      throw codedError('REDRAW_LOCALE_VERIFIER_DISABLED', '语言验证 Worker 已关闭');
    },
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalPayload(value) {
  return Buffer.from(JSON.stringify(canonicalize(value)), 'utf8');
}

function isHexSha256(value) {
  return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function notReady() {
  return codedError('REDRAW_LOCALE_VERIFIER_NOT_READY', '语言验证 Worker 未就绪');
}

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  SUPPORTED_LOCALE,
  SUPPORTED_PACK,
  canonicalPayload,
  createDisabledRedrawLocaleVerifier,
  createRedrawLocalePackRegistry,
};
