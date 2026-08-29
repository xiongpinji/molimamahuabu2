const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const sharp = require('sharp');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { getFfmpegPath } = require('../src/utils/ffmpegPath');
const {
  bindReadyMotionReference,
  importCharacterReferenceArtifact,
  importMotionReferenceArtifact,
} = require('../src/services/redrawReferenceArtifactImportService');

const OWNER = Object.freeze({ tenantId: 'tenant-reference-import', userId: 'user-reference-import' });
const INITIAL_UPDATED_AT = '2026-08-27T00:00:00.000Z';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function storagePath(storageRoot, relativePath) {
  return path.join(storageRoot, ...relativePath.split('/'));
}

function storedArtifactFiles(storageRoot) {
  const directory = path.join(storageRoot, 'redraw-reference-artifacts');
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

function storedMotionFiles(storageRoot) {
  const directory = path.join(storageRoot, 'redraw-conditioning');
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((name) => !name.startsWith('.')).sort()
    : [];
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-reference-import-'));
  const storageRoot = path.join(root, 'storage');
  const db = new Database(path.join(root, 'fixture.sqlite'));
  runMigrationsAndEnsure(db);
  db.pragma('foreign_keys = ON');
  const projectId = Number(db.prepare(`
    INSERT INTO redraw_projects
      (tenant_id, user_id, title, created_at, updated_at)
    VALUES (?, ?, 'Reference import fixture', ?, ?)
  `).run(OWNER.tenantId, OWNER.userId, INITIAL_UPDATED_AT, INITIAL_UPDATED_AT).lastInsertRowid);
  const workId = Number(db.prepare(`
    INSERT INTO redraw_works
      (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
       duration_ms, created_at, updated_at)
    VALUES (?, ?, ?, 'Reference import work', 1, 'reference-import-source',
            12000, ?, ?)
  `).run(
    projectId,
    OWNER.tenantId,
    OWNER.userId,
    INITIAL_UPDATED_AT,
    INITIAL_UPDATED_AT,
  ).lastInsertRowid);
  const versionId = Number(db.prepare(`
    INSERT INTO redraw_versions
      (work_id, tenant_id, user_id, version, locale, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'en-US', ?, ?)
  `).run(
    workId,
    OWNER.tenantId,
    OWNER.userId,
    INITIAL_UPDATED_AT,
    INITIAL_UPDATED_AT,
  ).lastInsertRowid);
  const assetId = Number(db.prepare(`
    INSERT INTO redraw_assets
      (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
       asset_id, approval_status, approved_by, approved_at, status,
       error_code, error_message, created_at, updated_at)
    VALUES (?, ?, ?, 'character', ?, 'Main character', 77, 'approved',
            'reviewer-before-import', ?, 'generated', 'OLD_ERROR', 'old error', ?, ?)
  `).run(
    versionId,
    OWNER.tenantId,
    OWNER.userId,
    JSON.stringify({ source_ref: { source_character_key: 'character-main' } }),
    INITIAL_UPDATED_AT,
    INITIAL_UPDATED_AT,
    INITIAL_UPDATED_AT,
  ).lastInsertRowid);
  const log = { info() {}, warn() {}, error() {} };
  const ctx = {
    db,
    log,
    ...OWNER,
    versionId,
    storageRoot,
    now: () => INITIAL_UPDATED_AT,
  };
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, storageRoot, db, ctx, projectId, workId, versionId, assetId };
}

function createMotionFixture(t) {
  const fixture = createFixture(t);
  const sourceAssetId = Number(fixture.db.prepare(`
    INSERT INTO assets (
      name, type, category, url, local_path, file_size, mime_type,
      width, height, duration, metadata, created_at, updated_at
    ) VALUES (
      'Source video', 'video', 'redraw', '/static/source.mp4',
      'redraw-sources/source.mp4', 1000, 'video/mp4', 320, 180, 12,
      '{}', ?, ?
    )
  `).run(INITIAL_UPDATED_AT, INITIAL_UPDATED_AT).lastInsertRowid);
  const sourceFingerprint = 'a'.repeat(64);
  fixture.db.prepare(`
    UPDATE redraw_works
    SET source_asset_id = ?, source_fingerprint = ?
    WHERE id = ?
  `).run(sourceAssetId, sourceFingerprint, fixture.workId);
  const shotId = Number(fixture.db.prepare(`
    INSERT INTO redraw_shots (
      version_id, tenant_id, user_id, batch_index, shot_index,
      start_ms, end_ms, duration_ms, preparation_state,
      reference_bundle_json, reference_bundle_hash,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, 1, 1, 1000, 2000, 1000, 'parsed', '{}', NULL, ?, ?
    )
  `).run(
    fixture.versionId,
    OWNER.tenantId,
    OWNER.userId,
    INITIAL_UPDATED_AT,
    INITIAL_UPDATED_AT,
  ).lastInsertRowid);
  return {
    ...fixture,
    sourceAssetId,
    sourceFingerprint,
    shotId,
  };
}

