const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');
const sharp = require('sharp');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const {
  buildGeneratedCoverageManifest,
  canonicalCoverageSha256,
} = require('../src/services/redrawFullFrameCoverageService');
const {
  canonicalizeModelLock,
  canonicalSha256: canonicalModelLockSha256,
} = require('../src/services/redrawFullFrameModelLockService');
const { reviewAsset } = require('../src/services/redrawReviewService');
const { loadReviewedReferenceCoverage } = require('../src/services/redrawReferenceBundleService');
const {
  registerReviewedCoverage,
} = require('../src/services/redrawCoverageRegistrationService');

const WIDTH = 64;
const HEIGHT = 96;
const OWNER = { tenantId: 'tenant-a', userId: 'user-a' };
const NOW = '2026-08-27T08:00:00.000Z';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function stableJson(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

async function writePng(filePath, { channels = 3, value = 64, rect } = {}) {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * channels, value);
  if (rect) {
    pixels.fill(0);
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) pixels[(y * WIDTH) + x] = 255;
    }
  }
  const image = sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels } });
  const bytes = await (channels === 1 ? image.toColourspace('b-w') : image).png().toBuffer();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
  return sha256(bytes);
}

function modelLock() {
  const components = ['tracker', 'text_detector', 'person_detector', 'face_detector'].map((component) => ({
    component,
    project: {
      face_detector: 'MediaPipe face detection',
      person_detector: 'YOLOX',
      text_detector: 'PaddleOCR',
      tracker: 'ByteTrack',
    }[component],
    repository: {
      face_detector: 'google-ai-edge/mediapipe',
      person_detector: 'Megvii-BaseDetection/YOLOX',
      text_detector: 'PaddlePaddle/PaddleOCR',
      tracker: 'FoundationVision/ByteTrack',
    }[component],
    revision: `rev-${component}-20260816`,
    artifact_name: `${component}.bin`,
    artifact_path: `${component}/model.bin`,
    artifact_sha256: 'a'.repeat(64),
    license_name: `${component}-LICENSE`,
    license_evidence_path: `${component}/LICENSE.txt`,
    license_evidence_sha256: 'b'.repeat(64),
  }));
  const lock = {
    schema_version: 'redraw-full-frame-model-lock-v2',
    runtimes: {
      main: {
        python_version: 'Python 3.11.9',
        interpreter_path: 'runtime/main/.venv/Scripts/python.exe',
        pip_freeze_path: 'runtime/main/pip-freeze.txt',
        pip_freeze_sha256: '1'.repeat(64),
      },
      text: {
        python_version: 'Python 3.11.9',
        interpreter_path: 'runtime/text/.venv/Scripts/python.exe',
        pip_freeze_path: 'runtime/text/pip-freeze.txt',
        pip_freeze_sha256: '2'.repeat(64),
      },
    },
    components,
  };
  return { ...lock, canonical_sha256: canonicalModelLockSha256(canonicalizeModelLock(lock)) };
}

