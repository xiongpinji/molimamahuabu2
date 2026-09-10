const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const SOURCE_SHA = '05c9849b35665c37e097b569819f401b2b7a85b059ff0a83f828ffb00605e075';
const AUDIO_SHA = '0ae9f13946582c96d26393277429c75fa20d84a12c20de6167f85b431d96ff07';
const MAX_WORKER_BYTES = 64 * 1024 * 1024;
const EXPECTED_WINDOWS = [
  { id: 'aw000001', analysis: [0, 1530000], commit: [0, 1500000] },
  { id: 'aw000002', analysis: [1470000, 3030000], commit: [1500000, 3000000] },
  { id: 'aw000003', analysis: [2970000, 3600000], commit: [3000000, 3600000] },
];
const RELATIVE = { startMs: 120125, endMs: 121125 };
const log = { info() {}, warn() {}, error() {} };
// Select exactly one case per fresh isolated launcher root; an omitted case is only the original test.
const SELECTED_CASE = process.env.G2_SOURCE_AUDIO_CASE || 'success';
const NEGATIVE_CASES = {
  'window-2-failed': { calls: 2, code: 'SOURCE_AUDIO_ANALYSIS_FAILED' },
  'window-2-unknown': { calls: 2, code: 'SOURCE_AUDIO_RESULT_UNKNOWN' },
  'window-2-audio-hash-mismatch': { calls: 2, code: 'SOURCE_AUDIO_EVIDENCE_INVALID' },
  'window-2-client-evidence-invalid': { calls: 2, code: 'SOURCE_AUDIO_EVIDENCE_INVALID' },
  'aggregate-4097-segments': { calls: 3, code: 'SOURCE_AUDIO_EVIDENCE_INVALID' },
  'work-source-fingerprint-drift': { calls: 3, code: 'SOURCE_AUDIO_SOURCE_FINGERPRINT_INVALID' },
  'source-asset-hash-drift': { calls: 3, code: 'SOURCE_AUDIO_SOURCE_ASSET_HASH_INVALID' },
};

function hashFile(file, start = 0, length = fs.statSync(file).size - start) {
  const fd = fs.openSync(file, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (let offset = 0; offset < length;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, length - offset), start + offset);
      assert.ok(count > 0, 'hash input must not end early');
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function preserveRawReceipt(evidence) {
  return {
    ...evidence,
    rawSourceEvidence: {
      audio_sha256: evidence.audioSha256,
      transcript_sha256: evidence.transcriptSha256,
      source_language: evidence.sourceLanguage,
      language_probability: evidence.languageProbability,
      segments: evidence.segments.map((segment) => ({
        start: segment.startMs / 1000,
        end: segment.endMs / 1000,
        text: segment.text,
        speaker_cluster_id: segment.speakerClusterId,
      })),
    },
  };
}

function inspectWav(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const read = (offset, length) => {
    const buffer = Buffer.alloc(length);
    assert.equal(fs.readSync(fd, buffer, 0, length, offset), length);
    return buffer;
  };
  try {
    const header = read(0, 12);
    assert.equal(header.toString('ascii', 0, 4), 'RIFF');
    assert.equal(header.toString('ascii', 8, 12), 'WAVE');
    assert.equal(header.readUInt32LE(4) + 8, size);
    let format;
    let data;
    for (let offset = 12; offset + 8 <= size;) {
      const chunk = read(offset, 8);
      const kind = chunk.toString('ascii', 0, 4);
      const length = chunk.readUInt32LE(4);
      assert.ok(offset + 8 + length <= size, 'RIFF chunk must be in bounds');
      if (kind === 'fmt ') {
        assert.equal(format, undefined);
        assert.ok(length >= 16);
        const fmt = read(offset + 8, 16);
        format = [0, 2, 4, 8, 12, 14].map((at, index) => (
          index === 2 || index === 3 ? fmt.readUInt32LE(at) : fmt.readUInt16LE(at)
        ));
      }
      if (kind === 'data') {
        assert.equal(data, undefined);
        data = { offset: offset + 8, length };
      }
      offset += 8 + length + (length % 2);
    }
    assert.deepEqual(format, [1, 1, 16000, 32000, 2, 16]);
    assert.ok(data && data.length > 0 && data.length % 2 === 0);
    return { size, sha256: hashFile(file), ...data, durationMs: data.length / 32 };
  } finally {
    fs.closeSync(fd);
  }
}

function inside(root, file) {
  const relative = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(file));
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
}

