const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { runMigrationsAndEnsure } = require('../../src/db/migrate');
const tenantService = require('../../src/services/tenantService');
const { buildGeneratedCoverageManifest, canonicalCoverageSha256 } = require('../../src/services/redrawFullFrameCoverageService');
const { canonicalizeModelLock, canonicalSha256 } = require('../../src/services/redrawFullFrameModelLockService');

const NOW = '2026-09-06T00:00:00.000Z';
const OWNER = { tenantId: 'tenant-motion', userId: 'user-motion' };
const WIDTH = 64;
const HEIGHT = 96;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
let migratedDatabase;

function modelLock() {
  const projects = {
    tracker: ['ByteTrack', 'FoundationVision/ByteTrack'],
    text_detector: ['PaddleOCR', 'PaddlePaddle/PaddleOCR'],
    person_detector: ['YOLOX', 'Megvii-BaseDetection/YOLOX'],
    face_detector: ['MediaPipe face detection', 'google-ai-edge/mediapipe'],
  };
  const lock = {
    schema_version: 'redraw-full-frame-model-lock-v2',
    runtimes: Object.fromEntries(['main', 'text'].map((name) => [name, {
      python_version: 'Python 3.11.9', interpreter_path: `runtime/${name}/.venv/Scripts/python.exe`,
      pip_freeze_path: `runtime/${name}/pip-freeze.txt`, pip_freeze_sha256: '1'.repeat(64),
    }])),
    components: Object.entries(projects).map(([component, [project, repository]]) => ({
      component, project, repository, revision: `rev-${component}-20260816`,
      artifact_name: `${component}.bin`, artifact_path: `${component}/model.bin`, artifact_sha256: 'a'.repeat(64),
      license_name: `${component}-LICENSE`, license_evidence_path: `${component}/LICENSE.txt`, license_evidence_sha256: 'b'.repeat(64),
    })),
  };
  return { ...lock, canonical_sha256: canonicalSha256(canonicalizeModelLock(lock)) };
}

