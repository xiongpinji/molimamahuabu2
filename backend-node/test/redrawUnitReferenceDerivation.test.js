'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { execFile } = require('node:child_process');
const { fixture, hash, probe, decodeRgb } = require('./helpers/redrawUnitReferenceDerivationFixture');
const servicePath = path.join(__dirname, '../src/services/redrawUnitReferenceDerivationService.js');
function preparer() {
  const service = fs.existsSync(servicePath) ? require(servicePath) : {};
  assert.equal(typeof service.prepareUnitReferenceMaterials, 'function', 'explicit unit derivation entry is required');
  return service.prepareUnitReferenceMaterials;
}

const count = h => h.db.prepare("SELECT count(*) n FROM assets WHERE category = 'redraw_unit_reference'").get().n;
const records = h => h.db.prepare('SELECT count(*) n FROM redraw_unit_reference_derivations').get().n;
const outputFiles = h => fs.existsSync(path.join(h.root, 'redraw-unit-reference'))
  ? fs.readdirSync(path.join(h.root, 'redraw-unit-reference'), { recursive: true }).filter(file => file.endsWith('.mp4')) : [];
async function inputFor(h, index) { return { ...h.expected(index), expected_materials_hash: (await h.materials(index)).materials_hash }; }
function outputPath(h, reference) {
  return path.join(h.root, h.db.prepare('SELECT local_path FROM assets WHERE id = ?').get(reference.asset_id).local_path);
}
function compareFrames(actual, originals, indexes) {
  assert.equal(actual.length, indexes.length);
  const difference = (left, right) => left.reduce((sum, value, index) => sum + Math.abs(value - right[index]), 0) / left.length;
  for (const [i, pixels] of actual.entries()) {
    const scores = originals.map(original => difference(pixels, original));
    assert.equal(scores.indexOf(Math.min(...scores)), indexes[i], `output frame ${i} comes from the selected parent ordinal`);
    assert.ok(scores[indexes[i]] < 12, `second lossy encode stays close to selected parent pixels: ${scores[indexes[i]]}`);
  }
}
function retain(h, label, reference) {
  const root = process.env.G4_DERIVATION_EVIDENCE_ROOT;
  if (!root) return;
  const file = outputPath(h, reference), target = path.join(root, `${label}.mp4`);
  fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
  const row = h.db.prepare('SELECT * FROM redraw_unit_reference_derivations WHERE id = ?').get(reference.derivation_id);
  fs.writeFileSync(path.join(root, `${label}.json`), JSON.stringify({ reference, sha256: hash(fs.readFileSync(target)),
    probe: probe(target), input: JSON.parse(row.input_json), output: JSON.parse(row.output_json) }, null, 2), { flag: 'wx' });
  const parentAsset = h.db.prepare('SELECT local_path FROM assets WHERE id = ?').get(JSON.parse(row.input_json).parent.asset_id);
  fs.copyFileSync(path.join(h.root, parentAsset.local_path), path.join(root, `${label}-parent.mp4`), fs.constants.COPYFILE_EXCL);
}
async function afterCandidateClose(h, mutate, action) {
  const original = fs.promises.open;
  const parent = h.processed.at(-1);
  const candidatePath = path.resolve(h.root, h.db.prepare('SELECT local_path FROM assets WHERE id = ?').get(parent.imported.asset.id).local_path);
  let injected = false;
  fs.promises.open = async function(file, ...args) {
    const handle = await original.call(this, file, ...args);
    if (path.resolve(String(file)) === candidatePath) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        const result = await close();
        if (!injected) { injected = true; mutate(); }
        return result;
      };
    }
    return handle;
  };
  try { await action(); assert.equal(injected, true, 'mutated after actual candidate cleanup await'); }
  finally { fs.promises.open = original; }
}

test('real processor/import/bind fixture establishes a current partial unit before derivation', async t => {
  const h = await fixture(t);
  assert.equal(h.queueState.queue.status, 'waiting_readiness');
  assert.equal(h.processed.length, 1);
  const parent = h.processed[0];
  assert.equal(parent.report.frames.length, 4);
  assert.equal(parent.report.timing.timescale, 64000);
  const metadata = JSON.parse(h.db.prepare('SELECT metadata FROM assets WHERE id = ?').get(parent.imported.asset.id).metadata);
  assert.equal(metadata.redraw_motion_processing.verified.output_media_verified, true);
  assert.equal(metadata.redraw_motion_processing.verified.renderer_origin_verified, false);
  const materials = await h.materials(1);
  assert.deepEqual(materials.references.map(ref => [ref.requirement_id, ref.state, ref.source_range]),
    [['motion-shot-1', 'needs_derivation', { start_ms: 5000, end_ms: 10000 }]]);
  assert.deepEqual(fs.readdirSync(h.ctx.tempRoot), []);
});

