#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const Database = require('better-sqlite3');

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parseArgs(argv) {
  const result = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--apply') {
      result.apply = true;
      continue;
    }
    if (!['--db', '--config-id', '--expected-fingerprint'].includes(name) || index + 1 >= argv.length) {
      fail('INVALID_ARGUMENTS');
    }
    result[name.slice(2).replaceAll('-', '_')] = argv[index + 1];
    index += 1;
  }
  const configId = Number(result.config_id);
  if (!result.db || !Number.isSafeInteger(configId) || configId <= 0) fail('INVALID_ARGUMENTS');
  if (!fs.existsSync(result.db) || !fs.statSync(result.db).isFile()) fail('DATABASE_NOT_FOUND');
  if (result.apply && !/^[a-f0-9]{64}$/i.test(String(result.expected_fingerprint || ''))) {
    fail('EXPECTED_FINGERPRINT_REQUIRED');
  }
  return { ...result, configId };
}

function normalizeModels(value) {
  let parsed;
  try {
    parsed = JSON.parse(value || '[]');
  } catch (_) {
    parsed = [value];
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function readTarget(db, configId) {
  const row = db.prepare('SELECT * FROM ai_service_configs WHERE id = ? AND deleted_at IS NULL').get(configId);
  if (!row) fail('CONFIG_NOT_FOUND');
  const models = normalizeModels(row.model);
  const defaultModel = String(row.default_model || '').trim();
  if (!models.length || !defaultModel || !models.includes(defaultModel)) fail('INVALID_MODEL_CONFIGURATION');
  return { row, models, defaultModel };
}

function fingerprint(target) {
  const snapshot = { ...target.row, model: target.models, default_model: target.defaultModel };
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function publicPlan(target) {
  return {
    config_id: target.row.id,
    model_count: target.models.length,
    models: target.models,
    fingerprint: fingerprint(target),
  };
}

function cloneRow(db, source, model, now) {
  const columns = db.prepare('PRAGMA table_info(ai_service_configs)').all()
    .map((column) => column.name)
    .filter((name) => name !== 'id');
  const clone = { ...source };
  clone.model = JSON.stringify([model]);
  clone.default_model = model;
  clone.name = `${String(source.name || '供应商线路')} · ${model}`;
  clone.is_default = 0;
  clone.is_active = 0;
  clone.logical_model_id = null;
  clone.failover_enabled = 0;
  clone.verification_status = 'unverified';
  clone.verified_at = null;
  clone.verification_evidence = null;
  clone.verification_checked_at = null;
  clone.verification_error = null;
  clone.verified_capabilities = '{}';
  clone.created_at = now;
  clone.updated_at = now;
  clone.deleted_at = null;
  const selected = columns.filter((column) => Object.prototype.hasOwnProperty.call(clone, column));
  db.prepare(`INSERT INTO ai_service_configs (${selected.join(', ')})
    VALUES (${selected.map(() => '?').join(', ')})`).run(...selected.map((column) => clone[column]));
}

function applyPlan(db, configId, expectedFingerprint) {
  const before = readTarget(db, configId);
  if (fingerprint(before) !== expectedFingerprint.toLowerCase()) fail('STALE_FINGERPRINT');
  if (before.models.length <= 1) return publicPlan(before);

  return db.transaction(() => {
    const current = readTarget(db, configId);
    if (fingerprint(current) !== expectedFingerprint.toLowerCase()) fail('STALE_FINGERPRINT');
    const now = new Date().toISOString();
    db.prepare(`UPDATE ai_service_configs SET model = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`).run(JSON.stringify([current.defaultModel]), now, configId);
    for (const model of current.models) {
      if (model === current.defaultModel) continue;
      cloneRow(db, current.row, model, now);
    }
    return publicPlan(readTarget(db, configId));
  }).immediate();
}

function main(argv = process.argv.slice(2)) {
  let db;
  try {
    const options = parseArgs(argv);
    db = new Database(options.db);
    const target = readTarget(db, options.configId);
    const result = options.apply
      ? applyPlan(db, options.configId, String(options.expected_fingerprint).toLowerCase())
      : publicPlan(target);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.code || 'SPLIT_FAILED'}\n`);
    process.exitCode = 1;
  } finally {
    if (db) db.close();
  }
}

if (require.main === module) main();

module.exports = { applyPlan, fingerprint, main, normalizeModels, parseArgs, publicPlan, readTarget };
