'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyEnrichment,
  buildEnrichmentPrompt,
  enrichSourceFacts,
} = require('../src/services/redrawSourceEnrichmentService');

function firstPassFacts() {
  return {
    schema_version: '2.0',
    duration_ms: 8_000,
    characters: [
      { id: 'c1', source_name: '林江', display_name: 'Lin Jiang', relationship: 'student', relationships: [] },
      { id: 'c2', source_name: '陆飞', display_name: 'Lu Fei', relationship: 'classmate', relationships: [] },
    ],
    scenes: [{ id: 's1', location: 'Storefront', time: 'Day', source_ranges: [{ start_ms: 0, end_ms: 8_000 }] }],
    props: [],
    shots: [
      {
        id: 'shot-1', index: 1, start_ms: 0, end_ms: 4_000, composition: 'Close-up of Lin Jiang',
        visible_character_ids: ['c1'],
        text_regions: [
          { id: 'txt1', kind: 'subtitle', source_text: '不是哥们你谁啊', polygon: [[0, 0], [1, 0], [1, 1]] },
          { id: 'txt2', kind: 'screen_text', source_text: '南非对墨西哥', polygon: [[0, 0], [1, 0], [1, 1]] },
        ],
      },
      {
        id: 'shot-2', index: 2, start_ms: 4_000, end_ms: 8_000, composition: 'Lu Fei laughs',
        visible_character_ids: ['c2'], text_regions: [],
      },
    ],
  };
}

test('enrichment prompt lists existing ids and only subtitle lines', () => {
  const prompt = buildEnrichmentPrompt(firstPassFacts());
  assert.match(prompt, /"id":"c1","name":"林江"/);
  assert.match(prompt, /"shot_id":"shot-1","region_id":"txt1","text":"不是哥们你谁啊"/);
  assert.doesNotMatch(prompt, /南非对墨西哥/, 'screen text is not a speaker candidate');
});

test('applyEnrichment fills known hints and ignores unknown ids, sizes and speakers', () => {
  const facts = firstPassFacts();
  const merged = applyEnrichment(facts, {
    characters: [{ id: 'c1', appearance: 'Teen boy, slim, short black hair; blue school jacket' }, { id: 'ghost', appearance: 'x' }],
    scenes: [{ id: 's1', visual: 'Warm-lit shop entrance with awning' }],
    shots: [{ id: 'shot-1', shot_size: 'Close-up' }, { id: 'shot-2', shot_size: 'dutch tilt' }],
    subtitle_speakers: [
      { shot_id: 'shot-1', region_id: 'txt1', speaker_id: 'c1' },
      { shot_id: 'shot-1', region_id: 'txt2', speaker_id: 'c1' },
      { shot_id: 'shot-2', region_id: 'txt9', speaker_id: 'ghost' },
    ],
  });
  assert.equal(merged.characters[0].appearance, 'Teen boy, slim, short black hair; blue school jacket');
  assert.equal(merged.characters[1].appearance, undefined);
  assert.equal(merged.characters.length, 2);
  assert.equal(merged.scenes[0].visual, 'Warm-lit shop entrance with awning');
  assert.equal(merged.shots[0].shot_size, 'close-up');
  assert.equal(merged.shots[1].shot_size, undefined, 'unknown shot size is dropped');
  assert.equal(merged.shots[0].text_regions[0].speaker_id, 'c1');
  assert.equal(merged.shots[0].text_regions[1].speaker_id, undefined, 'screen text never gets a speaker');
  assert.equal(facts.characters[0].appearance, undefined, 'input facts are not mutated');
  assert.deepEqual(merged.shots.map((shot) => [shot.start_ms, shot.end_ms]), [[0, 4_000], [4_000, 8_000]]);
});

test('enrichSourceFacts keeps first-pass facts when the second call fails', async () => {
  const facts = firstPassFacts();
  const warnings = [];
  const result = await enrichSourceFacts({
    visionDetailed: async () => { throw Object.assign(new Error('timeout'), { code: 'AI_NON_STREAM_TIMEOUT' }); },
    parseJsonObject: JSON.parse,
    imageSources: [],
    options: { model: 'm', timeout_ms: 1000 },
    log: { warn: (...args) => warnings.push(args) },
  }, facts);
  assert.equal(result.facts, facts);
  assert.deepEqual(result.enrichment, { status: 'failed', error_code: 'AI_NON_STREAM_TIMEOUT' });
  assert.equal(warnings.length, 1);
});

test('enrichSourceFacts sends a small capped request and reports the provider id', async () => {
  const calls = [];
  const result = await enrichSourceFacts({
    visionDetailed: async (payload) => {
      calls.push(payload);
      return { text: JSON.stringify({ shots: [{ id: 'shot-2', shot_size: 'medium' }] }), provider_task_id: 'enrich-1', usage: { total_tokens: 10 } };
    },
    parseJsonObject: JSON.parse,
    imageSources: [{ localAbsPath: 'sheet.jpg' }],
    options: { model: 'm', temperature: 0.1, timeout_ms: 1000 },
  }, firstPassFacts());
  assert.equal(calls[0].options.max_tokens, 6000);
  assert.equal(calls[0].options.timeout_ms, 1000);
  assert.deepEqual(calls[0].imageSources, [{ localAbsPath: 'sheet.jpg' }]);
  assert.equal(result.facts.shots[1].shot_size, 'medium');
  assert.deepEqual(result.enrichment, { status: 'completed', provider_task_id: 'enrich-1', usage: { total_tokens: 10 } });
});