async function fixture(t) {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-motion-coverage-'));
  if (!migratedDatabase) {
    const template = new Database(':memory:');
    runMigrationsAndEnsure(template);
    tenantService.ensureSchema(template);
    migratedDatabase = template.serialize();
    template.close();
  }
  const db = new Database(migratedDatabase);
  t.after(() => { db.close(); fs.rmSync(storageRoot, { recursive: true, force: true }); });
  db.prepare("INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES (?, 'motion', 'motion', ?, ?)")
    .run(OWNER.tenantId, NOW, NOW);
  db.prepare("INSERT INTO tenant_members (tenant_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?)")
    .run(OWNER.tenantId, OWNER.userId, NOW, NOW);
  const sourcePath = path.join(storageRoot, 'source.mp4');
  const sourceBytes = Buffer.from('motion-coverage-source-byte-integrity-fixture');
  fs.writeFileSync(sourcePath, sourceBytes);
  const fingerprint = sha256(sourceBytes);
  const factsHash = sha256('{}');
  function asset(id, type, localPath, digest, mimeType) {
    db.prepare(`INSERT INTO assets
      (id, name, type, category, url, local_path, mime_type, metadata, created_at, updated_at)
      VALUES (?, 'motion fixture', ?, 'redraw', '', ?, ?, ?, ?, ?)`)
      .run(id, type, localPath, mimeType, JSON.stringify({ tenant_id: OWNER.tenantId, user_id: OWNER.userId, sha256: digest }), NOW, NOW);
  }
  asset(101, 'video', 'source.mp4', fingerprint, 'video/mp4');
  db.prepare(`INSERT INTO redraw_projects
    (id, tenant_id, user_id, title, created_at, updated_at) VALUES (1, ?, ?, 'motion', ?, ?)`)
    .run(OWNER.tenantId, OWNER.userId, NOW, NOW);
  db.prepare(`INSERT INTO redraw_works
    (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint, duration_ms, created_at, updated_at)
    VALUES (1, 1, ?, ?, 'motion', 101, ?, 12000, ?, ?)`)
    .run(OWNER.tenantId, OWNER.userId, fingerprint, NOW, NOW);
  db.prepare(`INSERT INTO redraw_versions
    (id, work_id, tenant_id, user_id, version, locale, source_facts_json, facts_hash, created_at, updated_at)
    VALUES (1, 1, ?, ?, 1, 'en-US', '{}', ?, ?, ?)`)
    .run(OWNER.tenantId, OWNER.userId, factsHash, NOW, NOW);
  const shots = [
    { shot_id: 'shot-1', start_ms: 0, end_ms: 250 },
    { shot_id: 'shot-2', start_ms: 250, end_ms: 1100 },
    { shot_id: 'shot-3', start_ms: 1100, end_ms: 12000 },
  ];
  for (const [index, shot] of shots.entries()) {
    db.prepare(`INSERT INTO redraw_shots
      (id, work_id, version_id, tenant_id, user_id, shot_id, batch_index, shot_index, start_ms, end_ms, duration_ms, created_at, updated_at)
      VALUES (?, 1, 1, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
      .run(index + 1, OWNER.tenantId, OWNER.userId, shot.shot_id, index + 1,
        shot.start_ms, shot.end_ms, shot.end_ms - shot.start_ms, NOW, NOW);
  }
  const evidenceRoot = path.join(storageRoot, 'coverage');
  async function png(relativePath, value, mask = false) {
    const pixels = Buffer.alloc(WIDTH * HEIGHT * (mask ? 1 : 3), mask ? 0 : value);
    if (mask) for (let y = 8; y < 24; y += 1) for (let x = 8; x < 24; x += 1) pixels[y * WIDTH + x] = 255;
    const image = sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: mask ? 1 : 3 } });
    const bytes = await (mask ? image.toColourspace('b-w') : image).png().toBuffer();
    const target = path.join(evidenceRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    return { path: relativePath, sha256: sha256(bytes), width: WIDTH, height: HEIGHT, mime_type: 'image/png' };
  }
  const timestamps = [0, 3, 12, 21, 33, 349];
  const frames = [];
  for (const [index, ticks] of timestamps.entries()) {
    const frameFile = await png(`frames/frame-${index}.png`, 20 + index);
    const timestampMs = Math.round(ticks * 1000 / 30);
    frames.push({
      frame_index: index, timestamp_ticks: ticks, timestamp_ms: timestampMs,
      shot_id: shots.find((shot) => timestampMs >= shot.start_ms && timestampMs < shot.end_ms).shot_id,
      path: frameFile.path, sha256: frameFile.sha256, width: WIDTH, height: HEIGHT,
      person_region_ids: index === 1 ? ['person-1', 'extra-1'] : [],
      text_region_ids: index === 2 ? ['text-2'] : [], review_point_reasons: [], review_status: 'not_required',
    });
  }
  const personTracks = [];
  for (const [trackKey, kind, regionId] of [['actor', 'story_role', 'person-1'], ['crowd', 'background_extra', 'extra-1']]) {
    personTracks.push({
      track_key: trackKey, kind, source_character_key: kind === 'story_role' ? 'actor-a' : null,
      target_strategy: kind === 'story_role' ? 'fixed_actor' : 'foreign_adult_extra',
      frame_ranges: [{ start_frame: 1, end_frame: 1 }], visibility: [{ start_frame: 1, end_frame: 1, state: 'visible' }],
      regions: [{ region_id: regionId, frame_index: 1, bbox: { x: 8, y: 8, width: 16, height: 16 },
        mask: await png(`masks/${regionId}.png`, 0, true), association_confidence: 1, detector_disagreement: false }],
      review_status: 'pending', reviewer: null,
    });
  }
  const textTracks = [{
    region_key: 'subtitle', kind: 'subtitle', treatment: 'translate_subtitle', target_text_key: 'subtitle-a',
    frame_ranges: [{ start_frame: 2, end_frame: 2 }], regions: [{ region_id: 'text-2', frame_index: 2,
      polygon: [{ x: 8, y: 8 }, { x: 24, y: 8 }, { x: 24, y: 24 }, { x: 8, y: 24 }],
      mask: await png('masks/text-2.png', 0, true) }], review_status: 'pending', reviewer: null,
  }];
  const manifest = await buildGeneratedCoverageManifest({
    evidenceRoot, source: { sha256: fingerprint, duration_ms: 12000, width: WIDTH, height: HEIGHT,
      frame_count: frames.length, time_base: { numerator: 1, denominator: 30 } },
    shots, frames, personTracks, textTracks, modelLock: modelLock(),
  });
  manifest.status = 'reviewed';
  for (const frame of manifest.frames) frame.review_status = frame.review_point_reasons.length ? 'reviewed' : 'not_required';
  for (const track of [...manifest.person_tracks, ...manifest.text_tracks]) {
    track.review_status = 'reviewed'; track.reviewer = 'codex-local-review';
  }
  manifest.review = { status: 'reviewed', reviewed: true,
    required_review_point_count: manifest.review.required_review_point_count,
    reviewed_point_count: manifest.review.required_review_point_count, reviewer: 'codex-local-review' };
  manifest.analysis_sha256 = canonicalCoverageSha256(manifest);
  const manifestPath = path.join(evidenceRoot, 'redraw-full-frame-reviewed-manifest.json');
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(manifestPath, manifestBytes);
  asset(102, 'document', 'coverage/redraw-full-frame-reviewed-manifest.json', sha256(manifestBytes), 'application/json');
  const sourceRef = { source_ref: { stable_id: 'full-frame-reviewed-coverage' }, snapshot: {
    mode: 'full_frame_reviewed_coverage', version_id: 1, facts_hash: factsHash,
    source_fingerprint: fingerprint, analysis_sha256: manifest.analysis_sha256,
  } };
  db.prepare(`INSERT INTO redraw_assets
    (id, version_id, tenant_id, user_id, kind, source_ref_json, asset_id, version_number,
     approval_status, approved_by, approved_at, status, created_at, updated_at)
    VALUES (201, 1, ?, ?, 'scene', ?, 102, 1, 'approved', ?, ?, 'generated', ?, ?)`)
    .run(OWNER.tenantId, OWNER.userId, JSON.stringify(sourceRef), OWNER.userId, NOW, NOW, NOW);
  return {
    db, storageRoot, sourcePath, sourceBytes, fingerprint, factsHash, evidenceRoot, manifest, manifestPath, sourceRef,
    ctx: { db, storageRoot, versionId: 1, ...OWNER }, input: { shot_id: 2, expected_updated_at: NOW },
    rewriteManifest(mutate) {
      mutate(manifest);
      manifest.analysis_sha256 = canonicalCoverageSha256(manifest);
      sourceRef.snapshot.analysis_sha256 = manifest.analysis_sha256;
      const bytes = Buffer.from(JSON.stringify(manifest));
      fs.writeFileSync(manifestPath, bytes);
      db.prepare('UPDATE assets SET metadata = ? WHERE id = 102').run(JSON.stringify({ sha256: sha256(bytes) }));
      db.prepare('UPDATE redraw_assets SET source_ref_json = ? WHERE id = 201').run(JSON.stringify(sourceRef));
    },
  };
}

function snapshot(f) {
  const files = {};
  function walk(root) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(f.storageRoot, file)] = sha256(fs.readFileSync(file));
    }
  }
  walk(f.storageRoot);
  return { db: sha256(f.db.serialize()), changes: f.db.prepare('SELECT total_changes() AS n').get().n, files };
}

module.exports = { fixture, snapshot, sha256, NOW, OWNER, WIDTH, HEIGHT };
