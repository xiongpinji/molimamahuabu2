'use strict';

const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { getFfprobePath } = require('../utils/ffmpegPath');
const { loadReviewedMotionCoverage } = require('./redrawReferenceBundleService');
const { withSourceVideoSnapshot } = require('./redrawSourceVideoService');

const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const CONTENT_TYPE = 'application/vnd.moli.redraw-motion-processing.v1';
const failure = (kind = 'INVALID') => Object.assign(new Error(`REDRAW_MOTION_PROCESSING_${kind}`),
  { code: `REDRAW_MOTION_PROCESSING_${kind}` });
const stable = (value) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (ok, kind) => { if (!ok) throw failure(kind); };
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value) => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const equal = (a, b) => stable(a) === stable(b);
const processing = { method: 'conservative_mask_union_gaussian_detail_reduction', sigma_px: 12,
  mask_scope: 'all_story_role_background_extra_and_text', empty_region_behavior: 'unchanged_rgb',
  codec: 'h264', pixel_format: 'yuv420p', preset: 'ultrafast', crf: 18, b_frames: 0, audio: false };
const rounding = 'absolute source boundaries rounded to nearest microsecond before differencing; at most one microsecond or one output tick';

function keys(value, names) {
  check(value && Object.getPrototypeOf(value) === Object.prototype
    && equal(Object.keys(value).sort(), names.split(' ').sort()));
}

function timeBase(value) {
  keys(value, 'numerator denominator');
  check(integer(value.numerator, 1) && integer(value.denominator, 1));
}

function interval(value) {
  keys(value, 'start end');
  for (const point of [value.start, value.end]) {
    keys(point, 'ticks time_base');
    check(integer(point.ticks));
    timeBase(point.time_base);
  }
}

// Every nested field is allowlisted. Pixel hashes remain client claims, never renderer attestation.
function validateReport(report) {
  keys(report, 'schema_version approval_status owner work_id version_id shot_id source_shot_id shot facts_hash source_asset_id source_fingerprint source_size coverage input_binding_sha256 input_frame_mask_set_sha256 processing source_probe timing frames output_probe output quality_review');
  check(report.schema_version === 'redraw-motion-obscuration-report-v1' && report.approval_status === 'pending'
    && report.quality_review === 'pending_human_review; lossy_encoding_is_not_pixel_identity_or_background_approval');
  keys(report.owner, 'tenant_id user_id');
  check(text(report.owner.tenant_id) && text(report.owner.user_id) && text(report.source_shot_id));
  check(['work_id', 'version_id', 'shot_id', 'source_asset_id', 'source_size'].every((key) => integer(report[key], 1)));
  check(['facts_hash', 'source_fingerprint', 'input_binding_sha256', 'input_frame_mask_set_sha256'].every((key) => hash(report[key])));
  keys(report.shot, 'expected_updated_at start_ms end_ms');
  check(text(report.shot.expected_updated_at) && integer(report.shot.start_ms) && integer(report.shot.end_ms, report.shot.start_ms + 1));
  keys(report.coverage, 'analysis_sha256 file_sha256 approved_by approved_at');
  check(hash(report.coverage.analysis_sha256) && hash(report.coverage.file_sha256)
    && text(report.coverage.approved_by) && text(report.coverage.approved_at));
  check(equal(report.processing, processing));
  const source = report.source_probe;
  keys(source, 'origin width height sample_aspect_ratio display_aspect_ratio rotation time_base duration_ticks duration_ms duration_tolerance_ms');
  check(source.origin === 'sha256_bound_private_source_snapshot' && integer(source.width, 1) && integer(source.height, 1)
    && source.width % 2 === 0 && source.height % 2 === 0 && source.rotation === 0
    && /^[1-9]\d*:[1-9]\d*$/.test(source.sample_aspect_ratio) && /^[1-9]\d*:[1-9]\d*$/.test(source.display_aspect_ratio)
    && integer(source.duration_ticks, 1) && Number.isFinite(source.duration_ms) && source.duration_ms > 0
    && source.duration_tolerance_ms === 1);
  timeBase(source.time_base);
  const timing = report.timing;
  keys(timing, 'timescale frames duration tolerance_ticks rounding');
  check(integer(timing.timescale, 1) && timing.timescale <= 2147483647 && integer(timing.duration, 1)
    && timing.tolerance_ticks === Math.max(1, Math.ceil(timing.timescale / 1000000)) && timing.rounding === rounding);
  check(Array.isArray(report.frames) && report.frames.length > 0 && Array.isArray(timing.frames)
    && timing.frames.length === report.frames.length);
  for (const frame of report.frames) {
    keys(frame, 'frame_index timestamp_ticks clip_interval source_frame_sha256 masks union_mask_sha256 union_white_pixels processed_png_sha256 unmasked_rgb_changed_samples');
    check(integer(frame.frame_index) && integer(frame.timestamp_ticks) && hash(frame.source_frame_sha256)
      && hash(frame.union_mask_sha256) && hash(frame.processed_png_sha256) && integer(frame.union_white_pixels)
      && frame.union_white_pixels <= source.width * source.height && frame.unmasked_rgb_changed_samples === 0
      && Array.isArray(frame.masks));
    interval(frame.clip_interval);
    for (const mask of frame.masks) {
      keys(mask, 'region_id kind sha256');
      check(text(mask.region_id) && text(mask.kind) && hash(mask.sha256));
    }
  }
  for (const frame of timing.frames) {
    keys(frame, 'frame_index pts duration concat_start_us concat_duration_us');
    check(integer(frame.frame_index) && integer(frame.pts) && integer(frame.duration, 1)
      && integer(frame.concat_start_us) && integer(frame.concat_duration_us, 1));
  }
  const output = report.output_probe;
  keys(output, 'codec pixel_format time_base frame_count packet_count start_pts duration_ticks frames packets');
  check(output.codec === 'h264' && output.pixel_format === 'yuv420p' && output.time_base === `1/${timing.timescale}`
    && output.frame_count === report.frames.length && output.packet_count === report.frames.length && output.start_pts === 0
    && integer(output.duration_ticks, 1));
  for (const section of [output.frames, output.packets]) {
    check(Array.isArray(section) && section.length === report.frames.length);
    for (const frame of section) { keys(frame, 'pts duration'); check(integer(frame.pts) && integer(frame.duration, 1)); }
  }
  keys(report.output, 'mime size sha256');
  check(report.output.mime === 'video/mp4' && integer(report.output.size, 1) && hash(report.output.sha256));
  check(report.output.size <= MAX_VIDEO_BYTES, 'TOO_LARGE');
  return report;
}

