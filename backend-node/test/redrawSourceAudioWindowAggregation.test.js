const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const service = require('../src/services/redrawSourceAudioEvidenceService');

const WINDOW_PLAN = [
  { window_id: 'aw000001', index: 0, analysis_range_ms: { start_ms: 0, end_ms: 1530000 }, commit_range_ms: { start_ms: 0, end_ms: 1500000 } },
  { window_id: 'aw000002', index: 1, analysis_range_ms: { start_ms: 1470000, end_ms: 3030000 }, commit_range_ms: { start_ms: 1500000, end_ms: 3000000 } },
  { window_id: 'aw000003', index: 2, analysis_range_ms: { start_ms: 2970000, end_ms: 3600000 }, commit_range_ms: { start_ms: 3000000, end_ms: 3600000 } },
];
const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const EMPTY_SHA = sha256('[]');
const utterance = (start, end, text, speaker = 'speaker-cluster-1') => ({
  start_ms: start, end_ms: end, text, speaker,
});

function makeInput(groups = [
  [utterance(120125, 121125, 'first')],
  [utterance(1590125, 1591125, 'second')],
  [utterance(3090125, 3091125, 'third')],
]) {
  return {
    audioDurationMs: 3600000,
    audioSha256: 'a'.repeat(64),
    windows: WINDOW_PLAN.map((plan, index) => {
      const window = structuredClone(plan);
      const raw = {
        audio_sha256: String(index + 1).repeat(64),
        transcript_sha256: groups[index].length ? String(index + 4).repeat(64) : EMPTY_SHA,
        source_language: groups[index].length ? 'en' : null,
        language_probability: groups[index].length ? [0.95, 0.82, 0.91][index] : null,
        segments: groups[index].map(segment => ({
          start: (segment.start_ms - plan.analysis_range_ms.start_ms) / 1000,
          end: (segment.end_ms - plan.analysis_range_ms.start_ms) / 1000,
          text: segment.text,
          speaker_cluster_id: segment.speaker,
        })),
        ...(!groups[index].length ? { no_speech_evidence: {
          method: 'faster-whisper-vad',
          audio_duration_ms: plan.analysis_range_ms.end_ms - plan.analysis_range_ms.start_ms,
          speech_duration_ms: 0,
        } } : {}),
      };
      window.request_id = `task-window-${index + 1}`;
      window.audio_sha256 = raw.audio_sha256;
      window.workerEvidence = dto(window.request_id, raw);
      return window;
    }),
  };
}

function dto(requestId, raw) {
  return {
    requestId,
    audioSha256: raw.audio_sha256,
    transcriptSha256: raw.transcript_sha256,
    sourceLanguage: raw.source_language,
    languageProbability: raw.language_probability,
    segments: raw.segments.map(segment => ({
      startMs: Math.round(segment.start * 1000),
      endMs: Math.round(segment.end * 1000),
      text: segment.text.trim(),
      speakerClusterId: segment.speaker_cluster_id,
    })),
    ...(raw.no_speech_evidence ? { noSpeechEvidence: structuredClone(raw.no_speech_evidence) } : {}),
    rawSourceEvidence: structuredClone(raw),
  };
}

function aggregate(input) {
  assert.equal(typeof service.aggregateSourceAudioWindows, 'function', 'the producer exposes its reusable v2 aggregation contract');
  return service.aggregateSourceAudioWindows(input);
}

function invalid(input) {
  assert.throws(() => aggregate(input), { code: 'SOURCE_AUDIO_EVIDENCE_INVALID' });
}

function needsReview(input) {
  const before = structuredClone(input);
  let failure;
  assert.throws(() => aggregate(input), error => {
    failure = error;
    return error.code === 'SOURCE_AUDIO_SEAM_REVIEW_REQUIRED';
  });
  assert.ok(failure.diagnostic && Array.isArray(failure.diagnostic.windows));
  assert.notEqual(failure.diagnostic.schema_version, 'redraw-source-audio-evidence-v2');
  assert.equal(Object.hasOwn(failure.diagnostic, 'result_asset_id'), false);
  assert.deepEqual(failure.diagnostic.windows.map(window => window.raw_source_evidence),
    input.windows.map(window => window.workerEvidence.rawSourceEvidence));
  failure.diagnostic.windows[0].raw_source_evidence.source_language = 'changed-returned-copy';
  assert.deepEqual(input, before, 'a content conflict must not mutate or discard original receipts');
}

