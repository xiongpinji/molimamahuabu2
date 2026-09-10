'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { types } = require('node:util');
const { execFile } = require('node:child_process');
const { withUnitReferenceMaterials } = require('./redrawUnitReferenceMaterialsInternal');
const { timing, verifyOutput } = require('./redrawMotionObscurationService');
const { verifyProcessingUpload } = require('./redrawMotionProcessingReportService');
const { hashPlanValue } = require('./redrawExecutionPlanService');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');

const FIELDS = ['version_id', 'review_id', 'queue_id', 'plan_hash', 'unit_id', 'unit_hash', 'expected_materials_hash'];
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const failure = (kind = 'STALE') => Object.assign(new Error(`REDRAW_UNIT_REFERENCE_DERIVATION_${kind}`),
  { code: `REDRAW_UNIT_REFERENCE_DERIVATION_${kind}` });
const check = (ok, kind) => { if (!ok) throw failure(kind); };
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameStat = (a, b) => sameIdentity(a, b) && ['size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const recipe = { schema_version: 'redraw-unit-reference-trim-v1', selection: 'processed_parent_frame_ordinal',
  boundary: 'positive_display_interval_intersection', codec: 'h264', pixel_format: 'yuv420p',
  preset: 'ultrafast', crf: 18, b_frames: 0, audio: false, timing: 'exact_integer_lcm_source_and_milliseconds',
  pts: 'balanced_if_private_filter_script', packet_duration: 'consecutive_pts_with_explicit_tail' };

function checkedPath(file, directory = false) {
  check(path.isAbsolute(file));
  const resolved = path.resolve(file);
  let current = path.parse(resolved).root;
  const parts = resolved.slice(current.length).split(path.sep).filter(Boolean);
  let stat = fs.lstatSync(current, { bigint: true });
  check(stat.isDirectory() && !stat.isSymbolicLink());
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part); stat = fs.lstatSync(current, { bigint: true });
    check(!stat.isSymbolicLink() && (index < parts.length - 1 || directory ? stat.isDirectory() : stat.isFile()));
  }
  const actual = fs.realpathSync.native(resolved);
  check(process.platform === 'win32' ? actual.toLowerCase() === resolved.toLowerCase() : actual === resolved);
  return stat;
}

function run(ctx, binary, args) {
  ctx.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let closed = false, completed = false, error, stdout;
    const finish = () => {
      if (!closed || !completed) return;
      if (ctx.signal?.aborted) reject(ctx.signal.reason);
      else if (error) reject(failure('MEDIA_FAILED'));
      else resolve(stdout);
    };
    const child = (ctx.execFile || execFile)(binary, args, { shell: false, windowsHide: true,
      timeout: 120000, signal: ctx.signal, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
    (err, out) => { error = err; stdout = out; completed = true; finish(); });
    child.once('close', () => { closed = true; finish(); });
  });
}

async function probe(ctx, file) {
  const value = JSON.parse(await run(ctx, getFfprobePath(), ['-v', 'error', '-show_streams', '-show_format',
    '-count_frames', '-count_packets', '-of', 'json', file]));
  for (const section of ['frames', 'packets']) Object.assign(value, JSON.parse(await run(ctx, getFfprobePath(),
    ['-v', 'error', `-show_${section}`, '-of', 'json', file])));
  return value;
}

