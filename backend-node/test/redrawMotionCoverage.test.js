const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadReviewedMotionCoverage } = require('../src/services/redrawReferenceBundleService');
const { validateReviewedCoverageManifest } = require('../src/services/redrawFullFrameReviewService');
const { fixture, snapshot, sha256, NOW, OWNER, WIDTH, HEIGHT } = require('./helpers/redrawMotionCoverageFixture');
const COVERAGE = 'REDRAW_REFERENCE_BUNDLE_COVERAGE_EVIDENCE_REQUIRED';
const CONFLICT = 'REDRAW_REFERENCE_BUNDLE_CONFLICT';
const NOT_FOUND = 'REDRAW_REFERENCE_BUNDLE_NOT_FOUND';
const INPUT = 'REDRAW_REFERENCE_BUNDLE_INPUT_INVALID';

test('trusted per-frame motion coverage reader is exported', () => {
  assert.equal(typeof loadReviewedMotionCoverage, 'function');
});

test('isolated fixture passes the full real reviewed coverage validator', async (t) => {
  const f = await fixture(t);
  await validateReviewedCoverageManifest({ evidenceRoot: f.evidenceRoot, manifest: f.manifest });
});

test('nonuniform PTS includes the preceding frame at an intra-frame cut and excludes endpoint-only contact', async (t) => {
  const f = await fixture(t);
  const before = snapshot(f);
  const result = await loadReviewedMotionCoverage(f.ctx, f.input);
  assert.equal(result.schema_version, 'redraw-motion-obscuration-input-v1');
  assert.equal(result.approval_status, 'pending');
  assert.deepEqual(result.owner, { tenant_id: OWNER.tenantId, user_id: OWNER.userId });
  assert.equal(result.work_id, 1);
  assert.equal(result.version_id, 1);
  assert.equal(result.shot_id, 2);
  assert.equal(result.source_shot_id, 'shot-2');
  assert.equal(result.source_asset_id, 101);
  assert.equal(result.source_fingerprint, f.fingerprint);
  assert.equal(result.facts_hash, f.factsHash);
  assert.deepEqual(result.coverage, {
    analysis_sha256: f.manifest.analysis_sha256, file_sha256: sha256(fs.readFileSync(f.manifestPath)),
    approved_by: OWNER.userId, approved_at: NOW,
  });
  assert.deepEqual(result.shot, { expected_updated_at: NOW, start_ms: 250, end_ms: 1100 });
  assert.deepEqual(result.source, { width: WIDTH, height: HEIGHT, time_base: { numerator: 1, denominator: 30 } });
  assert.deepEqual(result.frames.map((frame) => frame.frame_index), [1, 2, 3]);
  assert.deepEqual(result.frames.map((frame) => frame.timestamp_ticks), [3, 12, 21]);
  const ticks = (value) => ({ ticks: value, time_base: { numerator: 1, denominator: 30 } });
  const ms = (value) => ({ ticks: value, time_base: { numerator: 1, denominator: 1000 } });
  assert.deepEqual(result.frames[0].display_interval, { start: ticks(3), end: ticks(12) });
  assert.deepEqual(result.frames[0].clip_interval, { start: ms(250), end: ticks(12) });
  assert.deepEqual(result.frames[2].clip_interval, { start: ticks(21), end: ticks(33) });
  assert.deepEqual(result.frames[0].time_base, { numerator: 1, denominator: 30 });
  assert.deepEqual(result.frames[0].person_regions.map((region) => region.kind).sort(), ['background_extra', 'story_role']);
  assert.equal(result.frames[1].text_regions[0].region_key, 'subtitle');
  assert.deepEqual(result.frames[2].person_regions, []);
  assert.deepEqual(result.frames[2].text_regions, []);
  for (const frame of result.frames) {
    assert.equal(path.isAbsolute(frame.path), true);
    assert.equal(sha256(fs.readFileSync(frame.path)), frame.sha256);
    for (const region of [...frame.person_regions, ...frame.text_regions]) {
      assert.equal(path.isAbsolute(region.mask.path), true);
      assert.equal(sha256(fs.readFileSync(region.mask.path)), region.mask.sha256);
    }
  }
  assert.deepEqual(snapshot(f), before, 'reader does not alter SQLite, source, manifests, frames or masks');
});

