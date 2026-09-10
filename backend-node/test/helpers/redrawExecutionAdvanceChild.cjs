'use strict';

// Own fixture only; reopen existing SQLite, never migrate/start an app or perform real I/O transport.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const runs = require('../../src/services/redrawExecutionRunService');
const payload = JSON.parse(process.argv[2]);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
assert.ok(['inspect', 'resume', 'advance'].includes(payload.action));
assert.ok(path.isAbsolute(payload.databaseFile) && path.isAbsolute(payload.storageRoot));
assert.equal(path.basename(payload.storageRoot).startsWith('redraw-reference-bundle-fixture-'), true);
assert.equal(path.resolve(payload.databaseFile), path.join(path.resolve(payload.storageRoot), 'fixture.sqlite'));
assert.equal(path.dirname(path.resolve(process.cwd())), path.dirname(path.resolve(payload.storageRoot)));
assert.equal(path.basename(process.cwd()).startsWith('g4-advance-child-'), true);
assert.equal(fs.lstatSync(process.cwd()).isSymbolicLink(), false);
assert.equal(process.env.PATH, '');
for (const name of ['FFMPEG_PATH', 'FFPROBE_PATH']) assert.ok(path.isAbsolute(process.env[name]) && fs.statSync(process.env[name]).isFile());
const guards = [];
for (const [name, methods, kind] of [
  ['../../src/config/index.js', ['loadConfig'], 'DEFAULT_CONFIG'],
  ['../../src/db/index.js', ['getDb', 'closeDb'], 'DEFAULT_DATABASE'],
]) {
  const cached = require.cache[require.resolve(name)];
  assert.ok(cached?.loaded);
  for (const method of methods) guards.push([cached.exports[method], kind]);
}
guards.push([global.fetch, 'NETWORK']);
for (const name of ['node:http', 'node:https']) for (const method of ['request', 'get']) guards.push([require(name)[method], 'NETWORK']);
for (const name of ['node:net', 'node:tls']) for (const method of ['connect', 'createConnection']) {
  if (require(name)[method]) guards.push([require(name)[method], 'NETWORK']);
}
for (const [fn, kind] of guards) {
  assert.match(fn.toString(), /REDRAW_EXECUTION_TEST_FORBIDS_/);
  assert.throws(() => fn(), { message: 'REDRAW_EXECUTION_TEST_FORBIDS_' + kind });
}
const db = new Database(payload.databaseFile, { fileMustExist: true, timeout: 15000 });
db.pragma('foreign_keys = ON');
let announced = false;
const guardedDb = payload.contend ? new Proxy(db, { get(target, key) {
  if (key === 'transaction') return callback => {
    const transaction = target.transaction(callback);
    const wrapped = Object.assign((...args) => transaction(...args), {
      default: transaction.default, deferred: transaction.deferred, exclusive: transaction.exclusive, database: target,
    });
    wrapped.immediate = (...args) => {
      if (!announced) {
        announced = true;
        target.pragma('busy_timeout = 0');
        let code;
        try { target.exec('BEGIN IMMEDIATE'); target.exec('ROLLBACK'); }
        catch (error) { code = error.code; }
        finally { target.pragma('busy_timeout = 15000'); }
        assert.equal(code, 'SQLITE_BUSY');
        emit({ type: 'transaction_waiting', code });
      }
      return transaction.immediate(...args);
    };
    return wrapped;
  };
  const value = target[key];
  return typeof value === 'function' ? value.bind(target) : value;
} }) : db;
const ctx = { db: guardedDb, tenantId: 'tenant-a', userId: 'user-a', storageRoot: payload.storageRoot,
  tempRoot: process.cwd(), env: {}, log: { info() {}, warn() {}, error() {} },
  providerAssets: { storageRoot: payload.storageRoot, storageBaseUrl: 'https://assets.dispatch.synthetic.invalid',
    signingSecret: 'synthetic-dispatch-provider-signing-secret-only', nowMs: Date.parse('2026-09-07T00:00:00.000Z') },
  canReadArtifact: id => {
    const row = db.prepare('SELECT local_path FROM assets WHERE id=? AND deleted_at IS NULL').get(Number(id));
    return Boolean(row && fs.existsSync(path.join(payload.storageRoot, row.local_path)));
  } };
let posts = 0;
const runtime = { fetchImpl: async (_url, init) => {
  assert.equal(db.inTransaction, false); assert.equal(init.method, 'POST'); posts += 1;
  return new Response(JSON.stringify({ id: 'synthetic-advance-child-task', status: 'running' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
} };
emit({ type: 'started', guard_count: guards.length, node: process.execPath, environment_names: Object.keys(process.env).sort() });
const methods = { inspect: 'inspectExecutionRunAdvanceReadiness', resume: 'resumeExecutionRun', advance: 'advanceExecutionRun' };
Promise.resolve().then(() => {
  assert.equal(typeof runs[methods[payload.action]], 'function', 'real advance/resume service must exist after actual persisted fixture');
  return runs[methods[payload.action]](ctx, payload.versionId, payload.runId, payload.input, runtime);
}).then(result => emit({ type: 'result', result, posts }), error => {
  emit({ type: 'failure', code: error.code || error.name, message: error.message, posts });
  process.exitCode = 1;
}).finally(() => db.close());