function parseProcessingReport(raw) {
  if (raw === undefined) return null;
  check(typeof raw === 'string');
  check(Buffer.byteLength(raw, 'utf8') <= MAX_REPORT_BYTES, 'TOO_LARGE');
  let report;
  try { report = JSON.parse(raw); } catch (_) { throw failure(); }
  validateReport(report);
  return { report, report_sha256: sha256(stable(report)) };
}

async function currentReportBinding(ctx, input) {
  let coverage;
  try { coverage = await loadReviewedMotionCoverage(ctx, input); }
  catch (error) {
    if (error?.code?.startsWith('REDRAW_REFERENCE_BUNDLE_')) throw failure('CONFLICT');
    throw error;
  }
  const material = structuredClone(coverage);
  delete material.shot.expected_updated_at;
  const frames = coverage.frames.map((frame) => ({ frame_index: frame.frame_index,
    source_frame_sha256: frame.sha256, masks: [...frame.person_regions, ...frame.text_regions]
      .map((region) => ({ region_id: region.region_id, kind: region.kind, sha256: region.mask.sha256 })) }));
  return { coverage, input_binding_sha256: sha256(stable(coverage)),
    material_binding_sha256: sha256(stable(material)), input_frame_mask_set_sha256: sha256(stable(frames)), frames };
}

function assertReportBinding(report, binding) {
  const trusted = binding.coverage;
  for (const key of ['owner', 'work_id', 'version_id', 'shot_id', 'source_shot_id', 'shot', 'facts_hash',
    'source_asset_id', 'source_fingerprint', 'coverage']) check(equal(report[key], trusted[key]), 'CONFLICT');
  check(report.input_binding_sha256 === binding.input_binding_sha256
    && report.input_frame_mask_set_sha256 === binding.input_frame_mask_set_sha256, 'CONFLICT');
  check(equal(report.frames.map((frame) => ({ frame_index: frame.frame_index,
    source_frame_sha256: frame.source_frame_sha256, masks: frame.masks })), binding.frames), 'CONFLICT');
  check(report.source_probe.width === trusted.source.width && report.source_probe.height === trusted.source.height
    && equal(report.source_probe.time_base, trusted.source.time_base), 'CONFLICT');
  const scale = BigInt(report.timing.timescale);
  const ticks = (point) => {
    const numerator = BigInt(point.ticks) * BigInt(point.time_base.numerator) * scale;
    check(numerator % BigInt(point.time_base.denominator) === 0n, 'CONFLICT');
    return numerator / BigInt(point.time_base.denominator);
  };
  const round = (point) => (point * 1000000n + scale / 2n) / scale;
  const origin = ticks(trusted.frames[0].clip_interval.start);
  for (const [index, frame] of trusted.frames.entries()) {
    const actual = report.frames[index];
    check(actual.timestamp_ticks === frame.timestamp_ticks && equal(actual.clip_interval, frame.clip_interval), 'CONFLICT');
    const start = ticks(frame.clip_interval.start), end = ticks(frame.clip_interval.end);
    check(equal(report.timing.frames[index], { frame_index: frame.frame_index, pts: Number(start - origin),
      duration: Number(end - start), concat_start_us: Number(round(start) - round(origin)),
      concat_duration_us: Number(round(end) - round(start)) }), 'CONFLICT');
  }
  check(report.timing.duration === Number(ticks(trusted.frames.at(-1).clip_interval.end) - origin), 'CONFLICT');
}

