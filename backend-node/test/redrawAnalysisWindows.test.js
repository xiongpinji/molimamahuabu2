const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildPrompt } = require('../src/services/redrawNativeSourceAnalysisService');
const { normalizeSourceFacts, stableStringify } = require('../src/services/redrawAnalysisService');
let windows;
try { windows = require('../src/services/redrawAnalysisWindowService'); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  windows = {};
}

function plan(durationMs, audioEvidence) {
  assert.equal(typeof windows.planAnalysisWindows, 'function', 'deterministic analysis window planner must exist');
  return windows.planAnalysisWindows({ duration_ms: durationMs, width: 320, height: 180 }, audioEvidence, buildPrompt);
}

function summary(window) {
  return JSON.parse(window.prompt.match(/BEGIN UNTRUSTED TRANSCRIPT DATA\n([^\n]+)\nEND UNTRUSTED TRANSCRIPT DATA/)[1]);
}

function localFacts(durationMs, suffix = '') {
  return { schema_version: '2.0', duration_ms: durationMs,
    story: [`z原顺序${suffix}`, `a原顺序${suffix}`], characters: [{ id: 'c1', source_name: '同名角色' }],
    scenes: [{ id: 's1', location: '室内', time: '日', source_ranges: [{ start_ms: 0, end_ms: durationMs }] }],
    props: [{ id: 'p1', name: '手机', evidence_ranges: [{ start_ms: 0, end_ms: durationMs }] }],
    shots: [{ id: 'shot1', index: 1, start_ms: 0, end_ms: durationMs, composition: '中景', camera_movement: '固定',
      opening_state: '持手机', continuous_action: '举手机', ending_state: '看手机', visible_character_ids: ['c1'],
      dialogue: [], text_regions: [{ id: 'text1', kind: 'subtitle', source_text: '原字幕', polygon: [[0, 0], [1, 0], [0, 1]] }],
      audio_contract: { dialogue_mode: 'silent', ambient_audio: 'preserve_or_rebuild' },
      confidence: { character_mapping: 0.9, speaker_mapping: 0, text_regions: 0.9, shot_boundary: 0.9 } }],
    causal_chain: [`z因果${suffix}`, `a因果${suffix}`], locked_facts: [`z事实${suffix}`, `a事实${suffix}`],
    reversals: [`z转折${suffix}`, `a转折${suffix}`], episode_hook: `悬念${suffix}` };
}

test('one-hour and empty-audio windows continuously cover source with at most 24 seconds and six sheets', () => {
  const result = plan(3_600_001);
  assert.equal(result.length, 151);
  let previousEnd = 0;
  for (const window of result) {
    assert.equal(window.start_ms, previousEnd);
    assert.ok(window.end_ms > window.start_ms);
    assert.ok(window.end_ms - window.start_ms <= 24_000);
    assert.ok(window.sheets.length <= 6);
    assert.ok(window.sheets.every((sheet) => sheet.frameCount <= 12));
    assert.ok(window.sheets.every((sheet) => sheet.startSeconds * 1000 >= window.start_ms));
    previousEnd = window.end_ms;
  }
  assert.equal(previousEnd, 3_600_001);
  assert.deepEqual(plan(1000, { dialogue_mode: 'silent', segments: [] }).map((window) => [window.start_ms, window.end_ms]), [[0, 1000]]);
});

test('more than 64 ASR segments deterministically bisect without losing or mutating any segment', () => {
  const evidence = { dialogue_mode: 'spoken', segments: Array.from({ length: 100 }, (_, index) => ({
    id: `audio-${index}`, evidence_ref: `ref-${index}`, start_ms: index * 10, end_ms: index * 10 + 9, source_text: `原文${index}`,
  })) };
  const before = JSON.stringify(evidence);
  const result = plan(1000, evidence);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((window) => [window.start_ms, window.end_ms]), [[0, 500], [500, 1000]]);
  assert.deepEqual(result.flatMap((window) => summary(window).segments.map((segment) => segment.id)), evidence.segments.map((segment) => segment.id));
  assert.equal(JSON.stringify(evidence), before);
  assert.deepEqual(plan(1000, evidence), result);
});

