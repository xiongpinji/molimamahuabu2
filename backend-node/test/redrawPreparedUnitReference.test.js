'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { execFile, execFileSync } = require('node:child_process');
const { fixture, hash } = require('./helpers/redrawUnitReferenceDerivationFixture');
const { fixture: unitFixture } = require('./helpers/redrawUnitReferenceFixture');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const service = require('../src/services/redrawUnitReferenceDerivationService');
function inspector() {
  assert.equal(typeof service.inspectPreparedUnitReferenceMaterials, 'function', 'read-only prepared-unit inspection entry is required');
  return service.inspectPreparedUnitReferenceMaterials;
}
const rejected = error => /^(?:REDRAW_|EXECUTION_|SOURCE_|BLUEPRINT_|LOCALIZATION_)/.test(error.code || '');
const outputPath = (h, ref) => path.join(h.root, h.db.prepare('SELECT local_path FROM assets WHERE id = ?').get(ref.asset_id).local_path);
const changes = db => db.prepare('SELECT total_changes() n').get().n;
const files = root => fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
  .map(entry => { const file = path.join(entry.parentPath || entry.path, entry.name); return [path.relative(root, file), hash(fs.readFileSync(file))]; })
  .sort(([a], [b]) => a.localeCompare(b));
async function prepare(h, index = 1) {
  return service.prepareUnitReferenceMaterials(h.ctx, { ...h.expected(index), expected_materials_hash: (await h.materials(index)).materials_hash });
}
async function afterCandidateClose(h, mutate, action) {
  const original = fs.promises.open;
  const candidate = path.resolve(h.root, h.db.prepare('SELECT local_path FROM assets WHERE id = ?').get(h.processed.at(-1).imported.asset.id).local_path);
  let injected = false;
  fs.promises.open = async function(file, ...args) {
    const handle = await original.call(this, file, ...args);
    if (path.resolve(String(file)) === candidate) {
      const close = handle.close.bind(handle);
      handle.close = async () => { const result = await close(); if (!injected) { injected = true; mutate(); } return result; };
    }
    return handle;
  };
  try { await action(); assert.equal(injected, true, 'mutation follows real candidate close await'); }
  finally { fs.promises.open = original; }
}
function retain(h, prepared) {
  const root = process.env.G4_PREPARED_EVIDENCE_ROOT;
  if (!root) return;
  const rows = h.db.prepare('SELECT * FROM redraw_unit_reference_derivations ORDER BY id').all();
  for (const ref of prepared.references) fs.copyFileSync(outputPath(h, ref), path.join(root, `${ref.requirement_id}.mp4`), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(root, 'prepared-cross-parent.json'), JSON.stringify({ prepared, rows }, null, 2), { flag: 'wx' });
}

test('missing current authority is needs_preparation without writes, encoding, unit directories or success DTO', async t => {
  const h = await fixture(t), original = await h.materials(1);
  h.db.prepare("INSERT INTO assets (name, type, category, local_path, metadata) VALUES ('not authority', 'video', 'redraw_unit_reference', 'source/source.mp4', '{}')").run();
  const before = { changes: changes(h.db), files: files(h.root) };
  h.db.pragma('query_only = ON');
  const result = await inspector()({ ...h.ctx, execFile: () => assert.fail('unprepared inspection must not derive media') }, h.expected(1));
  assert.deepEqual(result, { schema_version: 'redraw-unit-prepared-reference-inspection-v1', bindings: original.bindings,
    materials_hash: original.materials_hash, status: 'needs_preparation', missing_requirement_ids: ['motion-shot-1'] });
  assert.equal(Object.hasOwn(result, 'prepared_materials'), false);
  assert.equal(changes(h.db), before.changes); assert.deepEqual(files(h.root), before.files);
  assert.equal(fs.existsSync(path.join(h.root, 'redraw-unit-reference')), false);
  assert.deepEqual(fs.readdirSync(h.ctx.tempRoot), []);
});

test('inspection accepts only the original six server bindings, never client prepared DTOs or paths', async t => {
  const h = await unitFixture(t);
  const inspect = inspector();
  for (const extra of [{ prepared_materials: {} }, { expected_materials_hash: 'f'.repeat(64) }, { asset_id: 305 },
    { path: h.root }, { [Symbol('hidden')]: true }]) {
    await assert.rejects(inspect(h.ctx, { ...h.expected(0), ...extra }), rejected);
  }
  await assert.rejects(inspect(h.ctx, Object.assign(Object.create({ client: true }), h.expected(0))), rejected);
});

