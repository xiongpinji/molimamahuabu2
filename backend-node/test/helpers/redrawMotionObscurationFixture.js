const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const { fixture: coverageFixture, snapshot, sha256, NOW, OWNER } = require('./redrawMotionCoverageFixture');
const { getFfmpegPath, getFfprobePath } = require('../../src/utils/ffmpegPath');
const { buildGeneratedCoverageManifest, canonicalCoverageSha256 } = require('../../src/services/redrawFullFrameCoverageService');

function run(binary, args, options = {}) {
  return execFileSync(binary, args, { windowsHide: true, shell: false, timeout: 30000,
    maxBuffer: 32 * 1024 * 1024, ...options });
}

function probe(file) {
  const result = {};
  for (const section of ['streams', 'frames', 'packets']) {
    Object.assign(result, JSON.parse(run(getFfprobePath(), ['-v', 'error', `-show_${section}`,
      ...(section === 'streams' ? ['-show_format', '-count_frames', '-count_packets'] : []), '-of', 'json', file],
    { encoding: 'utf8' })));
  }
  return result;
}

function encodeFrames(files, boundaries, timescale, sar, output, pixelFormat = 'yuv420p') {
  const concat = `${output}.ffconcat`;
  const microseconds = boundaries.map((value) => Math.round(value * 1000000 / timescale));
  fs.writeFileSync(concat, ['ffconcat version 1.0', ...files.flatMap((file, i) => [
    `file '${file.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`, `option framerate ${timescale}`,
    `duration ${((microseconds[i + 1] - microseconds[i]) / 1000000).toFixed(6)}`,
  ])].join('\n'));
  run(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concat,
    '-map', '0:v:0', '-an', '-vf', `setsar=${sar.replace(':', '/')}`, '-c:v', 'libx264', '-preset', 'ultrafast',
    '-crf', '18', '-pix_fmt', pixelFormat, '-bf', '0', '-fps_mode', 'passthrough', '-enc_time_base', `1/${timescale}`,
    '-video_track_timescale', String(timescale), '-bsf:v',
    `setts=duration='if(eq(N,${files.length - 1}),${boundaries.at(-1) - boundaries.at(-2)},DURATION)':time_base=1/${timescale}`, output]);
}