test('v2 aggregation preserves raw JSON and independent transcript hash without mutating inputs', () => {
  const input = makeInput();
  const before = structuredClone(input);
  const result = aggregate(input);
  assert.equal(result.schema_version, 'redraw-source-audio-evidence-v2');
  assert.equal(result.audio_duration_ms, input.audioDurationMs);
  assert.equal(result.audio_sha256, input.audioSha256);
  assert.deepEqual(result.audio_format, { codec: 'pcm_s16le', sample_rate_hz: 16000, channels: 1, bit_depth: 16 });
  assert.equal(result.dialogue_mode, 'spoken');
  assert.equal(result.source_language, 'en');
  assert.equal(result.language_probability, 0.82, 'use the least confident speech window, not an average');
  assert.deepEqual(result.window_policy, {
    worker_max_audio_bytes: 67108864, target_commit_ms: 1500000, overlap_ms: 30000,
    seam_rule: 'full_utterance_single_owner_or_reject',
  });
  assert.deepEqual(result.coverage, {
    expected_duration_ms: 3600000,
    committed_ranges: WINDOW_PLAN.map(window => ({ window_id: window.window_id, ...window.commit_range_ms })),
    gap_ms: 0,
    full_coverage: true,
    seam_checks: [
      { seam_ms: 1500000, left_window_id: 'aw000001', right_window_id: 'aw000002', status: 'passed' },
      { seam_ms: 3000000, left_window_id: 'aw000002', right_window_id: 'aw000003', status: 'passed' },
    ],
  });
  assert.deepEqual(result.speaker_cluster_policy, { scope: 'window', cross_window_identity: 'unknown' });
  for (const [index, window] of result.windows.entries()) {
    assert.equal(window.index, index);
    assert.equal(window.window_id, input.windows[index].window_id);
    assert.equal(window.worker_status, 'completed');
    assert.equal(window.segment_count, 1);
    assert.equal(window.transcript_sha256, String(index + 4).repeat(64), 'do not replace a declared raw receipt SHA with a recomputed SHA');
    assert.deepEqual(window.raw_source_evidence, input.windows[index].workerEvidence.rawSourceEvidence);
  }
  const canonical = result.segments.map(segment => ({ end_ms: segment.end_ms, source_text: segment.source_text, start_ms: segment.start_ms }));
  assert.equal(result.transcript_sha256, sha256(JSON.stringify(canonical)));
  assert.equal(new Set(result.segments.map(segment => segment.speaker_cluster_id)).size, 3);
  assert.equal(new Set(result.segments.map(segment => segment.id)).size, 3);
  assert.equal(new Set(result.segments.map(segment => segment.evidence_ref)).size, 3);
  assert.deepEqual(aggregate(input), result, 'stable input produces stable IDs and bindings');
  result.windows[0].raw_source_evidence.segments[0].text = 'changed returned copy';
  assert.deepEqual(input, before, 'the result must not share mutable raw receipt objects with its caller');
});

