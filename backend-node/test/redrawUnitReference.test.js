'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const servicePath = path.join(__dirname, '../src/services/redrawUnitReferenceService.js');
const { fixture, hash } = require('./helpers/redrawUnitReferenceFixture');
const { compileUnitProductionPack } = require('../src/services/redrawUnitProductionPackService');
const { saveReferenceBundle, buildCurrentReferenceBindings } = require('../src/services/redrawReferenceBundleService');
const { probeVideo } = require('../scripts/run-redraw-reference-bundle-local-case');
const { prepareMotionReferenceCandidate } = require('../src/services/redrawReferenceArtifactImportService');

function inspector() {
  const service = fs.existsSync(servicePath) ? require(servicePath) : {};
  assert.equal(typeof service.inspectUnitReferenceMaterials, 'function');
  return service.inspectUnitReferenceMaterials;
}

function storageSnapshot(root) {
  return Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(item => item.isFile() && !item.name.startsWith('fixture.sqlite'))
    .map(item => { const file = path.join(item.parentPath || item.path, item.name);
      return [path.relative(root, file), hash(fs.readFileSync(file))]; }).sort(([a], [b]) => a.localeCompare(b)));
}

test('unit reference materials exposes a read-only current-unit inspector', () => {
  const service = fs.existsSync(servicePath) ? require(servicePath) : {};
  assert.equal(typeof service.inspectUnitReferenceMaterials, 'function');
  assert.deepEqual(Object.keys(service), ['inspectUnitReferenceMaterials']);
});

test('real fixture produces a current unit, full reusable parent materials and no inspection writes', async t => {
  const h = await fixture(t, { sourceAssetAsString: true });
  assert.equal(h.sourceProbe.audio_stream_count, 1);
  assert.deepEqual(h.queueState.queue.units.map(unit => [unit.plan_unit.source_start_ms, unit.plan_unit.source_end_ms]),
    [[0, 5000], [5000, 10000], [10000, 12000]]);
  const inspect = inspector();
  const before = { db: h.db.serialize(), changes: h.db.prepare('SELECT total_changes() n').get().n, files: storageSnapshot(h.root) };
  const actual = await inspect(h.ctx, h.expected(0));
  const again = await inspect(h.ctx, h.expected(0));
  assert.deepEqual(actual, again);
  assert.equal(actual.schema_version, 'redraw-unit-reference-materials-v1');
  assert.equal(actual.bindings.unit_id, h.expected(0).unit_id);
  assert.equal(actual.bindings.source_asset_id, 101);
  assert.equal(actual.bindings.production_pack_hash, compileUnitProductionPack({ owner: {
    tenantId: 'tenant-a', userId: 'user-a', workId: 1, versionId: h.versionId,
  }, expected: h.expected(0), queueState: h.queueState, blueprint: h.blueprint, localization: h.localization }).production_pack_hash);
  assert.deepEqual(actual.references.map(ref => ref.requirement_id), ['identity-character-001', 'identity-character-002', 'motion-shot-1']);
  assert.deepEqual(actual.references.map(ref => ref.asset_id), [301, 302, 305]);
  assert.equal(actual.references[2].state, 'reusable');
  assert.deepEqual(actual.references[2].parent_range, { start_ms: 0, end_ms: 5000 });
  assert.deepEqual(actual.references[2].source_range, { start_ms: 0, end_ms: 5000 });
  assert.deepEqual(actual.references[2].parent_offsets, { start_ms: 0, end_ms: 5000 });
  assert.equal(actual.parents[0].dependencies.identities.length, 2);
  assert.equal(actual.parents[0].dependencies.text_clean.length, 2);
  assert.match(actual.materials_hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(actual), /(?:https?:|local_path|provider|ready|generated_at|created_at|price|credits)/);
  assert.deepEqual(h.db.serialize(), before.db);
  assert.equal(h.db.prepare('SELECT total_changes() n').get().n, before.changes);
  assert.deepEqual(storageSnapshot(h.root), before.files);
  assert.deepEqual(fs.readdirSync(h.ctx.tempRoot), [], 'private source snapshots are cleaned after successful inspection');
  // A newer draft is not the current version's locked blueprint revision.
  h.db.prepare(`INSERT INTO redraw_episode_blueprints (work_id, tenant_id, user_id, revision, status,
    blueprint_json, blueprint_hash, created_at, updated_at) VALUES (1, 'tenant-a', 'user-a', 2, 'draft', '{}', '', 'fixture', 'fixture')`).run();
  assert.deepEqual(await inspect(h.ctx, h.expected(0)), actual);
});

