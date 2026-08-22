const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  parseLocalhostRunUrl,
  startTemporaryMediaTunnel,
} = require('../src/services/temporaryMediaTunnelService');

function writeAsset(t, directory, name, body) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, body);
  return filePath;
}

test('parseLocalhostRunUrl ignores ANSI and log noise and only accepts localhost.run HTTPS URLs', () => {
  assert.equal(
    parseLocalhostRunUrl('\u001b[32mconnected\u001b[0m\nForwarding HTTP traffic from https://Quiet-42.localhost.run\r\n'),
    'https://quiet-42.localhost.run',
  );
  for (const value of [
    'http://quiet-42.localhost.run',
    'https://localhost.run',
    'https://quiet..localhost.run',
    'https://quiet-42.localhost.run.example.test',
    'https://example.test/quiet-42.localhost.run',
  ]) {
    assert.equal(parseLocalhostRunUrl(value), null);
  }
});

test('temporary tunnel serves opaque GET and HEAD routes and closes idempotently', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-tunnel-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const assets = [
    { id: 'shot', path: writeAsset(t, directory, 'source-shot.mp4', Buffer.from('video')), contentType: 'video/mp4' },
    { id: 'mateo', path: writeAsset(t, directory, 'mateo.png', Buffer.from('mateo')), contentType: 'image/png' },
    { id: 'cast', path: writeAsset(t, directory, 'cast.png', Buffer.from('cast')), contentType: 'image/png' },
  ];
  let localPort;
  let tunnelCloseCount = 0;
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    return fetch(`http://127.0.0.1:${localPort}${parsed.pathname}`, options);
  };
  const tunnel = await startTemporaryMediaTunnel({
    assets,
    spawnTunnel: async ({ port }) => {
      localPort = port;
      return {
        publicUrl: 'https://random.localhost.run',
        close: async () => { tunnelCloseCount += 1; },
      };
    },
    fetchImpl,
    maxLifetimeMs: 1000,
  });
  t.after(() => tunnel.close());

  assert.equal(tunnel.urls.length, 3);
  assert.equal(tunnel.urls.every((item) => item.url.startsWith('https://random.localhost.run/')), true);
  assert.equal(tunnel.urls.every((item) => !item.url.includes(path.basename(item.path))), true);
  assert.equal(tunnel.urls.every((item) => item.head_ok === true), true);
  assert.equal(new Set(tunnel.urls.map((item) => new URL(item.url).pathname)).size, 3);

  const shotPath = new URL(tunnel.urls[0].url).pathname;
  const head = await fetch(`http://127.0.0.1:${localPort}${shotPath}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'video/mp4');
  assert.equal(head.headers.get('content-length'), '5');
  assert.equal(head.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(head.headers.get('x-content-type-options'), 'nosniff');

  const get = await fetch(`http://127.0.0.1:${localPort}${shotPath}`);
  assert.equal(await get.text(), 'video');
  assert.equal((await fetch(`http://127.0.0.1:${localPort}/unknown`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${localPort}${shotPath}`, { method: 'POST' })).status, 405);

  await tunnel.close();
  await tunnel.close();
  assert.equal(tunnel.closed, true);
  assert.equal(tunnelCloseCount, 1);
});

test('HEAD validation failure closes both resources and returns one stable error code', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-tunnel-fail-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const assetPath = writeAsset(t, directory, 'shot.mp4', Buffer.from('video'));
  let closeCount = 0;

  await assert.rejects(
    () => startTemporaryMediaTunnel({
      assets: [{ id: 'shot', path: assetPath, contentType: 'video/mp4' }],
      spawnTunnel: async () => ({
        publicUrl: 'https://random.localhost.run',
        close: async () => { closeCount += 1; },
      }),
      fetchImpl: async () => ({
        status: 200,
        headers: new Headers({ 'content-type': 'text/plain', 'content-length': '5' }),
      }),
    }),
    (error) => error.code === 'TEMP_MEDIA_TUNNEL_UNAVAILABLE',
  );
  assert.equal(closeCount, 1);
});

test('default launcher uses the fixed non-interactive localhost.run SSH contract', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-tunnel-ssh-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const assetPath = writeAsset(t, directory, 'shot.mp4', Buffer.from('video'));
  let invocation;
  let child;
  const spawnImpl = (command, args, options) => {
    invocation = { command, args, options };
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    setImmediate(() => child.stderr.write('Forwarding HTTP traffic from https://fixed.localhost.run\n'));
    return child;
  };
  const fetchImpl = async (url, options) => {
    const remote = invocation.args[invocation.args.indexOf('-R') + 1];
    const port = Number(remote.split(':').at(-1));
    return fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, options);
  };
  const tunnel = await startTemporaryMediaTunnel({
    assets: [{ id: 'shot', path: assetPath, contentType: 'video/mp4' }],
    sshPath: 'test-ssh',
    spawnImpl,
    fetchImpl,
  });

  assert.equal(invocation.command, 'test-ssh');
  assert.deepEqual(invocation.args.slice(0, 8), [
    '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-R',
  ]);
  assert.match(invocation.args[8], /^80:127\.0\.0\.1:\d+$/);
  assert.equal(invocation.args[9], 'nokey@localhost.run');
  assert.deepEqual(invocation.options, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await tunnel.close();
  assert.equal(child.killed, true);
});
