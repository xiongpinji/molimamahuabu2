const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

async function publicDnsLookup() {
  return [{ address: '93.184.216.34', family: 4 }];
}

function response(status, bytes = Buffer.alloc(0), headers = {}) {
  const body = Buffer.from(bytes || Buffer.alloc(0));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({
      ...(body.length ? { 'content-length': String(body.length) } : {}),
      ...headers,
    }),
    body: (async function* responseBody() {
      if (body.length) yield body;
    }()),
  };
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
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const fetchImpl = async (url) => {
    if (url.pathname === '/image') return response(200, jpeg, { 'content-type': 'image/jpeg' });
    if (url.pathname === '/video') return response(200, mp4, { 'content-type': 'video/mp4' });
    return response(404);
  };

  const remoteImage = await materializeImage({ image_url: 'https://artifact.example/image?private_signature=do-not-store' }, {
    storageRoot,
    runId: 'run-image-http',
    fetchImpl,
    _dnsLookupForTest: publicDnsLookup,
  });
  const dataImage = await materializeImage({
    image_url: `data:image/png;base64,${png.toString('base64')}`,
  }, { storageRoot, runId: 'run-image-data' });
  const video = await materializeVideo('https://artifact.example/video?private_signature=do-not-store', {
    storageRoot,
    runId: 'run-video-http',
    fetchImpl,
    _dnsLookupForTest: publicDnsLookup,
  });

  assert.match(remoteImage.relative_path, /^_system\/provider-canary\/runs\/run-image-http\/image\.jpg$/);
  assert.match(dataImage.relative_path, /^_system\/provider-canary\/runs\/run-image-data\/image\.png$/);
  assert.match(video.relative_path, /^_system\/provider-canary\/runs\/run-video-http\/video\.mp4$/);
  for (const summary of [remoteImage, dataImage, video]) {
    assert.match(summary.sha256, /^[a-f0-9]{64}$/);
    assert.ok(summary.bytes > 0);
    const serialized = JSON.stringify(summary);
    assert.doesNotMatch(serialized, /private_signature|data:image|base64|artifact\.example/);
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
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const fetchImpl = async (url) => {
    if (url.pathname === '/html') return response(200, '<html>not image</html>', { 'content-type': 'text/html' });
    if (url.pathname === '/svg') return response(200, '<svg/>', { 'content-type': 'image/svg+xml' });
    if (url.pathname === '/empty') return response(200);
    if (url.pathname === '/oversize') return response(200, Buffer.alloc(32, 1));
    if (url.pathname === '/file-redirect') return response(302, null, { location: 'file:///tmp/private.png' });
    if (url.pathname === '/interrupt') {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: (async function* interruptedBody() {
          yield Buffer.from('89504e470d0a1a0a', 'hex');
          throw new Error('connection interrupted');
        }()),
      };
    }
    return response(404);
  };
  const options = (runId, extra = {}) => ({
    storageRoot,
    runId,
    fetchImpl,
    _dnsLookupForTest: publicDnsLookup,
    ...extra,
  });
  const cases = [
    ['relative', () => materializeImage('/relative.png', { storageRoot, runId: 'bad-relative' })],
    ['file', () => materializeImage('file:///tmp/private.png', { storageRoot, runId: 'bad-file' })],
    ['svg-data', () => materializeImage('data:image/svg+xml;base64,PHN2Zy8+', { storageRoot, runId: 'bad-svg-data' })],
    ['html', () => materializeImage('https://artifact.example/html', options('bad-html'))],
    ['svg', () => materializeImage('https://artifact.example/svg', options('bad-svg'))],
    ['empty', () => materializeImage('https://artifact.example/empty', options('bad-empty'))],
    ['oversize', () => materializeImage('https://artifact.example/oversize', options('bad-oversize', { maxBytes: 16 }))],
    ['redirect', () => materializeImage('https://artifact.example/file-redirect', options('bad-redirect'))],
    ['interrupt', () => materializeImage('https://artifact.example/interrupt', options('bad-interrupt'))],
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
      _dnsLookupForTest: publicDnsLookup,
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
    _dnsLookupForTest: publicDnsLookup,
  }));
});

