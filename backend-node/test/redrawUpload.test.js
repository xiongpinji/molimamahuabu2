const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { getFfmpegPath, hasLocalFfmpeg, hasLocalFfprobe } = require('../src/utils/ffmpegPath');
const { MINIMAL_MP4 } = require('./fixtures/media');
const {
  validateSourceFile,
  safeZipEntry,
  expandSourceUpload,
} = require('../src/services/redrawUploadService');
const { createWorkFromSource } = require('../src/services/redrawService');
const redrawRoutes = require('../src/routes/redraw');

const NOW = '2026-08-06T00:00:00.000Z';

function makeTempDir(t, prefix = 'moli-redraw-upload-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeMp4(filePath, payload = 'video') {
  const header = Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d,
    0x6d, 0x70, 0x34, 0x32,
  ]);
  fs.writeFileSync(filePath, Buffer.concat([header, Buffer.from(payload)]));
}

function makeUpload(filePath, overrides = {}) {
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    originalname: path.basename(filePath),
    mimetype: 'video/mp4',
    size: stat.size,
    ...overrides,
  };
}

function writeZipWithRawEntryName(zipPath, rawName, data, safeName = rawName.replace(/\.\./g, 'aa')) {
  assert.equal(Buffer.byteLength(safeName), Buffer.byteLength(rawName));
  const zip = new AdmZip();
  zip.addFile(safeName, Buffer.from(data));
  zip.writeZip(zipPath);
  patchRawEntryName(zipPath, safeName, rawName);
}

