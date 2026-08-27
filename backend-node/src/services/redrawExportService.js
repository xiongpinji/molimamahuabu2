'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('../config');
const {
  buildEpisodeRelease,
  assertReleaseHash,
} = require('./redrawEpisodeReleaseService');

const DOWNLOAD_KINDS = Object.freeze({
  mp4: {
    outputKey: 'mp4_asset_id',
    rowKey: 'asset_id',
    assetType: 'video',
    assetKind: 'composition_video',
    mimeType: 'video/mp4',
  },
  srt: {
    outputKey: 'srt_asset_id',
    rowKey: 'subtitle_asset_id',
    assetType: 'subtitle',
    assetKind: 'subtitle_srt',
    mimeType: 'application/x-subrip',
  },
  vtt: {
    outputKey: 'vtt_asset_id',
    assetType: 'subtitle',
    assetKind: 'subtitle_vtt',
    mimeType: 'text/vtt',
  },
});

function exportError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveId(value, code = 'REDRAW_EXPORT_NOT_FOUND') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw exportError(code, 'export id invalid');
  return id;
}

function parseObject(value, code = 'REDRAW_EXPORT_MANIFEST_INVALID') {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {}
  throw exportError(code, 'export manifest invalid');
}

function resolveStorageRoot(ctx) {
  const configured = ctx.storageRoot || ctx.storage_root || ctx?.config?.storage?.local_path;
  if (configured) return path.resolve(configured);
  try {
    return path.resolve(loadConfig().storage.local_path);
  } catch (_) {
    throw exportError('REDRAW_EXPORT_STORAGE_NOT_CONFIGURED', 'export storage root not configured');
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function relativeAssetPath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.includes('\0')) throw exportError('REDRAW_EXPORT_PATH_INVALID', 'asset path invalid');
  const withoutStaticPrefix = raw.startsWith('/static/') ? raw.slice('/static/'.length) : raw;
  if (withoutStaticPrefix === raw && (raw.startsWith('/') || raw.startsWith('\\') || path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw))) {
    throw exportError('REDRAW_EXPORT_PATH_INVALID', 'asset path must be relative');
  }
  const normalized = withoutStaticPrefix.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw exportError('REDRAW_EXPORT_PATH_INVALID', 'asset path invalid');
  }
  return normalized;
}

function assertPlainPath(root, candidate) {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw exportError('REDRAW_EXPORT_PATH_INVALID', 'storage root unsafe');
  }
  const relative = path.relative(root, candidate);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw exportError('REDRAW_EXPORT_PATH_INVALID', 'asset path contains link');
  }
}

