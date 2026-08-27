const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');

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