test('whole-parent inspection equals explicit prepare without processing map or any derivation', async t => {
  const h = await fixture(t, { durations: [15], reports: false }), expected = h.expected(0);
  const original = await h.materials(0), prepared = await prepare(h, 0), before = { changes: changes(h.db), files: files(h.root) };
  h.db.pragma('query_only = ON');
  const result = await inspector()({ ...h.ctx, execFile: () => assert.fail('whole parent does not derive or probe a unit output') }, expected);
  assert.equal(result.status, 'prepared'); assert.deepEqual(result.prepared_materials, prepared);
  assert.deepEqual(result.prepared_materials.references, original.references);
  assert.deepEqual(await h.materials(0), original);
  assert.equal(changes(h.db), before.changes); assert.deepEqual(files(h.root), before.files);
  assert.equal(fs.existsSync(path.join(h.root, 'redraw-unit-reference')), false);
});

test('prepared cross-parent reads preserve order, full DTO and hash across repeats and a readonly connection', async t => {
  const h = await fixture(t, { parentRanges: [[0, 3000], [3000, 7000], [7000, 12000]] });
  const original = await h.materials(1), prepared = await prepare(h), inspect = inspector();
  assert.deepEqual(prepared.references.map(ref => ref.requirement_id), ['motion-shot-2', 'motion-shot-3']);
  assert.deepEqual(prepared.references.map(ref => ref.original_duration_ms), [4000, 5000]);
  assert.deepEqual(prepared.references.map(ref => h.db.prepare('SELECT duration FROM assets WHERE id = ?').get(ref.asset_id).duration), [2, 3]);
  retain(h, prepared);
  const sql = [], second = new Database(h.db.name, { readonly: true, verbose: query => sql.push(query) });
  const before = { changes: changes(h.db), files: files(h.root), db: hash(h.db.serialize()) }, probed = [];
  const readContext = db => ({ ...h.ctx, db, execFile: (binary, args, options, callback) => {
    assert.equal(binary, getFfprobePath(), 'read path only runs actual FFprobe, never an encoder');
    probed.push(args); return execFile(binary, args, options, callback);
  } });
  try {
    h.db.pragma('query_only = ON');
    for (const db of [h.db, second, h.db]) {
      const result = await inspect(readContext(db), h.expected(1));
      assert.deepEqual(result, { schema_version: 'redraw-unit-prepared-reference-inspection-v1', bindings: original.bindings,
        materials_hash: original.materials_hash, status: 'prepared', prepared_materials: prepared });
    }
    assert.equal(probed.length, 18, 'every derived output has fresh stream/frame/packet probes on every read');
    for (const ref of prepared.references) for (const flag of ['-show_streams', '-show_frames', '-show_packets']) {
      assert.equal(probed.filter(args => args.at(-1) === outputPath(h, ref) && args.includes(flag)).length, 3);
    }
    assert.equal(sql.some(query => /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(query)), false);
    assert.equal(changes(h.db), before.changes); assert.equal(changes(second), 0);
    assert.deepEqual(files(h.root), before.files); assert.equal(hash(h.db.serialize()), before.db);
    assert.deepEqual(await h.materials(1), original, 'original inspection continues to report logical needs_derivation');
    assert.doesNotMatch(JSON.stringify(await inspect(readContext(second), h.expected(1))), /local_path|directory|handle|https?:|executable|price|credits/);
  } finally { second.close(); h.db.pragma('query_only = OFF'); }
  h.db.exec('SAVEPOINT missing_current; DROP TRIGGER redraw_unit_reference_derivations_immutable_delete');
  try {
    h.db.prepare('DELETE FROM redraw_unit_reference_derivations WHERE id = ?').run(prepared.references[0].derivation_id);
    const missing = await inspect(h.ctx, h.expected(1));
    assert.equal(missing.status, 'needs_preparation');
    assert.deepEqual(missing.missing_requirement_ids, ['motion-shot-2']);
    assert.equal(Object.hasOwn(missing, 'prepared_materials'), false, 'one missing reference forbids the entire success DTO');
    h.db.prepare("UPDATE assets SET metadata = '{}' WHERE id = ?").run(prepared.references[1].asset_id);
    await assert.rejects(inspect(h.ctx, h.expected(1)), rejected, 'missing first reference cannot conceal a corrupt registered second reference');
  } finally { h.db.exec('ROLLBACK TO missing_current; RELEASE missing_current'); }
});