function makeMotionFile(fixture, {
  durationSeconds = 1,
  width = 320,
  height = 180,
  codec = 'libx264',
  audio = false,
  container = 'mp4',
  mimetype = container === 'mp4' ? 'video/mp4' : 'video/x-matroska',
  originalname = `motion.${container}`,
} = {}) {
  const outputPath = path.join(
    fixture.root,
    `generated-${crypto.randomBytes(8).toString('hex')}.${container}`,
  );
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=blue:s=${width}x${height}:r=10:d=${durationSeconds}`,
  ];
  if (audio) {
    args.push(
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${durationSeconds}`,
      '-map', '0:v:0', '-map', '1:a:0',
    );
  }
  args.push('-c:v', codec, '-pix_fmt', 'yuv420p');
  if (codec === 'libx264') args.push('-preset', 'ultrafast');
  if (audio) args.push('-c:a', 'aac', '-shortest');
  else args.push('-an');
  args.push(outputPath);
  execFileSync(getFfmpegPath(), args, { windowsHide: true, stdio: 'pipe' });
  const buffer = fs.readFileSync(outputPath);
  return { buffer, originalname, mimetype, size: buffer.length };
}

function motionInput(shotId, file, overrides = {}) {
  return {
    shotId,
    expectedUpdatedAt: INITIAL_UPDATED_AT,
    idempotencyKey: `motion-import-${shotId}`,
    fullFrameReviewed: true,
    sourceIdentityObscured: true,
    sourceTextObscured: true,
    motionPreserved: true,
    file,
    ...overrides,
  };
}

async function makeImageFile({
  format = 'png',
  mimetype = `image/${format === 'jpeg' ? 'jpeg' : format}`,
  originalname = `reference.${format === 'jpeg' ? 'jpg' : format}`,
  width = 3,
  height = 2,
  color = { r: 31, g: 127, b: 223, alpha: 1 },
} = {}) {
  const buffer = await sharp({
    create: { width, height, channels: 4, background: color },
  })[format]().toBuffer();
  return { buffer, originalname, mimetype, size: buffer.length };
}

function importInput(assetId, file, overrides = {}) {
  return {
    assetId,
    purpose: 'identity',
    expectedUpdatedAt: INITIAL_UPDATED_AT,
    idempotencyKey: `identity-import-${assetId}`,
    file,
    ...overrides,
  };
}

test('reference artifact import migration creates scoped idempotency table', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  runMigrationsAndEnsure(db);
  const columns = db.prepare('PRAGMA table_info(redraw_reference_artifact_imports)').all()
    .map((row) => row.name);
  assert.deepEqual(columns, [
    'id',
    'tenant_id',
    'user_id',
    'version_id',
    'scope_type',
    'scope_id',
    'purpose',
    'idempotency_hash',
    'request_hash',
    'file_sha256',
    'stored_asset_id',
    'status',
    'error_code',
    'created_at',
    'updated_at',
  ]);

  const indexes = new Map(
    db.prepare('PRAGMA index_list(redraw_reference_artifact_imports)').all()
      .map((row) => [row.name, row]),
  );
  const uniqueIndex = indexes.get('uq_redraw_reference_artifact_imports_idempotency');
  assert.ok(uniqueIndex);
  assert.equal(uniqueIndex.unique, 1);
  assert.deepEqual(
    db.prepare('PRAGMA index_info(uq_redraw_reference_artifact_imports_idempotency)').all()
      .map((row) => row.name),
    [
      'tenant_id',
      'user_id',
      'version_id',
      'scope_type',
      'scope_id',
      'purpose',
      'idempotency_hash',
    ],
  );

  const scopeStatusIndex = indexes.get('idx_redraw_reference_artifact_imports_scope_status');
  assert.ok(scopeStatusIndex);
  assert.equal(scopeStatusIndex.unique, 0);
  assert.deepEqual(
    db.prepare('PRAGMA index_info(idx_redraw_reference_artifact_imports_scope_status)').all()
      .map((row) => row.name),
    ['tenant_id', 'user_id', 'version_id', 'scope_type', 'scope_id', 'status'],
  );

  const insertImport = db.prepare(`
    INSERT INTO redraw_reference_artifact_imports (
      tenant_id,
      user_id,
      version_id,
      scope_type,
      scope_id,
      purpose,
      idempotency_hash,
      request_hash,
      file_sha256,
      stored_asset_id,
      status,
      error_code,
      created_at,
      updated_at
    ) VALUES (
      @tenant_id,
      @user_id,
      @version_id,
      @scope_type,
      @scope_id,
      @purpose,
      @idempotency_hash,
      @request_hash,
      @file_sha256,
      @stored_asset_id,
      @status,
      @error_code,
      @created_at,
      @updated_at
    )
  `);
  const completedImport = {
    tenant_id: 'tenant-1',
    user_id: 'user-1',
    version_id: 1,
    scope_type: 'character',
    scope_id: 11,
    purpose: 'identity',
    idempotency_hash: 'a'.repeat(64),
    request_hash: 'b'.repeat(64),
    file_sha256: 'c'.repeat(64),
    stored_asset_id: 21,
    status: 'completed',
    error_code: null,
    created_at: '2026-08-27T00:00:00.000Z',
    updated_at: '2026-08-27T00:00:00.000Z',
  };
  insertImport.run(completedImport);

  assert.throws(
    () => insertImport.run({
      ...completedImport,
      request_hash: 'd'.repeat(64),
      file_sha256: 'e'.repeat(64),
    }),
    (error) => error.code === 'SQLITE_CONSTRAINT_UNIQUE'
      && /UNIQUE constraint failed/.test(error.message),
  );

  const isCheckConstraint = (error) => error.code === 'SQLITE_CONSTRAINT_CHECK'
    && /CHECK constraint failed/.test(error.message);
  assert.throws(
    () => insertImport.run({
      ...completedImport,
      scope_type: 'project',
      idempotency_hash: 'invalid-scope',
    }),
    isCheckConstraint,
  );
  assert.throws(
    () => insertImport.run({
      ...completedImport,
      purpose: 'style',
      idempotency_hash: 'invalid-purpose',
    }),
    isCheckConstraint,
  );
  assert.throws(
    () => insertImport.run({
      ...completedImport,
      status: 'pending',
      idempotency_hash: 'invalid-status',
    }),
    isCheckConstraint,
  );
});