function patchRawEntryName(zipPath, safeName, rawName) {
  assert.equal(Buffer.byteLength(safeName), Buffer.byteLength(rawName));
  const buffer = fs.readFileSync(zipPath);
  const safe = Buffer.from(safeName);
  const raw = Buffer.from(rawName);
  let matches = 0;
  let index = buffer.indexOf(safe);
  while (index !== -1) {
    raw.copy(buffer, index);
    matches += 1;
    index = buffer.indexOf(safe, index + raw.length);
  }
  assert.equal(matches, 2, 'raw ZIP fixture must patch local and central entry names');
  fs.writeFileSync(zipPath, buffer);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createRealMp4(filePath, { color, duration = 12, size = '32x32' }) {
  assert.equal(hasLocalFfmpeg(), true, 'real upload tests require the resolved local FFmpeg');
  assert.equal(hasLocalFfprobe(), true, 'real upload tests require the resolved local FFprobe');
  execFileSync(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=1`,
    '-t', String(duration), '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', filePath,
  ], { windowsHide: true, stdio: 'pipe' });
  return fs.readFileSync(filePath);
}

function writeZip(zipPath, entries) {
  const zip = new AdmZip();
  for (const [name, data] of entries) zip.addFile(name, data);
  zip.writeZip(zipPath);
}

function corruptEntryCrc(zipPath, entryIndex) {
  const source = fs.readFileSync(zipPath);
  const buffer = Buffer.from(source);
  const entries = new AdmZip(zipPath).getEntries();
  const entry = entries[entryIndex];
  const localOffset = entry.header.offset;
  assert.equal(source.readUInt32LE(localOffset), 0x04034b50);
  assert.equal(source.readUInt16LE(localOffset + 6) & 8, 0, 'CRC fixture must not use a data descriptor');
  const corruptCrc = (source.readUInt32LE(localOffset + 14) ^ 1) >>> 0;
  buffer.writeUInt32LE(corruptCrc, localOffset + 14);

  const eocdOffset = source.length - 22;
  assert.equal(source.readUInt32LE(eocdOffset), 0x06054b50);
  let centralOffset = source.readUInt32LE(eocdOffset + 16);
  let patched = false;
  for (let index = 0; index < entries.length; index += 1) {
    assert.equal(source.readUInt32LE(centralOffset), 0x02014b50);
    const nameLength = source.readUInt16LE(centralOffset + 28);
    const extraLength = source.readUInt16LE(centralOffset + 30);
    const commentLength = source.readUInt16LE(centralOffset + 32);
    const name = source.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString();
    if (name === entry.entryName) {
      buffer.writeUInt32LE(corruptCrc, centralOffset + 16);
      patched = true;
    }
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(patched, true);
  fs.writeFileSync(zipPath, buffer);
  assert.throws(() => new AdmZip(zipPath).getEntries()[entryIndex].getData(), /CRC/i);
}

function storageSnapshot(storageRoot) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else files.push({
        path: path.relative(storageRoot, filePath).replaceAll('\\', '/'),
        sha256: sha256(fs.readFileSync(filePath)),
      });
    }
  }
  walk(storageRoot);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function prepareProtectedStorage(root, existingVideo) {
  const storageRoot = path.join(root, 'storage');
  const tempRoot = path.join(root, 'extract-temp');
  fs.mkdirSync(path.join(storageRoot, 'redraw-sources'), { recursive: true });
  fs.mkdirSync(tempRoot);
  fs.writeFileSync(path.join(storageRoot, 'sentinel.txt'), 'existing sentinel');
  fs.writeFileSync(
    path.join(storageRoot, 'redraw-sources', `${sha256(existingVideo)}.mp4`),
    existingVideo,
  );
  return { storageRoot, tempRoot, before: storageSnapshot(storageRoot) };
}

function zipUpload(zipPath) {
  return makeUpload(zipPath, { originalname: path.basename(zipPath), mimetype: 'application/zip' });
}

function captureResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function createDb() {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const projectId = db.prepare(`
    INSERT INTO redraw_projects
      (tenant_id, user_id, title, default_locale, default_market, localization_level, status, created_at, updated_at)
    VALUES ('tenant-a', 'user-a', '转绘项目', 'en-US', 'US', 'faithful', 'draft', ?, ?)
  `).run(NOW, NOW).lastInsertRowid;
  return { db, projectId };
}

test('validateSourceFile rejects a spoofed mp4 before probing video facts', async (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'spoof.mp4');
  fs.writeFileSync(filePath, 'not-a-real-video');
  let probed = false;

  await assert.rejects(
    () => validateSourceFile(
      makeUpload(filePath),
      { maxBytes: 1024, minDurationMs: 15000, maxDurationMs: 3600000 },
      async () => {
        probed = true;
        return { duration_ms: 16000, width: 1920, height: 1080 };
      },
    ),
    (error) => error?.code === 'REDRAW_SOURCE_MAGIC_MISMATCH',
  );
  assert.equal(probed, false);
});

test('validateSourceFile accepts the 12s and 60min single-file boundaries by default', async (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'source.mp4');
  writeMp4(filePath, 'boundary');
  const upload = makeUpload(filePath, { size: fs.statSync(filePath).size });
  const limits = { maxBytes: 1024, maxDurationMs: 3600000 };

  const min = await validateSourceFile(upload, limits, async () => ({
    duration_ms: 12000,
    width: 1280,
    height: 720,
  }));
  const max = await validateSourceFile(upload, limits, async () => ({
    duration_ms: 3600000,
    width: 1920,
    height: 1080,
  }));

  assert.equal(min.kind, 'mp4');
  assert.equal(min.duration_ms, 12000);
  assert.equal(max.duration_ms, 3600000);
  assert.match(min.sha256, /^[a-f0-9]{64}$/);
});

test('validateSourceFile respects an explicit 15s minimum override', async (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'explicit-min.mp4');
  writeMp4(filePath, 'explicit-min');
  const upload = makeUpload(filePath, { size: fs.statSync(filePath).size });

  await assert.rejects(
    () => validateSourceFile(
      upload,
      { maxBytes: 1024, minDurationMs: 15000, maxDurationMs: 3600000 },
      async () => ({ duration_ms: 12000, width: 1280, height: 720 }),
    ),
    (error) => error?.code === 'REDRAW_SOURCE_DURATION_OUT_OF_RANGE',
  );
});

test('expandSourceUpload rejects zip path traversal and cleans extraction temp files', async (t) => {
  const dir = makeTempDir(t);
  const tempRoot = path.join(dir, 'tmp');
  fs.mkdirSync(tempRoot);
  const zipPath = path.join(dir, 'bad.zip');
  writeZipWithRawEntryName(zipPath, '../escape.mp4', 'escape');

  await assert.rejects(
    () => expandSourceUpload(
      makeUpload(zipPath, { originalname: 'bad.zip', mimetype: 'application/zip' }),
      {
        maxBytes: 1024 * 1024,
        zipMaxEntries: 20,
        zipMaxTotalBytes: 1024 * 1024,
        zipMinDurationMs: 15000,
        zipMaxDurationMs: 180000,
        tempRoot,
        assetUrlPrefix: '/static/redraw-sources',
      },
      async () => ({ duration_ms: 16000, width: 1280, height: 720 }),
    ),
    (error) => error?.code === 'REDRAW_ZIP_UNSAFE_PATH',
  );
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test('expandSourceUpload normalizes corrupt zip archives to a redraw domain error', async (t) => {
  const dir = makeTempDir(t);
  const zipPath = path.join(dir, 'corrupt.zip');
  fs.writeFileSync(zipPath, 'not-a-zip');

  await assert.rejects(
    () => expandSourceUpload(
      makeUpload(zipPath, { originalname: 'corrupt.zip', mimetype: 'application/zip' }),
      { maxBytes: 1024 * 1024, zipMaxEntries: 20, zipMaxTotalBytes: 1024 * 1024 },
      async () => ({ duration_ms: 16000, width: 1280, height: 720 }),
    ),
    (error) => error?.code === 'REDRAW_ZIP_INVALID',
  );
});

test('safeZipEntry rejects absolute, drive-letter and non-video entries', () => {
  assert.throws(() => safeZipEntry('/tmp/source.mp4'), (error) => error?.code === 'REDRAW_ZIP_UNSAFE_PATH');
  assert.throws(() => safeZipEntry('C:\\tmp\\source.mp4'), (error) => error?.code === 'REDRAW_ZIP_UNSAFE_PATH');
  assert.throws(() => safeZipEntry('clips/a\0b.mp4'), (error) => error?.code === 'REDRAW_ZIP_UNSAFE_PATH');
  assert.throws(() => safeZipEntry('notes/readme.txt'), (error) => error?.code === 'REDRAW_SOURCE_EXTENSION_UNSUPPORTED');
  assert.equal(safeZipEntry('clips/scene.MOV'), 'clips/scene.MOV');
});

test('failed ZIP entry CRC leaves no earlier source published and preserves existing files', async (t) => {
  const dir = makeTempDir(t);
  const first = createRealMp4(path.join(dir, 'first.mp4'), { color: 'red', size: '16x16' });
  const second = createRealMp4(path.join(dir, 'second.mp4'), { color: 'blue', size: '32x32' });
  const controlZipPath = path.join(dir, 'control.zip');
  writeZip(controlZipPath, [['first.mp4', first], ['second.mp4', second]]);
  const controlStorage = path.join(dir, 'control-storage');
  const controlTemp = path.join(dir, 'control-temp');
  fs.mkdirSync(controlTemp);

  const control = await expandSourceUpload(zipUpload(controlZipPath), {
    storageRoot: controlStorage,
    tempRoot: controlTemp,
  });
  assert.deepEqual(control.map((item) => [item.name, item.duration_ms]), [
    ['first.mp4', 12000],
    ['second.mp4', 12000],
  ]);
  assert.equal(fs.readFileSync(path.join(controlStorage, control[0].local_path)).equals(first), true);
  assert.equal(fs.readFileSync(path.join(controlStorage, control[1].local_path)).equals(second), true);
  assert.deepEqual(fs.readdirSync(controlTemp), []);

  const badZipPath = path.join(dir, 'bad-crc.zip');
  fs.copyFileSync(controlZipPath, badZipPath);
  corruptEntryCrc(badZipPath, 1);
  const protectedStorage = prepareProtectedStorage(dir, second);
  await assert.rejects(
    () => expandSourceUpload(zipUpload(badZipPath), protectedStorage),
    (error) => error?.code === 'REDRAW_ZIP_ENTRY_READ_FAILED',
  );
  assert.deepEqual(storageSnapshot(protectedStorage.storageRoot), protectedStorage.before);
  assert.deepEqual(fs.readdirSync(protectedStorage.tempRoot), []);
});

test('invalid second ZIP media leaves no earlier source published and preserves existing files', async (t) => {
  const dir = makeTempDir(t);
  const first = createRealMp4(path.join(dir, 'first.mp4'), { color: 'red', size: '16x16' });
  const existing = createRealMp4(path.join(dir, 'existing.mp4'), { color: 'blue', size: '32x32' });
  const zipPath = path.join(dir, 'bad-magic.zip');
  writeZip(zipPath, [['first.mp4', first], ['second.mp4', Buffer.from('not a video')]]);
  const protectedStorage = prepareProtectedStorage(dir, existing);

  await assert.rejects(
    () => expandSourceUpload(zipUpload(zipPath), protectedStorage),
    (error) => error?.code === 'REDRAW_SOURCE_MAGIC_MISMATCH',
  );
  assert.deepEqual(storageSnapshot(protectedStorage.storageRoot), protectedStorage.before);
  assert.deepEqual(fs.readdirSync(protectedStorage.tempRoot), []);
});

test('short second ZIP media leaves no earlier source published and preserves existing files', async (t) => {
  const dir = makeTempDir(t);
  const first = createRealMp4(path.join(dir, 'first.mp4'), { color: 'red', size: '16x16' });
  const existing = createRealMp4(path.join(dir, 'existing.mp4'), { color: 'blue', size: '32x32' });
  const short = createRealMp4(path.join(dir, 'short.mp4'), { color: 'green', duration: 11, size: '16x16' });
  const zipPath = path.join(dir, 'short-second.zip');
  writeZip(zipPath, [['first.mp4', first], ['short.mp4', short]]);
  const protectedStorage = prepareProtectedStorage(dir, existing);

  await assert.rejects(
    () => expandSourceUpload(zipUpload(zipPath), protectedStorage),
    (error) => error?.code === 'REDRAW_SOURCE_DURATION_OUT_OF_RANGE',
  );
  assert.deepEqual(storageSnapshot(protectedStorage.storageRoot), protectedStorage.before);
  assert.deepEqual(fs.readdirSync(protectedStorage.tempRoot), []);
});

test('delayed ZIP publish keeps accepted path aliases distinct and ordered', async (t) => {
  const dir = makeTempDir(t);
  const storageRoot = path.join(dir, 'storage');
  const tempRoot = path.join(dir, 'temp');
  fs.mkdirSync(tempRoot);
  const first = createRealMp4(path.join(dir, 'first.mp4'), { color: 'red', size: '16x16' });
  const second = createRealMp4(path.join(dir, 'second.mp4'), { color: 'blue', size: '32x32' });
  const zipPath = path.join(dir, 'aliases.zip');
  writeZip(zipPath, [['a.mp4', first], ['x/a.mp4', second]]);
  patchRawEntryName(zipPath, 'x/a.mp4', './a.mp4');
  assert.deepEqual(new AdmZip(zipPath).getEntries().map((entry) => entry.entryName), ['a.mp4', './a.mp4']);

  const items = await expandSourceUpload(zipUpload(zipPath), { storageRoot, tempRoot });
  assert.deepEqual(items.map((item) => item.name), ['a.mp4', './a.mp4']);
  assert.deepEqual(items.map((item) => item.sha256), [sha256(first), sha256(second)]);
  assert.equal(fs.readFileSync(path.join(storageRoot, items[0].local_path)).equals(first), true);
  assert.equal(fs.readFileSync(path.join(storageRoot, items[1].local_path)).equals(second), true);
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test('raw ZIP NUL entry is rejected with the safeZipEntry domain error', async (t) => {
  const dir = makeTempDir(t);
  const storageRoot = path.join(dir, 'storage');
  const tempRoot = path.join(dir, 'temp');
  fs.mkdirSync(storageRoot);
  fs.mkdirSync(tempRoot);
  const video = createRealMp4(path.join(dir, 'source.mp4'), { color: 'red', size: '16x16' });
  const zipPath = path.join(dir, 'nul.zip');
  writeZipWithRawEntryName(zipPath, 'a\0b.mp4', video, 'aXb.mp4');
  assert.equal(new AdmZip(zipPath).getEntries()[0].entryName, 'a\0b.mp4');

  await assert.rejects(
    () => expandSourceUpload(zipUpload(zipPath), { storageRoot, tempRoot }),
    (error) => error?.code === 'REDRAW_ZIP_UNSAFE_PATH',
  );
  assert.deepEqual(storageSnapshot(storageRoot), []);
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test('ZIP nested backslash MOV names remain accepted and duplicate content is reused', async (t) => {
  const dir = makeTempDir(t);
  const storageRoot = path.join(dir, 'storage');
  const tempRoot = path.join(dir, 'temp');
  fs.mkdirSync(tempRoot);
  const video = createRealMp4(path.join(dir, 'source.mp4'), { color: 'red', size: '16x16' });
  const zipPath = path.join(dir, 'nested.zip');
  writeZip(zipPath, [['folder/scene.MOV', video], ['nested/duplicate.MOV', video]]);
  patchRawEntryName(zipPath, 'folder/scene.MOV', 'folder\\scene.MOV');

  const items = await expandSourceUpload(zipUpload(zipPath), { storageRoot, tempRoot });
  assert.deepEqual(items.map((item) => item.name), ['folder/scene.MOV', 'nested/duplicate.MOV']);
  assert.deepEqual(items.map((item) => item.persisted_file_created), [true, false]);
  assert.equal(items[0].sha256, items[1].sha256);
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

test('createWorks rejects a real bad ZIP before asset or work rows and storage change', async (t) => {
  const dir = makeTempDir(t);
  const first = createRealMp4(path.join(dir, 'first.mp4'), { color: 'red', size: '16x16' });
  const second = createRealMp4(path.join(dir, 'second.mp4'), { color: 'blue', size: '32x32' });
  const zipPath = path.join(dir, 'route-bad-crc.zip');
  writeZip(zipPath, [['first.mp4', first], ['second.mp4', second]]);
  corruptEntryCrc(zipPath, 1);
  const protectedStorage = prepareProtectedStorage(dir, second);
  const { db, projectId } = createDb();
  try {
    const handlers = redrawRoutes(db, { error() {}, warn() {} }, {
      cfg: { storage: { local_path: protectedStorage.storageRoot } },
      uploadLimits: {
        storageRoot: protectedStorage.storageRoot,
        tempRoot: protectedStorage.tempRoot,
      },
    });
    const res = captureResponse();
    await handlers.createWorks({
      params: { id: String(projectId) },
      tenant: { id: 'tenant-a' },
      user: { id: 'user-a' },
      body: {},
      file: zipUpload(zipPath),
    }, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_works').get().count, 0);
    assert.deepEqual(storageSnapshot(protectedStorage.storageRoot), protectedStorage.before);
    assert.deepEqual(fs.readdirSync(protectedStorage.tempRoot), []);
  } finally {
    db.close();
  }
});

test('expandSourceUpload enforces zip entry count and total expanded size limits', async (t) => {
  const dir = makeTempDir(t);
  const overCountZip = path.join(dir, 'count.zip');
  const countZip = new AdmZip();
  for (let i = 0; i < 21; i += 1) {
    countZip.addFile(`clip-${i}.mp4`, Buffer.from('x'));
  }
  countZip.writeZip(overCountZip);

  await assert.rejects(
    () => expandSourceUpload(
      makeUpload(overCountZip, { originalname: 'count.zip', mimetype: 'application/zip' }),
      { maxBytes: 1024 * 1024, zipMaxEntries: 20, zipMaxTotalBytes: 1024 * 1024 },
      async () => ({ duration_ms: 16000, width: 1280, height: 720 }),
    ),
    (error) => error?.code === 'REDRAW_ZIP_TOO_MANY_ENTRIES',
  );

  const overSizeZip = path.join(dir, 'size.zip');
  const sizeZip = new AdmZip();
  sizeZip.addFile('clip.mp4', Buffer.alloc(11));
  sizeZip.writeZip(overSizeZip);

  await assert.rejects(
    () => expandSourceUpload(
      makeUpload(overSizeZip, { originalname: 'size.zip', mimetype: 'application/zip' }),
      { maxBytes: 1024 * 1024, zipMaxEntries: 20, zipMaxTotalBytes: 10 },
      async () => ({ duration_ms: 16000, width: 1280, height: 720 }),
    ),
    (error) => error?.code === 'REDRAW_ZIP_EXPANDED_TOO_LARGE',
  );
});

test('expandSourceUpload validates zip item duration between 12s and 180s by default and returns only controlled urls', async (t) => {
  const dir = makeTempDir(t);
  const storageRoot = path.join(dir, 'storage');
  const zipPath = path.join(dir, 'sources.zip');
  const zip = new AdmZip();
  const mp4 = path.join(dir, 'clip.mp4');
  writeMp4(mp4, 'zip-video');
  zip.addLocalFile(mp4, '', 'clip.mp4');
  zip.writeZip(zipPath);

  await assert.rejects(
    () => expandSourceUpload(
      makeUpload(zipPath, { originalname: 'sources.zip', mimetype: 'application/zip' }),
      {
        maxBytes: 1024 * 1024,
        zipMaxEntries: 20,
        zipMaxTotalBytes: 1024 * 1024,
        zipMaxDurationMs: 180000,
        assetUrlPrefix: '/static/redraw-sources',
      },
      async () => ({ duration_ms: 181000, width: 1280, height: 720 }),
    ),
    (error) => error?.code === 'REDRAW_SOURCE_DURATION_OUT_OF_RANGE',
  );

  const items = await expandSourceUpload(
    makeUpload(zipPath, { originalname: 'sources.zip', mimetype: 'application/zip' }),
    {
      maxBytes: 1024 * 1024,
      zipMaxEntries: 20,
      zipMaxTotalBytes: 1024 * 1024,
      zipMaxDurationMs: 180000,
      assetUrlPrefix: '/static/redraw-sources',
      storageRoot,
    },
    async () => ({ duration_ms: 12000, width: 1280, height: 720 }),
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].url.startsWith('/static/redraw-sources/'), true);
  assert.equal(items[0].url, `/static/${items[0].local_path}`);
  assert.equal(/^[A-Za-z]:/.test(items[0].url), false);
  assert.equal(JSON.stringify(items).includes(dir), false);
  assert.equal(JSON.stringify(items).includes(storageRoot), false);
  assert.equal(fs.existsSync(path.join(storageRoot, items[0].local_path)), true);
  assert.equal(items[0].duration_ms, 12000);
});

test('expandSourceUpload returns one item for a single source upload', async (t) => {
  const dir = makeTempDir(t);
  const storageRoot = path.join(dir, 'storage');
  const filePath = path.join(dir, 'single.mp4');
  writeMp4(filePath, 'single-video');

  const items = await expandSourceUpload(
    makeUpload(filePath),
    {
      maxBytes: 1024 * 1024,
      minDurationMs: 15000,
      maxDurationMs: 3600000,
      assetUrlPrefix: '/static/redraw-sources',
      storageRoot,
    },
    async () => ({ duration_ms: 3600000, width: 1920, height: 1080 }),
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'mp4');
  assert.equal(items[0].url.startsWith('/static/redraw-sources/'), true);
  assert.equal(items[0].url, `/static/${items[0].local_path}`);
  assert.equal(JSON.stringify(items).includes(dir), false);
  assert.equal(JSON.stringify(items).includes(storageRoot), false);
  assert.equal(fs.existsSync(path.join(storageRoot, items[0].local_path)), true);
});

test('expandSourceUpload uses the resolved ffprobe when the production route does not inject one', async (t) => {
  if (!hasLocalFfprobe()) return t.skip('ffprobe unavailable');
  const dir = makeTempDir(t);
  const storageRoot = path.join(dir, 'storage');
  const filePath = path.join(dir, 'real-minimal.mp4');
  fs.writeFileSync(filePath, MINIMAL_MP4);

  const items = await expandSourceUpload(makeUpload(filePath), {
    maxBytes: 1024 * 1024,
    minDurationMs: 1,
    maxDurationMs: 1000,
    storageRoot,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].width, 16);
  assert.equal(items[0].height, 16);
  assert.equal(items[0].duration_ms > 0, true);
  assert.equal(fs.existsSync(path.join(storageRoot, items[0].local_path)), true);
});

test('expandSourceUpload does not reuse a partial file already present at the stable storage path', async (t) => {
  const dir = makeTempDir(t);
  const storageRoot = path.join(dir, 'storage');
  const filePath = path.join(dir, 'single.mp4');
  writeMp4(filePath, 'single-video');
  const facts = await validateSourceFile(
    makeUpload(filePath),
    { maxBytes: 1024 * 1024, minDurationMs: 15000, maxDurationMs: 3600000 },
    async () => ({ duration_ms: 3600000, width: 1920, height: 1080 }),
  );
  const partialPath = path.join(storageRoot, 'redraw-sources', `${facts.sha256}.mp4`);
  fs.mkdirSync(path.dirname(partialPath), { recursive: true });
  fs.writeFileSync(partialPath, 'partial');

  await assert.rejects(
    () => expandSourceUpload(
      makeUpload(filePath),
      {
        maxBytes: 1024 * 1024,
        minDurationMs: 15000,
        maxDurationMs: 3600000,
        storageRoot,
      },
      async () => ({ duration_ms: 3600000, width: 1920, height: 1080 }),
    ),
    (error) => error?.code === 'REDRAW_STORAGE_CONFLICT',
  );
  assert.equal(fs.readFileSync(partialPath, 'utf8'), 'partial');
});

test('createWorkFromSource reuses active same-owner work but not other users, tenants or soft-deleted rows', () => {
  const { db, projectId } = createDb();
  try {
    const sourceAsset = {
      id: 101,
      name: 'source.mp4',
      sha256: 'f'.repeat(64),
      duration_ms: 90000,
    };
    const first = createWorkFromSource(db, { tenantId: 'tenant-a', userId: 'user-a' }, projectId, sourceAsset);
    const reused = createWorkFromSource(db, { tenantId: 'tenant-a', userId: 'user-a' }, projectId, {
      ...sourceAsset,
      id: 202,
    });
    assert.equal(reused.id, first.id);
    assert.equal(reused.reused, true);

    const otherUserProjectId = db.prepare(`
      INSERT INTO redraw_projects
        (tenant_id, user_id, title, default_locale, default_market, localization_level, status, created_at, updated_at)
      VALUES ('tenant-a', 'user-b', '同租户其他用户项目', 'en-US', 'US', 'faithful', 'draft', ?, ?)
    `).run(NOW, NOW).lastInsertRowid;
    const otherUser = createWorkFromSource(
      db,
      { tenantId: 'tenant-a', userId: 'user-b' },
      otherUserProjectId,
      { ...sourceAsset, id: 303 },
    );
    assert.notEqual(otherUser.id, first.id);
    assert.equal(otherUser.reused, false);

    const otherTenantProjectId = db.prepare(`
      INSERT INTO redraw_projects
        (tenant_id, user_id, title, default_locale, default_market, localization_level, status, created_at, updated_at)
      VALUES ('tenant-b', 'user-b', '其他转绘项目', 'en-US', 'US', 'faithful', 'draft', ?, ?)
    `).run(NOW, NOW).lastInsertRowid;
    const otherTenant = createWorkFromSource(
      db,
      { tenantId: 'tenant-b', userId: 'user-b' },
      otherTenantProjectId,
      { ...sourceAsset, id: 404 },
    );
    assert.notEqual(otherTenant.id, first.id);

    db.prepare('UPDATE redraw_works SET deleted_at = ? WHERE id = ?').run(NOW, first.id);
    const replacement = createWorkFromSource(
      db,
      { tenantId: 'tenant-a', userId: 'user-a' },
      projectId,
      { ...sourceAsset, id: 505 },
    );
    assert.notEqual(replacement.id, first.id);
    assert.equal(replacement.reused, false);
  } finally {
    db.close();
  }
});

test('createWorkFromSource rejects a project from another tenant or user before insert or reuse', () => {
  const { db } = createDb();
  try {
    const now = new Date().toISOString();
    const sameTenantOtherUserProjectId = db.prepare(`
      INSERT INTO redraw_projects
        (tenant_id, user_id, title, default_locale, default_market, localization_level, status, created_at, updated_at)
      VALUES ('tenant-a', 'user-b', '同租户其他用户项目', 'en-US', 'US', 'faithful', 'draft', ?, ?)
    `).run(now, now).lastInsertRowid;
    const otherTenantProjectId = db.prepare(`
      INSERT INTO redraw_projects
        (tenant_id, user_id, title, default_locale, default_market, localization_level, status, created_at, updated_at)
      VALUES ('tenant-b', 'user-b', '其他转绘项目', 'en-US', 'US', 'faithful', 'draft', ?, ?)
    `).run(now, now).lastInsertRowid;

    assert.throws(
      () => createWorkFromSource(
        db,
        { tenantId: 'tenant-a', userId: 'user-a' },
        sameTenantOtherUserProjectId,
        { id: 101, name: 'source.mp4', sha256: 'f'.repeat(64), duration_ms: 90000 },
      ),
      (error) => error?.code === 'REDRAW_PROJECT_NOT_FOUND',
    );
    assert.throws(
      () => createWorkFromSource(
        db,
        { tenantId: 'tenant-a', userId: 'user-a' },
        otherTenantProjectId,
        { id: 101, name: 'source.mp4', sha256: 'f'.repeat(64), duration_ms: 90000 },
      ),
      (error) => error?.code === 'REDRAW_PROJECT_NOT_FOUND',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM redraw_works').get().count, 0);
  } finally {
    db.close();
  }
});
