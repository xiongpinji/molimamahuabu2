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
const identityService = require('../src/services/redrawCharacterIdentityService');
const redrawAssetService = require('../src/services/redrawAssetService');
const redrawReviewService = require('../src/services/redrawReviewService');
const createRedrawHandlers = require('../src/routes/redraw');
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

function currentCharacter(fixture) {
  return fixture.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(fixture.assetId);
}

function invokeIdentityHandler(fixture, name, body = {}) {
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  const handlers = createRedrawHandlers(fixture.db, fixture.ctx.log, {
    cfg: { storage: { local_path: fixture.storageRoot } },
  });
  handlers[name]({
    params: { id: String(name === 'listVersionAssets' ? fixture.versionId : fixture.assetId) },
    tenant: { id: OWNER.tenantId },
    user: { id: OWNER.userId },
    body,
  }, response);
  return response;
}

function saveAndApproveIdentity(fixture, wardrobeAssetId) {
  const ownsReadableArtifact = (asset) => {
    const metadata = JSON.parse(asset?.metadata || '{}');
    return metadata.tenant_id === OWNER.tenantId && metadata.user_id === OWNER.userId
      && fs.existsSync(storagePath(fixture.storageRoot, asset.local_path));
  };
  const saved = identityService.saveIdentityPack({
    ...fixture.ctx,
    assetReader: { owns: ownsReadableArtifact, canRead: ownsReadableArtifact },
  }, fixture.assetId, {
    expected_updated_at: currentCharacter(fixture).updated_at,
    target_actor_label: 'Main character',
    confirmed_views: ['front', 'profile', 'full_body'],
    live_action_human_confirmed: true,
    adult_status: 'verified_18_plus',
    identity_consistency_confirmed: true,
    wardrobe_reference_asset_id: wardrobeAssetId,
    wardrobe_consistency_confirmed: true,
  });
  assert.equal(saved.identity_pack_status.ready, true);
  assert.equal(saved.identity_pack.artifact.asset_id, currentCharacter(fixture).asset_id);
  const approved = invokeIdentityHandler(fixture, 'reviewRedrawAsset', {
    action: 'approved', expected_updated_at: saved.updated_at,
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.body.data.asset.approval_status, 'approved');
  return saved.identity_pack;
}

async function createApprovedIdentityFixture(t) {
  const fixture = createFixture(t);
  fixture.db.prepare("UPDATE redraw_versions SET market = 'US' WHERE id = ?")
    .run(fixture.versionId);
  const file = await makeImageFile({ width: 48, height: 64 });
  const input = importInput(fixture.assetId, file, { idempotencyKey: 'identity-original' });
  const imported = await importCharacterReferenceArtifact(fixture.ctx, input);
  const pack = saveAndApproveIdentity(fixture, imported.asset.id);
  return { ...fixture, file, input, imported, pack };
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
  assert.deepEqual(Object.keys(service).sort(), [...publicFunctions, 'prepareMotionReferenceCandidate'].sort());
  for (const functionName of publicFunctions) {
    await assert.rejects(service[functionName](), {
      code: 'REDRAW_REFERENCE_ARTIFACT_INPUT_INVALID',
    });
  }
  await assert.rejects(service.prepareMotionReferenceCandidate(), {
    code: 'REDRAW_MOTION_CANDIDATE_INPUT_INVALID',
  });
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

test('identity replacement requires a new real identity pack before read list and review are ready', async (t) => {
  const fixture = await createApprovedIdentityFixture(t);
  const originalAsset = fixture.db.prepare('SELECT * FROM assets WHERE id = ?')
    .get(fixture.imported.asset.id);
  const sourceMetadata = {
    source_ref: { source_character_key: 'character-main', label: 'source character' },
    source: { legacy: 'keep source alias' },
    snapshot: { expression: 'neutral', identity_pack: { historical_note: 'keep nested data' } },
    custom_metadata: ['untouched', { value: 7 }],
  };
  fixture.db.prepare('UPDATE redraw_assets SET source_ref_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...sourceMetadata, identity_pack: fixture.pack }), fixture.assetId);
  const replacementFile = await makeImageFile({ width: 48, height: 64, color: '#df1f7f' });
  const replacement = await importCharacterReferenceArtifact(fixture.ctx,
    importInput(fixture.assetId, replacementFile, {
      idempotencyKey: 'identity-replacement',
      expectedUpdatedAt: currentCharacter(fixture).updated_at,
    }));
  const pending = currentCharacter(fixture);

  assert.notEqual(replacement.asset.id, fixture.imported.asset.id);
  assert.equal(pending.asset_id, replacement.asset.id);
  assert.equal(pending.approval_status, 'pending');
  assert.equal(identityService.readIdentityPack(pending), null);
  assert.equal(identityService.identityPackStatus(pending).ready, false);
  assert.deepEqual(JSON.parse(pending.source_ref_json), sourceMetadata);
  const dto = redrawAssetService.rowToAsset(pending);
  assert.equal(dto.identity_pack, null);
  assert.equal(dto.identity_pack_status.has_identity_pack, false);
  assert.equal(dto.identity_pack_status.ready, false);
  const listed = invokeIdentityHandler(fixture, 'listVersionAssets');
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.data.length, 1);
  assert.equal(listed.body.data[0].identity_pack, null);
  assert.equal(listed.body.data[0].identity_pack_status.ready, false);
  assert.throws(() => redrawReviewService.reviewAsset(fixture.db, fixture.assetId, {
    ...OWNER, reviewerId: OWNER.userId, action: 'approved', expected_updated_at: pending.updated_at,
  }), { code: 'REDRAW_CHARACTER_IDENTITY_REQUIRED' });
  const rejected = invokeIdentityHandler(fixture, 'reviewRedrawAsset', {
    action: 'approved', expected_updated_at: pending.updated_at,
  });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.body.error.code, 'REDRAW_CHARACTER_IDENTITY_REQUIRED');
  assert.equal(rejected.body.error.message, '角色资产必须先完成真人身份包审核');
  assert.deepEqual(currentCharacter(fixture), pending);

  const newPack = saveAndApproveIdentity(fixture, replacement.asset.id);
  assert.equal(newPack.artifact.asset_id, replacement.asset.id);
  assert.notEqual(newPack.pack_sha256, fixture.pack.pack_sha256);
  assert.equal(currentCharacter(fixture).approval_status, 'approved');
  assert.equal(redrawAssetService.rowToAsset(currentCharacter(fixture)).identity_pack_status.ready, true);
  assert.deepEqual(fixture.db.prepare('SELECT * FROM assets WHERE id = ?')
    .get(fixture.imported.asset.id), originalAsset);
  for (const result of [fixture.imported, replacement]) {
    assert.deepEqual(result.billing, { credits: 0, held: 0, charged: 0 });
    const asset = fixture.db.prepare('SELECT * FROM assets WHERE id = ?').get(result.asset.id);
    const decoded = await sharp(storagePath(fixture.storageRoot, asset.local_path)).raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, 48);
    assert.equal(decoded.info.height, 64);
    assert.ok(decoded.data.length > 0);
  }
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM credit_ledger').get().count, 0);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM tenant_credit_ledger').get().count, 0);
});