test('HTTP artifact sources fail closed for local, metadata, private, and non-public DNS targets before fetch', async (t) => {
  const storageRoot = tempStorage();
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return response(200, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  };
  const cases = [
    ['localhost', 'http://localhost/image.png', publicDnsLookup],
    ['loopback', 'http://127.0.0.1/image.png', publicDnsLookup],
    ['metadata', 'http://169.254.169.254/latest/meta-data', publicDnsLookup],
    ['ipv6-loopback', 'http://[::1]/image.png', publicDnsLookup],
    ['private-dns', 'https://private.example/image.png', async () => [{ address: '10.1.2.3', family: 4 }]],
    ['link-local-dns', 'https://link-local.example/image.png', async () => [{ address: 'fe80::1', family: 6 }]],
    ['nat64-loopback', 'http://[64:ff9b::7f00:1]/image.png', publicDnsLookup],
    ['nat64-private', 'http://[64:ff9b:1::a01:203]/image.png', publicDnsLookup],
    ['six-to-four-metadata', 'http://[2002:a9fe:a9fe::]/image.png', publicDnsLookup],
    ['teredo-loopback', 'http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/image.png', publicDnsLookup],
  ];
  for (const [runId, url, dnsLookup] of cases) {
    await assert.rejects(
      () => materializeImage(url, { storageRoot, runId, fetchImpl, _dnsLookupForTest: dnsLookup }),
      /public|private|local|SSRF|address|host/i,
    );
    assert.deepEqual(tempFiles(storageRoot, runId), []);
  }
  assert.equal(fetchCalls, 0);
});

test('every redirect target is public-address validated before it can be fetched', async (t) => {
  const storageRoot = tempStorage();
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url.toString());
    return response(302, null, { location: 'https://redirect-private.example/image.png' });
  };
  const dnsLookup = async (hostname) => hostname === 'artifact.example'
    ? [{ address: '93.184.216.34', family: 4 }]
    : [{ address: '192.168.1.20', family: 4 }];

  await assert.rejects(
    () => materializeImage('https://artifact.example/start', {
      storageRoot,
      runId: 'private-redirect',
      fetchImpl,
      _dnsLookupForTest: dnsLookup,
    }),
    /public|private|local|SSRF|address|host/i,
  );
  assert.deepEqual(fetched, ['https://artifact.example/start']);
  assert.deepEqual(tempFiles(storageRoot, 'private-redirect'), []);
});

test('same run and artifact kind publishes once without overwriting across concurrent materializers', async (t) => {
  const storageRoot = tempStorage();
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const first = Buffer.from('89504e470d0a1a0a11111111', 'hex');
  const second = Buffer.from('89504e470d0a1a0a22222222', 'hex');
  const buffers = [first, second];
  let fetchIndex = 0;
  let releaseBodies;
  const bodiesReady = new Promise((resolve) => { releaseBodies = resolve; });
  let waitingBodies = 0;
  const fetchImpl = async () => {
    const bytes = buffers[fetchIndex++];
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(bytes.length) }),
      body: (async function* synchronizedBody() {
        waitingBodies += 1;
        if (waitingBodies === 2) releaseBodies();
        await bodiesReady;
        yield bytes;
      }()),
    };
  };
  const options = {
    storageRoot,
    runId: 'same-run',
    fetchImpl,
    _dnsLookupForTest: publicDnsLookup,
  };

  const settled = await Promise.allSettled([
    materializeImage('https://artifact.example/first.png', options),
    materializeImage('https://artifact.example/second.png', options),
  ]);
  const fulfilled = settled.filter(({ status }) => status === 'fulfilled');
  const rejected = settled.filter(({ status }) => status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0].reason?.message), /already exists|conflict/i);
  const finalPath = path.join(storageRoot, ...fulfilled[0].value.relative_path.split('/'));
  assert.equal(fs.readFileSync(finalPath).equals(first) || fs.readFileSync(finalPath).equals(second), true);
  assert.equal(artifactSummary(finalPath, { storageRoot }).sha256, fulfilled[0].value.sha256);
  assert.deepEqual(tempFiles(storageRoot, 'same-run'), []);

  const source = fs.readFileSync(require.resolve('../src/services/providerCanaryArtifactService'), 'utf8');
  assert.doesNotMatch(source, /existsSync\(finalPath\)[\s\S]{0,200}renameSync\(tempPath, finalPath\)/);
  assert.match(source, /linkSync\(tempPath, finalPath\)/);
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
