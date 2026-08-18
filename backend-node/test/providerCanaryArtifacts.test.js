const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const {
  materializeImage,
  materializeVideo,
  verifyText,
  artifactSummary,
} = require('../src/services/providerCanaryArtifactService');

function tempStorage() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moli-provider-canary-artifacts-'));
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function tempFiles(storageRoot, runId) {
  const dir = path.join(storageRoot, '_system', 'provider-canary', 'runs', runId);
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.includes('.tmp'))
    : [];
}

test('image and video artifacts are verified, atomically isolated, private, and summarized without source data', async (t) => {
  const storageRoot = tempStorage();
  const jpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#3366cc' },
  }).jpeg().toBuffer();
  const png = await sharp({
    create: { width: 8, height: 8, channels: 4, background: '#ffffff' },
  }).png().toBuffer();
  const mp4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
  const server = await listen((req, res) => {
    if (req.url.startsWith('/image')) {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpeg.length });
      return res.end(jpeg);
    }
    if (req.url.startsWith('/video')) {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': mp4.length });
      return res.end(mp4);
    }
    res.writeHead(404).end();
  });
  t.after(async () => {
    await close(server);
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const remoteImage = await materializeImage({ image_url: `${base}/image?private_signature=do-not-store` }, {
    storageRoot,
    runId: 'run-image-http',
  });
  const dataImage = await materializeImage({
    image_url: `data:image/png;base64,${png.toString('base64')}`,
  }, { storageRoot, runId: 'run-image-data' });
  const video = await materializeVideo(`${base}/video?private_signature=do-not-store`, {
    storageRoot,
    runId: 'run-video-http',
  });

  assert.match(remoteImage.relative_path, /^_system\/provider-canary\/runs\/run-image-http\/image\.jpg$/);
  assert.match(dataImage.relative_path, /^_system\/provider-canary\/runs\/run-image-data\/image\.png$/);
  assert.match(video.relative_path, /^_system\/provider-canary\/runs\/run-video-http\/video\.mp4$/);
  for (const summary of [remoteImage, dataImage, video]) {
    assert.match(summary.sha256, /^[a-f0-9]{64}$/);
    assert.ok(summary.bytes > 0);
    const serialized = JSON.stringify(summary);
    assert.doesNotMatch(serialized, /private_signature|data:image|base64|127\.0\.0\.1/);
    const filePath = path.join(storageRoot, ...summary.relative_path.split('/'));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    }
    assert.deepEqual(artifactSummary(filePath, { storageRoot }), summary);
  }
  assert.deepEqual(tempFiles(storageRoot, 'run-image-http'), []);
  assert.deepEqual(tempFiles(storageRoot, 'run-video-http'), []);
});

test('artifact materialization rejects unsafe, unreadable, interrupted, redirected, and oversized inputs and cleans partial files', async (t) => {
  const storageRoot = tempStorage();
  const server = await listen((req, res) => {
    if (req.url === '/html') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html>not image</html>');
    if (req.url === '/svg') return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg/>');
    if (req.url === '/empty') return res.writeHead(200, { 'content-length': 0 }).end();
    if (req.url === '/oversize') return res.writeHead(200, { 'content-length': 32 }).end(Buffer.alloc(32, 1));
    if (req.url === '/file-redirect') return res.writeHead(302, { location: 'file:///tmp/private.png' }).end();
    if (req.url === '/interrupt') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write(Buffer.from('89504e470d0a1a0a', 'hex'));
      return res.destroy();
    }
    return res.writeHead(404).end();
  });
  t.after(async () => {
    await close(server);
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cases = [
    ['relative', () => materializeImage('/relative.png', { storageRoot, runId: 'bad-relative' })],
    ['file', () => materializeImage('file:///tmp/private.png', { storageRoot, runId: 'bad-file' })],
    ['svg-data', () => materializeImage('data:image/svg+xml;base64,PHN2Zy8+', { storageRoot, runId: 'bad-svg-data' })],
    ['html', () => materializeImage(`${base}/html`, { storageRoot, runId: 'bad-html' })],
    ['svg', () => materializeImage(`${base}/svg`, { storageRoot, runId: 'bad-svg' })],
    ['empty', () => materializeImage(`${base}/empty`, { storageRoot, runId: 'bad-empty' })],
    ['oversize', () => materializeImage(`${base}/oversize`, { storageRoot, runId: 'bad-oversize', maxBytes: 16 })],
    ['redirect', () => materializeImage(`${base}/file-redirect`, { storageRoot, runId: 'bad-redirect' })],
    ['interrupt', () => materializeImage(`${base}/interrupt`, { storageRoot, runId: 'bad-interrupt' })],
  ];
  for (const [runSuffix, operation] of cases) {
    await assert.rejects(operation);
    assert.deepEqual(tempFiles(storageRoot, `bad-${runSuffix}`), []);
  }
});

test('magic checks accept PNG JPEG WebP ISO BMFF and WebM but reject mismatched media', async (t) => {
  const storageRoot = tempStorage();
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
  const webp = Buffer.from('524946460400000057454250', 'hex');
  const mp4 = Buffer.from('00000018667479706d703432', 'hex');
  const webm = Buffer.from('1a45dfa301000000', 'hex');
  for (const [index, bytes] of [png, jpeg, webp].entries()) {
    const result = await materializeImage(`data:image/${index === 1 ? 'jpeg' : index === 2 ? 'webp' : 'png'};base64,${bytes.toString('base64')}`, {
      storageRoot,
      runId: `magic-image-${index}`,
    });
    assert.ok(result.bytes > 0);
  }
  for (const [index, bytes] of [mp4, webm].entries()) {
    const result = await materializeVideo(`https://fixture.invalid/video-${index}`, {
      storageRoot,
      runId: `magic-video-${index}`,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(bytes.length) }),
        body: (async function* body() { yield bytes; }()),
      }),
    });
    assert.ok(result.bytes > 0);
  }
  await assert.rejects(() => materializeVideo('https://fixture.invalid/not-video', {
    storageRoot,
    runId: 'magic-video-bad',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: (async function* body() { yield png; }()),
    }),
  }));
});

test('text verification returns only a non-empty digest summary', () => {
  assert.throws(() => verifyText(' \n\t '), /empty|non-empty|\u7a7a/i);
  const summary = verifyText('  CANARY_OK  ');
  assert.deepEqual(Object.keys(summary).sort(), ['bytes', 'media_type', 'sha256']);
  assert.equal(summary.bytes, Buffer.byteLength('CANARY_OK'));
  assert.equal(summary.media_type, 'text/plain');
  assert.match(summary.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(summary).includes('CANARY_OK'), false);
});

test('artifact summaries cannot escape or reuse user storage namespaces', (t) => {
  const storageRoot = tempStorage();
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const userFile = path.join(storageRoot, 'assets', 'user.png');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, Buffer.from('89504e470d0a1a0a', 'hex'));

  assert.throws(() => artifactSummary(userFile, { storageRoot }), /provider-canary|artifact path/i);
});
