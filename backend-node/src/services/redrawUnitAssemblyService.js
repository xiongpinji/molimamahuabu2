'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const { getFfmpegPath } = require('../utils/ffmpegPath');
const { getExecutionRun } = require('./redrawExecutionRunService');
const { prepareApprovedExecutionUnitMedia } = require('./redrawExecutionUnitReviewService');
const { defaultCompositionRunner, defaultProbeRunner, validateGeometryProbe,
  rationalEquals, sha256File } = require('./redrawMediaRuntimeInternal');

const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

function fail(code, message = code, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function plainDirectory(directory, parentReal = null) {
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(directory, { mode: 0o700 });
    stat = fs.lstatSync(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('REDRAW_UNIT_ASSEMBLY_OUTPUT_PATH_UNSAFE');
  const real = fs.realpathSync.native(directory);
  if (parentReal && !inside(parentReal, real)) fail('REDRAW_UNIT_ASSEMBLY_OUTPUT_PATH_UNSAFE');
  return real;
}

function createWorkspace(storageRoot, runId) {
  const root = path.resolve(storageRoot);
  const realRoot = plainDirectory(root);
  const redraw = path.join(root, 'redraw');
  const realRedraw = plainDirectory(redraw, realRoot);
  const assemblies = path.join(redraw, 'unit-assemblies');
  const realAssemblies = plainDirectory(assemblies, realRedraw);
  const directory = fs.mkdtempSync(path.join(assemblies, `run-${runId}-`));
  const stat = fs.lstatSync(directory, { bigint: true });
  const real = fs.realpathSync.native(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(realAssemblies, real)) {
    fail('REDRAW_UNIT_ASSEMBLY_OUTPUT_PATH_UNSAFE');
  }
  return { directory, real, parentReal: realAssemblies, stat };
}

function sameIdentity(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);
}

function assertWorkspace(workspace) {
  const stat = fs.lstatSync(workspace.directory, { bigint: true });
  const sameDirectory = ['dev', 'ino'].every(key => stat[key] === workspace.stat[key]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameDirectory
    || fs.realpathSync.native(workspace.directory) !== workspace.real || !inside(workspace.parentReal, workspace.real)) {
    fail('REDRAW_UNIT_ASSEMBLY_OUTPUT_PATH_UNSAFE');
  }
}

function assertNoLinks(directory) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) fail('REDRAW_UNIT_ASSEMBLY_OUTPUT_PATH_UNSAFE');
  if (!stat.isDirectory()) return;
  for (const name of fs.readdirSync(directory)) assertNoLinks(path.join(directory, name));
}

function cleanupWorkspace(workspace) {
  if (!workspace) return;
  try {
    assertWorkspace(workspace);
    assertNoLinks(workspace.directory);
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  } catch (_) {}
}

function openOwnedFile(workspace, file, metadata) {
  assertWorkspace(workspace);
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || path.dirname(file) !== workspace.directory
    || fs.realpathSync.native(file) !== file || before.size !== BigInt(metadata.size)) {
    fail('REDRAW_UNIT_ASSEMBLY_OUTPUT_INVALID');
  }
  let fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count));
    if (digest.digest('hex') !== metadata.sha256 || !sameIdentity(before, fs.fstatSync(fd, { bigint: true }))) {
      fail('REDRAW_UNIT_ASSEMBLY_OUTPUT_INVALID');
    }
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  let closed = false;
  let streamed = false;
  const cleanup = () => {
    if (!closed) { fs.closeSync(fd); closed = true; fd = undefined; }
  };
  const assertCurrentBinding = () => {
    if (closed) fail('REDRAW_UNIT_ASSEMBLY_OUTPUT_INVALID');
    const current = fs.lstatSync(file, { bigint: true });
    if (!sameIdentity(before, current) || !sameIdentity(before, fs.fstatSync(fd, { bigint: true }))) {
      fail('REDRAW_UNIT_ASSEMBLY_OUTPUT_INVALID');
    }
  };
  return {
    size: metadata.size,
    sha256: metadata.sha256,
    mime: metadata.mime,
    cleanup,
    assertCurrentBinding,
    createReadStream() {
      assertCurrentBinding();
      if (streamed) fail('REDRAW_UNIT_ASSEMBLY_OUTPUT_INVALID');
      streamed = true;
      return fs.createReadStream(file, { fd, start: 0, end: metadata.size - 1, autoClose: false,
        fs: { read: fs.read.bind(fs), close: (_fd, callback) => callback(null) } });
    },
  };
}

