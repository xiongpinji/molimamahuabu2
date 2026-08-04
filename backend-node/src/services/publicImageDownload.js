const dnsCore = require('dns');
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');

function isPrivateAddress(address) {
  address = String(address || '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || parts[0] === 0
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168);
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) return true;
    const mappedIpv4 = normalized.replace(/^::ffff:/, '');
    if (net.isIPv4(mappedIpv4)) return isPrivateAddress(mappedIpv4);
    return normalized === '::1'
      || normalized === '::'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb');
  }
  return true;
}

async function assertPublicImageUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 HTTP(S) 图片');
  if (url.username || url.password) throw new Error('图片地址不得包含认证信息');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error('拒绝本机图片地址');
  const addresses = net.isIP(hostname)
    ? [hostname]
    : (await dns.lookup(hostname, { all: true })).map((item) => item.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error('拒绝私网图片地址');
  return url;
}

async function downloadPublicImage(value, maxBytes = 20 * 1024 * 1024) {
  let current = String(value || '').trim();
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const url = await assertPublicImageUrl(current);
    const response = await requestPublicImage(url, maxBytes);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location || redirect === 3) throw new Error('图片重定向无效或过多');
      current = new URL(location, current).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    return { bytes: response.bytes, mimeType: response.mimeType };
  }
  throw new Error('图片下载失败');
}

function requestPublicImage(url, maxBytes) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, {
      timeout: 30_000,
      lookup(hostname, options, callback) {
        dnsCore.lookup(hostname, { ...options, all: true }, (error, addresses) => {
          if (error) return callback(error);
          if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) {
            return callback(new Error('拒绝私网图片地址'));
          }
          if (options?.all) return callback(null, addresses);
          const selected = addresses[0];
          callback(null, selected.address, selected.family);
        });
      },
    }, (response) => {
      const status = response.statusCode || 0;
      const headers = response.headers;
      if (status >= 300 && status < 400) {
        response.resume();
        return resolve({ status, headers });
      }
      if (status < 200 || status >= 300) {
        response.resume();
        return resolve({ status, headers });
      }
      const mimeType = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!mimeType.startsWith('image/')) {
        response.destroy();
        return reject(new Error('响应不是图片'));
      }
      const declaredLength = Number(headers['content-length'] || 0);
      if (declaredLength > maxBytes) {
        response.destroy();
        return reject(new Error('图片超过 20MB 限制'));
      }
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy(new Error('图片超过 20MB 限制'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => resolve({
        status,
        headers,
        bytes: Buffer.concat(chunks),
        mimeType,
      }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('图片下载超时')));
    request.on('error', reject);
  });
}

module.exports = {
  assertPublicImageUrl,
  downloadPublicImage,
  requestPublicImage,
};
