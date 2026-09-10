const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const sharp = require('sharp');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');
const { loadReviewedMotionCoverage } = require('./redrawReferenceBundleService');
const { withSourceVideoSnapshot } = require('./redrawSourceVideoService');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = (value) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const failure = (kind = 'UNAVAILABLE') => Object.assign(new Error(`REDRAW_MOTION_OBSCURATION_${kind}`),
  { code: `REDRAW_MOTION_OBSCURATION_${kind}` });
const sameStat = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key]);
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const gcd = (a, b) => b === 0n ? a : gcd(b, a % b);
const integer = (value) => Number.isSafeInteger(value);

// Inspect the entire path and the opened handle; an approved pathname is not a byte snapshot.
function checkedFile(file) {
  if (!path.isAbsolute(file)) throw failure();
  const resolved = path.resolve(file);
  let current = path.parse(resolved).root;
  const parts = resolved.slice(current.length).split(path.sep).filter(Boolean);
  let stat = fs.lstatSync(current, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure();
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    stat = fs.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw failure();
  }
  const actual = fs.realpathSync.native(file);
  if ((process.platform === 'win32' ? actual.toLowerCase() !== resolved.toLowerCase() : actual !== resolved)) throw failure();
  return stat;
}

async function readBoundFile(file, expectedHash, signal) {
  signal?.throwIfAborted();
  const before = checkedFile(file);
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!sameStat(before, await handle.stat({ bigint: true }))) throw failure('CONFLICT');
    const bytes = await handle.readFile();
    signal?.throwIfAborted();
    if (!sameStat(before, await handle.stat({ bigint: true })) || !sameStat(before, checkedFile(file))
      || sha256(bytes) !== expectedHash) throw failure('CONFLICT');
    return bytes;
  } finally { await handle.close(); }
}

// execFile's abort/error callback can precede close. Never recycle paths until this child has closed.
function run(ctx, binary, args) {
  ctx.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let closed = false, completed = false, result, executionError;
    const finish = () => {
      if (!closed || !completed) return;
      if (ctx.signal?.aborted) reject(ctx.signal.reason);
      else if (executionError) reject(failure('MEDIA_FAILED'));
      else resolve(result);
    };
    const child = (ctx.execFile || execFile)(binary, args, {
      shell: false, windowsHide: true, signal: ctx.signal, timeout: 120000,
      maxBuffer: 32 * 1024 * 1024, encoding: 'utf8',
    }, (error, stdout) => { executionError = error; result = stdout; completed = true; finish(); });
    child.once('close', () => { closed = true; finish(); });
  });
}

async function probe(ctx, file, full = false) {
  const result = JSON.parse(await run(ctx, getFfprobePath(), ['-v', 'error', '-show_streams', '-show_format',
    ...(full ? ['-count_frames', '-count_packets'] : []), '-of', 'json', file]));
  if (full) for (const section of ['frames', 'packets']) {
    Object.assign(result, JSON.parse(await run(ctx, getFfprobePath(), ['-v', 'error', `-show_${section}`, '-of', 'json', file])));
  }
  return result;
}

function ratio(value, separator) {
  if (typeof value !== 'string' || !new RegExp(`^[1-9]\\d*${separator}[1-9]\\d*$`).test(value)) throw failure('UNSUPPORTED');
  const [a, b] = value.split(separator).map(Number);
  if (!integer(a) || !integer(b) || a > 2147483647 || b > 2147483647) throw failure('UNSUPPORTED');
  return [a, b];
}

