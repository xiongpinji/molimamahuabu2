const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSubtitles,
  validateSubtitles,
  serializeSrt,
  serializeVtt,
} = require('../src/services/redrawSubtitleService');

test('buildSubtitles sorts absolute timeline cues and serializes exact SRT/VTT formats', () => {
  const result = buildSubtitles([
    { segment_id: 'b', start_ms: 2500, end_ms: 4500, text: 'Second line' },
    { segment_id: 'a', start_ms: 0, end_ms: 1500, text: 'First line' },
  ], { locale: 'en-US' });

  assert.equal(result.status, 'ready');
  assert.equal(result.locale, 'en-US');
  assert.equal(result.direction, 'ltr');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.cues.map((cue) => cue.segment_id), ['a', 'b']);
  assert.deepEqual(result.cues.map((cue) => [cue.start_ms, cue.end_ms]), [[0, 1500], [2500, 4500]]);
  assert.equal(result.srt, [
    '1',
    '00:00:00,000 --> 00:00:01,500',
    'First line',
    '',
    '2',
    '00:00:02,500 --> 00:00:04,500',
    'Second line',
    '',
  ].join('\n'));
  assert.equal(result.vtt, [
    'WEBVTT',
    '',
    '1',
    '00:00:00.000 --> 00:00:01.500',
    'First line',
    '',
    '2',
    '00:00:02.500 --> 00:00:04.500',
    'Second line',
    '',
  ].join('\n'));
});

test('buildSubtitles is deterministic for equal times and segment ids', () => {
  const input = [
    { segment_id: 'same', start_ms: 1000, end_ms: 2000, text: 'Alpha' },
    { segment_id: 'same', start_ms: 1000, end_ms: 2000, text: 'Alpha' },
    { segment_id: 'later', start_ms: 1000, end_ms: 2200, text: 'Beta' },
  ];

  const first = buildSubtitles(input, { locale: 'en-US' });
  const second = buildSubtitles([...input].reverse(), { locale: 'en-US' });

  assert.equal(first.srt, second.srt);
  assert.deepEqual(first.cues, second.cues);
});

test('validateSubtitles rejects overlaps, empty text, and invalid durations without adjusting times', () => {
  const cues = [
    { segment_id: 'empty', start_ms: 0, end_ms: 1000, text: '   ' },
    { segment_id: 'bad-duration', start_ms: 1000, end_ms: 1000, text: 'No duration' },
    { segment_id: 'overlap-a', start_ms: 1500, end_ms: 2500, text: 'First overlap' },
    { segment_id: 'overlap-b', start_ms: 2000, end_ms: 3000, text: 'Second overlap' },
  ];

  const result = buildSubtitles(cues, { locale: 'en-US' });

  assert.equal(result.status, 'needs_rewrite');
  assert.equal(result.srt, null);
  assert.equal(result.vtt, null);
  assert.deepEqual(result.cues.map((cue) => [cue.segment_id, cue.start_ms, cue.end_ms]), [
    ['empty', 0, 1000],
    ['bad-duration', 1000, 1000],
    ['overlap-a', 1500, 2500],
    ['overlap-b', 2000, 3000],
  ]);
  assert.deepEqual(result.errors.map((error) => error.reason), [
    'subtitle_text_empty',
    'subtitle_time_invalid',
    'subtitle_overlap',
  ]);
});

test('validateSubtitles rejects non-number and non-integer raw time values', () => {
  const invalidStartValues = [null, '', [], false, '0', NaN, Infinity, 0.5];
  const invalidEndValues = [null, '', [], false, '1000', NaN, Infinity, 1000.5];

  for (const [index, start_ms] of invalidStartValues.entries()) {
    const result = buildSubtitles([
      { segment_id: `bad-start-${index}`, start_ms, end_ms: 1000, text: 'Valid text' },
    ], { locale: 'en-US' });
    assert.equal(result.status, 'needs_rewrite');
    assert.equal(result.srt, null);
    assert.equal(result.vtt, null);
    assert.ok(result.errors.some((error) => error.reason === 'subtitle_time_invalid'));
  }

  for (const [index, end_ms] of invalidEndValues.entries()) {
    const result = buildSubtitles([
      { segment_id: `bad-end-${index}`, start_ms: 0, end_ms, text: 'Valid text' },
    ], { locale: 'en-US' });
    assert.equal(result.status, 'needs_rewrite');
    assert.equal(result.srt, null);
    assert.equal(result.vtt, null);
    assert.ok(result.errors.some((error) => error.reason === 'subtitle_time_invalid'));
  }
});

