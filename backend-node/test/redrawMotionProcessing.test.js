const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { getFfmpegPath } = require('../src/utils/ffmpegPath');
const redrawRoutes = require('../src/routes/redraw');
const { fixture } = require('./helpers/redrawMotionObscurationFixture');
const { httpFixture, envelope, importInput, snapshot, sha256, probe, NOW, OWNER } = require('./helpers/redrawMotionProcessingFixture');
const { importMotionReferenceArtifact } = require('../src/services/redrawReferenceArtifactImportService');
const stable = (value) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

test('motion-processing exposes the actual product handler for reviewed frame processing', async (t) => {
  const f = await fixture(t);
  const handlers = redrawRoutes(f.db, { error() {}, warn() {}, info() {} }, { storageRoot: f.storageRoot });
  assert.equal(typeof handlers.getMotionProcessing, 'function', 'missing motion-processing product handler');
});

test('motion-processing report contract service exists for response/import/prepare', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '../src/services/redrawMotionProcessingReportService.js')),
    'missing motion-processing report contract service');
});

test('motion-processing actual authenticated router streams the reviewed MP4 envelope with zero business writes', async (t) => {
  const f = await httpFixture(t);
  const before = snapshot(f);
  const result = await envelope(f, await f.get());
  assert.deepEqual(snapshot(f), before);
  const received = path.join(f.storageRoot, 'received.mp4');
  fs.writeFileSync(received, result.video);
  const actual = probe(received);
  assert.equal(actual.streams.length, 1);
  assert.equal(actual.streams[0].codec_name, 'h264');
  assert.equal(actual.streams[0].sample_aspect_ratio, f.sar);
  assert.equal(actual.streams[0].width, f.width);
  assert.equal(actual.streams[0].height, f.height);
  assert.equal(actual.frames.length, result.report.frames.length);
});

test('motion-processing rejects login, owner, disabled, source, CAS and extra query with zero writes', async (t) => {
  const f = await httpFixture(t);
  const cases = [
    [f.query, { Authorization: '' }, 401],
    [f.query, { Authorization: `Bearer ${f.otherToken}` }, 404],
    [f.query.replace(f.fingerprint, 'e'.repeat(64)), {}, 409],
    [f.query.replace('2026', '2025'), {}, 409],
    [f.query + '&path=/private/frame.png', {}, 400],
    [f.query + '&expected_source_sha256=' + f.fingerprint, {}, 400],
    ['', {}, 400],
  ];
  for (const [q, headers, status] of cases) {
    const before = snapshot(f);
    const response = await f.get(q, headers);
    assert.equal(response.status, status, await response.text());
    assert.deepEqual(snapshot(f), before);
  }
  f.db.prepare("UPDATE tenant_members SET status = 'disabled' WHERE tenant_id = ? AND user_id = ?")
    .run(OWNER.tenantId, OWNER.userId);
  const before = snapshot(f);
  const response = await f.get();
  assert.equal(response.status, 404, await response.text());
  assert.deepEqual(snapshot(f), before);
});