function geometry(sourceProbe, source, expectedDurationMs, shotEndMs) {
  const videos = sourceProbe.streams?.filter((stream) => stream.codec_type === 'video');
  if (videos?.length !== 1) throw failure('UNSUPPORTED');
  const stream = videos[0];
  if (stream.width !== source.width || stream.height !== source.height) throw failure('SOURCE_MISMATCH');
  if (source.width % 2 || source.height % 2) throw failure('UNSUPPORTED');
  const [num, den] = ratio(stream.time_base, '/');
  if (BigInt(num) * BigInt(source.time_base.denominator) !== BigInt(den) * BigInt(source.time_base.numerator)) throw failure('SOURCE_MISMATCH');
  if (!integer(Number(stream.duration_ts)) || Number(stream.duration_ts) <= 0
    || !integer(expectedDurationMs) || Number(stream.start_pts) !== 0) throw failure('UNSUPPORTED');
  const durationNumerator = BigInt(stream.duration_ts) * BigInt(num) * 1000n;
  const durationDifference = durationNumerator - BigInt(expectedDurationMs) * BigInt(den);
  if (durationDifference > BigInt(den) || durationDifference < -BigInt(den)
    || BigInt(shotEndMs) * BigInt(den) > durationNumerator + BigInt(den)) throw failure('SOURCE_MISMATCH');
  const durationMs = Number(durationNumerator) / den;
  const [sarNum, sarDen] = ratio(stream.sample_aspect_ratio, ':');
  const [darNum, darDen] = ratio(stream.display_aspect_ratio, ':');
  if (BigInt(source.width) * BigInt(sarNum) * BigInt(darDen) !== BigInt(source.height) * BigInt(sarDen) * BigInt(darNum)) throw failure('SOURCE_MISMATCH');
  if (sarNum > 65535 || sarDen > 65535) throw failure('UNSUPPORTED');
  const rotations = [stream.tags?.rotate, ...(stream.side_data_list || []).map((item) => item.rotation)]
    .filter((item) => item !== undefined);
  if (rotations.some((item) => !Number.isFinite(Number(item)) || Number(item) !== 0)) throw failure('UNSUPPORTED');
  return { width: source.width, height: source.height, sample_aspect_ratio: stream.sample_aspect_ratio,
    display_aspect_ratio: stream.display_aspect_ratio, rotation: 0, time_base: { numerator: num, denominator: den },
    duration_ticks: Number(stream.duration_ts), duration_ms: durationMs, duration_tolerance_ms: 1 };
}

function timing(coverage) {
  const denominator = BigInt(coverage.source.time_base.denominator);
  const scale = denominator / gcd(denominator, 1000n) * 1000n;
  if (scale > 2147483647n) throw failure('UNSUPPORTED');
  const ticks = (point) => {
    const numerator = BigInt(point.ticks) * BigInt(point.time_base.numerator) * scale;
    const denominator = BigInt(point.time_base.denominator);
    if (numerator % denominator) throw failure('UNSUPPORTED');
    const result = numerator / denominator;
    if (result < 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) throw failure('UNSUPPORTED');
    return result;
  };
  const origin = ticks(coverage.frames[0].clip_interval.start);
  const roundUs = (value) => (value * 1000000n + scale / 2n) / scale;
  const originUs = roundUs(origin);
  let previous;
  const frames = coverage.frames.map((frame) => {
    const start = ticks(frame.clip_interval.start), end = ticks(frame.clip_interval.end);
    const startUs = roundUs(start), endUs = roundUs(end);
    if (end <= start || endUs <= startUs || (previous !== undefined && previous !== start)) throw failure('UNSUPPORTED');
    previous = end;
    return { frame_index: frame.frame_index, pts: Number(start - origin), duration: Number(end - start),
      concat_start_us: Number(startUs - originUs), concat_duration_us: Number(endUs - startUs) };
  });
  return { timescale: Number(scale), frames, duration: frames.at(-1).pts + frames.at(-1).duration,
    tolerance_ticks: Math.max(1, Math.ceil(Number(scale) / 1000000)),
    rounding: 'absolute source boundaries rounded to nearest microsecond before differencing; at most one microsecond or one output tick' };
}