test('reference artifact import service exposes narrow public API', async () => {
  const service = require('../src/services/redrawReferenceArtifactImportService');
  const publicFunctions = [
    'bindReadyMotionReference',
    'importCharacterReferenceArtifact',
    'importMotionReferenceArtifact',
  ];
  assert.deepEqual(Object.keys(service).sort(), publicFunctions.slice().sort());
  for (const functionName of publicFunctions) {
    await assert.rejects(service[functionName](), {
      code: 'REDRAW_REFERENCE_ARTIFACT_INPUT_INVALID',
    });
  }
});

test('identity import stores image asset and binds current character', async (t) => {
  const fixture = createFixture(t);
  const file = await makeImageFile();
  const fileSha = sha256(file.buffer);
  const idempotencyKey = 'identity-import-main-character';

  const result = await importCharacterReferenceArtifact(
    fixture.ctx,
    importInput(fixture.assetId, file, { idempotencyKey }),
  );

  assert.deepEqual(result, {
    purpose: 'identity',
    asset: {
      id: result.asset.id,
      type: 'image',
      mime_type: 'image/png',
      sha256: fileSha,
      width: 3,
      height: 2,
      file_size: file.buffer.length,
    },
    redraw_asset: {
      id: fixture.assetId,
      asset_id: result.asset.id,
      status: 'generated',
      approval_status: 'pending',
      approved_by: null,
      approved_at: null,
      error_code: null,
      updated_at: '2026-08-27T00:00:00.001Z',
    },
    billing: { credits: 0, held: 0, charged: 0 },
  });

  const relativePath = `redraw-reference-artifacts/${fileSha}.png`;
  assert.deepEqual(fs.readFileSync(storagePath(fixture.storageRoot, relativePath)), file.buffer);
  const storedAsset = fixture.db.prepare('SELECT * FROM assets WHERE id = ?').get(result.asset.id);
  assert.equal(storedAsset.type, 'image');
  assert.equal(storedAsset.category, 'redraw');
  assert.equal(storedAsset.url, `/static/${relativePath}`);
  assert.equal(storedAsset.local_path, relativePath);
  assert.equal(storedAsset.file_size, file.buffer.length);
  assert.equal(storedAsset.mime_type, 'image/png');
  assert.equal(storedAsset.width, 3);
  assert.equal(storedAsset.height, 2);
  assert.deepEqual(JSON.parse(storedAsset.metadata), {
    sha256: fileSha,
    source: 'redraw_reference_artifact_import',
    tenant_id: OWNER.tenantId,
    user_id: OWNER.userId,
    version_id: fixture.versionId,
    scope_type: 'character',
    scope_id: fixture.assetId,
    purpose: 'identity',
  });

  const character = fixture.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(fixture.assetId);
  assert.equal(character.asset_id, result.asset.id);
  assert.equal(character.status, 'generated');
  assert.equal(character.approval_status, 'pending');
  assert.equal(character.approved_by, null);
  assert.equal(character.approved_at, null);
  assert.equal(character.error_code, null);
  assert.equal(character.error_message, null);
  assert.ok(character.updated_at > INITIAL_UPDATED_AT);

  const importRecord = fixture.db.prepare(
    'SELECT * FROM redraw_reference_artifact_imports WHERE scope_id = ?',
  ).get(fixture.assetId);
  assert.equal(importRecord.status, 'completed');
  assert.equal(importRecord.stored_asset_id, result.asset.id);
  assert.equal(importRecord.file_sha256, fileSha);
  assert.equal(importRecord.idempotency_hash, sha256(idempotencyKey));
  assert.notEqual(importRecord.idempotency_hash, idempotencyKey);
  assert.doesNotMatch(JSON.stringify(result), /local_path|\/static\/|identity-import-main-character/);
  assert.equal(JSON.stringify(result).includes(fixture.storageRoot), false);
});

