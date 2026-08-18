'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  loadManifest,
  verifyIncrementalReleaseScope,
} = require('../scripts/verify-incremental-release-scope');

const repoRoot = path.resolve(__dirname, '..', '..');
const proactiveCanaryManifestPath = path.join(
  repoRoot,
  'deploy',
  'release-scopes',
  'platform-stability-proactive-canary.json',
);

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'incremental-release-scope-'));
  const parentRoot = path.join(root, 'parent');
  const candidateRoot = path.join(root, 'candidate');
  fs.mkdirSync(path.join(parentRoot, 'backend-node', 'src'), { recursive: true });
  fs.mkdirSync(path.join(candidateRoot, 'backend-node', 'src'), { recursive: true });
  fs.writeFileSync(path.join(parentRoot, 'backend-node', 'src', 'allowed.js'), 'old\n');
  fs.writeFileSync(path.join(candidateRoot, 'backend-node', 'src', 'allowed.js'), 'new\n');
  const manifestPath = path.join(root, 'scope.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    release: 'test-release',
    allowedPaths: ['backend-node/src/allowed.js'],
  }));
  return { root, parentRoot, candidateRoot, manifestPath };
}

test('增量门禁允许白名单内改动并校验 current 未漂移', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const report = verifyIncrementalReleaseScope({
    ...fixture,
    expectedCurrent: fixture.parentRoot,
    currentLink: fixture.parentRoot,
  });

  assert.equal(report.ready, true);
  assert.deepEqual(report.changedPaths, ['backend-node/src/allowed.js']);
});

test('增量门禁拒绝白名单外改动', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.candidateRoot, 'backend-node', 'src', 'pollution.js'), 'pollution\n');

  assert.throws(
    () => verifyIncrementalReleaseScope(fixture),
    (error) => error.code === 'SCOPE_VIOLATION'
      && error.details.unexpectedPaths.includes('backend-node/src/pollution.js'),
  );
});

test('增量门禁拒绝 current 漂移', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.throws(
    () => verifyIncrementalReleaseScope({
      ...fixture,
      expectedCurrent: fixture.parentRoot,
      currentLink: fixture.candidateRoot,
    }),
    (error) => error.code === 'CURRENT_CHANGED',
  );
});

test('增量门禁拒绝路径穿越和清单哈希不匹配', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  fs.writeFileSync(fixture.manifestPath, JSON.stringify({
    schemaVersion: 1,
    allowedPaths: ['../outside.js'],
  }));
  assert.throws(() => loadManifest(fixture.manifestPath), { code: 'INVALID_MANIFEST' });
  assert.throws(
    () => loadManifest(fixture.manifestPath, '0'.repeat(64)),
    { code: 'MANIFEST_SHA256_MISMATCH' },
  );
});

test('主动巡检发布范围是精确文件白名单且排除运行数据与受保护服务', () => {
  const { manifest, allowedPaths } = loadManifest(proactiveCanaryManifestPath);
  assert.equal(manifest.release, 'platform-stability-proactive-canary');
  assert.equal(allowedPaths.length, 66);
  assert.equal(allowedPaths.every((entry) => !entry.includes('*') && !entry.endsWith('/')), true);

  for (const required of [
    'backend-node/migrations/60_provider_canary_guard.sql',
    'backend-node/src/services/providerCanarySchedulerService.js',
    'backend-node/test/providerCanaryPublicGate.test.js',
    'docs/verification/platform-stability/proactive-canary-verification.md',
    'frontweb/e2e/platform-zero-cost-smoke.spec.js',
    'frontweb/src/components/ProviderStabilityPanel.vue',
    'deploy/release-scopes/platform-stability-proactive-canary.json',
  ]) {
    assert.ok(allowedPaths.includes(required), `发布范围缺少计划文件: ${required}`);
  }

  for (const forbidden of [
    'backend-node/data',
    'backend-node/uploads',
    'storage',
    'assets',
    'ai-music',
    'deploy/release-scopes/platform-stability-foundation.json',
    'deploy/install-protected-release-guard.sh',
    'shared/release-guard',
  ]) {
    assert.equal(
      allowedPaths.some((entry) => entry === forbidden || entry.startsWith(`${forbidden}/`)),
      false,
      `发布范围不得包含: ${forbidden}`,
    );
  }
});
