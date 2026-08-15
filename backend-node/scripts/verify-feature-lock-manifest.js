'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const VALID_STATUSES = new Set(['locked_pass', 'locked_fixed', 'blocked']);
const DEFAULT_MANIFEST = 'docs/verification/platform-stability/feature-lock-manifest.json';

function gateError(message, details = []) {
  const error = new Error(message);
  error.code = 'INVALID_FEATURE_LOCK_MANIFEST';
  error.details = details;
  return error;
}

function normalizePath(value, field) {
  const raw = String(value || '').replaceAll('\\', '/');
  const normalized = path.posix.normalize(raw);
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)
    || normalized === '..' || normalized.startsWith('../') || normalized !== raw) {
    throw gateError(`${field} 包含非法路径: ${value}`);
  }
  return normalized;
}

function nonEmptyStrings(values) {
  return Array.isArray(values) && values.length > 0
    && values.every((value) => typeof value === 'string' && value.trim().length > 0);
}

function validateUnlock(unlock, repoRoot) {
  if (!unlock || typeof unlock !== 'object' || Array.isArray(unlock)) return false;
  if (!String(unlock.reason || '').trim() || !String(unlock.approvedBy || '').trim()) return false;
  if (!nonEmptyStrings(unlock.impactTests)) return false;
  return unlock.impactTests.every((testPath) => {
    const normalized = normalizePath(testPath, 'unlock.impactTests');
    return fs.existsSync(path.join(repoRoot, ...normalized.split('/')));
  });
}

function validateManifest(manifest, repoRoot) {
  const errors = [];
  if (!manifest || manifest.schemaVersion !== 1) errors.push('schemaVersion 必须为 1');
  if (!/^[0-9a-f]{40}$/i.test(String(manifest?.baselineCommit || ''))) {
    errors.push('baselineCommit 必须为完整提交 SHA');
  }
  if (!Array.isArray(manifest?.features) || manifest.features.length === 0) {
    errors.push('features 不能为空');
  }
  const ids = new Set();
  for (const [index, feature] of (manifest?.features || []).entries()) {
    const prefix = `features[${index}]`;
    const featureId = String(feature?.featureId || '').trim();
    if (!featureId || ids.has(featureId)) errors.push(`${prefix}.featureId 缺失或重复`);
    ids.add(featureId);
    if (!String(feature?.module || '').trim()) errors.push(`${prefix}.module 不能为空`);
    if (!VALID_STATUSES.has(feature?.status)) errors.push(`${prefix}.status 无效`);
    if (!nonEmptyStrings(feature?.acceptance)) errors.push(`${prefix}.acceptance 不能为空`);
    for (const field of ['protectedPaths', 'requiredTests', 'evidence']) {
      if (!nonEmptyStrings(feature?.[field])) {
        errors.push(`${prefix}.${field} 不能为空`);
        continue;
      }
      for (const value of feature[field]) {
        try {
          const normalized = normalizePath(value, `${prefix}.${field}`);
          if (!fs.existsSync(path.join(repoRoot, ...normalized.split('/')))) {
            errors.push(`${prefix}.${field} 不存在: ${normalized}`);
          }
        } catch (error) {
          errors.push(error.message);
        }
      }
    }
    if (feature.fixCommit != null && !/^[0-9a-f]{40}$/i.test(String(feature.fixCommit))) {
      errors.push(`${prefix}.fixCommit 必须为 null 或完整提交 SHA`);
    }
    if (feature.unlock != null && !validateUnlock(feature.unlock, repoRoot)) {
      errors.push(`${prefix}.unlock 缺少原因、批准者或有效影响测试`);
    }
  }
  if (errors.length) throw gateError('功能锁定清单校验失败', errors);
  return manifest;
}