test('motion-processing optional multipart report imports actual envelope video and replays without another asset', async (t) => {
  const f = await httpFixture(t);
  const result = await envelope(f, await f.get());
  async function upload() {
    const form = new FormData();
    form.set('expected_updated_at', NOW);
    for (const key of ['full_frame_reviewed', 'source_identity_obscured', 'source_text_obscured', 'motion_preserved']) form.set(key, 'true');
    form.set('processing_report', result.rawReport);
    form.set('file', new Blob([result.video], { type: 'video/mp4' }), 'processed.mp4');
    const response = await fetch(`${f.base}/redraw/shots/1/motion-reference`, {
      method: 'POST', headers: { ...f.headers, 'idempotency-key': 'local-processing-http' }, body: form,
    });
    const json = await response.json();
    assert.equal(response.status, 200, JSON.stringify(json));
    return json.data;
  }
  const first = await upload();
  const second = await upload();
  assert.equal(first.asset.id, second.asset.id);
  const metadata = JSON.parse(f.db.prepare('SELECT metadata FROM assets WHERE id = ?').get(first.asset.id).metadata);
  const attachment = metadata.redraw_motion_processing;
  assert.equal(attachment.provenance, 'client_returned_unattested');
  assert.deepEqual(attachment.report, result.report);
  assert.equal(attachment.report_sha256, sha256(stable(result.report)));
  assert.equal(attachment.verified.input_binding_sha256, result.report.input_binding_sha256);
  assert.equal(attachment.verified.input_frame_mask_set_sha256, result.report.input_frame_mask_set_sha256);
  assert.equal(attachment.verified.output_sha256, sha256(result.video));
  assert.equal(attachment.verified.pixel_claims_verified, false);
  assert.equal(attachment.verified.renderer_origin_verified, false);
  assert.equal(attachment.verified.output_media_verified, true);
  assert.match(attachment.verified.material_binding_sha256, /^[a-f0-9]{64}$/);
  assert.equal(metadata.redraw_motion_reference, undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM redraw_reference_artifact_imports').get().n, 1);
});

test('motion-processing rejects actual rotated display matrices with zero writes and preserves zero-rotation imports', async (t) => {
  const f = await httpFixture(t);
  require('../src/services/tenantService').ensurePersonalTenant(f.db, { id: OWNER.userId });
  const original = await envelope(f, await f.get());
  const source = path.join(f.storageRoot, 'rotation-input.mp4');
  fs.writeFileSync(source, original.video, { flag: 'wx' });
  const conditioning = path.join(f.storageRoot, 'redraw-conditioning');
  for (const directory of [f.uploadRoot, f.tempRoot, conditioning]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'other-request.txt'), 'unrelated-request', { flag: 'wx' });
  }
  for (const rotation of [90, -90, 180, 0]) {
    const output = path.join(f.storageRoot, `rotation-${rotation}.mp4`);
    execFileSync(getFfmpegPath(), ['-v', 'error', '-display_rotation', String(rotation), '-i', source,
      '-map', '0:v:0', '-c', 'copy', '-video_track_timescale', String(original.report.timing.timescale), output],
    { windowsHide: true, timeout: 15000 });
    const actual = probe(output).streams[0];
    const rotations = [actual.tags?.rotate, ...(actual.side_data_list || []).map(entry => entry.rotation)]
      .filter(value => value !== undefined);
    if (rotation) assert.ok(rotations.some(value => Number(value) !== 0), 'real nonzero display matrix preflight');
    else assert.ok(rotations.every(value => Number(value) === 0), 'real zero-rotation media preflight');
    assert.equal(actual.width, original.report.source_probe.width);
    assert.equal(actual.height, original.report.source_probe.height);
    assert.equal(actual.sample_aspect_ratio, original.report.source_probe.sample_aspect_ratio);
    const video = fs.readFileSync(output);
    const report = structuredClone(original.report);
    report.output.sha256 = sha256(video);
    report.output.size = video.length;
    const before = snapshot(f);
    const assetsBefore = f.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n;
    const form = new FormData();
    form.set('expected_updated_at', NOW);
    for (const key of ['full_frame_reviewed', 'source_identity_obscured', 'source_text_obscured', 'motion_preserved']) form.set(key, 'true');
    form.set('processing_report', JSON.stringify(report));
    form.set('file', new Blob([video], { type: 'video/mp4' }), 'rotation.mp4');
    const response = await fetch(`${f.base}/redraw/shots/1/motion-reference`, {
      method: 'POST', headers: { ...f.headers, 'idempotency-key': `rotation-${rotation}` }, body: form,
    });
    const body = await response.json();
    assert.equal(response.status, rotation ? 409 : 200, JSON.stringify(body));
    if (rotation) {
      assert.deepEqual(snapshot(f), before);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, assetsBefore);
      for (const table of ['redraw_reference_artifact_imports', 'async_tasks', 'tenant_usage_reservations', 'video_generations']) {
        assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
      }
      for (const directory of [f.uploadRoot, f.tempRoot, conditioning]) {
        assert.deepEqual(fs.readdirSync(directory), ['other-request.txt']);
        assert.equal(fs.readFileSync(path.join(directory, 'other-request.txt'), 'utf8'), 'unrelated-request');
      }
    } else {
      const metadata = JSON.parse(f.db.prepare('SELECT metadata FROM assets WHERE id = ?').get(body.data.asset.id).metadata);
      assert.equal(metadata.redraw_motion_processing.verified.output_media_verified, true);
      assert.equal(metadata.redraw_motion_processing.provenance, 'client_returned_unattested');
    }
  }
});

