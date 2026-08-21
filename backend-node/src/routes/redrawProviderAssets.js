'use strict';

const net = require('net');
const path = require('path');
const express = require('express');

const config = require('../config');
const {
  PROVIDER_ASSET_ROUTE,
  verifyProviderAssetUrl,
  resolveProviderAssetPath,
} = require('../services/redrawSourceConditioningService');

function resolveStorageRoot(cfg, explicit) {
  if (explicit) return path.resolve(String(explicit));
  const raw = cfg.storage?.local_path || './data/storage';
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(process.cwd(), raw);
}

function errorStatus(error) {
  if (error?.code === 'REDRAW_PROVIDER_ASSET_SECRET_REQUIRED'
    || error?.code === 'REDRAW_PROVIDER_ASSET_ORIGIN_UNSAFE') return 503;
  if (error?.code === 'REDRAW_PROVIDER_ASSET_NOT_FOUND'
    || error?.code === 'REDRAW_PROVIDER_ASSET_PATH_INVALID'
    || error?.code === 'REDRAW_PROVIDER_ASSET_HASH_MISMATCH') return 404;
  return 403;
}

function isLoopbackAddress(value) {
  const raw = String(value || '').trim().toLowerCase();
  const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  if (address === '::1') return true;
  return net.isIP(address) === 4 && address.startsWith('127.');
}

function singleHeader(value) {
  const values = (Array.isArray(value) ? value : [value])
    .flatMap((entry) => String(entry || '').split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length === 1 ? values[0] : null;
}

function requestHost(value) {
  const raw = singleHeader(value);
  if (!raw || /[\s/\\@?#]/.test(raw)) return null;
  try {
    return new URL(`https://${raw}`).host.toLowerCase();
  } catch (_) {
    return null;
  }
}

function assertProviderRequestOrigin(req, expectedOrigin) {
  const expected = new URL(expectedOrigin);
  let protocol = req.socket?.encrypted ? 'https' : null;
  let host = requestHost(req.headers.host);
  if (!protocol && isLoopbackAddress(req.socket?.remoteAddress)) {
    protocol = singleHeader(req.headers['x-forwarded-proto'])?.toLowerCase() || null;
    if (req.headers['x-forwarded-host'] !== undefined) {
      host = requestHost(req.headers['x-forwarded-host']);
    }
  }
  if (protocol !== 'https' || host !== expected.host.toLowerCase()) {
    const error = new Error('provider asset 请求 origin 不匹配');
    error.code = 'REDRAW_PROVIDER_ASSET_REQUEST_ORIGIN_MISMATCH';
    throw error;
  }
}

function createProviderAssetHandler(options = {}) {
  return async function providerAssetHandler(req, res) {
    try {
      const cfg = options.cfg || config.loadConfig();
      const storageBaseUrl = options.storageBaseUrl || cfg.storage?.base_url;
      const origin = new URL(String(storageBaseUrl || '')).origin;
      assertProviderRequestOrigin(req, origin);
      const originalUrl = String(req.originalUrl || '');
      if (!originalUrl.startsWith('/')) {
        const error = new Error('provider asset request URL 无效');
        error.code = 'REDRAW_PROVIDER_ASSET_PATH_INVALID';
        throw error;
      }
      const verified = verifyProviderAssetUrl(new URL(originalUrl, origin).toString(), {
        storageBaseUrl,
        signingSecret: options.signingSecret ?? process.env.REDRAW_PROVIDER_ASSET_HMAC_SECRET,
        routePrefix: options.routePrefix || PROVIDER_ASSET_ROUTE,
        nowMs: typeof options.nowMs === 'function' ? options.nowMs() : options.nowMs,
      });
      const filename = String(req.params?.filename || '').toLowerCase();
      if (filename !== `${verified.segmentSha256}.mp4`) {
        const error = new Error('provider asset request 路径不匹配');
        error.code = 'REDRAW_PROVIDER_ASSET_PATH_INVALID';
        throw error;
      }
      const absolutePath = await resolveProviderAssetPath({
        storageRoot: resolveStorageRoot(cfg, options.storageRoot),
        filename,
      });
      res.set({
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Type': 'video/mp4',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.sendFile(absolutePath);
    } catch (error) {
      return res.status(errorStatus(error)).json({
        code: error?.code || 'REDRAW_PROVIDER_ASSET_UNAVAILABLE',
        error: 'provider asset 不可用',
      });
    }
  };
}

function createRedrawProviderAssetsRouter(options = {}) {
  const router = express.Router();
  router.get('/:filename', createProviderAssetHandler(options));
  return router;
}

module.exports = {
  createProviderAssetHandler,
  createRedrawProviderAssetsRouter,
};
