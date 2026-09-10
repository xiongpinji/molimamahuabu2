'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fixture, snapshot, unchanged, assertSafe } = require('./helpers/redrawExecutionRunHttpFixture');

function getRaw(h, body, headers = {}) {
  const url = new URL(h.url('/execution-runs'));
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers: {
      Authorization: `Bearer ${h.actor.token}`, 'X-Tenant-Id': h.actor.tenantId,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }),
      ...headers,
    } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('local GET response aborted')));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('local GET request timed out')));
    // node:http sends these actual GET bytes; fetch rejects GET bodies client-side.
    req.end(body);
  });
}

function safeJson(res) {
  assert.match(res.headers['content-type'], /application\/json/);
  const body = JSON.parse(res.text);
  assertSafe(body);
  assert.doesNotMatch(res.text, /Error:|\.js:\d|SELECT |"stack"|<!DOCTYPE|<html/i);
  return body;
}

function assertDenied(res, status, code) {
  assert.equal(res.status, status);
  const body = safeJson(res);
  assert.equal(body.success, false);
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, 'string');
  assert.equal(Object.hasOwn(body, 'data'), false);
}

test('owned execution-run GET rejects actual empty JSON array bytes without DML or provider transport', async t => {
  const h = await fixture(t, { stage: 'idle' });
  assert.deepEqual(h.calls, { submits: 0, queries: 0, downloads: 0, other: 0 });
  const before = snapshot(h);
  const res = await getRaw(h, '[]');
  // Check all database bytes, real total_changes() and transport even on the RED response.
  unchanged(h, before);
  assertDenied(res, 400, 'EXECUTION_RUN_INPUT_INVALID');
});

test('owned execution-run GET without a body preserves existing run discovery and remains read-only', async t => {
  const h = await fixture(t, { stage: 'idle' });
  const before = snapshot(h);
  const res = await getRaw(h);
  assert.equal(res.status, 200);
  const body = safeJson(res);
  assert.equal(body.success, true);
  assert.equal(body.data.version_id, h.versionId);
  assert.equal(body.data.current_run_id, h.run.id);
  assert.deepEqual(body.data.runs.map(value => value.id), [h.run.id]);
  const normal = await h.request('/execution-runs');
  assert.equal(normal.status, 200);
  const normalBody = await normal.json();
  assertSafe(normalBody);
  assert.equal(normalBody.success, true);
  // The response envelope timestamp varies, but all valid discovery data must match.
  assert.deepEqual(body.data, normalBody.data);
  unchanged(h, before);
  assert.deepEqual(h.calls, { submits: 0, queries: 0, downloads: 0, other: 0 });
});

for (const [name, rawBody] of [['nonempty array', '[{}]'], ['nonempty object', '{"runtime":"injected"}']]) {
  test(`owned execution-run GET still rejects a ${name} without DML or provider transport`, async t => {
    const h = await fixture(t, { stage: 'idle' });
    const before = snapshot(h);
    const res = await getRaw(h, rawBody);
    unchanged(h, before);
    assertDenied(res, 400, 'EXECUTION_RUN_INPUT_INVALID');
    assert.deepEqual(h.calls, { submits: 0, queries: 0, downloads: 0, other: 0 });
  });
}

test('execution-run GET preserves tenant and version-owner isolation without DML or provider transport', async t => {
  const h = await fixture(t, { stage: 'idle' });
  const outsider = h.registerActor(true);
  const before = snapshot(h);
  // Membership is checked before body validation; the outsider cannot use the owner's tenant.
  const missingMembership = await getRaw(h, '[]', { Authorization: `Bearer ${outsider.token}` });
  unchanged(h, before);
  assertDenied(missingMembership, 404, 'EXECUTION_RUN_NOT_FOUND');
  // A valid personal tenant still grants no access to a different version owner.
  const wrongOwner = await getRaw(h, undefined, {
    Authorization: `Bearer ${outsider.token}`, 'X-Tenant-Id': outsider.tenantId,
  });
  unchanged(h, before);
  assertDenied(wrongOwner, 404, 'REDRAW_VERSION_NOT_FOUND');
  assert.deepEqual(h.calls, { submits: 0, queries: 0, downloads: 0, other: 0 });
});
