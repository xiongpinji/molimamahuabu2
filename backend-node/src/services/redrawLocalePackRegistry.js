const crypto = require('node:crypto');
const fs = require('node:fs');

const SUPPORTED_LOCALE = 'en-US';
const SUPPORTED_PACK = 'en-US@1';
const MODERN_PACK_FIELDS = [
  'id',
  'language',
  'locale',
  'scope',
  'prompt_language_label',
  'model_manifest_sha256',
  'calibration_manifest_sha256',
  'thresholds',
];
const NATIVE_THRESHOLD_FIELDS = [
  'dialogue_similarity_min',
  'language_probability_min',
  'speech_chars_per_second_max',
];

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

  function assertReady(expected) {
    const state = readRegistryState();
    const pack = resolveExpectedPack(state.packs, expected);
    const ready = readJson(paths.readyPath);
    assertReadyAttestation(ready, state);
    return clonePack(pack);
  }

  function listReadyPacks() {
    const state = readRegistryState();
    const ready = readJson(paths.readyPath);
    assertReadyAttestation(ready, state);
    return state.packs.map(clonePack);
  }

  function requireEnabledPack(expected) {
    return clonePack(resolveExpectedPack(readRegistryState().packs, expected));
  }

  function assertEvidenceTrusted(evidence = {}, expected = SUPPORTED_LOCALE) {
    const pack = resolveExpectedPack(readRegistryState().packs, expected);
    if (evidence.source !== 'offline-worker'
      || evidence.locale_pack !== pack.id
      || evidence.model_manifest_sha256 !== pack.model_manifest_sha256
      || evidence.calibration_manifest_sha256 !== pack.calibration_manifest_sha256) {
      throw notReady();
    }
    if (!pack.legacy) {
      if (evidence.detected_language !== pack.language
        || evidence.language_verified !== true
        || (pack.scope === 'language'
          && (evidence.detected_locale !== null || evidence.locale_verified !== false))
        || (pack.scope === 'locale' && evidence.detected_locale !== pack.locale)) {
        throw notReady();
      }
    }
    return evidence;
  }

  function readRegistryState() {
    const manifest = verifiedManifest();
    const packs = validateEnabledPacks(manifest);
    return {
      packs,
      manifestSha256: crypto.createHash('sha256').update(canonicalPayload(manifest)).digest('hex'),
    };
  }

  function assertReadyAttestation(ready, state) {
    const currentSeconds = Math.floor(Number(deps.now()) / 1000);
    const topLevelPack = state.packs.find((pack) => pack.id === SUPPORTED_PACK)
      || (state.packs.length === 1 ? state.packs[0] : null);
    if (!ready || typeof ready !== 'object' || Array.isArray(ready)
      || typeof ready.expires_at !== 'number'
      || !Number.isFinite(ready.expires_at)
      || ready.expires_at <= currentSeconds
      || !Number.isInteger(ready.pid)
      || ready.pid <= 0
      || !topLevelPack
      || ready.locale_pack !== topLevelPack.id
      || ready.model_manifest_sha256 !== topLevelPack.model_manifest_sha256
      || ready.calibration_manifest_sha256 !== topLevelPack.calibration_manifest_sha256
      || (Object.hasOwn(ready, 'manifest_sha256')
        && ready.manifest_sha256 !== state.manifestSha256)
      || !safeProbe(deps.isProcessAlive, ready.pid)
      || !safeProbe(deps.isSocketPath, paths.socketPath)) {
      throw notReady();
    }

    const hasPackIds = Object.hasOwn(ready, 'enabled_pack_ids');
    const hasAttestations = Object.hasOwn(ready, 'pack_attestations');
    if (hasPackIds !== hasAttestations || (!hasPackIds && state.packs.length !== 1)) {
      throw notReady();
    }
    if (!hasPackIds) return;

    const expectedIds = state.packs.map((pack) => pack.id);
    if (!Array.isArray(ready.enabled_pack_ids)
      || !sameArray(ready.enabled_pack_ids, expectedIds)
      || !Array.isArray(ready.pack_attestations)
      || ready.pack_attestations.length !== state.packs.length) {
      throw notReady();
    }
    for (let index = 0; index < state.packs.length; index += 1) {
      const pack = state.packs[index];
      const attestation = ready.pack_attestations[index];
      if (!attestation || typeof attestation !== 'object'
        || !sameArray(Object.keys(attestation).sort(), [
          'calibration_manifest_sha256',
          'id',
          'model_manifest_sha256',
        ])
        || attestation.id !== pack.id
        || attestation.model_manifest_sha256 !== pack.model_manifest_sha256
        || attestation.calibration_manifest_sha256 !== pack.calibration_manifest_sha256) {
        throw notReady();
      }
    }
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
    listReadyPacks,
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
    async verifyNativeAudio() {
      throw codedError('REDRAW_LOCALE_VERIFIER_DISABLED', '语言验证 Worker 已关闭');
    },
    assertEvidenceTrusted() {
      throw codedError('REDRAW_LOCALE_VERIFIER_DISABLED', '语言验证 Worker 已关闭');
    },
    listReadyPacks() {
      throw codedError('REDRAW_LOCALE_VERIFIER_DISABLED', '语言验证 Worker 已关闭');
    },
  };
}

