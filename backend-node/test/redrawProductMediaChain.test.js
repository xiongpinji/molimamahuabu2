const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');
const express = require('express');
const sharp = require('sharp');

const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { setupRouter } = require('../src/routes');
const modelPriceService = require('../src/services/modelPriceService');
const userAuthService = require('../src/services/userAuthService');
const {
  buildGeneratedCoverageManifest,
  canonicalCoverageSha256,
} = require('../src/services/redrawFullFrameCoverageService');
const {
  canonicalizeModelLock,
  canonicalSha256: canonicalModelLockSha256,
} = require('../src/services/redrawFullFrameModelLockService');
const {
  loadReviewedReferenceCoverage,
} = require('../src/services/redrawReferenceBundleService');

const WIDTH = 64;
const HEIGHT = 96;
const DURATION_MS = 12_000;
const NOW = '2026-08-28T00:00:00.000Z';
const CLEAN_MODEL = 'local-product-clean-v1';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function pngBytes(value = 64, channels = 3) {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * channels, value);
  const image = sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels } });
  return (channels === 1 ? image.toColourspace('b-w') : image).png().toBuffer();
}

async function maskPngBytes() {
  const pixels = Buffer.alloc(WIDTH * HEIGHT);
  for (let y = 70; y < 82; y += 1) {
    for (let x = 4; x < 40; x += 1) pixels[(y * WIDTH) + x] = 255;
  }
  return sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 1 } })
    .toColourspace('b-w')
    .png()
    .toBuffer();
}

function storeFile(root, relativePath, bytes) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return sha256(bytes);
}