test('a full seam utterance is never cropped and physical source remains separate from logical commit owner', () => {
  const input = makeInput([
    [utterance(1499000, 1502000, '  Keep the complete sentence.  ')],
    [utterance(1499500, 1502500, 'Keep the complete sentence.')],
    [utterance(3090000, 3091000, 'Later.')],
  ]);
  const result = aggregate(input);
  assert.equal(result.segments.length, 2);
  const segment = result.segments[0];
  assert.equal(segment.start_ms, 1499000);
  assert.equal(segment.end_ms, 1502000);
  assert.equal(segment.source_text, '  Keep the complete sentence.  ', 'trim only for matching, never for saved source text');
  assert.equal(segment.commit_window_id, 'aw000002');
  assert.equal(segment.speaker_cluster_id, 'aw000001-speaker-cluster-1');
  assert.equal(segment.speaker_cluster_scope, 'window');
  assert.equal(segment.speaker_link_status, 'unknown');
  assert.equal(segment.source_bindings.length, 2);
  assert.equal(segment.selected_source_binding_index, 0);
  assert.deepEqual(segment.source_bindings.map(binding => binding.role), ['selected_source', 'deduplicated_overlap']);
  assert.deepEqual(segment.source_bindings.map(binding => binding.window_id), ['aw000001', 'aw000002']);
  for (const [index, binding] of segment.source_bindings.entries()) {
    const window = input.windows[index];
    const raw = window.workerEvidence.rawSourceEvidence.segments[0];
    assert.equal(binding.worker_request_id, window.request_id);
    assert.equal(binding.worker_segment_index, 0);
    assert.deepEqual(binding.worker_relative_range_ms, { start_ms: raw.start * 1000, end_ms: raw.end * 1000 });
    assert.deepEqual(binding.absolute_range_ms, {
      start_ms: window.analysis_range_ms.start_ms + raw.start * 1000,
      end_ms: window.analysis_range_ms.start_ms + raw.end * 1000,
    });
    assert.equal(binding.window_audio_sha256, window.audio_sha256);
    assert.equal(binding.window_transcript_sha256, window.workerEvidence.transcriptSha256);
    assert.equal(binding.worker_source_text, raw.text);
    assert.equal(binding.raw_worker_speaker_cluster_id, raw.speaker_cluster_id);
  }
});

test('a midpoint exactly on the seam belongs to the right half-open commit window', () => {
  const line = utterance(1499000, 1501000, 'Boundary.');
  const result = aggregate(makeInput([[line], [line], [utterance(3090000, 3091000, 'Later.')]]));
  assert.equal(result.segments[0].commit_window_id, 'aw000002');
  assert.equal(result.segments[0].speaker_cluster_id, 'aw000001-speaker-cluster-1');
});

test('v2 retains raw sub-millisecond intervals and whitespace instead of rebuilding from the rounded DTO', () => {
  const input = makeInput();
  const window = input.windows[1];
  const raw = structuredClone(window.workerEvidence.rawSourceEvidence);
  raw.segments[0] = { start: 120.1254, end: 121.1256, text: '  完整原文 — full text. \n', speaker_cluster_id: 'speaker-cluster-1' };
  window.workerEvidence = dto(window.request_id, raw);
  assert.equal(window.workerEvidence.segments[0].startMs, 120125);
  assert.equal(window.workerEvidence.segments[0].endMs, 121126);
  assert.equal(window.workerEvidence.segments[0].text, '完整原文 — full text.');
  const result = aggregate(input);
  const segment = result.segments[1];
  assert.equal(segment.start_ms, 1470000 + raw.segments[0].start * 1000);
  assert.equal(segment.end_ms, 1470000 + raw.segments[0].end * 1000);
  assert.equal(segment.source_text, raw.segments[0].text);
  assert.deepEqual(segment.source_bindings[0].worker_relative_range_ms, {
    start_ms: raw.segments[0].start * 1000, end_ms: raw.segments[0].end * 1000,
  });
  assert.equal(result.transcript_sha256, sha256(JSON.stringify(result.segments.map(item => ({
    end_ms: item.end_ms, source_text: item.source_text, start_ms: item.start_ms,
  })))));
  assert.deepEqual(result.windows[1].raw_source_evidence, raw);
  assert.equal(result.windows[1].transcript_sha256, raw.transcript_sha256);
});

test('repeated text is deduplicated only through disjoint bidirectionally unique overlap pairs', () => {
  const lines = [utterance(1480000, 1481000, 'Again.'), utterance(1510000, 1511000, 'Again.')];
  const result = aggregate(makeInput([lines, lines, [utterance(3090000, 3091000, 'Later.')]]));
  assert.deepEqual(result.segments.map(segment => segment.start_ms), [1480000, 1510000, 3090000]);
  assert.deepEqual(result.segments.slice(0, 2).map(segment => segment.source_bindings.length), [2, 2]);
});