test('wardrobe import stores image asset without changing identity approval', async (t) => {
  const fixture = createFixture(t);
  const file = await makeImageFile({ format: 'webp', originalname: 'wardrobe.webp' });
  const before = fixture.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(fixture.assetId);

  const result = await importCharacterReferenceArtifact(
    fixture.ctx,
    importInput(fixture.assetId, file, {
      purpose: 'wardrobe',
      idempotencyKey: 'wardrobe-import-main-character',
    }),
  );

  assert.equal(result.purpose, 'wardrobe');
  assert.equal(result.asset.type, 'image');
  assert.equal(result.asset.mime_type, 'image/webp');
  assert.equal(result.asset.sha256, sha256(file.buffer));
  assert.deepEqual(result.billing, { credits: 0, held: 0, charged: 0 });
  assert.equal(Object.hasOwn(result, 'redraw_asset'), false);
  assert.deepEqual(
    fixture.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(fixture.assetId),
    before,
  );
  const storedAsset = fixture.db.prepare('SELECT * FROM assets WHERE id = ?').get(result.asset.id);
  assert.equal(JSON.parse(storedAsset.metadata).purpose, 'wardrobe');
});

test('identity import replays same idempotency key and rejects changed replay', async (t) => {
  const fixture = createFixture(t);
  const file = await makeImageFile();
  const input = importInput(fixture.assetId, file, { idempotencyKey: 'identity-replay-key' });

  const first = await importCharacterReferenceArtifact(fixture.ctx, input);
  const replay = await importCharacterReferenceArtifact(fixture.ctx, input);
  assert.deepEqual(replay, first);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 1);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    1,
  );

  const changedFile = await makeImageFile({
    format: 'jpeg',
    color: { r: 190, g: 40, b: 65, alpha: 1 },
  });
  await assert.rejects(
    importCharacterReferenceArtifact(fixture.ctx, { ...input, file: changedFile }),
    { code: 'REDRAW_REFERENCE_ARTIFACT_IDEMPOTENCY_CONFLICT' },
  );
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 1);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    1,
  );
});

test('identity import concurrent same-key requests replay one stored asset', async (t) => {
  const fixture = createFixture(t);
  const file = await makeImageFile({ width: 1024, height: 1024 });
  const input = importInput(fixture.assetId, file, {
    idempotencyKey: 'identity-concurrent-same-key',
  });

  const [first, second] = await Promise.all([
    importCharacterReferenceArtifact(fixture.ctx, input),
    importCharacterReferenceArtifact(fixture.ctx, input),
  ]);

  assert.deepEqual(second, first);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 1);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    1,
  );
  assert.equal(storedArtifactFiles(fixture.storageRoot).length, 1);
});

test('identity import concurrent changed-file requests return idempotency conflict', async (t) => {
  const fixture = createFixture(t);
  const firstFile = await makeImageFile({ width: 1024, height: 1024 });
  const secondFile = await makeImageFile({
    width: 1024,
    height: 1024,
    color: { r: 205, g: 35, b: 75, alpha: 1 },
  });
  const base = importInput(fixture.assetId, firstFile, {
    idempotencyKey: 'identity-concurrent-changed-file',
  });

  const settled = await Promise.allSettled([
    importCharacterReferenceArtifact(fixture.ctx, base),
    importCharacterReferenceArtifact(fixture.ctx, { ...base, file: secondFile }),
  ]);

  const fulfilled = settled.filter((result) => result.status === 'fulfilled');
  const rejected = settled.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'REDRAW_REFERENCE_ARTIFACT_IDEMPOTENCY_CONFLICT');
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 1);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    1,
  );
  assert.equal(storedArtifactFiles(fixture.storageRoot).length, 1);
});