test('motion-processing upload probe rejects every nonzero or invalid rotation value and accepts explicit numeric zero', async (t) => {
  const f = await httpFixture(t);
  const original = await envelope(f, await f.get());
  const file = path.join(f.storageRoot, 'rotation-probe-boundary.mp4');
  fs.writeFileSync(file, original.video, { flag: 'wx' });
  const { promisify } = require('node:util');
  const childProcess = require('node:child_process');
  const realProbe = promisify(execFile);
  let rotationMetadata;
  // Keep the real FFprobe/media result; vary only malformed external metadata at the subprocess boundary.
  const boundary = (...args) => execFile(...args);
  boundary[promisify.custom] = async (...args) => {
    const result = await realProbe(...args);
    if (args[1].includes('-show_streams')) {
      const actual = JSON.parse(result.stdout);
      Object.assign(actual.streams[0], rotationMetadata);
      result.stdout = JSON.stringify(actual);
    }
    return result;
  };
  const modulePath = require.resolve('../src/services/redrawMotionProcessingReportService');
  const previousModule = require.cache[modulePath];
  let verifyProcessingUpload;
  try {
    childProcess.execFile = boundary;
    delete require.cache[modulePath];
    ({ verifyProcessingUpload } = require(modulePath));
  } finally {
    childProcess.execFile = execFile;
    require.cache[modulePath] = previousModule;
  }
  for (const field of ['tag', 'side_data']) {
    for (const value of [90, -90, '90', null, false, '', ' ', 'NaN', 'Infinity', '0x0', [], {}]) {
      rotationMetadata = field === 'tag' ? { tags: { rotate: value } } : { side_data_list: [{ rotation: value }] };
      const attachment = { report: original.report, verified: {} };
      await assert.rejects(verifyProcessingUpload(file, attachment), { code: 'REDRAW_MOTION_PROCESSING_CONFLICT' },
        `${field} ${JSON.stringify(value)}`);
      assert.equal(attachment.verified.output_media_verified, undefined);
    }
  }
  rotationMetadata = { tags: { rotate: '0' }, side_data_list: [{ rotation: 0 }, { rotation: 90 }] };
  await assert.rejects(verifyProcessingUpload(file, { report: original.report, verified: {} }), { code: 'REDRAW_MOTION_PROCESSING_CONFLICT' });
  for (const value of [0, '0', '-0', '0.00']) {
    rotationMetadata = { tags: { rotate: value }, side_data_list: [{ rotation: value }, { side_data_type: 'unrelated' }] };
    const attachment = { report: original.report, verified: {} };
    await verifyProcessingUpload(file, attachment);
    assert.equal(attachment.verified.output_media_verified, true);
  }
});

test('motion-processing withholds the final media bytes until callback binding verification succeeds', async (t) => {
  const f = await httpFixture(t);
  let changed = false;
  f.server.prependListener('request', (_req, response) => {
    const write = response.write.bind(response);
    response.write = (...args) => {
      const result = write(...args);
      if (!changed && Buffer.isBuffer(args[0]) && args[0].subarray(0, 8).toString() === 'RDMO0001') {
        changed = true;
        f.db.prepare("UPDATE redraw_assets SET approved_at = 'changed-during-stream' WHERE id = 201").run();
      }
      return result;
    };
  });
  await assert.rejects(async () => { const response = await f.get(); await response.arrayBuffer(); });
  assert.equal(changed, true);
  for (let i = 0; i < 200 && fs.readdirSync(f.tempRoot).length; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fs.readdirSync(f.tempRoot), []);
  for (const table of ['redraw_reference_artifact_imports', 'async_tasks', 'tenant_usage_reservations', 'video_generations']) {
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  }
});