test('partial overlap reports exact derivation bounds without publishing trimmed media', async t => {
  const h = await fixture(t, { secondMotion: true });
  assert.deepEqual(h.queueState.queue.units[2].plan_unit.parent_shots.map(parent =>
    [parent.id, parent.source_start_ms, parent.source_end_ms]), [['shot-2', 10000, 12000]]);
  const inspect = inspector();
  const before = storageSnapshot(h.root);
  const result = await inspect(h.ctx, h.expected(2));
  const motion = result.references.find(ref => ref.kind === 'video');
  assert.equal(motion.state, 'needs_derivation');
  assert.equal(motion.asset_id, 502);
  assert.deepEqual(motion.parent_range, { start_ms: 5000, end_ms: 12000 });
  assert.deepEqual(motion.source_range, { start_ms: 10000, end_ms: 12000 });
  assert.deepEqual(motion.parent_offsets, { start_ms: 5000, end_ms: 7000 });
  assert.deepEqual(storageSnapshot(h.root), before);
});

test('actual cross-parent offscreen unit works before old parent dialogue bundle can be saved', async t => {
  const h = await fixture(t, { durations: [15], crossParent: true, secondMotion: true });
  assert.equal(h.queueState.queue.units.length, 1);
  const unit = h.queueState.queue.units[0].plan_unit;
  assert.deepEqual([unit.dialogues[0].start_ms, unit.dialogues[0].end_ms], [4500, 7000]);
  h.db.prepare('UPDATE redraw_shots SET source_dialogue_json = ?, localized_dialogue_json = ? WHERE id = ?').run(
    JSON.stringify([{ speaker_id: 'character-002', text: '等我回来。', start_ms: 5000, end_ms: 7000 }]),
    JSON.stringify([{ speaker_id: 'character-002', localized_text: 'Wait for me.', start_ms: 5000, end_ms: 7000 }]), h.secondShotId);
  const bindings = await buildCurrentReferenceBindings(h.ctx, { shot_id: h.secondShotId, clean_results: [] });
  const shot = h.db.prepare('SELECT * FROM redraw_shots WHERE id = ?').get(h.secondShotId);
  await assert.rejects(saveReferenceBundle(h.ctx, { shot_id: h.secondShotId, expected_updated_at: shot.updated_at,
    motion_reference_asset_id: 502, face_tracks: bindings.face_tracks, text_regions: bindings.text_regions,
    coverage_review: bindings.coverage_review }), { code: 'REDRAW_REFERENCE_BUNDLE_DIALOGUE_REQUIRED' });
  const inspect = inspector();
  const result = await inspect(h.ctx, h.expected(0));
  assert.deepEqual(result.references.map(ref => ref.requirement_id), unit.reference_requirements.map(ref => ref.id));
  assert.deepEqual(result.references.filter(ref => ref.kind === 'video').map(ref => ref.asset_id), [305, 502]);
  assert.deepEqual(result.references.filter(ref => ref.kind === 'video').map(ref => ref.state), ['reusable', 'reusable']);
  assert.deepEqual(result.parents.map(parent => parent.parent_shot_id), ['shot-1', 'shot-2']);
  assert.deepEqual(result.references.filter(ref => ref.kind === 'image').map(ref => ref.target_character_name), ['Ethan', 'Maya']);
});