test('partial unit retains its displayed first frame and exact tail in registered VFR media', async t => {
  const h = await fixture(t);
  const materials = await h.materials(1);
  const result = await preparer()(h.ctx, { ...h.expected(1), expected_materials_hash: materials.materials_hash });
  assert.equal(result.schema_version, 'redraw-unit-prepared-reference-materials-v1');
  assert.equal(result.references.length, 1);
  const ref = result.references[0];
  assert.equal(ref.requirement_id, 'motion-shot-1');
  assert.equal(ref.state, 'reusable');
  assert.equal(ref.asset_scope, 'unit_derivation');
  const row = h.db.prepare('SELECT * FROM redraw_unit_reference_derivations').get();
  assert.equal(row.output_asset_id, ref.asset_id);
  const asset = h.db.prepare('SELECT * FROM assets WHERE id = ?').get(ref.asset_id);
  const output = path.join(h.root, asset.local_path);
  assert.equal(hash(fs.readFileSync(output)), ref.sha256);
  const actual = probe(output);
  assert.equal(actual.streams.length, 1);
  assert.equal(actual.streams[0].time_base, '1/64000');
  assert.equal(actual.streams[0].sample_aspect_ratio, '4:3');
  assert.equal(actual.streams[0].display_aspect_ratio, '2:1');
  assert.deepEqual(actual.frames.map(frame => [Number(frame.pts), Number(frame.duration ?? frame.pkt_duration)]), [[0, 128000], [128000, 192000]]);
  assert.equal(Number(actual.streams[0].duration_ts), 320000);
  const parentPath = path.join(h.root, h.db.prepare('SELECT local_path FROM assets WHERE id = ?').get(h.processed[0].imported.asset.id).local_path);
  compareFrames(decodeRgb(output, 96, 64), decodeRgb(parentPath, 96, 64), [1, 2]);
  retain(h, 'inside-frame-vfr', ref);
  const tail = await preparer()(h.ctx, await inputFor(h, 2));
  const tailProbe = probe(outputPath(h, tail.references[0]));
  assert.deepEqual(tailProbe.frames.map(frame => [Number(frame.pts), Number(frame.duration ?? frame.pkt_duration)]), [[0, 128000]]);
  compareFrames(decodeRgb(outputPath(h, tail.references[0]), 96, 64), decodeRgb(parentPath, 96, 64), [3]);
  retain(h, 'single-tail-frame', tail.references[0]);
  assert.deepEqual(fs.readdirSync(h.ctx.tempRoot), []);
});

test('whole-parent reuse changes neither old inspection nor assets and does not require a processing map', async t => {
  const h = await fixture(t, { durations: [15], reports: false });
  const before = await h.materials(0), countBefore = h.db.prepare('SELECT count(*) n FROM assets').get().n;
  const result = await preparer()(h.ctx, { ...h.expected(0), expected_materials_hash: before.materials_hash });
  assert.deepEqual(result.references, before.references);
  assert.equal(records(h), 0); assert.equal(count(h), 0);
  assert.equal(h.db.prepare('SELECT count(*) n FROM assets').get().n, countBefore);
  assert.deepEqual(await h.materials(0), before);
  assert.deepEqual(outputFiles(h), []);
  assert.doesNotMatch(JSON.stringify(result), /local_path|directory|handle|https?:|executable|price|credits/);
});

test('cross-parent unit keeps original order and selects parent array ordinal, not global frame ID', async t => {
  const h = await fixture(t, { parentRanges: [[0, 3000], [3000, 7000], [7000, 12000]] });
  const result = await preparer()(h.ctx, await inputFor(h, 1));
  assert.deepEqual(result.references.map(ref => ref.requirement_id), ['motion-shot-2', 'motion-shot-3']);
  assert.equal(records(h), 2); assert.equal(count(h), 2);
  const rows = h.db.prepare('SELECT input_json FROM redraw_unit_reference_derivations ORDER BY id').all().map(row => JSON.parse(row.input_json));
  assert.deepEqual(rows.map(row => row.mapping.map(frame => [frame.frame_index, frame.parent_frame_ordinal])), [[[1, 1]], [[2, 0]]]);
  for (const [index, reference] of result.references.entries()) {
    const expectedDuration = index ? 3000 : 2000;
    const actual = probe(outputPath(h, reference));
    assert.equal(Number(actual.streams[0].duration_ts), expectedDuration * 64);
    const parentAsset = h.db.prepare('SELECT local_path FROM assets WHERE id = ?').get(rows[index].parent.asset_id);
    compareFrames(decodeRgb(outputPath(h, reference), 96, 64), decodeRgb(path.join(h.root, parentAsset.local_path), 96, 64), [index ? 0 : 1]);
    retain(h, `cross-parent-${index}`, reference);
  }
  assert.deepEqual(fs.readdirSync(h.ctx.tempRoot), []);
});