function applyNegativeFixture(evidence, call, callNumber, db, sourceAssetId) {
  if (SELECTED_CASE === 'aggregate-4097-segments') {
    // Each individual receipt stays below 4096; only the final aggregate exceeds the cap.
    const count = [1366, 1366, 1365][callNumber - 1];
    evidence.segments = Array.from({ length: count }, (_, index) => ({
      startMs: RELATIVE.startMs + index * 10,
      endMs: RELATIVE.startMs + index * 10 + 5,
      text: `w${callNumber}s${index}`,
      speakerClusterId: 'speaker-cluster-1',
    }));
    evidence.transcriptSha256 = hashJson(evidence.segments.map((segment) => ({
      end: segment.endMs / 1000, start: segment.startMs / 1000, text: segment.text,
    })));
    call.transcript_sha256 = evidence.transcriptSha256;
    call.injected_case = SELECTED_CASE;
    call.returned_segment_count = count;
  }
  if (callNumber === 2) {
    const failureCode = SELECTED_CASE === 'window-2-failed' ? 'G2_EXPLICIT_WORKER_FAILURE'
      : SELECTED_CASE === 'window-2-unknown' ? 'REDRAW_LOCALE_VERIFIER_TIMEOUT'
        : SELECTED_CASE === 'window-2-client-evidence-invalid' ? 'SOURCE_AUDIO_EVIDENCE_INVALID' : null;
    if (failureCode) {
      call.injected_case = SELECTED_CASE;
      call.outcome = failureCode;
      throw Object.assign(new Error(failureCode), { code: failureCode });
    }
    if (SELECTED_CASE === 'window-2-audio-hash-mismatch') {
      evidence.audioSha256 = `${evidence.audioSha256[0] === '0' ? '1' : '0'}${evidence.audioSha256.slice(1)}`;
      call.injected_case = SELECTED_CASE;
      call.outcome = 'returned_mismatched_audio_sha256';
    }
  }
  if (callNumber === 3 && SELECTED_CASE === 'work-source-fingerprint-drift') {
    db.prepare('UPDATE redraw_works SET source_fingerprint = ? WHERE id = 1').run('c'.repeat(64));
    call.injected_case = SELECTED_CASE;
  }
  if (callNumber === 3 && SELECTED_CASE === 'source-asset-hash-drift') {
    const asset = db.prepare('SELECT metadata FROM assets WHERE id = ?').get(sourceAssetId);
    const metadata = { ...JSON.parse(asset.metadata), sha256: 'c'.repeat(64) };
    db.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), sourceAssetId);
    call.injected_case = SELECTED_CASE;
  }
  return evidence;
}