test('identity import rejects stale expected_updated_at, cross-owner asset, forbidden fields and MIME mismatch', async (t) => {
  const fixture = createFixture(t);
  const file = await makeImageFile();

  await assert.rejects(
    importCharacterReferenceArtifact(
      fixture.ctx,
      importInput(fixture.assetId, file, { expectedUpdatedAt: '2026-08-26T23:59:59.000Z' }),
    ),
    { code: 'REDRAW_REFERENCE_ARTIFACT_CONFLICT' },
  );

  const crossOwnerId = Number(fixture.db.prepare(`
    INSERT INTO redraw_assets
      (version_id, tenant_id, user_id, kind, source_ref_json, created_at, updated_at)
    VALUES (?, 'tenant-other', 'user-other', 'character', '{}', ?, ?)
  `).run(fixture.versionId, INITIAL_UPDATED_AT, INITIAL_UPDATED_AT).lastInsertRowid);
  await assert.rejects(
    importCharacterReferenceArtifact(fixture.ctx, importInput(crossOwnerId, file)),
    { code: 'REDRAW_REFERENCE_ARTIFACT_NOT_FOUND' },
  );

  await assert.rejects(
    importCharacterReferenceArtifact(
      fixture.ctx,
      { ...importInput(fixture.assetId, file), asset_id: 999 },
    ),
    { code: 'REDRAW_REFERENCE_ARTIFACT_FORBIDDEN_FIELD' },
  );

  await assert.rejects(
    importCharacterReferenceArtifact(
      fixture.ctx,
      importInput(fixture.assetId, { ...file, mimetype: 'image/jpeg' }),
    ),
    { code: 'REDRAW_REFERENCE_ARTIFACT_MEDIA_INVALID' },
  );

  const oversized = Buffer.alloc((20 * 1024 * 1024) + 1);
  await assert.rejects(
    importCharacterReferenceArtifact(
      fixture.ctx,
      importInput(fixture.assetId, {
        buffer: oversized,
        originalname: 'oversized.png',
        mimetype: 'image/png',
        size: oversized.length,
      }),
    ),
    { code: 'REDRAW_REFERENCE_ARTIFACT_TOO_LARGE' },
  );

  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 0);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    0,
  );
});

test('identity import rejects oversized image dimensions without side effects', async (t) => {
  const fixture = createFixture(t);
  const file = await makeImageFile({ width: 4097, height: 1 });

  await assert.rejects(
    importCharacterReferenceArtifact(
      fixture.ctx,
      importInput(fixture.assetId, file, { idempotencyKey: 'identity-oversized-dimensions' }),
    ),
    { code: 'REDRAW_REFERENCE_ARTIFACT_MEDIA_INVALID' },
  );
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 0);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    0,
  );
  assert.deepEqual(storedArtifactFiles(fixture.storageRoot), []);
});

test('identity import removes newly-created file after database failure', async (t) => {
  const fixture = createFixture(t);
  const file = await makeImageFile();
  const relativePath = `redraw-reference-artifacts/${sha256(file.buffer)}.png`;
  fixture.db.exec(`
    CREATE TRIGGER reject_reference_asset_insert
    BEFORE INSERT ON assets
    BEGIN
      SELECT RAISE(ABORT, 'forced asset insert failure');
    END
  `);

  await assert.rejects(
    importCharacterReferenceArtifact(fixture.ctx, importInput(fixture.assetId, file)),
    { code: 'REDRAW_REFERENCE_ARTIFACT_STORAGE_FAILED' },
  );
  assert.equal(fs.existsSync(storagePath(fixture.storageRoot, relativePath)), false);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 0);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    0,
  );
});

test('identity import preserves pre-existing content-addressed file after database failure', async (t) => {
  const fixture = createFixture(t);
  const file = await makeImageFile();
  const relativePath = `redraw-reference-artifacts/${sha256(file.buffer)}.png`;
  const absolutePath = storagePath(fixture.storageRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, file.buffer);
  fixture.db.exec(`
    CREATE TRIGGER reject_reference_asset_insert
    BEFORE INSERT ON assets
    BEGIN
      SELECT RAISE(ABORT, 'forced asset insert failure');
    END
  `);

  await assert.rejects(
    importCharacterReferenceArtifact(fixture.ctx, importInput(fixture.assetId, file)),
    { code: 'REDRAW_REFERENCE_ARTIFACT_STORAGE_FAILED' },
  );
  assert.deepEqual(fs.readFileSync(absolutePath), file.buffer);
});

test('identity import rejects mismatched pre-existing content-addressed file without overwriting it', async (t) => {
  const fixture = createFixture(t);
  const file = await makeImageFile();
  const relativePath = `redraw-reference-artifacts/${sha256(file.buffer)}.png`;
  const absolutePath = storagePath(fixture.storageRoot, relativePath);
  const mismatched = Buffer.from('mismatched-existing-content');
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, mismatched);

  await assert.rejects(
    importCharacterReferenceArtifact(fixture.ctx, importInput(fixture.assetId, file)),
    { code: 'REDRAW_REFERENCE_ARTIFACT_STORAGE_FAILED' },
  );
  assert.deepEqual(fs.readFileSync(absolutePath), mismatched);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 0);
});

