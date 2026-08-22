'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EXCLUDED_PREFIXES = [
  '.git',
  'backend-node/node_modules',
  'frontweb/dist',
  'frontweb/node_modules',
];

function releaseGateError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizeRelativePath(value) {
  const raw = String(value || '').replaceAll('\\', '/');
  const normalized = path.posix.normalize(raw);
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)
    || normalized === '..' || normalized.startsWith('../') || normalized !== raw) {
    throw releaseGateError('INVALID_MANIFEST', `非法发布路径: ${value}`);
  }
  if (EXCLUDED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    throw releaseGateError('INVALID_MANIFEST', `发布白名单不能包含忽略目录: ${normalized}`);
  }
  return normalized;
}

function loadManifest(manifestPath, expectedManifestSha256) {
  const content = fs.readFileSync(manifestPath);
  const actualSha256 = crypto.createHash('sha256').update(content).digest('hex');
  if (expectedManifestSha256 && actualSha256 !== expectedManifestSha256) {
    throw releaseGateError('MANIFEST_SHA256_MISMATCH', '发布清单哈希不匹配', {
      expected: expectedManifestSha256,
      actual: actualSha256,
    });
  }

  let manifest;
  try {
    manifest = JSON.parse(content.toString('utf8'));
  } catch (error) {
    throw releaseGateError('INVALID_MANIFEST', `发布清单不是有效 JSON: ${error.message}`);
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.allowedPaths) || manifest.allowedPaths.length === 0) {
    throw releaseGateError('INVALID_MANIFEST', '发布清单必须使用 schemaVersion=1 且包含 allowedPaths');
  }
  const allowedPaths = manifest.allowedPaths.map(normalizeRelativePath);
  if (new Set(allowedPaths).size !== allowedPaths.length) {
    throw releaseGateError('INVALID_MANIFEST', '发布清单包含重复路径');
  }
  return { manifest, allowedPaths, actualSha256 };
}

function isExcluded(relativePath) {
  return EXCLUDED_PREFIXES.some((prefix) => (
    relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  ));
}

function collectEntries(rootPath, relativePath = '', entries = new Map()) {
  const absolutePath = relativePath
    ? path.join(rootPath, ...relativePath.split('/'))
    : rootPath;
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (isExcluded(childRelativePath)) continue;
    const childAbsolutePath = path.join(absolutePath, entry.name);
    if (entry.isDirectory()) {
      collectEntries(rootPath, childRelativePath, entries);
    } else if (entry.isSymbolicLink()) {
      entries.set(childRelativePath, { type: 'symlink', target: fs.readlinkSync(childAbsolutePath) });
    } else if (entry.isFile()) {
      entries.set(childRelativePath, {
        type: 'file',
        size: fs.statSync(childAbsolutePath).size,
        absolutePath: childAbsolutePath,
      });
    } else {
      entries.set(childRelativePath, { type: 'other' });
    }
  }
  return entries;
}

function entriesEqual(parentEntry, candidateEntry) {
  if (!parentEntry || !candidateEntry || parentEntry.type !== candidateEntry.type) return false;
  if (parentEntry.type === 'symlink') return parentEntry.target === candidateEntry.target;
  if (parentEntry.type !== 'file') return true;
  return parentEntry.size === candidateEntry.size
    && sha256(parentEntry.absolutePath) === sha256(candidateEntry.absolutePath);
}

function verifyCurrent(expectedCurrent, currentLink) {
  if (!expectedCurrent && !currentLink) return;
  if (!expectedCurrent || !currentLink) {
    throw releaseGateError('INVALID_ARGUMENTS', '--expected-current 与 --current-link 必须同时提供');
  }
  const expected = fs.realpathSync(expectedCurrent);
  const actual = fs.realpathSync(currentLink);
  if (actual !== expected) {
    throw releaseGateError('CURRENT_CHANGED', '线上 current 已变化，必须从新版本重建候选', { expected, actual });
  }
}

function verifyIncrementalReleaseScope(options) {
  const parentRoot = fs.realpathSync(options.parentRoot);
  const candidateRoot = fs.realpathSync(options.candidateRoot);
  if (parentRoot === candidateRoot) {
    throw releaseGateError('INVALID_ARGUMENTS', '父版本与候选版本不能是同一目录');
  }
  verifyCurrent(options.expectedCurrent, options.currentLink);

  const { manifest, allowedPaths, actualSha256 } = loadManifest(
    options.manifestPath,
    options.expectedManifestSha256,
  );
  const allowed = new Set(allowedPaths);
  const parentEntries = collectEntries(parentRoot);
  const candidateEntries = collectEntries(candidateRoot);
  const allPaths = [...new Set([...parentEntries.keys(), ...candidateEntries.keys()])].sort();
  const changedPaths = allPaths.filter((relativePath) => (
    !entriesEqual(parentEntries.get(relativePath), candidateEntries.get(relativePath))
  ));
  const unexpectedPaths = changedPaths.filter((relativePath) => !allowed.has(relativePath));
  if (unexpectedPaths.length > 0) {
    throw releaseGateError('SCOPE_VIOLATION', '候选版本包含白名单外改动', {
      unexpectedPaths,
      changedPaths,
    });
  }

  return {
    ready: true,
    gate: 'incremental-release-scope-v1',
    release: manifest.release || null,
    manifestSha256: actualSha256,
    allowedPaths,
    changedPaths,
  };
}

function parseArguments(argv) {
  const options = {};
  const keyMap = {
    '--parent': 'parentRoot',
    '--candidate': 'candidateRoot',
    '--manifest': 'manifestPath',
    '--manifest-sha256': 'expectedManifestSha256',
    '--expected-current': 'expectedCurrent',
    '--current-link': 'currentLink',
  };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!keyMap[key] || !value) throw releaseGateError('INVALID_ARGUMENTS', `未知或缺少参数: ${key}`);
    options[keyMap[key]] = value;
  }
  for (const required of ['parentRoot', 'candidateRoot', 'manifestPath']) {
    if (!options[required]) throw releaseGateError('INVALID_ARGUMENTS', `缺少参数: ${required}`);
  }
  return options;
}

function runCli(argv) {
  try {
    process.stdout.write(`${JSON.stringify(verifyIncrementalReleaseScope(parseArguments(argv)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ready: false,
      gate: 'incremental-release-scope-v1',
      error: error.code || 'INCREMENTAL_RELEASE_SCOPE_FAILED',
      message: error.message,
      ...error.details,
    })}\n`);
    process.exitCode = error.code === 'CURRENT_CHANGED' ? 73 : 1;
  }
}

if (require.main === module) runCli(process.argv.slice(2));

module.exports = {
  EXCLUDED_PREFIXES,
  loadManifest,
  verifyIncrementalReleaseScope,
};
