'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { setup, readPublished, hash, NOW } = require('./helpers/redrawExecutionUnitDispatchFixture');
const { publishPreparedProviderAsset, readProviderAssetBytes, resolveProviderAssetPath } = require('../src/services/redrawSourceConditioningService');

test('content-bound provider assets serve real formats and reject tampering, links, expiry and wrong origin', async t => {
  const h = await setup(t);
  const png = fs.readFileSync(path.join(h.root, 'redraw/identity-301.png'));
  const jpeg = await sharp(png).jpeg().toBuffer();
  const mp4 = fs.readFileSync(h.motionPath);
  const published = [];
  for (const [mimeType, bytes] of [['image/png', png], ['image/jpeg', jpeg], ['video/mp4', mp4]]) {
    await t.test(`actual ${mimeType} bytes are bound to the URL and handler response`, async () => {
      const signed = await publishPreparedProviderAsset({ ...h.ctx.providerAssets, bytes, mimeType, segmentSha256: hash(bytes) });
      const result = await readPublished(h, signed.url);
      assert.equal(result.status, 200, JSON.stringify(result.failure));
      assert.deepEqual(result.bytes, bytes);
      assert.equal(result.headers['Content-Type'], mimeType);
      assert.equal(result.headers['Cache-Control'], 'private, no-store, max-age=0');
      assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(hash(result.bytes), path.basename(new URL(signed.url).pathname).split('.')[0]);
      published.push(signed.url);
    });
  }
  await t.test('wrong byte hash is rejected before publication', async () => {
    await assert.rejects(publishPreparedProviderAsset({ ...h.ctx.providerAssets, bytes: png, mimeType: 'image/png',
      segmentSha256: '0'.repeat(64) }), error => error.code === 'REDRAW_PROVIDER_ASSET_HASH_MISMATCH');
  });
  await t.test('valid bytes cannot be published under a different media MIME', async () => {
    await assert.rejects(publishPreparedProviderAsset({ ...h.ctx.providerAssets, bytes: png, mimeType: 'video/mp4',
      segmentSha256: hash(png) }), error => error.code === 'REDRAW_PROVIDER_ASSET_MIME_MISMATCH');
  });
  await t.test('existing motion sizes above 128 MiB remain publishable and legacy-resolvable', async () => {
    // One actual MP4 with a legal trailing ISO-BMFF free box, shared by both checks.
    // No source/fixture/probe implementation is mocked and no large historical media is read.
    const free = Buffer.alloc(128 * 1024 * 1024 + 8);
    free.writeUInt32BE(free.length, 0); free.write('free', 4, 'ascii');
    const bytes = Buffer.concat([mp4, free]);
    assert.ok(bytes.length > 128 * 1024 * 1024 && bytes.length < 200 * 1024 * 1024);
    const digest = hash(bytes), filename = `${digest}.mp4`;
    const file = path.join(h.root, 'redraw-conditioning', filename);
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    assert.equal(await resolveProviderAssetPath({ storageRoot: h.root, filename }), file);
    const signed = await publishPreparedProviderAsset({ ...h.ctx.providerAssets, bytes, mimeType: 'video/mp4', segmentSha256: digest });
    assert.equal(path.basename(new URL(signed.url).pathname), filename);
  });
  await t.test('prepared images retain the existing 20 MiB upload limit', async () => {
    const bytes = Buffer.alloc(20 * 1024 * 1024 + 1); png.copy(bytes);
    await assert.rejects(publishPreparedProviderAsset({ ...h.ctx.providerAssets, bytes, mimeType: 'image/png',
      segmentSha256: hash(bytes) }), error => error.code === 'REDRAW_PROVIDER_ASSET_TOO_LARGE');
  });
  await t.test('changed content is not served even with a valid signature', async () => {
    const file = path.join(h.root, 'redraw-conditioning', path.basename(new URL(published[0]).pathname));
    const before = fs.readFileSync(file);
    try {
      fs.writeFileSync(file, jpeg);
      const result = await readPublished(h, published[0]);
      assert.equal(result.status, 404);
      assert.equal(result.bytes, undefined);
      assert.equal(result.failure.code, 'REDRAW_PROVIDER_ASSET_HASH_MISMATCH');
    } finally { fs.writeFileSync(file, before); }
  });
  await t.test('directory junctions cannot redirect the provider storage root', () => {
    const alias = path.join(h.root, 'provider-junction');
    fs.symlinkSync(h.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => readProviderAssetBytes({ storageRoot: alias, filename: path.basename(new URL(published[0]).pathname) }),
      error => error.code === 'REDRAW_PROVIDER_ASSET_PATH_INVALID');
  });
  await t.test('expired and forged signatures send no bytes', async () => {
    const expired = { ...h, ctx: { ...h.ctx, providerAssets: { ...h.ctx.providerAssets, nowMs: Date.parse(NOW) + 31 * 60_000 } } };
    assert.equal((await readPublished(expired, published[0])).status, 403);
    const forged = new URL(published[0]); forged.searchParams.set('signature', '0'.repeat(64));
    const result = await readPublished(h, forged.toString());
    assert.equal(result.status, 403); assert.equal(result.bytes, undefined);
  });
  await t.test('wrong origin and unsupported path send no bytes', async () => {
    const other = new URL(published[0]); other.hostname = 'other.synthetic.invalid';
    assert.equal((await readPublished(h, other.toString())).status, 403);
    assert.throws(() => readProviderAssetBytes({ storageRoot: h.root, filename: '../identity.png' }),
      error => error.code === 'REDRAW_PROVIDER_ASSET_PATH_INVALID');
  });
});
