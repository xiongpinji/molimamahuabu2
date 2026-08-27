'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const sharp = require('sharp');

const assetService = require('./assetService');
const { validateReviewedCoverageManifest } = require('./redrawFullFrameReviewService');

const HEX_64 = /^[a-f0-9]{64}$/;
const MANIFEST_NAME = 'redraw-full-frame-reviewed-manifest.json';

function codedError(code, message) {
  return Object.assign(new Error(String(code)), { code, detail: message || null });
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function stableJson(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw codedError('REDRAW_COVERAGE_REQUEST_INVALID');
  }
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function hashString(value) {
  return sha256(Buffer.from(String(value), 'utf8'));
}

function requestHash(input) {
  return sha256(Buffer.from(stableJson({
    expected_version_updated_at: String(input.expectedVersionUpdatedAt || ''),
  }), 'utf8'));
}

function normalizeOwner(input) {
  const tenantId = String(input.tenantId ?? input.tenant_id ?? '').trim();
  const userId = String(input.userId ?? input.user_id ?? '').trim();
  if (!tenantId || !userId) throw codedError('REDRAW_COVERAGE_OWNER_REQUIRED', 'missing owner');
  return { tenantId, userId };
}

function assertRelativePath(value, code = 'REDRAW_COVERAGE_PROVIDER_OUTPUT_INVALID') {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.includes('\0')) throw codedError(code);
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw codedError(code);
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized === '.' || normalized === '..' || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw codedError(code);
  }
  return normalized;
}

function insideOrSame(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertNoLinkedComponents(rootReal, relativePath, code) {
  let current = rootReal;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (_) {
      throw codedError(code);
    }
    if (stat.isSymbolicLink()) throw codedError(code);
  }
}

async function secureReadFile(root, relativePath, code = 'REDRAW_COVERAGE_EVIDENCE_INVALID') {
  const normalized = assertRelativePath(relativePath, code);
  let rootReal;
  try {
    rootReal = await fsp.realpath(root);
  } catch (_) {
    throw codedError(code);
  }
  const target = path.resolve(rootReal, normalized);
  if (!insideOrSame(rootReal, target)) throw codedError(code);
  await assertNoLinkedComponents(rootReal, normalized, code);
  let real;
  try {
    real = await fsp.realpath(target);
  } catch (_) {
    throw codedError(code);
  }
  if (!insideOrSame(rootReal, real)) throw codedError(code);
  let handle;
  try {
    const expected = await fsp.stat(real, { bigint: true });
    if (!expected.isFile()) throw codedError(code);
    handle = await fsp.open(real, 'r');
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()
      || before.dev !== expected.dev
      || before.ino !== expected.ino
      || before.size !== expected.size
      || before.mtimeNs !== expected.mtimeNs
      || before.ctimeNs !== expected.ctimeNs) {
      throw codedError(code);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs) {
      throw codedError(code);
    }
    return { bytes, absolutePath: real, relativePath: normalized };
  } catch (error) {
    if (error.code && String(error.code).startsWith('REDRAW_COVERAGE_')) throw error;
    throw codedError(code);
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

async function readJsonSecure(root, relativePath) {
  const file = await secureReadFile(root, relativePath, 'REDRAW_COVERAGE_EVIDENCE_INVALID');
  try {
    return { ...file, json: JSON.parse(file.bytes.toString('utf8')) };
  } catch (_) {
    throw codedError('REDRAW_COVERAGE_EVIDENCE_INVALID');
  }
}

function providerManifestPath(result) {
  const value = result?.reviewed_manifest_relative_path ?? result?.reviewedManifestRelativePath;
  return assertRelativePath(value);
}

function assertProviderResultContract(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw codedError('REDRAW_COVERAGE_PROVIDER_OUTPUT_INVALID');
  }
  const allowed = new Set(['status', 'provider_task_id', 'providerTaskId', 'reviewed_manifest_relative_path', 'reviewedManifestRelativePath']);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) throw codedError('REDRAW_COVERAGE_PROVIDER_OUTPUT_INVALID');
  }
  const providerTaskId = result.provider_task_id ?? result.providerTaskId;
  if (providerTaskId != null && typeof providerTaskId !== 'string') {
    throw codedError('REDRAW_COVERAGE_PROVIDER_OUTPUT_INVALID');
  }
}