test('final candidate cleanup preserves initially validated asset state and import identity', async t => {
  const h = await fixture(t, { durations: [15], crossParent: true, secondMotion: true });
  const inspect = inspector();
  const expected = h.expected(0);
  const rejection = error => /^(?:REDRAW_|EXECUTION_|SOURCE_|BLUEPRINT_|LOCALIZATION_)/.test(error.code || '');
  const importId = h.db.prepare(`SELECT id FROM redraw_reference_artifact_imports
    WHERE stored_asset_id = 305 AND status = 'completed' ORDER BY id DESC LIMIT 1`).get().id;
  const metadata = JSON.parse(h.db.prepare('SELECT metadata FROM assets WHERE id = 305').get().metadata);
  metadata.redraw_motion_import.review.motion_preserved = false;
  const cases = [
    ['assets', 305, 'width', 865], ['assets', 305, 'height', 497],
    ['assets', 305, 'file_size', 1], ['assets', 305, 'duration', 99],
    ['assets', 305, 'mime_type', 'application/octet-stream'], ['assets', 305, 'type', 'image'],
    ['assets', 305, 'category', 'other'], ['assets', 305, 'deleted_at', 'deleted'],
    ['assets', 305, 'local_path', 'redraw/missing-motion.mp4'],
    ['assets', 305, 'metadata', JSON.stringify(metadata)],
    ['redraw_reference_artifact_imports', importId, 'stored_asset_id', 502],
    ['redraw_reference_artifact_imports', importId, 'file_sha256', '0'.repeat(64)],
  ];
  for (const [table, id, column, value] of cases) {
    await t.test(`${table}.${column}: invalid at entry`, async () => {
      h.db.exec('SAVEPOINT unit_reference_candidate_entry');
      try {
        h.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(value, id);
        await assert.rejects(inspect(h.ctx, expected), rejection);
      } finally { h.db.exec('ROLLBACK TO unit_reference_candidate_entry; RELEASE unit_reference_candidate_entry'); }
    });
  }
  // Import identity may change to another valid row ID between separate calls, but
  // must not disappear beneath the asset's same-named id during this inspection.
  for (const [table, id, column, value] of [...cases,
    ['redraw_reference_artifact_imports', importId, 'id', importId + 100000]]) {
    await t.test(`${table}.${column}: drift after final real handle close`, async () => {
      h.db.exec('SAVEPOINT unit_reference_candidate_cleanup');
      const secondPath = path.resolve(h.root, h.db.prepare('SELECT local_path FROM assets WHERE id = 502').get().local_path);
      const originalOpen = fs.promises.open;
      let changed = false;
      const mocked = t.mock.method(fs.promises, 'open', async (...args) => {
        const handle = await originalOpen(...args);
        if (path.resolve(String(args[0])) === secondPath) {
          const close = handle.close.bind(handle);
          handle.close = async () => {
            await close();
            if (!changed) {
              h.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(value, id);
              changed = true;
            }
          };
        }
        return handle;
      });
      try {
        let result; let error;
        try { result = await inspect(h.ctx, expected); } catch (caught) { error = caught; }
        assert.equal(changed, true, 'mutation follows the actual second-parent handle close');
        assert.equal(h.db.prepare(`SELECT ${column} AS value FROM ${table} WHERE id = ?`)
          .get(column === 'id' ? value : id).value, value);
        assert.equal(Boolean(result), false, `changed ${table}.${column} cannot return current materials`);
        assert.ok(error && rejection(error), `changed ${table}.${column} must produce a domain rejection`);
      } finally { mocked.mock.restore(); h.db.exec('ROLLBACK TO unit_reference_candidate_cleanup; RELEASE unit_reference_candidate_cleanup'); }
    });
  }
  assert.deepEqual(fs.readdirSync(h.ctx.tempRoot), [], 'candidate rejection leaves no private source snapshot');
});