test('UTF-8 over-limit previews split windows while preserving complete long IDs and evidence refs', () => {
  const evidence = { dialogue_mode: 'spoken', segments: Array.from({ length: 64 }, (_, index) => ({
    id: `${'i'.repeat(100)}-${index}`, evidence_ref: `${'r'.repeat(100)}-${index}`, start_ms: index * 100,
    end_ms: index * 100 + 90, source_text: '中'.repeat(200),
  })) };
  const result = plan(6400, evidence);
  assert.ok(result.length > 1);
  const segments = result.flatMap((window) => summary(window).segments);
  assert.deepEqual(segments.map((segment) => segment.id), evidence.segments.map((segment) => segment.id));
  assert.deepEqual(segments.map((segment) => segment.evidence_ref), evidence.segments.map((segment) => segment.evidence_ref));
  assert.ok(segments.every((segment) => segment.source_text_preview === '中'.repeat(160)));
  assert.ok(result.every((window) => Buffer.byteLength(JSON.stringify(summary(window)), 'utf8') <= 16 * 1024));
});

test('cross-window ASR overlap repeats the original untrimmed absolute timing and preview', () => {
  const segment = { id: 'across', evidence_ref: 'original', start_ms: 23_999, end_ms: 24_001, source_text: '这句跨窗不能被截断' };
  const evidence = { dialogue_mode: 'spoken', segments: [segment] };
  const result = plan(25_000, evidence);
  assert.deepEqual(summary(result[0]).segments, summary(result[1]).segments);
  assert.equal(summary(result[0]).segments[0].start_ms, 23_999);
  assert.equal(summary(result[0]).segments[0].end_ms, 24_001);
  assert.deepEqual(evidence.segments, [segment]);
});

test('dense overlap that is still over limit at 1ms rejects with original limit code', () => {
  assert.throws(() => plan(100, { segments: Array.from({ length: 65 }, (_, index) => ({
    id: `dense-${index}`, start_ms: 50, end_ms: 51, source_text: '密集',
  })) }), (error) => error.code === 'REDRAW_NATIVE_AUDIO_PROMPT_LIMIT');
});

test('all audio timings must be integers and stay inside measured duration', () => {
  for (const [start, end] of [[-1, 10], [0, 1001], [10, 10], [10, 9], [0.5, 10], [0, NaN], ['0', 10]]) {
    assert.throws(() => plan(1000, { segments: [{ id: 'bad', start_ms: start, end_ms: end, source_text: '原文' }] }),
      (error) => error.code === 'REDRAW_NATIVE_AUDIO_TIMING_INVALID');
  }
});

test('unsafe data in any later window fails the whole preflight', () => {
  assert.throws(() => plan(25_000, { segments: [{ id: 'later', start_ms: 24_100, end_ms: 24_200, source_text: 'bearer secret' }] }),
    (error) => error.code === 'REDRAW_NATIVE_AUDIO_PROMPT_UNSAFE');
});

test('safe multi-window merge namespaces identities, offsets ranges and keeps ordered narrative sidecar', () => {
  assert.equal(typeof windows.mergeWindowFacts, 'function');
  const first = localFacts(24_000, '一');
  const second = localFacts(1000, '二');
  const before = JSON.stringify([first, second]);
  const merged = windows.mergeWindowFacts([
    { start_ms: 0, end_ms: 24_000, facts: first }, { start_ms: 24_000, end_ms: 25_000, facts: second },
  ], 25_000);
  const facts = merged.facts;
  assert.equal(facts.characters.length, 2);
  assert.notEqual(facts.characters[0].id, facts.characters[1].id);
  assert.ok(facts.shots.every((shot) => shot.visible_character_ids.every((id) => facts.characters.some((character) => character.id === id))));
  assert.deepEqual(facts.scenes.map((scene) => scene.source_ranges[0]), [{ start_ms: 0, end_ms: 24_000 }, { start_ms: 24_000, end_ms: 25_000 }]);
  assert.deepEqual(facts.props.map((prop) => prop.evidence_ranges[0]), [{ start_ms: 0, end_ms: 24_000 }, { start_ms: 24_000, end_ms: 25_000 }]);
  assert.deepEqual(facts.shots.map((shot) => [shot.index, shot.start_ms, shot.end_ms]), [[1, 0, 24_000], [2, 24_000, 25_000]]);
  assert.ok(merged.diagnostics.ordered_narratives);
  for (const field of ['story', 'causal_chain', 'locked_facts', 'reversals']) {
    assert.deepEqual(merged.diagnostics.ordered_narratives[field], [...first[field], ...second[field]]);
  }
  assert.equal(merged.diagnostics.ordered_narratives.episode_hook, second.episode_hook);
  assert.equal(merged.diagnostics.narrative_order_hash, crypto.createHash('sha256')
    .update(stableStringify(merged.diagnostics.ordered_narratives)).digest('hex'));
  assert.equal(facts.episode_hook, second.episode_hook);
  assert.ok(facts.shots.every((shot) => shot.confidence.character_mapping === 0 && shot.confidence.shot_boundary === 0));
  assert.equal(merged.diagnostics.needs_review, true);
  assert.equal(merged.diagnostics.cross_window_identity, 'needs_review');
  assert.equal(merged.diagnostics.artificial_window_boundaries, 'needs_review');
  assert.equal(JSON.stringify([first, second]), before);
  const { facts_hash: hash, ...raw } = facts;
  assert.doesNotThrow(() => normalizeSourceFacts(raw));
  assert.equal(hash, crypto.createHash('sha256').update(stableStringify(raw)).digest('hex'));
});