function mapFrames(report, reference) {
  const point = value => ({ ticks: value, time_base: { numerator: 1, denominator: 1000 } });
  const compare = (a, b) => BigInt(a.ticks) * BigInt(a.time_base.numerator) * BigInt(b.time_base.denominator)
    - BigInt(b.ticks) * BigInt(b.time_base.numerator) * BigInt(a.time_base.denominator);
  const start = point(reference.source_range.start_ms), end = point(reference.source_range.end_ms);
  const frames = [];
  for (const [ordinal, frame] of report.frames.entries()) {
    const clipStart = compare(frame.clip_interval.start, start) < 0n ? start : frame.clip_interval.start;
    const clipEnd = compare(frame.clip_interval.end, end) > 0n ? end : frame.clip_interval.end;
    if (compare(clipStart, clipEnd) < 0n) frames.push({ frame_index: frame.frame_index, parent_frame_ordinal: ordinal,
      clip_interval: { start: clipStart, end: clipEnd } });
  }
  check(frames.length && compare(frames[0].clip_interval.start, start) === 0n
    && compare(frames.at(-1).clip_interval.end, end) === 0n, 'MAPPING_REQUIRED');
  const timeline = timing({ source: { time_base: report.source_probe.time_base }, frames });
  check(BigInt(timeline.duration) * 1000n === BigInt(reference.source_range.end_ms - reference.source_range.start_ms)
    * BigInt(timeline.timescale), 'MAPPING_REQUIRED');
  return { frames, timeline: { ...timeline, tolerance_ticks: 0 } };
}

function derivationPlans(materials, parents) {
  return materials.references.filter(reference => reference.state === 'needs_derivation').map(reference => {
    const parent = parents.find(value => value.parent.parent_shot_id === reference.parent_shot_id);
    const attachment = JSON.parse(parent.candidate.asset.metadata).redraw_motion_processing;
    check(attachment, 'MAPPING_REQUIRED');
    const mapping = mapFrames(attachment.report, reference);
    const input = { schema_version: 'redraw-unit-reference-derivation-input-v1', bindings: materials.bindings,
      materials_hash: materials.materials_hash, requirement: reference,
      parent: { import_id: parent.candidate.id, asset_id: parent.candidate.stored_asset_id,
        sha256: reference.sha256, processing_report_sha256: attachment.report_sha256,
        processing_material_sha256: attachment.verified.material_binding_sha256,
        processing_provenance: attachment.provenance }, mapping: mapping.frames, recipe };
    return { reference, parent, attachment, ...mapping, input, inputHash: hashPlanValue(input) };
  });
}

function queueUnit(ctx, materials) {
  const b = materials.bindings;
  const unit = ctx.db.prepare(`SELECT u.id FROM redraw_execution_queue_units u
    JOIN redraw_execution_queues q ON q.id = u.queue_id JOIN redraw_versions v ON v.id = q.version_id
    JOIN redraw_works w ON w.id = v.work_id
    WHERE q.id = ? AND q.tenant_id = ? AND q.user_id = ? AND q.work_id = ? AND q.version_id = ?
    AND q.review_id = ? AND q.plan_hash = ? AND u.unit_id = ? AND u.unit_hash = ?
    AND v.tenant_id = q.tenant_id AND v.user_id = q.user_id AND v.work_id = q.work_id AND v.deleted_at IS NULL
    AND w.tenant_id = q.tenant_id AND w.user_id = q.user_id AND w.deleted_at IS NULL`)
    .get(b.queue_id, ctx.tenantId, ctx.userId, b.work_id, b.version_id, b.review_id, b.plan_hash, b.unit_id, b.unit_hash);
  check(unit);
  return unit;
}

function registeredRow(ctx, unit, plan) {
  return ctx.db.prepare(`SELECT * FROM redraw_unit_reference_derivations
    WHERE tenant_id = ? AND user_id = ? AND queue_unit_id = ? AND requirement_id = ? AND input_hash = ?`)
    .get(ctx.tenantId, ctx.userId, unit.id, plan.reference.requirement_id, plan.inputHash);
}

function storedJson(value) {
  try { return JSON.parse(value); } catch { throw failure('INVALID'); }
}

function assertRegisteredOutput(entry) {
  try { assertOutput(entry); }
  catch (error) {
    if (error.code?.startsWith('REDRAW_')) throw error;
    throw failure('OUTPUT_INVALID');
  }
}

