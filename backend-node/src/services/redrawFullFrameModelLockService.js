const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const ERROR_CODE = 'REDRAW_FULL_FRAME_MODEL_LOCK_INVALID';
const SOURCE_SCHEMA = 'redraw-full-frame-model-sources-v1';
const COMPONENT_ORDER = Object.freeze([
  'face_detector',
  'person_detector',
  'text_detector',
  'tracker',
]);
const SOURCE_BY_COMPONENT = Object.freeze({
  face_detector: Object.freeze({
    component: 'face_detector',
    project: 'MediaPipe face detection',
    repository: 'google-ai-edge/mediapipe',
    license_path: 'LICENSE',
  }),
  person_detector: Object.freeze({
    component: 'person_detector',
    project: 'YOLOX',
    repository: 'Megvii-BaseDetection/YOLOX',
    license_path: 'LICENSE',
  }),
  text_detector: Object.freeze({
    component: 'text_detector',
    project: 'PaddleOCR',
    repository: 'PaddlePaddle/PaddleOCR',
    license_path: 'LICENSE',
  }),
  tracker: Object.freeze({
    component: 'tracker',
    project: 'ByteTrack',
    repository: 'FoundationVision/ByteTrack',
    license_path: 'LICENSE',
  }),
});
const TOP_LEVEL_KEYS = Object.freeze(['schema_version', 'runtime', 'components']);
const COMPONENT_KEYS = Object.freeze([
  'component',
  'project',
  'repository',
  'revision',
  'artifact_name',
  'artifact_path',
  'artifact_sha256',
  'license_name',
  'license_evidence_path',
  'license_evidence_sha256',
]);
const PLACEHOLDER_VALUES = new Set([
  'latest',
  'main',
  'master',
  'unknown',
  'example',
  'placeholder',
  'todo',
]);
const PLACEHOLDER_TOKENS = ['unknown', 'example', 'placeholder', 'todo'];

class ModelLockInvalidError extends Error {
  constructor() {
    super(ERROR_CODE);
    this.name = 'ModelLockInvalidError';
    this.code = ERROR_CODE;
  }
}

function invalid() {
  return new ModelLockInvalidError();
}

function assertPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
}

function assertExactKeys(value, allowedKeys) {
  assertPlainObject(value);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalid();
  }
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw invalid();
  }
}

function requireConcreteString(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw invalid();
  const normalized = value.toLowerCase();
  if (PLACEHOLDER_VALUES.has(normalized)) throw invalid();
  if (PLACEHOLDER_TOKENS.some((token) => normalized.includes(token))) throw invalid();
  return value;
}

function requireHash(value) {
  requireConcreteString(value);
  if (!/^[a-f0-9]{64}$/.test(value)) throw invalid();
  return value;
}

function assertJsonSerializable(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw invalid();
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertJsonSerializable(item);
    return;
  }
  for (const key of Object.keys(value)) assertJsonSerializable(value[key]);
}

function stableJson(value) {
  assertJsonSerializable(value);
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function canonicalSha256(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function bytesSha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isUnsafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return true;
  if (value.includes('\0')) return true;
  if (value === '.' || value === '..') return true;
  if (/^[A-Za-z]:/.test(value)) return true;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) return true;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return true;
  return false;
}

function requireSafeRelativePath(value) {
  requireConcreteString(value);
  if (isUnsafeRelativePath(value)) throw invalid();
  return value;
}