test('identity import without a pack preserves original source JSON bytes for both source aliases', async (t) => {
  for (const sourceField of ['source_ref', 'source']) {
    const fixture = createFixture(t);
    const sourceJson = `{ "${sourceField}" : { "source_character_key" : "character-main" }, "custom" : [1, true] }\n`;
    fixture.db.prepare('UPDATE redraw_assets SET source_ref_json = ? WHERE id = ?')
      .run(sourceJson, fixture.assetId);
    await importCharacterReferenceArtifact(fixture.ctx,
      importInput(fixture.assetId, await makeImageFile()));
    assert.equal(currentCharacter(fixture).source_ref_json, sourceJson);
  }
});

test('identity import with a new operation key revokes confirmation even for identical image bytes', async (t) => {
  const fixture = await createApprovedIdentityFixture(t);
  const replacement = await importCharacterReferenceArtifact(fixture.ctx,
    importInput(fixture.assetId, fixture.file, {
      idempotencyKey: 'identity-same-bytes-new-operation',
      expectedUpdatedAt: currentCharacter(fixture).updated_at,
    }));
  assert.notEqual(replacement.asset.id, fixture.imported.asset.id);
  assert.equal(currentCharacter(fixture).approval_status, 'pending');
  assert.equal(identityService.readIdentityPack(currentCharacter(fixture)), null);
  assert.equal(storedArtifactFiles(fixture.storageRoot).length, 1);
});

test('wardrobe import preserves the entire approved character row including its real identity pack', async (t) => {
  const fixture = await createApprovedIdentityFixture(t);
  const before = currentCharacter(fixture);
  await importCharacterReferenceArtifact(fixture.ctx,
    importInput(fixture.assetId, await makeImageFile({ color: '#123456' }), {
      purpose: 'wardrobe', idempotencyKey: 'wardrobe-with-ready-identity',
      expectedUpdatedAt: before.updated_at,
    }));
  assert.deepEqual(currentCharacter(fixture), before);
  assert.equal(identityService.identityPackStatus(currentCharacter(fixture)).ready, true);
});

test('identity idempotency replay does not revoke a later saved and approved replacement pack', async (t) => {
  const fixture = await createApprovedIdentityFixture(t);
  const replacementInput = importInput(fixture.assetId, await makeImageFile({ color: '#654321' }), {
    idempotencyKey: 'identity-replay-later-pack',
    expectedUpdatedAt: currentCharacter(fixture).updated_at,
  });
  const replacement = await importCharacterReferenceArtifact(fixture.ctx, replacementInput);
  saveAndApproveIdentity(fixture, replacement.asset.id);
  const before = currentCharacter(fixture);
  for (const input of [replacementInput, fixture.input]) {
    await importCharacterReferenceArtifact(fixture.ctx, input);
    assert.deepEqual(currentCharacter(fixture), before);
  }
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 2);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count, 2);
});