function registeredOutput(ctx, materials, plan, row) {
  const b = materials.bindings, geometry = plan.attachment.report.source_probe, timeline = plan.timeline;
  check(row.work_id === b.work_id && row.version_id === b.version_id && row.queue_id === b.queue_id
    && row.input_json === stable(plan.input));
  const envelope = storedJson(row.output_json);
  const asset = ctx.db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(row.output_asset_id);
  check(asset && asset.type === 'video' && asset.category === 'redraw_unit_reference'
    && asset.mime_type === 'video/mp4' && asset.width === geometry.width && asset.height === geometry.height
    && asset.duration === timeline.duration / timeline.timescale
    && stable(storedJson(asset.metadata)) === stable({ schema_version: 'redraw-unit-reference-asset-v1',
      tenant_id: ctx.tenantId, user_id: ctx.userId, input_hash: plan.inputHash, sha256: row.output_sha256 }));
  check(typeof asset.local_path === 'string' && /^redraw-unit-reference\/unit-[A-Za-z0-9]+\/reference-\d+\.mp4$/.test(asset.local_path));
  const file = path.join(ctx.storageRoot, asset.local_path);
  let stat;
  try { stat = checkedPath(file); }
  catch (error) {
    if (error.code?.startsWith('REDRAW_')) throw error;
    throw failure('OUTPUT_INVALID');
  }
  check(stat.size > 0n && stat.size <= BigInt(Number.MAX_SAFE_INTEGER) && asset.file_size === Number(stat.size), 'OUTPUT_INVALID');
  const entry = { file, stat, size: Number(stat.size), sha256: row.output_sha256, row, asset, envelope, plan };
  assertRegisteredOutput(entry);
  return entry;
}

async function outputProof(ctx, file, plan) {
  const actual = await probe(ctx, file), geometry = plan.attachment.report.source_probe, timeline = plan.timeline;
  check([actual.streams?.[0]?.tags?.rotate, ...(actual.streams?.[0]?.side_data_list || []).map(value => value.rotation)]
    .filter(value => value !== undefined).every(value => Number(value) === 0), 'OUTPUT_INVALID');
  return { geometry, timeline, media: verifyOutput(actual, geometry, timeline) };
}

function assertEnvelope(entry, proof) {
  check(stable(entry.envelope) === stable({ proof, sha256: entry.sha256, size: entry.size }));
}

function bindPreparedReference(references, requirementId, assetId, digest, derivationId, inputHash, proofHash) {
  Object.assign(references.find(ref => ref.requirement_id === requirementId), { asset_id: assetId, sha256: digest,
    state: 'reusable', asset_scope: 'unit_derivation', derivation_id: derivationId,
    derivation_input_hash: inputHash, output_proof_hash: proofHash });
}

function preparedMaterials(materials, references) {
  const result = { schema_version: 'redraw-unit-prepared-reference-materials-v1', bindings: materials.bindings,
    materials_hash: materials.materials_hash, references };
  return { ...result, prepared_materials_hash: hashPlanValue(result) };
}