test('English P0 limits 20 cps, 42 code points per line, two lines, and never truncates text', () => {
  const longWords = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';
  const tooFast = 'This subtitle has way too many characters for one second.';
  const result = buildSubtitles([
    { segment_id: 'wrapped', start_ms: 0, end_ms: 5000, text: longWords },
    { segment_id: 'fast', start_ms: 6000, end_ms: 7000, text: tooFast },
    { segment_id: 'too-long', start_ms: 8000, end_ms: 12000, text: `${longWords} mu nu xi omicron pi rho sigma tau upsilon` },
  ], { locale: 'en-US', maxCharsPerSecond: 999, maxLineCodePoints: 999, maxLines: 99 });

  assert.equal(result.status, 'needs_rewrite');
  assert.equal(result.srt, null);
  assert.equal(result.vtt, null);
  assert.deepEqual(result.cues[0].lines, ['Alpha beta gamma delta epsilon zeta eta', 'theta iota kappa lambda']);
  assert.equal(result.cues[0].text, longWords);
  assert.equal(result.cues[1].text, tooFast);
  assert.ok(result.errors.some((error) => error.segment_id === 'fast' && error.reason === 'subtitle_reading_speed_exceeded'));
  assert.ok(result.errors.some((error) => error.segment_id === 'too-long' && error.reason === 'subtitle_line_length_exceeded'));
});

test('reading speed counts spaces and client options cannot relax 20 cps', () => {
  const result = buildSubtitles([
    { segment_id: 'spaces-count', start_ms: 0, end_ms: 1000, text: 'a a a a a a a a a a a' },
  ], { locale: 'en-US', maxCharsPerSecond: 999 });

  assert.equal(result.status, 'needs_rewrite');
  assert.equal(result.srt, null);
  assert.equal(result.vtt, null);
  assert.ok(result.errors.some((error) => (
    error.segment_id === 'spaces-count'
    && error.reason === 'subtitle_reading_speed_exceeded'
  )));
});

test('subtitle limit options clamp to safe bounds without relaxing server caps', () => {
  for (const options of [
    { maxCharsPerSecond: 0, maxLineCodePoints: 0, maxLines: 0 },
    { maxCharsPerSecond: -1, maxLineCodePoints: -1, maxLines: -1 },
    { maxCharsPerSecond: NaN, maxLineCodePoints: NaN, maxLines: NaN },
  ]) {
    const valid = buildSubtitles([
      { segment_id: 'valid', start_ms: 0, end_ms: 1000, text: 'OK' },
    ], { locale: 'en-US', ...options });
    assert.equal(valid.status, 'ready');
    assert.deepEqual(valid.errors, []);
  }

  const tooFast = buildSubtitles([
    { segment_id: 'server-cap', start_ms: 0, end_ms: 1000, text: 'a a a a a a a a a a a' },
  ], { locale: 'en-US', maxCharsPerSecond: 999, maxLineCodePoints: 999, maxLines: 999 });
  assert.equal(tooFast.status, 'needs_rewrite');
  assert.ok(tooFast.errors.some((error) => error.reason === 'subtitle_reading_speed_exceeded'));
});

test('RTL locale marks direction and serializers escape HTML while preserving safe line breaks', () => {
  const cues = validateSubtitles([
    { segment_id: 'rtl', start_ms: 0, end_ms: 3000, text: 'مرحبا & <b>أهلا</b>\nثانيا' },
  ], { locale: 'ar-EG' });

  assert.equal(cues.status, 'ready');
  assert.equal(cues.direction, 'rtl');
  assert.equal(serializeSrt(cues.cues), [
    '1',
    '00:00:00,000 --> 00:00:03,000',
    'مرحبا &amp; &lt;b&gt;أهلا&lt;/b&gt;',
    'ثانيا',
    '',
  ].join('\n'));
  assert.equal(serializeVtt(cues.cues), [
    'WEBVTT',
    '',
    '1',
    '00:00:00.000 --> 00:00:03.000',
    'مرحبا &amp; &lt;b&gt;أهلا&lt;/b&gt;',
    'ثانيا',
    '',
  ].join('\n'));
});