test('multi-window canonical facts survive normalize roundtrip while sidecar retains exact whitespace and order', () => {
  const first = localFacts(10, '一');
  const second = localFacts(10, '二');
  first.story = [' z原句 ', ' a原句 '];
  second.episode_hook = '  原始末窗悬念  ';
  const merged = windows.mergeWindowFacts([{ start_ms: 0, end_ms: 10, facts: first },
    { start_ms: 10, end_ms: 20, facts: second }], 20);
  const { facts_hash: hash, ...raw } = merged.facts;
  const roundtrip = normalizeSourceFacts(raw);
  assert.deepEqual(roundtrip, merged.facts);
  assert.equal(roundtrip.facts_hash, hash);
  assert.deepEqual(merged.diagnostics.ordered_narratives.story, [...first.story, ...second.story]);
  assert.equal(merged.diagnostics.ordered_narratives.episode_hook, second.episode_hook);
  assert.equal(merged.facts.episode_hook, second.episode_hook.trim());
  assert.equal(merged.diagnostics.narrative_order_hash, crypto.createHash('sha256')
    .update(stableStringify(merged.diagnostics.ordered_narratives)).digest('hex'));
});

test('96-character reused IDs retain deterministic uniqueness without truncation collisions', () => {
  assert.equal(typeof windows.mergeWindowFacts, 'function');
  const first = localFacts(10);
  first.characters = [{ id: `${'x'.repeat(95)}a`, source_name: '甲' }, { id: `${'x'.repeat(95)}b`, source_name: '乙' }];
  first.shots[0].visible_character_ids = first.characters.map((character) => character.id);
  first.shots[0].id = 's'.repeat(96);
  first.scenes[0].id = 'l'.repeat(96);
  first.props[0].id = 'p'.repeat(96);
  first.shots[0].text_regions[0].id = 't'.repeat(96);
  const entries = [{ start_ms: 0, end_ms: 10, facts: first }, { start_ms: 10, end_ms: 20, facts: structuredClone(first) }];
  const result = windows.mergeWindowFacts(entries, 20);
  const ids = [...result.facts.characters, ...result.facts.scenes, ...result.facts.props, ...result.facts.shots,
    ...result.facts.shots.flatMap((shot) => shot.text_regions)].map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id.length <= 96));
  assert.deepEqual(windows.mergeWindowFacts(entries, 20), result);
});

test('merger rejects malformed local facts and noncontinuous or wrong-duration global windows', () => {
  assert.equal(typeof windows.mergeWindowFacts, 'function');
  for (const change of [
    (facts) => { delete facts.characters[0].id; },
    (facts) => { facts.shots[0].visible_character_ids = ['unknown']; },
    (facts) => { facts.scenes[0].source_ranges[0].end_ms = 11; },
    (facts) => { facts.shots[0].end_ms = 9; },
  ]) {
    const facts = localFacts(10);
    change(facts);
    assert.throws(() => windows.mergeWindowFacts([{ start_ms: 0, end_ms: 10, facts }, { start_ms: 10, end_ms: 20, facts: localFacts(10) }], 20));
  }
  assert.throws(() => windows.mergeWindowFacts([{ start_ms: 0, end_ms: 10, facts: localFacts(10) },
    { start_ms: 11, end_ms: 21, facts: localFacts(10) }], 21));
  assert.throws(() => windows.mergeWindowFacts([{ start_ms: 0, end_ms: 10, facts: localFacts(10) }], 11));
});

test('single-window normalized facts and original IDs remain unchanged', () => {
  assert.equal(typeof windows.mergeWindowFacts, 'function');
  const facts = normalizeSourceFacts(localFacts(1000));
  const merged = windows.mergeWindowFacts([{ start_ms: 0, end_ms: 1000, facts }], 1000);
  assert.deepEqual(merged.facts, facts);
  assert.deepEqual(merged.diagnostics, {});
});