function decodeRgb(file, width, height) {
  const bytes = run(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-noautorotate', '-i', file,
    '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const frameSize = width * height * 3;
  if (bytes.length % frameSize !== 0) throw new Error('Incomplete decoded frame');
  return Array.from({ length: bytes.length / frameSize }, (_, i) => bytes.subarray(i * frameSize, (i + 1) * frameSize));
}

async function fixture(t, { width = 96, height = 64, sar = '4:3', timescale = 30000, cuts = false, audio = false, rotation = 0,
  sourceDurationMs = 12000 } = {}) {
  const f = await coverageFixture(t);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-obscuration-private-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const mediaRoot = path.join(f.storageRoot, 'synthetic-media');
  fs.mkdirSync(mediaRoot);
  const boundaries = [0, Math.round(timescale * 0.15) + 1, Math.round(timescale * 0.45) + 1,
    Math.round(timescale * 0.85) + (cuts ? 0 : 2), timescale * sourceDurationMs / 1000];
  const inputs = [];
  for (let frame = 0; frame < 4; frame += 1) {
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const moved = (x + frame * 7) % width;
      const i = (y * width + x) * 3;
      pixels[i] = 35 + ((Math.floor(moved / 3) + Math.floor(y / 3)) % 2) * 190;
      pixels[i + 1] = 25 + ((moved * 5 + y * 3) % 200);
      pixels[i + 2] = 20 + ((x * 3 + frame * 43 + y * 7) % 210);
    }
    const file = path.join(mediaRoot, `synthetic-${frame}.png`);
    await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toFile(file);
    inputs.push(file);
  }
  encodeFrames(inputs, boundaries, timescale, sar, f.sourcePath, width % 2 || height % 2 ? 'yuv444p' : 'yuv420p');
  if (audio || rotation) {
    const muxed = path.join(mediaRoot, 'muxed.mp4');
    run(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...(rotation ? ['-display_rotation:v:0', String(rotation)] : []), '-i', f.sourcePath,
      ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=16000:duration=12', '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac'] : []),
      '-c:v', 'copy', '-video_track_timescale', String(timescale), muxed]);
    fs.copyFileSync(muxed, f.sourcePath);
  }
  const sourceProbe = probe(f.sourcePath);
  const stream = sourceProbe.streams.find((item) => item.codec_type === 'video');
  if (rotation && !stream.side_data_list?.some((item) => Number(item.rotation) === rotation)) throw new Error('Synthetic rotation was not written');
  const [numerator, denominator] = stream.time_base.split('/').map(Number);
  const sourceBytes = fs.readFileSync(f.sourcePath);
  const fingerprint = sha256(sourceBytes);
  f.db.prepare(`UPDATE assets SET category = 'redraw_source', width = ?, height = ?, duration = 12,
    file_size = ?, metadata = ? WHERE id = 101`).run(width, height, sourceBytes.length,
    JSON.stringify({ tenant_id: OWNER.tenantId, user_id: OWNER.userId, sha256: fingerprint }));
  f.db.prepare('UPDATE redraw_works SET source_fingerprint = ?, duration_ms = 12000 WHERE id = 1').run(fingerprint);
  const shots = cuts ? [{ shot_id: 'shot-1', start_ms: 0, end_ms: 250 },
    { shot_id: 'shot-2', start_ms: 250, end_ms: 850 }, { shot_id: 'shot-3', start_ms: 850, end_ms: 12000 }]
    : [{ shot_id: 'shot-1', start_ms: 0, end_ms: 12000 }];
  f.db.prepare('DELETE FROM redraw_shots').run();
  for (const [i, shot] of shots.entries()) f.db.prepare(`INSERT INTO redraw_shots
    (id, work_id, version_id, tenant_id, user_id, shot_id, batch_index, shot_index, start_ms, end_ms,
     duration_ms, created_at, updated_at) VALUES (?, 1, 1, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
    .run(i + 1, OWNER.tenantId, OWNER.userId, shot.shot_id, i + 1, shot.start_ms, shot.end_ms,
      shot.end_ms - shot.start_ms, NOW, NOW);
  const decoded = decodeRgb(f.sourcePath, width, height);
  const sourceVideoFrames = sourceProbe.frames.filter((frame) => frame.media_type === 'video');
  if (decoded.length !== 4 || sourceVideoFrames.length !== 4) throw new Error('Source fixture lost frames');
  const frames = [];
  for (const [i, pixels] of decoded.entries()) {
    const relative = `frames/real-${i}.png`;
    const bytes = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
    fs.writeFileSync(path.join(f.evidenceRoot, relative), bytes);
    const ticks = Number(sourceVideoFrames[i].best_effort_timestamp);
    const timestampMs = Math.round(ticks * numerator * 1000 / denominator);
    frames.push({ frame_index: i, timestamp_ticks: ticks, timestamp_ms: timestampMs,
      shot_id: shots.find((shot) => timestampMs >= shot.start_ms && timestampMs < shot.end_ms).shot_id,
      path: relative, sha256: sha256(bytes), width, height,
      person_region_ids: i === 1 ? ['actor-1', 'extra-1'] : [], text_region_ids: i === 1 || i === 2 ? [`text-${i}`] : [],
      review_point_reasons: [], review_status: 'not_required' });
  }
  const boxes = { actor: { x: 4, y: 4, width: 16, height: 16 }, extra: { x: 24, y: 4, width: 16, height: 16 },
    text: { x: 4, y: 28, width: 32, height: 12 } };
  const masks = {};
  async function mask(name, box) {
    const pixels = Buffer.alloc(width * height);
    for (let y = box.y; y < box.y + box.height; y += 1) for (let x = box.x; x < box.x + box.width; x += 1) pixels[y * width + x] = 255;
    const bytes = await sharp(pixels, { raw: { width, height, channels: 1 } }).toColourspace('b-w').png().toBuffer();
    const relative = `masks/real-${name}.png`;
    fs.writeFileSync(path.join(f.evidenceRoot, relative), bytes);
    masks[name] = pixels;
    return { path: relative, sha256: sha256(bytes), width, height, mime_type: 'image/png' };
  }
  const personTracks = [];
  for (const [name, kind] of [['actor', 'story_role'], ['extra', 'background_extra']]) personTracks.push({
    track_key: name, kind, source_character_key: name === 'actor' ? 'actor-a' : null,
    target_strategy: name === 'actor' ? 'fixed_actor' : 'foreign_adult_extra',
    frame_ranges: [{ start_frame: 1, end_frame: 1 }], visibility: [{ start_frame: 1, end_frame: 1, state: 'visible' }],
    regions: [{ region_id: `${name}-1`, frame_index: 1, bbox: boxes[name], mask: await mask(name, boxes[name]),
      association_confidence: 1, detector_disagreement: false }], review_status: 'pending', reviewer: null,
  });
  const textRegions = [];
  for (const i of [1, 2]) textRegions.push({ region_id: `text-${i}`, frame_index: i,
    polygon: [{ x: 4, y: 28 }, { x: 36, y: 28 }, { x: 36, y: 40 }, { x: 4, y: 40 }], mask: await mask(`text-${i}`, boxes.text) });
  const models = f.manifest.models;
  const manifest = await buildGeneratedCoverageManifest({ evidenceRoot: f.evidenceRoot,
    source: { sha256: fingerprint, duration_ms: 12000, width, height, frame_count: 4, time_base: { numerator, denominator } },
    shots, frames, personTracks, textTracks: [{ region_key: 'subtitle', kind: 'subtitle', treatment: 'translate_subtitle',
      target_text_key: 'subtitle-a', frame_ranges: [{ start_frame: 1, end_frame: 2 }], regions: textRegions,
      review_status: 'pending', reviewer: null }], modelLock: { schema_version: 'redraw-full-frame-model-lock-v2',
      runtimes: models.runtimes, components: models.components, canonical_sha256: models.model_lock_sha256 } });
  manifest.status = 'reviewed';
  for (const frame of manifest.frames) frame.review_status = frame.review_point_reasons.length ? 'reviewed' : 'not_required';
  for (const track of [...manifest.person_tracks, ...manifest.text_tracks]) { track.review_status = 'reviewed'; track.reviewer = 'codex-local-review'; }
  manifest.review = { status: 'reviewed', reviewed: true, required_review_point_count: manifest.review.required_review_point_count,
    reviewed_point_count: manifest.review.required_review_point_count, reviewer: 'codex-local-review' };
  manifest.analysis_sha256 = canonicalCoverageSha256(manifest);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(f.manifestPath, manifestBytes);
  const sourceRef = { ...f.sourceRef, snapshot: { ...f.sourceRef.snapshot, source_fingerprint: fingerprint,
    analysis_sha256: manifest.analysis_sha256 } };
  f.db.prepare('UPDATE assets SET metadata = ? WHERE id = 102').run(JSON.stringify({ sha256: sha256(manifestBytes) }));
  f.db.prepare('UPDATE redraw_assets SET source_ref_json = ? WHERE id = 201').run(JSON.stringify(sourceRef));
  return { ...f, sourceBytes, fingerprint, manifest, sourceRef, sourceProbe, decoded, boxes, masks,
    width, height, sar, timescale: denominator, tempRoot, mediaRoot,
    ctx: { ...f.ctx, tempRoot }, input: { shot_id: cuts ? 2 : 1, expected_updated_at: NOW },
    rewriteManifest(mutate) {
      mutate(manifest); manifest.analysis_sha256 = canonicalCoverageSha256(manifest);
      sourceRef.snapshot.analysis_sha256 = manifest.analysis_sha256;
      const bytes = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(f.manifestPath, bytes);
      f.db.prepare('UPDATE assets SET metadata = ? WHERE id = 102').run(JSON.stringify({ sha256: sha256(bytes) }));
      f.db.prepare('UPDATE redraw_assets SET source_ref_json = ? WHERE id = 201').run(JSON.stringify(sourceRef));
    } };
}

module.exports = { fixture, snapshot, sha256, probe, encodeFrames, decodeRgb, NOW, OWNER };