test('identity import rejection preserves the old pack for owner version CAS source and media failures', async (t) => {
  const cases = [
    ['owner', { userId: 'another-user' }, {}, null, 'REDRAW_REFERENCE_ARTIFACT_NOT_FOUND'],
    ['version', { versionId: 99999 }, {}, null, 'REDRAW_REFERENCE_ARTIFACT_NOT_FOUND'],
    ['CAS', {}, { expectedUpdatedAt: INITIAL_UPDATED_AT }, null, 'REDRAW_REFERENCE_ARTIFACT_CONFLICT'],
    ['media', {}, {}, null, 'REDRAW_REFERENCE_ARTIFACT_MEDIA_INVALID'],
    ['source-key', {}, {}, (payload) => JSON.stringify({ ...payload, source_ref: {} }), 'REDRAW_REFERENCE_ARTIFACT_INPUT_INVALID'],
    ['malformed-source', {}, {}, () => '{"identity_pack":', 'REDRAW_REFERENCE_ARTIFACT_INPUT_INVALID'],
  ];
  for (const [name, context, overrides, changeSource, code] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await createApprovedIdentityFixture(subtest);
      if (changeSource) {
        fixture.db.prepare('UPDATE redraw_assets SET source_ref_json = ? WHERE id = ?')
          .run(changeSource(JSON.parse(currentCharacter(fixture).source_ref_json)), fixture.assetId);
      }
      const before = currentCharacter(fixture);
      const file = await makeImageFile({ color: '#112233' });
      if (name === 'media') file.mimetype = 'image/jpeg';
      await assert.rejects(importCharacterReferenceArtifact({ ...fixture.ctx, ...context },
        importInput(fixture.assetId, file, {
          idempotencyKey: `identity-reject-${name}`, expectedUpdatedAt: before.updated_at, ...overrides,
        })), { code });
      assert.deepEqual(currentCharacter(fixture), before);
      assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 1);
      assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count, 1);
      assert.equal(storedArtifactFiles(fixture.storageRoot).length, 1);
    });
  }
});

test('identity import revokes only the pack from transaction-current source metadata', async (t) => {
  const fixture = await createApprovedIdentityFixture(t);
  const file = await makeImageFile({ color: '#998877' });
  const pending = importCharacterReferenceArtifact(fixture.ctx, importInput(fixture.assetId, file, {
    idempotencyKey: 'identity-current-source-payload',
    expectedUpdatedAt: currentCharacter(fixture).updated_at,
  }));
  const currentMetadata = {
    source: { source_character_key: 'character-main', latest: true },
    snapshot: { retained: 'written while image inspection awaited' },
  };
  fixture.db.prepare('UPDATE redraw_assets SET source_ref_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...currentMetadata, identity_pack: fixture.pack }), fixture.assetId);
  await pending;
  assert.deepEqual(JSON.parse(currentCharacter(fixture).source_ref_json), currentMetadata);
});

test('identity import rolls back pack revocation and the asset when the import record insert fails', async (t) => {
  const fixture = await createApprovedIdentityFixture(t);
  const before = currentCharacter(fixture);
  const filesBefore = storedArtifactFiles(fixture.storageRoot);
  fixture.db.exec(`
    CREATE TRIGGER reject_replacement_import_record BEFORE INSERT ON redraw_reference_artifact_imports
    BEGIN SELECT RAISE(ABORT, 'forced replacement import record failure'); END
  `);
  await assert.rejects(importCharacterReferenceArtifact(fixture.ctx,
    importInput(fixture.assetId, await makeImageFile({ color: '#102030' }), {
      idempotencyKey: 'identity-rollback-pack', expectedUpdatedAt: before.updated_at,
    })), { code: 'REDRAW_REFERENCE_ARTIFACT_STORAGE_FAILED' });
  assert.deepEqual(currentCharacter(fixture), before);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 1);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count, 1);
  assert.deepEqual(storedArtifactFiles(fixture.storageRoot), filesBefore);
});

test('identity import zero-row CAS update preserves the approved pack and rolls back the new asset', async (t) => {
  const fixture = await createApprovedIdentityFixture(t);
  const before = currentCharacter(fixture);
  fixture.db.exec(`
    CREATE TRIGGER ignore_replacement_CAS BEFORE UPDATE ON redraw_assets
    WHEN NEW.asset_id <> OLD.asset_id
    BEGIN SELECT RAISE(IGNORE); END
  `);
  await assert.rejects(importCharacterReferenceArtifact(fixture.ctx,
    importInput(fixture.assetId, await makeImageFile({ color: '#203040' }), {
      idempotencyKey: 'identity-zero-row-CAS', expectedUpdatedAt: before.updated_at,
    })), { code: 'REDRAW_REFERENCE_ARTIFACT_CONFLICT' });
  assert.deepEqual(currentCharacter(fixture), before);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 1);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM redraw_reference_artifact_imports').get().count, 1);
  assert.equal(storedArtifactFiles(fixture.storageRoot).length, 1);
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
