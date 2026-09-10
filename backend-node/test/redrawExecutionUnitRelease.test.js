'use strict';

// Actual isolated SQLite, prepared references, dispatch, candidate media and review.
// Provider transports and human decisions are synthetic. Release is an input
// contract, not evidence of final media, language or dialogue alignment quality.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, makeCandidateMedia, attemptRow, runRow, hash } = require('./helpers/redrawExecutionUnitDispatchFixture');
const runs = require('../src/services/redrawExecutionRunService');
const reviews = require('../src/services/redrawExecutionUnitReviewService');
const { inspectUnitReferenceMaterials } = require('../src/services/redrawUnitReferenceService');
const { prepareUnitReferenceMaterials } = require('../src/services/redrawUnitReferenceDerivationService');
const { compileUnitProductionPack } = require('../src/services/redrawUnitProductionPackService');
const { buildEpisodeRelease, calculateReleaseHash, validateReleaseManifest,
  assertReleaseHash } = require('../src/services/redrawEpisodeReleaseService');

const SCHEMA = 'redraw-execution-unit-release-v1';
const TOP_KEYS = ['schema_version', 'project_id', 'work_id', 'version_id', 'locale', 'market',
  'run_id', 'run_revision', 'queue_id', 'plan_review_id', 'plan_hash', 'source_sha256',
  'blueprint_hash', 'localization_hash', 'duration_ms', 'audio_mode', 'units', 'subtitles',
  'composition_readiness', 'quality_summary', 'release_hash'];
const UNIT_KEYS = ['unit_id', 'ordinal', 'queue_unit_id', 'unit_hash', 'attempt_id', 'task_id',
  'output_asset_id', 'candidate_hash', 'candidate_sha256', 'candidate_bytes', 'review_hash',
  'production_pack_hash', 'prepared_materials_hash', 'output_contract_hash', 'timeline',
  'output_start_ms', 'output_end_ms', 'parent_shots', 'source_audio_present'];
const PARENT_KEYS = ['parent_shot_id', 'parent_contract_hash', 'parent_start_ms', 'parent_end_ms',
  'source_start_ms', 'source_end_ms', 'unit_start_ms', 'unit_end_ms'];
const response = value => new Response(JSON.stringify(value), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});
const exactKeys = (value, keys) => assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
const changes = h => h.db.prepare('SELECT total_changes() AS n').get().n;
const stableJson = value => Array.isArray(value) ? `[${value.map(stableJson).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);

function request(h) {
  return { schema_version: SCHEMA, version_id: h.versionId, run_id: h.run.id,
    expected_plan_hash: h.run.plan_hash, expected_run_revision: runRow(h).revision };
}

async function dispatchAndApprove(h, index, variant = 'valid') {
  const mediaRoot = fs.mkdtempSync(path.join(h.root, 'release-candidate-media-'));
  const bytes = await makeCandidateMedia({ ...h, root: mediaRoot }, variant,
    { color: index ? 'blue' : 'red', frequency: index ? 880 : 440 });
  let posts = 0, downloads = 0;
  const candidate = await runs.dispatchClaimedExecutionUnitTask(h.ctx, h.versionId, h.run.id, h.input, {
    fetchImpl: async (_url, init) => {
      posts += 1;
      assert.equal(h.db.inTransaction, false);
      assert.equal(init.method, 'POST');
      return response({ id: `synthetic-unit-release-${h.attemptId}`, status: 'succeeded',
        content: { video_url: `https://result.synthetic.invalid/release-${h.attemptId}.mp4` } });
    },
    download: {
      _dnsLookupForTest: async (hostname, options) => {
        assert.equal(hostname, 'result.synthetic.invalid');
        assert.equal(options.all, true);
        return [{ address: '8.8.8.8', family: 4 }];
      },
      fetchImpl: async (_url, init) => {
        downloads += 1;
        assert.equal(h.db.inTransaction, false);
        assert.equal(init.method, 'GET');
        assert.equal(init.headers, undefined);
        return new Response(bytes, { status: 200, headers: { 'Content-Type': 'video/mp4' } });
      },
    },
  });
  assert.equal(posts, 1); assert.equal(downloads, 1);
  assert.equal(candidate.status, 'waiting_review');
  assert.equal(attemptRow(h).output_sha256, hash(bytes));
  const publicCandidate = await reviews.getExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.unitId);
  const approved = await reviews.reviewExecutionUnitCandidate(h.ctx, h.versionId, h.run.id, h.unitId, {
    expected_revision: publicCandidate.run_revision,
    expected_candidate_hash: publicCandidate.candidate_hash,
    decision: 'approved',
    checks: Object.fromEntries(publicCandidate.required_checks.map(key => [key,
      { basis: 'human_watch_listen', result: 'passed' }])),
  });
  assert.equal(approved.status, 'approved');
  const attempt = attemptRow(h);
  const envelope = JSON.parse(attempt.quality_json);
  return { attempt, envelope, pack: structuredClone(h.pack), bytes,
    file: path.resolve(h.root, envelope.candidate.relative_path) };
}