for (const [name, left, right] of [
  ['missing counterpart', [utterance(1499000, 1502000, 'Complete.')], []],
  ['same text without temporal overlap', [utterance(1490000, 1491000, 'Complete.')], [utterance(1505000, 1506000, 'Complete.')]],
  ['contradictory text', [utterance(1499000, 1502000, 'Yes.')], [utterance(1499000, 1502000, 'No.')]],
  ['two same-text candidates', [utterance(1498000, 1502000, 'Again.')], [utterance(1498500, 1499000, 'Again.'), utterance(1500500, 1501500, 'Again.')]],
  ['representatives disagree on logical owner', [utterance(1499000, 1501000, 'Boundary.')], [utterance(1498000, 1500000, 'Boundary.')]],
]) {
  test(`seam ${name} stops for review with full raw diagnostics, not a network-unknown result`, () => {
    needsReview(makeInput([left, right, [utterance(3090000, 3091000, 'Later.')]]));
  });
}

test('all VAD-silent windows yield silent full coverage and retain each no-speech receipt', () => {
  const input = makeInput([[], [], []]);
  const result = aggregate(input);
  assert.equal(result.dialogue_mode, 'silent');
  assert.equal(result.source_language, null);
  assert.equal(result.language_probability, null);
  assert.equal(result.transcript_sha256, EMPTY_SHA);
  assert.deepEqual(result.segments, []);
  assert.equal(result.coverage.full_coverage, true);
  for (const [index, window] of result.windows.entries()) {
    assert.deepEqual(window.raw_source_evidence.no_speech_evidence,
      input.windows[index].workerEvidence.rawSourceEvidence.no_speech_evidence);
  }
});

test('mixed spoken and VAD-silent windows retain silent coverage without inventing speech', () => {
  const input = makeInput([[utterance(120000, 121000, 'Speech.')], [], []]);
  const result = aggregate(input);
  assert.equal(result.dialogue_mode, 'spoken');
  assert.equal(result.source_language, 'en');
  assert.equal(result.language_probability, 0.95);
  assert.equal(result.segments.length, 1);
  assert.equal(result.windows.length, 3);
  assert.equal(result.coverage.full_coverage, true);
  assert.equal(result.windows[1].raw_source_evidence.no_speech_evidence.speech_duration_ms, 0);
});

for (const [name, change] of [
  ['missing proof', worker => { delete worker.noSpeechEvidence; delete worker.rawSourceEvidence.no_speech_evidence; }],
  ['proof duration mismatch', worker => { worker.noSpeechEvidence.audio_duration_ms = 1; worker.rawSourceEvidence.no_speech_evidence.audio_duration_ms = 1; }],
  ['normal/raw proof mismatch', worker => { worker.noSpeechEvidence.audio_duration_ms += 1; }],
  ['nonzero speech duration', worker => { worker.noSpeechEvidence.speech_duration_ms = 1; worker.rawSourceEvidence.no_speech_evidence.speech_duration_ms = 1; }],
  ['nonempty silent transcript hash', worker => { worker.transcriptSha256 = 'b'.repeat(64); worker.rawSourceEvidence.transcript_sha256 = 'b'.repeat(64); }],
]) {
  test(`silent window ${name} is invalid, not silently accepted as coverage`, () => {
    const input = makeInput([[], [], []]); change(input.windows[1].workerEvidence); invalid(input);
  });
}

test('different spoken languages never resolve by majority vote', () => {
  const input = makeInput();
  input.windows[1].workerEvidence.sourceLanguage = 'zh';
  input.windows[1].workerEvidence.rawSourceEvidence.source_language = 'zh';
  needsReview(input);
});

