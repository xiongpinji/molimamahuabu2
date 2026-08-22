'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_VIDEO_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const MAX_REDIRECTS = 3;
const NON_PUBLIC_IPV4 = new net.BlockList();
const NON_PUBLIC_IPV6 = new net.BlockList();

for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) NON_PUBLIC_IPV4.addSubnet(address, prefix, 'ipv4');

for (const [address, prefix] of [
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 32], ['2001:2::', 48], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) NON_PUBLIC_IPV6.addSubnet(address, prefix, 'ipv6');

function storageRoot(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('storageRoot must be a non-empty string');
  return path.resolve(value);
}

function safeRunId(value) {
  const runId = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) throw new TypeError('runId is invalid');
  return runId;
}

function maxBytes(value, fallback) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError('maxBytes must be a positive safe integer');
  return result;
}

function runDirectory(options) {
  return path.join(storageRoot(options.storageRoot), '_system', 'provider-canary', 'runs', safeRunId(options.runId));
}

function header(response, name) {
  if (response?.headers?.get) return response.headers.get(name);
  const headers = response?.headers || {};
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

async function cancelBody(response) {
  try {
    if (typeof response?.body?.cancel === 'function') await response.body.cancel();
    else if (typeof response?.body?.destroy === 'function') response.body.destroy();
  } catch (_) { /* preserve the original failure */ }
}

function absoluteHttpUrl(value) {
  let parsed;
  try { parsed = new URL(String(value)); } catch (_) { throw new TypeError('artifact URL must be absolute http/https'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('artifact URL must be absolute http/https');
  if (parsed.username || parsed.password) throw new TypeError('artifact URL credentials are not allowed');
  return parsed;
}

function normalizedHostname(url) {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isNonPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return true;
  return family === 4
    ? NON_PUBLIC_IPV4.check(address, 'ipv4')
    : NON_PUBLIC_IPV6.check(address, 'ipv6');
}

async function publicAddresses(url, options) {
  const hostname = normalizedHostname(url);
  if (!hostname
      || hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || hostname.endsWith('.internal')
      || hostname.endsWith('.localdomain')) {
    throw new Error('artifact URL host must resolve only to public addresses');
  }
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (isNonPublicAddress(hostname)) throw new Error('artifact URL host must resolve only to public addresses');
    return [{ address: hostname, family: literalFamily }];
  }
  const lookup = options._dnsLookupForTest || dns.lookup;
  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (_) {
    throw new Error('artifact URL host could not be resolved to public addresses');
  }
  if (!Array.isArray(records)) records = records ? [records] : [];
  const normalized = records.map((record) => ({
    address: String(record?.address || ''),
    family: Number(record?.family || net.isIP(record?.address)),
  }));
  if (normalized.length === 0
      || normalized.some(({ address, family }) => ![4, 6].includes(family) || isNonPublicAddress(address))) {
    throw new Error('artifact URL host must resolve only to public addresses');
  }
  return normalized;
}

function pinnedLookup(records) {
  return (_hostname, options, callback) => {
    const requestedFamily = Number(options?.family || 0);
    const matching = records.filter(({ family }) => !requestedFamily || family === requestedFamily);
    if (matching.length === 0) {
      const error = new Error('validated DNS response does not include the requested address family');
      error.code = 'ENOTFOUND';
      callback(error);
      return;
    }
    if (options?.all) {
      callback(null, matching);
      return;
    }
    const [record] = matching;
    callback(null, record.address, record.family);
  };
}

function requestPinned(url, records, signal) {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: 'GET',
      lookup: pinnedLookup(records),
      signal,
    }, (incoming) => resolve({
      ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
      status: incoming.statusCode,
      headers: { get: (name) => incoming.headers[String(name).toLowerCase()] ?? null },
      body: incoming,
    }));
    request.once('error', reject);
    request.end();
  });
}

function decodeDataImage(value, limit) {
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(value || ''));
  if (!match) throw new TypeError('unsupported data:image artifact');
  const encoded = match[2].replace(/\s+/g, '');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new TypeError('invalid data:image artifact');
  }
  if (encoded.length > (Math.ceil(limit / 3) * 4) + 4) throw new Error('artifact exceeds size limit');
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length === 0 || buffer.length > limit) throw new Error('artifact is empty or exceeds size limit');
  return buffer;
}

function imageSource(result) {
  const value = typeof result === 'string'
    ? result
    : result?.image_url ?? result?.url ?? result?.data?.[0]?.url ?? result?.data?.[0]?.image_url;
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('image artifact source is missing');
  return value.trim();
}