async function readPreparedUnitReferenceMaterials(ctx, expected, consumer, mode) {
  check(expected && Object.getPrototypeOf(expected) === Object.prototype
    && Reflect.ownKeys(expected).length === FIELDS.length - 1
    && FIELDS.slice(0, -1).every(key => Object.hasOwn(expected, key)), 'INVALID');
  const selected = [], missing = [];
  let unit;
  return withUnitReferenceMaterials(ctx, expected, async ({ materials, parents }) => {
    unit = queueUnit(ctx, materials);
    for (const plan of derivationPlans(materials, parents)) {
      const row = registeredRow(ctx, unit, plan);
      if (!row) { missing.push(plan); continue; }
      const entry = registeredOutput(ctx, materials, plan, row);
      assertEnvelope(entry, await outputProof(ctx, entry.file, plan));
      assertRegisteredOutput(entry);
      selected.push(entry);
    }
  }, ({ materials, productionPack, assertCurrent }) => {
    const readCurrent = () => {
      // All media probes and reader cleanup awaits have finished. Reread rows and real
      // output paths now; no expired source/candidate FD or asynchronous work escapes.
      assertCurrent(); check(queueUnit(ctx, materials).id === unit.id);
      for (const entry of selected) {
        check(stable(ctx.db.prepare('SELECT * FROM redraw_unit_reference_derivations WHERE id = ?').get(entry.row.id)) === stable(entry.row)
          && stable(ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(entry.asset.id)) === stable(entry.asset));
        assertRegisteredOutput(entry);
      }
      for (const plan of missing) check(!registeredRow(ctx, unit, plan));
      const result = { schema_version: 'redraw-unit-prepared-reference-inspection-v1', bindings: materials.bindings,
        materials_hash: materials.materials_hash };
      if (missing.length) return { ...result, status: 'needs_preparation',
        missing_requirement_ids: missing.map(plan => plan.reference.requirement_id) };
      const references = structuredClone(materials.references);
      for (const entry of selected) bindPreparedReference(references, entry.plan.reference.requirement_id,
        entry.asset.id, entry.sha256, entry.row.id, entry.plan.inputHash, hashPlanValue(entry.envelope));
      return { ...result, status: 'prepared', prepared_materials: preparedMaterials(materials, references) };
    };
    if (!consumer) return readCurrent();
    if (mode === 'submission') {
      const material = readCurrent();
      check(material.status === 'prepared', 'INVALID');
      const references = material.prepared_materials.references.map(reference => {
        const asset = ctx.db.prepare('SELECT * FROM assets WHERE id=? AND deleted_at IS NULL').get(reference.asset_id);
        check(asset && typeof asset.local_path === 'string' && !path.isAbsolute(asset.local_path));
        const file = path.resolve(ctx.storageRoot, asset.local_path), relative = path.relative(ctx.storageRoot, file);
        check(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
        const before = checkedPath(file);
        const { PREPARED_REFERENCE_MAX_BYTES } = require('./redrawSourceConditioningService');
        const limit = PREPARED_REFERENCE_MAX_BYTES[asset.mime_type];
        check(limit && before.size > 0n && before.size <= BigInt(limit), 'OUTPUT_INVALID');
        const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
          check(sameStat(before, fs.fstatSync(fd, { bigint: true })));
          const bytes = fs.readFileSync(fd);
          check(sameStat(before, checkedPath(file)) && sameStat(before, fs.fstatSync(fd, { bigint: true }))
            && bytes.length === Number(before.size) && sha256(bytes) === reference.sha256);
          check(reference.kind === 'image' ? ['image/png', 'image/jpeg'].includes(asset.mime_type) : asset.mime_type === 'video/mp4');
          return { ...reference, mime_type: asset.mime_type, bytes };
        } finally { fs.closeSync(fd); }
      });
      readCurrent();
      let active = true, consumed = false;
      const consumeCurrent = fn => {
        check(active && !consumed && typeof fn === 'function' && !types.isAsyncFunction(fn), 'INVALID');
        consumed = true;
        return ctx.db.transaction(() => {
          const value = fn(readCurrent());
          check(!value || typeof value.then !== 'function', 'INVALID');
          readCurrent();
          return value;
        }).immediate();
      };
      // All probes/readers have closed. Only byte snapshots and the one-shot final
      // transaction gate survive; never revalidate mutable materials after a POST.
      try {
        return Promise.resolve(consumer({ material, productionPack: structuredClone(productionPack), references, consumeCurrent }))
          .finally(() => { active = false; });
      } catch (error) { active = false; throw error; }
    }
    return ctx.db.transaction(() => {
      const result = consumer(readCurrent());
      check(!result || typeof result.then !== 'function', 'INVALID');
      readCurrent();
      return result;
    })[mode]();
  });
}

async function inspectPreparedUnitReferenceMaterials(ctx, expected) {
  return readPreparedUnitReferenceMaterials(ctx, expected);
}

// Server-only synchronous boundary: no live reader, FD or async continuation is exposed.
async function consumePreparedUnitReferenceMaterials(ctx, expected, consumer, mode) {
  check(typeof consumer === 'function' && !types.isAsyncFunction(consumer)
    && ['deferred', 'immediate'].includes(mode), 'INVALID');
  return readPreparedUnitReferenceMaterials(ctx, expected, consumer, mode);
}