test('motion import stores reviewed silent candidate without making shot reference_ready', async (t) => {
  const fixture = createMotionFixture(t);
  const file = makeMotionFile(fixture);
  const fileSha = sha256(file.buffer);
  const shotBefore = fixture.db.prepare('SELECT * FROM redraw_shots WHERE id = ?')
    .get(fixture.shotId);

  const result = await importMotionReferenceArtifact(
    fixture.ctx,
    motionInput(fixture.shotId, file, { idempotencyKey: 'motion-happy-path' }),
  );

  assert.deepEqual(result, {
    purpose: 'motion',
    asset: {
      id: result.asset.id,
      type: 'video',
      mime_type: 'video/mp4',
      sha256: fileSha,
      duration_ms: 1000,
      width: 320,
      height: 180,
      file_size: file.buffer.length,
    },
    billing: { credits: 0, held: 0, charged: 0 },
  });

  const relativePath = `redraw-conditioning/${fileSha}.mp4`;
  assert.deepEqual(fs.readFileSync(storagePath(fixture.storageRoot, relativePath)), file.buffer);
  const storedAsset = fixture.db.prepare('SELECT * FROM assets WHERE id = ?').get(result.asset.id);
  assert.equal(storedAsset.type, 'video');
  assert.equal(storedAsset.category, 'redraw');
  assert.equal(storedAsset.local_path, relativePath);
  assert.equal(storedAsset.mime_type, 'video/mp4');
  assert.equal(storedAsset.width, 320);
  assert.equal(storedAsset.height, 180);
  assert.equal(storedAsset.file_size, file.buffer.length);
  const metadata = JSON.parse(storedAsset.metadata);
  assert.equal(Object.hasOwn(metadata, 'redraw_motion_reference'), false);
  assert.deepEqual(metadata.redraw_motion_import, {
    schema_version: 'redraw-motion-import-v1',
    tenant_id: OWNER.tenantId,
    user_id: OWNER.userId,
    version_id: fixture.versionId,
    shot_id: fixture.shotId,
    source_work_id: fixture.workId,
    source_asset_id: fixture.sourceAssetId,
    source_fingerprint: fixture.sourceFingerprint,
    clip_start_ms: 1000,
    clip_end_ms: 2000,
    file_sha256: fileSha,
    duration_ms: 1000,
    width: 320,
    height: 180,
    mime_type: 'video/mp4',
    video_codec: 'h264',
    audio_stream_count: 0,
    reviewed_by: OWNER.userId,
    reviewed_at: INITIAL_UPDATED_AT,
    review: {
      full_frame_reviewed: true,
      source_identity_obscured: true,
      source_text_obscured: true,
      motion_preserved: true,
    },
  });
  assert.equal(Object.hasOwn(metadata.redraw_motion_import, 'face_coverage_sha256'), false);
  assert.equal(Object.hasOwn(metadata.redraw_motion_import, 'text_coverage_sha256'), false);
  assert.deepEqual(
    fixture.db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(fixture.shotId),
    shotBefore,
  );
  assert.equal(shotBefore.preparation_state, 'parsed');
  assert.equal(shotBefore.reference_bundle_hash, null);
  assert.equal(JSON.stringify(result).includes(fixture.storageRoot), false);
  assert.doesNotMatch(JSON.stringify(result), /local_path|motion-happy-path|Authorization|Bearer/);
});

test('motion binding is not ready until current identity reviewed coverage and clean result exist', async (t) => {
  const fixture = createMotionFixture(t);
  const sourceBytes = Buffer.from('binding-not-ready-source');
  const sourceFingerprint = sha256(sourceBytes);
  const sourcePath = storagePath(fixture.storageRoot, 'redraw-sources/source.mp4');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, sourceBytes);
  fixture.db.prepare('UPDATE assets SET metadata = ? WHERE id = ?')
    .run(JSON.stringify({ sha256: sourceFingerprint }), fixture.sourceAssetId);
  fixture.db.prepare('UPDATE redraw_works SET source_fingerprint = ? WHERE id = ?')
    .run(sourceFingerprint, fixture.workId);
  fixture.db.prepare('UPDATE redraw_shots SET work_id = ? WHERE id = ?')
    .run(String(fixture.workId), fixture.shotId);
  const file = makeMotionFile(fixture);
  await importMotionReferenceArtifact(
    fixture.ctx,
    motionInput(fixture.shotId, file, { idempotencyKey: 'motion-binding-not-ready' }),
  );

  await assert.rejects(
    bindReadyMotionReference(fixture.ctx, {
      shot_id: fixture.shotId,
      clean_results: [],
    }),
    { code: 'REDRAW_MOTION_REFERENCE_BINDING_NOT_READY' },
  );
  const metadata = JSON.parse(fixture.db.prepare(`
    SELECT metadata FROM assets WHERE id = (
      SELECT stored_asset_id FROM redraw_reference_artifact_imports
      WHERE scope_type = 'shot' AND scope_id = ? AND purpose = 'motion'
    )
  `).get(fixture.shotId).metadata);
  assert.ok(metadata.redraw_motion_import);
  assert.equal(Object.hasOwn(metadata, 'redraw_motion_reference'), false);
  assert.equal(
    fixture.db.prepare('SELECT preparation_state FROM redraw_shots WHERE id = ?')
      .get(fixture.shotId).preparation_state,
    'parsed',
  );
});

test('motion import rejects every missing review assertion without side effects', async (t) => {
  const fixture = createMotionFixture(t);
  const file = makeMotionFile(fixture);
  const reviewFields = [
    'fullFrameReviewed',
    'sourceIdentityObscured',
    'sourceTextObscured',
    'motionPreserved',
  ];
  for (const field of reviewFields) {
    await assert.rejects(
      importMotionReferenceArtifact(
        fixture.ctx,
        motionInput(fixture.shotId, file, {
          [field]: false,
          idempotencyKey: `motion-review-${field}`,
        }),
      ),
      { code: 'REDRAW_MOTION_REFERENCE_REVIEW_REQUIRED' },
    );
  }
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 1);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    0,
  );
  assert.deepEqual(storedMotionFiles(fixture.storageRoot), []);
});

