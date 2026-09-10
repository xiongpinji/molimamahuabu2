const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, sha256 } = require('./redrawMotionObscurationFixture');
const { buildGeneratedCoverageManifest, canonicalCoverageSha256 } = require('../../src/services/redrawFullFrameCoverageService');
const { withMotionObscuration } = require('../../src/services/redrawMotionObscurationService');
const { importMotionReferenceArtifact } = require('../../src/services/redrawReferenceArtifactImportService');

// Keep the original preparation fixture and its real quote/claim/persist/bind flow intact.
// The processing variant has real moving frames and one reviewed text track; person/extra coverage is exercised by the HTTP fixture.
async function processingPreparationFixture(t, originalFixture) {
  const state = await originalFixture(t);
  const media = await fixture(t, { width: 64, height: 64, sar: '1:1' });
  const root = state.ctx.storageRoot;
  const evidenceRoot = path.join(root, 'redraw-full-frame/version-1');
  fs.copyFileSync(media.sourcePath, path.join(root, 'source/source.mp4'));
  const frames = media.manifest.frames.map((frame) => ({ ...frame, person_region_ids: [],
    review_point_reasons: [], review_status: 'not_required' }));
  for (const frame of frames) fs.copyFileSync(path.join(media.evidenceRoot, frame.path), path.join(evidenceRoot, frame.path));
  const textTracks = structuredClone(media.manifest.text_tracks);
  for (const track of textTracks) {
    track.region_key = 'subtitle-a';
    track.review_status = 'pending';
    track.reviewer = null;
    for (const region of track.regions) fs.copyFileSync(path.join(media.evidenceRoot, region.mask.path), path.join(evidenceRoot, region.mask.path));
  }
  const models = media.manifest.models;
  const evidenceFiles = [...frames, ...textTracks.flatMap((track) => track.regions.map((region) => region.mask))];
  for (const file of evidenceFiles) state.db.prepare(`INSERT INTO assets
    (name, type, category, url, local_path, mime_type, width, height, metadata)
    VALUES ('processing evidence', 'image', 'redraw', '', ?, 'image/png', 64, 64, ?)`)
    .run(`redraw-full-frame/version-1/${file.path}`, JSON.stringify({ sha256: file.sha256,
      tenant_id: state.ctx.tenantId, user_id: state.ctx.userId }));
  const manifest = await buildGeneratedCoverageManifest({ evidenceRoot,
    source: media.manifest.source, shots: [{ shot_id: 'shot-1', start_ms: 0, end_ms: 12000 }], frames,
    personTracks: [], textTracks, modelLock: { schema_version: 'redraw-full-frame-model-lock-v2',
      runtimes: models.runtimes, components: models.components, canonical_sha256: models.model_lock_sha256 } });
  manifest.status = 'reviewed';
  for (const frame of manifest.frames) frame.review_status = frame.review_point_reasons.length ? 'reviewed' : 'not_required';
  for (const track of manifest.text_tracks) { track.review_status = 'reviewed'; track.reviewer = 'codex-local-review'; }
  manifest.review = { status: 'reviewed', reviewed: true, required_review_point_count: manifest.review.required_review_point_count,
    reviewed_point_count: manifest.review.required_review_point_count, reviewer: 'codex-local-review' };
  state.db.prepare('UPDATE redraw_works SET source_fingerprint = ? WHERE id = 1').run(media.fingerprint);
  state.db.prepare("UPDATE assets SET category = 'redraw_source', width = 64, height = 64, file_size = ?, duration = 12, metadata = ? WHERE id = 101")
    .run(media.sourceBytes.length, JSON.stringify({ tenant_id: state.ctx.tenantId, user_id: state.ctx.userId, sha256: media.fingerprint }));
  function writeManifest() {
    manifest.analysis_sha256 = canonicalCoverageSha256(manifest);
    const bytes = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(path.join(evidenceRoot, 'redraw-full-frame-reviewed-manifest.json'), bytes);
    state.db.prepare('UPDATE assets SET metadata = ? WHERE id = 701').run(JSON.stringify({ sha256: sha256(bytes) }));
    const sourceRef = JSON.parse(state.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = 204').get().source_ref_json);
    sourceRef.snapshot.source_fingerprint = media.fingerprint;
    sourceRef.snapshot.analysis_sha256 = manifest.analysis_sha256;
    state.db.prepare('UPDATE redraw_assets SET source_ref_json = ? WHERE id = 204').run(JSON.stringify(sourceRef));
  }
  writeManifest();
  state.ctx.tempRoot = media.tempRoot;
  const result = await withMotionObscuration(state.ctx, { shot_id: 1, expected_updated_at: state.shot().updated_at }, async (value) => {
    const chunks = [];
    for await (const chunk of value.createReadStream()) chunks.push(chunk);
    const video = Buffer.concat(chunks);
    assert.equal(sha256(video), value.sha256);
    return { report: value.report, video };
  });
  const imported = await importMotionReferenceArtifact(state.ctx, { shotId: 1,
    expectedUpdatedAt: state.shot().updated_at, idempotencyKey: 'processing-prepare-a',
    fullFrameReviewed: true, sourceIdentityObscured: true, sourceTextObscured: true, motionPreserved: true,
    processingReport: JSON.stringify(result.report),
    file: { originalname: 'processing-a.mp4', mimetype: 'video/mp4', size: result.video.length, buffer: result.video } });
  return { ...state, result, imported, manifest, evidenceRoot, writeManifest,
    get providerCalls() { return state.providerCalls; },
    get reservationCount() { return state.reservationCount; },
    attachment: () => JSON.parse(state.db.prepare('SELECT metadata FROM assets WHERE id = ?').get(imported.asset.id).metadata).redraw_motion_processing };
}

module.exports = { processingPreparationFixture };