function resolveReadableFile(root, localPath) {
  const relative = relativeAssetPath(localPath);
  const absolute = path.resolve(root, ...relative.split('/'));
  if (!isInside(root, absolute)) throw exportError('REDRAW_EXPORT_PATH_INVALID', 'asset path escapes storage');
  try {
    assertPlainPath(root, absolute);
    const realRoot = fs.realpathSync.native(root);
    const realFile = fs.realpathSync.native(absolute);
    if (!isInside(realRoot, realFile)) throw exportError('REDRAW_EXPORT_PATH_INVALID', 'asset realpath escapes storage');
    const stat = fs.statSync(realFile);
    if (!stat.isFile()) throw exportError('REDRAW_EXPORT_FILE_UNREADABLE', 'asset is not a regular file');
    fs.accessSync(realFile, fs.constants.R_OK);
    return { relative, absolute: realFile, size: stat.size };
  } catch (error) {
    if (String(error.code || '').startsWith('REDRAW_EXPORT_')) throw error;
    throw exportError('REDRAW_EXPORT_FILE_UNREADABLE', 'asset file unreadable');
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', () => reject(exportError('REDRAW_EXPORT_FILE_UNREADABLE', 'asset file unreadable')));
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function ownedExport(ctx, exportId) {
  const id = positiveId(exportId);
  const row = ctx.db.prepare(`
    SELECT * FROM redraw_exports
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    LIMIT 1
  `).get(id, String(ctx.tenantId), String(ctx.userId));
  if (!row) throw exportError('REDRAW_EXPORT_NOT_FOUND', 'export not found');
  if (row.status !== 'completed') throw exportError('REDRAW_EXPORT_NOT_READY', 'export not completed');
  if (row.export_type !== 'video') throw exportError('REDRAW_EXPORT_TYPE_INVALID', 'export does not contain composition outputs');
  return row;
}

function artifactBinding(ctx, row, kind) {
  const contract = DOWNLOAD_KINDS[String(kind || '').toLowerCase()];
  if (!contract) throw exportError('REDRAW_EXPORT_KIND_INVALID', 'download kind invalid');
  const manifest = parseObject(row.manifest_json);
  const outputs = parseObject(manifest.outputs);
  const assetId = positiveId(outputs[contract.outputKey], 'REDRAW_EXPORT_ASSET_INVALID');
  if (contract.rowKey && Number(row[contract.rowKey]) !== assetId) {
    throw exportError('REDRAW_EXPORT_ASSET_INVALID', 'export asset binding mismatch');
  }
  const asset = ctx.db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL LIMIT 1').get(assetId);
  if (!asset || asset.type !== contract.assetType || asset.category !== 'redraw_composition' || asset.mime_type !== contract.mimeType) {
    throw exportError('REDRAW_EXPORT_ASSET_INVALID', 'export asset invalid');
  }
  const metadata = parseObject(asset.metadata, 'REDRAW_EXPORT_ASSET_INVALID');
  if (String(metadata.tenant_id) !== String(ctx.tenantId)
    || String(metadata.user_id) !== String(ctx.userId)
    || Number(metadata.version_id) !== Number(row.version_id)
    || Number(metadata.export_id) !== Number(row.id)
    || metadata.kind !== contract.assetKind) {
    throw exportError('REDRAW_EXPORT_ASSET_INVALID', 'export asset owner or version binding mismatch');
  }
  return { asset, contract, manifest };
}

async function resolveDownloadArtifact(ctx, input) {
  const row = ownedExport(ctx, input.exportId);
  const kind = String(input.kind || '').toLowerCase();
  const { asset, contract, manifest } = artifactBinding(ctx, row, kind);
  let release;
  try {
    assertReleaseHash(manifest.episode_release, row.release_hash);
    const builder = ctx.episodeReleaseBuilder || buildEpisodeRelease;
    release = await builder(ctx, { version_id: Number(row.version_id) });
    assertReleaseHash(release, row.release_hash);
  } catch (error) {
    throw exportError('REDRAW_EXPORT_RELEASE_HASH_MISMATCH', 'export release hash mismatch');
  }
  const file = resolveReadableFile(resolveStorageRoot(ctx), asset.local_path);
  const digest = await hashFile(file.absolute);
  const expected = String(manifest.outputs?.hashes?.[kind] || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected) || expected !== digest) {
    throw exportError('REDRAW_EXPORT_CHECKSUM_MISMATCH', 'export artifact checksum mismatch');
  }
  return {
    export_id: Number(row.id),
    version_id: Number(row.version_id),
    asset_id: Number(asset.id),
    kind,
    mime_type: contract.mimeType,
    filename: `redraw-export-${row.id}.${kind}`,
    absolute_path: file.absolute,
    sha256: digest,
    size: file.size,
  };
}

async function getDownloadDescriptor(ctx, input) {
  const artifact = await resolveDownloadArtifact(ctx, input);
  return {
    export_id: artifact.export_id,
    version_id: artifact.version_id,
    asset_id: artifact.asset_id,
    kind: artifact.kind,
    mime_type: artifact.mime_type,
    filename: artifact.filename,
    size: artifact.size,
    sha256: artifact.sha256,
    download_url: `/api/redraw/exports/${artifact.export_id}/download/${artifact.kind}`,
  };
}

function stripPaths(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^(?:[a-zA-Z]:[\\/]|\/|\\\\|file:\/\/|https?:\/\/)/i.test(trimmed)) return undefined;
    return value;
  }
  if (Array.isArray(value)) return value.map(stripPaths).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    const entries = [];
    for (const [key, item] of Object.entries(value)) {
      const allowed = (() => {
        const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
        return normalized !== 'url' && !normalized.endsWith('url') && !normalized.endsWith('path');
      })();
      if (!allowed) continue;
      const sanitized = stripPaths(item);
      if (sanitized !== undefined) entries.push([key, sanitized]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

function requiredRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw exportError('REDRAW_JIANYING_MANIFEST_INVALID', `${label} invalid`);
  }
  return value;
}