test('missing processing mapping and untrusted caller fields create zero registrations', async t => {
  const h = await fixture(t, { reports: false });
  const input = await inputFor(h, 1);
  for (const extra of [{ path: h.root }, { frames: [] }, { model: 'caller' }, { approved: true }]) {
    await assert.rejects(preparer()(h.ctx, { ...input, ...extra }), { code: 'REDRAW_UNIT_REFERENCE_DERIVATION_INVALID' });
  }
  await assert.rejects(preparer()(h.ctx, { ...input, expected_materials_hash: 'f'.repeat(64) }), { code: 'REDRAW_UNIT_REFERENCE_DERIVATION_STALE' });
  await assert.rejects(preparer()(h.ctx, input), { code: 'REDRAW_UNIT_REFERENCE_DERIVATION_MAPPING_REQUIRED' });
  assert.equal(records(h), 0); assert.equal(count(h), 0); assert.deepEqual(outputFiles(h), []);
});

test('two connections publish one authoritative result and metadata alone cannot impersonate it', async t => {
  let second;
  t.after(() => second?.close()); // Close the extra connection before the existing fixture's directory cleanup.
  const h = await fixture(t);
  h.db.prepare(`INSERT INTO assets (name, type, category, local_path, metadata) VALUES ('fake', 'video',
    'redraw_unit_reference', 'source/source.mp4', ?)`)
    .run(JSON.stringify({ schema_version: 'redraw-unit-reference-asset-v1', tenant_id: 'tenant-a', user_id: 'user-a',
      sha256: h.sourceFingerprint, input_hash: 'f'.repeat(64) }));
  const input = await inputFor(h, 1);
  second = new Database(h.db.name);
  const beforeCount = count(h);
  const results = await Promise.all([preparer()(h.ctx, input), preparer()({ ...h.ctx, db: second }, input)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(records(h), 1); assert.equal(count(h), beforeCount + 1); assert.equal(outputFiles(h).length, 1);
  assert.deepEqual(await preparer()(h.ctx, input), results[0]);
  assert.equal(outputFiles(h).length, 1);
  const row = h.db.prepare('SELECT * FROM redraw_unit_reference_derivations').get();
  assert.throws(() => h.db.prepare("UPDATE redraw_unit_reference_derivations SET output_json = '{}' WHERE id = ?").run(row.id), /immutable/);
  const file = outputPath(h, results[0].references[0]); const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
  await assert.rejects(preparer()(h.ctx, input), { code: 'REDRAW_UNIT_REFERENCE_DERIVATION_STALE' });
  assert.equal(records(h), 1); assert.equal(outputFiles(h).length, 1, 'winner is not removed when its bytes are invalid');
});

test('changed private parent copy during real encoder execution is rejected before publication', async t => {
  const h = await fixture(t), input = await inputFor(h, 1);
  let replaced = false;
  const local = { ...h.ctx, execFile: (binary, args, options, callback) => {
    const copiedParent = args[args.indexOf('-i') + 1];
    if (!replaced && args.includes('-filter_script:v') && path.basename(String(copiedParent)).startsWith('unit-parent-')) {
      // Still decodable with identical geometry/timing, but not the approved processed-parent bytes.
      fs.copyFileSync(path.join(h.root, 'source/source.mp4'), copiedParent); replaced = true;
    }
    return execFile(binary, args, options, callback);
  } };
  await assert.rejects(preparer()(local, input), { code: 'REDRAW_UNIT_REFERENCE_DERIVATION_STALE' });
  assert.equal(replaced, true);
  assert.equal(records(h), 0); assert.equal(count(h), 0); assert.deepEqual(outputFiles(h), []);
  assert.deepEqual(fs.readdirSync(h.ctx.tempRoot), [], 'owned changed copy is still cleaned after rejecting its bytes');
});

test('private cleanup failure records the safe residual reason and does not publish', async t => {
  const h = await fixture(t), input = await inputFor(h, 1), original = fs.promises.unlink;
  let refused = false;
  fs.promises.unlink = async function(file, ...args) {
    if (path.basename(String(file)).startsWith('unit-parent-')) {
      refused = true; throw Object.assign(new Error('fixture private cleanup denied'), { code: 'EACCES' });
    }
    return original.call(this, file, ...args);
  };
  try {
    await assert.rejects(preparer()(h.ctx, input), { code: 'REDRAW_UNIT_REFERENCE_DERIVATION_CLEANUP_FAILED', cleanup_code: 'EACCES' });
    assert.equal(refused, true); assert.equal(records(h), 0); assert.equal(count(h), 0); assert.deepEqual(outputFiles(h), []);
    assert.equal(fs.readdirSync(h.ctx.tempRoot).length, 1, 'failed owned private cleanup is not concealed');
  } finally { fs.promises.unlink = original; }
});

test('changed private filter bytes during real encoding cannot publish a result', async t => {
  const h = await fixture(t), input = await inputFor(h, 1);
  let changed = false;
  const local = { ...h.ctx, execFile: (binary, args, options, callback) => {
    if (args.includes('-filter_script:v')) {
      const file = args[args.indexOf('-filter_script:v') + 1];
      fs.appendFileSync(file, '\n'); changed = true; // Still parses, but no longer the verified recipe bytes.
    }
    return execFile(binary, args, options, callback);
  } };
  await assert.rejects(preparer()(local, input), { code: 'REDRAW_UNIT_REFERENCE_DERIVATION_STALE' });
  assert.equal(changed, true);
  assert.equal(records(h), 0); assert.equal(count(h), 0); assert.deepEqual(outputFiles(h), []);
  assert.deepEqual(fs.readdirSync(h.ctx.tempRoot), []);
});

test('first private-parent stat failure closes its real FD and reports the unidentified residual without deleting it', async t => {
  const h = await fixture(t), input = await inputFor(h, 1), originalOpen = fs.promises.open, originalStat = fs.fstatSync;
  let fd, injected = false;
  fs.promises.open = async function(file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    if (path.basename(String(file)).startsWith('unit-parent-')) fd = handle.fd;
    return handle;
  };
  fs.fstatSync = function(value, ...args) {
    if (value === fd && !injected) { injected = true; throw Object.assign(new Error('fixture first private stat'), { code: 'EIO' }); }
    return originalStat.call(this, value, ...args);
  };
  try {
    await assert.rejects(preparer()(h.ctx, input), error => {
      assert.equal(injected, true, 'fault targets the newly opened actual parent-copy FD');
      assert.equal(error.code, 'EIO'); assert.equal(error.cleanup_code, 'UNAVAILABLE'); return true;
    });
    assert.equal(records(h), 0); assert.equal(count(h), 0); assert.deepEqual(outputFiles(h), []);
    assert.equal(fs.readdirSync(h.ctx.tempRoot).length, 1, 'unknown file identity is retained, not guessed');
  } finally { fs.promises.open = originalOpen; fs.fstatSync = originalStat; }
  assert.throws(() => originalStat(fd), { code: 'EBADF' });
});

test('first output-directory stat failure preserves and reports the real unidentified empty directory', async t => {
  const h = await fixture(t), input = await inputFor(h, 1);
  const originalMkdtemp = fs.mkdtempSync, originalLstat = fs.lstatSync;
  let created, injected = false, error, creations = 0;
  fs.mkdtempSync = function(prefix, ...args) {
    const result = originalMkdtemp.call(this, prefix, ...args);
    if (path.resolve(String(prefix)) === path.join(h.root, 'redraw-unit-reference', 'unit-')) {
      created = result; creations += 1;
    }
    return result;
  };
  fs.lstatSync = function(file, ...args) {
    if (created && !injected && path.resolve(String(file)) === created) {
      injected = true; throw Object.assign(new Error('fixture first output-directory stat'), { code: 'EIO' });
    }
    return originalLstat.call(this, file, ...args);
  };
  try { await preparer()(h.ctx, input); }
  catch (failure) { error = failure; }
  finally { fs.mkdtempSync = originalMkdtemp; fs.lstatSync = originalLstat; }
  assert.equal(injected, true, 'fault follows the actual successful exclusive directory creation');
  assert.equal(creations, 1); assert.equal(originalLstat(created).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(created), [], 'unknown identity is not guessed and its directory is retained');
  assert.equal(error?.code, 'EIO');
  assert.equal(records(h), 0); assert.equal(count(h), 0); assert.deepEqual(outputFiles(h), []);
  t.diagnostic(JSON.stringify({ injected, creations, residualExists: fs.existsSync(created),
    entries: fs.readdirSync(created), code: error.code, cleanup_code: error.cleanup_code ?? null, records: records(h), assets: count(h) }));
  assert.equal(error.cleanup_code, 'UNAVAILABLE', 'a real unidentified directory residual must be reported');
});

test('a non-integral source-tick parent boundary uses exact LCM milliseconds without rounding', async t => {
  const h = await fixture(t, { parentRanges: [[0, 123], [123, 12000]] });
  const result = await preparer()(h.ctx, await inputFor(h, 0));
  assert.deepEqual(result.references.map(ref => ref.asset_scope), ['original_parent', 'unit_derivation']);
  const ref = result.references[1], actual = probe(outputPath(h, ref));
  assert.equal(actual.streams[0].time_base, '1/64000');
  assert.deepEqual(actual.frames.map(frame => [Number(frame.pts), Number(frame.duration ?? frame.pkt_duration)]), [[0, 280128], [280128, 32000]]);
  assert.equal(Number(actual.streams[0].duration_ts), 312128);
  assert.equal(312128 / 64000 * 1000, 4877);
  retain(h, 'fractional-source-tick-boundary', ref);
});

test('last awaited candidate cleanup cannot publish after owner, approval, source or output drift', async t => {
  const h = await fixture(t), input = await inputFor(h, 1);
  for (const kind of ['owner', 'approval', 'source', 'output', 'cancel']) await t.test(kind, async () => {
    const sourcePath = path.join(h.root, 'source/source.mp4'), originalSource = fs.readFileSync(sourcePath);
    const controller = new AbortController();
    try {
      await afterCandidateClose(h, () => {
        if (kind === 'owner') h.db.prepare("UPDATE tenant_members SET status = 'disabled' WHERE user_id = 'user-a'").run();
        if (kind === 'approval') h.db.prepare("UPDATE redraw_assets SET approval_status = 'pending' WHERE id = 205").run();
        if (kind === 'source') { const changed = Buffer.from(originalSource); changed[changed.length - 1] ^= 1; fs.writeFileSync(sourcePath, changed); }
        if (kind === 'output') {
          const file = path.join(h.root, 'redraw-unit-reference', outputFiles(h)[0]);
          const changed = fs.readFileSync(file); changed[changed.length - 1] ^= 1; fs.writeFileSync(file, changed);
        }
        if (kind === 'cancel') controller.abort(new Error('fixture final cancellation'));
      }, () => assert.rejects(preparer()({ ...h.ctx, signal: controller.signal }, input)));
      assert.equal(records(h), 0); assert.equal(count(h), 0); assert.deepEqual(outputFiles(h), []);
    } finally {
      h.db.prepare("UPDATE tenant_members SET status = 'active' WHERE user_id = 'user-a'").run();
      h.db.prepare("UPDATE redraw_assets SET approval_status = 'approved' WHERE id = 205").run();
      if (kind === 'source') fs.writeFileSync(sourcePath, originalSource);
    }
  });
});

test('cross-parent transaction failure rolls back all registrations and removes only new output files', async t => {
  const h = await fixture(t, { parentRanges: [[0, 3000], [3000, 7000], [7000, 12000]] });
  h.db.exec(`CREATE TRIGGER fixture_reject_second BEFORE INSERT ON redraw_unit_reference_derivations
    WHEN NEW.requirement_id = 'motion-shot-3' BEGIN SELECT RAISE(ABORT, 'fixture second registration rejected'); END;`);
  await assert.rejects(preparer()(h.ctx, await inputFor(h, 1)), /fixture second registration rejected/);
  assert.equal(records(h), 0); assert.equal(count(h), 0); assert.deepEqual(outputFiles(h), []);
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_reference_artifact_imports').get().n, 3);
  assert.deepEqual(fs.readdirSync(h.ctx.tempRoot), []);
});

test('final synchronous material recheck cannot publish an output whose bytes changed after its first check', async t => {
  const h = await fixture(t), input = await inputFor(h, 1), originalRead = fs.readFileSync;
  let changed = false;
  fs.readFileSync = function(file, ...args) {
    if (!changed && typeof file === 'string' && file.endsWith('redraw-full-frame-reviewed-manifest.json') && records(h) === 1) {
      const output = path.join(h.root, 'redraw-unit-reference', outputFiles(h)[0]);
      const bytes = originalRead.call(this, output); bytes[bytes.length - 1] ^= 1;
      fs.writeFileSync(output, bytes); changed = true;
    }
    return originalRead.call(this, file, ...args);
  };
  try {
    await assert.rejects(preparer()(h.ctx, input), { code: 'REDRAW_UNIT_REFERENCE_DERIVATION_STALE' });
    assert.equal(changed, true, 'injected during the final material check inside the actual transaction');
    assert.equal(records(h), 0); assert.equal(count(h), 0); assert.deepEqual(outputFiles(h), []);
  } finally { fs.readFileSync = originalRead; t.diagnostic(`final synchronous output mutation injected=${changed}`); }
});

test('ordinary twenty-five-fps source produces all 125 frames of a five-second unit', async t => {
  const h = await fixture(t, { boundariesMs: Array.from({ length: 301 }, (_, index) => index * 40) });
  assert.equal(h.processed[0].report.frames.length, 300, 'actual processed parent prerequisite');
  let captured = false;
  const local = { ...h.ctx, execFile: (binary, args, options, callback) => {
    if (args.includes('-filter_script:v')) {
      const filter = args[args.indexOf('-filter_script:v') + 1], script = fs.readFileSync(filter, 'utf8');
      assert.ok(args.join(' ').length < 2048, 'frame table does not grow process argv');
      assert.ok(script.includes('setpts=\'if(lt(N,62)'), 'balanced selection is read from the owned private script');
      assert.equal(path.dirname(filter), path.dirname(args[args.indexOf('-i') + 1]));
      assert.match(args[args.indexOf('-bsf:v') + 1], /if\(eq\(N,124\),2560,DURATION\)/);
      captured = true;
    }
    return execFile(binary, args, options, callback);
  } };
  const result = await preparer()(local, await inputFor(h, 1));
  assert.equal(captured, true);
  const ref = result.references[0], actual = probe(outputPath(h, ref));
  assert.equal(actual.frames.length, 125); assert.equal(actual.packets.length, 125);
  assert.equal(Number(actual.streams[0].duration_ts), 320000);
  assert.ok(actual.frames.every((frame, index) => Number(frame.pts) === index * 2560 && Number(frame.duration ?? frame.pkt_duration) === 2560));
  retain(h, 'ordinary-25fps-unit', ref);
});

test('successful loser-directory cleanup is not repeated when final winner validation rejects', async t => {
  const h = await fixture(t), input = await inputFor(h, 1), first = await preparer()(h.ctx, input);
  const winner = outputPath(h, first.references[0]), bytes = fs.readFileSync(winner);
  const originalUnlink = fs.unlinkSync, originalRmdir = fs.rmdirSync;
  let loser, removedDirectory, error, injected = false, removals = 0;
  fs.unlinkSync = function(file, ...args) {
    if (!injected && typeof file === 'string' && file.endsWith('.mp4') && file !== winner
      && path.dirname(path.dirname(file)) === path.join(h.root, 'redraw-unit-reference')) {
      loser = file;
      const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
      fs.writeFileSync(winner, changed); injected = true;
    }
    return originalUnlink.call(this, file, ...args);
  };
  fs.rmdirSync = function(file, ...args) {
    const result = originalRmdir.call(this, file, ...args);
    if (loser && file === path.dirname(loser)) { removedDirectory = file; removals += 1; }
    return result;
  };
  try { await preparer()(h.ctx, input); }
  catch (failure) { error = failure; }
  finally { fs.unlinkSync = originalUnlink; fs.rmdirSync = originalRmdir; }
  assert.equal(injected, true, 'winner mutation occurs during actual unpublished loser removal');
  assert.ok(removedDirectory); assert.equal(fs.existsSync(removedDirectory), false);
  assert.equal(removals, 1); assert.equal(fs.existsSync(loser), false);
  assert.equal(error?.code, 'REDRAW_UNIT_REFERENCE_DERIVATION_STALE');
  assert.equal(error.cleanup_code, undefined, 'successfully removed owned directory is not a cleanup residual');
  assert.equal(records(h), 1); assert.equal(count(h), 1); assert.equal(outputFiles(h).length, 1);
  assert.equal(fs.existsSync(winner), true); assert.notEqual(hash(fs.readFileSync(winner)), hash(bytes));
});