test('motion-processing real FFmpeg failure and client abort remove only request temporaries', async (t) => {
  for (const mode of ['ffmpeg_failure', 'abort']) await t.test(mode, async (t) => {
    const abort = new AbortController();
    let called = 0, closed = 0;
    const f = await httpFixture(t, { routes: { motionProcessingExecFile(binary, args, options, callback) {
      called += 1;
      const child = execFile(binary, mode === 'ffmpeg_failure' ? ['-invalid-motion-processing-test-option'] : args, options, callback);
      child.once('close', () => { closed += 1; });
      if (mode === 'abort') setImmediate(() => abort.abort());
      return child;
    } } });
    const sentinel = path.join(f.tempRoot, 'other-request.txt');
    fs.writeFileSync(sentinel, 'unrelated');
    const before = snapshot(f);
    if (mode === 'abort') await assert.rejects(fetch(f.url(), { headers: f.headers, signal: abort.signal }));
    else { const response = await f.get(); assert.equal(response.status, 409, await response.text()); }
    for (let i = 0; i < 300 && (fs.readdirSync(f.tempRoot).length !== 1 || closed !== called); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(called > 0);
    assert.equal(closed, called);
    assert.deepEqual(fs.readdirSync(f.tempRoot), ['other-request.txt']);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unrelated');
    assert.deepEqual(snapshot(f), before);
  });
});

test('motion-processing envelope and multipart report limits reject without truncation or registration', async (t) => {
  const f = await httpFixture(t);
  const result = await envelope(f, await f.get());
  const service = require('../src/services/redrawMotionProcessingReportService');
  const value = { report: result.report, size: result.video.length, sha256: result.report.output.sha256, mime: 'video/mp4' };
  assert.throws(() => service.envelopeHeader({ ...value, size: 200 * 1024 * 1024 + 1 }), { code: 'REDRAW_MOTION_PROCESSING_TOO_LARGE' });
  assert.throws(() => service.envelopeHeader({ ...value, report: { ...result.report, quality_review: 'x'.repeat(8 * 1024 * 1024) } }),
    { code: 'REDRAW_MOTION_PROCESSING_TOO_LARGE' });
  const form = new FormData();
  form.set('processing_report', 'x'.repeat(8 * 1024 * 1024 + 1));
  const response = await fetch(`${f.base}/redraw/shots/1/motion-reference`, { method: 'POST', headers: f.headers, body: form });
  assert.equal(response.status, 413, await response.text());
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM redraw_reference_artifact_imports').get().n, 0);
});

test('motion-processing import rechecks trusted coverage after storing bytes and before its transaction', async (t) => {
  const f = await httpFixture(t);
  const result = await envelope(f, await f.get());
  const rename = fs.promises.rename.bind(fs.promises);
  let injected = 0;
  const before = snapshot(f);
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    await rename(from, to);
    if (String(to).endsWith(`${result.report.output.sha256}.mp4`)) {
      injected += 1;
      f.db.prepare("UPDATE redraw_assets SET approved_at = 'drift-before-import-transaction' WHERE id = 201").run();
    }
  });
  await assert.rejects(importMotionReferenceArtifact(f.ctx, importInput(result)), { code: 'REDRAW_MOTION_PROCESSING_CONFLICT' });
  assert.equal(injected, 1);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, before.changes + 1);
  assert.deepEqual(snapshot(f).files, before.files);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM redraw_reference_artifact_imports').get().n, 0);
});

