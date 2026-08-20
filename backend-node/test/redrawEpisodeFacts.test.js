const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeEpisodeFactsV2 } = require('../src/services/redrawEpisodeFactsService');

function genericThreeShotFacts() {
  return {
    schema_version: '2.0',
    duration_ms: 12_300,
    story: ['雨夜订单暴露旧案'],
    characters: [
      { id: 'c1', source_name: '乔安', display_name: '乔安', relationship: '骑手' },
      { id: 'c2', source_name: '陆沉', display_name: '陆沉', relationship: '客户' },
    ],
    scenes: [{ id: 's1', location: '便利店门口', time: '雨夜', source_ranges: [{ start_ms: 0, end_ms: 12_300 }] }],
    props: [{ id: 'p1', name: '密封餐袋', evidence_ranges: [{ start_ms: 1_800, end_ms: 4_500 }] }],
    shots: [
      {
        id: 'shot-a',
        index: 1,
        start_ms: 0,
        end_ms: 4_100,
        composition: '半身跟拍，乔安从便利店门口冲进雨幕',
        camera_movement: '轻微手持前推',
        opening_state: '乔安扣紧雨衣帽檐',
        continuous_action: '她把密封餐袋护在胸前跑向路边',
        ending_state: '她停在黑色轿车旁',
        visible_character_ids: ['c1'],
        dialogue: [{
          id: 't1',
          speaker_id: 'c1',
          start_ms: 900,
          end_ms: 2_200,
          source_text: '尾号八七的订单到了',
        }],
        text_regions: [{
          id: 'txt1',
          kind: 'subtitle',
          source_text: '订单超时 00:31',
          polygon: [[0.22, 0.82], [0.78, 0.82], [0.78, 0.91], [0.22, 0.91]],
        }],
        audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
        confidence: { character_mapping: 0.86, speaker_mapping: 0.74, text_regions: 0.91, shot_boundary: 0.88 },
      },
      {
        id: 'shot-b',
        index: 2,
        start_ms: 4_100,
        end_ms: 8_000,
        composition: '车窗反射中陆沉抬眼看向乔安',
        camera_movement: '定机位微抖',
        opening_state: '车窗缓慢下降',
        continuous_action: '陆沉接过餐袋并露出戒指',
        ending_state: '乔安认出戒指后后退半步',
        visible_character_ids: ['c1', 'c2'],
        dialogue: [{
          id: 't2',
          speaker_id: 'c2',
          start_ms: 5_000,
          end_ms: 6_200,
          source_text: '你终于来了',
        }],
        text_regions: [],
        audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
        confidence: { character_mapping: 0.8, speaker_mapping: 0.63, text_regions: 0.7, shot_boundary: 0.84 },
      },
      {
        id: 'shot-c',
        index: 3,
        start_ms: 8_000,
        end_ms: 12_300,
        composition: '雨水落在餐袋封条特写',
        camera_movement: '缓慢下摇',
        opening_state: '封条上的旧案编号被雨水浸湿',
        continuous_action: '乔安伸手挡住编号',
        ending_state: '编号露出最后两位',
        visible_character_ids: ['c1'],
        dialogue: [],
        text_regions: [],
        audio_contract: { dialogue_mode: 'silent', ambient_audio: 'preserve_or_rebuild' },
        confidence: { character_mapping: 0.79, speaker_mapping: 0.2, text_regions: 0.61, shot_boundary: 0.82 },
      },
    ],
    causal_chain: ['超时订单让乔安遇见陆沉', '陆沉戒指连接旧案编号'],
    locked_facts: ['乔安在雨夜送达密封餐袋', '陆沉在黑色轿车内等待'],
    reversals: ['订单客户知道乔安会来'],
    episode_hook: '餐袋封条出现旧案编号',
  };
}

function invalid(mutator) {
  const raw = genericThreeShotFacts();
  mutator(raw);
  return raw;
}

test('v2 事实连续覆盖整集并绑定人物、说话人、文字和环境声', () => {
  const facts = normalizeEpisodeFactsV2(genericThreeShotFacts());
  assert.equal(facts.schema_version, '2.0');
  assert.deepEqual(facts.shots.map((shot) => shot.index), [1, 2, 3]);
  assert.equal(facts.shots[2].audio_contract.dialogue_mode, 'silent');
  assert.equal(facts.shots[0].dialogue[0].speaker_id, 'c1');
  assert.match(facts.facts_hash, /^[a-f0-9]{64}$/);
});

test('v2 facts hash is canonical, semantic and input-safe', () => {
  const raw = genericThreeShotFacts();
  raw.scenes[0].source_ranges = [
    { start_ms: 0, end_ms: 6_000 },
    { start_ms: 6_000, end_ms: 12_300 },
  ];
  raw.props[0].evidence_ranges = [
    { start_ms: 1_800, end_ms: 3_000 },
    { start_ms: 3_000, end_ms: 4_500 },
  ];
  const before = JSON.stringify(raw);
  const first = normalizeEpisodeFactsV2(raw);
  const reordered = genericThreeShotFacts();
  reordered.characters.reverse();
  reordered.shots[1].visible_character_ids.reverse();
  reordered.scenes[0].source_ranges = [
    { start_ms: 6_000, end_ms: 12_300 },
    { start_ms: 0, end_ms: 6_000 },
  ];
  reordered.props[0].evidence_ranges = [
    { start_ms: 3_000, end_ms: 4_500 },
    { start_ms: 1_800, end_ms: 3_000 },
  ];
  const second = normalizeEpisodeFactsV2(reordered);
  const changed = genericThreeShotFacts();
  changed.shots[0].continuous_action = '她停下检查密封餐袋';
  assert.equal(JSON.stringify(raw), before);
  assert.equal(first.facts_hash, second.facts_hash);
  assert.notEqual(first.facts_hash, normalizeEpisodeFactsV2(changed).facts_hash);
});

