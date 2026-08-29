'use strict';

const crypto = require('crypto');

const EXPIRES_PARAM = 'provider_asset_expires';
const SIGNATURE_PARAM = 'provider_asset_signature';
const DEFAULT_TTL_SECONDS = 2 * 60 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;

function validSecret(secret) {
  return String(secret || '').length >= 32;
}

function canonicalAssetPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(pathname || ''));
  } catch (_) {
    return null;
  }
  const normalized = decoded.replace(/\\/g, '/').normalize('NFC');
  if (!normalized.startsWith('/static/')) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) return null;
  return normalized;
}

function staticUrlError() {
  const error = new Error('invalid static URL');
  error.code = 'PROVIDER_STATIC_ASSET_URL_INVALID';
  return error;
}

function decodedPathLike(value) {
  let current = String(value || '');
  for (let i = 0; i < 3; i += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch (_) {
      break;
    }
  }
  return current;
}

function rejectUnsafeRawStaticUrl(raw) {
  const value = String(raw || '').trim();
  if (!value || /^data:/i.test(value) || /^file:/i.test(value)) throw staticUrlError();
  if (/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value) || value.includes('\\')) throw staticUrlError();
  const pathPart = value.split(/[?#]/)[0];
  const decoded = decodedPathLike(pathPart).replace(/\\/g, '/');
  if (decoded.includes('\0') || decoded.split('/').some((part) => part === '.' || part === '..')) {
    throw staticUrlError();
  }
}

function assertHttpsUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (_) {
    throw staticUrlError();
  }
  if (url.protocol !== 'https:') throw staticUrlError();
  return url;
}

function safeStaticAssetUrl(asset) {
  const storedUrl = String(asset?.url || '').trim();
  const localPath = String(asset?.local_path || '').trim().replace(/^\/+/, '');
  const raw = storedUrl || (localPath ? `/static/${localPath}` : '');
  rejectUnsafeRawStaticUrl(raw);

  let pathname;
  try {
    pathname = /^https?:\/\//i.test(raw)
      ? new URL(raw).pathname
      : raw;
  } catch (_) {
    throw staticUrlError();
  }
  const canonical = canonicalAssetPath(pathname);
  if (!canonical) throw staticUrlError();
  return canonical;
}

function signatureFor(secret, pathname, expires) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(`provider-asset-v1\n${expires}\n${pathname}`)
    .digest('base64url');
}

function signProviderAssetUrl(value, options = {}) {
  const raw = String(value || '').trim();
  if (!raw || /^data:/i.test(raw)) return raw;

  const filesBaseUrl = String(options.filesBaseUrl || '').trim().replace(/\/+$/, '');
  if (!filesBaseUrl) return raw;
  let base;
  let url;
  try {
    base = new URL(filesBaseUrl);
    url = /^https?:\/\//i.test(raw)
      ? new URL(raw)
      : new URL(raw.replace(/^\/?static\//i, ''), `${filesBaseUrl}/`);
  } catch (_) {
    return raw;
  }

  if (url.origin !== base.origin) return raw;
  const pathname = canonicalAssetPath(url.pathname);
  if (!pathname) return raw;

  const secret = options.secret ?? process.env.PLATFORM_JWT_SECRET;
  if (!validSecret(secret)) throw new Error('供应商素材签名密钥未配置');
  const nowSeconds = Math.floor(Number(options.now ?? Date.now()) / 1000);
  const requestedTtl = Number(options.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const ttlSeconds = Math.min(MAX_TTL_SECONDS, Math.max(60, Math.floor(requestedTtl)));
  const expires = nowSeconds + ttlSeconds;
  url.searchParams.set(EXPIRES_PARAM, String(expires));
  url.searchParams.set(SIGNATURE_PARAM, signatureFor(secret, pathname, expires));
  return url.toString();
}

function signStrictStaticAssetUrl(value, options = {}) {
  const raw = String(value || '').trim();
  rejectUnsafeRawStaticUrl(raw);
  const base = assertHttpsUrl(String(options.filesBaseUrl || '').trim().replace(/\/+$/, ''));
  let url;
  try {
    url = /^https?:\/\//i.test(raw)
      ? new URL(raw)
      : new URL(raw.replace(/^\/?static\//i, ''), `${base.toString().replace(/\/+$/, '')}/`);
  } catch (_) {
    throw staticUrlError();
  }
  if (url.protocol !== 'https:' || url.origin !== base.origin) throw staticUrlError();
  const pathname = canonicalAssetPath(url.pathname);
  if (!pathname) throw staticUrlError();
  url.pathname = pathname;

  const signed = signProviderAssetUrl(url.toString(), options);
  let signedUrl;
  try {
    signedUrl = new URL(signed);
  } catch (_) {
    throw staticUrlError();
  }
  if (
    signedUrl.protocol !== 'https:'
    || signedUrl.origin !== base.origin
    || !canonicalAssetPath(signedUrl.pathname)
    || !signedUrl.searchParams.get(EXPIRES_PARAM)
    || !signedUrl.searchParams.get(SIGNATURE_PARAM)
  ) {
    throw staticUrlError();
  }
  return signedUrl.toString();
}

function verifyProviderAssetRequest(options = {}) {
  const pathname = canonicalAssetPath(options.pathname);
  const expires = Number(options.expires);
  const supplied = String(options.signature || '');
  const secret = options.secret;
  if (!pathname || !Number.isSafeInteger(expires) || !supplied || !validSecret(secret)) return false;

  const nowSeconds = Math.floor(Number(options.now ?? Date.now()) / 1000);
  if (expires < nowSeconds || expires > nowSeconds + MAX_TTL_SECONDS) return false;
  const expected = signatureFor(secret, pathname, expires);
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

module.exports = {
  EXPIRES_PARAM,
  SIGNATURE_PARAM,
  DEFAULT_TTL_SECONDS,
  signProviderAssetUrl,
  signStrictStaticAssetUrl,
  safeStaticAssetUrl,
  verifyProviderAssetRequest,
};
