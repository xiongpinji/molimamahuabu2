const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  ensureFixtureSet,
  buildReferenceInputs,
} = require('../src/services/providerCanaryFixtureService');

const SECRET = 'provider-canary-fixture-secret-is-at-least-32-characters';

function tempStorage() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moli-provider-canary-fixtures-'));
}

function tableCounts(db) {
  return Object.fromEntries(['assets', 'image_generations', 'video_generations'].map((table) => [
    table,
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
  ]));
}

test('fixed fixtures stay in the system namespace with stable names and never create user rows', async (t) => {
  const storageRoot = tempStorage();
  const db = new Database(':memory:');
  t.after(() => {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  runMigrationsAndEnsure(db);
  const before = tableCounts(db);

  const first = await ensureFixtureSet({
    storageRoot,
    imageCount: 3,
    videoCount: 2,
    audioCount: 2,
  });
  const second = await ensureFixtureSet({
    storageRoot,
    imageCount: 3,
    videoCount: 2,
    audioCount: 2,
  });

  const expectedRoot = path.join(storageRoot, '_system', 'provider-canary', 'fixtures');
  assert.equal(first.root, expectedRoot);
  assert.deepEqual(first.images.map((item) => path.basename(item.path)), [
    'image-01.png', 'image-02.png', 'image-03.png',
  ]);
  assert.deepEqual(first.videos.map((item) => path.basename(item.path)), [
    'video-01.mp4', 'video-02.mp4',
  ]);
  assert.deepEqual(first.audios.map((item) => path.basename(item.path)), [
    'audio-01.wav', 'audio-02.wav',
  ]);
  assert.deepEqual(
    second.images.concat(second.videos, second.audios).map((item) => item.path),
    first.images.concat(first.videos, first.audios).map((item) => item.path),
  );
  for (const item of first.images.concat(first.videos, first.audios)) {
    assert.equal(path.relative(expectedRoot, item.path).startsWith('..'), false);
    assert.equal(fs.statSync(item.path).isFile(), true);
    assert.ok(fs.statSync(item.path).size > 0);
  }
  assert.equal(fs.existsSync(path.join(storageRoot, 'assets')), false);
  assert.equal(fs.existsSync(path.join(storageRoot, 'image_generations')), false);
  assert.equal(fs.existsSync(path.join(storageRoot, 'video_generations')), false);
  assert.deepEqual(tableCounts(db), before);
});

test('reference inputs match the capability exactly, use distinct signed URLs, and cap TTL at two hours', async (t) => {
  const storageRoot = tempStorage();
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const now = Date.parse('2026-08-18T00:00:00.000Z');
  const result = await buildReferenceInputs({
    storageRoot,
    filesBaseUrl: 'https://molimama.vip/static',
    secret: SECRET,
    now,
    ttlSeconds: 24 * 60 * 60,
    capability: {
      referenceImageCount: 2,
      referenceVideoCount: 1,
      referenceAudioCount: 1,
      firstFrame: true,
      lastFrame: true,
    },
  });

  assert.equal(result.imageUrls.length, 2);
  assert.equal(result.videoUrls.length, 1);
  assert.equal(result.audioUrls.length, 1);
  assert.ok(result.firstFrameUrl);
  assert.ok(result.lastFrameUrl);
  const all = [
    ...result.imageUrls,
    ...result.videoUrls,
    ...result.audioUrls,
    result.firstFrameUrl,
    result.lastFrameUrl,
  ];
  assert.equal(new Set(all).size, all.length);
  for (const value of all) {
    const signed = new URL(value);
    assert.match(signed.pathname, /^\/static\/_system\/provider-canary\/fixtures\//);
    const expires = Number(signed.searchParams.get('provider_asset_expires'));
    assert.ok(signed.searchParams.get('provider_asset_signature'));
    assert.ok(expires - Math.floor(now / 1000) <= 2 * 60 * 60);
    assert.ok(expires > Math.floor(now / 1000));
  }
});

test('video or audio references without ffmpeg fail closed with a budget_blocked signal', async (t) => {
  const storageRoot = tempStorage();
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => ensureFixtureSet({ storageRoot, imageCount: 1, videoCount: 1, ffmpegAvailable: false }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_CANARY_BUDGET_BLOCKED');
      assert.equal(error.state, 'budget_blocked');
      assert.equal(error.reason, 'ffmpeg_unavailable');
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(storageRoot, '_system', 'provider-canary', 'fixtures', 'video-01.mp4')), false);
});

test('reference fixtures fail closed when they cannot produce externally signed URLs', async (t) => {
  const storageRoot = tempStorage();
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));

  await assert.rejects(() => buildReferenceInputs({
    storageRoot,
    secret: SECRET,
    capability: { referenceImageCount: 1 },
  }), /signed URL|filesBaseUrl/i);
});

test('corrupt fixture files are replaced before they can be signed', async (t) => {
  const storageRoot = tempStorage();
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const root = path.join(storageRoot, '_system', 'provider-canary', 'fixtures');
  fs.mkdirSync(root, { recursive: true });
  for (const name of ['image-01.png', 'video-01.mp4', 'audio-01.wav']) {
    fs.writeFileSync(path.join(root, name), 'corrupt');
  }

  await ensureFixtureSet({ storageRoot, imageCount: 1, videoCount: 1, audioCount: 1 });

  const image = fs.readFileSync(path.join(root, 'image-01.png'));
  const video = fs.readFileSync(path.join(root, 'video-01.mp4'));
  const audio = fs.readFileSync(path.join(root, 'audio-01.wav'));
  assert.deepEqual(image.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.equal(video.subarray(4, 8).toString('ascii'), 'ftyp');
  assert.equal(audio.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(audio.subarray(8, 12).toString('ascii'), 'WAVE');
});
