'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runtimeService = require('../src/services/providerRuntimeFingerprintService');

function createRuntimeRoot(t, suffix, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `provider-runtime-${suffix}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relativePath, contents] of Object.entries(files)) {
    const filename = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  return root;
}

const IMAGE_OPENAI_FILES = {
  'src/services/imageClient.js': 'image common v1\n',
  'src/services/providerErrorClassifier.js': 'classifier v1\n',
};

test('runtime fingerprint is stable across roots and changes with common or adapter contents', (t) => {
  const rootA = createRuntimeRoot(t, 'a', IMAGE_OPENAI_FILES);
  const rootB = createRuntimeRoot(t, 'b', IMAGE_OPENAI_FILES);
  const config = {
    id: 1, service_type: 'image', provider: 'generic', api_protocol: 'openai', api_key: 'secret-key',
  };
  const a = runtimeService.runtimeFingerprintForConfig(config, { repoRoot: rootA });
  const b = runtimeService.runtimeFingerprintForConfig(config, { repoRoot: rootB });
  assert.equal(a.ok, true);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.match(a.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(a.files, ['src/services/imageClient.js', 'src/services/providerErrorClassifier.js']);
  const serialized = JSON.stringify(a);
  assert.equal(serialized.includes(rootA), false);
  assert.equal(serialized.includes('image common v1'), false);
  assert.equal(serialized.includes('secret-key'), false);

  fs.writeFileSync(path.join(rootB, 'src', 'services', 'providerErrorClassifier.js'), 'classifier v2\n');
  assert.notEqual(
    a.fingerprint,
    runtimeService.runtimeFingerprintForConfig(config, { repoRoot: rootB }).fingerprint,
  );
  fs.writeFileSync(path.join(rootB, 'src', 'services', 'providerErrorClassifier.js'), 'classifier v1\n');
  fs.writeFileSync(path.join(rootB, 'src', 'services', 'imageClient.js'), 'image common v2\n');
  assert.notEqual(
    a.fingerprint,
    runtimeService.runtimeFingerprintForConfig(config, { repoRoot: rootB }).fingerprint,
  );
  fs.writeFileSync(path.join(rootB, 'src', 'services', 'imageClient.js'), 'image common v1\n');

  fs.mkdirSync(path.join(rootA, 'src', 'services'), { recursive: true });
  fs.writeFileSync(path.join(rootA, 'src', 'services', 'aihubccClient.js'), 'adapter v1\n');
  fs.writeFileSync(path.join(rootB, 'src', 'services', 'aihubccClient.js'), 'adapter v2\n');
  const adapterConfig = { service_type: 'image', provider: 'aihubcc', api_protocol: 'aihubcc' };
  assert.notEqual(
    runtimeService.runtimeFingerprintForConfig(adapterConfig, { repoRoot: rootA }).fingerprint,
    runtimeService.runtimeFingerprintForConfig(adapterConfig, { repoRoot: rootB }).fingerprint,
  );
});

test('known service mappings are explicit and missing files are structured failures', (t) => {
  const root = createRuntimeRoot(t, 'missing-adapter', IMAGE_OPENAI_FILES);
  const resolved = runtimeService.resolveRuntimeFiles(
    { service_type: 'image', provider: 'aihubcc', api_protocol: 'aihubcc' },
    { repoRoot: root },
  );
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, 'missing_runtime_file');
  assert.deepEqual(resolved.missingFiles, ['src/services/aihubccClient.js']);
  assert.equal(JSON.stringify(resolved).includes(root), false);
});

test('unknown services and explicit protocols return missing mapping instead of common-only hashes', (t) => {
  const root = createRuntimeRoot(t, 'unknown', IMAGE_OPENAI_FILES);
  for (const config of [
    { service_type: 'audio', provider: 'openai', api_protocol: 'openai' },
    { service_type: 'image', provider: 'generic', api_protocol: 'invented-protocol' },
  ]) {
    const result = runtimeService.runtimeFingerprintForConfig(config, { repoRoot: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'missing_runtime_mapping');
    assert.equal(result.fingerprint, null);
  }
});

test('provider inference selects the repository current adapter branches', (t) => {
  const files = {
    'src/services/videoClient.js': 'video common\n',
    'src/services/providerErrorClassifier.js': 'classifier\n',
    'src/services/providerAssetUrlService.js': 'asset helper\n',
    'src/services/toapisVideoClient.js': 'toapis adapter\n',
  };
  const root = createRuntimeRoot(t, 'provider', files);
  const result = runtimeService.runtimeFingerprintForConfig(
    { service_type: 'video', provider: 'toapis_video', api_protocol: '' },
    { repoRoot: root },
  );
  assert.equal(result.ok, true);
  assert.equal(result.protocol, 'toapis_video');
  assert.deepEqual(result.files, [
    'src/services/providerAssetUrlService.js',
    'src/services/providerErrorClassifier.js',
    'src/services/toapisVideoClient.js',
    'src/services/videoClient.js',
  ]);
});

test('catalog-supported text and image protocols with runtime branches have mappings', (t) => {
  const root = createRuntimeRoot(t, 'catalog-protocols', {
    'src/services/aiClient.js': 'text common\n',
    'src/services/imageClient.js': 'image common\n',
    'src/services/videoClient.js': 'video common\n',
    'src/services/providerErrorClassifier.js': 'classifier\n',
    'src/services/token6688Client.js': 'token adapter\n',
    'src/services/usmercariVideoClient.js': 'usmercari adapter\n',
  });
  for (const config of [
    { service_type: 'text', provider: 'openai', api_protocol: 'responses' },
    { service_type: 'image', provider: 'token6688', api_protocol: 'token6688' },
    { service_type: 'image', provider: 'usmercari_image', api_protocol: 'usmercari_image' },
  ]) {
    const result = runtimeService.runtimeFingerprintForConfig(config, { repoRoot: root });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
});

test('video protocols without submission dispatch stay unmapped while wired protocols remain mapped', (t) => {
  const root = createRuntimeRoot(t, 'video-dispatch', {
    'src/services/videoClient.js': 'video common\n',
    'src/services/providerErrorClassifier.js': 'classifier\n',
    'src/services/klingJwt.js': 'kling helper\n',
    'src/services/providerAssetUrlService.js': 'asset helper\n',
    'src/services/toapisVideoClient.js': 'toapis adapter\n',
  });

  for (const protocol of ['djpsd_media', 'djpsd_openapi', 'lingjing_open']) {
    const result = runtimeService.runtimeFingerprintForConfig(
      { service_type: 'video', provider: 'catalog-provider', api_protocol: protocol },
      { repoRoot: root },
    );
    assert.equal(result.ok, false, protocol);
    assert.equal(result.code, 'missing_runtime_mapping', protocol);
    assert.equal(result.fingerprint, null, protocol);
  }

  for (const config of [
    { service_type: 'video', provider: 'generic', api_protocol: 'openai' },
    { service_type: 'video', provider: 'kling', api_protocol: 'kling' },
    { service_type: 'video', provider: 'toapis', api_protocol: 'toapis_video' },
  ]) {
    const result = runtimeService.runtimeFingerprintForConfig(config, { repoRoot: root });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
});

test('branch helper changes invalidate Kling and ToAPI runtime fingerprints', (t) => {
  const shared = {
    'src/services/imageClient.js': 'image common\n',
    'src/services/videoClient.js': 'video common\n',
    'src/services/providerErrorClassifier.js': 'classifier\n',
    'src/services/toapisVideoClient.js': 'toapis adapter\n',
  };
  const rootA = createRuntimeRoot(t, 'branch-helper-a', {
    ...shared,
    'src/services/klingJwt.js': 'kling helper v1\n',
    'src/services/providerAssetUrlService.js': 'asset helper v1\n',
  });
  const rootB = createRuntimeRoot(t, 'branch-helper-b', {
    ...shared,
    'src/services/klingJwt.js': 'kling helper v2\n',
    'src/services/providerAssetUrlService.js': 'asset helper v2\n',
  });
  for (const config of [
    { service_type: 'image', provider: 'kling', api_protocol: 'kling' },
    { service_type: 'video', provider: 'kling', api_protocol: 'kling' },
    { service_type: 'video', provider: 'ffir', api_protocol: 'kling_omni' },
    { service_type: 'video', provider: 'toapis', api_protocol: 'toapis_video' },
  ]) {
    const a = runtimeService.runtimeFingerprintForConfig(config, { repoRoot: rootA });
    const b = runtimeService.runtimeFingerprintForConfig(config, { repoRoot: rootB });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.notEqual(a.fingerprint, b.fingerprint, JSON.stringify(config));
  }
});