function isInsideOrSame(rootReal, targetReal) {
  const relative = path.relative(rootReal, targetReal);
  return relative === '' || (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertRegularFile(stat) {
  if (!stat.isFile()) throw invalid();
}

async function secureReadFile({ cacheRootReal, relativePath }) {
  if (isUnsafeRelativePath(relativePath)) throw invalid();
  const target = path.resolve(cacheRootReal, relativePath);
  if (!isInsideOrSame(cacheRootReal, target)) throw invalid();

  const realBefore = await fs.realpath(target);
  if (!isInsideOrSame(cacheRootReal, realBefore)) throw invalid();

  let handle;
  try {
    handle = await fs.open(realBefore, 'r');
    const statBefore = await handle.stat({ bigint: true });
    assertRegularFile(statBefore);
    const bytes = await handle.readFile();
    const statAfter = await handle.stat({ bigint: true });
    assertRegularFile(statAfter);
    const realAfter = await fs.realpath(realBefore);
    if (realAfter !== realBefore) throw invalid();
    if (!sameIdentity(statBefore, statAfter)) throw invalid();
    return bytes;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function validateSourcePolicy(sourcePolicy) {
  assertExactKeys(sourcePolicy, ['schema_version', 'sources']);
  if (sourcePolicy.schema_version !== SOURCE_SCHEMA) throw invalid();
  if (!Array.isArray(sourcePolicy.sources) || sourcePolicy.sources.length !== COMPONENT_ORDER.length) throw invalid();

  const seen = new Set();
  for (const source of sourcePolicy.sources) {
    assertExactKeys(source, ['component', 'project', 'repository', 'license_path']);
    const expected = SOURCE_BY_COMPONENT[source.component];
    if (!expected || seen.has(source.component)) throw invalid();
    seen.add(source.component);
    for (const key of ['component', 'project', 'repository', 'license_path']) {
      if (source[key] !== expected[key]) throw invalid();
    }
  }
  for (const component of COMPONENT_ORDER) {
    if (!seen.has(component)) throw invalid();
  }
}

function canonicalizeComponent(component) {
  assertExactKeys(component, COMPONENT_KEYS);
  const expected = SOURCE_BY_COMPONENT[component.component];
  if (!expected) throw invalid();
  if (component.project !== expected.project || component.repository !== expected.repository) throw invalid();

  return {
    component: component.component,
    project: component.project,
    repository: component.repository,
    revision: requireConcreteString(component.revision),
    artifact_name: requireConcreteString(component.artifact_name),
    artifact_path: requireSafeRelativePath(component.artifact_path),
    artifact_sha256: requireHash(component.artifact_sha256),
    license_name: requireConcreteString(component.license_name),
    license_evidence_path: requireSafeRelativePath(component.license_evidence_path),
    license_evidence_sha256: requireHash(component.license_evidence_sha256),
  };
}

function canonicalizeModelLock(lock) {
  assertExactKeys(lock, TOP_LEVEL_KEYS);
  assertJsonSerializable(lock.runtime);
  if (!lock.runtime || typeof lock.runtime !== 'object' || Array.isArray(lock.runtime)) throw invalid();
  if (!Array.isArray(lock.components) || lock.components.length !== COMPONENT_ORDER.length) throw invalid();

  const byComponent = new Map();
  for (const component of lock.components) {
    const canonical = canonicalizeComponent(component);
    if (byComponent.has(canonical.component)) throw invalid();
    byComponent.set(canonical.component, canonical);
  }

  const components = COMPONENT_ORDER.map((component) => {
    const found = byComponent.get(component);
    if (!found) throw invalid();
    return found;
  });

  return {
    schema_version: requireConcreteString(lock.schema_version),
    runtime: JSON.parse(stableJson(lock.runtime)),
    components,
  };
}

async function validateModelLock({ cacheRoot, sourcePolicy, lock }) {
  try {
    if (typeof cacheRoot !== 'string' || cacheRoot.length === 0) throw invalid();
    validateSourcePolicy(sourcePolicy);
    const cacheRootReal = await fs.realpath(cacheRoot);
    const cacheRootStat = await fs.stat(cacheRootReal);
    if (!cacheRootStat.isDirectory()) throw invalid();
    const canonical = canonicalizeModelLock(lock);

    for (const component of canonical.components) {
      const artifact = await secureReadFile({ cacheRootReal, relativePath: component.artifact_path });
      if (bytesSha256(artifact) !== component.artifact_sha256) throw invalid();
      const license = await secureReadFile({ cacheRootReal, relativePath: component.license_evidence_path });
      if (bytesSha256(license) !== component.license_evidence_sha256) throw invalid();
    }

    return {
      ...canonical,
      canonical_sha256: canonicalSha256(canonical),
    };
  } catch (_) {
    throw invalid();
  }
}

module.exports = {
  validateModelLock,
  canonicalizeModelLock,
  canonicalSha256,
};