test('registered outputs reject missing bytes, wrong SHA and damaged authority or asset envelopes', async t => {
  const h = await fixture(t), prepared = await prepare(h), inspect = inspector(), ref = prepared.references[0];
  const file = outputPath(h, ref), bytes = fs.readFileSync(file);
  const cases = [
    ['missing output', () => fs.unlinkSync(file)],
    ['wrong SHA', () => { const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; fs.writeFileSync(file, changed); }],
    ['missing asset', () => h.db.prepare("UPDATE assets SET deleted_at = 'gone' WHERE id = ?").run(ref.asset_id)],
    ['asset metadata', () => h.db.prepare("UPDATE assets SET metadata = '{}' WHERE id = ?").run(ref.asset_id)],
    ['asset malformed JSON', () => h.db.prepare("UPDATE assets SET metadata = 'broken' WHERE id = ?").run(ref.asset_id)],
    ['asset duration is not parent duration', () => h.db.prepare('UPDATE assets SET duration = 12 WHERE id = ?').run(ref.asset_id)],
    ['asset path', () => h.db.prepare("UPDATE assets SET local_path = '../source/source.mp4' WHERE id = ?").run(ref.asset_id)],
    ['authority input', () => h.db.prepare("UPDATE redraw_unit_reference_derivations SET input_json = '{}' WHERE id = ?").run(ref.derivation_id)],
    ['authority null envelope', () => h.db.prepare("UPDATE redraw_unit_reference_derivations SET output_json = 'null' WHERE id = ?").run(ref.derivation_id)],
    ['authority extra envelope key', () => h.db.prepare("UPDATE redraw_unit_reference_derivations SET output_json = json_set(output_json, '$.untrusted', 1) WHERE id = ?").run(ref.derivation_id)],
    ['authority extra proof key', () => h.db.prepare("UPDATE redraw_unit_reference_derivations SET output_json = json_set(output_json, '$.proof.media.untrusted', 1) WHERE id = ?").run(ref.derivation_id)],
    ['authority size', () => h.db.prepare("UPDATE redraw_unit_reference_derivations SET output_json = json_set(output_json, '$.size', 1) WHERE id = ?").run(ref.derivation_id)],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    h.db.exec('SAVEPOINT corrupt_registered; DROP TRIGGER redraw_unit_reference_derivations_immutable_update');
    try {
      mutate(); const before = changes(h.db);
      await assert.rejects(inspect(h.ctx, h.expected(1)), rejected);
      assert.equal(changes(h.db), before, 'corrupt authority is rejected, never replaced or repaired');
      assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_unit_reference_derivations').get().n, 1);
    } finally { h.db.exec('ROLLBACK TO corrupt_registered; RELEASE corrupt_registered'); fs.writeFileSync(file, bytes); }
  });
});

test('actual output media is reprobed even when corrupt bytes have consistently resealed SHA and size', async t => {
  const h = await fixture(t), prepared = await prepare(h), inspect = inspector(), ref = prepared.references[0];
  const file = outputPath(h, ref), original = fs.readFileSync(file);
  const parent = path.join(h.root, h.db.prepare('SELECT local_path FROM assets WHERE id = ?').get(h.processed[0].imported.asset.id).local_path);
  for (const kind of ['parent timeline', 'wrong geometry', 'unreadable MP4']) await t.test(kind, async () => {
    h.db.exec('SAVEPOINT resealed_media; DROP TRIGGER redraw_unit_reference_derivations_immutable_update');
    try {
      if (kind === 'parent timeline') fs.copyFileSync(parent, file);
      if (kind === 'wrong geometry') execFileSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', parent,
        '-an', '-vf', 'scale=48:32', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { windowsHide: true, timeout: 30000 });
      if (kind === 'unreadable MP4') fs.writeFileSync(file, Buffer.from('not a media container'));
      const bytes = fs.readFileSync(file), sha256 = hash(bytes);
      h.db.prepare('UPDATE redraw_unit_reference_derivations SET output_sha256 = ?, output_json = json_set(output_json, \'$.sha256\', ?, \'$.size\', ?) WHERE id = ?')
        .run(sha256, sha256, bytes.length, ref.derivation_id);
      h.db.prepare('UPDATE assets SET file_size = ?, metadata = json_set(metadata, \'$.sha256\', ?) WHERE id = ?').run(bytes.length, sha256, ref.asset_id);
      let probes = 0;
      await assert.rejects(inspect({ ...h.ctx, execFile: (binary, args, options, callback) => {
        assert.equal(binary, getFfprobePath()); probes += 1; return execFile(binary, args, options, callback);
      } }, h.expected(1)), rejected);
      assert.ok(probes > 0, 'real media checks, not only stored strings, reject this resealed file');
    } finally { h.db.exec('ROLLBACK TO resealed_media; RELEASE resealed_media'); fs.writeFileSync(file, original); }
  });
});