function validateEnabledPacks(manifest) {
  if (!manifest || typeof manifest !== 'object'
    || manifest.schema_version !== 1
    || !Array.isArray(manifest.enabled_packs)
    || manifest.enabled_packs.length === 0) {
    throw notReady();
  }
  const ids = new Set();
  const identities = new Set();
  const packs = manifest.enabled_packs.map(projectPack);
  for (const pack of packs) {
    const identity = `${pack.language || ''}\u0000${pack.scope || ''}\u0000${pack.locale || ''}`;
    if (ids.has(pack.id) || identities.has(identity)) {
      throw notReady();
    }
    ids.add(pack.id);
    identities.add(identity);
  }
  return packs.sort((left, right) => {
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
}

function projectPack(pack) {
  if (!pack || typeof pack !== 'object'
    || typeof pack.id !== 'string'
    || !pack.id.trim()
    || !isHexSha256(pack.model_manifest_sha256)
    || !isHexSha256(pack.calibration_manifest_sha256)) {
    throw notReady();
  }
  const modernFieldCount = ['language', 'scope', 'prompt_language_label']
    .filter((field) => Object.hasOwn(pack, field)).length;
  if (modernFieldCount === 0 && pack.id === SUPPORTED_PACK && pack.locale === SUPPORTED_LOCALE) {
    return {
      id: pack.id,
      locale: pack.locale,
      model_manifest_sha256: pack.model_manifest_sha256,
      calibration_manifest_sha256: pack.calibration_manifest_sha256,
      legacy: true,
    };
  }
  if (modernFieldCount !== 3
    || !sameArray(Object.keys(pack).sort(), [...MODERN_PACK_FIELDS].sort())
    || !/^[a-z]{2,8}$/.test(String(pack.language || ''))
    || !['language', 'locale'].includes(pack.scope)
    || typeof pack.prompt_language_label !== 'string'
    || !pack.prompt_language_label.trim()
    || !validScopeLocale(pack)
    || !validNativeThresholds(pack.thresholds)) {
    throw notReady();
  }
  return Object.fromEntries(MODERN_PACK_FIELDS.map((field) => [
    field,
    field === 'thresholds' ? { ...pack[field] } : pack[field],
  ]));
}

function validScopeLocale(pack) {
  if (pack.scope === 'language') return pack.locale === null;
  return typeof pack.locale === 'string'
    && new RegExp(`^${pack.language}-(?:[A-Za-z0-9]{1,8})(?:-[A-Za-z0-9]{1,8})*$`).test(pack.locale);
}

function validNativeThresholds(thresholds) {
  if (!thresholds || typeof thresholds !== 'object'
    || !sameArray(Object.keys(thresholds).sort(), NATIVE_THRESHOLD_FIELDS)) {
    return false;
  }
  const languageProbability = thresholds.language_probability_min;
  const dialogueSimilarity = thresholds.dialogue_similarity_min;
  const speechCharsPerSecond = thresholds.speech_chars_per_second_max;
  return typeof languageProbability === 'number'
    && Number.isFinite(languageProbability)
    && languageProbability >= 0
    && languageProbability <= 1
    && typeof dialogueSimilarity === 'number'
    && Number.isFinite(dialogueSimilarity)
    && dialogueSimilarity >= 0
    && dialogueSimilarity <= 1
    && typeof speechCharsPerSecond === 'number'
    && Number.isFinite(speechCharsPerSecond)
    && speechCharsPerSecond > 0;
}

function resolveExpectedPack(packs, expected) {
  let matches;
  if (typeof expected === 'string') {
    matches = packs.filter((pack) => pack.locale === expected);
  } else if (expected && typeof expected === 'object') {
    const allowedFields = new Set([
      'calibrationManifestSha256',
      'calibration_manifest_sha256',
      'language',
      'locale',
      'modelManifestSha256',
      'model_manifest_sha256',
      'packId',
      'scope',
    ]);
    const keys = Object.keys(expected);
    if (keys.length === 0 || keys.some((key) => !allowedFields.has(key))) throw notReady();
    matches = packs.filter((pack) => (
      (!Object.hasOwn(expected, 'packId') || pack.id === expected.packId)
      && (!Object.hasOwn(expected, 'language') || pack.language === expected.language)
      && (!Object.hasOwn(expected, 'locale') || pack.locale === expected.locale)
      && (!Object.hasOwn(expected, 'scope') || pack.scope === expected.scope)
      && (!Object.hasOwn(expected, 'modelManifestSha256')
        || pack.model_manifest_sha256 === expected.modelManifestSha256)
      && (!Object.hasOwn(expected, 'model_manifest_sha256')
        || pack.model_manifest_sha256 === expected.model_manifest_sha256)
      && (!Object.hasOwn(expected, 'calibrationManifestSha256')
        || pack.calibration_manifest_sha256 === expected.calibrationManifestSha256)
      && (!Object.hasOwn(expected, 'calibration_manifest_sha256')
        || pack.calibration_manifest_sha256 === expected.calibration_manifest_sha256)
    ));
  } else {
    throw notReady();
  }
  if (matches.length !== 1) throw notReady();
  return matches[0];
}

function clonePack(pack) {
  const clone = { ...pack };
  delete clone.legacy;
  if (pack.thresholds) clone.thresholds = { ...pack.thresholds };
  return clone;
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function safeProbe(probe, value) {
  try {
    return probe(value) === true;
  } catch {
    return false;
  }
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