function assertTimeline(units) {
  let end = 0;
  const dialogueIds = new Set();
  for (const unit of units) {
    const timeline = unit.timeline;
    if (!exact(timeline, ['source_start_ms', 'source_end_ms', 'retained_duration_ms', 'generated_duration_ms', 'padding_ms'])
      || !nonnegative(timeline.source_start_ms) || !positive(timeline.source_end_ms)
      || timeline.source_start_ms !== end || timeline.source_end_ms <= timeline.source_start_ms
      || timeline.retained_duration_ms !== timeline.source_end_ms - timeline.source_start_ms
      || timeline.generated_duration_ms < timeline.retained_duration_ms
      || timeline.padding_ms !== timeline.generated_duration_ms - timeline.retained_duration_ms) {
      fail('REDRAW_UNIT_ASSEMBLY_TIMELINE_INVALID');
    }
    end = timeline.source_end_ms;
    for (const dialogue of unit.dialogues) {
      if (dialogueIds.has(dialogue.id)) fail('REDRAW_UNIT_ASSEMBLY_TIMELINE_INVALID');
      dialogueIds.add(dialogue.id);
    }
  }
  return end;
}

function ffmpegArgs(inputs, output, geometry, audioMode) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-copyts'];
  for (const input of inputs) args.push('-i', input.file);
  const filters = [];
  const concat = [];
  const includeAudio = audioMode !== 'replace' && (audioMode === 'native' || inputs.some(input => input.probe.hasAudio));
  for (const [index, input] of inputs.entries()) {
    const seconds = input.snapshot.timeline.retained_duration_ms / 1000;
    const start = input.probe.videoStartTime;
    const end = start + seconds;
    const sar = `${geometry.sar.numerator}/${geometry.sar.denominator}`;
    filters.push(`[${index}:v]trim=start=${start}:end=${end},setpts=PTS-(${start})/TB,scale=${geometry.width}:${geometry.height}:flags=lanczos,setsar=${sar}:max=65535,format=yuv420p[v${index}]`);
    concat.push(`[v${index}]`);
    if (includeAudio) {
      filters.push(input.probe.hasAudio
        ? `[${index}:a]atrim=start=${start}:end=${end},asetpts=PTS-(${start})/TB,aresample=48000:first_pts=0,apad=whole_dur=${seconds},atrim=duration=${seconds},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${index}]`
        : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${seconds},asetpts=PTS-STARTPTS[a${index}]`);
      concat.push(`[a${index}]`);
    }
  }
  filters.push(`${concat.join('')}concat=n=${inputs.length}:v=1:a=${includeAudio ? 1 : 0}[vout]${includeAudio ? '[aout]' : ''}`);
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
  if (includeAudio) args.push('-map', '[aout]');
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (includeAudio) args.push('-c:a', 'aac');
  args.push('-movflags', '+faststart', output);
  return { args, includeAudio };
}

async function assembleApprovedExecutionUnits(ctx, input) {
  if (!ctx?.db || typeof ctx.db.prepare !== 'function' || !path.isAbsolute(String(ctx.storageRoot || ''))
    || typeof ctx.tenantId !== 'string' || !ctx.tenantId || typeof ctx.userId !== 'string' || !ctx.userId
    || !exact(input, ['version_id', 'run_id', 'expected_plan_hash', 'expected_run_revision'])
    || !positive(input.version_id) || !positive(input.run_id) || !sha(input.expected_plan_hash)
    || !nonnegative(input.expected_run_revision)) fail('REDRAW_UNIT_ASSEMBLY_INPUT_INVALID');
  const run = getExecutionRun(ctx, input.version_id, input.run_id);
  if (run.binding_status !== 'current' || run.status !== 'completed' || run.plan_hash !== input.expected_plan_hash
    || run.revision !== input.expected_run_revision || !run.units.length
    || run.units.some(unit => unit.status !== 'approved')) fail('REDRAW_UNIT_ASSEMBLY_CONFLICT');
  const candidates = ctx.db.prepare(`SELECT qu.unit_id, a.candidate_hash
    FROM redraw_execution_unit_attempts a JOIN redraw_execution_queue_units qu ON qu.id=a.queue_unit_id
    WHERE a.run_id=? ORDER BY qu.ordinal`).all(run.id);
  if (candidates.length !== run.units.length || candidates.some((row, index) => row.unit_id !== run.units[index].id || !sha(row.candidate_hash))) {
    fail('REDRAW_UNIT_ASSEMBLY_CONFLICT');
  }
  const snapshots = [];
  let workspace;
  let videoHandle;
  let manifestHandle;
  try {
    for (const row of candidates) {
      snapshots.push(await prepareApprovedExecutionUnitMedia(ctx, run.version_id, run.id, row.unit_id, row.candidate_hash));
    }
    const first = snapshots[0];
    if (!['native', 'replace', 'not_required'].includes(first.audio_mode)
      || snapshots.some((unit, index) => unit.ordinal !== index || unit.run_revision !== run.revision
        || unit.audio_mode !== first.audio_mode || unit.bindings.version_id !== run.version_id
        || unit.bindings.run_id !== run.id || unit.bindings.plan_hash !== run.plan_hash
        || unit.candidate.sha256 !== unit.sha256 || unit.candidate.bytes !== unit.size)) {
      fail('REDRAW_UNIT_ASSEMBLY_CONFLICT');
    }
    const totalDurationMs = assertTimeline(snapshots);
    workspace = createWorkspace(ctx.storageRoot, run.id);
    const materialized = [];
    for (const [index, snapshot] of snapshots.entries()) {
      const file = path.join(workspace.directory, `unit-${index + 1}.mp4`);
      await pipeline(snapshot.createReadStream(), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
      if (await sha256File(file) !== snapshot.candidate.sha256) fail('REDRAW_UNIT_ASSEMBLY_INPUT_DRIFT');
      const probe = await defaultProbeRunner(file, { execFile: ctx.execFile });
      const geometry = validateGeometryProbe(probe, snapshot.candidate, 'REDRAW_UNIT_ASSEMBLY_INPUT_GEOMETRY_INVALID');
      if (!Number.isFinite(probe.videoStartTime)
        || (first.audio_mode !== 'replace' && probe.hasAudio && !Number.isFinite(probe.audioStartTime))) {
        fail('REDRAW_UNIT_ASSEMBLY_INPUT_TIMESTAMP_INVALID');
      }
      if (first.audio_mode === 'native' && !probe.hasAudio) fail('REDRAW_UNIT_ASSEMBLY_INPUT_AUDIO_INVALID');
      materialized.push({ file, snapshot, probe, geometry });
    }
    const geometry = materialized[0].geometry;
    if (materialized.some(inputUnit => !rationalEquals(inputUnit.geometry.sar, geometry.sar)
      || !rationalEquals(inputUnit.geometry.dar, geometry.dar))) fail('REDRAW_UNIT_ASSEMBLY_INPUT_GEOMETRY_MISMATCH');
    const outputPath = path.join(workspace.directory, 'assembly.mp4');
    const encoding = ffmpegArgs(materialized, outputPath, geometry, first.audio_mode);
    const runner = ctx.assemblyRunner || defaultCompositionRunner;
    await runner({ bin: getFfmpegPath(), args: encoding.args, outputPath,
      timeoutMs: Math.min(1_800_000, Math.max(30_000, Math.ceil(totalDurationMs * 10 + 30_000))), execFile: ctx.execFile });
    for (const unit of materialized) {
      if (await sha256File(unit.file) !== unit.snapshot.candidate.sha256) fail('REDRAW_UNIT_ASSEMBLY_INPUT_DRIFT');
      unit.snapshot.assertCurrentBinding();
    }
    const outputHashBeforeProbe = await sha256File(outputPath);
    const outputProbe = await defaultProbeRunner(outputPath, { execFile: ctx.execFile });
    const outputHashAfterProbe = await sha256File(outputPath);
    if (outputHashAfterProbe !== outputHashBeforeProbe || outputProbe.hasAudio !== encoding.includeAudio
      || !Number.isFinite(outputProbe.videoStartTime) || Math.abs(outputProbe.videoStartTime) > 0.001) {
      fail('REDRAW_UNIT_ASSEMBLY_OUTPUT_INVALID');
    }
    const outputGeometry = validateGeometryProbe(outputProbe, geometry, 'REDRAW_UNIT_ASSEMBLY_OUTPUT_INVALID');
    if (!rationalEquals(outputGeometry.sar, geometry.sar) || !rationalEquals(outputGeometry.dar, geometry.dar)) {
      fail('REDRAW_UNIT_ASSEMBLY_OUTPUT_INVALID');
    }
    const actualDurationMs = Math.round(Number(outputProbe.duration) * 1000);
    if (!positive(actualDurationMs) || Math.abs(actualDurationMs - totalDurationMs) > Math.max(250, Math.round(totalDurationMs * 0.03))) {
      fail('REDRAW_UNIT_ASSEMBLY_OUTPUT_INVALID');
    }
    const units = snapshots.map((unit, index) => ({
      ordinal: unit.ordinal,
      unit_id: unit.bindings.unit_id,
      unit_hash: unit.bindings.unit_hash,
      source_start_ms: unit.timeline.source_start_ms,
      source_end_ms: unit.timeline.source_end_ms,
      retained_duration_ms: unit.timeline.retained_duration_ms,
      generated_duration_ms: unit.timeline.generated_duration_ms,
      padding_ms: unit.timeline.padding_ms,
      parent_shots: unit.parent_shots,
      dialogues: unit.dialogues,
      candidate_hash: unit.candidate.hash,
      candidate_sha256: unit.candidate.sha256,
      candidate_bytes: unit.candidate.bytes,
      review_hash: unit.review_hash,
      input_sample_aspect_ratio: `${materialized[index].geometry.sar.numerator}:${materialized[index].geometry.sar.denominator}`,
      input_display_aspect_ratio: `${materialized[index].geometry.dar.numerator}:${materialized[index].geometry.dar.denominator}`,
      input_has_audio: materialized[index].probe.hasAudio,
    }));
    const audioUnits = units.map(unit => ({ unit_id: unit.unit_id, input_has_audio: unit.input_has_audio,
      silence_placeholder: first.audio_mode === 'not_required' && encoding.includeAudio && !unit.input_has_audio }));
    const manifest = {
      schema_version: 'redraw-execution-unit-assembly-v1',
      bindings: { tenant_id: first.bindings.tenant_id, user_id: first.bindings.user_id,
        work_id: first.bindings.work_id, version_id: run.version_id, run_id: run.id, queue_id: run.queue_id,
        review_id: run.review_id, plan_hash: run.plan_hash, run_revision: run.revision },
      units,
      audio: {
        mode: first.audio_mode,
        disposition: first.audio_mode === 'native' ? 'approved_unit_tracks_preserved'
          : first.audio_mode === 'replace' ? 'approved_dub_required'
            : encoding.includeAudio ? 'available_unit_tracks_preserved_with_missing_intervals_silenced' : 'video_only_no_unit_tracks',
        approved_dub_required: first.audio_mode === 'replace',
        no_dialogue_required: first.audio_mode === 'not_required',
        units: audioUnits,
        post_assembly_ambient_and_extra_dialogue_review_required: true,
      },
      output: { mime_type: 'video/mp4', bytes: Number(fs.statSync(outputPath).size), sha256: outputHashAfterProbe,
        duration_ms: actualDurationMs, width: outputGeometry.width, height: outputGeometry.height,
        sample_aspect_ratio: `${outputGeometry.sar.numerator}:${outputGeometry.sar.denominator}`,
        display_aspect_ratio: `${outputGeometry.dar.numerator}:${outputGeometry.dar.denominator}`,
        has_audio: outputProbe.hasAudio },
      review_status: 'requires_post_assembly_human_review',
    };
    const manifestPath = path.join(workspace.directory, 'assembly-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    const manifestHash = await sha256File(manifestPath);
    for (const unit of materialized) {
      if (await sha256File(unit.file) !== unit.snapshot.candidate.sha256) fail('REDRAW_UNIT_ASSEMBLY_INPUT_DRIFT');
      unit.snapshot.assertCurrentBinding();
    }
    if (await sha256File(outputPath) !== outputHashAfterProbe) fail('REDRAW_UNIT_ASSEMBLY_OUTPUT_INVALID');
    snapshots.forEach(unit => unit.assertCurrentBinding());
    videoHandle = openOwnedFile(workspace, outputPath, { size: manifest.output.bytes, sha256: outputHashAfterProbe, mime: 'video/mp4' });
    manifestHandle = openOwnedFile(workspace, manifestPath, { size: Number(fs.statSync(manifestPath).size),
      sha256: manifestHash, mime: 'application/json' });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      videoHandle.cleanup();
      manifestHandle.cleanup();
      snapshots.forEach(unit => unit.cleanup());
      cleanupWorkspace(workspace);
    };
    const assertCurrentBindingSync = () => {
      const current = getExecutionRun(ctx, run.version_id, run.id);
      if (current.binding_status !== 'current' || current.status !== 'completed' || current.plan_hash !== run.plan_hash
        || current.revision !== run.revision) fail('REDRAW_UNIT_ASSEMBLY_CONFLICT');
      snapshots.forEach(unit => unit.assertCurrentBinding());
      videoHandle.assertCurrentBinding();
      manifestHandle.assertCurrentBinding();
    };
    return {
      manifest,
      files: { video: videoHandle, manifest: manifestHandle },
      assertCurrentBindingSync,
      async assertCurrentBinding() { assertCurrentBindingSync(); },
      cleanup,
    };
  } catch (error) {
    videoHandle?.cleanup();
    manifestHandle?.cleanup();
    snapshots.forEach(unit => unit.cleanup());
    cleanupWorkspace(workspace);
    throw error;
  }
}

module.exports = { assembleApprovedExecutionUnits };