test('prepared reads recheck owner, plan, queue and approval instead of treating drift as missing material', async t => {
  const h = await fixture(t), prepared = await prepare(h), inspect = inspector();
  const cases = [
    ['other owner', () => {}, () => inspect({ ...h.ctx, userId: 'other' }, h.expected(1))],
    ['inactive owner', () => h.db.prepare("UPDATE tenant_members SET status = 'disabled'").run()],
    ['plan hash', () => {}, () => inspect(h.ctx, { ...h.expected(1), plan_hash: 'f'.repeat(64) })],
    ['queue binding', () => {}, () => inspect(h.ctx, { ...h.expected(1), queue_id: h.expected(1).queue_id + 1 })],
    ['approval', () => h.db.prepare("UPDATE redraw_assets SET approval_status = 'pending' WHERE id = 205").run()],
  ];
  for (const [name, mutate, call = () => inspect(h.ctx, h.expected(1))] of cases) await t.test(name, async () => {
    h.db.exec('SAVEPOINT prepared_drift');
    try { mutate(); const before = changes(h.db); await assert.rejects(call(), rejected); assert.equal(changes(h.db), before); }
    finally { h.db.exec('ROLLBACK TO prepared_drift; RELEASE prepared_drift'); }
  });
  assert.equal(hash(fs.readFileSync(outputPath(h, prepared.references[0]))), prepared.references[0].sha256);
});

test('last real candidate cleanup rejects changed complete winner rows, asset rows, bytes and parent authority', async t => {
  const h = await fixture(t), prepared = await prepare(h), inspect = inspector(), ref = prepared.references[0];
  const file = outputPath(h, ref), bytes = fs.readFileSync(file);
  for (const kind of ['authority row', 'asset row', 'output bytes', 'owner', 'approval']) await t.test(kind, async () => {
    h.db.exec('SAVEPOINT final_prepared; DROP TRIGGER redraw_unit_reference_derivations_immutable_update');
    try {
      await afterCandidateClose(h, () => {
        if (kind === 'authority row') h.db.prepare("UPDATE redraw_unit_reference_derivations SET created_at = 'changed after probe' WHERE id = ?").run(ref.derivation_id);
        if (kind === 'asset row') h.db.prepare("UPDATE assets SET name = 'changed after probe' WHERE id = ?").run(ref.asset_id);
        if (kind === 'output bytes') { const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; fs.writeFileSync(file, changed); }
        if (kind === 'owner') h.db.prepare("UPDATE tenant_members SET status = 'disabled'").run();
        if (kind === 'approval') h.db.prepare("UPDATE redraw_assets SET approval_status = 'pending' WHERE id = 205").run();
      }, () => assert.rejects(inspect(h.ctx, h.expected(1)), rejected));
      assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_unit_reference_derivations').get().n, 1);
      assert.equal(fs.existsSync(file), true, 'inspection must not delete the registered winner');
    } finally { h.db.exec('ROLLBACK TO final_prepared; RELEASE final_prepared'); fs.writeFileSync(file, bytes); }
  });
  assert.deepEqual(fs.readdirSync(h.ctx.tempRoot), []);
});

test('internal synchronous consumption rejects async and thenable callbacks and checks current material around writes', async t => {
  const h = await fixture(t), prepared = await prepare(h), expected = h.expected(1);
  assert.equal(typeof service.consumePreparedUnitReferenceMaterials, 'function', 'internal prepared consumption must share the last synchronous check');
  const consume = (callback, mode = 'immediate') => service.consumePreparedUnitReferenceMaterials(h.ctx, expected, callback, mode);
  let called = false;
  await assert.rejects(consume(async () => { called = true; }), rejected);
  assert.equal(called, false, 'an async callback must be rejected before invoking it');
  const before = h.db.prepare('SELECT name FROM assets WHERE id = 101').get();
  await assert.rejects(consume(() => {
    h.db.prepare("UPDATE assets SET name = 'must roll back' WHERE id = 101").run();
    return { then() {} };
  }), rejected);
  assert.deepEqual(h.db.prepare('SELECT name FROM assets WHERE id = 101').get(), before);
  const ref = prepared.references[0], original = h.db.prepare('SELECT name FROM assets WHERE id = ?').get(ref.asset_id);
  await assert.rejects(consume(dto => {
    assert.equal(h.db.inTransaction, true); assert.deepEqual(Object.keys(dto).sort(), ['bindings','materials_hash','prepared_materials','schema_version','status']);
    h.db.prepare("UPDATE assets SET name = 'drift during consumption' WHERE id = ?").run(ref.asset_id);
  }), rejected);
  assert.deepEqual(h.db.prepare('SELECT name FROM assets WHERE id = ?').get(ref.asset_id), original);
  h.db.pragma('query_only = ON');
  try { assert.deepEqual(await consume(dto => dto, 'deferred'), await inspector()(h.ctx, expected)); }
  finally { h.db.pragma('query_only = OFF'); }
});