function readVersion(db, { tenantId, userId, versionId }) {
  const row = db.prepare(`
    SELECT v.*, w.source_fingerprint, w.duration_ms, w.source_asset_id
    FROM redraw_versions v
    JOIN redraw_works w ON w.id = v.work_id AND w.deleted_at IS NULL
    WHERE v.id = ? AND v.tenant_id = ? AND v.user_id = ? AND v.deleted_at IS NULL
  `).get(Number(versionId), tenantId, userId);
  if (!row) throw codedError('REDRAW_VERSION_NOT_FOUND', 'version not found');
  return row;
}

function shotTimeline(db, versionId, tenantId, userId) {
  return db.prepare(`
    SELECT id, shot_id, start_ms, end_ms, duration_ms
    FROM redraw_shots
    WHERE version_id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
    ORDER BY batch_index ASC, shot_index ASC, id ASC
  `).all(Number(versionId), tenantId, userId);
}

function assertManifestMatchesVersion(manifest, version, shots) {
  if (manifest.source?.sha256 !== version.source_fingerprint
    || Number(manifest.source?.duration_ms) !== Number(version.duration_ms)) {
    throw codedError('REDRAW_COVERAGE_VERSION_MISMATCH');
  }
  const expected = shots.map((shot) => ({
    shot_id: String(shot.shot_id || ''),
    start_ms: Number(shot.start_ms),
    end_ms: Number(shot.end_ms),
  }));
  const actual = Array.isArray(manifest.shots)
    ? manifest.shots.map((shot) => ({
        shot_id: String(shot.shot_id || ''),
        start_ms: Number(shot.start_ms),
        end_ms: Number(shot.end_ms),
      }))
    : [];
  if (stableJson(actual) !== stableJson(expected)) {
    throw codedError('REDRAW_COVERAGE_VERSION_MISMATCH');
  }
  if (!HEX_64.test(String(version.facts_hash || ''))) throw codedError('REDRAW_COVERAGE_VERSION_MISMATCH');
}

function collectEvidenceFiles(manifest, manifestRelativePath) {
  const files = new Map();
  files.set(MANIFEST_NAME, { kind: 'manifest', path: manifestRelativePath, expectedSha: null });
  for (const frame of manifest.frames || []) {
    files.set(assertRelativePath(frame.path, 'REDRAW_COVERAGE_EVIDENCE_INVALID'), {
      kind: 'image',
      path: frame.path,
      expectedSha: frame.sha256,
    });
  }
  for (const track of [...(manifest.person_tracks || []), ...(manifest.text_tracks || [])]) {
    for (const region of track.regions || []) {
      if (!region.mask) continue;
      const rel = assertRelativePath(region.mask.path, 'REDRAW_COVERAGE_EVIDENCE_INVALID');
      files.set(rel, { kind: 'image', path: rel, expectedSha: region.mask.sha256 });
    }
  }
  return [...files.values()];
}

async function copyEvidenceFile({ storageRoot, stagingRoot, destBaseRelative, file }) {
  const read = await secureReadFile(stagingRoot, file.path, 'REDRAW_COVERAGE_EVIDENCE_INVALID');
  const digest = sha256(read.bytes);
  if (file.expectedSha && digest !== file.expectedSha) throw codedError('REDRAW_COVERAGE_EVIDENCE_INVALID');
  const destRelative = path.posix.join(destBaseRelative, file.kind === 'manifest' ? MANIFEST_NAME : read.relativePath);
  const destAbs = path.join(storageRoot, destRelative);
  await fsp.mkdir(path.dirname(destAbs), { recursive: true });
  await fsp.writeFile(destAbs, read.bytes, { flag: 'w' });
  return { destRelative, bytes: read.bytes, digest };
}