for (const count of [4096, 4097]) {
  test(`aggregate ${count} segments ${count === 4096 ? 'retains every segment' : 'fails before evidence registration'}`, () => {
    const sizes = count === 4096 ? [1366, 1365, 1365] : [1366, 1366, 1365];
    const groups = sizes.map((size, index) => Array.from({ length: size }, (_, n) => {
      const start = WINDOW_PLAN[index].analysis_range_ms.start_ms + 120000 + n * 10;
      return utterance(start, start + 5, `w${index + 1}s${n}`);
    }));
    const input = makeInput(groups);
    if (count === 4097) invalid(input);
    else assert.equal(aggregate(input).segments.length, count);
  });
}

for (const [name, change] of [
  ['missing raw', window => { delete window.workerEvidence.rawSourceEvidence; }],
  ['audio SHA mismatch', window => { window.workerEvidence.rawSourceEvidence.audio_sha256 = 'f'.repeat(64); }],
  ['declared transcript SHA mismatch', window => { window.workerEvidence.rawSourceEvidence.transcript_sha256 = 'f'.repeat(64); }],
  ['request mismatch', window => { window.workerEvidence.requestId = 'foreign-request'; }],
  ['normalized text mismatch', window => { window.workerEvidence.segments[0].text = 'Not the raw text.'; }],
  ['normalized start mismatch', window => { window.workerEvidence.segments[0].startMs += 1; }],
  ['normalized end mismatch', window => { window.workerEvidence.segments[0].endMs += 1; }],
  ['normalized speaker mismatch', window => { window.workerEvidence.segments[0].speakerClusterId = 'speaker-cluster-2'; }],
  ['language mismatch', window => { window.workerEvidence.sourceLanguage = 'zh'; }],
  ['probability mismatch', window => { window.workerEvidence.languageProbability = 0.1; }],
]) {
  test(`raw/normal DTO ${name} is invalid without mutating the receipt`, () => {
    const input = makeInput(); change(input.windows[1]);
    const before = structuredClone(input); invalid(input); assert.deepEqual(input, before);
  });
}

for (const [name, change] of [
  ['negative relative start', raw => { raw.segments[0].start = -0.001; }],
  ['past analysis end', raw => { raw.segments[0].end = 1560.001; }],
  ['nonfinite end', raw => { raw.segments[0].end = Number.POSITIVE_INFINITY; }],
  ['empty interval', raw => { raw.segments[0].end = raw.segments[0].start; }],
]) {
  test(`raw segment ${name} is rejected rather than clipped`, () => {
    const input = makeInput();
    const window = input.windows[1];
    const raw = structuredClone(window.workerEvidence.rawSourceEvidence); change(raw);
    window.workerEvidence = dto(window.request_id, raw);
    invalid(input);
  });
}

for (const [name, change] of [
  ['coverage gap', input => { input.windows[1].commit_range_ms.start_ms += 1; }],
  ['coverage overlap', input => { input.windows[1].commit_range_ms.start_ms -= 1; }],
  ['missing last window', input => { input.windows.pop(); }],
  ['duplicate request', input => { input.windows[1].request_id = input.windows[0].request_id; input.windows[1].workerEvidence.requestId = input.windows[0].request_id; }],
  ['duplicate window id', input => { input.windows[1].window_id = input.windows[0].window_id; }],
  ['wrong physical index', input => { input.windows[1].index = 0; }],
  ['analysis excludes commit', input => { input.windows[1].analysis_range_ms.start_ms = 1500001; }],
  ['non-sample-aligned total duration', input => { input.audioDurationMs += 0.01; }],
]) {
  test(`window plan ${name} is invalid rather than claimed complete`, () => {
    const input = makeInput(); change(input); invalid(input);
  });
}

test('a final PCM sample retains 1/16 millisecond duration instead of dropping or padding it', () => {
  const input = makeInput();
  input.audioDurationMs += 1 / 16;
  input.windows[2].analysis_range_ms.end_ms += 1 / 16;
  input.windows[2].commit_range_ms.end_ms += 1 / 16;
  const result = aggregate(input);
  assert.equal(result.audio_duration_ms, 3600000.0625);
  assert.equal(result.coverage.expected_duration_ms, 3600000.0625);
  assert.equal(result.coverage.committed_ranges[2].end_ms, 3600000.0625);
  assert.equal(result.windows[2].analysis_range_ms.end_ms, 3600000.0625);
  assert.equal(result.coverage.gap_ms, 0);
});