function verifyOutput(result, expectedGeometry, timeline) {
  const stream = result.streams?.[0];
  if (result.streams?.length !== 1 || stream.codec_type !== 'video' || stream.codec_name !== 'h264'
    || stream.pix_fmt !== 'yuv420p' || stream.width !== expectedGeometry.width || stream.height !== expectedGeometry.height
    || stream.sample_aspect_ratio !== expectedGeometry.sample_aspect_ratio || stream.display_aspect_ratio !== expectedGeometry.display_aspect_ratio
    || stream.time_base !== `1/${timeline.timescale}` || Number(stream.nb_read_frames) !== timeline.frames.length
    || Number(stream.nb_read_packets) !== timeline.frames.length) throw failure('OUTPUT_INVALID');
  const near = (actual, expected) => integer(Number(actual)) && Math.abs(Number(actual) - expected) <= timeline.tolerance_ticks;
  const sections = {};
  for (const name of ['frames', 'packets']) {
    if (!Array.isArray(result[name]) || result[name].length !== timeline.frames.length) throw failure('OUTPUT_INVALID');
    sections[name] = result[name].map((entry, index) => {
      const pts = Number(entry.pts), duration = Number(entry.duration ?? entry.pkt_duration);
      const expected = timeline.frames[index];
      if (!near(pts, expected.pts) || !near(duration, expected.duration) || duration <= 0
        || !near(pts + duration, expected.pts + expected.duration)) throw failure('OUTPUT_INVALID');
      if (name === 'packets' && Number(entry.dts) !== pts) throw failure('OUTPUT_INVALID');
      return { pts, duration };
    });
  }
  if (!near(stream.start_pts, 0) || !near(stream.duration_ts, timeline.duration)
    || !Number.isFinite(Number(result.format?.duration))
    || Math.abs(Number(result.format.duration) - timeline.duration / timeline.timescale) > 0.001001) throw failure('OUTPUT_INVALID');
  return { codec: stream.codec_name, pixel_format: stream.pix_fmt, time_base: stream.time_base,
    frame_count: sections.frames.length, packet_count: sections.packets.length, start_pts: Number(stream.start_pts),
    duration_ticks: Number(stream.duration_ts), ...sections };
}