async function imageMetadata(bytes) {
  let metadata;
  try {
    metadata = await sharp(bytes).metadata();
  } catch (_) {
    throw codedError('REDRAW_COVERAGE_EVIDENCE_INVALID');
  }
  if (!metadata.width || !metadata.height || metadata.format !== 'png') {
    throw codedError('REDRAW_COVERAGE_EVIDENCE_INVALID');
  }
  return { width: metadata.width, height: metadata.height, mimeType: 'image/png' };
}

function createAsset(db, payload) {
  return assetService.create(db, null, payload);
}

function createRedrawAsset(db, { version, tenantId, userId, manifestAssetId, providerTaskId, manifest }) {
  const now = new Date().toISOString();
  const previous = db.prepare(`
    SELECT COALESCE(MAX(version_number), 0) AS max_version
    FROM redraw_assets
    WHERE version_id = ? AND kind = 'scene' AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL
  `).get(Number(version.id), tenantId, userId);
  const payload = {
    source_ref: { stable_id: 'full-frame-reviewed-coverage' },
    snapshot: {
      mode: 'full_frame_reviewed_coverage',
      version_id: Number(version.id),
      facts_hash: version.facts_hash,
      source_fingerprint: version.source_fingerprint,
      analysis_sha256: manifest.analysis_sha256,
    },
  };
  const result = db.prepare(`
    INSERT INTO redraw_assets
      (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
       localized_description, prompt, asset_id, generation_task_id, credit_reservation_id,
       version_number, approval_status, status, created_at, updated_at)
    VALUES (?, ?, ?, 'scene', ?, 'reviewed full frame coverage', '', '', ?, ?, NULL,
      ?, 'pending', 'generated', ?, ?)
  `).run(
    Number(version.id),
    tenantId,
    userId,
    JSON.stringify(payload),
    Number(manifestAssetId),
    providerTaskId || null,
    Number(previous.max_version || 0) + 1,
    now,
    now,
  );
  return Number(result.lastInsertRowid);
}

async function storeEvidence({ db, storageRoot, stagingRoot, version, tenantId, userId, providerTaskId, manifest, manifestRelativePath }) {
  const destBaseRelative = path.posix.join('redraw-full-frame-coverages', String(version.id), manifest.analysis_sha256);
  const evidenceFiles = collectEvidenceFiles(manifest, manifestRelativePath);
  const stored = [];
  for (const file of evidenceFiles) {
    stored.push({ ...file, ...(await copyEvidenceFile({ storageRoot, stagingRoot, destBaseRelative, file })) });
  }
  const imageFiles = [];
  for (const file of stored.filter((item) => item.kind === 'image')) {
    imageFiles.push({ file, image: await imageMetadata(file.bytes) });
  }

  return db.transaction(() => {
    let manifestAssetId = null;
    for (const file of stored.filter((item) => item.kind === 'manifest')) {
      const asset = createAsset(db, {
        name: 'reviewed full frame coverage manifest',
        type: 'document',
        category: 'redraw',
        local_path: file.destRelative,
        file_size: file.bytes.length,
        mime_type: 'application/json',
        metadata: { sha256: file.digest },
      });
      manifestAssetId = Number(asset.id);
    }
    for (const { file, image } of imageFiles) {
      const asset = createAsset(db, {
        name: path.posix.basename(file.destRelative),
        type: 'image',
        category: 'redraw',
        local_path: file.destRelative,
        file_size: file.bytes.length,
        mime_type: image.mimeType,
        width: image.width,
        height: image.height,
        metadata: { sha256: file.digest },
      });
      if (!asset?.id) throw codedError('REDRAW_COVERAGE_ASSET_CREATE_FAILED');
    }
    if (!manifestAssetId) throw codedError('REDRAW_COVERAGE_ASSET_CREATE_FAILED');
    return createRedrawAsset(db, { version, tenantId, userId, manifestAssetId, providerTaskId, manifest });
  })();
}

