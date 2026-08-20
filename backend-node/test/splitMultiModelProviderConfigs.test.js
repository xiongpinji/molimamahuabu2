'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');

const script = path.resolve(__dirname, '../scripts/split-multi-model-provider-configs.js');

function fixture(models = ['model-primary', 'model-secondary', 'model-third']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-split-models-'));
  const dbPath = path.join(dir, 'fixture.sqlite');
  const db = new Database(dbPath);
  runMigrationsAndEnsure(db);
  const now = '2026-08-20T00:00:00.000Z';
  const info = db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, api_protocol, name, base_url, api_key, model, default_model,
     endpoint, query_endpoint, priority, is_default, is_active, settings, logical_model_id,
     failover_enabled, verification_status, verified_at, verification_evidence, created_at, updated_at)
    VALUES ('image', 'private-provider', 'openai', 'Private Multi Model',
      'https://private-relay.example/v1', 'test-secret-key', ?, 'model-primary',
      '/images/generations', '/images/tasks/{taskId}', 50, 1, 1, ?, 'logical-public-model',
      1, 'verified', ?, 'private-evidence', ?, ?)`)
    .run(JSON.stringify(models), JSON.stringify({ private_token: 'settings-secret', public_note: 'safe' }), now, now, now);
  db.close();
  return { dir, dbPath, configId: Number(info.lastInsertRowid) };
}

function cleanup(item) {
  fs.rmSync(item.dir, { recursive: true, force: true });
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  });
}

function rows(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const result = db.prepare(`SELECT id, name, base_url, api_key, model, default_model,
      is_default, is_active, settings, logical_model_id, failover_enabled,
      verification_status, verified_at, verification_evidence, deleted_at
    FROM ai_service_configs ORDER BY id`).all();
  db.close();
  return result;
}

test('无参数失败且 dry-run 只输出脱敏稳定计划、不写数据库', (t) => {
  const item = fixture();
  t.after(() => cleanup(item));
  const missing = run([]);
  assert.notEqual(missing.status, 0);

  const before = rows(item.dbPath);
  const result = run(['--db', item.dbPath, '--config-id', String(item.configId)]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(plan).sort(), ['config_id', 'fingerprint', 'model_count', 'models']);
  assert.equal(plan.config_id, item.configId);
  assert.equal(plan.model_count, 3);
  assert.deepEqual(plan.models, ['model-primary', 'model-secondary', 'model-third']);
  assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(rows(item.dbPath), before);
  const output = `${result.stdout}${result.stderr}`;
  for (const privateValue of [
    'test-secret-key', 'private-relay.example', 'settings-secret', 'private-evidence',
  ]) assert.equal(output.includes(privateValue), false, privateValue);

  const repeat = run(['--db', item.dbPath, '--config-id', String(item.configId)]);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout).fingerprint, plan.fingerprint);
});

test('--apply 缺少或使用过期指纹时不写数据库', (t) => {
  const item = fixture();
  t.after(() => cleanup(item));
  const before = rows(item.dbPath);
  const missing = run(['--db', item.dbPath, '--config-id', String(item.configId), '--apply']);
  assert.notEqual(missing.status, 0);
  assert.deepEqual(rows(item.dbPath), before);

  const stale = run([
    '--db', item.dbPath, '--config-id', String(item.configId), '--apply',
    '--expected-fingerprint', '0'.repeat(64),
  ]);
  assert.notEqual(stale.status, 0);
  assert.deepEqual(rows(item.dbPath), before);
});

test('应用后原配置只保留默认模型，克隆停用、未验证且没有逻辑模型绑定', (t) => {
  const item = fixture();
  t.after(() => cleanup(item));
  const dryRun = run(['--db', item.dbPath, '--config-id', String(item.configId)]);
  const fingerprint = JSON.parse(dryRun.stdout).fingerprint;
  const applied = run([
    '--db', item.dbPath, '--config-id', String(item.configId), '--apply',
    '--expected-fingerprint', fingerprint,
  ]);
  assert.equal(applied.status, 0, applied.stderr);
  const result = rows(item.dbPath);
  assert.equal(result.length, 3);
  assert.deepEqual(JSON.parse(result[0].model), ['model-primary']);
  assert.equal(result[0].default_model, 'model-primary');
  assert.equal(result[0].is_active, 1);
  assert.equal(result[0].logical_model_id, 'logical-public-model');

  for (const [index, model] of ['model-secondary', 'model-third'].entries()) {
    const clone = result[index + 1];
    assert.deepEqual(JSON.parse(clone.model), [model]);
    assert.equal(clone.default_model, model);
    assert.equal(clone.is_active, 0);
    assert.equal(clone.is_default, 0);
    assert.equal(clone.logical_model_id, null);
    assert.equal(clone.failover_enabled, 0);
    assert.equal(clone.verification_status, 'unverified');
    assert.equal(clone.verified_at, null);
    assert.equal(clone.verification_evidence, null);
    assert.equal(clone.deleted_at, null);
    assert.equal(clone.api_key, 'test-secret-key');
    assert.equal(clone.base_url, 'https://private-relay.example/v1');
    assert.equal(JSON.parse(clone.settings).private_token, 'settings-secret');
  }
  const output = `${applied.stdout}${applied.stderr}`;
  assert.equal(output.includes('test-secret-key'), false);
  assert.equal(output.includes('private-relay.example'), false);
});

test('插入失败时原配置缩窄和全部克隆都回滚', (t) => {
  const item = fixture(['model-primary', 'model-secondary', 'model-fail']);
  t.after(() => cleanup(item));
  const db = new Database(item.dbPath);
  db.exec(`CREATE TRIGGER reject_model_fail BEFORE INSERT ON ai_service_configs
    WHEN NEW.default_model = 'model-fail'
    BEGIN SELECT RAISE(ABORT, 'fixture rejected clone'); END`);
  db.close();
  const before = rows(item.dbPath);
  const dryRun = run(['--db', item.dbPath, '--config-id', String(item.configId)]);
  const failed = run([
    '--db', item.dbPath, '--config-id', String(item.configId), '--apply',
    '--expected-fingerprint', JSON.parse(dryRun.stdout).fingerprint,
  ]);
  assert.notEqual(failed.status, 0);
  assert.deepEqual(rows(item.dbPath), before);
  assert.equal(`${failed.stdout}${failed.stderr}`.includes('test-secret-key'), false);
});

test('重复执行不会创建更多克隆，也不会启用或公开拆出的模型', (t) => {
  const item = fixture();
  t.after(() => cleanup(item));
  const firstPlan = JSON.parse(run(['--db', item.dbPath, '--config-id', String(item.configId)]).stdout);
  assert.equal(run([
    '--db', item.dbPath, '--config-id', String(item.configId), '--apply',
    '--expected-fingerprint', firstPlan.fingerprint,
  ]).status, 0);
  const afterFirst = rows(item.dbPath);
  const secondPlan = JSON.parse(run(['--db', item.dbPath, '--config-id', String(item.configId)]).stdout);
  assert.equal(secondPlan.model_count, 1);
  assert.equal(run([
    '--db', item.dbPath, '--config-id', String(item.configId), '--apply',
    '--expected-fingerprint', secondPlan.fingerprint,
  ]).status, 0);
  assert.deepEqual(rows(item.dbPath), afterFirst);
  assert.equal(afterFirst.filter((row) => row.is_active === 1).length, 1);
  assert.equal(afterFirst.filter((row) => row.logical_model_id != null).length, 1);
});