async function bindNextUnit(h, index) {
  const expected = h.expected(index);
  const material = await inspectUnitReferenceMaterials(h.ctx, expected);
  await prepareUnitReferenceMaterials(h.ctx, { ...expected, expected_materials_hash: material.materials_hash });
  const ready = await runs.inspectExecutionRunReadiness(h.ctx, h.versionId, h.run.id, {});
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  assert.equal(ready.unit.id, expected.unit_id);
  const claim = await runs.claimNextUnit(h.ctx, h.versionId, h.run.id, {
    expected_revision: ready.revision, expected_plan_hash: ready.plan_hash, expected_quote_hash: ready.quote_hash,
  });
  h.attemptId = claim.attempt_id; h.unitId = expected.unit_id;
  const binding = { attempt_id: h.attemptId, expected_revision: runRow(h).revision,
    expected_plan_hash: ready.plan_hash, expected_quote_hash: ready.quote_hash };
  h.binding = await runs.bindClaimedExecutionUnitTask(h.ctx, h.versionId, h.run.id, binding);
  h.input = { ...binding, expected_revision: runRow(h).revision };
  h.pack = compileUnitProductionPack({
    owner: { tenantId: h.ctx.tenantId, userId: h.ctx.userId, workId: 1, versionId: h.versionId },
    expected, queueState: h.queueState, blueprint: h.blueprint, localization: h.localization,
  });
}

async function approvedRun(t, audioMode = 'native') {
  const h = await setup(t, 'paid', true, 'bound', { assemblyCase: true, audioMode });
  h.unitId = h.expected(0).unit_id;
  h.candidates = [await dispatchAndApprove(h, 0, audioMode === 'not_required' ? 'silent' : 'valid')];
  await bindNextUnit(h, 1);
  h.candidates.push(await dispatchAndApprove(h, 1, audioMode === 'not_required' ? 'silent' : 'valid'));
  assert.equal(runRow(h).status, 'completed');
  assert.deepEqual(h.candidates.map(item => item.attempt.status), ['approved', 'approved']);
  assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_candidate_reviews').get().n, 0,
    'the new path must not require or fabricate old shot reviews');
  assert.equal(h.db.prepare('SELECT count(*) n FROM video_generations').get().n, 0);
  return h;
}

function storageSnapshot(root) {
  const entries = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) { entries.push([path.relative(root, absolute), 'directory']); visit(absolute); }
      else entries.push([path.relative(root, absolute), fs.statSync(absolute).size, hash(fs.readFileSync(absolute))]);
    }
  }
  visit(root);
  return entries;
}