test('v2 rejects inherited enumerable keys while accepting null-prototype plain data', () => {
  const nullProto = Object.assign(Object.create(null), genericThreeShotFacts());
  assert.equal(normalizeEpisodeFactsV2(nullProto).schema_version, '2.0');

  Object.defineProperty(Object.prototype, 'model', {
    value: 'leaked-model',
    enumerable: true,
    configurable: true,
  });
  try {
    assert.throws(() => normalizeEpisodeFactsV2(genericThreeShotFacts()), /继承字段|model/);

    const inheritedTop = Object.create({ model: 'x' });
    Object.assign(inheritedTop, genericThreeShotFacts());
    assert.throws(() => normalizeEpisodeFactsV2(inheritedTop), /继承字段|model/);

    assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => {
      const inheritedShot = Object.create({ model: 'x' });
      Object.assign(inheritedShot, raw.shots[0]);
      raw.shots[0] = inheritedShot;
    })), /继承字段|model/);
  } finally {
    delete Object.prototype.model;
  }
});

test('v2 rejects unsafe or non-contract top-level data', () => {
  assert.throws(() => normalizeEpisodeFactsV2({ ...genericThreeShotFacts(), schema_version: '1.0' }), /schema_version/);
  assert.throws(() => normalizeEpisodeFactsV2({ ...genericThreeShotFacts(), duration_ms: 0 }), /duration_ms/);
  assert.throws(() => normalizeEpisodeFactsV2({ ...genericThreeShotFacts(), raw_prompt: 'describe everything' }), /未知字段|危险字段/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.characters[0].avatar_url = 'https://example.test/a.png'; })), /未知字段|危险字段/);
  const inherited = Object.create({ leaked: true });
  Object.assign(inherited, genericThreeShotFacts());
  assert.throws(() => normalizeEpisodeFactsV2(inherited), /继承字段/);
});

test('v2 rejects incomplete or inconsistent shot timelines and identities', () => {
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].start_ms = 100; })), /0|连续|覆盖/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[1].start_ms = 4_200; })), /gap|连续|覆盖/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[1].start_ms = 4_000; })), /重叠|连续/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[2].end_ms = 12_000; })), /duration|覆盖/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[1].index = 3; })), /index|连续/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[1].id = 'shot-a'; })), /重复|id/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.characters[1].id = 'c1'; })), /重复|characters/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].visible_character_ids.push('c1'); })), /重复|visible_character_ids/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].visible_character_ids = ['c9']; })), /未知角色/);
});

test('v2 rejects dialogue, audio, text region, confidence and required shot field violations', () => {
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].dialogue[0].speaker_id = 'c2'; })), /speaker|可见/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].dialogue[0].end_ms = 4_500; })), /dialogue|时间/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[1].dialogue[0].id = 't1'; })), /turn|重复|dialogue/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].dialogue = []; })), /spoken|dialogue/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[2].dialogue.push({ id: 't3', speaker_id: 'c1', start_ms: 8_200, end_ms: 8_900, source_text: '别动' }); })), /silent|dialogue/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].text_regions[0].polygon = [[0, 0], [0.5, 0.5]]; })), /polygon/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].text_regions[0].polygon = [[0, 0], [1.2, 0], [0, 1]]; })), /polygon|坐标/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].text_regions[0].polygon = [[0, 0], [0.5, 0.5], [1, 1]]; })), /polygon|面积/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].text_regions.push({ ...raw.shots[0].text_regions[0] }); })), /text_regions|重复/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].text_regions[0].kind = 'model_note'; })), /kind/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].composition = ''; })), /composition/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].camera_movement = 'C:\\\\secret\\\\clip.mp4'; })), /危险|路径|URL/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].audio_contract.ambient_audio = 'keep_original'; })), /ambient_audio/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].confidence.speaker_mapping = Number.NaN; })), /confidence/);
  assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].confidence.text_regions = 1.2; })), /confidence/);
});

test('v2 rejects non-string narrative arrays and dangerous file path text', () => {
  for (const value of [{ text: '解释' }, ['解释'], () => '解释']) {
    assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.story = [value]; })), /story|文本|string/);
    assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.causal_chain = [value]; })), /causal_chain|文本|string/);
    assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.characters[0].relationships = [value]; })), /relationships|文本|string/);
  }

  for (const value of [
    'uploads/private/frame.png',
    './x.jpg',
    '../x',
    'folder\\x',
    'C:\\x',
    '\\\\server\\share\\x.png',
    'file:///tmp/x.png',
    'http://example.test/x.png',
    'scene/output/video.webm',
  ]) {
    assert.throws(() => normalizeEpisodeFactsV2(invalid((raw) => { raw.shots[0].composition = value; })), /危险|路径|URL/);
  }

  const ordinarySlash = normalizeEpisodeFactsV2(invalid((raw) => {
    raw.shots[0].composition = '乔安在门口决定进/退';
  }));
  assert.equal(ordinarySlash.shots[0].composition, '乔安在门口决定进/退');
});

module.exports = { genericThreeShotFacts };