async function writeResponseBody(response, handle, limit) {
  const declared = Number(header(response, 'content-length') || 0);
  if (declared && (!Number.isSafeInteger(declared) || declared < 0 || declared > limit)) {
    throw new Error('artifact exceeds size limit');
  }
  let total = 0;
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > limit) throw new Error('artifact exceeds size limit');
      await handle.write(chunk);
    }
  } else if (typeof response.arrayBuffer === 'function') {
    const chunk = Buffer.from(await response.arrayBuffer());
    total = chunk.length;
    if (total > limit) throw new Error('artifact exceeds size limit');
    await handle.write(chunk);
  } else {
    throw new Error('artifact response body is unreadable');
  }
  if (total === 0) throw new Error('artifact is empty');
}

async function downloadHttpToFile(source, tempPath, options, limit) {
  const fetchImpl = options.fetchImpl;
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  let current = absoluteHttpUrl(source);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const records = await publicAddresses(current, options);
    const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const response = fetchImpl
      ? await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal,
      })
      : await requestPinned(current, records, signal);
    const status = Number(response?.status);
    if (status >= 300 && status < 400) {
      const location = header(response, 'location');
      if (!location || redirects === MAX_REDIRECTS) throw new Error('artifact redirect is invalid or excessive');
      await cancelBody(response);
      current = absoluteHttpUrl(new URL(location, current).toString());
      continue;
    }
    if (!response?.ok && !(status >= 200 && status < 300)) {
      await cancelBody(response);
      throw new Error(`artifact download failed: HTTP ${status || 0}`);
    }
    const handle = await fs.promises.open(tempPath, 'wx', 0o600);
    try {
      try {
        await writeResponseBody(response, handle, limit);
      } catch (error) {
        await cancelBody(response);
        throw error;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
}

function imageFormat(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  throw new Error('artifact is not a supported PNG, JPEG, or WebP image');
}

function videoFormat(buffer) {
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) return 'webm';
  throw new Error('artifact is not a supported ISO BMFF or WebM video');
}

function mediaTypeForExtension(extension) {
  return {
    png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm',
  }[extension] || 'application/octet-stream';
}

function readPrefix(filePath, length = 12) {
  const handle = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(length);
  try {
    const bytesRead = fs.readSync(handle, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(handle);
  }
}

function sha256File(filePath) {
  const handle = fs.openSync(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest('hex');
  } finally {
    fs.closeSync(handle);
  }
}

function artifactSummary(filePath, options = {}) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error('artifact path must be a non-empty regular file');
  const bytes = stat.size;
  const relative = options.storageRoot
    ? path.relative(storageRoot(options.storageRoot), path.resolve(filePath))
    : path.basename(filePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('artifact path escapes storage root');
  }
  const relativePath = relative.split(path.sep).join('/');
  if (!/^_system\/provider-canary\/runs\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[^/]+$/.test(relativePath)) {
    throw new Error('artifact path must stay in provider-canary runs');
  }
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return {
    relative_path: relativePath,
    sha256: sha256File(filePath),
    bytes,
    media_type: mediaTypeForExtension(extension),
  };
}

async function materialize(source, options, kind) {
  const limit = maxBytes(options.maxBytes, kind === 'image' ? DEFAULT_IMAGE_MAX_BYTES : DEFAULT_VIDEO_MAX_BYTES);
  const directory = runDirectory(options);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(directory, `.${kind}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    if (kind === 'image' && /^data:/i.test(source)) {
      const bytes = decodeDataImage(source, limit);
      fs.writeFileSync(tempPath, bytes, { flag: 'wx', mode: 0o600 });
    } else {
      await downloadHttpToFile(source, tempPath, options, limit);
    }
    const prefix = readPrefix(tempPath);
    const extension = kind === 'image' ? imageFormat(prefix) : videoFormat(prefix);
    const finalPath = path.join(directory, `${kind}.${extension}`);
    fs.chmodSync(tempPath, 0o600);
    try {
      fs.linkSync(tempPath, finalPath);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const conflict = new Error('artifact already exists for run');
        conflict.code = 'PROVIDER_CANARY_ARTIFACT_EXISTS';
        throw conflict;
      }
      throw error;
    }
    fs.unlinkSync(tempPath);
    return artifactSummary(finalPath, { storageRoot: options.storageRoot });
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

async function materializeImage(result, options = {}) {
  return materialize(imageSource(result), options, 'image');
}

async function materializeVideo(url, options = {}) {
  if (typeof url !== 'string' || !url.trim()) throw new TypeError('video artifact source is missing');
  return materialize(url.trim(), options, 'video');
}

function verifyText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('text artifact must be non-empty');
  const normalized = text.trim();
  const bytes = Buffer.from(normalized, 'utf8');
  return {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    media_type: 'text/plain',
  };
}

module.exports = {
  materializeImage,
  materializeVideo,
  verifyText,
  artifactSummary,
};