function insertAsset(db, input) {
  return Number(db.prepare(`INSERT INTO assets
    (name, type, category, url, local_path, file_size, mime_type, width, height, duration,
     metadata, created_at, updated_at)
    VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      input.name,
      input.type,
      input.category || 'redraw',
      input.localPath,
      input.bytes.length,
      input.mimeType,
      input.width ?? null,
      input.height ?? null,
      input.duration ?? null,
      JSON.stringify({ sha256: sha256(input.bytes), ...(input.metadata || {}) }),
      NOW,
      NOW,
    ).lastInsertRowid);
}

function modelLock() {
  const projects = {
    face_detector: ['MediaPipe face detection', 'google-ai-edge/mediapipe'],
    person_detector: ['YOLOX', 'Megvii-BaseDetection/YOLOX'],
    text_detector: ['PaddleOCR', 'PaddlePaddle/PaddleOCR'],
    tracker: ['ByteTrack', 'FoundationVision/ByteTrack'],
  };
  const components = ['tracker', 'text_detector', 'person_detector', 'face_detector'].map((component) => ({
    component,
    project: projects[component][0],
    repository: projects[component][1],
    revision: `rev-${component}-20260828`,
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

async function writeReviewedCoverage(outputDir, input) {
  assert.deepEqual(Object.keys(input).sort(), [
    'duration_ms', 'expected_version_updated_at', 'facts_hash', 'owner',
    'shots', 'source_fingerprint', 'version_id',
  ]);
  assert.equal(Object.keys(input).some((key) => /asset|storage|database|db/i.test(key)), false);
  assert.equal(input.shots.length, 1);
  assert.deepEqual(input.shots[0], { shot_id: 'shot-1', start_ms: 0, end_ms: DURATION_MS });

  const frameShas = [];
  for (let index = 0; index < 12; index += 1) {
    const bytes = await pngBytes(20 + index);
    frameShas[index] = storeFile(outputDir, `frames/frame-${index}.png`, bytes);
  }
  const maskBytes = await maskPngBytes();
  const maskSha = storeFile(outputDir, 'masks/text-subtitle.png', maskBytes);
  const generated = await buildGeneratedCoverageManifest({
    evidenceRoot: outputDir,
    source: {
      sha256: input.source_fingerprint,
      duration_ms: input.duration_ms,
      width: WIDTH,
      height: HEIGHT,
      frame_count: 12,
      time_base: { numerator: 1, denominator: 1 },
    },
    shots: input.shots,
    frames: Array.from({ length: 12 }, (_, index) => ({
      frame_index: index,
      timestamp_ticks: index,
      timestamp_ms: index * 1000,
      shot_id: 'shot-1',
      path: `frames/frame-${index}.png`,
      sha256: frameShas[index],
      width: WIDTH,
      height: HEIGHT,
      person_region_ids: [],
      text_region_ids: index === 0 ? ['text-subtitle-region'] : [],
      review_point_reasons: [],
      review_status: 'not_required',
    })),
    personTracks: [],
    textTracks: [{
      region_key: 'subtitle-a',
      kind: 'subtitle',
      treatment: 'translate_subtitle',
      target_text_key: 'subtitle-a',
      frame_ranges: [{ start_frame: 0, end_frame: 0 }],
      regions: [{
        region_id: 'text-subtitle-region',
        frame_index: 0,
        polygon: [{ x: 4, y: 70 }, { x: 40, y: 70 }, { x: 40, y: 82 }],
        mask: {
          path: 'masks/text-subtitle.png',
          sha256: maskSha,
          width: WIDTH,
          height: HEIGHT,
          mime_type: 'image/png',
        },
      }],
      review_status: 'pending',
      reviewer: null,
    }],
    modelLock: modelLock(),
  });
  generated.status = 'reviewed';
  for (const frame of generated.frames) {
    frame.review_status = frame.review_point_reasons.length ? 'reviewed' : 'not_required';
  }
  for (const track of generated.text_tracks) {
    track.review_status = 'reviewed';
    track.reviewer = 'codex-local-review';
  }
  generated.review = {
    status: 'reviewed',
    reviewed: true,
    required_review_point_count: generated.review.required_review_point_count,
    reviewed_point_count: generated.review.required_review_point_count,
    reviewer: 'codex-local-review',
  };
  generated.approval_status = 'pending';
  generated.ready_for_reference = false;
  generated.analysis_sha256 = canonicalCoverageSha256(generated);
  fs.writeFileSync(
    path.join(outputDir, 'redraw-full-frame-reviewed-manifest.json'),
    `${JSON.stringify(generated, null, 2)}\n`,
  );
}

function identityPack(input) {
  const value = {
    schema_version: 'target-actor-identity-v1',
    source_character_key: 'char-a',
    target_actor_label: 'Alice Carter',
    artifact: {
      asset_id: input.identityAssetId,
      sha256: input.identitySha,
      width: WIDTH,
      height: HEIGHT,
      mime_type: 'image/png',
    },
    wardrobe: {
      label: '整集主服装',
      reference_asset_id: input.wardrobeAssetId,
      reference_sha256: input.wardrobeSha,
      consistency_confirmed: true,
    },
    confirmed_views: ['front', 'profile', 'full_body'],
    live_action_human_confirmed: true,
    adult_status: 'verified_18_plus',
    identity_consistency_confirmed: true,
    persona_origin: 'fictional_ai_generated',
    target_country: 'US',
    ready: true,
    reviewed_by: input.userId,
    reviewed_at: NOW,
  };
  return { ...value, pack_sha256: sha256(stableJson(value)) };
}

function billingSnapshot(db) {
  const reservation = db.prepare(`SELECT COUNT(*) AS rows,
    COALESCE(SUM(amount), 0) AS reserved,
    COALESCE(SUM(CASE WHEN status = 'held' THEN amount ELSE 0 END), 0) AS held,
    COALESCE(SUM(CASE WHEN status = 'confirmed' THEN amount ELSE 0 END), 0) AS charged
    FROM tenant_usage_reservations`).get();
  const ledger = db.prepare('SELECT COUNT(*) AS rows FROM tenant_credit_ledger').get();
  return { ...reservation, ledger_rows: ledger.rows };
}

async function setupFixture(t) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-product-media-chain-'));
  const previous = {
    publicMode: process.env.PUBLIC_PLATFORM_MODE,
    jwtSecret: process.env.PLATFORM_JWT_SECRET,
  };
  process.env.PUBLIC_PLATFORM_MODE = 'true';
  process.env.PLATFORM_JWT_SECRET = 'redraw-product-media-chain-secret-at-least-32-bytes';
  t.after(() => {
    db.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
    if (previous.publicMode === undefined) delete process.env.PUBLIC_PLATFORM_MODE;
    else process.env.PUBLIC_PLATFORM_MODE = previous.publicMode;
    if (previous.jwtSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = previous.jwtSecret;
  });

  const user = userAuthService.register(db, {
    email: `redraw-product-chain-${crypto.randomUUID()}@example.test`,
    password: 'redraw-product-chain-password-123',
  });
  const userId = String(user.id);
  const tenantId = `personal:${userId}`;

  const sourceBytes = Buffer.from('local-source-video');
  const sourceSha = storeFile(storageRoot, 'source/source.mp4', sourceBytes);
  const identityBytes = await pngBytes(72);
  const identitySha = storeFile(storageRoot, 'seed/identity.png', identityBytes);
  const wardrobeBytes = await pngBytes(84);
  const wardrobeSha = storeFile(storageRoot, 'seed/wardrobe.png', wardrobeBytes);
  const voiceBytes = Buffer.from('local-voice-evidence');
  storeFile(storageRoot, 'seed/voice.mp3', voiceBytes);
  const motionBytes = Buffer.from('00000000ftypisom-local-motion-reference');
  const motionSha = storeFile(storageRoot, `redraw-conditioning/${sha256(motionBytes)}.mp4`, motionBytes);

  const sourceAssetId = insertAsset(db, {
    name: 'source.mp4', type: 'video', category: 'redraw_source', localPath: 'source/source.mp4',
    bytes: sourceBytes, mimeType: 'video/mp4', width: WIDTH, height: HEIGHT, duration: DURATION_MS / 1000,
  });
  const identityAssetId = insertAsset(db, {
    name: 'identity.png', type: 'image', localPath: 'seed/identity.png', bytes: identityBytes,
    mimeType: 'image/png', width: WIDTH, height: HEIGHT,
  });
  const wardrobeAssetId = insertAsset(db, {
    name: 'wardrobe.png', type: 'image', localPath: 'seed/wardrobe.png', bytes: wardrobeBytes,
    mimeType: 'image/png', width: WIDTH, height: HEIGHT,
  });
  const voiceAssetId = insertAsset(db, {
    name: 'voice.mp3', type: 'audio', localPath: 'seed/voice.mp3', bytes: voiceBytes,
    mimeType: 'audio/mpeg', duration: 1,
  });

  const projectId = Number(db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, default_locale, default_market, localization_level,
     execution_mode, budget_limit_credits, max_auto_attempts_per_shot, policy_version,
     automation_policy_json, status, created_at, updated_at)
    VALUES (?, ?, 'HTTP product chain', 'en-US', 'US', 'faithful', 'auto', 100, 1, 1,
      ?, 'draft', ?, ?)`)
    .run(tenantId, userId, JSON.stringify({
      analysis_confidence_thresholds: {
        character_mapping: 0.9, speaker_mapping: 0.9, text_regions: 0.9, shot_boundary: 0.9,
      },
    }), NOW, NOW).lastInsertRowid);
  const workId = Number(db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms,
     current_version, current_step, status, created_at, updated_at)
    VALUES (?, ?, ?, 'episode', ?, ?, ?, 1, 2, 'asset_review', ?, ?)`)
    .run(projectId, tenantId, userId, sourceAssetId, sourceSha, DURATION_MS, NOW, NOW).lastInsertRowid);
  const nameMap = { 'char-a': 'Alice Carter' };
  const facts = {
    schema_version: '2.0',
    script_sha256: '9'.repeat(64),
    name_map_source_sha256: sha256(stableJson(nameMap)),
    characters: [{ source_character_key: 'char-a', source_name: 'Alice' }],
    shots: [{
      id: 'shot-1',
      confidence: { character_mapping: 0.99, speaker_mapping: 0.99, text_regions: 0.99, shot_boundary: 0.99 },
    }],
  };
  const factsHash = sha256(stableJson(facts));
  const versionId = Number(db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, localization_level, name_map_json,
     source_facts_json, facts_hash, reference_bundle_required, status, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'en-US', 'US', 'faithful', ?, ?, ?, 1, 'asset_review', ?, ?)`)
    .run(workId, tenantId, userId, JSON.stringify(nameMap), JSON.stringify(facts), factsHash, NOW, NOW)
    .lastInsertRowid);
  const shotId = Number(db.prepare(`INSERT INTO redraw_shots
    (work_id, version_id, tenant_id, user_id, shot_id, batch_index, shot_index, start_ms, end_ms,
     duration_ms, source_dialogue_json, localized_dialogue_json, references_json,
     preparation_state, preparation_version, preparation_snapshot_json, reference_bundle_json,
     status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'shot-1', 1, 1, 0, ?, ?, '[]', '[]', '[]',
      'localized', 1, '{}', '{}', 'draft', ?, ?)`)
    .run(workId, versionId, tenantId, userId, DURATION_MS, DURATION_MS, NOW, NOW).lastInsertRowid);

  const pack = identityPack({ identityAssetId, identitySha, wardrobeAssetId, wardrobeSha, userId });
  db.prepare(`INSERT INTO redraw_assets
    (version_id, tenant_id, user_id, kind, source_ref_json, localized_name, asset_id,
     voice_asset_id, version_number, approval_status, approved_by, approved_at, status, created_at, updated_at)
    VALUES (?, ?, ?, 'character', ?, 'Alice Carter', ?, ?, 1, 'approved', ?, ?, 'generated', ?, ?)`)
    .run(versionId, tenantId, userId, JSON.stringify({
      source_ref: { stable_id: 'char-a' },
      identity_pack: pack,
      snapshot: { voice_snapshot: {
        locale: 'en-US', market: 'US', audio_sha256: sha256(voiceBytes), audio_asset_id: voiceAssetId,
        language_verified: true, detected_locale: 'en-US',
      } },
    }), identityAssetId, voiceAssetId, userId, NOW, NOW, NOW);
  db.prepare(`INSERT INTO redraw_assets
    (version_id, tenant_id, user_id, kind, source_ref_json, localized_name, voice_asset_id,
     version_number, approval_status, approved_by, approved_at, status, created_at, updated_at)
    VALUES (?, ?, ?, 'voice', ?, 'voice char-a', ?, 1, 'approved', ?, ?, 'generated', ?, ?)`)
    .run(versionId, tenantId, userId, JSON.stringify({ source_ref: { stable_id: 'char-a' } }),
      voiceAssetId, userId, NOW, NOW, NOW);

  const motionMetadata = {
    sha256: motionSha,
    source: 'redraw_motion_reference_import',
    tenant_id: tenantId,
    user_id: userId,
    version_id: versionId,
    scope_type: 'shot',
    scope_id: shotId,
    purpose: 'motion',
    redraw_motion_import: {
      schema_version: 'redraw-motion-import-v1',
      tenant_id: tenantId,
      user_id: userId,
      version_id: versionId,
      shot_id: shotId,
      source_work_id: workId,
      source_asset_id: sourceAssetId,
      source_fingerprint: sourceSha,
      clip_start_ms: 0,
      clip_end_ms: DURATION_MS,
      file_sha256: motionSha,
      duration_ms: DURATION_MS,
      width: WIDTH,
      height: HEIGHT,
      mime_type: 'video/mp4',
      video_codec: 'h264',
      audio_stream_count: 0,
      reviewed_by: userId,
      reviewed_at: NOW,
      review: {
        full_frame_reviewed: true,
        source_identity_obscured: true,
        source_text_obscured: true,
        motion_preserved: true,
      },
    },
  };
  const motionAssetId = insertAsset(db, {
    name: 'motion.mp4', type: 'video', localPath: `redraw-conditioning/${motionSha}.mp4`,
    bytes: motionBytes, mimeType: 'video/mp4', width: WIDTH, height: HEIGHT,
    duration: DURATION_MS / 1000, metadata: motionMetadata,
  });
  db.prepare(`INSERT INTO redraw_reference_artifact_imports
    (tenant_id, user_id, version_id, scope_type, scope_id, purpose, idempotency_hash,
     request_hash, file_sha256, stored_asset_id, status, error_code, created_at, updated_at)
    VALUES (?, ?, ?, 'shot', ?, 'motion', ?, ?, ?, ?, 'completed', NULL, ?, ?)`)
    .run(tenantId, userId, versionId, shotId, sha256('http-chain-motion-idempotency'),
      sha256('http-chain-motion-request'), motionSha, motionAssetId, NOW, NOW);

  const capabilityEvidence = {
    provider: 'local-product-clean',
    model: CLEAN_MODEL,
    task_id: 'local-clean-capability-evidence',
    terminal_status: 'completed',
    artifact_id: sourceAssetId,
  };
  db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, base_url, api_key, model, default_model, priority,
     is_default, is_active, settings, created_at, updated_at, deleted_at)
    VALUES ('image', 'local-product-clean', 'Local product clean', '', '', ?, ?, 100,
      1, 1, ?, ?, ?, NULL)`)
    .run(CLEAN_MODEL, CLEAN_MODEL, JSON.stringify({ redraw_locale_capabilities: [{
      locale: 'en-US', market: 'US', language: 'English', status: 'verified',
      evidence: { clean_plate_image: capabilityEvidence },
    }] }), NOW, NOW);
  modelPriceService.set(db, CLEAN_MODEL, 0, {
    pricingMode: 'free', category: 'image', billingUnit: 'request', costUnit: 'image',
  });

  const coverageCalls = [];
  const coverageProvider = async (request) => {
    coverageCalls.push(request);
    assert.deepEqual(Object.keys(request).sort(), ['input', 'outputDir']);
    await writeReviewedCoverage(request.outputDir, request.input);
    return {
      status: 'completed',
      provider_task_id: 'local-coverage-task-1',
      reviewed_manifest_relative_path: 'redraw-full-frame-reviewed-manifest.json',
    };
  };
  const cleanCalls = [];
  const cleanProvider = async (request) => {
    cleanCalls.push(request);
    assert.deepEqual(Object.keys(request).sort(), ['input', 'outputDir']);
    assert.equal(Object.prototype.hasOwnProperty.call(request, 'db'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(request, 'storageRoot'), false);
    const output = await pngBytes(96);
    fs.writeFileSync(path.join(request.outputDir, 'clean.png'), output);
    return {
      status: 'completed',
      provider_task_id: 'local-clean-task-1',
      output: { relative_path: 'clean.png' },
      quality: {
        width: WIDTH,
        height: HEIGHT,
        mime_type: 'image/png',
        mask_area_changed: true,
        non_mask_similarity: 0.99,
      },
    };
  };
  const unusedProvider = async () => ({ status: 'failed' });
  const router = setupRouter({ storage: { local_path: storageRoot } }, db, {
    info() {}, warn() {}, error() {},
  }, {
    localizationProvider: unusedProvider,
    assetGenerationProvider: cleanProvider,
    dialogueProvider: unusedProvider,
    coverageRegistrationProvider: coverageProvider,
    redrawOptions: {
      referencePreparationProbeRunner: async () => ({
        duration_ms: DURATION_MS,
        width: WIDTH,
        height: HEIGHT,
        mime_type: 'video/mp4',
        video_codec: 'h264',
        audio_stream_count: 0,
      }),
    },
  });
  const token = userAuthService.issueToken(user, process.env.PLATFORM_JWT_SECRET, 0);
  return {
    db, router, storageRoot, token, tenantId, userId, versionId, shotId,
    sourceAssetId, motionAssetId, coverageCalls, cleanCalls,
  };
}

async function withServer(router, run) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}/api/v1`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(fixture, baseUrl, pathname, body) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${fixture.token}`,
      'X-Tenant-Id': fixture.tenantId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function waitForTask(db, taskId, expectedStatuses, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(taskId);
    if (row && expectedStatuses.includes(row.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const latest = db.prepare('SELECT * FROM async_tasks WHERE id = ?').get(taskId);
  throw new Error(`timed out waiting for task ${taskId}: ${JSON.stringify(latest)}`);
}

test('真实 HTTP 产品链由产品服务登记、审核并复用 coverage 与 clean 媒体直到 reference_ready 且零计费', async (t) => {
  const fixture = await setupFixture(t);
  const beforeBilling = billingSnapshot(fixture.db);
  assert.deepEqual(beforeBilling, { rows: 0, reserved: 0, held: 0, charged: 0, ledger_rows: 0 });

  await withServer(fixture.router, async (baseUrl) => {
    const versionBefore = fixture.db.prepare('SELECT updated_at FROM redraw_versions WHERE id = ?')
      .get(fixture.versionId);
    const coverageResponse = await post(
      fixture,
      baseUrl,
      `/redraw/versions/${fixture.versionId}/full-frame-coverages`,
      { expected_version_updated_at: versionBefore.updated_at, idempotency_key: 'http-product-coverage-1' },
    );
    const coverageBody = await coverageResponse.json();
    const coverageRegistration = fixture.db.prepare(
      'SELECT status, error_code, error_message FROM redraw_coverage_registrations ORDER BY id DESC LIMIT 1',
    ).get();
    assert.equal(
      coverageResponse.status,
      200,
      JSON.stringify({ coverageBody, coverageRegistration }),
    );
    assert.deepEqual(coverageBody.data.billing, { credits: 0, held: 0, charged: 0 });
    assert.equal(fixture.coverageCalls.length, 1);

    const coverageId = Number(coverageBody.data.redraw_asset_id);
    const coveragePending = fixture.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(coverageId);
    assert.equal(coveragePending.status, 'generated');
    assert.equal(coveragePending.approval_status, 'pending');
    assert.equal(coveragePending.credit_reservation_id, null);

    const coverageReviewResponse = await post(
      fixture,
      baseUrl,
      `/redraw/assets/${coverageId}/review`,
      { action: 'approved', expected_updated_at: coveragePending.updated_at },
    );
    const coverageReviewBody = await coverageReviewResponse.json();
    assert.equal(coverageReviewResponse.status, 200, JSON.stringify(coverageReviewBody));
    const coverageApproved = fixture.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(coverageId);
    assert.equal(coverageApproved.status, 'generated');
    assert.equal(coverageApproved.approval_status, 'approved');
    assert.equal(coverageApproved.approved_by, fixture.userId);
    assert.ok(coverageApproved.approved_at);

    const defaultCoverage = await loadReviewedReferenceCoverage({
      db: fixture.db,
      storageRoot: fixture.storageRoot,
      tenantId: fixture.tenantId,
      userId: fixture.userId,
      versionId: fixture.versionId,
    });
    assert.equal(defaultCoverage.status, 'approved');
    assert.equal(defaultCoverage.shots.length, 1);
    assert.deepEqual(defaultCoverage.shots[0].requirements.map(({ kind, key }) => ({ kind, key })), [
      { kind: 'text_clean', key: 'subtitle-a' },
    ]);

    const firstQuoteResponse = await post(
      fixture,
      baseUrl,
      `/redraw/versions/${fixture.versionId}/reference-preparation-quote`,
      { shot_ids: [fixture.shotId] },
    );
    const firstQuoteBody = await firstQuoteResponse.json();
    assert.equal(firstQuoteResponse.status, 200, JSON.stringify(firstQuoteBody));
    assert.equal(firstQuoteBody.data.priced, true);
    assert.equal(firstQuoteBody.data.credits, 0);
    assert.deepEqual(firstQuoteBody.data.items.map(({ kind, credits }) => ({ kind, credits })), [
      { kind: 'text_clean', credits: 0 },
    ]);

    const firstStartResponse = await post(
      fixture,
      baseUrl,
      `/redraw/versions/${fixture.versionId}/reference-preparations`,
      {
        shot_ids: [fixture.shotId],
        quote_hash: firstQuoteBody.data.quote_hash,
        idempotency_key: 'http-product-clean-first',
      },
    );
    const firstStartBody = await firstStartResponse.json();
    assert.equal(firstStartResponse.status, 202, JSON.stringify(firstStartBody));
    const firstTask = await waitForTask(fixture.db, firstStartBody.data.task_id, ['needs_attention', 'failed']);
    const diagnosticShot = fixture.db.prepare('SELECT preparation_state, stale_reason_code, preparation_snapshot_json FROM redraw_shots WHERE id = ?')
      .get(fixture.shotId);
    assert.equal(firstTask.status, 'needs_attention', JSON.stringify({ firstTask, diagnosticShot, cleanCalls: fixture.cleanCalls.length }));
    assert.equal(fixture.cleanCalls.length, 1);

    const firstShot = fixture.db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(fixture.shotId);
    assert.equal(firstShot.preparation_state, 'needs_attention');
    const firstSnapshot = JSON.parse(firstShot.preparation_snapshot_json);
    assert.equal(firstSnapshot.status, 'unknown');
    assert.equal(firstSnapshot.clean_results.length, 1);
    const cleanResult = firstSnapshot.clean_results[0];
    assert.equal(cleanResult.kind, 'text_clean');
    assert.equal(cleanResult.status, 'unknown');
    const cleanId = Number(cleanResult.redraw_asset_id);
    const cleanPending = fixture.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(cleanId);
    assert.equal(cleanPending.status, 'needs_attention');
    assert.equal(cleanPending.approval_status, 'pending');
    assert.equal(cleanPending.credit_reservation_id, null);
    assert.ok(Number.isInteger(cleanPending.clean_plate_asset_id));
    const cleanStored = fixture.db.prepare('SELECT * FROM assets WHERE id = ?').get(cleanPending.clean_plate_asset_id);
    assert.match(cleanStored.local_path, /^redraw-clean-plates\/[a-f0-9]{64}\.png$/);
    assert.equal(fs.existsSync(path.join(fixture.storageRoot, cleanStored.local_path)), true);

    const cleanReviewResponse = await post(
      fixture,
      baseUrl,
      `/redraw/assets/${cleanId}/review`,
      { action: 'approved', expected_updated_at: cleanPending.updated_at },
    );
    const cleanReviewBody = await cleanReviewResponse.json();
    assert.equal(cleanReviewResponse.status, 200, JSON.stringify(cleanReviewBody));
    const cleanApproved = fixture.db.prepare('SELECT * FROM redraw_assets WHERE id = ?').get(cleanId);
    assert.equal(cleanApproved.status, 'needs_attention');
    assert.equal(cleanApproved.approval_status, 'approved');
    assert.equal(cleanApproved.approved_by, fixture.userId);
    assert.ok(cleanApproved.approved_at);

    const secondQuoteResponse = await post(
      fixture,
      baseUrl,
      `/redraw/versions/${fixture.versionId}/reference-preparation-quote`,
      { shot_ids: [fixture.shotId] },
    );
    const secondQuoteBody = await secondQuoteResponse.json();
    assert.equal(secondQuoteResponse.status, 200, JSON.stringify(secondQuoteBody));
    assert.equal(secondQuoteBody.data.priced, true);
    assert.equal(secondQuoteBody.data.credits, 0);
    assert.deepEqual(secondQuoteBody.data.items, []);
    assert.deepEqual(secondQuoteBody.data.needs_attention_shot_ids, []);

    const secondStartResponse = await post(
      fixture,
      baseUrl,
      `/redraw/versions/${fixture.versionId}/reference-preparations`,
      {
        shot_ids: [fixture.shotId],
        quote_hash: secondQuoteBody.data.quote_hash,
        idempotency_key: 'http-product-clean-second',
      },
    );
    const secondStartBody = await secondStartResponse.json();
    assert.equal(secondStartResponse.status, 202, JSON.stringify(secondStartBody));
    const secondTask = await waitForTask(fixture.db, secondStartBody.data.task_id, ['completed', 'failed', 'needs_attention']);
    const secondDiagnosticShot = fixture.db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(fixture.shotId);
    assert.equal(secondTask.status, 'completed', JSON.stringify({
      secondTask,
      secondDiagnosticShot,
      cleanCalls: fixture.cleanCalls.length,
    }));
    assert.equal(fixture.cleanCalls.length, 1, '第二轮必须复用 approved clean，不得重提 provider');

    const finalShot = fixture.db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(fixture.shotId);
    assert.equal(finalShot.preparation_state, 'reference_ready');
    assert.match(finalShot.reference_bundle_hash, /^[a-f0-9]{64}$/);
    const bundle = JSON.parse(finalShot.reference_bundle_json);
    assert.equal(bundle.schema_version, 'redraw-reference-bundle-v2');
    assert.equal(Number(bundle.shot_id), fixture.shotId);
    assert.equal(bundle.text_regions[0].text_clean_redraw_asset_id, cleanId);
    assert.equal(bundle.motion_reference.asset_id, fixture.motionAssetId);
    const motion = JSON.parse(fixture.db.prepare('SELECT metadata FROM assets WHERE id = ?')
      .get(fixture.motionAssetId).metadata);
    assert.equal(motion.redraw_motion_reference.shot_id, fixture.shotId);
    assert.equal(motion.redraw_motion_reference.bound_by, fixture.userId);
  });

  assert.equal(fixture.coverageCalls.length, 1);
  assert.equal(fixture.cleanCalls.length, 1);
  assert.equal(fs.existsSync(fixture.coverageCalls[0].outputDir), false);
  assert.equal(fs.existsSync(fixture.cleanCalls[0].outputDir), false);
  const afterBilling = billingSnapshot(fixture.db);
  assert.deepEqual(afterBilling, beforeBilling);
  assert.deepEqual(afterBilling, { rows: 0, reserved: 0, held: 0, charged: 0, ledger_rows: 0 });
});
