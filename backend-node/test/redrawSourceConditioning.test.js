const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { getFfmpegPath, hasLocalFfmpeg } = require('../src/utils/ffmpegPath');
const {
  prepareSourceConditioning,
  createProviderAssetUrl,
  verifyProviderAssetUrl,
  resolveProviderAssetPath,
} = require('../src/services/redrawSourceConditioningService');
const { createProviderAssetHandler } = require('../src/routes/redrawProviderAssets');

const SIGNING_SECRET = 'test-redraw-provider-asset-secret-32-bytes-minimum';
const NOW_MS = Date.parse('2026-08-08T00:00:00.000Z');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-conditioning-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createSourceVideo(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  execFileSync(getFfmpegPath(), [
    '-y',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'testsrc2=duration=6:size=320x180:rate=25',
    '-f', 'lavfi',
    '-i', 'sine=frequency=880:sample_rate=48000:duration=6',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    filePath,
  ], { stdio: 'pipe' });
}

test('源片按 shot 毫秒边界生成并复用经 ffprobe 校验的 H.264/AAC 精确 segment', async (t) => {
  if (!hasLocalFfmpeg()) return t.skip('ffmpeg unavailable');
  const storageRoot = makeTempRoot(t);
  const sourceRelativePath = 'redraw-sources/source.mp4';
  const sourcePath = path.join(storageRoot, sourceRelativePath);
  createSourceVideo(sourcePath);
  const sourceFingerprint = sha256File(sourcePath);
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  const now = new Date(NOW_MS).toISOString();
  const sourceAssetId = db.prepare(`
    INSERT INTO assets
      (name, type, category, url, local_path, mime_type, created_at, updated_at)
    VALUES ('source.mp4', 'video', 'redraw-source', '/static/redraw-sources/source.mp4', ?, 'video/mp4', ?, ?)
  `).run(sourceRelativePath, now, now).lastInsertRowid;

  const input = {
    db,
    shot: { id: 17 },
    sourceAssetId,
    sourceFingerprint,
    startMs: 1250,
    endMs: 3750,
    storageRoot,
    storageBaseUrl: 'https://media.example.test/static',
    signingSecret: SIGNING_SECRET,
    nowMs: NOW_MS,
    ttlSeconds: 600,
  };
  const first = await prepareSourceConditioning(input);
  const second = await prepareSourceConditioning(input);
  const duplicateSourceAssetId = db.prepare(`
    INSERT INTO assets
      (name, type, category, url, local_path, mime_type, created_at, updated_at)
    VALUES ('source-copy.mp4', 'video', 'redraw-source', '/static/redraw-sources/source.mp4', ?, 'video/mp4', ?, ?)
  `).run(sourceRelativePath, now, now).lastInsertRowid;
  const duplicateAsset = await prepareSourceConditioning({ ...input, sourceAssetId: duplicateSourceAssetId });
  const firstAfterDuplicate = await prepareSourceConditioning(input);
  const shifted = await prepareSourceConditioning({ ...input, startMs: 1500, endMs: 4000 });
  const anotherShot = await prepareSourceConditioning({ ...input, shot: { id: 18 } });

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(duplicateAsset.reused, false);
  assert.equal(firstAfterDuplicate.reused, true);
  assert.equal(duplicateAsset.segmentSha256, first.segmentSha256);
  assert.equal(first.segmentSha256, second.segmentSha256);
  assert.notEqual(first.segmentSha256, shifted.segmentSha256);
  assert.equal(anotherShot.segmentSha256, first.segmentSha256);
  assert.equal(anotherShot.reused, true);
  assert.match(first.relativePath, /^redraw-conditioning\/[a-f0-9]{64}\.mp4$/);
  assert.equal(path.dirname(path.resolve(storageRoot, first.relativePath)), path.resolve(storageRoot, 'redraw-conditioning'));
  assert.equal(sha256File(path.join(storageRoot, first.relativePath)), first.segmentSha256);
  assert.equal(first.auditSnapshot.start_ms, 1250);
  assert.equal(first.auditSnapshot.end_ms, 3750);
  assert.equal(first.auditSnapshot.shot_id, 17);
  assert.equal(anotherShot.auditSnapshot.shot_id, 18);
  assert.ok(Math.abs(first.auditSnapshot.segment_duration_ms - 2500) <= 100);
  assert.equal(first.auditSnapshot.width, 320);
  assert.equal(first.auditSnapshot.height, 180);
  assert.equal(first.auditSnapshot.video_codec, 'h264');
  assert.equal(first.auditSnapshot.audio_codec, 'aac');
  assert.equal(JSON.stringify(first.auditSnapshot).includes(SIGNING_SECRET), false);
  assert.equal(JSON.stringify(first.auditSnapshot).includes('signature='), false);
  assert.match(first.referenceVideoUrl, /^https:\/\/media\.example\.test\/api\/v1\/redraw-provider-assets\/[a-f0-9]{64}\.mp4\?/);
});