const testName = 'local-only one-hour source produces one v2 evidence asset from three bounded real PCM windows';
test(SELECTED_CASE === 'success' ? testName : `local-only long-source negative: ${SELECTED_CASE}`, {
  // An explicitly selected negative without its isolation root must fail, never silently skip.
  skip: process.env.G2_SOURCE_AUDIO_RUN_ROOT || SELECTED_CASE !== 'success'
    ? false : 'requires isolated long-audio media launcher; not exercised in default suite',
}, async (t) => {
  assert.ok(SELECTED_CASE === 'success' || Object.hasOwn(NEGATIVE_CASES, SELECTED_CASE), 'unknown G2 case');
  const root = process.env.G2_SOURCE_AUDIO_RUN_ROOT;
  assert.ok(root && path.isAbsolute(root));
  assert.equal(path.resolve(root), path.resolve(process.cwd()));
  assert.match(path.basename(root), /^g2-source-audio-windows-[0-9a-f]{32}$/);
  assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
  const Database = require('better-sqlite3');
  const assetService = require('../src/services/assetService');
  const { runMigrationsAndEnsure } = require('../src/db/migrate');
  const { analyzeSourceAudio } = require('../src/services/redrawSourceAudioEvidenceService');
  const sourcePath = path.join(root, 'storage', 'uploads', 'one-hour-synthetic.mp4');
  const fullWavPath = path.join(root, 'inputs', 'one-hour-16k-mono.wav');
  inside(root, sourcePath);
  inside(root, fullWavPath);
  assert.equal(fs.statSync(sourcePath).size, 11186014);
  assert.equal(hashFile(sourcePath), SOURCE_SHA);
  const fullWav = inspectWav(fullWavPath);
  assert.equal(fullWav.sha256, AUDIO_SHA);
  assert.equal(fullWav.size, 115200078);
  assert.equal(fullWav.durationMs, 3600000);
  assert.ok(fullWav.size > MAX_WORKER_BYTES);

  const db = new Database(path.join(root, 'source-audio-test.sqlite'), {
    nativeBinding: path.resolve(__dirname, '../node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
  });
  const observations = [];
  t.after(() => {
    try {
      fs.writeFileSync(path.join(root, 'worker-observations.json'), JSON.stringify({
        fixture_kind: 'synthetic transport response; not ASR or seam quality acceptance',
        selected_case: SELECTED_CASE,
        full_wav: fullWav,
        worker_calls: observations,
      }, null, 2), { flag: 'wx' });
      assert.equal(hashFile(sourcePath), SOURCE_SHA);
      assert.equal(hashFile(fullWavPath), AUDIO_SHA);
    } finally {
      db.close();
    }
  });
  runMigrationsAndEnsure(db);
  // Observe real INSERTs, including any subsequently deleted intermediate assets.
  db.exec(`
    CREATE TABLE g2_evidence_insert_observations (asset_id INTEGER NOT NULL);
    CREATE TRIGGER g2_observe_evidence_insert AFTER INSERT ON assets
    WHEN NEW.category = 'redraw_source_audio_evidence'
    BEGIN INSERT INTO g2_evidence_insert_observations (asset_id) VALUES (NEW.id); END;
  `);
  const source = assetService.create(db, log, {
    name: 'one-hour-synthetic.mp4', type: 'video', category: 'redraw_source',
    local_path: 'uploads/one-hour-synthetic.mp4', file_size: 11186014, mime_type: 'video/mp4',
    metadata: { tenant_id: 'g2-tenant', user_id: 'g2-user', sha256: SOURCE_SHA },
  });
  const now = '2026-09-07T00:00:00.000Z';
  db.prepare(`INSERT INTO redraw_projects
    (id, tenant_id, user_id, title, status, created_at, updated_at)
    VALUES (1, 'g2-tenant', 'g2-user', 'G2 synthetic source', 'draft', ?, ?)
  `).run(now, now);
  db.prepare(`INSERT INTO redraw_works
    (id, project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, status, current_step, created_at, updated_at)
    VALUES (1, 1, 'g2-tenant', 'g2-user', 'G2 synthetic source', ?, ?, 3600000, 'draft', 1, ?, ?)
  `).run(source.id, SOURCE_SHA, now, now);

  const ctx = {
    db, log, storageRoot: path.join(root, 'storage'), privateAudioRoot: path.join(root, 'private'),
    ffmpegPath: process.env.FFMPEG_PATH,
    workerClient: {
      async analyzeSourceAudio(input) {
        inside(ctx.privateAudioRoot, input.audioPath);
        const actual = inspectWav(input.audioPath);
        const call = { request_id: input.requestId, actual, outcome: 'checking' };
        observations.push(call);
        try {
          assert.equal(actual.sha256, input.audioSha256);
          assert.equal(db.prepare('SELECT COUNT(*) AS n FROM g2_evidence_insert_observations').get().n, 0);
          // Preserve the original Worker >64 MiB rejection, based on real file bytes.
          if (actual.size > MAX_WORKER_BYTES) {
            call.outcome = 'AUDIO_PATH_NOT_ALLOWED';
            throw Object.assign(new Error('AUDIO_PATH_NOT_ALLOWED'), { code: 'AUDIO_PATH_NOT_ALLOWED' });
          }
          assert.ok(actual.size < MAX_WORKER_BYTES, 'each accepted window stays strictly below the limit');
          assert.equal(input.preserveSourceEvidence, true, 'long-window requests retain the validated raw JSON receipt locally');
          const expected = EXPECTED_WINDOWS[observations.length - 1];
          assert.ok(expected, 'no fourth Worker call or retry');
          assert.equal(actual.durationMs, expected.analysis[1] - expected.analysis[0]);
          const pcmSha = hashFile(input.audioPath, actual.offset, actual.length);
          assert.equal(pcmSha, hashFile(fullWavPath,
            fullWav.offset + expected.analysis[0] * 32, actual.length));
          const text = `synthetic-window-${observations.length}`;
          // Decimal seconds match the Worker's canonical relative-seconds JSON representation.
          const transcriptSha256 = hashJson([{ end: 121.125, start: 120.125, text }]);
          Object.assign(call, { outcome: 'completed', pcm_sha256: pcmSha, transcript_sha256: transcriptSha256 });
          const evidence = preserveRawReceipt(applyNegativeFixture({
            requestId: input.requestId, audioSha256: actual.sha256, transcriptSha256,
            sourceLanguage: 'en', languageProbability: 0.9,
            segments: [{ ...RELATIVE, text, speakerClusterId: 'speaker-cluster-1' }],
          }, call, observations.length, db, source.id));
          call.raw_source_evidence = structuredClone(evidence.rawSourceEvidence);
          return evidence;
        } catch (error) {
          if (call.outcome === 'checking') {
            call.outcome = 'fixture_validation_failed';
            call.validation_error = String(error.message);
          }
          throw error;
        }
      },
    },
  };
  assert.ok(path.isAbsolute(ctx.ffmpegPath));
  const negativeCase = NEGATIVE_CASES[SELECTED_CASE];
  if (negativeCase) {
    await assert.rejects(() => analyzeSourceAudio(ctx, {
      workId: 1, sourceAssetId: source.id, tenantId: 'g2-tenant', userId: 'g2-user',
    }), (error) => {
      assert.equal(error.code, negativeCase.code);
      assert.equal(error.message, negativeCase.code);
      return true;
    });
    assert.equal(observations.length, negativeCase.calls, 'stop at the affected window; no later call or retry');
    assert.equal(new Set(observations.map((call) => call.request_id)).size, negativeCase.calls);
    assert.equal(observations.at(-1).injected_case, SELECTED_CASE, 'reach the intended injection, not the old full-WAV rejection');
    if (SELECTED_CASE === 'aggregate-4097-segments') {
      assert.deepEqual(observations.map((call) => call.returned_segment_count), [1366, 1366, 1365]);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assets WHERE category = 'redraw_source_audio_evidence'").get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM g2_evidence_insert_observations').get().n, 0);
    const outputRoot = path.join(ctx.storageRoot, 'redraw-source-audio-evidence');
    if (fs.existsSync(outputRoot)) assert.deepEqual(fs.readdirSync(outputRoot), []);
    assert.deepEqual(fs.readdirSync(ctx.privateAudioRoot), []);
    return;
  }
  let result;
  await assert.doesNotReject(async () => {
    result = await analyzeSourceAudio(ctx, {
      workId: 1, sourceAssetId: source.id, tenantId: 'g2-tenant', userId: 'g2-user',
    });
  }, 'the product must successfully analyze the long source instead of submitting an oversized full WAV');

  assert.equal(result.schema_version, 'redraw-source-audio-evidence-v2');
  assert.equal(result.source_video_sha256, SOURCE_SHA);
  assert.equal(result.audio_sha256, AUDIO_SHA);
  assert.notEqual(result.source_video_sha256, result.audio_sha256);
  assert.equal(result.audio_duration_ms, 3600000);
  assert.deepEqual(result.audio_format, { codec: 'pcm_s16le', sample_rate_hz: 16000, channels: 1, bit_depth: 16 });
  assert.equal(result.dialogue_mode, 'spoken');
  assert.equal(result.source_language, 'en');
  assert.equal(result.language_probability, 0.9);
  assert.deepEqual(result.speaker_cluster_policy, { scope: 'window', cross_window_identity: 'unknown' });
  assert.equal(observations.length, 3);
  assert.equal(new Set(observations.map((call) => call.request_id)).size, 3);
  assert.equal(result.windows.length, 3);
  assert.equal(result.coverage.expected_duration_ms, 3600000);
  assert.equal(result.coverage.gap_ms, 0);
  assert.equal(result.coverage.full_coverage, true);
  assert.deepEqual(result.coverage.committed_ranges, EXPECTED_WINDOWS.map((window) => ({
    window_id: window.id, start_ms: window.commit[0], end_ms: window.commit[1],
  })));
  assert.equal(result.window_policy.worker_max_audio_bytes, MAX_WORKER_BYTES);
  assert.equal(result.window_policy.target_commit_ms, 1500000);
  assert.equal(result.window_policy.overlap_ms, 30000);
  assert.equal(result.window_policy.seam_rule, 'full_utterance_single_owner_or_reject');
  assert.deepEqual(result.coverage.seam_checks, [
    { seam_ms: 1500000, left_window_id: 'aw000001', right_window_id: 'aw000002', status: 'passed' },
    { seam_ms: 3000000, left_window_id: 'aw000002', right_window_id: 'aw000003', status: 'passed' },
  ]);
  assert.equal(result.segments.length, 3);

  for (const [index, expected] of EXPECTED_WINDOWS.entries()) {
    const window = result.windows[index];
    const segment = result.segments[index];
    const call = observations[index];
    const absolute = { start_ms: expected.analysis[0] + RELATIVE.startMs, end_ms: expected.analysis[0] + RELATIVE.endMs };
    assert.equal(window.window_id, expected.id);
    assert.equal(window.index, index);
    assert.deepEqual(window.analysis_range_ms, { start_ms: expected.analysis[0], end_ms: expected.analysis[1] });
    assert.deepEqual(window.commit_range_ms, { start_ms: expected.commit[0], end_ms: expected.commit[1] });
    assert.equal(window.request_id, call.request_id);
    assert.equal(window.worker_status, 'completed');
    assert.equal(window.segment_count, 1);
    assert.equal(window.audio_sha256, call.actual.sha256);
    assert.equal(window.transcript_sha256, call.transcript_sha256);
    assert.deepEqual(window.raw_source_evidence, call.raw_source_evidence);
    assert.notEqual(window.audio_sha256, result.audio_sha256);
    assert.notEqual(window.audio_sha256, result.source_video_sha256);
    assert.equal(segment.start_ms, absolute.start_ms);
    assert.equal(segment.end_ms, absolute.end_ms);
    assert.equal(segment.source_text, `synthetic-window-${index + 1}`);
    assert.equal(segment.speaker_cluster_id, `${expected.id}-speaker-cluster-1`);
    assert.equal(segment.speaker_cluster_scope, 'window');
    assert.equal(segment.speaker_link_status, 'unknown');
    assert.equal(segment.commit_window_id, expected.id);
    assert.equal(segment.selected_source_binding_index, 0);
    assert.ok(typeof segment.id === 'string' && segment.id.length > 0);
    assert.ok(typeof segment.evidence_ref === 'string' && segment.evidence_ref.length > 0);
    assert.equal(segment.source_bindings.length, 1);
    const binding = segment.source_bindings[0];
    assert.equal(binding.role, 'selected_source');
    assert.equal(binding.window_id, expected.id);
    assert.equal(binding.worker_request_id, call.request_id);
    assert.equal(binding.worker_segment_index, 0);
    assert.deepEqual(binding.worker_relative_range_ms, { start_ms: RELATIVE.startMs, end_ms: RELATIVE.endMs });
    assert.deepEqual(binding.absolute_range_ms, absolute);
    assert.equal(binding.window_audio_sha256, window.audio_sha256);
    assert.equal(binding.window_transcript_sha256, window.transcript_sha256);
    assert.equal(binding.raw_worker_speaker_cluster_id, 'speaker-cluster-1');
    assert.equal(binding.worker_source_text, segment.source_text);
  }
  assert.equal(new Set(result.segments.map((segment) => segment.speaker_cluster_id)).size, 3);
  assert.equal(result.transcript_sha256, hashJson(result.segments.map((segment) => ({
    end_ms: segment.end_ms, source_text: segment.source_text, start_ms: segment.start_ms,
  }))));
  for (const window of result.windows) assert.notEqual(result.transcript_sha256, window.transcript_sha256);
  const assets = db.prepare("SELECT * FROM assets WHERE category = 'redraw_source_audio_evidence'").all();
  assert.equal(assets.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM g2_evidence_insert_observations').get().n, 1);
  assert.equal(result.result_asset_id, assets[0].id);
  const evidencePath = path.join(ctx.storageRoot, assets[0].local_path);
  inside(ctx.storageRoot, evidencePath);
  const persisted = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  assert.equal(persisted.schema_version, result.schema_version);
  assert.deepEqual(persisted.windows, result.windows);
  assert.deepEqual(persisted.segments, result.segments);
  assert.equal(hashFile(evidencePath), result.evidence_sha256);
  assert.equal(JSON.parse(assets[0].metadata).schema_version, result.schema_version);
  assert.deepEqual(fs.readdirSync(ctx.privateAudioRoot), []);
});