// Existing source/motion validators create and remove their own private temp
// snapshots outside storageRoot. No new persistent release output is permitted.
async function readRelease(h, input = request(h), ctx = h.ctx, onLastStreamEnd) {
  const beforeChanges = changes(h);
  const beforeDb = hash(h.db.serialize());
  const beforeFiles = storageSnapshot(h.root);
  const candidateFiles = new Set(h.candidates.map(item => item.file));
  const tracked = new Set();
  const originals = { openSync: fs.openSync, closeSync: fs.closeSync, createReadStream: fs.createReadStream };
  let streams = 0, endMutation = false, mutationChanges = 0, restoreMutation;
  fs.openSync = function open(file, ...args) {
    const fd = originals.openSync.call(this, file, ...args);
    if (candidateFiles.has(String(file))) tracked.add(fd);
    return fd;
  };
  fs.closeSync = function close(fd) {
    const result = originals.closeSync.call(this, fd);
    tracked.delete(fd);
    return result;
  };
  fs.createReadStream = function stream(file, options, ...args) {
    const value = originals.createReadStream.call(this, file, options, ...args);
    if (candidateFiles.has(String(file)) && Number.isInteger(options?.fd)
      && options.autoClose === false && options.start === 0) {
      streams += 1;
      if (String(file) === h.candidates.at(-1).file && onLastStreamEnd) value.once('end', () => {
        endMutation = true;
        const before = changes(h);
        restoreMutation = onLastStreamEnd();
        mutationChanges += changes(h) - before;
      });
    }
    return value;
  };
  try {
    const release = await buildEpisodeRelease({ ...ctx,
      assemblyRunner: () => { throw new Error('READ_ONLY_RELEASE_MUST_NOT_ASSEMBLE'); },
    }, input);
    assert.equal(streams, h.candidates.length, 'each actual protected candidate stream must be read once');
    return release;
  } finally {
    Object.assign(fs, originals);
    if (typeof restoreMutation === 'function') restoreMutation();
    assert.equal(tracked.size, 0, 'every candidate FD acquired by this read must be closed on all exits');
    assert.equal(changes(h), beforeChanges + mutationChanges, 'release must not change any business table');
    if (!onLastStreamEnd) assert.equal(hash(h.db.serialize()), beforeDb);
    assert.deepEqual(storageSnapshot(h.root), beforeFiles, 'release must not create, delete or alter stored files');
    if (onLastStreamEnd) assert.equal(endMutation, true, 'drift must occur after the last real candidate stream');
  }
}

function assertUnitManifest(h, release) {
  exactKeys(release, TOP_KEYS);
  assert.equal(release.schema_version, SCHEMA);
  const version = h.db.prepare('SELECT * FROM redraw_versions WHERE id=?').get(h.versionId);
  const plan = h.queueState.saved_review.plan;
  assert.equal(release.project_id, 1); assert.equal(release.work_id, 1);
  assert.equal(release.version_id, h.versionId);
  assert.equal(release.locale, version.locale); assert.equal(release.market, version.market);
  assert.equal(release.run_id, h.run.id); assert.equal(release.run_revision, runRow(h).revision);
  assert.equal(release.queue_id, h.queueState.queue.id);
  assert.equal(release.plan_review_id, h.queueState.saved_review.id);
  assert.equal(release.plan_hash, h.run.plan_hash);
  assert.equal(release.source_sha256, h.sourceFingerprint);
  assert.equal(release.blueprint_hash, plan.bindings.blueprint_hash);
  assert.equal(release.localization_hash, plan.bindings.localization_hash);
  assert.equal(release.duration_ms, 12000); assert.equal(release.units.length, 2);
  let outputStart = 0;
  for (const [index, unit] of release.units.entries()) {
    exactKeys(unit, UNIT_KEYS);
    const { attempt, envelope, pack, bytes } = h.candidates[index];
    const planUnit = h.queueState.queue.units[index];
    assert.equal(unit.unit_id, planUnit.id); assert.equal(unit.ordinal, index);
    assert.equal(unit.queue_unit_id, attempt.queue_unit_id); assert.equal(unit.unit_hash, attempt.unit_hash);
    assert.equal(unit.attempt_id, attempt.id); assert.equal(unit.task_id, attempt.task_id);
    assert.equal(unit.output_asset_id, attempt.output_asset_id);
    assert.equal(unit.candidate_hash, attempt.candidate_hash);
    assert.equal(unit.candidate_sha256, hash(bytes)); assert.equal(unit.candidate_bytes, bytes.length);
    assert.notEqual(unit.candidate_hash, unit.candidate_sha256, 'candidate identity is not an artifact byte digest');
    assert.equal(unit.review_hash, envelope.review.review_hash);
    assert.equal(unit.production_pack_hash, pack.production_pack_hash);
    assert.equal(unit.prepared_materials_hash, envelope.submission.prepared_materials_hash);
    assert.equal(unit.output_contract_hash, hash(stableJson(envelope.submission.output_contract)));
    assert.deepEqual(unit.timeline, pack.timeline);
    assert.equal(unit.output_start_ms, outputStart);
    outputStart += pack.timeline.retained_duration_ms;
    assert.equal(unit.output_end_ms, outputStart);
    assert.equal(unit.source_audio_present, envelope.candidate.audio_codec !== null);
    assert.deepEqual(unit.parent_shots, pack.parent_contexts.map(parent =>
      Object.fromEntries(PARENT_KEYS.map(key => [key, parent[key]]))));
    unit.parent_shots.forEach(parent => exactKeys(parent, PARENT_KEYS));
  }
  assert.equal(outputStart, release.duration_ms);
  exactKeys(release.quality_summary, ['decision', 'approved_unit_count', 'human_review_count',
    'final_media_review', 'dialogue_alignment']);
  assert.deepEqual(release.quality_summary, { decision: 'approved_inputs', approved_unit_count: 2,
    human_review_count: 2, final_media_review: 'pending', dialogue_alignment: 'not_verified' });
  validateReleaseManifest(release);
  assert.equal(assertReleaseHash(release), release.release_hash);
  const { release_hash: digest, ...unsigned } = release;
  assert.equal(digest, hash(stableJson(unsigned)));
  const serialized = JSON.stringify(release);
  assert.equal(serialized.includes(h.root), false);
  assert.doesNotMatch(serialized, /https?:|local_path|absolute_path|api_key|connection|prompt|source_text/);
}