async function withPreparedUnitSubmission(ctx, expected, consumer) {
  check(typeof consumer === 'function', 'INVALID');
  return readPreparedUnitReferenceMaterials(ctx, expected, consumer, 'submission');
}

function expression(values, start = 0, end = values.length) {
  if (end - start === 1) return String(values[start]);
  const middle = Math.floor((start + end) / 2);
  return `if(lt(N,${middle}),${expression(values, start, middle)},${expression(values, middle, end)})`;
}

function assertOutput(entry) {
  const before = checkedPath(entry.file);
  check(sameStat(before, entry.stat) && before.size === BigInt(entry.size));
  check(sha256(fs.readFileSync(entry.file)) === entry.sha256 && sameStat(before, checkedPath(entry.file)));
}

function ownedDirectory(storageRoot) {
  checkedPath(storageRoot, true);
  const base = path.join(storageRoot, 'redraw-unit-reference');
  if (!fs.existsSync(base)) fs.mkdirSync(base, { mode: 0o700 });
  checkedPath(base, true);
  const directory = fs.mkdtempSync(path.join(base, 'unit-'));
  let stat;
  try { stat = checkedPath(directory, true); }
  catch (error) {
    // Creation succeeded, but this directory's identity is unknown: retain it and report the residual.
    throw Object.assign(error, { cleanup_code: 'UNAVAILABLE' });
  }
  return { directory, assert: () => check(sameIdentity(stat, checkedPath(directory, true))) };
}

function cleanupOutputs(owned, entries) {
  if (!owned || owned.cleaned) return;
  owned.assert();
  for (const entry of entries) {
    if (!entry.exists) continue;
    check(sameIdentity(entry.identity, checkedPath(entry.file)));
    fs.unlinkSync(entry.file); entry.exists = false;
  }
  if (fs.readdirSync(owned.directory).length === 0) {
    fs.rmdirSync(owned.directory); owned.cleaned = true;
  }
}