test('current unit keeps the existing active owner gate after final real cleanup', async t => {
  const h = await fixture(t, { durations: [15], crossParent: true, secondMotion: true });
  const inspect = inspector();
  const secondPath = path.resolve(h.root, h.db.prepare('SELECT local_path FROM assets WHERE id = 502').get().local_path);
  for (const table of ['tenant_members', 'tenants']) {
    await t.test(`${table} disabled at entry`, async () => {
      h.db.exec('SAVEPOINT unit_reference_owner_entry');
      try {
        h.db.prepare(`UPDATE ${table} SET status = 'disabled'`).run();
        await assert.rejects(inspect(h.ctx, h.expected(0)), { code: 'REDRAW_MOTION_CANDIDATE_NOT_FOUND' });
      } finally { h.db.exec('ROLLBACK TO unit_reference_owner_entry; RELEASE unit_reference_owner_entry'); }
    });
    await t.test(`${table} disabled after final real motion handle close`, async () => {
      h.db.exec('SAVEPOINT unit_reference_owner_cleanup');
      const originalOpen = fs.promises.open;
      let changed = false;
      const mocked = t.mock.method(fs.promises, 'open', async (...args) => {
        const handle = await originalOpen(...args);
        if (path.resolve(String(args[0])) === secondPath) {
          const close = handle.close.bind(handle);
          handle.close = async () => {
            await close();
            if (!changed) { h.db.prepare(`UPDATE ${table} SET status = 'disabled'`).run(); changed = true; }
          };
        }
        return handle;
      });
      try {
        let result; let error;
        try { result = await inspect(h.ctx, h.expected(0)); } catch (caught) { error = caught; }
        assert.equal(changed, true, 'owner mutation follows the actual final motion handle close');
        assert.deepEqual(h.db.prepare(`SELECT status FROM ${table}`).all().map(row => row.status), ['disabled']);
        assert.equal(Boolean(result), false, 'inactive owner cannot receive current unit materials');
        assert.equal(error?.code, 'REDRAW_MOTION_CANDIDATE_NOT_FOUND');
      } finally { mocked.mock.restore(); h.db.exec('ROLLBACK TO unit_reference_owner_cleanup; RELEASE unit_reference_owner_cleanup'); }
    });
  }
  assert.deepEqual(fs.readdirSync(h.ctx.tempRoot), []);
});

test('motion candidate record checks survive cleanup without restoring file access', async t => {
  const h = await fixture(t);
  const before = { db: hash(h.db.serialize()), changes: h.db.prepare('SELECT total_changes() n').get().n,
    files: storageSnapshot(h.root) };
  const controller = new AbortController();
  const shot = h.db.prepare('SELECT updated_at FROM redraw_shots WHERE id = ?').get(h.shotId);
  const handle = await prepareMotionReferenceCandidate({ ...h.ctx, signal: controller.signal }, {
    tenantId: h.ctx.tenantId, userId: h.ctx.userId, shotId: h.shotId,
    expectedUpdatedAt: shot.updated_at, expectedSourceSha256: h.sourceFingerprint,
  });
  try {
    assert.equal(handle.data.status, 'available');
    assert.equal(typeof handle.assertCurrentRecordBinding, 'function');
    assert.doesNotThrow(handle.assertCurrentRecordBinding);
    assert.doesNotThrow(handle.assertCurrentBinding);
    await handle.cleanup();
    await handle.cleanup();
    assert.doesNotThrow(handle.assertCurrentRecordBinding);
    assert.throws(handle.assertCurrentBinding, { code: 'REDRAW_MOTION_CANDIDATE_CONFLICT' });
    assert.throws(handle.createReadStream, { code: 'REDRAW_MOTION_CANDIDATE_UNAVAILABLE' });
    assert.equal(hash(h.db.serialize()), before.db);
    assert.equal(h.db.prepare('SELECT total_changes() n').get().n, before.changes);
    for (const [name, mutate, code] of [
      ...['tenant_members', 'tenants'].map(table => [table,
        () => h.db.prepare(`UPDATE ${table} SET status = 'disabled'`).run(), 'REDRAW_MOTION_CANDIDATE_NOT_FOUND']),
      ['scope snapshot', () => h.db.prepare("UPDATE redraw_versions SET updated_at = 'changed' WHERE id = ?").run(h.versionId),
        'REDRAW_MOTION_CANDIDATE_CONFLICT'],
      ['latest candidate row', () => h.db.prepare('UPDATE redraw_reference_artifact_imports SET file_sha256 = ? WHERE stored_asset_id = 305')
        .run('0'.repeat(64)), 'REDRAW_MOTION_CANDIDATE_CONFLICT'],
    ]) await t.test(`${name} remains current after cleanup`, () => {
      h.db.exec('SAVEPOINT unit_reference_record');
      try {
        mutate();
        const mutated = { db: hash(h.db.serialize()), changes: h.db.prepare('SELECT total_changes() n').get().n };
        assert.throws(handle.assertCurrentRecordBinding, { code });
        assert.equal(hash(h.db.serialize()), mutated.db);
        assert.equal(h.db.prepare('SELECT total_changes() n').get().n, mutated.changes);
      }
      finally { h.db.exec('ROLLBACK TO unit_reference_record; RELEASE unit_reference_record'); }
    });
    const reason = new Error('UNIT_REFERENCE_RECORD_ABORT');
    controller.abort(reason);
    assert.throws(handle.assertCurrentRecordBinding, error => error === reason);
    assert.deepEqual(storageSnapshot(h.root), before.files);
  } finally { await handle.cleanup(); }
});

