'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { execFileSync } = require('node:child_process');
const { fixture: unitFixture, hash } = require('./redrawUnitReferenceFixture');
const { fixture: mediaFixture, encodeFrames, decodeRgb, probe } = require('./redrawMotionObscurationFixture');
const { getFfmpegPath } = require('../../src/utils/ffmpegPath');
const { buildGeneratedCoverageManifest, canonicalCoverageSha256 } = require('../../src/services/redrawFullFrameCoverageService');
const { withMotionObscuration } = require('../../src/services/redrawMotionObscurationService');
const { importMotionReferenceArtifact, bindReadyMotionReference } = require('../../src/services/redrawReferenceArtifactImportService');
const { inspectUnitReferenceMaterials } = require('../../src/services/redrawUnitReferenceService');

// Actual synthetic VFR source, decoded coverage, processor, import and binding. No renderer/human attestation.
async function fixture(t, { boundariesMs = [0, 4500, 7000, 10000, 12000],
  parentRanges = [[0, 12000]], durations = [5], timescale = 12800, reports = true,
  beforeBlueprint, beforeReview, createActor } = {}) {
  const media = await mediaFixture(t);
  return unitFixture(t, { durations, createActor, beforeBlueprint: async (h, raw) => {
    h.ctx.log = {};
    const silent = path.join(media.mediaRoot, 'derivation-silent.mp4');
    const sourcePath = path.join(h.root, 'source/source.mp4');
    encodeFrames(boundariesMs.slice(0, -1).map((_, index) => path.join(media.mediaRoot, `synthetic-${index % 4}.png`)),
      boundariesMs.map(value => value * timescale / 1000), timescale, '4:3', silent);
    execFileSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', silent,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12', '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-ac', '1', '-video_track_timescale', String(timescale), sourcePath],
    { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    h.sourceFingerprint = hash(fs.readFileSync(sourcePath));
    const sourceProbe = probe(sourcePath);
    const stream = sourceProbe.streams.find(value => value.codec_type === 'video');
    const [numerator, denominator] = stream.time_base.split('/').map(Number);
    h.db.prepare('UPDATE redraw_works SET source_fingerprint = ? WHERE id = 1').run(h.sourceFingerprint);
    h.db.prepare('UPDATE assets SET width = 96, height = 64, file_size = ?, metadata = ? WHERE id = 101')
      .run(fs.statSync(sourcePath).size, JSON.stringify({ tenant_id: h.ctx.tenantId, user_id: h.ctx.userId, sha256: h.sourceFingerprint }));
    Object.assign(raw.source, { sha256: h.sourceFingerprint, width: 96, height: 64 });
    const first = raw.shots[0];
    raw.shots = parentRanges.map(([start, end], index) => ({ ...structuredClone(first), id: `shot-${index + 1}`,
      index: index + 1, start_ms: start, end_ms: end, visible_character_ids: [], dialogue: [], text_regions: [] }));
    h.db.prepare('DELETE FROM redraw_reference_artifact_imports').run();
    h.db.prepare('DELETE FROM redraw_shots').run();
    for (const shot of raw.shots) h.db.prepare(`INSERT INTO redraw_shots
      (id, work_id, version_id, tenant_id, user_id, shot_id, batch_index, shot_index, start_ms, end_ms,
       duration_ms, source_dialogue_json, localized_dialogue_json, preparation_snapshot_json, created_at, updated_at)
      VALUES (?, 1, ?, ?, ?, ?, 1, ?, ?, ?, ?, '[]', '[]', '{"clean_results":[]}', 'fixture', 'fixture')`)
      .run(shot.index, h.versionId, h.ctx.tenantId, h.ctx.userId, shot.id, shot.index, shot.start_ms, shot.end_ms, shot.end_ms - shot.start_ms);
    const evidenceRoot = path.join(h.root, 'coverage/version-1');
    const videoFrames = sourceProbe.frames.filter(frame => frame.media_type === 'video');
    const frames = [];
    for (const [index, pixels] of decodeRgb(sourcePath, 96, 64).entries()) {
      const relative = `frames/derivation-${index}.png`;
      const bytes = await sharp(pixels, { raw: { width: 96, height: 64, channels: 3 } }).png().toBuffer();
      fs.writeFileSync(path.join(evidenceRoot, relative), bytes, { flag: 'wx' });
      const ticks = Number(videoFrames[index].best_effort_timestamp);
      const ms = Math.round(ticks * numerator * 1000 / denominator);
      frames.push({ frame_index: index, timestamp_ticks: ticks, timestamp_ms: ms,
        shot_id: raw.shots.find(shot => shot.start_ms <= ms && shot.end_ms > ms).id,
        path: relative, sha256: hash(bytes), width: 96, height: 64, person_region_ids: [], text_region_ids: [],
        review_point_reasons: [], review_status: 'not_required' });
      h.db.prepare(`INSERT INTO assets (id, type, category, local_path, mime_type, width, height, metadata)
        VALUES (?, 'image', 'redraw', ?, 'image/png', 96, 64, ?)`)
        .run(1000 + index, `coverage/version-1/${relative}`, JSON.stringify({ sha256: hash(bytes) }));
    }
    const models = media.manifest.models;
    const manifest = await buildGeneratedCoverageManifest({ evidenceRoot,
      source: { sha256: h.sourceFingerprint, duration_ms: 12000, width: 96, height: 64,
        frame_count: frames.length, time_base: { numerator, denominator } },
      shots: raw.shots.map(shot => ({ shot_id: shot.id, start_ms: shot.start_ms, end_ms: shot.end_ms })),
      frames, personTracks: [], textTracks: [], modelLock: { schema_version: 'redraw-full-frame-model-lock-v2',
        runtimes: models.runtimes, components: models.components, canonical_sha256: models.model_lock_sha256 } });
    manifest.status = 'reviewed';
    for (const frame of manifest.frames) frame.review_status = frame.review_point_reasons.length ? 'reviewed' : 'not_required';
    manifest.review = { status: 'reviewed', reviewed: true, required_review_point_count: manifest.review.required_review_point_count,
      reviewed_point_count: manifest.review.required_review_point_count, reviewer: 'codex-local-review' };
    manifest.analysis_sha256 = canonicalCoverageSha256(manifest);
    const manifestPath = path.join(evidenceRoot, 'redraw-full-frame-reviewed-manifest.json');
    const bytes = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(manifestPath, bytes);
    h.db.prepare('UPDATE assets SET metadata = ? WHERE id = 406').run(JSON.stringify({ sha256: hash(bytes) }));
    const sourceRef = JSON.parse(h.db.prepare('SELECT source_ref_json FROM redraw_assets WHERE id = 205').get().source_ref_json);
    Object.assign(sourceRef.snapshot, { source_fingerprint: h.sourceFingerprint, analysis_sha256: manifest.analysis_sha256 });
    h.db.prepare('UPDATE redraw_assets SET source_ref_json = ? WHERE id = 205').run(JSON.stringify(sourceRef));
    h.processed = [];
    for (const shot of h.db.prepare('SELECT * FROM redraw_shots ORDER BY shot_index').all()) {
      const processed = await withMotionObscuration(h.ctx, { shot_id: shot.id, expected_updated_at: shot.updated_at }, async value => {
        const chunks = []; for await (const chunk of value.createReadStream()) chunks.push(chunk);
        const video = Buffer.concat(chunks); assert.equal(hash(video), value.sha256);
        return { report: value.report, video };
      });
      const imported = await importMotionReferenceArtifact(h.ctx, { shotId: shot.id, expectedUpdatedAt: shot.updated_at,
        idempotencyKey: `unit-derivation-parent-${shot.id}`, fullFrameReviewed: true, sourceIdentityObscured: true,
        sourceTextObscured: true, motionPreserved: true, ...(reports ? { processingReport: JSON.stringify(processed.report) } : {}),
        file: { originalname: 'processed-parent.mp4', mimetype: 'video/mp4', size: processed.video.length, buffer: processed.video } });
      await bindReadyMotionReference(h.ctx, { shot_id: shot.id, clean_results: [] });
      h.processed.push({ ...processed, imported, shotId: shot.id });
    }
    h.manifest = manifest; h.manifestPath = manifestPath;
    h.materials = index => inspectUnitReferenceMaterials(h.ctx, h.expected(index));
    if (beforeBlueprint) await beforeBlueprint(h, raw);
  }, beforeReview });
}
module.exports = { fixture, hash, probe, decodeRgb };