async function prepareUnitReferenceMaterials(ctx, input) {
  check(input && Object.getPrototypeOf(input) === Object.prototype && Reflect.ownKeys(input).length === FIELDS.length
    && FIELDS.every(key => Object.hasOwn(input, key)) && /^[a-f0-9]{64}$/.test(input.expected_materials_hash), 'INVALID');
  const { expected_materials_hash: expectedHash, ...expected } = input;
  const outputs = [];
  let owned, committed = false;
  try {
    return await withUnitReferenceMaterials(ctx, expected, async ({ materials, parents, source, assertCurrent }) => {
      check(materials.materials_hash === expectedHash);
      // Validate all mappings before creating persistent outputs.
      const plans = derivationPlans(materials, parents);
      if (!plans.length) return;
      owned = ownedDirectory(ctx.storageRoot);
      const copies = [];
      let primaryError;
      try {
        for (const [index, plan] of plans.entries()) {
          ctx.signal?.throwIfAborted(); assertCurrent(); source.assertCurrentBinding(); source.assertPrivateDirectory();
          const copy = { file: path.join(source.directory, `unit-parent-${index}.mp4`), handle: null, identity: null };
          copies.push(copy);
          copy.handle = await fs.promises.open(copy.file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR
            | (fs.constants.O_NOFOLLOW || 0), 0o600);
          copy.created = true;
          copy.identity = fs.fstatSync(copy.handle.fd, { bigint: true });
          const hash = crypto.createHash('sha256'); let size = 0;
          for await (const chunk of plan.parent.handle.createReadStream()) {
            ctx.signal?.throwIfAborted();
            await copy.handle.writeFile(chunk); hash.update(chunk); size += chunk.length;
          }
          check(hash.digest('hex') === plan.reference.sha256 && size === plan.attachment.report.output.size);
          check(sameIdentity(copy.identity, checkedPath(copy.file)));
          Object.assign(copy, { size, sha256: plan.reference.sha256, stat: fs.fstatSync(copy.handle.fd, { bigint: true }) });
          await copy.handle.close(); copy.handle = null;
          plan.parent.handle.assertCurrentBinding(); source.assertCurrentBinding();
          await verifyProcessingUpload(copy.file, structuredClone(plan.attachment));
          assertOutput(copy);
          const output = { file: path.join(owned.directory, `reference-${index}.mp4`), exists: false, handle: null,
            reference: plan.reference, plan };
          outputs.push(output); owned.assert();
          output.handle = await fs.promises.open(output.file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR
            | (fs.constants.O_NOFOLLOW || 0), 0o600);
          output.exists = true; output.identity = fs.fstatSync(output.handle.fd, { bigint: true });
          const timeline = plan.timeline, geometry = plan.attachment.report.source_probe;
          const filters = `select='between(n,${plan.frames[0].parent_frame_ordinal},${plan.frames.at(-1).parent_frame_ordinal})',`
            + `settb=expr=1/${timeline.timescale},setpts='${expression(timeline.frames.map(frame => frame.pts))}',`
            + `setsar=${geometry.sample_aspect_ratio.replace(':', '/')}:max=65535`;
          const filter = { file: path.join(source.directory, `unit-filter-${index}.txt`), handle: null, identity: null };
          copies.push(filter); source.assertPrivateDirectory();
          filter.handle = await fs.promises.open(filter.file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR
            | (fs.constants.O_NOFOLLOW || 0), 0o600);
          filter.created = true;
          filter.identity = fs.fstatSync(filter.handle.fd, { bigint: true });
          await filter.handle.writeFile(filters, 'utf8');
          Object.assign(filter, { size: Buffer.byteLength(filters), sha256: sha256(filters),
            stat: fs.fstatSync(filter.handle.fd, { bigint: true }) });
          await filter.handle.close(); filter.handle = null;
          assertOutput(copy); assertOutput(filter);
          await run(ctx, getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-noautorotate', '-i', copy.file,
            '-map', '0:v:0', '-an', '-map_metadata', '-1', '-filter_script:v', filter.file, '-c:v', 'libx264', '-preset', recipe.preset,
            '-crf', String(recipe.crf), '-pix_fmt', recipe.pixel_format, '-bf', '0', '-fps_mode', 'passthrough',
            '-enc_time_base', `1/${timeline.timescale}`, '-video_track_timescale', String(timeline.timescale),
            '-bsf:v', `setts=duration='if(eq(N,${timeline.frames.length - 1}),${timeline.frames.at(-1).duration},DURATION)':time_base=1/${timeline.timescale}`,
            output.file]);
          assertOutput(copy); assertOutput(filter);
          output.stat = fs.fstatSync(output.handle.fd, { bigint: true });
          check(sameIdentity(output.identity, output.stat) && sameStat(output.stat, checkedPath(output.file))
            && output.stat.size > 0n && output.stat.size <= BigInt(Number.MAX_SAFE_INTEGER), 'OUTPUT_INVALID');
          output.proof = await outputProof(ctx, output.file, plan);
          output.size = Number(output.stat.size); output.sha256 = sha256(fs.readFileSync(output.file));
          assertOutput(output); plan.parent.handle.assertCurrentBinding(); assertCurrent(); source.assertCurrentBinding();
          output.input = plan.input; output.inputHash = plan.inputHash;
        }
      } catch (error) { primaryError = error; throw error; }
      finally {
        let cleanupError, bindingError;
        for (const entry of [...outputs, ...copies]) {
          try { await entry.handle?.close(); entry.handle = null; }
          catch (error) { cleanupError ??= error; }
        }
        for (const copy of copies) {
          try {
            if (!copy.identity) {
              // The exclusive open succeeded, but ownership identity could not be established.
              // Retain this unknown file and report the residual instead of guessing what to unlink.
              if (copy.created) cleanupError ??= failure('CLEANUP_FAILED');
              continue;
            }
            source.assertPrivateDirectory(); check(sameIdentity(copy.identity, checkedPath(copy.file)));
            if (copy.stat) { try { assertOutput(copy); } catch (error) { bindingError ??= error; } }
            await fs.promises.unlink(copy.file);
          } catch (error) { cleanupError ??= error; }
        }
        if (cleanupError) {
          const code = ['EIO', 'EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY', 'ENOENT', 'EBADF'].includes(cleanupError.code)
            ? cleanupError.code : 'UNAVAILABLE';
          if (primaryError) primaryError.cleanup_code = code;
          else throw Object.assign(failure('CLEANUP_FAILED'), { cleanup_code: code });
        }
        if (!primaryError && bindingError) throw bindingError;
      }
    }, ({ materials, assertCurrent }) => {
      const value = ctx.db.transaction(() => {
        assertCurrent();
        const b = materials.bindings;
        const unit = queueUnit(ctx, materials);
        const references = structuredClone(materials.references), losers = [], retained = [];
        for (const output of outputs) {
          owned.assert(); assertOutput(output);
          const old = registeredRow(ctx, unit, output.plan);
          let assetId, digest, derivationId, proofHash;
          if (old) {
            const retainedOutput = registeredOutput(ctx, materials, output.plan, old);
            assertEnvelope(retainedOutput, output.proof); retained.push(retainedOutput);
            assetId = old.output_asset_id; digest = old.output_sha256; derivationId = old.id;
            proofHash = hashPlanValue(retainedOutput.envelope); losers.push(output);
          } else {
            const local = path.relative(ctx.storageRoot, output.file).split(path.sep).join('/');
            const metadata = stable({ schema_version: 'redraw-unit-reference-asset-v1', tenant_id: ctx.tenantId,
              user_id: ctx.userId, input_hash: output.inputHash, sha256: output.sha256 });
            assetId = Number(ctx.db.prepare(`INSERT INTO assets
              (name, type, category, local_path, mime_type, width, height, duration, file_size, metadata)
              VALUES ('Unit motion reference', 'video', 'redraw_unit_reference', ?, 'video/mp4', ?, ?, ?, ?, ?)`)
              .run(local, output.proof.geometry.width, output.proof.geometry.height,
                output.proof.timeline.duration / output.proof.timeline.timescale, output.size, metadata).lastInsertRowid);
            const proof = { proof: output.proof, sha256: output.sha256, size: output.size };
            derivationId = Number(ctx.db.prepare(`INSERT INTO redraw_unit_reference_derivations
              (tenant_id, user_id, work_id, version_id, queue_id, queue_unit_id, requirement_id, input_hash,
               input_json, output_json, output_asset_id, output_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(ctx.tenantId, ctx.userId, b.work_id, b.version_id, b.queue_id, unit.id, output.reference.requirement_id,
                output.inputHash, stable(output.input), stable(proof), assetId, output.sha256, new Date().toISOString()).lastInsertRowid);
            digest = output.sha256; proofHash = hashPlanValue(proof);
            retained.push(output);
          }
          bindPreparedReference(references, output.reference.requirement_id, assetId, digest, derivationId, output.inputHash, proofHash);
        }
        // No await after this authority check. Remove only this invocation's unpublished duplicate files.
        if (losers.length) cleanupOutputs(owned, losers);
        assertCurrent();
        for (const output of retained) assertOutput(output);
        return preparedMaterials(materials, references);
      }).immediate();
      committed = true;
      return value;
    });
  } catch (error) {
    if (!committed) {
      try { cleanupOutputs(owned, outputs); }
      catch (cleanupError) { error.cleanup_code = cleanupError?.code || 'CLEANUP_FAILED'; }
    }
    throw error;
  }
}

module.exports = { prepareUnitReferenceMaterials, inspectPreparedUnitReferenceMaterials, consumePreparedUnitReferenceMaterials, withPreparedUnitSubmission };