function verifyFeatureLock({ repoRoot, currentManifest, baseManifest, changedPaths = [] }) {
  validateManifest(currentManifest, repoRoot);
  if (baseManifest) {
    const currentById = new Map(currentManifest.features.map((feature) => [feature.featureId, feature]));
    const changed = new Set(changedPaths.map((entry) => normalizePath(entry, 'changedPaths')));
    const violations = [];
    for (const baseFeature of baseManifest.features || []) {
      if (!String(baseFeature.status || '').startsWith('locked_')) continue;
      const touched = (baseFeature.protectedPaths || []).filter((entry) => changed.has(entry));
      if (!touched.length) continue;
      const currentFeature = currentById.get(baseFeature.featureId);
      if (!currentFeature || !validateUnlock(currentFeature.unlock, repoRoot)) {
        violations.push({ featureId: baseFeature.featureId, touched });
      }
    }
    if (violations.length) {
      const error = new Error('已锁定功能被修改但缺少有效解锁记录');
      error.code = 'FEATURE_LOCKED';
      error.details = violations;
      throw error;
    }
  }
  return {
    ready: true,
    gate: 'feature-lock-manifest-v1',
    schemaVersion: currentManifest.schemaVersion,
    features: currentManifest.features.length,
    changedPaths: changedPaths.length,
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw gateError(`无法读取功能锁定清单: ${error.message}`);
  }
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function discoverBaseRef(repoRoot, explicitBaseRef) {
  const candidates = [
    explicitBaseRef,
    process.env.FEATURE_LOCK_BASE_REF,
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null,
    'HEAD^',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      git(repoRoot, ['rev-parse', '--verify', candidate]);
      return candidate;
    } catch (_) {}
  }
  return null;
}

function loadBaseManifest(repoRoot, baseRef, manifestRelativePath) {
  if (!baseRef) return null;
  try {
    return JSON.parse(git(repoRoot, ['show', `${baseRef}:${manifestRelativePath}`]));
  } catch (_) {
    return null;
  }
}

function changedPathsSince(repoRoot, baseRef) {
  if (!baseRef) return [];
  return git(repoRoot, ['diff', '--name-only', baseRef, '--'])
    .split(/\r?\n/)
    .map((entry) => entry.trim().replaceAll('\\', '/'))
    .filter(Boolean);
}

function loadAndVerifyCurrentManifest(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..', '..'));
  const manifestPath = path.resolve(options.manifestPath || path.join(repoRoot, DEFAULT_MANIFEST));
  const manifestRelativePath = path.relative(repoRoot, manifestPath).replaceAll('\\', '/');
  const currentManifest = readJson(manifestPath);
  const baseRef = options.baseRef || discoverBaseRef(repoRoot);
  const baseManifest = Object.prototype.hasOwnProperty.call(options, 'baseManifest')
    ? options.baseManifest
    : loadBaseManifest(repoRoot, baseRef, manifestRelativePath);
  const changedPaths = options.changedPaths || (baseManifest ? changedPathsSince(repoRoot, baseRef) : []);
  return {
    ...verifyFeatureLock({ repoRoot, currentManifest, baseManifest, changedPaths }),
    baseRef,
    protectedFeaturesFromBase: baseManifest?.features?.length || 0,
  };
}

function runCli(argv) {
  const baseIndex = argv.indexOf('--base');
  if (baseIndex !== -1 && !argv[baseIndex + 1]) {
    process.stderr.write(`${JSON.stringify({ ready: false, error: 'INVALID_ARGUMENTS' })}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(loadAndVerifyCurrentManifest({
      baseRef: baseIndex === -1 ? undefined : argv[baseIndex + 1],
    }))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ready: false,
      gate: 'feature-lock-manifest-v1',
      error: error.code || 'FEATURE_LOCK_AUDIT_FAILED',
      message: error.message,
      details: error.details || [],
    })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) runCli(process.argv.slice(2));

module.exports = {
  loadAndVerifyCurrentManifest,
  validateManifest,
  verifyFeatureLock,
};
