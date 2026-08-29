const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { createStaticOwnershipMiddleware } = require('../src/middleware/resourceOwnership');
const {
  signProviderAssetUrl,
  signStrictStaticAssetUrl,
} = require('../src/services/providerAssetUrlService');

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

test('严格 static 签名拒绝非法 static 路径且必须生成同源 HTTPS 签名 URL', () => {
  const secret = 'strict-static-provider-asset-secret-1234567890';
  const filesBaseUrl = 'https://media.example.test/static';

  const signed = signStrictStaticAssetUrl('/static/projects/0001/ref.png', {
    filesBaseUrl,
    secret,
    now: 1_700_000_000_000,
  });
  const url = new URL(signed);
  assert.equal(url.origin, 'https://media.example.test');
  assert.equal(url.pathname, '/static/projects/0001/ref.png');
  assert.ok(url.searchParams.get('provider_asset_expires'));
  assert.ok(url.searchParams.get('provider_asset_signature'));

  const badInputs = [
    '/static/../private/ref.png',
    '/static/%2e%2e/private/ref.png',
    'C:\\private\\ref.png',
    'file:///tmp/ref.png',
    'https://evil.example.test/static/projects/0001/ref.png',
    'https://media.example.test/assets/ref.png',
  ];
  for (const input of badInputs) {
    assert.throws(() => signStrictStaticAssetUrl(input, { filesBaseUrl, secret }), /static URL/);
  }
  assert.throws(() => signStrictStaticAssetUrl('/static/projects/0001/ref.png', {
    filesBaseUrl: 'http://media.example.test/static',
    secret,
  }), /static URL/);
});