test('last frame ends at source duration while retaining fractional original PTS', async (t) => {
  const f = await fixture(t);
  const result = await loadReviewedMotionCoverage(f.ctx, { ...f.input, shot_id: 3 });
  assert.deepEqual(result.frames.map((frame) => frame.frame_index), [4, 5]);
  assert.deepEqual(result.frames[1].display_interval, {
    start: { ticks: 349, time_base: { numerator: 1, denominator: 30 } },
    end: { ticks: 12000, time_base: { numerator: 1, denominator: 1000 } },
  });
  assert.deepEqual(result.frames[1].clip_interval, result.frames[1].display_interval);
  assert.deepEqual(result.frames[1].person_regions, []);
  assert.deepEqual(result.frames[1].text_regions, []);
  const firstShot = await loadReviewedMotionCoverage(f.ctx, { ...f.input, shot_id: 1 });
  assert.deepEqual(firstShot.frames.map((frame) => frame.frame_index), [0, 1]);
  assert.deepEqual(firstShot.frames[1].clip_interval.end, { ticks: 250, time_base: { numerator: 1, denominator: 1000 } });
});

for (const [name, start, end, duration] of [
  ['noninteger start', 0.5, 1100, 1099.5],
  ['duration mismatch', 250, 1100, 851],
  ['noninteger end', 250, 1100.5, 850.5],
]) {
  test(`malformed motion coverage timeline: ${name} uses coverage error without writes`, async (t) => {
    const f = await fixture(t);
    f.db.prepare('UPDATE redraw_shots SET start_ms = ?, end_ms = ?, duration_ms = ? WHERE id = 2')
      .run(start, end, duration);
    const before = snapshot(f);
    await assert.rejects(() => loadReviewedMotionCoverage(f.ctx, f.input), { code: COVERAGE });
    assert.deepEqual(snapshot(f), before);
  });
}

for (const [name, start, end, duration] of [
  ['negative start', -1, 1100, 1101],
  ['end equals start', 250, 250, 0],
  ['end precedes start', 250, 200, -50],
]) {
  test(`malformed motion coverage timeline: SQLite itself rejects ${name} without writes`, async (t) => {
    const f = await fixture(t);
    const before = snapshot(f);
    assert.throws(() => f.db.prepare('UPDATE redraw_shots SET start_ms = ?, end_ms = ?, duration_ms = ? WHERE id = 2')
      .run(start, end, duration), { code: 'SQLITE_CONSTRAINT_CHECK' });
    assert.deepEqual(snapshot(f), before);
  });
}