function registrationByKey(db, { tenantId, userId, versionId, idempotencyHash }) {
  return db.prepare(`
    SELECT * FROM redraw_coverage_registrations
    WHERE tenant_id = ? AND user_id = ? AND version_id = ? AND idempotency_hash = ? AND deleted_at IS NULL
  `).get(tenantId, userId, Number(versionId), idempotencyHash);
}

function claimRegistration(db, input) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = registrationByKey(db, input);
    if (existing) {
      db.exec('COMMIT');
      return { existing };
    }
    const now = input.now();
    const info = db.prepare(`
      INSERT INTO redraw_coverage_registrations
        (tenant_id, user_id, version_id, idempotency_hash, request_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)
    `).run(
      input.tenantId,
      input.userId,
      Number(input.versionId),
      input.idempotencyHash,
      input.requestHash,
      now,
      now,
    );
    db.exec('COMMIT');
    return { id: Number(info.lastInsertRowid) };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {}
    throw error;
  }
}

function replayOrThrow(existing, requestHashValue) {
  if (existing.request_hash !== requestHashValue) {
    throw codedError('REDRAW_COVERAGE_REGISTRATION_IDEMPOTENCY_CONFLICT');
  }
  if (existing.status === 'completed') {
    return {
      redraw_asset_id: Number(existing.redraw_asset_id),
      expected_updated_at: existing.completed_at || existing.updated_at,
      billing: { credits: 0, held: 0, charged: 0 },
      provider_task_id: existing.provider_task_id || null,
      analysis_sha256: existing.analysis_sha256 || null,
      replayed: true,
    };
  }
  if (existing.status === 'processing') throw codedError('REDRAW_COVERAGE_REGISTRATION_IN_PROGRESS');
  if (existing.status === 'needs_attention') throw codedError('REDRAW_COVERAGE_REGISTRATION_NEEDS_ATTENTION');
  throw codedError('REDRAW_COVERAGE_REGISTRATION_FAILED');
}