async function verifyProcessingReport(ctx, input, parsed, media) {
  if (!parsed) return null;
  const binding = await currentReportBinding(ctx, input);
  assertReportBinding(parsed.report, binding);
  check(parsed.report.output.sha256 === media.fileSha256 && parsed.report.output.size === media.fileSize, 'CONFLICT');
  const trusted = binding.coverage;
  await withSourceVideoSnapshot(ctx, { tenantId: ctx.tenantId, userId: ctx.userId, workId: trusted.work_id,
    expectedSourceAssetId: trusted.source_asset_id, expectedSourceSha256: trusted.source_fingerprint }, async (source) => {
    check(source.size === parsed.report.source_size, 'CONFLICT');
    const { stdout } = await promisify(execFile)(getFfprobePath(), ['-v', 'error', '-show_streams', '-of', 'json', source.path],
      { windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024, signal: ctx.signal });
    const videos = JSON.parse(stdout).streams?.filter((stream) => stream.codec_type === 'video');
    const actual = videos?.[0], expected = parsed.report.source_probe;
    check(videos?.length === 1 && actual.width === expected.width && actual.height === expected.height
      && actual.time_base === `${expected.time_base.numerator}/${expected.time_base.denominator}`
      && actual.sample_aspect_ratio === expected.sample_aspect_ratio && actual.display_aspect_ratio === expected.display_aspect_ratio
      && Number(actual.duration_ts) === expected.duration_ticks
      && Number(actual.duration_ts) * expected.time_base.numerator * 1000 / expected.time_base.denominator === expected.duration_ms
      && Number(actual.start_pts) === 0
      && [actual.tags?.rotate, ...(actual.side_data_list || []).map((entry) => entry.rotation)]
        .filter((entry) => entry !== undefined).every((entry) => Number(entry) === 0), 'CONFLICT');
    source.assertCurrentBinding();
  });
  // Source snapshot cleanup is asynchronous. Finish with the trusted reader, not a new raw pathname read.
  check((await currentReportBinding(ctx, input)).input_binding_sha256 === binding.input_binding_sha256, 'CONFLICT');
  return { provenance: 'client_returned_unattested', report: parsed.report, report_sha256: parsed.report_sha256,
    verified: { input_binding_sha256: binding.input_binding_sha256, material_binding_sha256: binding.material_binding_sha256,
      input_frame_mask_set_sha256: binding.input_frame_mask_set_sha256, output_sha256: media.fileSha256,
      output_size: media.fileSize, pixel_claims_verified: false, renderer_origin_verified: false } };
}