test('motion import rejects audio stream and duration mismatch without side effects', async (t) => {
  const fixture = createMotionFixture(t);
  const audioFile = makeMotionFile(fixture, { audio: true });
  await assert.rejects(
    importMotionReferenceArtifact(
      fixture.ctx,
      motionInput(fixture.shotId, audioFile, { idempotencyKey: 'motion-with-audio' }),
    ),
    { code: 'REDRAW_REFERENCE_ARTIFACT_MEDIA_INVALID' },
  );

  const longFile = makeMotionFile(fixture, { durationSeconds: 1.3 });
  await assert.rejects(
    importMotionReferenceArtifact(
      fixture.ctx,
      motionInput(fixture.shotId, longFile, { idempotencyKey: 'motion-too-long' }),
    ),
    { code: 'REDRAW_REFERENCE_ARTIFACT_MEDIA_INVALID' },
  );
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 1);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    0,
  );
  assert.deepEqual(storedMotionFiles(fixture.storageRoot), []);
});

test('motion import rejects dimension codec container and size mismatches', async (t) => {
  const fixture = createMotionFixture(t);
  const cases = [
    ['dimensions', makeMotionFile(fixture, { width: 640, height: 360 }), {}],
    ['codec', makeMotionFile(fixture, { codec: 'mpeg4' }), {}],
    ['container', makeMotionFile(fixture, { container: 'mkv' }), {}],
    ['size', makeMotionFile(fixture), { size: (200 * 1024 * 1024) + 1 }],
  ];
  for (const [name, file, changes] of cases) {
    await assert.rejects(
      importMotionReferenceArtifact(
        fixture.ctx,
        motionInput(fixture.shotId, { ...file, ...changes }, {
          idempotencyKey: `motion-invalid-${name}`,
        }),
      ),
      { code: name === 'size'
        ? 'REDRAW_REFERENCE_ARTIFACT_TOO_LARGE'
        : 'REDRAW_REFERENCE_ARTIFACT_MEDIA_INVALID' },
    );
  }
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 1);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    0,
  );
  assert.deepEqual(storedMotionFiles(fixture.storageRoot), []);
});

test('motion import rejects cross-owner shot stale CAS and client source overrides', async (t) => {
  const fixture = createMotionFixture(t);
  const file = makeMotionFile(fixture);
  const crossOwnerShotId = Number(fixture.db.prepare(`
    INSERT INTO redraw_shots (
      version_id, tenant_id, user_id, batch_index, shot_index,
      start_ms, end_ms, duration_ms, created_at, updated_at
    ) VALUES (?, 'tenant-other', 'user-other', 1, 2, 2000, 3000, 1000, ?, ?)
  `).run(fixture.versionId, INITIAL_UPDATED_AT, INITIAL_UPDATED_AT).lastInsertRowid);

  await assert.rejects(
    importMotionReferenceArtifact(fixture.ctx, motionInput(crossOwnerShotId, file)),
    { code: 'REDRAW_REFERENCE_ARTIFACT_NOT_FOUND' },
  );
  await assert.rejects(
    importMotionReferenceArtifact(
      fixture.ctx,
      motionInput(fixture.shotId, file, { expectedUpdatedAt: '2026-08-26T00:00:00.000Z' }),
    ),
    { code: 'REDRAW_REFERENCE_ARTIFACT_CONFLICT' },
  );
  await assert.rejects(
    importMotionReferenceArtifact(
      fixture.ctx,
      { ...motionInput(fixture.shotId, file), sourceAssetId: 999 },
    ),
    { code: 'REDRAW_REFERENCE_ARTIFACT_FORBIDDEN_FIELD' },
  );
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 1);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    0,
  );
  assert.deepEqual(storedMotionFiles(fixture.storageRoot), []);
});

test('motion import rejects unverifiable source fingerprint without side effects', async (t) => {
  const fixture = createMotionFixture(t);
  const file = makeMotionFile(fixture);
  fixture.db.prepare('UPDATE redraw_works SET source_fingerprint = ? WHERE id = ?')
    .run('not-a-server-source-hash', fixture.workId);

  await assert.rejects(
    importMotionReferenceArtifact(fixture.ctx, motionInput(fixture.shotId, file)),
    { code: 'REDRAW_REFERENCE_ARTIFACT_NOT_FOUND' },
  );
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 1);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    0,
  );
  assert.deepEqual(storedMotionFiles(fixture.storageRoot), []);
});

