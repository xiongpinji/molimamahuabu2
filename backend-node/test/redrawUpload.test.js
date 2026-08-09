const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  validateSourceFile,
  safeZipEntry,
  expandSourceUpload,
} = require('../src/services/redrawUploadService');
const { createWorkFromSource } = require('../src/services/redrawService');

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

function writeZipWithRawEntryName(zipPath, rawName, data) {
  const safeName = rawName.replace(/\.\./g, 'aa');
  assert.equal(Buffer.byteLength(safeName), Buffer.byteLength(rawName));
  const zip = new AdmZip();
  zip.addFile(safeName, Buffer.from(data));
  zip.writeZip(zipPath);
  const buffer = fs.readFileSync(zipPath);
  const safe = Buffer.from(safeName);
  const raw = Buffer.from(rawName);
  let index = buffer.indexOf(safe);
  while (index !== -1) {
    raw.copy(buffer, index);
    index = buffer.indexOf(safe, index + raw.length);
  }
  fs.writeFileSync(zipPath, buffer);
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

test('validateSourceFile accepts the 15s and 60min single-file boundaries', async (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'source.mp4');
  writeMp4(filePath, 'boundary');
  const upload = makeUpload(filePath, { size: fs.statSync(filePath).size });
  const limits = { maxBytes: 1024, minDurationMs: 15000, maxDurationMs: 3600000 };

  const min = await validateSourceFile(upload, limits, async () => ({
    duration_ms: 15000,
    width: 1280,
    height: 720,
  }));
  const max = await validateSourceFile(upload, limits, async () => ({
    duration_ms: 3600000,
    width: 1920,
    height: 1080,
  }));

  assert.equal(min.kind, 'mp4');
  assert.equal(min.duration_ms, 15000);
  assert.equal(max.duration_ms, 3600000);
  assert.match(min.sha256, /^[a-f0-9]{64}$/);
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
  assert.throws(() => safeZipEntry('notes/readme.txt'), (error) => error?.code === 'REDRAW_SOURCE_EXTENSION_UNSUPPORTED');
  assert.equal(safeZipEntry('clips/scene.MOV'), 'clips/scene.MOV');
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

test('expandSourceUpload validates zip item duration between 15s and 180s and returns only controlled urls', async (t) => {
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
        zipMinDurationMs: 15000,
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
      zipMinDurationMs: 15000,
      zipMaxDurationMs: 180000,
      assetUrlPrefix: '/static/redraw-sources',
      storageRoot,
    },
    async () => ({ duration_ms: 180000, width: 1280, height: 720 }),
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].url.startsWith('/static/redraw-sources/'), true);
  assert.equal(items[0].url, `/static/${items[0].local_path}`);
  assert.equal(/^[A-Za-z]:/.test(items[0].url), false);
  assert.equal(JSON.stringify(items).includes(dir), false);
  assert.equal(JSON.stringify(items).includes(storageRoot), false);
  assert.equal(fs.existsSync(path.join(storageRoot, items[0].local_path)), true);
  assert.equal(items[0].duration_ms, 180000);
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
