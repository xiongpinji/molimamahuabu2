const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');

const DEFAULT_MAX_LIFETIME_MS = 15 * 60 * 1000;
const DEFAULT_TUNNEL_URL_TIMEOUT_MS = 20 * 1000;

function codedError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'TEMP_MEDIA_TUNNEL_UNAVAILABLE';
  return error;
}

function parseLocalhostRunUrl(value) {
  const text = String(value || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  const matches = text.match(new RegExp(`https://(?:${label}\\.)+localhost\\.run(?![a-z0-9.-])`, 'ig')) || [];
  for (const match of matches) {
    try {
      const parsed = new URL(match);
      if (parsed.protocol === 'https:' && parsed.hostname !== 'localhost.run'
        && parsed.hostname.endsWith('.localhost.run')) {
        return parsed.origin.toLowerCase();
      }
    } catch {
      // Ignore malformed log fragments and continue scanning.
    }
  }
  return null;
}

function normalizeAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0) {
    throw codedError('临时媒体通道缺少资产');
  }
  const ids = new Set();
  return assets.map((asset) => {
    const id = String(asset?.id || '').trim();
    const contentType = String(asset?.contentType || '').trim().toLowerCase();
    if (!id || ids.has(id)) throw codedError('临时媒体资产 ID 无效或重复');
    if (!contentType || /[\r\n]/.test(contentType)) throw codedError('临时媒体 Content-Type 无效');
    ids.add(id);
    try {
      const filePath = fs.realpathSync(String(asset?.path || ''));
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error('not a regular file');
      return { id, path: filePath, contentType, size: stat.size };
    } catch (error) {
      throw codedError(`临时媒体资产不可读取: ${id}`, error);
    }
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function defaultSpawnTunnel({
  port,
  sshPath = 'ssh',
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TUNNEL_URL_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(sshPath, [
      '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15', '-R', `80:127.0.0.1:${port}`,
      'nokey@localhost.run',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const finish = (error, publicUrl) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (!child.killed) child.kill();
        reject(error);
        return;
      }
      resolve({
        publicUrl,
        close: async () => {
          if (!child.killed) child.kill();
        },
      });
    };
    const inspect = (chunk) => {
      output = `${output}${String(chunk || '')}`.slice(-8192);
      const publicUrl = parseLocalhostRunUrl(output);
      if (publicUrl) finish(null, publicUrl);
    };
    child.stdout?.on('data', inspect);
    child.stderr?.on('data', inspect);
    child.once('error', (error) => finish(codedError('无法启动临时媒体 SSH 隧道', error)));
    child.once('exit', (code) => finish(codedError(`临时媒体 SSH 隧道提前退出: ${code}`)));
    const timer = setTimeout(
      () => finish(codedError('等待临时媒体公网地址超时')),
      timeoutMs,
    );
    timer.unref?.();
  });
}

function createMediaServer(routes) {
  return http.createServer((req, res) => {
    const headers = {
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    };
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD', 'Content-Length': '0' });
      res.end();
      return;
    }
    let route;
    try {
      route = routes.get(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      route = null;
    }
    if (!route) {
      res.writeHead(404, { ...headers, 'Content-Length': '0' });
      res.end();
      return;
    }
    res.writeHead(200, {
      ...headers,
      'Content-Type': route.contentType,
      'Content-Length': String(route.size),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(route.path);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

async function startTemporaryMediaTunnel(options = {}) {
  const assets = normalizeAssets(options.assets);
  const routes = new Map();
  const routedAssets = assets.map((asset) => {
    const route = `/${crypto.randomBytes(24).toString('hex')}`;
    routes.set(route, asset);
    return { ...asset, route };
  });
  const server = createMediaServer(routes);
  let tunnelHandle;
  let lifetimeTimer;
  let closed = false;
  let closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      clearTimeout(lifetimeTimer);
      await Promise.allSettled([
        tunnelHandle?.close?.(),
        closeServer(server),
      ]);
    })();
    return closePromise;
  };

  try {
    const port = await listen(server);
    const spawnTunnel = options.spawnTunnel || defaultSpawnTunnel;
    tunnelHandle = await spawnTunnel({
      port,
      sshPath: options.sshPath,
      spawnImpl: options.spawnImpl,
      timeoutMs: options.tunnelUrlTimeoutMs,
    });
    const publicUrl = parseLocalhostRunUrl(tunnelHandle?.publicUrl);
    if (!publicUrl) throw codedError('临时媒体隧道未返回合法 HTTPS 地址');
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw codedError('缺少 HTTPS HEAD 校验器');
    const urls = [];
    for (const asset of routedAssets) {
      const url = `${publicUrl}${asset.route}`;
      const response = await fetchImpl(url, { method: 'HEAD', redirect: 'error' });
      const responseType = String(response?.headers?.get?.('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      const responseLength = Number(response?.headers?.get?.('content-length'));
      if (response?.status !== 200 || responseType !== asset.contentType || responseLength !== asset.size) {
        throw codedError(`临时媒体 HEAD 校验失败: ${asset.id}`);
      }
      urls.push({
        id: asset.id,
        path: asset.path,
        content_type: asset.contentType,
        size: asset.size,
        url,
        head_ok: true,
      });
    }
    const maxLifetimeMs = Number(options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS);
    if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs <= 0) {
      throw codedError('临时媒体通道生命周期无效');
    }
    lifetimeTimer = setTimeout(() => { void close(); }, maxLifetimeMs);
    lifetimeTimer.unref?.();
    return {
      urls,
      get closed() { return closed; },
      close,
    };
  } catch (error) {
    await close();
    if (error?.code === 'TEMP_MEDIA_TUNNEL_UNAVAILABLE') throw error;
    throw codedError('临时媒体隧道不可用', error);
  }
}

module.exports = {
  parseLocalhostRunUrl,
  startTemporaryMediaTunnel,
};