test('current materials reject owner, binding, approval, bytes and latest import drift', async t => {
  const h = await fixture(t, { durations: [15], crossParent: true, secondMotion: true });
  const inspect = inspector();
  const inspectCurrent = (ctx = h.ctx, expected = h.expected(0)) => inspect(ctx, expected);
  const rejection = error => /^(?:REDRAW_|EXECUTION_|SOURCE_|BLUEPRINT_|LOCALIZATION_)/.test(error.code || '');
  const updateMetadata = mutate => {
    const data = JSON.parse(h.db.prepare('SELECT metadata FROM assets WHERE id = 305').get().metadata);
    mutate(data); h.db.prepare('UPDATE assets SET metadata = ? WHERE id = 305').run(JSON.stringify(data));
  };
  const cases = [
    ['other owner', () => {}, () => inspectCurrent({ ...h.ctx, userId: 'other' })],
    ['other version', () => {}, () => inspectCurrent(h.ctx, { ...h.expected(0), version_id: 999 })],
    ['stale unit hash', () => {}, () => inspectCurrent(h.ctx, { ...h.expected(0), unit_hash: '0'.repeat(64) })],
    ['client material paths rejected', () => {}, () => inspectCurrent(h.ctx, { ...h.expected(0), storageRoot: h.root })],
    ['parent logical ID', () => h.db.prepare("UPDATE redraw_shots SET shot_id = 'wrong' WHERE id = ?").run(h.shotId)],
    ['ambiguous logical parent IDs', () => h.db.prepare("UPDATE redraw_shots SET shot_id = 'shot-1' WHERE id = ?").run(h.secondShotId)],
    ['parent range', () => h.db.prepare('UPDATE redraw_shots SET end_ms = 4999, duration_ms = 4999 WHERE id = ?').run(h.shotId)],
    ['source work', () => h.db.prepare("UPDATE redraw_shots SET work_id = '999' WHERE id = ?").run(h.shotId)],
    ['current source SHA', () => h.db.prepare('UPDATE redraw_works SET source_fingerprint = ? WHERE id = 1').run('0'.repeat(64))],
    ['identity approval', () => h.db.prepare("UPDATE redraw_assets SET approval_status = 'pending' WHERE id = 201").run()],
    ['current target name map', () => h.db.prepare('UPDATE redraw_versions SET name_map_json = ? WHERE id = ?')
      .run(JSON.stringify({ 'character-001': 'Changed', 'character-002': 'Maya' }), h.versionId)],
    ['coverage approval', () => h.db.prepare("UPDATE redraw_assets SET approval_status = 'pending' WHERE id = 205").run()],
    ['clean approval', () => h.db.prepare("UPDATE redraw_assets SET approval_status = 'pending' WHERE id = 203").run()],
    ['wardrobe missing', () => h.db.prepare("UPDATE assets SET deleted_at = 'deleted' WHERE id = 306").run()],
    ['identity artifact missing', () => h.db.prepare("UPDATE assets SET deleted_at = 'deleted' WHERE id = 301").run()],
    ...['full_frame_reviewed', 'source_identity_obscured', 'source_text_obscured', 'motion_preserved']
      .map(key => [`motion confirmation ${key}`, () => updateMetadata(metadata => { metadata.redraw_motion_import.review[key] = false; })]),
    ['motion bound ID drift', () => updateMetadata(metadata => { metadata.redraw_motion_reference.shot_id = h.secondShotId; })],
    ['latest completed missing candidate no fallback', () => h.db.prepare(`INSERT INTO redraw_reference_artifact_imports
      (tenant_id, user_id, version_id, scope_type, scope_id, purpose, idempotency_hash, request_hash,
      file_sha256, stored_asset_id, status, created_at, updated_at)
      VALUES ('tenant-a', 'user-a', ?, 'shot', ?, 'motion', ?, ?, ?, 9999, 'completed', 'fixture', 'fixture')`)
      .run(h.versionId, h.shotId, hash('latest-missing'), hash('latest-request'), h.motion.sha256)],
    ['processing report malformed', () => updateMetadata(metadata => { metadata.redraw_motion_processing = {}; })],
    ['missing material lookup', () => h.db.prepare("UPDATE redraw_shots SET preparation_snapshot_json = '{}' WHERE id = ?").run(h.shotId)],
  ];
  for (const [name, mutate, call = inspectCurrent] of cases) await t.test(name, async () => {
    h.db.exec('SAVEPOINT unit_reference_case');
    try { mutate(); await assert.rejects(call(), rejection); }
    finally { h.db.exec('ROLLBACK TO unit_reference_case; RELEASE unit_reference_case'); }
  });
  for (const [name, file] of [
    ['identity', h.identityImages[0]], ['wardrobe', path.join(h.root, 'redraw/wardrobe-306.png')],
    ['text clean', h.textImages[0]], ['motion', h.motionPath],
    ['coverage mask', path.join(h.root, 'coverage/version-1/masks/face-001.png')],
    ['source', path.join(h.root, 'source/source.mp4')],
  ]) await t.test(`${name} actual file tamper`, async () => {
    const bytes = fs.readFileSync(file);
    try { fs.appendFileSync(file, 'tampered'); await assert.rejects(inspectCurrent(), rejection); }
    finally { fs.writeFileSync(file, bytes); }
  });
  await t.test('approved identity with an absent actual file is rejected', async () => {
    const file = h.identityImages[0]; const bytes = fs.readFileSync(file);
    try { fs.unlinkSync(file); await assert.rejects(inspectCurrent(), rejection); }
    finally { fs.writeFileSync(file, bytes); }
  });
  for (const [name, mutate] of [
    ['earlier parent identity approval while later parent is probing', () => h.db.prepare("UPDATE redraw_assets SET approval_status = 'pending' WHERE id = 201").run()],
    ['earlier parent clean approval while later parent is probing', () => h.db.prepare("UPDATE redraw_assets SET approval_status = 'pending' WHERE id = 203").run()],
    ['earlier parent range while later parent is probing', () => h.db.prepare('UPDATE redraw_shots SET end_ms = 4999, duration_ms = 4999 WHERE id = ?').run(h.shotId)],
    ['current queue becomes stale while later parent is probing', () => h.db.prepare("UPDATE ai_service_configs SET updated_at = 'changed' WHERE id = 41").run()],
    ['current source while later parent is probing', () => h.db.prepare('UPDATE redraw_works SET source_fingerprint = ? WHERE id = 1').run('0'.repeat(64))],
  ]) await t.test(`async drift: ${name}`, async () => {
    h.db.exec('SAVEPOINT unit_reference_async');
    let probes = 0;
    try {
      await assert.rejects(inspectCurrent({ ...h.ctx, probeRunner: async file => {
        const actual = await probeVideo(file);
        if (++probes === 2) mutate();
        return { ...actual, mime_type: 'video/mp4' };
      } }), rejection);
      assert.equal(probes, 2, 'actual ffprobe wrapper controls only the async mutation point');
    } finally { h.db.exec('ROLLBACK TO unit_reference_async; RELEASE unit_reference_async'); }
  });
  await t.test('final candidate cleanup await cannot hide earlier parent approval drift', async () => {
    h.db.exec('SAVEPOINT unit_reference_cleanup');
    const originalOpen = fs.promises.open;
    let changed = false;
    const secondPath = h.db.prepare('SELECT local_path FROM assets WHERE id = 502').get().local_path;
    const mocked = t.mock.method(fs.promises, 'open', async (...args) => {
      const handle = await originalOpen(...args);
      if (path.resolve(String(args[0])) === path.resolve(h.root, secondPath)) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          if (!changed) {
            changed = true;
            h.db.prepare("UPDATE redraw_assets SET approval_status = 'pending' WHERE id = 201").run();
          }
        };
      }
      return handle;
    });
    try {
      await assert.rejects(inspectCurrent(), rejection);
      assert.equal(changed, true, 'real handle closure is the async mutation point');
    } finally { mocked.mock.restore(); h.db.exec('ROLLBACK TO unit_reference_cleanup; RELEASE unit_reference_cleanup'); }
  });
  assert.deepEqual(fs.readdirSync(h.ctx.tempRoot), [], 'private source snapshots are cleaned after every rejection');
});
