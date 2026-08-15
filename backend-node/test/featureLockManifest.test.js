'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const manifestPath = path.join(
  repoRoot,
  'docs',
  'verification',
  'platform-stability',
  'feature-lock-manifest.json',
);
const {
  loadAndVerifyCurrentManifest,
  verifyFeatureLock,
} = require('../scripts/verify-feature-lock-manifest');

test('共享稳定性锁定清单引用的保护路径、测试和证据全部存在', () => {
  const report = loadAndVerifyCurrentManifest({ repoRoot, manifestPath, baseManifest: null, changedPaths: [] });
  assert.equal(report.ready, true);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.features > 0, true);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.features.every((feature) => feature.module === 'shared'), true);
  assert.equal(manifest.features.some((feature) => /canvas|factory|script-analysis/.test(feature.featureId)), false);
  assert.equal(manifest.features.every((feature) => feature.status === 'locked_fixed'), true);
});

test('锁定保护路径发生变化时必须提供原因、批准者和影响测试', () => {
  const protectedPath = 'backend-node/src/services/imageService.js';
  const baseManifest = {
    schemaVersion: 1,
    baselineCommit: '8f9a66cd708d5db96fbee573a2f4aa7de182a6fe',
    features: [{
      featureId: 'stability.safe-provider-failover',
      module: 'shared',
      status: 'locked_fixed',
      acceptance: ['明确未受理才切换'],
      protectedPaths: [protectedPath],
      requiredTests: ['backend-node/test/providerRouteImageIntegration.test.js'],
      evidence: ['docs/superpowers/plans/2026-08-15-platform-stability-foundation.md'],
      fixCommit: null,
      unlock: null,
    }],
  };
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: baseManifest, baseManifest, changedPaths: [protectedPath] }),
    (error) => error.code === 'FEATURE_LOCKED',
  );
  const approved = structuredClone(baseManifest);
  approved.features[0].unlock = {
    reason: '修复已复现的回归',
    approvedBy: 'product-owner',
    impactTests: ['backend-node/test/providerRouteImageIntegration.test.js'],
  };
  assert.equal(
    verifyFeatureLock({ repoRoot, currentManifest: approved, baseManifest, changedPaths: [protectedPath] }).ready,
    true,
  );
});

test('清单拒绝非法状态、缺失路径和空验收标准', () => {
  const invalid = {
    schemaVersion: 1,
    baselineCommit: '8f9a66cd708d5db96fbee573a2f4aa7de182a6fe',
    features: [{
      featureId: 'stability.invalid',
      module: 'shared',
      status: 'done',
      acceptance: [],
      protectedPaths: ['backend-node/src/services/not-found.js'],
      requiredTests: ['backend-node/test/not-found.test.js'],
      evidence: ['docs/not-found.md'],
      fixCommit: null,
      unlock: null,
    }],
  };
  assert.throws(
    () => verifyFeatureLock({ repoRoot, currentManifest: invalid, baseManifest: null, changedPaths: [] }),
    (error) => error.code === 'INVALID_FEATURE_LOCK_MANIFEST',
  );
});

test('CI 在后端全量测试后运行功能锁审计且发布范围无目录通配', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/backend-node-tests.yml'), 'utf8');
  assert.match(workflow, /Run backend tests[\s\S]*npm test[\s\S]*Audit feature locks[\s\S]*npm run audit:feature-lock/);
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'backend-node/package.json'), 'utf8'));
  assert.equal(pkg.scripts['audit:feature-lock'], 'node scripts/verify-feature-lock-manifest.js');
  const releaseScope = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'deploy/release-scopes/platform-stability-foundation.json'),
    'utf8',
  ));
  assert.equal(releaseScope.schemaVersion, 1);
  assert.equal(releaseScope.allowedPaths.length > 0, true);
  assert.equal(releaseScope.allowedPaths.every((entry) => !entry.includes('*') && !entry.endsWith('/')), true);
});
