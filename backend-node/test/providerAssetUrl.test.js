const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { createStaticOwnershipMiddleware } = require('../src/middleware/resourceOwnership');
const { signProviderAssetUrl } = require('../src/services/providerAssetUrlService');

test('限时签名素材链接允许供应商匿名读取，但未签名链接仍受登录保护', async (t) => {
  const secret = 'test-provider-asset-secret-at-least-32-characters';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-asset-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'reference.jpg'), Buffer.from('provider-readable-image'));

  const app = express();
  app.use('/static', createStaticOwnershipMiddleware({
    db: { prepare() { throw new Error('signed request must not query ownership'); } },
    enabled: true,
    secret,
  }), express.static(root));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/static`;

  const unsignedResponse = await fetch(`${baseUrl}/reference.jpg`);
  assert.equal(unsignedResponse.status, 401);

  const signedUrl = signProviderAssetUrl(`${baseUrl}/reference.jpg`, {
    filesBaseUrl: baseUrl,
    secret,
  });
  const signedResponse = await fetch(signedUrl);
  assert.equal(signedResponse.status, 200);
  assert.equal(await signedResponse.text(), 'provider-readable-image');

  const tampered = new URL(signedUrl);
  tampered.pathname = '/static/other.jpg';
  const tamperedResponse = await fetch(tampered);
  assert.equal(tamperedResponse.status, 401);

  const expiredUrl = signProviderAssetUrl(`${baseUrl}/reference.jpg`, {
    filesBaseUrl: baseUrl,
    secret,
    now: Date.now() - (3 * 60 * 60 * 1000),
    ttlSeconds: 60,
  });
  const expiredResponse = await fetch(expiredUrl);
  assert.equal(expiredResponse.status, 401);
});