async function verifyProcessingUpload(filePath, attachment) {
  if (!attachment) return;
  const report = attachment.report;
  const run = promisify(execFile);
  async function probe(args) {
    const { stdout } = await run(getFfprobePath(), ['-v', 'error', ...args, '-of', 'json', filePath],
      { windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  }
  try {
    const actual = await probe(['-show_streams', '-show_format', '-count_frames', '-count_packets']);
    const stream = actual.streams?.[0], expected = report.output_probe, geometry = report.source_probe;
    check([stream?.tags?.rotate, ...(stream?.side_data_list || []).map(entry => entry.rotation)]
      .filter(value => value !== undefined).every(value => (typeof value === 'number'
        || typeof value === 'string' && /^[+-]?0+(?:\.0+)?$/.test(value))
        && Number.isFinite(Number(value)) && Number(value) === 0), 'CONFLICT');
    check(actual.streams?.length === 1 && stream.codec_type === 'video' && stream.codec_name === expected.codec
      && stream.pix_fmt === expected.pixel_format && stream.width === geometry.width && stream.height === geometry.height
      && stream.sample_aspect_ratio === geometry.sample_aspect_ratio && stream.display_aspect_ratio === geometry.display_aspect_ratio
      && stream.time_base === expected.time_base && Number(stream.nb_read_frames) === expected.frame_count
      && Number(stream.nb_read_packets) === expected.packet_count && Number(stream.start_pts) === expected.start_pts
      && Number(stream.duration_ts) === expected.duration_ticks
      && Math.abs(Number(actual.format?.duration) - report.timing.duration / report.timing.timescale) <= 0.001001, 'CONFLICT');
    for (const name of ['frames', 'packets']) {
      const entries = (await probe([`-show_${name}`]))[name];
      check(Array.isArray(entries) && entries.length === expected[name].length, 'CONFLICT');
      check(equal(entries.map((frame) => ({ pts: Number(frame.pts), duration: Number(frame.duration ?? frame.pkt_duration) })), expected[name]), 'CONFLICT');
      for (const [index, entry] of entries.entries()) {
        const planned = report.timing.frames[index], received = expected[name][index], tolerance = report.timing.tolerance_ticks;
        check(Math.abs(received.pts - planned.pts) <= tolerance && Math.abs(received.duration - planned.duration) <= tolerance
          && Math.abs(received.pts + received.duration - planned.pts - planned.duration) <= tolerance
          && (name !== 'packets' || Number(entry.dts) === received.pts), 'CONFLICT');
      }
    }
    check(Math.abs(expected.duration_ticks - report.timing.duration) <= report.timing.tolerance_ticks, 'CONFLICT');
    attachment.verified.output_media_verified = true;
  } catch (error) {
    if (error?.code?.startsWith('REDRAW_MOTION_PROCESSING_')) throw error;
    throw failure();
  }
}

async function assertStoredProcessingMaterial(ctx, input, attachment, pending) {
  keys(attachment, 'provenance report report_sha256 verified');
  check(attachment.provenance === 'client_returned_unattested');
  const parsed = parseProcessingReport(JSON.stringify(attachment.report));
  check(parsed.report_sha256 === attachment.report_sha256);
  const verified = attachment.verified;
  keys(verified, 'input_binding_sha256 material_binding_sha256 input_frame_mask_set_sha256 output_sha256 output_size pixel_claims_verified renderer_origin_verified output_media_verified');
  check(verified.pixel_claims_verified === false && verified.renderer_origin_verified === false
    && verified.output_media_verified === true
    && hash(verified.material_binding_sha256) && verified.output_sha256 === pending.file_sha256
    && verified.output_sha256 === parsed.report.output.sha256 && verified.output_size === parsed.report.output.size
    && verified.input_binding_sha256 === parsed.report.input_binding_sha256
    && verified.input_frame_mask_set_sha256 === parsed.report.input_frame_mask_set_sha256);
  const current = await currentReportBinding(ctx, input);
  check(current.material_binding_sha256 === verified.material_binding_sha256, 'CONFLICT');
  // Only CAS is allowed to advance during preparation. Every approval, frame, mask and source field stays bound.
  const original = structuredClone(current.coverage);
  original.shot.expected_updated_at = parsed.report.shot.expected_updated_at;
  assertReportBinding(parsed.report, { ...current, coverage: original, input_binding_sha256: sha256(stable(original)) });
}

function envelopeHeader(result) {
  const json = Buffer.from(JSON.stringify(result.report), 'utf8');
  if (json.length > MAX_REPORT_BYTES || result.size > MAX_VIDEO_BYTES) throw failure('TOO_LARGE');
  validateReport(result.report);
  if (!Number.isSafeInteger(result.size) || result.size <= 0 || result.mime !== 'video/mp4'
    || result.report?.schema_version !== 'redraw-motion-obscuration-report-v1'
    || result.report?.approval_status !== 'pending' || result.report.output?.mime !== result.mime
    || result.report.output.size !== result.size || result.report.output.sha256 !== result.sha256
    || !/^[a-f0-9]{64}$/.test(result.sha256)) throw failure();
  const prefix = Buffer.alloc(12);
  prefix.write('RDMO0001', 'ascii');
  prefix.writeUInt32BE(json.length, 8);
  return Buffer.concat([prefix, json]);
}

module.exports = { MAX_REPORT_BYTES, MAX_VIDEO_BYTES, CONTENT_TYPE, envelopeHeader,
  parseProcessingReport, verifyProcessingReport, verifyProcessingUpload, assertStoredProcessingMaterial };