test('motion-processing valid returned report cannot grant review and same key cannot substitute another report', async (t) => {
  const f = await httpFixture(t);
  const result = await envelope(f, await f.get());
  const before = snapshot(f);
  await assert.rejects(importMotionReferenceArtifact(f.ctx, importInput(result, { fullFrameReviewed: false })),
    { code: 'REDRAW_MOTION_REFERENCE_REVIEW_REQUIRED' });
  assert.deepEqual(snapshot(f), before);
  await importMotionReferenceArtifact(f.ctx, importInput(result));
  const altered = structuredClone(result.report);
  altered.frames[0].processed_png_sha256 = 'e'.repeat(64); // Still an unattested claim, but not the same request.
  const imported = snapshot(f);
  await assert.rejects(importMotionReferenceArtifact(f.ctx, importInput(result, { processingReport: JSON.stringify(altered) })),
    { code: 'REDRAW_REFERENCE_ARTIFACT_IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(snapshot(f), imported);
});

test('motion-processing rejects schema, owner, source, CAS, frame, mask, timing and upload discrepancies before import', async (t) => {
  const f = await httpFixture(t);
  const result = await envelope(f, await f.get());
  const mutations = [
    (r) => { r.schema_version = 'unknown'; }, (r) => { r.approval_status = 'approved'; },
    (r) => { r.owner.user_id = 'other'; }, (r) => { r.owner.extra = 'private'; },
    (r) => { r.source_fingerprint = 'e'.repeat(64); }, (r) => { r.source_size += 1; },
    (r) => { r.shot.expected_updated_at = 'old'; }, (r) => { r.version_id += 1; },
    (r) => { r.work_id += 1; }, (r) => { r.shot_id += 1; }, (r) => { r.facts_hash = 'e'.repeat(64); },
    (r) => { r.coverage.approved_at = 'new'; }, (r) => { r.input_binding_sha256 = 'e'.repeat(64); },
    (r) => { r.input_frame_mask_set_sha256 = 'e'.repeat(64); },
    (r) => { r.frames.pop(); }, (r) => { r.frames.push(r.frames[0]); },
    (r) => { r.frames[1].masks.pop(); }, (r) => { r.frames[1].masks.push(r.frames[1].masks[0]); },
    (r) => { r.frames[1].masks[0].sha256 = 'e'.repeat(64); },
    (r) => { r.frames[0].source_frame_sha256 = 'e'.repeat(64); },
    (r) => { r.frames[0].clip_interval.start.ticks += 1; },
    (r) => { r.frames[0].path = '/secret'; }, (r) => { r.output.sha256 = 'e'.repeat(64); },
    (r) => { r.output.size += 1; }, (r) => { r.output_probe.frame_count += 1; },
    (r) => { r.output_probe.frames[0].pts += 1; }, (r) => { r.source_probe.width += 2; },
    (r) => { r.timing.frames[0].duration += 1; },
    (r) => { r.source_probe.duration_ms += 1; }, (r) => { r.source_probe.duration_ticks += 1; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const report = structuredClone(result.report);
    mutate(report);
    const before = snapshot(f);
    await assert.rejects(importMotionReferenceArtifact(f.ctx, importInput(result, {
      processingReport: JSON.stringify(report), idempotencyKey: `invalid-report-${index}`,
    })), (error) => /^REDRAW_MOTION_PROCESSING_(INVALID|CONFLICT)$/.test(error.code), `mutation ${index}`);
    assert.deepEqual(snapshot(f), before, `mutation ${index} must not write`);
  }
  for (const raw of ['', '{', 'null', '[]', '{"x":1}', '\uD800', ' '.repeat(8 * 1024 * 1024 + 1)]) {
    const before = snapshot(f);
    await assert.rejects(importMotionReferenceArtifact(f.ctx, importInput(result, { processingReport: raw })),
      (error) => /^REDRAW_MOTION_PROCESSING_(INVALID|TOO_LARGE)$/.test(error.code));
    assert.deepEqual(snapshot(f), before);
  }
});