async function withMotionObscuration(ctx, input, consume) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
    || Object.keys(input).some((key) => !['shot_id', 'expected_updated_at'].includes(key))
    || typeof consume !== 'function') throw failure('INPUT_INVALID');
  ctx.signal?.throwIfAborted();
  const coverage = await loadReviewedMotionCoverage(ctx, input);
  const initialBinding = stable(coverage);
  return withSourceVideoSnapshot(ctx, { tenantId: coverage.owner.tenant_id, userId: coverage.owner.user_id,
    workId: coverage.work_id, expectedSourceAssetId: coverage.source_asset_id, expectedSourceSha256: coverage.source_fingerprint }, async (source) => {
    const owned = [];
    const streams = new Set();
    let output, outputStat, active = true;
    async function create(name, bytes) {
      source.assertPrivateDirectory();
      const file = path.join(source.directory, name);
      const handle = await fs.promises.open(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0), 0o600);
      const entry = { file, handle, stat: null };
      owned.push(entry);
      entry.stat = fs.fstatSync(handle.fd, { bigint: true });
      if (!sameStat(entry.stat, await handle.stat({ bigint: true }))
        || !sameStat(entry.stat, checkedFile(file))) throw failure('CONFLICT');
      if (bytes) {
        await handle.writeFile(bytes);
        if (!sameStat(await handle.stat({ bigint: true }), checkedFile(file))) throw failure('CONFLICT');
        await handle.close(); entry.handle = null;
      }
      return entry;
    }
    const assertCurrentBinding = async () => {
      if (!active) throw failure('EXPIRED');
      ctx.signal?.throwIfAborted();
      source.assertCurrentBinding();
      if (outputStat && !sameStat(outputStat, await output.handle.stat({ bigint: true }))) throw failure('CONFLICT');
      // Finish asynchronous file checks before the trusted reader's final authority check; the tail must not yield.
      if (stable(await loadReviewedMotionCoverage(ctx, input)) !== initialBinding) throw failure('CONFLICT');
      source.assertCurrentBinding();
      if (outputStat && (!sameStat(outputStat, fs.fstatSync(output.handle.fd, { bigint: true }))
        || !sameStat(outputStat, checkedFile(output.file)))) throw failure('CONFLICT');
      ctx.signal?.throwIfAborted();
    };
    try {
      const work = ctx.db.prepare('SELECT duration_ms FROM redraw_works WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL')
        .get(coverage.work_id, coverage.owner.tenant_id, coverage.owner.user_id);
      const sourceGeometry = geometry(await probe(ctx, source.path), coverage.source, work?.duration_ms, coverage.shot.end_ms);
      source.assertCurrentBinding();
      const timeline = timing(coverage);
      const frameReports = [], files = [];
      for (const [index, frame] of coverage.frames.entries()) {
        const frameBytes = await readBoundFile(frame.path, frame.sha256, ctx.signal);
        const decoded = await sharp(frameBytes).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
        if (decoded.info.width !== sourceGeometry.width || decoded.info.height !== sourceGeometry.height || decoded.info.channels !== 3) throw failure('SOURCE_MISMATCH');
        const original = decoded.data;
        const union = Buffer.alloc(sourceGeometry.width * sourceGeometry.height);
        const maskInputs = [];
        for (const region of [...frame.person_regions, ...frame.text_regions]) {
          const maskBytes = await readBoundFile(region.mask.path, region.mask.sha256, ctx.signal);
          const mask = await sharp(maskBytes).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
          if (mask.info.width !== sourceGeometry.width || mask.info.height !== sourceGeometry.height || mask.info.channels !== 1) throw failure('SOURCE_MISMATCH');
          for (let pixel = 0; pixel < union.length; pixel += 1) {
            if (mask.data[pixel] !== 0 && mask.data[pixel] !== 255) throw failure('SOURCE_MISMATCH');
            union[pixel] |= mask.data[pixel];
          }
          maskInputs.push({ region_id: region.region_id, kind: region.kind, sha256: sha256(maskBytes) });
        }
        ctx.signal?.throwIfAborted();
        const maskPixels = union.reduce((sum, value) => sum + (value === 255 ? 1 : 0), 0);
        const processed = Buffer.from(original);
        if (maskPixels) {
          const blurred = await sharp(original, { raw: decoded.info }).blur(12).raw().toBuffer();
          for (let pixel = 0; pixel < union.length; pixel += 1) if (union[pixel]) blurred.copy(processed, pixel * 3, pixel * 3, pixel * 3 + 3);
        }
        const png = await sharp(processed, { raw: decoded.info }).png().toBuffer();
        files.push(await create(`frame-${String(index).padStart(6, '0')}.png`, png));
        frameReports.push({ frame_index: frame.frame_index, timestamp_ticks: frame.timestamp_ticks, clip_interval: frame.clip_interval,
          source_frame_sha256: sha256(frameBytes), masks: maskInputs, union_mask_sha256: sha256(union), union_white_pixels: maskPixels,
          processed_png_sha256: sha256(png), unmasked_rgb_changed_samples: 0 });
      }
      await assertCurrentBinding();
      const concat = await create('frames.ffconcat', Buffer.from(['ffconcat version 1.0', ...files.flatMap((entry, index) => [
        `file '${path.basename(entry.file)}'`, `option framerate ${timeline.timescale}`,
        `duration ${(timeline.frames[index].concat_duration_us / 1000000).toFixed(6)}`,
      ])].join('\n')));
      output = await create('motion-obscuration.mp4');
      const tail = timeline.frames.at(-1);
      await run(ctx, getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concat.file,
        '-map', '0:v:0', '-an', '-vf', `setsar=${sourceGeometry.sample_aspect_ratio.replace(':', '/')}:max=65535`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-bf', '0',
        '-fps_mode', 'passthrough', '-enc_time_base', `1/${timeline.timescale}`, '-video_track_timescale', String(timeline.timescale),
        '-bsf:v', `setts=duration='if(eq(N,${timeline.frames.length - 1}),${tail.duration},DURATION)':time_base=1/${timeline.timescale}`, output.file]);
      outputStat = await output.handle.stat({ bigint: true });
      if (!sameIdentity(output.stat, outputStat) || !outputStat.isFile() || outputStat.size <= 0n
        || outputStat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw failure('OUTPUT_INVALID');
      const outputProbe = verifyOutput(await probe(ctx, output.file, true), sourceGeometry, timeline);
      const outputSize = Number(outputStat.size), hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(65536);
      let position = 0;
      while (position < outputSize) {
        ctx.signal?.throwIfAborted();
        const { bytesRead } = await output.handle.read(buffer, 0, Math.min(buffer.length, outputSize - position), position);
        if (!bytesRead) throw failure('OUTPUT_INVALID');
        hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      const outputHash = hash.digest('hex');
      await assertCurrentBinding();
      const report = { schema_version: 'redraw-motion-obscuration-report-v1', approval_status: 'pending',
        owner: coverage.owner, work_id: coverage.work_id, version_id: coverage.version_id, shot_id: coverage.shot_id,
        source_shot_id: coverage.source_shot_id, shot: coverage.shot, facts_hash: coverage.facts_hash,
        source_asset_id: coverage.source_asset_id, source_fingerprint: source.sha256, source_size: source.size,
        coverage: coverage.coverage, input_binding_sha256: sha256(initialBinding),
        input_frame_mask_set_sha256: sha256(stable(frameReports.map((frame) => ({ frame_index: frame.frame_index,
          source_frame_sha256: frame.source_frame_sha256, masks: frame.masks })))),
        processing: { method: 'conservative_mask_union_gaussian_detail_reduction', sigma_px: 12,
          mask_scope: 'all_story_role_background_extra_and_text', empty_region_behavior: 'unchanged_rgb',
          codec: 'h264', pixel_format: 'yuv420p', preset: 'ultrafast', crf: 18, b_frames: 0, audio: false },
        source_probe: { origin: 'sha256_bound_private_source_snapshot', ...sourceGeometry },
        timing: timeline, frames: frameReports, output_probe: outputProbe,
        output: { mime: 'video/mp4', size: outputSize, sha256: outputHash },
        quality_review: 'pending_human_review; lossy_encoding_is_not_pixel_identity_or_background_approval' };
      const result = await consume({ mime: 'video/mp4', size: outputSize, sha256: outputHash, report,
        assertCurrentBinding,
        createReadStream: () => {
          if (!active) throw failure('EXPIRED');
          ctx.signal?.throwIfAborted(); source.assertCurrentBinding();
          if (!sameStat(outputStat, checkedFile(output.file))) throw failure('CONFLICT');
          const stream = output.handle.createReadStream({ start: 0, autoClose: false });
          streams.add(stream); stream.once('close', () => streams.delete(stream)); return stream;
        } });
      await assertCurrentBinding();
      return result;
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason;
      if (/^REDRAW_(?:MOTION_OBSCURATION|REFERENCE_BUNDLE|SOURCE_VIDEO)_/.test(String(error.code))) throw error;
      throw failure();
    } finally {
      active = false;
      for (const stream of streams) stream.destroy();
      let cleanupError, directoryTrusted = true;
      const rememberCleanupError = (error) => {
        if (!cleanupError) cleanupError = Object.assign(failure('CLEANUP_FAILED'), {
          cleanup_code: ['EIO', 'EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'ENOENT', 'EBADF',
            'REDRAW_MOTION_OBSCURATION_CONFLICT', 'REDRAW_SOURCE_VIDEO_UNAVAILABLE'].includes(error?.code) ? error.code : 'UNAVAILABLE',
        });
      };
      for (const entry of owned.reverse()) {
        try { await entry.handle?.close(); } catch (error) { rememberCleanupError(error); continue; }
        if (!directoryTrusted) continue;
        try { source.assertPrivateDirectory(); } catch (error) {
          directoryTrusted = false; rememberCleanupError(error); continue;
        }
        try {
          if (!entry.stat || !sameIdentity(entry.stat, checkedFile(entry.file))) throw failure('CONFLICT');
          await fs.promises.unlink(entry.file);
        } catch (error) { rememberCleanupError(error); }
      }
      if (cleanupError) throw cleanupError;
    }
  });
}

module.exports = { withMotionObscuration, timing, verifyOutput };
