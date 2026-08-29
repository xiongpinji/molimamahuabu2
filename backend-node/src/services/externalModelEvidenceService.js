const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EVIDENCE_ALLOWED_ROOT = '/opt/moli-drama/shared/release-evidence';
const EVIDENCE_ROOT = '/opt/moli-drama/shared/release-evidence/external-models-v1';
const MANIFEST_CONTRACT = 'external-model-release-evidence-manifest-v1';
const CONTRACT_BY_MODEL = Object.freeze({
  'seedance-2-fast': 'toapis-video-real-verification-v1',
  'seedance-2-mini': 'toapis-video-real-verification-v1',
  'wan3.0-video': 'toapis-wan3-video-real-verification-v1',
  'gpt-image-2-2-4k': 'usmercari-image-real-verification-v1',
  'nano-banana-2': 'usmercari-image-real-verification-v1',
  'lingjing-video-v1': 'lingjing-video-real-verification-v1',
});
const EVIDENCE_FILE_BY_CONTRACT = Object.freeze({
  'toapis-video-real-verification-v1': 'toapis-video-verification.json',
  'toapis-wan3-video-real-verification-v1': 'toapis-wan3-video-verification.json',
  'usmercari-image-real-verification-v1': 'usmercari-image-verification.json',
  'lingjing-video-real-verification-v1': 'lingjing-video-verification.json',
});
const PUBLIC_PROVIDER_BY_CONTRACT = Object.freeze({
  'toapis-video-real-verification-v1': 'toapis',
  'toapis-wan3-video-real-verification-v1': 'toapis',
  'usmercari-image-real-verification-v1': 'usmercari',
  'lingjing-video-real-verification-v1': 'lingjing',
});

function evidenceContractForModel(model) {
  return CONTRACT_BY_MODEL[String(model || '').trim().toLowerCase()] || null;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.normalize(path.resolve(value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function hasProtectedPermissions(stat, requireRootOwnership) {
  if (process.platform === 'win32') return true;
  if (requireRootOwnership && (stat.uid !== 0 || stat.gid !== 0)) return false;
  return (stat.mode & 0o022) === 0;
}

function securePath(input, type, requireRootOwnership) {
  const lstat = fs.lstatSync(input);
  if (lstat.isSymbolicLink()) return null;
  const real = fs.realpathSync(input);
  if (!samePath(real, input)) return null;
  const stat = fs.statSync(real);
  if ((type === 'directory' && !stat.isDirectory()) || (type === 'file' && !stat.isFile())) return null;
  if (!hasProtectedPermissions(stat, requireRootOwnership)) return null;
  return real;
}

function secureRelativePath(root, relative, type, requireRootOwnership) {
  if (!relative || path.isAbsolute(relative)) return null;
  const target = path.resolve(root, relative);
  if (!isInside(root, target)) return null;
  return securePath(target, type, requireRootOwnership);
}

function evidenceRoots(override) {
  if (override) {
    return {
      configured: String(override.root || '').trim(),
      allowedConfigured: String(override.allowedRoot || '').trim(),
      requireRootOwnership: false,
    };
  }
  return {
    configured: EVIDENCE_ROOT,
    allowedConfigured: EVIDENCE_ALLOWED_ROOT,
    requireRootOwnership: true,
  };
}

function trustedRoot(override) {
  const { configured, allowedConfigured, requireRootOwnership } = evidenceRoots(override);
  if (!configured || !allowedConfigured || !path.isAbsolute(configured) || !path.isAbsolute(allowedConfigured)) return null;
  const allowed = securePath(path.resolve(allowedConfigured), 'directory', requireRootOwnership);
  if (!allowed || !isInside(allowed, path.resolve(configured))) return null;
  const relative = path.relative(path.resolve(allowedConfigured), path.resolve(configured));
  let current = path.resolve(allowedConfigured);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!securePath(current, 'directory', requireRootOwnership)) return null;
  }
  const root = fs.realpathSync(configured);
  if (!isInside(allowed, root)) return null;
  return { root, requireRootOwnership };
}

function hasProtectedPublicAssets(root, contract, evidence, requireRootOwnership) {
  const provider = PUBLIC_PROVIDER_BY_CONTRACT[contract];
  const results = Array.isArray(evidence?.results) ? evidence.results : null;
  if (!provider || !results?.length) return false;
  if (!secureRelativePath(root, 'public', 'directory', requireRootOwnership)
      || !secureRelativePath(root, path.join('public', provider), 'directory', requireRootOwnership)) return false;
  for (const result of results) {
    const outputFile = String(contract === 'usmercari-image-real-verification-v1'
      ? result?.output_file
      : result?.artifact?.output_file || '');
    if (!outputFile || path.basename(outputFile) !== outputFile) return false;
    if (!secureRelativePath(root, path.join('public', provider, outputFile), 'file', requireRootOwnership)) return false;
  }
  return true;
}

function readTrustedEvidence(model, roots) {
  const contract = evidenceContractForModel(model);
  if (!contract) return null;
  try {
    const trusted = trustedRoot(roots);
    if (!trusted) return null;
    const { root, requireRootOwnership } = trusted;
    const manifestPath = secureRelativePath(root, 'manifest.json', 'file', requireRootOwnership);
    if (!manifestPath) return null;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest?.contract_version !== MANIFEST_CONTRACT) return null;
    const record = manifest?.evidence?.[contract];
    const file = String(record?.file || '');
    const expectedSha = String(record?.sha256 || '').toLowerCase();
    if (file !== EVIDENCE_FILE_BY_CONTRACT[contract] || !/^[a-f0-9]{64}$/.test(expectedSha)) return null;
    const evidencePath = secureRelativePath(root, file, 'file', requireRootOwnership);
    if (!evidencePath) return null;
    const evidenceBytes = fs.readFileSync(evidencePath);
    const actualSha = crypto.createHash('sha256').update(evidenceBytes).digest('hex');
    if (actualSha !== expectedSha) return null;
    const evidence = JSON.parse(evidenceBytes.toString('utf8'));
    if (evidence?.contract_version !== contract
        || !hasProtectedPublicAssets(root, contract, evidence, requireRootOwnership)) return null;
    return { contract, sha256: actualSha };
  } catch (_) {
    return null;
  }
}

function hasTrustedEvidenceBinding(model, capabilities, roots) {
  const contract = evidenceContractForModel(model);
  if (!contract) return true;
  const trusted = readTrustedEvidence(model, roots);
  return Boolean(trusted
    && capabilities
    && String(capabilities.evidence_contract || '') === trusted.contract
    && String(capabilities.evidence_sha256 || '').toLowerCase() === trusted.sha256);
}

module.exports = {
  CONTRACT_BY_MODEL,
  EVIDENCE_ALLOWED_ROOT,
  EVIDENCE_ROOT,
  MANIFEST_CONTRACT,
  evidenceContractForModel,
  hasTrustedEvidenceBinding,
  readTrustedEvidence,
};
