const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

describe('appVersion routes', () => {
  let server;
  let baseUrl;
  let prev = {};

  before(async () => {
    prev = {
      APP_VERSION: process.env.APP_VERSION,
      APP_RELEASE_NOTES: process.env.APP_RELEASE_NOTES,
      APP_FORCE_UPDATE: process.env.APP_FORCE_UPDATE,
    };
    process.env.APP_VERSION = '1.2.9';
    process.env.APP_RELEASE_NOTES = 'test notes';
    process.env.APP_FORCE_UPDATE = 'false';

    delete require.cache[require.resolve('../src/routes/appVersion')];
    const router = require('../src/routes/appVersion');
    const app = express();
    app.use('/api/v1/app', router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('returns current version info', async () => {
    const res = await fetch(`${baseUrl}/api/v1/app/version`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.version, '1.2.9');
    assert.equal(body.data.releaseNotes, 'test notes');
  });

  it('reports update when client version is older', async () => {
    const res = await fetch(`${baseUrl}/api/v1/app/version/check?current=1.0.0`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.hasUpdate, true);
    assert.equal(body.data.latestVersion, '1.2.9');
    assert.equal(body.data.forceUpdate, false);
  });

  it('reports no update when client version matches', async () => {
    const res = await fetch(`${baseUrl}/api/v1/app/version/check?current=1.2.9`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.hasUpdate, false);
  });
});
