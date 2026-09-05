const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  EVIDENCE_ALLOWED_ROOT,
  EVIDENCE_ROOT,
  evidenceContractForModel,
  hasTrustedEvidenceBinding,
  readTrustedEvidence,
} = require('../src/services/externalModelEvidenceService');

function createEvidenceRoot() {
  const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'external-model-evidence-'));
  const root = path.join(allowedRoot, 'bundles', 'external-models-v1');
  fs.mkdirSync(path.join(root, 'public', 'toapis'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(root, 'public', 'usmercari'), { recursive: true, mode: 0o755 });
  const records = {
    'toapis-video-real-verification-v1': {
      file: 'toapis-video-verification.json',
      provider: 'toapis',
      outputFile: 'video.mp4',
      body: { results: [{ artifact: { output_file: 'video.mp4' } }] },
    },
    'usmercari-image-real-verification-v1': {
      file: 'usmercari-image-verification.json',
      provider: 'usmercari',
      outputFile: 'image.jpg',
      body: { results: [{ output_file: 'image.jpg' }] },
    },
  };
  const evidence = {};
  for (const [contract, record] of Object.entries(records)) {
    const bytes = Buffer.from(JSON.stringify({ contract_version: contract, ...record.body }));
    fs.writeFileSync(path.join(root, record.file), bytes, { mode: 0o644 });
    fs.writeFileSync(path.join(root, 'public', record.provider, record.outputFile), `${contract}\n`, { mode: 0o644 });
    evidence[contract] = {
      file: record.file,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    contract_version: 'external-model-release-evidence-manifest-v1',
    evidence,
  }), { mode: 0o644 });
  if (process.platform !== 'win32') {
    for (const directory of [
      allowedRoot,
      path.join(allowedRoot, 'bundles'),
      root,
      path.join(root, 'public'),
      path.join(root, 'public', 'toapis'),
      path.join(root, 'public', 'usmercari'),
    ]) fs.chmodSync(directory, 0o755);
  }
  return {
    allowedRoot,
    root,
    roots: { allowedRoot, root },
    evidence,
  };
}

function wan3ConfigFingerprint(config) {
  return crypto.createHash('sha256').update(JSON.stringify({
    id: String(config.id),
    provider: 'toapis_wan3',
    model: 'wan3.0-video',
    base_url: 'https://toapis.cn',
    api_key: config.api_key,
  })).digest('hex');
}

function wan3Config(overrides = {}) {
  return {
    id: 99,
    service_type: 'video',
    provider: 'toapis_wan3',
    api_protocol: 'toapis_wan3_video',
    base_url: 'https://toapis.cn',
    api_key: 'wan3-runtime-key',
    model: ['wan3.0-video'],
    default_model: 'wan3.0-video',
    ...overrides,
  };
}

