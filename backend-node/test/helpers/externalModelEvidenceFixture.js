const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONTRACT_BY_MODEL = Object.freeze({
  'seedance-2-fast': 'toapis-video-real-verification-v1',
  'seedance-2-mini': 'toapis-video-real-verification-v1',
  'gpt-image-2-2-4k': 'usmercari-image-real-verification-v1',
  'nano-banana-2': 'usmercari-image-real-verification-v1',
});

const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'external-model-test-evidence-'));
const evidenceRoot = path.join(allowedRoot, 'external-models-v1');
fs.mkdirSync(path.join(evidenceRoot, 'public', 'toapis'), { recursive: true, mode: 0o755 });
fs.mkdirSync(path.join(evidenceRoot, 'public', 'usmercari'), { recursive: true, mode: 0o755 });

const evidence = {};
for (const [contract, file, provider, outputFile, result] of [
  [
    'toapis-video-real-verification-v1',
    'toapis-video-verification.json',
    'toapis',
    'video.mp4',
    { artifact: { output_file: 'video.mp4' } },
  ],
  [
    'usmercari-image-real-verification-v1',
    'usmercari-image-verification.json',
    'usmercari',
    'image.jpg',
    { output_file: 'image.jpg' },
  ],
]) {
  const bytes = Buffer.from(JSON.stringify({ contract_version: contract, results: [result] }));
  fs.writeFileSync(path.join(evidenceRoot, file), bytes, { mode: 0o644 });
  fs.writeFileSync(path.join(evidenceRoot, 'public', provider, outputFile), `${contract}\n`, { mode: 0o644 });
  evidence[contract] = {
    file,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}
fs.writeFileSync(path.join(evidenceRoot, 'manifest.json'), JSON.stringify({
  contract_version: 'external-model-release-evidence-manifest-v1',
  evidence,
}), { mode: 0o644 });
if (process.platform !== 'win32') {
  for (const directory of [
    allowedRoot,
    evidenceRoot,
    path.join(evidenceRoot, 'public'),
    path.join(evidenceRoot, 'public', 'toapis'),
    path.join(evidenceRoot, 'public', 'usmercari'),
  ]) fs.chmodSync(directory, 0o755);
}

function withExternalModelEvidence(model, capabilities) {
  const contract = CONTRACT_BY_MODEL[String(model || '').trim().toLowerCase()];
  if (!contract) return { ...capabilities };
  return {
    ...capabilities,
    evidence_contract: contract,
    evidence_sha256: evidence[contract].sha256,
  };
}

process.once('exit', () => {
  try { fs.rmSync(allowedRoot, { recursive: true, force: true }); } catch (_) {}
});

module.exports = {
  evidenceRoots: Object.freeze({ allowedRoot, root: evidenceRoot }),
  withExternalModelEvidence,
};