test('motion import replays same idempotency key and rejects changed replay', async (t) => {
  const fixture = createMotionFixture(t);
  const file = makeMotionFile(fixture);
  const input = motionInput(fixture.shotId, file, { idempotencyKey: 'motion-replay-key' });

  const first = await importMotionReferenceArtifact(fixture.ctx, input);
  const replay = await importMotionReferenceArtifact(fixture.ctx, input);
  assert.deepEqual(replay, first);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 2);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    1,
  );

  const changedFile = makeMotionFile(fixture, { durationSeconds: 1.05 });
  await assert.rejects(
    importMotionReferenceArtifact(fixture.ctx, { ...input, file: changedFile }),
    { code: 'REDRAW_REFERENCE_ARTIFACT_IDEMPOTENCY_CONFLICT' },
  );
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 2);
  assert.equal(storedMotionFiles(fixture.storageRoot).length, 1);
});

test('motion import idempotency replay rejects drifted source dimensions', async (t) => {
  const fixture = createMotionFixture(t);
  const file = makeMotionFile(fixture);
  const input = motionInput(fixture.shotId, file, {
    idempotencyKey: 'motion-replay-source-dimensions',
  });
  await importMotionReferenceArtifact(fixture.ctx, input);

  fixture.db.prepare('UPDATE assets SET width = 640 WHERE id = ?')
    .run(fixture.sourceAssetId);

  await assert.rejects(
    importMotionReferenceArtifact(fixture.ctx, input),
    { code: 'REDRAW_REFERENCE_ARTIFACT_IDEMPOTENCY_CONFLICT' },
  );
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 2);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    1,
  );
  assert.equal(storedMotionFiles(fixture.storageRoot).length, 1);
});

test('motion import idempotency replay rejects tampered pending binding metadata', async (t) => {
  const fixture = createMotionFixture(t);
  const file = makeMotionFile(fixture);
  const input = motionInput(fixture.shotId, file, {
    idempotencyKey: 'motion-replay-tampered-binding',
  });
  const first = await importMotionReferenceArtifact(fixture.ctx, input);
  const asset = fixture.db.prepare('SELECT metadata FROM assets WHERE id = ?')
    .get(first.asset.id);
  const metadata = JSON.parse(asset.metadata);
  metadata.redraw_motion_import.source_asset_id += 1;
  fixture.db.prepare('UPDATE assets SET metadata = ? WHERE id = ?')
    .run(JSON.stringify(metadata), first.asset.id);

  await assert.rejects(
    importMotionReferenceArtifact(fixture.ctx, input),
    { code: 'REDRAW_REFERENCE_ARTIFACT_STORAGE_FAILED' },
  );
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 2);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    1,
  );
});

test('motion import concurrent same-key requests create one asset and one import record', async (t) => {
  const fixture = createMotionFixture(t);
  const file = makeMotionFile(fixture);
  const input = motionInput(fixture.shotId, file, { idempotencyKey: 'motion-concurrent-key' });

  const [first, second] = await Promise.all([
    importMotionReferenceArtifact(fixture.ctx, input),
    importMotionReferenceArtifact(fixture.ctx, input),
  ]);

  assert.deepEqual(second, first);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 2);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    1,
  );
  assert.equal(storedMotionFiles(fixture.storageRoot).length, 1);
});

test('motion import concurrent changed-file requests return one idempotency conflict', async (t) => {
  const fixture = createMotionFixture(t);
  const firstFile = makeMotionFile(fixture);
  const secondFile = makeMotionFile(fixture, { durationSeconds: 1.05 });
  const base = motionInput(fixture.shotId, firstFile, {
    idempotencyKey: 'motion-concurrent-changed-file',
  });

  const settled = await Promise.allSettled([
    importMotionReferenceArtifact(fixture.ctx, base),
    importMotionReferenceArtifact(fixture.ctx, { ...base, file: secondFile }),
  ]);

  const fulfilled = settled.filter((item) => item.status === 'fulfilled');
  const rejected = settled.filter((item) => item.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'REDRAW_REFERENCE_ARTIFACT_IDEMPOTENCY_CONFLICT');
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 2);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    1,
  );
  assert.equal(storedMotionFiles(fixture.storageRoot).length, 1);
});

test('motion import database failure cleans newly-created file and leaves shot unchanged', async (t) => {
  const fixture = createMotionFixture(t);
  const file = makeMotionFile(fixture);
  const shotBefore = fixture.db.prepare('SELECT * FROM redraw_shots WHERE id = ?')
    .get(fixture.shotId);
  fixture.db.exec(`
    CREATE TRIGGER reject_motion_asset_insert
    BEFORE INSERT ON assets
    BEGIN
      SELECT RAISE(ABORT, 'forced motion asset insert failure');
    END
  `);

  await assert.rejects(
    importMotionReferenceArtifact(fixture.ctx, motionInput(fixture.shotId, file)),
    { code: 'REDRAW_REFERENCE_ARTIFACT_STORAGE_FAILED' },
  );
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 1);
  assert.equal(
    fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count,
    0,
  );
  assert.deepEqual(storedMotionFiles(fixture.storageRoot), []);
  assert.deepEqual(
    fixture.db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(fixture.shotId),
    shotBefore,
  );
});