function assertSubtitles(h, release) {
  exactKeys(release.subtitles, ['locale', 'direction', 'cues', 'srt', 'vtt', 'sha256', 'timing_basis']);
  assert.equal(release.subtitles.locale, release.locale);
  assert.equal(release.subtitles.direction, 'ltr');
  assert.equal(release.subtitles.timing_basis, 'execution_plan_not_verified_audio_alignment');
  const expected = [];
  let offset = 0;
  for (const { pack } of h.candidates) {
    for (const dialogue of pack.dialogues) expected.push({ segment_id: dialogue.id,
      start_ms: offset + dialogue.unit_start_ms, end_ms: offset + dialogue.unit_end_ms,
      text: dialogue.target_text });
    offset += pack.timeline.retained_duration_ms;
  }
  assert.deepEqual(release.subtitles.cues.map(({ lines: _lines, ...cue }) => cue), expected);
  assert.equal(new Set(expected.map(cue => cue.segment_id)).size, expected.length);
  const { sha256: digest, timing_basis: _basis, ...subtitleBytes } = release.subtitles;
  assert.equal(digest, hash(stableJson(subtitleBytes)));
  if (expected.length) {
    assert.equal(expected.length, 1);
    assert.deepEqual([expected[0].start_ms, expected[0].end_ms], [8000, 11000]);
    assert.equal(expected[0].text, 'Maya, bring the blue folder. Do not leave anything behind.');
    assert.equal(release.subtitles.srt,
      '1\n00:00:08,000 --> 00:00:11,000\nMaya, bring the blue folder. Do not leave\nanything behind.\n');
    assert.equal(release.subtitles.vtt,
      'WEBVTT\n\n1\n00:00:08.000 --> 00:00:11.000\nMaya, bring the blue folder. Do not leave\nanything behind.\n');
    assert.doesNotMatch(release.subtitles.srt, /源对白/);
  } else {
    assert.equal(release.subtitles.srt, ''); assert.equal(release.subtitles.vtt, 'WEBVTT\n\n');
  }
}

