const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { fixture, snapshot, sha256, probe, encodeFrames, decodeRgb } = require('./helpers/redrawMotionObscurationFixture');
const { loadReviewedMotionCoverage } = require('../src/services/redrawReferenceBundleService');
const { withSourceVideoSnapshot } = require('../src/services/redrawSourceVideoService');
const servicePath = '../src/services/redrawMotionObscurationService';
const withMotionObscuration = fs.existsSync(path.join(__dirname, servicePath + '.js')) ? require(servicePath).withMotionObscuration : undefined;

async function bytes(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }

test('controlled motion and source callbacks exist', () => {
  assert.equal(typeof withMotionObscuration, 'function');
  assert.equal(typeof withSourceVideoSnapshot, 'function');
});

test('real source fixture is decoded to reviewed coverage without mocking the trusted reader', async (t) => {
  const f = await fixture(t);
  const input = await loadReviewedMotionCoverage(f.ctx, f.input);
  assert.equal(input.source.time_base.denominator, 30000);
  assert.deepEqual(input.frames.map((frame) => frame.timestamp_ticks), f.sourceProbe.frames.map((frame) => Number(frame.best_effort_timestamp)));
  for (const frame of input.frames) assert.deepEqual(await sharp(frame.path).removeAlpha().raw().toBuffer(), f.decoded[frame.frame_index]);
});

for (const geometry of [{ width: 96, height: 64, sar: '4:3', timescale: 30000 },
  { width: 64, height: 96, sar: '1:1', timescale: 90000 }]) {
  test(`real moving ${geometry.width}x${geometry.height} union pixels and encoded baseline preserve geometry and VFR`, async (t) => {
    assert.equal(typeof withMotionObscuration, 'function');
    const f = await fixture(t, geometry);
    const before = snapshot(f);
    let invoked = 0;
    const result = await withMotionObscuration(f.ctx, f.input, async (artifact) => {
      invoked += 1;
      assert.deepEqual(Object.keys(artifact).sort(), ['assertCurrentBinding', 'createReadStream', 'mime', 'report', 'sha256', 'size']);
      await artifact.assertCurrentBinding();
      const outputBytes = await bytes(artifact.createReadStream());
      assert.equal(sha256(outputBytes), artifact.sha256);
      assert.equal(outputBytes.length, artifact.size);
      assert.equal(artifact.mime, 'video/mp4');
      assert.equal(artifact.report.schema_version, 'redraw-motion-obscuration-report-v1');
      assert.equal(artifact.report.approval_status, 'pending');
      assert.equal(JSON.stringify(artifact.report).includes(f.storageRoot), false);
      assert.equal(JSON.stringify(artifact.report).includes(f.tempRoot), false);
      for (const key of ['identity_obscured', 'background_preserved', 'text_removed', 'motion_preserved']) assert.notEqual(artifact.report[key], true);
      const directory = path.join(f.tempRoot, fs.readdirSync(f.tempRoot)[0]);
      const intermediate = fs.readdirSync(directory).filter((name) => /^frame-\d+\.png$/.test(name)).sort();
      assert.equal(intermediate.length, 4);
      for (const [i, name] of intermediate.entries()) {
        const actual = await sharp(path.join(directory, name)).removeAlpha().raw().toBuffer();
        const original = f.decoded[i];
        const blurred = await sharp(original, { raw: { width: f.width, height: f.height, channels: 3 } }).blur(12).raw().toBuffer();
        const union = Buffer.alloc(f.width * f.height);
        const regions = i === 1 ? ['actor', 'extra', 'text-1'] : i === 2 ? ['text-2'] : [];
        for (const region of regions) for (let pixel = 0; pixel < union.length; pixel += 1) union[pixel] |= f.masks[region][pixel];
        let changed = 0;
        for (let pixel = 0; pixel < union.length; pixel += 1) for (let channel = 0; channel < 3; channel += 1) {
          const j = pixel * 3 + channel;
          assert.equal(actual[j], union[pixel] ? blurred[j] : original[j], `frame ${i} pixel ${pixel}`);
          if (union[pixel] && actual[j] !== original[j]) changed += 1;
        }
        assert.equal(changed > 0, regions.length > 0);
      }
      const outputFile = path.join(f.mediaRoot, 'consumed.mp4');
      fs.writeFileSync(outputFile, outputBytes);
      const actualProbe = probe(outputFile);
      const stream = actualProbe.streams[0];
      assert.equal(actualProbe.streams.length, 1);
      assert.equal(stream.codec_name, 'h264'); assert.equal(stream.pix_fmt, 'yuv420p');
      assert.equal(stream.width, f.width); assert.equal(stream.height, f.height); assert.equal(stream.sample_aspect_ratio, geometry.sar);
      assert.equal(stream.display_aspect_ratio, f.sourceProbe.streams[0].display_aspect_ratio);
      assert.equal(actualProbe.frames.length, 4); assert.equal(actualProbe.packets.length, 4);
      for (const section of ['frames', 'packets']) for (let i = 0; i < 4; i += 1) {
        const actual = actualProbe[section][i], source = f.sourceProbe[section][i];
        assert.ok(Math.abs(Number(actual.pts) - Number(source.pts)) <= 1);
        assert.ok(Math.abs(Number(actual.duration ?? actual.pkt_duration) - Number(source.duration ?? source.pkt_duration)) <= 1);
      }
      const baselineFile = path.join(f.mediaRoot, 'baseline.mp4');
      const coverage = await loadReviewedMotionCoverage(f.ctx, f.input);
      const boundaries = [...coverage.frames.map((frame) => frame.timestamp_ticks), 12 * f.timescale];
      encodeFrames(coverage.frames.map((frame) => frame.path), boundaries, f.timescale, f.sar, baselineFile);
      const actualFrames = decodeRgb(outputFile, f.width, f.height), baselineFrames = decodeRgb(baselineFile, f.width, f.height);
      let backgroundError = 0, samples = 0;
      for (let i = 0; i < 4; i += 1) for (let y = 0; y < f.height; y += 1) for (let x = 44; x < f.width; x += 1) {
        for (let c = 0; c < 3; c += 1) { const j = (y * f.width + x) * 3 + c; backgroundError += Math.abs(actualFrames[i][j] - baselineFrames[i][j]); samples += 1; }
      }
      const mean = backgroundError / samples;
      assert.ok(mean < 5, `equivalent baseline background MAE ${mean}`);
      t.diagnostic(JSON.stringify({ geometry, output_sha256: artifact.sha256, output_size: artifact.size, baseline_background_mae: mean,
        frame_pts: actualProbe.frames.map((frame) => frame.pts), packet_durations: actualProbe.packets.map((packet) => packet.duration),
        report: artifact.report }));
      for (const file of [outputFile, baselineFile, `${baselineFile}.ffconcat`]) fs.unlinkSync(file);
      return 'consumed';
    });
    assert.equal(result, 'consumed'); assert.equal(invoked, 1);
    assert.deepEqual(fs.readdirSync(f.tempRoot), []);
    assert.deepEqual(snapshot(f), before);
  });
}