function updateRegistration(db, id, fields, now) {
  const allowed = {
    status: 'status',
    providerTaskId: 'provider_task_id',
    analysisSha256: 'analysis_sha256',
    redrawAssetId: 'redraw_asset_id',
    errorCode: 'error_code',
    errorMessage: 'error_message',
    completedAt: 'completed_at',
  };
  const sets = [];
  const params = [];
  for (const [input, column] of Object.entries(allowed)) {
    if (fields[input] !== undefined) {
      sets.push(`${column} = ?`);
      params.push(fields[input]);
    }
  }
  sets.push('updated_at = ?');
  params.push(now);
  params.push(Number(id));
  db.prepare(`UPDATE redraw_coverage_registrations SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

function errorCode(error, fallback = 'REDRAW_COVERAGE_REGISTRATION_FAILED') {
  return error?.code && String(error.code).startsWith('REDRAW_') ? error.code : fallback;
}

async function registerReviewedCoverage(rawInput = {}) {
  if (!rawInput.db) throw codedError('REDRAW_COVERAGE_DB_REQUIRED');
  if (!rawInput.provider || typeof rawInput.provider !== 'function') throw codedError('REDRAW_COVERAGE_PROVIDER_REQUIRED');
  const { tenantId, userId } = normalizeOwner(rawInput);
  const db = rawInput.db;
  const versionId = Number(rawInput.versionId ?? rawInput.version_id);
  if (!Number.isSafeInteger(versionId) || versionId <= 0) throw codedError('REDRAW_COVERAGE_VERSION_REQUIRED');
  const rawStorageRoot = rawInput.storageRoot ?? rawInput.storage_root;
  if (!rawStorageRoot) throw codedError('REDRAW_COVERAGE_STORAGE_REQUIRED');
  const storageRoot = path.resolve(String(rawStorageRoot));
  const idempotencyKey = String(rawInput.idempotencyKey ?? rawInput.idempotency_key ?? '').trim();
  if (!idempotencyKey) throw codedError('REDRAW_COVERAGE_IDEMPOTENCY_REQUIRED');
  const now = typeof rawInput.now === 'function' ? rawInput.now : () => new Date().toISOString();
  const version = readVersion(db, { tenantId, userId, versionId });
  const reqHash = requestHash(rawInput);
  const idempotencyHash = hashString(idempotencyKey);
  const claim = claimRegistration(db, {
    tenantId,
    userId,
    versionId,
    idempotencyHash,
    requestHash: reqHash,
    now,
  });
  if (claim.existing) return replayOrThrow(claim.existing, reqHash);
  const expectedVersionUpdatedAt = rawInput.expectedVersionUpdatedAt ?? rawInput.expected_version_updated_at ?? '';
  if (String(version.updated_at) !== String(expectedVersionUpdatedAt)) {
    updateRegistration(db, claim.id, {
      status: 'failed',
      errorCode: 'REDRAW_COVERAGE_VERSION_CONFLICT',
    }, now());
    throw codedError('REDRAW_COVERAGE_VERSION_CONFLICT');
  }

  let stagingRoot;
  let providerTaskId = null;
  try {
    const parent = path.join(os.tmpdir(), 'moli-redraw-coverage-registration');
    await fsp.mkdir(parent, { recursive: true });
    stagingRoot = await fsp.mkdtemp(path.join(parent, 'redraw-coverage-staging-'));
    const shots = shotTimeline(db, versionId, tenantId, userId);
    const providerResult = await rawInput.provider({
      outputDir: stagingRoot,
      input: Object.freeze({
        version_id: Number(version.id),
        owner: Object.freeze({ tenant_id: tenantId, user_id: userId }),
        expected_version_updated_at: String(rawInput.expectedVersionUpdatedAt ?? rawInput.expected_version_updated_at),
        facts_hash: version.facts_hash,
        source_fingerprint: version.source_fingerprint,
        duration_ms: Number(version.duration_ms),
        shots: Object.freeze(shots.map((shot) => Object.freeze({
          shot_id: String(shot.shot_id),
          start_ms: Number(shot.start_ms),
          end_ms: Number(shot.end_ms),
        }))),
      }),
    });
    assertProviderResultContract(providerResult);
    providerTaskId = providerResult?.provider_task_id || providerResult?.providerTaskId || null;
    if (providerResult?.status && providerResult.status !== 'completed') {
      updateRegistration(db, claim.id, {
        status: 'needs_attention',
        providerTaskId,
        errorCode: 'REDRAW_COVERAGE_PROVIDER_UNKNOWN',
      }, now());
      throw codedError('REDRAW_COVERAGE_PROVIDER_UNKNOWN');
    }
    const manifestRelativePath = providerManifestPath(providerResult);
    const manifestRead = await readJsonSecure(stagingRoot, manifestRelativePath);
    let manifest;
    try {
      manifest = await validateReviewedCoverageManifest({ evidenceRoot: stagingRoot, manifest: manifestRead.json });
    } catch (_) {
      throw codedError('REDRAW_COVERAGE_EVIDENCE_INVALID');
    }
    assertManifestMatchesVersion(manifest, version, shots);
    const redrawAssetId = await storeEvidence({
      db,
      storageRoot,
      stagingRoot,
      version,
      tenantId,
      userId,
      providerTaskId,
      manifest,
      manifestRelativePath,
    });
    const completedAt = now();
    updateRegistration(db, claim.id, {
      status: 'completed',
      providerTaskId,
      analysisSha256: manifest.analysis_sha256,
      redrawAssetId,
      errorCode: null,
      errorMessage: null,
      completedAt,
    }, completedAt);
    return {
      redraw_asset_id: redrawAssetId,
      expected_updated_at: completedAt,
      billing: { credits: 0, held: 0, charged: 0 },
      provider_task_id: providerTaskId,
      analysis_sha256: manifest.analysis_sha256,
    };
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'REDRAW_COVERAGE_PROVIDER_UNKNOWN') {
      updateRegistration(db, claim.id, {
        status: 'failed',
        providerTaskId,
        errorCode: code,
        errorMessage: String(error?.message || code).slice(0, 500),
      }, now());
    }
    throw codedError(code, error?.message);
  } finally {
    if (stagingRoot) await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  registerReviewedCoverage,
};