test('approved unit release is stable, read-only and uses retained target dialogue instead of old shot pointers', async t => {
  const h = await approvedRun(t);
  const release = await readRelease(h);
  assertUnitManifest(h, release); assertSubtitles(h, release);
  assert.deepEqual(release.units.map(unit => unit.timeline.retained_duration_ms), [8000, 4000]);
  assert.deepEqual(release.units.map(unit => unit.timeline.padding_ms), [2000, 1000]);
  assert.equal(release.audio_mode, 'native');
  assert.deepEqual(release.composition_readiness, { status: 'ready',
    audio_requirement: 'native_candidate_tracks', reason_codes: [] });
  assert.deepEqual(await readRelease(h), release);

  await t.test('strict request rejects client media, schema fallback and invalid CAS types before any reads', async () => {
    const valid = request(h);
    const invalid = [
      { ...valid, units: [] }, { ...valid, candidate_path: h.candidates[0].file },
      { ...valid, audio_mode: 'replace' }, { ...valid, subtitles: [] }, { ...valid, api_key: 'synthetic-only' },
      { ...valid, assembly_manifest: {} }, { ...valid, schema_version: 'redraw-episode-release-v1' },
      { ...valid, version_id: String(valid.version_id) }, { ...valid, run_id: 0 },
      { ...valid, expected_plan_hash: 'not-a-sha' }, { ...valid, expected_run_revision: -1 },
      { ...valid, expected_run_revision: String(valid.expected_run_revision) },
      Object.assign(Object.create({ inherited: true }), valid), { ...valid, [Symbol('untrusted')]: true },
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'schema_version')),
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'run_id')),
    ];
    for (const input of invalid) await assert.rejects(readRelease(h, input),
      { code: 'REDRAW_EPISODE_RELEASE_INPUT_INVALID' });
  });

  await t.test('foreign owner and stale expected run/plan cannot use approved labels', async () => {
    await assert.rejects(readRelease(h, request(h), { ...h.ctx, userId: 'different-user' }),
      { code: 'REDRAW_EPISODE_RELEASE_VERSION_NOT_FOUND' });
    await assert.rejects(readRelease(h, request(h), { ...h.ctx, tenantId: 'different-tenant' }),
      { code: 'REDRAW_EPISODE_RELEASE_VERSION_NOT_FOUND' });
    for (const input of [{ ...request(h), expected_run_revision: runRow(h).revision - 1 },
      { ...request(h), expected_plan_hash: hash('other-plan') }, { ...request(h), run_id: h.run.id + 1000 }]) {
      await assert.rejects(readRelease(h, input), error =>
        ['REDRAW_EPISODE_RELEASE_INPUT_DRIFT', 'EXECUTION_RUN_NOT_FOUND'].includes(error.code));
    }
  });

  await t.test('manifest validator rejects recomputed extra fields, duplicated units and dishonest readiness', async () => {
    for (const mutate of [value => { value.units[0].local_path = 'forbidden.mp4'; },
      value => { value.units[1] = structuredClone(value.units[0]); },
      value => { value.quality_summary.final_media_review = 'approved'; },
      value => { value.units[1].output_start_ms += 1; },
      value => { value.subtitles.cues[0].end_ms = value.duration_ms + 1; }]) {
      const changed = structuredClone(release); mutate(changed);
      changed.release_hash = calculateReleaseHash(changed);
      assert.throws(() => assertReleaseHash(changed), { code: 'REDRAW_EPISODE_RELEASE_MANIFEST_INVALID' });
    }
    const changed = structuredClone(release); changed.units[0].candidate_sha256 = hash('other-byte-content');
    assert.throws(() => assertReleaseHash(changed), { code: 'REDRAW_EPISODE_RELEASE_HASH_MISMATCH' });
  });

  await t.test('all awaits are followed by current owner/source/approval/locale/market/billing/run checks', async () => {
    const first = h.candidates[0].attempt;
    const mutations = [
      ['run revision', () => h.db.prepare('UPDATE redraw_execution_runs SET revision=revision+1 WHERE id=?').run(h.run.id)],
      ['owner', () => h.db.prepare("UPDATE redraw_versions SET user_id='other-user' WHERE id=?").run(h.versionId)],
      ['source', () => h.db.prepare('UPDATE redraw_works SET source_fingerprint=? WHERE id=1').run(hash('changed-source'))],
      ['approval', () => h.db.prepare("UPDATE redraw_execution_unit_attempts SET approved_by='different-reviewer' WHERE id=?").run(first.id)],
      ['locale', () => h.db.prepare("UPDATE redraw_versions SET locale='ar-SA' WHERE id=?").run(h.versionId)],
      ['market', () => h.db.prepare("UPDATE redraw_versions SET market='CA' WHERE id=?").run(h.versionId)],
      ['billing', () => h.db.prepare("UPDATE tenant_usage_reservations SET status='held' WHERE id=?").run(first.reservation_id)],
    ];
    for (const [label, mutate] of mutations) {
      assert.equal(h.db.inTransaction, false, `${label}: own the isolated mutation transaction`);
      const beforeMutation = hash(h.db.serialize());
      h.db.exec('BEGIN');
      let restored = false;
      const restore = () => {
        if (restored) return;
        h.db.exec('ROLLBACK');
        assert.equal(hash(h.db.serialize()), beforeMutation, `${label}: restore the isolated database exactly`);
        restored = true;
      };
      try {
        await assert.rejects(readRelease(h, request(h), h.ctx, () => {
          mutate();
          return restore;
        }), error => {
          assert.equal(typeof error.code, 'string', `${label}: a coded business conflict is required`);
          assert.match(error.code, /^(?:REDRAW_(?:EPISODE_RELEASE_(?:INPUT_DRIFT|VERSION_NOT_FOUND)|VERSION_NOT_FOUND|UNIT_REFERENCE_MATERIALS_STALE)|EXECUTION_UNIT_REVIEW_CONFLICT|EXECUTION_RUN_CONFLICT)$/,
            `${label}: ${error.message}\n${error.stack}`);
          return true;
        }, label);
      } finally { restore(); }
    }
    assert.deepEqual(await readRelease(h), release, 'rollback restores the original approved input without rebuilding media');
  });

  await t.test('candidate byte drift rejects without deleting any approved candidate', async () => {
    const item = h.candidates[0];
    const changed = Buffer.from(item.bytes); changed[Math.floor(changed.length / 2)] ^= 1;
    fs.writeFileSync(item.file, changed);
    try {
      await assert.rejects(readRelease(h), error =>
        ['REDRAW_UNIT_RESULT_INVALID', 'REDRAW_EPISODE_RELEASE_INPUT_DRIFT', 'EXECUTION_UNIT_REVIEW_CONFLICT'].includes(error.code));
      assert.equal(fs.existsSync(item.file), true);
      assert.equal(hash(fs.readFileSync(item.file)), hash(changed));
    } finally { fs.writeFileSync(item.file, item.bytes); }
  });

  await t.test('last asynchronous stream cannot hide a same-length mutation of an earlier approved candidate', async () => {
    const item = h.candidates[0];
    const changed = Buffer.from(item.bytes); changed[Math.floor(changed.length / 2)] ^= 1;
    await assert.rejects(readRelease(h, request(h), h.ctx, () => {
      fs.writeFileSync(item.file, changed);
      assert.equal(fs.statSync(item.file).size, item.bytes.length);
      return () => fs.writeFileSync(item.file, item.bytes);
    }), error => ['REDRAW_UNIT_RESULT_INVALID', 'REDRAW_EPISODE_RELEASE_INPUT_DRIFT',
      'EXECUTION_UNIT_REVIEW_CONFLICT'].includes(error.code));
    assert.equal(hash(fs.readFileSync(item.file)), hash(item.bytes));
  });
});

