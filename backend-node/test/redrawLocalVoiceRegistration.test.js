const assert = require('node:assert/strict');
const test = require('node:test');

const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../src/db/migrate');

function columnNames(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
}

test('local voice registration migration creates the exact scoped contract idempotently', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  runMigrationsAndEnsure(db);
  runMigrationsAndEnsure(db);

  const table = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'redraw_local_voice_registrations'
  `).get();
  assert.ok(table?.sql, 'redraw_local_voice_registrations table should exist');

  assert.deepEqual(columnNames(db, 'redraw_local_voice_registrations'), [
    'id',
    'tenant_id',
    'user_id',
    'version_id',
    'voice_redraw_asset_id',
    'source_character_key',
    'idempotency_hash',
    'request_hash',
    'target_locale',
    'target_market',
    'approved_text_sha256',
    'profile_key',
    'engine_manifest_sha256',
    'status',
    'audio_asset_id',
    'audio_sha256',
    'locale_evidence_sha256',
    'error_code',
    'error_message',
    'created_at',
    'updated_at',
    'completed_at',
    'deleted_at',
  ]);

  assert.match(
    table.sql,
    /status\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*status\s+IN\s*\(\s*'processing'\s*,\s*'completed'\s*,\s*'needs_attention'\s*,\s*'failed'\s*\)\s*\)/i,
  );

  const foreignKeys = db.prepare('PRAGMA foreign_key_list(redraw_local_voice_registrations)').all()
    .map((row) => [row.from, row.table, row.to])
    .sort((left, right) => left[0].localeCompare(right[0]));
  assert.deepEqual(foreignKeys, [
    ['version_id', 'redraw_versions', 'id'],
    ['voice_redraw_asset_id', 'redraw_assets', 'id'],
  ]);

  const indexes = db.prepare('PRAGMA index_list(redraw_local_voice_registrations)').all();
  const idempotencyIndex = indexes.find((row) => row.name === 'uq_redraw_local_voice_registration_idempotency');
  assert.equal(idempotencyIndex?.unique, 1);
  assert.equal(idempotencyIndex?.partial, 1);
  assert.deepEqual(
    db.prepare('PRAGMA index_info(uq_redraw_local_voice_registration_idempotency)').all().map((row) => row.name),
    ['tenant_id', 'user_id', 'version_id', 'voice_redraw_asset_id', 'idempotency_hash'],
  );
  const indexSql = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'index'
      AND name = 'uq_redraw_local_voice_registration_idempotency'
  `).get().sql;
  assert.match(indexSql, /WHERE\s+deleted_at\s+IS\s+NULL/i);
});

test('local voice registration service exposes one narrow command', () => {
  const service = require('../src/services/redrawLocalVoiceRegistrationService');
  assert.deepEqual(Object.keys(service), ['registerLocalProductionVoice']);
});