for (const shotId of [2, 3]) test(`intra-frame cut shot ${shotId} retains preceding frame and exact final duration`, async (t) => {
  assert.equal(typeof withMotionObscuration, 'function');
  const f = await fixture(t, { cuts: true });
  await withMotionObscuration(f.ctx, { ...f.input, shot_id: shotId }, async (artifact) => {
    const file = path.join(f.mediaRoot, 'cut.mp4');
    fs.writeFileSync(file, await bytes(artifact.createReadStream()));
    const actual = probe(file);
    assert.equal(actual.frames.length, shotId === 2 ? 2 : 1);
    assert.equal(Number(actual.frames[0].pts), 0);
    assert.equal(Number(actual.streams[0].duration_ts), (shotId === 2 ? 600 : 11150) * 30);
    assert.equal(artifact.report.frames[0].frame_index, shotId === 2 ? 1 : 3);
    fs.unlinkSync(file);
  });
  assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

test('source callback checks and lifetime clean up after success and failure', async (t) => {
  assert.equal(typeof withSourceVideoSnapshot, 'function');
  const f = await fixture(t);
  const input = { tenantId: f.ctx.tenantId, userId: f.ctx.userId, workId: 1,
    expectedSourceAssetId: 101, expectedSourceSha256: f.fingerprint };
  let privatePath;
  assert.equal(await withSourceVideoSnapshot(f.ctx, input, async (source) => {
    privatePath = source.path; source.assertSnapshot(); source.assertSourceUnchanged(); source.assertCurrentBinding();
    assert.deepEqual(await bytes(source.createReadStream()), f.sourceBytes);
    return 17;
  }), 17);
  assert.equal(fs.existsSync(privatePath), false);
  await assert.rejects(() => withSourceVideoSnapshot(f.ctx, input, async () => { throw new Error('consumer failed'); }), /consumer failed/);
  assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

test('source callback capability expires after its consumer returns', async (t) => {
  const f = await fixture(t);
  let saved;
  await withSourceVideoSnapshot(f.ctx, { tenantId: f.ctx.tenantId, userId: f.ctx.userId, workId: 1,
    expectedSourceAssetId: 101, expectedSourceSha256: f.fingerprint }, async (value) => { saved = value; });
  assert.throws(() => saved.createReadStream(), { code: 'REDRAW_SOURCE_VIDEO_EXPIRED' });
  assert.throws(() => saved.assertCurrentBinding(), { code: 'REDRAW_SOURCE_VIDEO_EXPIRED' });
});

test('actual audio source is stripped and the motion capability expires after consumer scope', async (t) => {
  const f = await fixture(t, { audio: true });
  assert.ok(f.sourceProbe.streams.some((stream) => stream.codec_type === 'audio'));
  const before = snapshot(f);
  let saved;
  await withMotionObscuration(f.ctx, f.input, async (artifact) => {
    saved = artifact;
    assert.equal(artifact.report.output_probe.frame_count, 4);
    const file = path.join(f.mediaRoot, 'audio-stripped.mp4');
    fs.writeFileSync(file, await bytes(artifact.createReadStream()));
    assert.deepEqual(probe(file).streams.map((stream) => stream.codec_type), ['video']);
    fs.unlinkSync(file);
  });
  assert.throws(() => saved.createReadStream(), { code: 'REDRAW_MOTION_OBSCURATION_EXPIRED' });
  await assert.rejects(saved.assertCurrentBinding, { code: 'REDRAW_MOTION_OBSCURATION_EXPIRED' });
  assert.deepEqual(snapshot(f), before);
  assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

for (const options of [{ width: 95 }, { rotation: 90 }]) test(`actual unsupported geometry fails closed: ${JSON.stringify(options)}`, async (t) => {
  const f = await fixture(t, options);
  await loadReviewedMotionCoverage(f.ctx, f.input);
  const before = snapshot(f);
  await assert.rejects(() => withMotionObscuration(f.ctx, f.input, () => assert.fail('must not consume')),
    { code: 'REDRAW_MOTION_OBSCURATION_UNSUPPORTED' });
  assert.deepEqual(snapshot(f), before); assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

test('actual video EOF cannot be extended by a longer approved manifest and work duration', async (t) => {
  const f = await fixture(t, { sourceDurationMs: 10000 });
  assert.equal(Number(f.sourceProbe.streams[0].duration_ts), 300000);
  const reviewed = await loadReviewedMotionCoverage(f.ctx, f.input);
  assert.equal(reviewed.shot.end_ms, 12000);
  let consumed = false;
  const before = snapshot(f);
  await assert.rejects(() => withMotionObscuration(f.ctx, f.input, () => { consumed = true; }),
    { code: 'REDRAW_MOTION_OBSCURATION_SOURCE_MISMATCH' });
  assert.equal(consumed, false); assert.deepEqual(snapshot(f), before); assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

for (const [name, change, code] of [
  ['caller owner', (f) => { f.ctx.userId = 'not-owner'; }, 'REDRAW_REFERENCE_BUNDLE_NOT_FOUND'],
  ['CAS', (f) => { f.input.expected_updated_at = 'stale'; }, 'REDRAW_REFERENCE_BUNDLE_CONFLICT'],
  ['unapproved coverage', (f) => f.db.prepare("UPDATE redraw_assets SET approval_status = 'pending'").run(), 'REDRAW_REFERENCE_BUNDLE_COVERAGE_EVIDENCE_REQUIRED'],
  ['caller path', (f) => { f.input.path = 'caller.mp4'; }, 'REDRAW_MOTION_OBSCURATION_INPUT_INVALID'],
  ['source bytes', (f) => fs.appendFileSync(f.sourcePath, 'changed'), 'REDRAW_REFERENCE_BUNDLE_COVERAGE_EVIDENCE_REQUIRED'],
]) test(`trusted preconditions reject ${name} without business writes or temp leaks`, async (t) => {
  const f = await fixture(t); change(f);
  const before = snapshot(f);
  await assert.rejects(() => withMotionObscuration(f.ctx, f.input, () => assert.fail('must not consume')), { code });
  assert.deepEqual(snapshot(f), before); assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

for (const target of ['frame', 'mask']) test(`rechecks ${target} bytes between trusted validation and processing`, async (t) => {
  const f = await fixture(t);
  const original = fs.promises.open;
  const targetFile = path.join(f.evidenceRoot, target === 'frame' ? 'frames/real-1.png' : 'masks/real-actor.png');
  let changed = false, after;
  t.mock.method(fs.promises, 'open', async function (...args) {
    const handle = await original.apply(this, args);
    const directory = fs.readdirSync(f.tempRoot)[0];
    if (!changed && args[0] === targetFile && directory
      && fs.existsSync(path.join(f.tempRoot, directory, 'frame-000000.png'))) {
      changed = true; fs.appendFileSync(targetFile, 'changed'); after = snapshot(f);
    }
    return handle;
  });
  await assert.rejects(() => withMotionObscuration(f.ctx, f.input, () => assert.fail('must not consume')),
    { code: 'REDRAW_MOTION_OBSCURATION_CONFLICT' });
  assert.equal(changed, true); assert.deepEqual(snapshot(f), after);
  assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

for (const name of ['source', 'mask', 'approval', 'CAS', 'owner']) test(`post-encode ${name} drift prevents success consumption`, async (t) => {
  const f = await fixture(t);
  let changed = false, after;
  f.ctx.execFile = (binary, args, options, callback) => execFile(binary, args, options, (error, stdout, stderr) => {
    if (!changed && args.includes('-c:v')) {
      changed = true;
      if (name === 'source') fs.appendFileSync(f.sourcePath, 'changed');
      if (name === 'mask') fs.appendFileSync(path.join(f.evidenceRoot, 'masks/real-actor.png'), 'changed');
      if (name === 'approval') f.db.prepare("UPDATE redraw_assets SET approval_status = 'pending'").run();
      if (name === 'CAS') f.db.prepare("UPDATE redraw_shots SET updated_at = 'changed'").run();
      if (name === 'owner') f.db.prepare("UPDATE tenant_members SET status = 'disabled'").run();
      after = snapshot(f);
    }
    callback(error, stdout, stderr);
  });
  await assert.rejects(() => withMotionObscuration(f.ctx, f.input, () => assert.fail('must not consume')),
    (error) => /^REDRAW_(SOURCE_VIDEO|REFERENCE_BUNDLE|MOTION_OBSCURATION)_/.test(error.code));
  assert.equal(changed, true); assert.deepEqual(snapshot(f), after); assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

for (const mode of ['cancel', 'exec-error']) test(`${mode} waits for only its own child close before cleanup`, async (t) => {
  const f = await fixture(t);
  const before = snapshot(f), controller = new AbortController();
  f.ctx.signal = controller.signal;
  let closed = false, waited = false;
  f.ctx.execFile = (binary, args, options, callback) => {
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.equal(options.signal, controller.signal);
    if (!args.includes('-c:v')) return execFile(binary, args, options, callback);
    const child = new EventEmitter();
    setImmediate(() => {
      if (mode === 'cancel') controller.abort(new Error('local synthetic cancellation'));
      callback(new Error('synthetic child error'), '', '');
      setTimeout(() => {
        waited = fs.readdirSync(f.tempRoot).length === 1;
        closed = true; child.emit('close', 1, null);
      }, 20);
    });
    return child;
  };
  await assert.rejects(() => withMotionObscuration(f.ctx, f.input, () => assert.fail('must not consume')),
    mode === 'cancel' ? /local synthetic cancellation/ : { code: 'REDRAW_MOTION_OBSCURATION_MEDIA_FAILED' });
  assert.equal(closed, true); assert.equal(waited, true);
  assert.deepEqual(snapshot(f), before); assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

test('pre-aborted input does not start a child or mutate source and DB', async (t) => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort(new Error('already cancelled'));
  const before = snapshot(f);
  await assert.rejects(() => withMotionObscuration({ ...f.ctx, signal: controller.signal,
    execFile: () => assert.fail('no child') }, f.input, () => assert.fail('no consumer')), /already cancelled/);
  assert.deepEqual(snapshot(f), before); assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

test('Sharp processing failure closes owned files without changing reviewed inputs', async (t) => {
  const f = await fixture(t), before = snapshot(f);
  t.mock.method(sharp.prototype, 'blur', () => { throw new Error('synthetic Sharp failure'); });
  await assert.rejects(() => withMotionObscuration(f.ctx, f.input, () => assert.fail('no consumer')),
    { code: 'REDRAW_MOTION_OBSCURATION_UNAVAILABLE' });
  assert.deepEqual(snapshot(f), before); assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

test('consumer failure still recovers this operation and preserves historical files', async (t) => {
  const f = await fixture(t), before = snapshot(f);
  const historical = path.join(f.tempRoot, 'unrelated-history.txt'); fs.writeFileSync(historical, 'retain');
  await assert.rejects(() => withMotionObscuration(f.ctx, f.input, () => { throw new Error('consumer rejected'); }),
    { code: 'REDRAW_MOTION_OBSCURATION_UNAVAILABLE' });
  assert.deepEqual(snapshot(f), before); assert.deepEqual(fs.readdirSync(f.tempRoot), ['unrelated-history.txt']);
  assert.equal(fs.readFileSync(historical, 'utf8'), 'retain');
});

for (const [name, mutate] of [
  ['frame PTS', (value) => { value.frames[1].pts += 50; }],
  ['frame duration', (value) => { value.frames[1].pkt_duration = 1; value.frames[1].duration = 1; }],
  ['packet PTS', (value) => { value.packets[1].pts += 50; }],
  ['packet duration', (value) => { value.packets[1].duration = 1; }],
  ['packet count', (value) => { value.packets.pop(); }],
  ['stream SAR', (value) => { value.streams[0].sample_aspect_ratio = '1:1'; }],
]) test(`output probe ${name} mismatch fails closed even when total duration is plausible`, async (t) => {
  const f = await fixture(t), before = snapshot(f);
  let changed = false;
  f.ctx.execFile = (binary, args, options, callback) => execFile(binary, args, options, (error, stdout, stderr) => {
    if (!error && args.at(-1).endsWith('motion-obscuration.mp4') && !args.includes('-c:v')) {
      const value = JSON.parse(stdout);
      const section = name.startsWith('frame') ? 'frames' : name.startsWith('packet') ? 'packets' : 'streams';
      if (value[section]) { mutate(value); changed = true; stdout = JSON.stringify(value); }
    }
    callback(error, stdout, stderr);
  });
  await assert.rejects(() => withMotionObscuration(f.ctx, f.input, () => assert.fail('no consumer')),
    { code: 'REDRAW_MOTION_OBSCURATION_OUTPUT_INVALID' });
  assert.equal(changed, true); assert.deepEqual(snapshot(f), before); assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

test('unsupported LCM timebase fails before FFmpeg encoding (narrow source-probe boundary double)', async (t) => {
  const f = await fixture(t);
  const denominator = 1000000007;
  f.rewriteManifest((manifest) => {
    const original = manifest.source.time_base.denominator;
    for (const frame of manifest.frames) frame.timestamp_ticks = Math.round(frame.timestamp_ticks * denominator / original);
    manifest.source.time_base.denominator = denominator;
  });
  await loadReviewedMotionCoverage(f.ctx, f.input);
  const before = snapshot(f);
  let encoded = false;
  f.ctx.execFile = (binary, args, options, callback) => {
    if (args.includes('-c:v')) encoded = true;
    return execFile(binary, args, options, (error, stdout, stderr) => {
      if (!error && args.at(-1).endsWith('source.snapshot')) {
        const value = JSON.parse(stdout); value.streams[0].time_base = `1/${denominator}`;
        value.streams[0].duration_ts = 12 * denominator; stdout = JSON.stringify(value);
      }
      callback(error, stdout, stderr);
    });
  };
  await assert.rejects(() => withMotionObscuration(f.ctx, f.input, () => assert.fail('no consumer')),
    { code: 'REDRAW_MOTION_OBSCURATION_UNSUPPORTED' });
  assert.equal(encoded, false); assert.deepEqual(snapshot(f), before); assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

test('real child cancellation closes FFmpeg and recovers only this operation', async (t) => {
  const f = await fixture(t), before = snapshot(f), controller = new AbortController();
  f.ctx.signal = controller.signal;
  let closed = false, aborted = false;
  f.ctx.execFile = (binary, args, options, callback) => {
    const child = execFile(binary, args, options, callback);
    if (args.includes('-c:v')) {
      child.once('close', () => { closed = true; });
      setImmediate(() => { aborted = true; controller.abort(new Error('real child cancellation')); });
    }
    return child;
  };
  await assert.rejects(() => withMotionObscuration(f.ctx, f.input, () => assert.fail('no consumer')), /real child cancellation/);
  assert.equal(aborted, true); assert.equal(closed, true);
  assert.deepEqual(snapshot(f), before); assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

test('mask symlink substitution after validation is never processed or removed as an owned file', async (t) => {
  const f = await fixture(t), originalOpen = fs.promises.open;
  const mask = path.join(f.evidenceRoot, 'masks/real-actor.png');
  const preserved = path.join(f.evidenceRoot, 'masks/real-actor-preserved.png');
  const capabilityLink = path.join(f.mediaRoot, 'symlink-capability');
  let realSymlink = true;
  try { fs.symlinkSync(mask, capabilityLink, 'file'); fs.unlinkSync(capabilityLink); }
  catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    realSymlink = false;
    t.diagnostic(`Real file symlink unavailable (${error.code}); narrow lstat boundary double, no test skipped.`);
  }
  const before = snapshot(f); let changed = false;
  const originalLstat = fs.lstatSync;
  if (!realSymlink) t.mock.method(fs, 'lstatSync', function (...args) {
    const stat = originalLstat.apply(this, args);
    if (changed && args[0] === mask) return Object.assign(Object.create(stat), { isSymbolicLink: () => true });
    return stat;
  });
  t.mock.method(fs.promises, 'open', async function (...args) {
    const handle = await originalOpen.apply(this, args);
    const directory = fs.readdirSync(f.tempRoot)[0];
    if (!changed && args[0] === mask && directory && fs.existsSync(path.join(f.tempRoot, directory, 'frame-000000.png'))) {
      changed = true;
      if (realSymlink) {
        try { fs.renameSync(mask, preserved); fs.symlinkSync(preserved, mask, 'file'); }
        catch (error) { await handle.close(); throw error; }
      }
    }
    return handle;
  });
  try {
    await assert.rejects(() => withMotionObscuration(f.ctx, f.input, () => assert.fail('no consumer')),
      (error) => /^REDRAW_MOTION_OBSCURATION_/.test(error.code));
    assert.equal(changed, true); assert.equal(fs.lstatSync(mask).isSymbolicLink(), true);
    assert.deepEqual(fs.readdirSync(f.tempRoot), []);
  } finally {
    if (changed && realSymlink) { if (fs.existsSync(mask)) fs.unlinkSync(mask); fs.renameSync(preserved, mask); }
  }
  assert.deepEqual(snapshot(f), before);
});

for (const [name, mutate, code] of [
  ['missing SAR', (stream) => { stream.sample_aspect_ratio = 'N/A'; }, 'UNSUPPORTED'],
  ['unmatched timebase', (stream) => { stream.time_base = '1/1000'; }, 'SOURCE_MISMATCH'],
  ['unmatched dimensions', (stream) => { stream.width += 2; }, 'SOURCE_MISMATCH'],
]) test(`source-probe ${name} is rejected without output`, async (t) => {
  const f = await fixture(t), before = snapshot(f);
  f.ctx.execFile = (binary, args, options, callback) => execFile(binary, args, options, (error, stdout, stderr) => {
    if (!error && args.at(-1).endsWith('source.snapshot')) {
      const value = JSON.parse(stdout); mutate(value.streams[0]); stdout = JSON.stringify(value);
    }
    callback(error, stdout, stderr);
  });
  await assert.rejects(() => withMotionObscuration(f.ctx, f.input, () => assert.fail('no consumer')),
    { code: `REDRAW_MOTION_OBSCURATION_${code}` });
  assert.deepEqual(snapshot(f), before); assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

test('intermediate PNG and concat handles are released before encoding and consumption', async (t) => {
  const f = await fixture(t), original = fs.promises.open, opened = new Set();
  t.mock.method(fs.promises, 'open', async function (...args) {
    const handle = await original.apply(this, args);
    if (String(args[0]).startsWith(f.tempRoot) && /(?:frame-\d+\.png|frames\.ffconcat)$/.test(args[0])) {
      opened.add(handle);
      const close = handle.close.bind(handle);
      handle.close = async () => { try { return await close(); } finally { opened.delete(handle); } };
    }
    return handle;
  });
  let duringEncode;
  f.ctx.execFile = (binary, args, options, callback) => {
    if (args.includes('-c:v')) duringEncode = opened.size;
    return execFile(binary, args, options, callback);
  };
  let duringConsume;
  await withMotionObscuration(f.ctx, f.input, () => { duringConsume = opened.size; });
  assert.equal(duringEncode, 0, 'frame count must not grow the number of live private file handles');
  assert.equal(duringConsume, 0); assert.equal(opened.size, 0);
  assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

for (const [name, mutate, code] of [
  ['membership', (f) => f.db.prepare("UPDATE tenant_members SET status = 'disabled'").run(), 'REDRAW_REFERENCE_BUNDLE_NOT_FOUND'],
  ['shot CAS', (f) => f.db.prepare("UPDATE redraw_shots SET updated_at = 'revoked-after-hash'").run(), 'REDRAW_REFERENCE_BUNDLE_CONFLICT'],
  ['coverage approval', (f) => f.db.prepare("UPDATE redraw_assets SET approval_status = 'pending'").run(), 'REDRAW_REFERENCE_BUNDLE_COVERAGE_EVIDENCE_REQUIRED'],
]) test(`final output file check cannot consume after ${name} is revoked`, async (t) => {
  const f = await fixture(t), originalOpen = fs.promises.open;
  let outputHashReadComplete = false, changed = false, consumed = false, afterMutation;
  t.mock.method(fs.promises, 'open', async function (...args) {
    const handle = await originalOpen.apply(this, args);
    if (String(args[0]).startsWith(f.tempRoot) && String(args[0]).endsWith('motion-obscuration.mp4')) {
      const read = handle.read.bind(handle), stat = handle.stat.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (result.bytesRead > 0 && readArgs[3] + result.bytesRead === fs.fstatSync(handle.fd).size) outputHashReadComplete = true;
        return result;
      };
      handle.stat = async (...statArgs) => {
        const result = await stat(...statArgs);
        if (outputHashReadComplete && !changed) {
          changed = true; mutate(f); afterMutation = snapshot(f);
        }
        return result;
      };
    }
    return handle;
  });
  try {
    await assert.rejects(() => withMotionObscuration(f.ctx, f.input, () => { consumed = true; }), { code });
    assert.equal(changed, true, 'real database mutation must occur at the post-hash file-check phase');
    assert.equal(consumed, false, 'post-consumer rejection cannot undo an unauthorized successful handoff');
    assert.deepEqual(snapshot(f), afterMutation); assert.deepEqual(fs.readdirSync(f.tempRoot), []);
  } finally { t.mock.restoreAll(); }
});

for (const method of ['assertSourceUnchanged', 'assertSnapshot', 'assertPrivateDirectory']) {
  test(`source callback ${method} capability expires with its consumer scope`, async (t) => {
    const f = await fixture(t); let saved;
    await withSourceVideoSnapshot(f.ctx, { tenantId: f.ctx.tenantId, userId: f.ctx.userId, workId: 1,
      expectedSourceAssetId: 101, expectedSourceSha256: f.fingerprint }, async (value) => { saved = value; });
    assert.throws(() => saved[method](), { code: 'REDRAW_SOURCE_VIDEO_EXPIRED' });
    assert.deepEqual(fs.readdirSync(f.tempRoot), []);
  });
}

test('output mutation during the final trusted-reader wait cannot consume a stale output hash', async (t) => {
  const f = await fixture(t), originalOpen = fs.promises.open, before = snapshot(f);
  let outputFile, hashReadComplete = false, checkedAfterHash = false, changed = false, consumed = false;
  t.mock.method(fs.promises, 'open', async function (...args) {
    const handle = await originalOpen.apply(this, args);
    if (String(args[0]).startsWith(f.tempRoot) && String(args[0]).endsWith('motion-obscuration.mp4')) {
      outputFile = args[0];
      const read = handle.read.bind(handle), stat = handle.stat.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (result.bytesRead > 0 && readArgs[3] + result.bytesRead === fs.fstatSync(handle.fd).size) hashReadComplete = true;
        return result;
      };
      handle.stat = async (...statArgs) => {
        const result = await stat(...statArgs);
        if (hashReadComplete) checkedAfterHash = true;
        return result;
      };
    } else if (checkedAfterHash && !changed && String(args[0]).startsWith(path.join(f.evidenceRoot, 'frames'))) {
      changed = true; fs.appendFileSync(outputFile, 'changed-during-final-reader');
    }
    return handle;
  });
  try {
    await assert.rejects(() => withMotionObscuration(f.ctx, f.input, () => { consumed = true; }),
      { code: 'REDRAW_MOTION_OBSCURATION_CONFLICT' });
    assert.equal(changed, true); assert.equal(consumed, false);
    assert.deepEqual(snapshot(f), before); assert.deepEqual(fs.readdirSync(f.tempRoot), []);
  } finally { t.mock.restoreAll(); }
});

test('first private-file stat failure closes acquired handles and rolls back its verified file', async (t) => {
  const f = await fixture(t), before = snapshot(f), originalOpen = fs.promises.open, handles = [];
  const historical = path.join(f.tempRoot, 'historical.txt'); fs.writeFileSync(historical, 'retain');
  let injected = false, consumed = false, error;
  t.mock.method(fs.promises, 'open', async function (...args) {
    const handle = await originalOpen.apply(this, args);
    if (String(args[0]).startsWith(f.tempRoot)) handles.push(handle);
    if (String(args[0]).startsWith(f.tempRoot) && String(args[0]).endsWith('frame-000000.png')) {
      const stat = handle.stat.bind(handle);
      t.mock.method(handle, 'stat', async (...statArgs) => {
        if (!injected) { injected = true; throw Object.assign(new Error('single initial stat failure'), { code: 'EIO' }); }
        return stat(...statArgs);
      });
    }
    return handle;
  });
  try {
    try { await withMotionObscuration(f.ctx, f.input, () => { consumed = true; }); } catch (caught) { error = caught; }
    const remaining = fs.readdirSync(f.tempRoot).filter((name) => name !== 'historical.txt');
    t.diagnostic(JSON.stringify({ phase: 'before_test_teardown', injected, consumed, live_fd_count: handles.filter((handle) => handle.fd !== -1).length,
      remaining_request_directories: remaining.length, error_code: error?.code, error_contains_private_path: error?.message.includes(f.tempRoot) }));
    assert.equal(injected, true); assert.equal(consumed, false);
    assert.ok(handles.every((handle) => handle.fd === -1), 'product cleanup must close the acquired handle even when its first stat fails');
    assert.deepEqual(remaining, []); assert.equal(error.code, 'REDRAW_MOTION_OBSCURATION_UNAVAILABLE');
    assert.equal(error.message.includes(f.tempRoot), false); assert.equal(JSON.stringify(error).includes(f.tempRoot), false);
    assert.equal(fs.readFileSync(historical, 'utf8'), 'retain'); assert.deepEqual(snapshot(f), before);
  } finally {
    t.mock.restoreAll();
    // Rescue failed RED resources only after all product-cleanup observations above.
    for (const handle of handles) if (handle.fd !== -1) await handle.close();
  }
});

test('one blocked output unlink preserves that output but cleans verified siblings and retains the first error', async (t) => {
  const f = await fixture(t), before = snapshot(f), originalOpen = fs.promises.open, originalUnlink = fs.promises.unlink;
  const historical = path.join(f.tempRoot, 'historical.txt'); fs.writeFileSync(historical, 'retain');
  const handles = [], attempts = []; let injected = false, consumed = false, error;
  t.mock.method(fs.promises, 'open', async function (...args) {
    const handle = await originalOpen.apply(this, args);
    if (String(args[0]).startsWith(f.tempRoot)) handles.push(handle);
    return handle;
  });
  t.mock.method(fs.promises, 'unlink', async function (file, ...args) {
    if (String(file).startsWith(f.tempRoot)) attempts.push(path.basename(file));
    if (!injected && String(file).startsWith(f.tempRoot) && String(file).endsWith('motion-obscuration.mp4')) {
      injected = true; throw Object.assign(new Error('single output unlink denial'), { code: 'EACCES' });
    }
    return originalUnlink.call(this, file, ...args);
  });
  try {
    try { await withMotionObscuration(f.ctx, f.input, () => { consumed = true; }); } catch (caught) { error = caught; }
    const directories = fs.readdirSync(f.tempRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const files = directories.flatMap((entry) => fs.readdirSync(path.join(f.tempRoot, entry.name))).sort();
    t.diagnostic(JSON.stringify({ phase: 'before_test_teardown', injected, consumed, files, cleanup_attempts: attempts,
      error_code: error?.code, cleanup_code: error?.cleanup_code, live_fd_count: handles.filter((handle) => handle.fd !== -1).length }));
    assert.equal(injected, true); assert.equal(consumed, true, 'the single failure is after normal consumption');
    assert.deepEqual(files, ['motion-obscuration.mp4'], 'one blocked unlink must not prevent safe sibling cleanup');
    assert.equal(attempts.filter((name) => name === 'motion-obscuration.mp4').length, 1, 'blocked output is not automatically retried');
    assert.deepEqual(attempts.filter((name) => name.endsWith('.png')).sort(),
      ['frame-000000.png', 'frame-000001.png', 'frame-000002.png', 'frame-000003.png']);
    assert.ok(attempts.includes('frames.ffconcat')); assert.ok(handles.every((handle) => handle.fd === -1));
    assert.equal(error.code, 'REDRAW_MOTION_OBSCURATION_CLEANUP_FAILED'); assert.equal(error.cleanup_code, 'EACCES');
    assert.equal(error.message.includes(f.tempRoot), false); assert.equal(JSON.stringify(error).includes(f.tempRoot), false);
    assert.equal(fs.readFileSync(historical, 'utf8'), 'retain'); assert.deepEqual(snapshot(f), before);
  } finally {
    t.mock.restoreAll();
    for (const handle of handles) if (handle.fd !== -1) await handle.close();
  }
});

test('source callback cleanup-only failure is typed and redacted while its blocked snapshot is preserved', async (t) => {
  const f = await fixture(t), before = snapshot(f), originalUnlink = fs.promises.unlink;
  let injected = false, saved, error;
  t.mock.method(fs.promises, 'unlink', async function (file, ...args) {
    if (!injected && String(file).startsWith(f.tempRoot) && String(file).endsWith('source.snapshot')) {
      injected = true; throw Object.assign(new Error(`denied ${file}`), { code: 'EACCES', path: file });
    }
    return originalUnlink.call(this, file, ...args);
  });
  try {
    try {
      await withSourceVideoSnapshot(f.ctx, { tenantId: f.ctx.tenantId, userId: f.ctx.userId, workId: 1,
        expectedSourceAssetId: 101, expectedSourceSha256: f.fingerprint }, async (source) => { saved = source; });
    } catch (caught) { error = caught; }
    assert.equal(injected, true); assert.equal(error.code, 'REDRAW_SOURCE_VIDEO_CLEANUP_FAILED');
    assert.equal(error.cleanup_code, 'EACCES'); assert.equal(error.message.includes(f.tempRoot), false);
    assert.equal(JSON.stringify(error).includes(f.tempRoot), false);
    assert.throws(() => saved.assertCurrentBinding(), { code: 'REDRAW_SOURCE_VIDEO_EXPIRED' });
    assert.deepEqual(fs.readdirSync(saved.directory), ['source.snapshot']); assert.deepEqual(snapshot(f), before);
  } finally { t.mock.restoreAll(); }
});

test('initial-stat rollback preserves a replacement file whose identity is not owned', async (t) => {
  const f = await fixture(t), before = snapshot(f), originalOpen = fs.promises.open, originalUnlink = fs.promises.unlink;
  const handles = [], attempts = []; let injected = false, consumed = false, file, retained, error;
  t.mock.method(fs.promises, 'open', async function (...args) {
    const handle = await originalOpen.apply(this, args);
    if (String(args[0]).startsWith(f.tempRoot)) handles.push(handle);
    if (String(args[0]).startsWith(f.tempRoot) && String(args[0]).endsWith('frame-000000.png')) {
      file = args[0]; retained = path.join(path.dirname(file), 'retained-created-frame.png');
      const stat = handle.stat.bind(handle);
      t.mock.method(handle, 'stat', async (...statArgs) => {
        if (!injected) {
          injected = true; fs.renameSync(file, retained); fs.writeFileSync(file, 'unowned replacement');
          throw Object.assign(new Error('initial stat failed after pathname replacement'), { code: 'EIO' });
        }
        return stat(...statArgs);
      });
    }
    return handle;
  });
  t.mock.method(fs.promises, 'unlink', async function (target, ...args) {
    attempts.push(target); return originalUnlink.call(this, target, ...args);
  });
  try {
    try { await withMotionObscuration(f.ctx, f.input, () => { consumed = true; }); } catch (caught) { error = caught; }
    assert.equal(injected, true); assert.equal(consumed, false);
    assert.ok(handles.every((handle) => handle.fd === -1));
    assert.equal(fs.readFileSync(file, 'utf8'), 'unowned replacement'); assert.equal(fs.existsSync(retained), true);
    assert.equal(attempts.includes(file), false); assert.equal(attempts.includes(retained), false);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['frame-000000.png', 'retained-created-frame.png']);
    assert.equal(error.code, 'REDRAW_MOTION_OBSCURATION_CLEANUP_FAILED');
    assert.equal(error.cleanup_code, 'REDRAW_MOTION_OBSCURATION_CONFLICT');
    assert.equal(error.message.includes(f.tempRoot), false); assert.equal(JSON.stringify(error).includes(f.tempRoot), false);
    assert.deepEqual(snapshot(f), before);
  } finally {
    t.mock.restoreAll();
    for (const handle of handles) if (handle.fd !== -1) await handle.close();
  }
});

test('cleanup stops path deletion after private-directory replacement but closes every acquired handle', async (t) => {
  const f = await fixture(t), before = snapshot(f), originalOpen = fs.promises.open, originalUnlink = fs.promises.unlink;
  const originalLstat = fs.lstatSync, handles = [], attempts = [];
  let injected = false, nativeReplacement = false, consumed = false, directory, displaced, error, replacementDenied;
  t.mock.method(fs.promises, 'open', async function (...args) {
    const handle = await originalOpen.apply(this, args);
    if (String(args[0]).startsWith(f.tempRoot)) handles.push(handle);
    if (String(args[0]).startsWith(f.tempRoot) && String(args[0]).endsWith('motion-obscuration.mp4')) {
      directory = path.dirname(args[0]); displaced = `${directory}-displaced`;
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => {
        await close();
        if (!injected) {
          try { fs.renameSync(directory, displaced); nativeReplacement = true; } catch (caught) {
            if (process.platform !== 'win32' || caught.code !== 'EPERM') throw caught;
            replacementDenied = caught.code;
          }
          if (nativeReplacement) {
            fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'foreign.txt'), 'retain');
          }
          injected = true;
        }
      });
    }
    return handle;
  });
  // Windows can forbid renaming a directory containing the still-open source snapshot.
  // Only that observed EPERM uses an identity double; all handles and cleanup operations stay real.
  t.mock.method(fs, 'lstatSync', function (target, ...args) {
    const stat = originalLstat.call(this, target, ...args);
    return injected && !nativeReplacement && target === directory
      ? Object.assign(Object.create(stat), { ino: stat.ino + (typeof stat.ino === 'bigint' ? 1n : 1) }) : stat;
  });
  t.mock.method(fs.promises, 'unlink', async function (file, ...args) {
    if (injected) attempts.push(file); return originalUnlink.call(this, file, ...args);
  });
  try {
    try { await withMotionObscuration(f.ctx, f.input, () => { consumed = true; }); } catch (caught) { error = caught; }
    t.diagnostic(JSON.stringify({ phase: 'before_test_teardown', injected, consumed, error_code: error?.code,
      cleanup_code: error?.cleanup_code, native_directory_replacement: nativeReplacement, replacement_denied: replacementDenied,
      live_fd_count: handles.filter((handle) => handle.fd !== -1).length }));
    assert.equal(injected, true); assert.equal(consumed, true);
    assert.ok(handles.every((handle) => handle.fd === -1)); assert.deepEqual(attempts, []);
    if (nativeReplacement) {
      assert.deepEqual(fs.readdirSync(directory), ['foreign.txt']); assert.equal(fs.readFileSync(path.join(directory, 'foreign.txt'), 'utf8'), 'retain');
    } else { assert.equal(replacementDenied, 'EPERM'); }
    assert.deepEqual(fs.readdirSync(nativeReplacement ? displaced : directory).sort(), ['frame-000000.png', 'frame-000001.png', 'frame-000002.png',
      'frame-000003.png', 'frames.ffconcat', 'motion-obscuration.mp4', 'source.snapshot']);
    assert.equal(error.code, 'REDRAW_MOTION_OBSCURATION_CLEANUP_FAILED'); assert.equal(error.cleanup_code, 'REDRAW_SOURCE_VIDEO_UNAVAILABLE');
    assert.equal(error.message.includes(f.tempRoot), false); assert.equal(JSON.stringify(error).includes(f.tempRoot), false);
    assert.deepEqual(snapshot(f), before);
  } finally {
    t.mock.restoreAll();
    for (const handle of handles) if (handle.fd !== -1) await handle.close();
  }
});