for (const [name, durationMs, permitted] of [
  ['last whole millisecond below the RIFF size ceiling', 134217726, true],
  ['first whole millisecond beyond the RIFF size ceiling', 134217727, false],
]) {
  test(`aggregate ${name} uses bounded metadata rather than an unbounded window plan`, () => {
    const windows = [];
    for (let start = 0; start < durationMs; start += 1500000) {
      const index = windows.length, end = Math.min(start + 1500000, durationMs);
      const analysis = { start_ms: Math.max(0, start - 30000), end_ms: Math.min(durationMs, end + 30000) };
      const requestId = `bounded-window-${index + 1}`;
      const raw = {
        audio_sha256: sha256(requestId), transcript_sha256: EMPTY_SHA,
        source_language: null, language_probability: null, segments: [],
        no_speech_evidence: { method: 'faster-whisper-vad', audio_duration_ms: analysis.end_ms - analysis.start_ms, speech_duration_ms: 0 },
      };
      windows.push({
        window_id: `aw${String(index + 1).padStart(6, '0')}`, index,
        analysis_range_ms: analysis, commit_range_ms: { start_ms: start, end_ms: end },
        request_id: requestId, audio_sha256: raw.audio_sha256, workerEvidence: dto(requestId, raw),
      });
    }
    assert.equal(windows.length, 90, 'only ninety metadata windows are created; no media, giant arrays, or OOM probe');
    const input = { audioDurationMs: durationMs, audioSha256: 'a'.repeat(64), windows };
    if (permitted) assert.equal(aggregate(input).coverage.full_coverage, true);
    else invalid(input);
  });
}

for (const extraMs of [0.0625, 0.5]) {
  test(`rounded VAD receipt retains exact PCM coverage with ${extraMs}ms final samples`, () => {
    const input = makeInput([[], [], []]);
    input.audioDurationMs += extraMs;
    input.windows[2].analysis_range_ms.end_ms += extraMs;
    input.windows[2].commit_range_ms.end_ms += extraMs;
    // Existing Python Worker rounds to integer milliseconds, including ties-to-even.
    // The original integer receipt remains unchanged; only PCM coverage is fractional.
    const raw = structuredClone(input.windows[2].workerEvidence.rawSourceEvidence);
    assert.equal(raw.no_speech_evidence.audio_duration_ms, 630000);
    const result = aggregate(input);
    assert.equal(result.dialogue_mode, 'silent');
    assert.equal(result.audio_duration_ms, 3600000 + extraMs);
    assert.equal(result.coverage.expected_duration_ms, 3600000 + extraMs);
    assert.equal(result.coverage.committed_ranges[2].end_ms, 3600000 + extraMs);
    assert.deepEqual(result.windows[2].raw_source_evidence, raw);
    assert.equal(result.transcript_sha256, EMPTY_SHA);
  });
}

test('rounded VAD receipt beyond its half-millisecond quantization bound is invalid', () => {
  const input = makeInput([[], [], []]);
  input.audioDurationMs += 0.0625;
  input.windows[2].analysis_range_ms.end_ms += 0.0625;
  input.windows[2].commit_range_ms.end_ms += 0.0625;
  input.windows[2].workerEvidence.noSpeechEvidence.audio_duration_ms = 630001;
  input.windows[2].workerEvidence.rawSourceEvidence.no_speech_evidence.audio_duration_ms = 630001;
  invalid(input);
});

test('rounded VAD receipt still requires an integer, not a fractional value within the quantization bound', () => {
  const input = makeInput([[], [], []]);
  input.windows[2].workerEvidence.noSpeechEvidence.audio_duration_ms = 630000.25;
  input.windows[2].workerEvidence.rawSourceEvidence.no_speech_evidence.audio_duration_ms = 630000.25;
  invalid(input);
});