for (const mode of ['not_required', 'replace']) {
  test(`approved unit release keeps ${mode} audio semantics and leaves final media review pending`, async t => {
    const h = await approvedRun(t, mode);
    const release = await readRelease(h);
    assertUnitManifest(h, release); assertSubtitles(h, release);
    assert.equal(release.audio_mode, mode);
    assert.deepEqual(release.composition_readiness, mode === 'replace'
      ? { status: 'blocked', audio_requirement: 'approved_dub_required', reason_codes: ['APPROVED_DUB_REQUIRED'] }
      : { status: 'ready', audio_requirement: 'not_required', reason_codes: [] });
    assert.deepEqual(release.units.map(unit => unit.source_audio_present), mode === 'replace' ? [true, true] : [false, false]);
    assert.equal(h.db.prepare("SELECT count(*) n FROM assets WHERE category='redraw_dialogue'").get().n, 0);
    assert.equal(h.db.prepare('SELECT count(*) n FROM redraw_exports').get().n, 0);
    if (mode === 'replace') {
      const dishonest = structuredClone(release);
      dishonest.composition_readiness = { status: 'ready', audio_requirement: 'approved_dub_required', reason_codes: [] };
      dishonest.release_hash = calculateReleaseHash(dishonest);
      assert.throws(() => assertReleaseHash(dishonest), { code: 'REDRAW_EPISODE_RELEASE_MANIFEST_INVALID' });
    }
  });
}

test('old v1 exact-key shape and canonical hash remain independent of the execution-unit schema', () => {
  const legacy = { schema_version: 'redraw-episode-release-v1', project_id: 1, work_id: 2,
    version_id: 3, locale: 'en-US', market: 'US', shots: [{ shot_id: 4, shot_index: 1,
      start_ms: 0, end_ms: 1000, candidate_review_id: 5, candidate_sha256: hash('candidate'),
      audio_sha256: hash('audio'), subtitle_sha256: hash('subtitles'), dependency_hash: hash('dependencies') }],
    quality_summary: { decision: 'approved', approved_shot_count: 1, automatic_review_count: 0, human_review_count: 1 } };
  const expected = hash(stableJson(legacy));
  legacy.release_hash = expected;
  assert.equal(calculateReleaseHash(legacy), expected);
  assert.equal(assertReleaseHash(legacy), expected);
  const polluted = { ...legacy, run_id: 1 };
  polluted.release_hash = calculateReleaseHash(polluted);
  assert.throws(() => assertReleaseHash(polluted), { code: 'REDRAW_EPISODE_RELEASE_MANIFEST_INVALID' });
});
