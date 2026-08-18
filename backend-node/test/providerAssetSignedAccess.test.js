const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStaticOwnershipMiddleware } = require('../src/middleware/resourceOwnership');
const { signProviderAssetUrl } = require('../src/services/providerAssetUrlService');

const SECRET = 'provider-asset-signed-access-secret-at-least-32-characters';

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test('an exact unexpired provider asset signature grants cookie-free access and tampering is rejected without logging the signature', async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-provider-signed-static-'));
  const relativePath = '_system/provider-canary/fixtures/image-01.png';
  const filePath = path.join(storageRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  const db = { prepare() { throw new Error('signed access must bypass user ownership queries'); } };
  const app = express();
  app.use('/static', createStaticOwnershipMiddleware({
    db,
    enabled: true,
    secret: SECRET,
    storageRoot,
  }), express.static(storageRoot));
  const server = await listen(app);
  const logged = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => logged.push(args);
  console.warn = (...args) => logged.push(args);
  console.error = (...args) => logged.push(args);
  t.after(async () => {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    await close(server);
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const signed = signProviderAssetUrl(`${base}/static/${relativePath}`, {
    filesBaseUrl: `${base}/static`,
    secret: SECRET,
    ttlSeconds: 60,
  });

  const allowed = await fetch(signed);
  assert.equal(allowed.status, 200);
  assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), fs.readFileSync(filePath));
  assert.equal((await fetch(`${base}/static/${relativePath}`)).status, 401);

  const tamperedPath = new URL(signed);
  tamperedPath.pathname = tamperedPath.pathname.replace('image-01.png', 'image-02.png');
  assert.equal((await fetch(tamperedPath)).status, 401);
  const tamperedSignature = new URL(signed);
  tamperedSignature.searchParams.set('provider_asset_signature', 'A'.repeat(43));
  assert.equal((await fetch(tamperedSignature)).status, 401);

  const expired = signProviderAssetUrl(`${base}/static/${relativePath}`, {
    filesBaseUrl: `${base}/static`,
    secret: SECRET,
    now: Date.now() - 61 * 1000,
    ttlSeconds: 60,
  });
  assert.equal((await fetch(expired)).status, 401);
  const signature = new URL(signed).searchParams.get('provider_asset_signature');
  assert.equal(JSON.stringify(logged).includes(signature), false);
});