async function writeReviewedCoverage(root, overrides = {}) {
  const frameShas = [];
  for (let i = 0; i < 12; i += 1) {
    frameShas[i] = await writePng(path.join(root, 'frames', `frame-${i}.png`), { value: 20 + i });
  }
  const maskPaths = ['masks/person-a-0.png', 'masks/text-sub-0.png'];
  const maskShas = {};
  for (const rel of maskPaths) {
    maskShas[rel] = await writePng(path.join(root, rel), { channels: 1, rect: { x: 8, y: 8, width: 14, height: 14 } });
  }
  const mask = (rel) => ({ path: rel, sha256: maskShas[rel], width: WIDTH, height: HEIGHT, mime_type: 'image/png' });
  const source = {
    sha256: overrides.sourceFingerprint || 'd'.repeat(64),
    duration_ms: overrides.durationMs ?? 12000,
    width: WIDTH,
    height: HEIGHT,
    frame_count: 12,
    time_base: { numerator: 1, denominator: 1 },
  };
  const manifest = await buildGeneratedCoverageManifest({
    evidenceRoot: root,
    source,
    shots: Array.from({ length: 12 }, (_, i) => ({ shot_id: `shot-${i + 1}`, start_ms: i * 1000, end_ms: (i + 1) * 1000 })),
    frames: Array.from({ length: 12 }, (_, i) => ({
      frame_index: i,
      timestamp_ticks: i,
      timestamp_ms: i * 1000,
      shot_id: `shot-${i + 1}`,
      path: `frames/frame-${i}.png`,
      sha256: frameShas[i],
      width: WIDTH,
      height: HEIGHT,
      person_region_ids: i === 0 ? ['p-a-0'] : [],
      text_region_ids: i === 0 ? ['t-sub-0'] : [],
      review_point_reasons: [],
      review_status: 'not_required',
    })),
    personTracks: [{
      track_key: 'person-a',
      kind: 'story_role',
      source_character_key: 'role-a',
      target_strategy: 'fixed_actor',
      frame_ranges: [{ start_frame: 0, end_frame: 0 }],
      visibility: [{ start_frame: 0, end_frame: 0, state: 'visible' }],
      regions: [{
        region_id: 'p-a-0',
        frame_index: 0,
        bbox: { x: 8, y: 8, width: 14, height: 14 },
        mask: mask('masks/person-a-0.png'),
        association_confidence: 0.9,
        detector_disagreement: false,
      }],
      review_status: 'pending',
      reviewer: null,
    }],
    textTracks: [{
      region_key: 'subtitle-a',
      kind: 'subtitle',
      treatment: 'translate_subtitle',
      target_text_key: 'subtitle-a',
      frame_ranges: [{ start_frame: 0, end_frame: 0 }],
      regions: [{
        region_id: 't-sub-0',
        frame_index: 0,
        polygon: [{ x: 8, y: 70 }, { x: 40, y: 70 }, { x: 40, y: 80 }],
        mask: mask('masks/text-sub-0.png'),
      }],
      review_status: 'pending',
      reviewer: null,
    }],
    modelLock: modelLock(),
  });
  manifest.status = 'reviewed';
  for (const frame of manifest.frames) frame.review_status = frame.review_point_reasons.length ? 'reviewed' : 'not_required';
  for (const track of [...manifest.person_tracks, ...manifest.text_tracks]) {
    track.review_status = 'reviewed';
    track.reviewer = 'codex-local-review';
  }
  manifest.review = {
    status: 'reviewed',
    reviewed: true,
    required_review_point_count: manifest.review.required_review_point_count,
    reviewed_point_count: manifest.review.required_review_point_count,
    reviewer: 'codex-local-review',
  };
  manifest.approval_status = 'pending';
  manifest.ready_for_reference = false;
  manifest.analysis_sha256 = canonicalCoverageSha256(manifest);
  if (overrides.mutateManifest) overrides.mutateManifest(manifest);
  fs.writeFileSync(path.join(root, 'redraw-full-frame-reviewed-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'unreferenced-secret.png'), Buffer.from('do-not-copy'));
  return manifest;
}

async function setup(t) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-coverage-registration-storage-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const facts = { characters: [{ id: 'role-a', name: 'A' }] };
  const factsHash = sha256(stableJson(facts));
  const sourceFingerprint = 'd'.repeat(64);
  const sourceBytes = Buffer.from('source-video');
  fs.mkdirSync(path.join(storageRoot, 'source'), { recursive: true });
  fs.writeFileSync(path.join(storageRoot, 'source', 'source.mp4'), sourceBytes);
  db.prepare(`INSERT INTO assets
    (id, name, type, category, url, local_path, file_size, mime_type, metadata, created_at, updated_at)
    VALUES (101, 'source', 'video', 'source', '', 'source/source.mp4', ?, 'video/mp4', ?, ?, ?)`)
    .run(sourceBytes.length, JSON.stringify({ sha256: sourceFingerprint }), NOW, NOW);
  db.prepare(`INSERT INTO redraw_projects
    (id, tenant_id, user_id, title, default_locale, default_market, created_at, updated_at)
    VALUES (1, ?, ?, 'project', 'en-US', 'US', ?, ?)`)
    .run(OWNER.tenantId, OWNER.userId, NOW, NOW);
  db.prepare(`INSERT INTO redraw_works
    (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (1, 1, ?, ?, 'work', 101, ?, 12000, ?, ?)`)
    .run(OWNER.tenantId, OWNER.userId, sourceFingerprint, NOW, NOW);
  const versionId = Number(db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, name_map_json, source_facts_json,
     facts_hash, reference_bundle_required, status, created_at, updated_at)
    VALUES (1, ?, ?, 1, 'en-US', 'US', '{}', ?, ?, 1, 'asset_review', ?, ?)`)
    .run(OWNER.tenantId, OWNER.userId, JSON.stringify(facts), factsHash, NOW, NOW).lastInsertRowid);
  for (let i = 0; i < 12; i += 1) {
    db.prepare(`INSERT INTO redraw_shots
      (work_id, version_id, tenant_id, user_id, shot_id, batch_index, shot_index, start_ms,
       end_ms, duration_ms, source_dialogue_json, localized_dialogue_json, references_json,
       reference_bundle_json, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, 1, ?, ?, ?, 1000, '[]', '[]', '[]', '{}', ?, ?)`)
      .run(versionId, OWNER.tenantId, OWNER.userId, `shot-${i + 1}`, i + 1, i * 1000, (i + 1) * 1000, NOW, NOW);
  }
  return { db, storageRoot, versionId, factsHash, sourceFingerprint };
}

function registerInput(state, overrides = {}) {
  return {
    db: state.db,
    storageRoot: state.storageRoot,
    tenantId: overrides.tenantId || OWNER.tenantId,
    userId: overrides.userId || OWNER.userId,
    versionId: state.versionId,
    expectedVersionUpdatedAt: overrides.expectedVersionUpdatedAt ?? NOW,
    idempotencyKey: overrides.idempotencyKey || 'coverage-key-1',
    now: () => NOW,
    provider: overrides.provider,
  };
}

function providerFromManifest(options = {}) {
  return async ({ outputDir, input }) => {
    assert.ok(outputDir.includes('redraw-coverage-staging-'));
    assert.equal(input.version_id > 0, true);
    assert.equal(input.owner.tenant_id, OWNER.tenantId);
    assert.equal(input.owner.user_id, OWNER.userId);
    await writeReviewedCoverage(outputDir, options);
    return {
      status: options.status || 'completed',
      provider_task_id: options.taskId || 'provider-task-1',
      reviewed_manifest_relative_path: options.relativePath || 'redraw-full-frame-reviewed-manifest.json',
    };
  };
}

test('registerReviewedCoverage validates and stores reviewed coverage as pending loader-compatible scene asset', async (t) => {
  const state = await setup(t);
  const result = await registerReviewedCoverage(registerInput(state, { provider: providerFromManifest() }));

  assert.equal(result.billing.credits, 0);
  assert.equal(result.billing.held, 0);
  assert.equal(result.billing.charged, 0);
  assert.equal(result.expected_updated_at, NOW);
  assert.equal(Number.isInteger(result.redraw_asset_id), true);

  const registration = state.db.prepare('SELECT * FROM redraw_coverage_registrations').get();
  assert.equal(registration.status, 'completed');
  assert.equal(registration.provider_task_id, 'provider-task-1');
  assert.equal(registration.redraw_asset_id, result.redraw_asset_id);
  assert.match(registration.analysis_sha256, /^[a-f0-9]{64}$/);

  const redrawAsset = state.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(result.redraw_asset_id);
  assert.equal(redrawAsset.kind, 'scene');
  assert.equal(redrawAsset.status, 'generated');
  assert.equal(redrawAsset.approval_status, 'pending');
  assert.equal(redrawAsset.credit_reservation_id, null);
  const payload = JSON.parse(redrawAsset.source_ref_json);
  assert.deepEqual(payload.source_ref, { stable_id: 'full-frame-reviewed-coverage' });
  assert.equal(payload.snapshot.mode, 'full_frame_reviewed_coverage');
  assert.equal(payload.snapshot.version_id, state.versionId);
  assert.equal(payload.snapshot.facts_hash, state.factsHash);
  assert.equal(payload.snapshot.source_fingerprint, state.sourceFingerprint);
  assert.equal(payload.snapshot.analysis_sha256, registration.analysis_sha256);

  const assets = state.db.prepare('SELECT * FROM assets WHERE category = ? ORDER BY id').all('redraw');
  const documents = assets.filter((asset) => asset.type === 'document');
  const images = assets.filter((asset) => asset.type === 'image');
  assert.equal(documents.length, 1);
  assert.equal(images.length, 14);
  assert.equal(documents[0].mime_type, 'application/json');
  assert.equal(path.posix.basename(documents[0].local_path.replace(/\\/g, '/')), 'redraw-full-frame-reviewed-manifest.json');
  assert.equal(images.every((asset) => asset.mime_type === 'image/png' && asset.width === WIDTH && asset.height === HEIGHT), true);
  for (const asset of assets) {
    const metadata = JSON.parse(asset.metadata);
    assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
    const bytes = fs.readFileSync(path.join(state.storageRoot, asset.local_path));
    assert.equal(sha256(bytes), metadata.sha256);
    assert.equal(asset.file_size, bytes.length);
  }
  assert.equal(fs.existsSync(path.join(state.storageRoot, path.posix.dirname(documents[0].local_path), 'unreferenced-secret.png')), false);

  reviewAsset(state.db, result.redraw_asset_id, {
    action: 'approved',
    reviewerId: OWNER.userId,
    expectedUpdatedAt: redrawAsset.updated_at,
    tenantId: OWNER.tenantId,
    userId: OWNER.userId,
    preparationContext: { storageRoot: state.storageRoot },
  });
  const coverage = await loadReviewedReferenceCoverage({
    db: state.db,
    storageRoot: state.storageRoot,
    tenantId: OWNER.tenantId,
    userId: OWNER.userId,
    versionId: state.versionId,
  });
  assert.equal(coverage.status, 'approved');
  assert.equal(coverage.coverage_binding.analysis_sha256, registration.analysis_sha256);
  assert.equal(coverage.shots.length, 12);
});

test('registerReviewedCoverage replays completed same request and rejects same key with different request', async (t) => {
  const state = await setup(t);
  let providerCalls = 0;
  const first = await registerReviewedCoverage(registerInput(state, {
    idempotencyKey: 'same-key',
    provider: async (args) => {
      providerCalls += 1;
      return providerFromManifest({ taskId: 'task-replay' })(args);
    },
  }));
  const replay = await registerReviewedCoverage(registerInput(state, {
    idempotencyKey: 'same-key',
    provider: async () => {
      providerCalls += 1;
      throw new Error('provider must not be called for replay');
    },
  }));

  assert.equal(providerCalls, 1);
  assert.equal(replay.redraw_asset_id, first.redraw_asset_id);
  assert.deepEqual(replay.billing, { credits: 0, held: 0, charged: 0 });
  await assert.rejects(
    registerReviewedCoverage(registerInput(state, {
      idempotencyKey: 'same-key',
      expectedVersionUpdatedAt: '2026-08-27T08:01:00.000Z',
      provider: providerFromManifest(),
    })),
    /REDRAW_COVERAGE_REGISTRATION_IDEMPOTENCY_CONFLICT/,
  );
});

test('registerReviewedCoverage keeps processing claim from replaying provider', async (t) => {
  const state = await setup(t);
  const idempotencyHash = sha256('busy-key');
  state.db.prepare(`INSERT INTO redraw_coverage_registrations
    (tenant_id, user_id, version_id, idempotency_hash, request_hash, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)`)
    .run(OWNER.tenantId, OWNER.userId, state.versionId, idempotencyHash, sha256(stableJson({ expected_version_updated_at: NOW })), NOW, NOW);
  await assert.rejects(
    registerReviewedCoverage(registerInput(state, {
      idempotencyKey: 'busy-key',
      provider: async () => {
        throw new Error('provider must not be called while processing');
      },
    })),
    /REDRAW_COVERAGE_REGISTRATION_IN_PROGRESS/,
  );
});

test('registerReviewedCoverage claims before provider so same-key concurrency calls provider once', async (t) => {
  const state = await setup(t);
  let providerCalls = 0;
  let releaseProvider;
  const providerStarted = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  const first = registerReviewedCoverage(registerInput(state, {
    idempotencyKey: 'concurrent-key',
    provider: async (args) => {
      providerCalls += 1;
      await providerStarted;
      return providerFromManifest({ taskId: 'task-concurrent' })(args);
    },
  }));
  const second = registerReviewedCoverage(registerInput(state, {
    idempotencyKey: 'concurrent-key',
    provider: async () => {
      providerCalls += 1;
      throw new Error('second provider must not run');
    },
  }));
  await assert.rejects(second, /REDRAW_COVERAGE_REGISTRATION_IN_PROGRESS/);
  releaseProvider();
  const result = await first;
  assert.equal(providerCalls, 1);
  assert.equal(Number.isInteger(result.redraw_asset_id), true);
});

test('registerReviewedCoverage rejects owner, CAS, version facts, path escape, symlink, and hash drift before assets are consumable', async (t) => {
  const state = await setup(t);
  await assert.rejects(
    registerReviewedCoverage(registerInput(state, { tenantId: 'other-tenant', provider: providerFromManifest() })),
    /REDRAW_VERSION_NOT_FOUND/,
  );
  await assert.rejects(
    registerReviewedCoverage(registerInput(state, { expectedVersionUpdatedAt: 'stale', provider: providerFromManifest() })),
    /REDRAW_COVERAGE_VERSION_CONFLICT/,
  );
  await assert.rejects(
    registerReviewedCoverage(registerInput(state, {
      idempotencyKey: 'source-mismatch',
      provider: providerFromManifest({ sourceFingerprint: 'e'.repeat(64) }),
    })),
    /REDRAW_COVERAGE_VERSION_MISMATCH/,
  );
  await assert.rejects(
    registerReviewedCoverage(registerInput(state, {
      idempotencyKey: 'escape',
      provider: providerFromManifest({ relativePath: '../redraw-full-frame-reviewed-manifest.json' }),
    })),
    /REDRAW_COVERAGE_PROVIDER_OUTPUT_INVALID/,
  );
  await assert.rejects(
    registerReviewedCoverage(registerInput(state, {
      idempotencyKey: 'provider-db-field',
      provider: async ({ outputDir }) => {
        await writeReviewedCoverage(outputDir);
        return {
          status: 'completed',
          provider_task_id: 'task-db-field',
          reviewed_manifest_relative_path: 'redraw-full-frame-reviewed-manifest.json',
          asset_id: 123,
        };
      },
    })),
    /REDRAW_COVERAGE_PROVIDER_OUTPUT_INVALID/,
  );
  await assert.rejects(
    registerReviewedCoverage(registerInput(state, {
      idempotencyKey: 'hash-drift',
      provider: async ({ outputDir }) => {
        await writeReviewedCoverage(outputDir);
        fs.appendFileSync(path.join(outputDir, 'frames', 'frame-0.png'), Buffer.from('drift'));
        return { status: 'completed', provider_task_id: 'task-drift', reviewed_manifest_relative_path: 'redraw-full-frame-reviewed-manifest.json' };
      },
    })),
    /REDRAW_COVERAGE_EVIDENCE_INVALID/,
  );

  const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-coverage-link-target-'));
  t.after(() => fs.rmSync(linkRoot, { recursive: true, force: true }));
  await assert.rejects(
    registerReviewedCoverage(registerInput(state, {
      idempotencyKey: 'symlink',
      provider: async ({ outputDir }) => {
        await writeReviewedCoverage(outputDir);
        fs.rmSync(path.join(outputDir, 'frames'), { recursive: true, force: true });
        fs.mkdirSync(path.join(linkRoot, 'frames'), { recursive: true });
        fs.writeFileSync(path.join(linkRoot, 'frames', 'frame-0.png'), Buffer.from('outside'));
        fs.symlinkSync(path.join(linkRoot, 'frames'), path.join(outputDir, 'frames'), process.platform === 'win32' ? 'junction' : 'dir');
        return { status: 'completed', provider_task_id: 'task-link', reviewed_manifest_relative_path: 'redraw-full-frame-reviewed-manifest.json' };
      },
    })),
    /REDRAW_COVERAGE_EVIDENCE_INVALID/,
  );

  assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM redraw_assets WHERE kind = 'scene'").get().count, 0);
});

test('registerReviewedCoverage records unknown provider result without provider replay', async (t) => {
  const state = await setup(t);
  let providerCalls = 0;
  await assert.rejects(
    registerReviewedCoverage(registerInput(state, {
      idempotencyKey: 'unknown-key',
      provider: async () => {
        providerCalls += 1;
        return { status: 'unknown', provider_task_id: 'task-unknown' };
      },
    })),
    /REDRAW_COVERAGE_PROVIDER_UNKNOWN/,
  );
  await assert.rejects(
    registerReviewedCoverage(registerInput(state, {
      idempotencyKey: 'unknown-key',
      provider: async () => {
        providerCalls += 1;
        throw new Error('provider must not be retried for unknown result');
      },
    })),
    /REDRAW_COVERAGE_REGISTRATION_NEEDS_ATTENTION/,
  );
  assert.equal(providerCalls, 1);
  const registration = state.db.prepare('SELECT * FROM redraw_coverage_registrations WHERE idempotency_hash = ?').get(sha256('unknown-key'));
  assert.equal(registration.status, 'needs_attention');
  assert.equal(registration.provider_task_id, 'task-unknown');
});