const mutations = [
  ['foreign caller tenant', (f) => { f.ctx.tenantId = 'foreign'; }, NOT_FOUND],
  ['foreign caller user', (f) => { f.ctx.userId = 'foreign'; }, NOT_FOUND],
  ['inactive tenant', (f) => f.db.prepare("UPDATE tenants SET status = 'disabled'").run(), NOT_FOUND],
  ['inactive member', (f) => f.db.prepare("UPDATE tenant_members SET status = 'disabled'").run(), NOT_FOUND],
  ['missing member', (f) => f.db.prepare('DELETE FROM tenant_members').run(), NOT_FOUND],
  ...['redraw_projects', 'redraw_works', 'redraw_versions', 'redraw_shots'].flatMap((table) => [
    [`deleted ${table}`, (f) => f.db.prepare(`UPDATE ${table} SET deleted_at = ?`).run(NOW), NOT_FOUND],
    [`foreign ${table} owner`, (f) => f.db.prepare(`UPDATE ${table} SET user_id = 'foreign'`).run(), NOT_FOUND],
  ]),
  ['foreign source asset', (f) => f.db.prepare('UPDATE assets SET metadata = ? WHERE id = 101')
    .run(JSON.stringify({ tenant_id: OWNER.tenantId, user_id: 'foreign', sha256: f.fingerprint })), COVERAGE],
  ['missing source owner', (f) => f.db.prepare('UPDATE assets SET metadata = ? WHERE id = 101')
    .run(JSON.stringify({ sha256: f.fingerprint })), COVERAGE],
  ['deleted source', (f) => f.db.prepare('UPDATE assets SET deleted_at = ? WHERE id = 101').run(NOW), COVERAGE],
  ['source SHA changed', (f) => fs.appendFileSync(f.sourcePath, 'changed'), COVERAGE],
  ['source metadata SHA drift', (f) => f.db.prepare('UPDATE assets SET metadata = ? WHERE id = 101')
    .run(JSON.stringify({ tenant_id: OWNER.tenantId, user_id: OWNER.userId, sha256: 'a'.repeat(64) })), COVERAGE],
  ['CAS mismatch', (f) => { f.input.expected_updated_at = 'stale'; }, CONFLICT],
  ['approval pending', (f) => f.db.prepare("UPDATE redraw_assets SET approval_status = 'pending'").run(), COVERAGE],
  ['approval absent', (f) => f.db.prepare('UPDATE redraw_assets SET approved_by = NULL').run(), COVERAGE],
  ['facts binding drift', (f) => { f.sourceRef.snapshot.facts_hash = 'a'.repeat(64);
    f.db.prepare('UPDATE redraw_assets SET source_ref_json = ?').run(JSON.stringify(f.sourceRef)); }, COVERAGE],
  ['analysis drift', (f) => { f.sourceRef.snapshot.analysis_sha256 = 'b'.repeat(64);
    f.db.prepare('UPDATE redraw_assets SET source_ref_json = ?').run(JSON.stringify(f.sourceRef)); }, COVERAGE],
  ['unreviewed manifest', (f) => f.rewriteManifest((manifest) => { manifest.status = 'generated'; }), COVERAGE],
  ['missing frame', (f) => f.rewriteManifest((manifest) => { manifest.frames.pop(); }), COVERAGE],
  ['visible track without region', (f) => f.rewriteManifest((manifest) => {
    manifest.person_tracks[0].regions = [];
    manifest.frames[1].person_region_ids = manifest.frames[1].person_region_ids.filter((id) => id !== 'person-1');
  }), COVERAGE],
  ['tampered frame PNG', (f) => fs.appendFileSync(path.join(f.evidenceRoot, 'frames/frame-1.png'), 'changed'), COVERAGE],
  ['tampered mask PNG', (f) => fs.appendFileSync(path.join(f.evidenceRoot, 'masks/person-1.png'), 'changed'), COVERAGE],
  ['fake PNG with consistent hash', (f) => f.rewriteManifest((manifest) => {
    const bytes = Buffer.from('not-a-png'); fs.writeFileSync(path.join(f.evidenceRoot, manifest.frames[1].path), bytes);
    manifest.frames[1].sha256 = sha256(bytes);
  }), COVERAGE],
  ['fake mask with consistent hash', (f) => f.rewriteManifest((manifest) => {
    const mask = manifest.person_tracks[0].regions[0].mask;
    const bytes = Buffer.from('not-a-mask'); fs.writeFileSync(path.join(f.evidenceRoot, mask.path), bytes); mask.sha256 = sha256(bytes);
  }), COVERAGE],
];
for (const [name, mutate, code] of mutations) {
  test(`rejects ${name} without business or evidence writes`, async (t) => {
    const f = await fixture(t); mutate(f);
    const before = snapshot(f);
    await assert.rejects(() => loadReviewedMotionCoverage(f.ctx, f.input), { code });
    assert.deepEqual(snapshot(f), before);
  });
}

for (const input of [{}, { shot_id: 2 }, { shot_id: 0, expected_updated_at: NOW },
  { shot_id: 2, expected_updated_at: NOW, evidenceRoot: 'caller-supplied' }]) {
  test(`rejects malformed input ${JSON.stringify(input)}`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(() => loadReviewedMotionCoverage(f.ctx, input), { code: INPUT });
  });
}

for (const name of ['CAS', 'membership', 'approval', 'source', 'manifest', 'earlier-frame']) {
  test(`rechecks ${name} after asynchronous validation starts`, async (t) => {
    const f = await fixture(t);
    const originalOpen = fs.promises.open;
    let changed = false;
    let afterMutation;
    t.mock.method(fs.promises, 'open', async function (...args) {
      const handle = await originalOpen.apply(this, args);
      if (!changed && String(args[0]).endsWith('frame-5.png')) {
        changed = true;
        if (name === 'CAS') f.db.prepare("UPDATE redraw_shots SET updated_at = 'changed' WHERE id = 2").run();
        if (name === 'membership') f.db.prepare("UPDATE tenant_members SET status = 'disabled'").run();
        if (name === 'approval') f.db.prepare("UPDATE redraw_assets SET approval_status = 'pending'").run();
        if (name === 'source') fs.appendFileSync(f.sourcePath, 'racing-source-change');
        if (name === 'manifest') f.db.prepare("UPDATE redraw_assets SET approved_at = 'changed'").run();
        if (name === 'earlier-frame') fs.appendFileSync(path.join(f.evidenceRoot, 'frames/frame-0.png'), 'racing-frame-change');
        afterMutation = snapshot(f);
      }
      return handle;
    });
    await assert.rejects(() => loadReviewedMotionCoverage(f.ctx, f.input), (error) => [CONFLICT, NOT_FOUND, COVERAGE].includes(error.code));
    assert.equal(changed, true, 'race is injected inside real filesystem validation');
    assert.deepEqual(snapshot(f), afterMutation);
  });
}