function buildJianyingManifest(input) {
  const version = requiredRecord(input.version, 'version');
  const exportRecord = requiredRecord(input.exportRecord, 'exportRecord');
  const composition = requiredRecord(input.composition, 'composition');
  const inputs = requiredRecord(composition.inputs, 'composition.inputs');
  const outputs = requiredRecord(composition.outputs, 'composition.outputs');
  const timeline = Array.isArray(inputs.timeline) ? inputs.timeline : [];
  const videos = Array.isArray(inputs.video_generation_ids) ? inputs.video_generation_ids : [];
  const audio = Array.isArray(inputs.audio_asset_ids) ? inputs.audio_asset_ids : [];
  if (!timeline.length || videos.length !== timeline.length) {
    throw exportError('REDRAW_JIANYING_MANIFEST_INVALID', 'timeline and video assets mismatch');
  }
  const safeTimeline = timeline.map((clip, index) => {
    const shotId = positiveId(clip.shot_id, 'REDRAW_JIANYING_MANIFEST_INVALID');
    const startMs = Number(clip.start_ms);
    const endMs = Number(clip.end_ms);
    const durationMs = Number(clip.duration_ms);
    if (!Number.isSafeInteger(startMs) || startMs < 0
      || !Number.isSafeInteger(endMs) || endMs <= startMs
      || durationMs !== endMs - startMs) {
      throw exportError('REDRAW_JIANYING_MANIFEST_INVALID', 'timeline clip invalid');
    }
    return {
      shot_id: shotId,
      start_ms: startMs,
      end_ms: endMs,
      duration_ms: durationMs,
      video_generation_id: positiveId(videos[index], 'REDRAW_JIANYING_MANIFEST_INVALID'),
    };
  });
  return {
    schema_version: 'redraw-jianying-1.0',
    source: {
      version_id: positiveId(version.id, 'REDRAW_JIANYING_MANIFEST_INVALID'),
      version_number: positiveId(version.version, 'REDRAW_JIANYING_MANIFEST_INVALID'),
      export_id: positiveId(exportRecord.id, 'REDRAW_JIANYING_MANIFEST_INVALID'),
      export_version: positiveId(exportRecord.version_number, 'REDRAW_JIANYING_MANIFEST_INVALID'),
      input_hash: String(inputs.input_hash || ''),
    },
    locale: {
      language: String(version.locale || ''),
      market: String(version.market || ''),
    },
    style_snapshot: stripPaths(input.styleSnapshot || {}),
    timeline: safeTimeline,
    tracks: [
      { type: 'video', clips: safeTimeline },
      { type: 'audio', asset_ids: audio.map((id) => positiveId(id, 'REDRAW_JIANYING_MANIFEST_INVALID')) },
      {
        type: 'subtitle',
        asset_ids: {
          srt: positiveId(outputs.srt_asset_id, 'REDRAW_JIANYING_MANIFEST_INVALID'),
          vtt: positiveId(outputs.vtt_asset_id, 'REDRAW_JIANYING_MANIFEST_INVALID'),
        },
      },
    ],
  };
}

function validateJianyingImport({ manifestSha256, expectedDesktopVersion, evidence, verifyEvidence } = {}) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { status: 'unavailable', reason: 'desktop_import_not_verified' };
  }
  const expectedVersion = String(expectedDesktopVersion || '').trim();
  const actualVersion = String(evidence.desktop_version || '').trim();
  if (!expectedVersion || !actualVersion || actualVersion.toLowerCase() === 'unknown' || actualVersion !== expectedVersion) {
    return { status: 'unavailable', reason: 'desktop_version_unknown' };
  }
  if (typeof verifyEvidence !== 'function' || verifyEvidence(evidence) !== true) {
    return { status: 'unavailable', reason: 'untrusted_verification_evidence' };
  }
  if (!/^[a-f0-9]{64}$/i.test(String(manifestSha256 || ''))
    || String(evidence.manifest_sha256 || '').toLowerCase() !== String(manifestSha256).toLowerCase()) {
    return { status: 'unavailable', reason: 'manifest_hash_mismatch' };
  }
  const checks = ['imported', 'opened', 'shot_order_ok', 'audio_ok', 'subtitles_ok', 'timecodes_ok'];
  if (!checks.every((key) => evidence[key] === true)) {
    return { status: 'unavailable', reason: 'desktop_import_not_verified' };
  }
  return { status: 'verified', desktop_version: actualVersion };
}

module.exports = {
  buildJianyingManifest,
  getDownloadDescriptor,
  resolveDownloadArtifact,
  validateJianyingImport,
};
