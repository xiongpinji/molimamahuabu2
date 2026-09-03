const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { mountFrontend } = require('../src/app');

const RELEASE_SCOPE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'deploy',
  'release-scopes',
  'static-asset-cross-release-compat-20260826.json',
);

const EXPECTED_RELEASE_PATHS = [
  'backend-node/src/app.js',
  'backend-node/test/featureLockManifest.test.js',
  'backend-node/test/frontendStaticHosting.test.js',
  'backend-node/test/webProductionDeploymentContract.test.js',
  'deploy/release-scopes/static-asset-cross-release-compat-20260826.json',
  'docs/tasks/2026-08-26-static-asset-cross-release-compat.md',
  'docs/verification/platform-stability/feature-lock-manifest.json',
  'frontweb/scripts/build-public.mjs',
  'frontweb/scripts/release-asset-compat.mjs',
  'frontweb/src/main.js',
  'frontweb/src/utils/preloadErrorRecovery.js',
  'frontweb/test/preloadErrorRecovery.test.js',
  'frontweb/test/releaseAssetCompatibility.test.js',
].sort();

test('createApp 使用统一前端静态服务挂载', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(appSource, /mountFrontend\(app, webDist\)/);
});

test('增量发布范围只允许本次静态资源兼容修复文件', () => {
  const scope = JSON.parse(fs.readFileSync(RELEASE_SCOPE_PATH, 'utf8'));
  assert.equal(scope.schemaVersion, 1);
  assert.equal(scope.release, 'static-asset-cross-release-compat-20260826');
  assert.deepEqual([...scope.allowedPaths].sort(), EXPECTED_RELEASE_PATHS);
});

test('前端静态服务不会把缺失的哈希资源回退成 SPA HTML', async (t) => {
  assert.equal(typeof mountFrontend, 'function');

  const webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-web-dist-'));
  fs.mkdirSync(path.join(webDist, 'assets'));
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>moli-spa</title>');
  fs.writeFileSync(path.join(webDist, 'assets', 'current.js'), 'export const current = true;');
  t.after(() => fs.rmSync(webDist, { recursive: true, force: true }));

  const app = express();
  mountFrontend(app, webDist);
  app.use((req, res) => res.status(404).send('Not Found'));

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const current = await fetch(`${baseUrl}/assets/current.js`);
  assert.equal(current.status, 200);
  assert.match(current.headers.get('content-type') || '', /javascript/);

  const missing = await fetch(`${baseUrl}/assets/old-hash.js`);
  assert.equal(missing.status, 404);
  assert.doesNotMatch(missing.headers.get('content-type') || '', /text\/html/);
  assert.doesNotMatch(await missing.text(), /moli-spa/);

  const route = await fetch(`${baseUrl}/canvas/64`);
  assert.equal(route.status, 200);
  assert.match(await route.text(), /moli-spa/);
  assert.match(route.headers.get('cache-control') || '', /no-cache/);
});

test('前端静态目录存在但不可读取时启动即失败', (t) => {
  const webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-web-dist-permission-'));
  fs.mkdirSync(path.join(webDist, 'assets'));
  const indexHtml = path.join(webDist, 'index.html');
  fs.writeFileSync(indexHtml, '<!doctype html><title>moli-spa</title>');
  t.after(() => fs.rmSync(webDist, { recursive: true, force: true }));

  const originalAccessSync = fs.accessSync;
  fs.accessSync = (target, mode) => {
    if (target === indexHtml && mode === fs.constants.R_OK) {
      const error = new Error(`EACCES: permission denied, access '${target}'`);
      error.code = 'EACCES';
      throw error;
    }
    return originalAccessSync(target, mode);
  };
  t.after(() => { fs.accessSync = originalAccessSync; });

  assert.throws(
    () => mountFrontend(express(), webDist),
    /Frontend static assets unavailable.*EACCES/,
  );
});