function installWanEvidence(current, config = wan3Config()) {
  const contract = 'toapis-wan3-video-real-verification-v1';
  const file = 'toapis-wan3-video-verification.json';
  const outputFile = 'wan3-video.mp4';
  const bytes = Buffer.from(JSON.stringify({
    contract_version: contract,
    results: [{
      source_config_id: 16,
      target_config_id: config.id,
      config_id: config.id,
      credential_fingerprint: crypto.createHash('sha256').update(config.api_key).digest('hex'),
      config_fingerprint: wan3ConfigFingerprint(config),
      artifact: { output_file: outputFile },
    }],
  }));
  fs.writeFileSync(path.join(current.root, file), bytes, { mode: 0o644 });
  fs.writeFileSync(path.join(current.root, 'public', 'toapis', outputFile), 'wan3\n', { mode: 0o644 });
  current.evidence[contract] = {
    file,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  fs.writeFileSync(path.join(current.root, 'manifest.json'), JSON.stringify({
    contract_version: 'external-model-release-evidence-manifest-v1',
    evidence: current.evidence,
  }), { mode: 0o644 });
  return current.evidence[contract];
}

test('protected external models require an exact root-owned evidence contract', () => {
  assert.equal(EVIDENCE_ROOT, '/opt/moli-drama/shared/release-evidence/external-models-v1');
  assert.equal(EVIDENCE_ALLOWED_ROOT, '/opt/moli-drama/shared/release-evidence');
  assert.equal(evidenceContractForModel('seedance-2-fast'), 'toapis-video-real-verification-v1');
  assert.equal(evidenceContractForModel('seedance-2-mini'), 'toapis-video-real-verification-v1');
  assert.equal(evidenceContractForModel('wan3.0-video'), 'toapis-wan3-video-real-verification-v1');
  assert.equal(evidenceContractForModel('gpt-image-2-2-4k'), 'usmercari-image-real-verification-v1');
  assert.equal(evidenceContractForModel('nano-banana-2'), 'usmercari-image-real-verification-v1');
  assert.equal(evidenceContractForModel('legacy-model'), null);
});

test('Wan 3.0 fails closed until its independent evidence is installed', () => {
  const current = createEvidenceRoot();
  try {
    assert.equal(readTrustedEvidence('wan3.0-video', current.roots), null);
    assert.equal(hasTrustedEvidenceBinding('wan3.0-video', {
      evidence_contract: 'toapis-wan3-video-real-verification-v1',
      evidence_sha256: '0'.repeat(64),
    }, current.roots), false);
  } finally {
    fs.rmSync(current.allowedRoot, { recursive: true, force: true });
  }
});

test('Wan 3.0 binds only to its installed independent evidence bytes', () => {
  const current = createEvidenceRoot();
  try {
    const config = wan3Config();
    const installed = installWanEvidence(current, config);
    assert.deepEqual(readTrustedEvidence('wan3.0-video', current.roots), {
      contract: 'toapis-wan3-video-real-verification-v1',
      sha256: installed.sha256,
      source_config_id: 16,
      target_config_id: config.id,
      config_id: config.id,
      credential_fingerprint: crypto.createHash('sha256').update(config.api_key).digest('hex'),
      config_fingerprint: wan3ConfigFingerprint(config),
    });
    assert.equal(hasTrustedEvidenceBinding('wan3.0-video', {
      evidence_contract: 'toapis-wan3-video-real-verification-v1',
      evidence_sha256: installed.sha256,
    }, current.roots, config), true);
    assert.equal(hasTrustedEvidenceBinding('wan3.0-video', {
      evidence_contract: 'toapis-wan3-video-real-verification-v1',
      evidence_sha256: '0'.repeat(64),
    }, current.roots, config), false);
  } finally {
    fs.rmSync(current.allowedRoot, { recursive: true, force: true });
  }
});

test('Wan 3.0 evidence binding fails closed when the active target config identity or credential drifts', () => {
  const current = createEvidenceRoot();
  try {
    const config = wan3Config();
    const installed = installWanEvidence(current, config);
    const capabilities = {
      evidence_contract: 'toapis-wan3-video-real-verification-v1',
      evidence_sha256: installed.sha256,
    };
    for (const drifted of [
      undefined,
      wan3Config({ id: 100 }),
      wan3Config({ provider: 'toapis' }),
      wan3Config({ api_protocol: 'toapis_video' }),
      wan3Config({ base_url: 'https://toapis.cn/v1' }),
      wan3Config({ api_key: 'rotated-key' }),
      wan3Config({ model: ['seedance-2-fast'] }),
      wan3Config({ default_model: 'seedance-2-fast' }),
    ]) {
      assert.equal(hasTrustedEvidenceBinding(
        'wan3.0-video', capabilities, current.roots, drifted,
      ), false);
    }
  } finally {
    fs.rmSync(current.allowedRoot, { recursive: true, force: true });
  }
});

test('runtime capability must bind to the exact shared evidence bytes', () => {
  const current = createEvidenceRoot();
  try {
    const trusted = readTrustedEvidence('seedance-2-fast', current.roots);
    assert.deepEqual(trusted, {
      contract: 'toapis-video-real-verification-v1',
      sha256: current.evidence['toapis-video-real-verification-v1'].sha256,
    });
    assert.equal(hasTrustedEvidenceBinding('seedance-2-fast', {
      evidence_contract: trusted.contract,
      evidence_sha256: trusted.sha256,
    }, current.roots), true);
    assert.equal(hasTrustedEvidenceBinding('seedance-2-fast', {
      evidence_contract: trusted.contract,
      evidence_sha256: '0'.repeat(64),
    }, current.roots), false);
    assert.equal(hasTrustedEvidenceBinding('legacy-model', {}, current.roots), true);
  } finally {
    fs.rmSync(current.allowedRoot, { recursive: true, force: true });
  }
});

test('missing, tampered, symlinked or out-of-root evidence fails closed', (t) => {
  const current = createEvidenceRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'external-model-outside-'));
  try {
    fs.appendFileSync(path.join(current.root, 'toapis-video-verification.json'), 'tampered');
    assert.equal(readTrustedEvidence('seedance-2-fast', current.roots), null);

    assert.equal(readTrustedEvidence('seedance-2-fast', {
      ...current.roots,
      root: outside,
    }), null);

    if (process.platform === 'win32') {
      t.diagnostic('Windows symlink creation is privilege-dependent; realpath containment remains covered');
    } else {
      const link = path.join(current.allowedRoot, 'linked');
      fs.symlinkSync(current.root, link, 'dir');
      assert.equal(readTrustedEvidence('seedance-2-fast', {
        ...current.roots,
        root: link,
      }), null);
    }
  } finally {
    fs.rmSync(current.allowedRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('explicit test roots still require a non-symlink, non-writable path chain and public assets', (t) => {
  const targets = [
    ['allowed path layer', (current) => path.join(current.allowedRoot, 'bundles')],
    ['evidence root', (current) => current.root],
    ['manifest', (current) => path.join(current.root, 'manifest.json')],
    ['evidence JSON', (current) => path.join(current.root, 'toapis-video-verification.json')],
    ['public directory', (current) => path.join(current.root, 'public', 'toapis')],
    ['public asset', (current) => path.join(current.root, 'public', 'toapis', 'video.mp4')],
  ];
  if (process.platform === 'win32') {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/externalModelEvidenceService.js'), 'utf8');
    assert.match(source, /stat\.mode\s*&\s*0o022/);
    assert.match(source, /stat\.uid\s*!==\s*0/);
    assert.match(source, /stat\.gid\s*!==\s*0/);
    t.diagnostic('POSIX mode mutation is covered by source contract on Windows');
    return;
  }
  for (const [name, resolveTarget] of targets) {
    const current = createEvidenceRoot();
    try {
      fs.chmodSync(resolveTarget(current), 0o777);
      assert.equal(readTrustedEvidence('seedance-2-fast', current.roots), null, name);
    } finally {
      fs.rmSync(current.allowedRoot, { recursive: true, force: true });
    }
  }
});

test('symlinked public asset fails closed', (t) => {
  const current = createEvidenceRoot();
  const asset = path.join(current.root, 'public', 'toapis', 'video.mp4');
  const outside = path.join(current.allowedRoot, 'outside.mp4');
  try {
    fs.writeFileSync(outside, 'outside');
    fs.rmSync(asset);
    try { fs.symlinkSync(outside, asset, 'file'); } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return t.skip(`symlink unavailable: ${error.code}`);
      throw error;
    }
    assert.equal(readTrustedEvidence('seedance-2-fast', current.roots), null);
  } finally {
    fs.rmSync(current.allowedRoot, { recursive: true, force: true });
  }
});

test('production evidence binding does not accept evidence path environment overrides', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/externalModelEvidenceService.js'), 'utf8');
  assert.doesNotMatch(source, /EXTERNAL_MODEL_EVIDENCE_(?:ROOT|ALLOWED_ROOT)/);
  assert.doesNotMatch(source, /NODE_TEST_CONTEXT|testEvidenceRoots|configureEvidenceRootsForTest/);
});

test('catalog, pricing and generation gates all require the shared evidence binding', () => {
  const sourceByGate = {
    catalog: fs.readFileSync(path.join(__dirname, '../src/services/canvasModelCatalogService.js'), 'utf8'),
    pricing: fs.readFileSync(path.join(__dirname, '../src/services/modelPriceService.js'), 'utf8'),
    image: fs.readFileSync(path.join(__dirname, '../src/services/imageService.js'), 'utf8'),
    video: fs.readFileSync(path.join(__dirname, '../src/services/videoService.js'), 'utf8'),
  };
  for (const [gate, source] of Object.entries(sourceByGate)) {
    assert.match(source, /hasTrustedEvidenceBinding\s*\(/, `${gate} gate must bind runtime config to shared evidence`);
  }
});