test('provider asset URL 使用限时 HMAC 且对过期、坏签名、HTTP、localhost 和缺 secret fail closed', () => {
  const segmentSha256 = crypto.createHash('sha256').update('segment').digest('hex');
  const defaultWindow = createProviderAssetUrl({
    storageBaseUrl: 'https://media.example.test/static/files',
    segmentSha256,
    signingSecret: SIGNING_SECRET,
    nowMs: NOW_MS,
  });
  assert.equal(defaultWindow.expiresAt - Math.floor(NOW_MS / 1000), 30 * 60);
  const signed = createProviderAssetUrl({
    storageBaseUrl: 'https://media.example.test/static/files',
    segmentSha256,
    signingSecret: SIGNING_SECRET,
    nowMs: NOW_MS,
    ttlSeconds: 300,
  });

  assert.equal(new URL(signed.url).origin, 'https://media.example.test');
  assert.doesNotThrow(() => verifyProviderAssetUrl(signed.url, {
    storageBaseUrl: 'https://media.example.test/another/path',
    signingSecret: SIGNING_SECRET,
    nowMs: NOW_MS + 1000,
  }));
  const tampered = new URL(signed.url);
  tampered.searchParams.set('signature', '0'.repeat(64));
  assert.throws(
    () => verifyProviderAssetUrl(tampered.toString(), {
      storageBaseUrl: 'https://media.example.test/static',
      signingSecret: SIGNING_SECRET,
      nowMs: NOW_MS,
    }),
    (error) => error.code === 'REDRAW_PROVIDER_ASSET_SIGNATURE_INVALID',
  );
  assert.throws(
    () => verifyProviderAssetUrl(signed.url, {
      storageBaseUrl: 'https://media.example.test/static',
      signingSecret: SIGNING_SECRET,
      nowMs: NOW_MS + 301000,
    }),
    (error) => error.code === 'REDRAW_PROVIDER_ASSET_EXPIRED',
  );
  for (const storageBaseUrl of ['http://media.example.test/static', 'https://localhost/static', 'https://127.0.0.1/static']) {
    assert.throws(
      () => createProviderAssetUrl({ storageBaseUrl, segmentSha256, signingSecret: SIGNING_SECRET, nowMs: NOW_MS }),
      (error) => error.code === 'REDRAW_PROVIDER_ASSET_ORIGIN_UNSAFE',
    );
  }
  assert.throws(
    () => createProviderAssetUrl({
      storageBaseUrl: 'https://media.example.test/static',
      segmentSha256,
      signingSecret: '',
      nowMs: NOW_MS,
    }),
    (error) => error.code === 'REDRAW_PROVIDER_ASSET_SECRET_REQUIRED',
  );
});

test('provider asset 文件解析限制在 storage/redraw-conditioning 并校验内容 hash', async (t) => {
  const storageRoot = makeTempRoot(t);
  const content = Buffer.from('verified-provider-segment');
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const conditioningDir = path.join(storageRoot, 'redraw-conditioning');
  fs.mkdirSync(conditioningDir, { recursive: true });
  fs.writeFileSync(path.join(conditioningDir, `${hash}.mp4`), content);

  const resolved = await resolveProviderAssetPath({ storageRoot, filename: `${hash}.mp4` });
  assert.equal(resolved, path.join(conditioningDir, `${hash}.mp4`));
  await assert.rejects(
    () => resolveProviderAssetPath({ storageRoot, filename: '../source.mp4' }),
    (error) => error.code === 'REDRAW_PROVIDER_ASSET_PATH_INVALID',
  );
  fs.writeFileSync(path.join(conditioningDir, `${hash}.mp4`), Buffer.from('tampered'));
  await assert.rejects(
    () => resolveProviderAssetPath({ storageRoot, filename: `${hash}.mp4` }),
    (error) => error.code === 'REDRAW_PROVIDER_ASSET_HASH_MISMATCH',
  );
});

test('pre-auth provider asset handler 只读发送有效 MP4 且坏 HMAC 不暴露文件', async (t) => {
  const storageRoot = makeTempRoot(t);
  const content = Buffer.from('handler-provider-segment');
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const conditioningDir = path.join(storageRoot, 'redraw-conditioning');
  fs.mkdirSync(conditioningDir, { recursive: true });
  const absolutePath = path.join(conditioningDir, `${hash}.mp4`);
  fs.writeFileSync(absolutePath, content);
  const signed = createProviderAssetUrl({
    storageBaseUrl: 'https://media.example.test/static',
    segmentSha256: hash,
    signingSecret: SIGNING_SECRET,
    nowMs: NOW_MS,
    ttlSeconds: 300,
  });
  const handler = createProviderAssetHandler({
    storageRoot,
    storageBaseUrl: 'https://media.example.test/static',
    signingSecret: SIGNING_SECRET,
    nowMs: () => NOW_MS + 1000,
  });
  function responseCapture() {
    return {
      statusCode: 200,
      headers: {},
      sentFile: null,
      status(code) { this.statusCode = code; return this; },
      set(values) { Object.assign(this.headers, values); return this; },
      sendFile(value) { this.sentFile = value; return this; },
      json(value) { this.body = value; return this; },
    };
  }
  const url = new URL(signed.url);
  const validRes = responseCapture();
  await handler({
    params: { filename: `${hash}.mp4` },
    originalUrl: `${url.pathname}${url.search}`,
    headers: {
      host: '127.0.0.1:5679',
      'x-forwarded-host': 'media.example.test',
      'x-forwarded-proto': 'https',
    },
    socket: { remoteAddress: '127.0.0.1' },
  }, validRes);
  assert.equal(validRes.statusCode, 200);
  assert.equal(validRes.sentFile, absolutePath);
  assert.equal(validRes.headers['Cache-Control'], 'private, no-store, max-age=0');
  assert.equal(validRes.headers['Content-Type'], 'video/mp4');

  url.searchParams.set('signature', '0'.repeat(64));
  const badRes = responseCapture();
  await handler({
    params: { filename: `${hash}.mp4` },
    originalUrl: `${url.pathname}${url.search}`,
    headers: {
      host: '127.0.0.1:5679',
      'x-forwarded-host': 'media.example.test',
      'x-forwarded-proto': 'https',
    },
    socket: { remoteAddress: '127.0.0.1' },
  }, badRes);
  assert.equal(badRes.statusCode, 403);
  assert.equal(badRes.sentFile, null);
});
