const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectActiveCharacterVoiceRefs,
  selectStableCharacterVoiceRef,
  selectStoryboardCharacterVoiceRef,
} = require('../src/services/videoClient');

function fakeDb(rows) {
  return {
    prepare(sql) {
      assert.match(sql, /seedance2_voice_asset/);
      return { all: () => rows };
    },
  };
}

function storyboardDb(rows, characters, dialogue = '') {
  return {
    prepare(sql) {
      if (/seedance2_voice_asset/.test(sql)) return { all: () => rows };
      if (/SELECT characters, dialogue FROM storyboards/.test(sql)) return { get: () => ({ characters, dialogue }) };
      if (/SELECT id, name FROM characters/.test(sql)) return { all: () => [
        { id: 4, name: '林岚' },
        { id: 12, name: '小狐狸' },
      ] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

test('Seedance 2.0 音色参考按角色 ID 固定排序，分镜不会因角色列表变化而换音色', () => {
  const db = fakeDb([
    { id: 12, seedance2_voice_asset: JSON.stringify({ status: 'active', url: 'https://cdn.example/voice-b.mp3' }) },
    { id: 4, seedance2_voice_asset: JSON.stringify({ status: 'active', url: 'https://cdn.example/voice-a.mp3' }) },
    { id: 19, seedance2_voice_asset: JSON.stringify({ status: 'stale', url: 'https://cdn.example/voice-c.mp3' }) },
  ]);

  const refs = collectActiveCharacterVoiceRefs(db, 99);
  assert.deepEqual([...refs.keys()], [4, 12]);
  assert.equal(selectStableCharacterVoiceRef(db, 99), 'https://cdn.example/voice-a.mp3');
  assert.equal(selectStableCharacterVoiceRef(db, 99), 'https://cdn.example/voice-a.mp3');
});

test('没有 active 音色参考时不伪造音频 URL', () => {
  const db = fakeDb([
    { id: 1, seedance2_voice_asset: JSON.stringify({ status: 'stale', url: 'https://cdn.example/old.mp3' }) },
  ]);
  assert.equal(selectStableCharacterVoiceRef(db, 99), null);
});

test('分镜有角色音色时优先使用当前分镜角色，缺失时回退本剧固定音色', () => {
  const rows = [
    { id: 12, seedance2_voice_asset: JSON.stringify({ status: 'active', url: 'https://cdn.example/voice-b.mp3' }) },
    { id: 4, seedance2_voice_asset: JSON.stringify({ status: 'active', url: 'https://cdn.example/voice-a.mp3' }) },
  ];
  assert.equal(
    selectStoryboardCharacterVoiceRef(storyboardDb(rows, JSON.stringify([12, 4])), 99, 7),
    'https://cdn.example/voice-b.mp3'
  );
  assert.equal(
    selectStoryboardCharacterVoiceRef(storyboardDb(rows, JSON.stringify([19])), 99, 7),
    'https://cdn.example/voice-a.mp3'
  );
});

test('同一分镜有多个角色时，按对白最先说话角色选择音色', () => {
  const rows = [
    { id: 12, seedance2_voice_asset: JSON.stringify({ status: 'active', url: 'https://cdn.example/fox.mp3' }) },
    { id: 4, seedance2_voice_asset: JSON.stringify({ status: 'active', url: 'https://cdn.example/linlan.mp3' }) },
  ];
  assert.equal(
    selectStoryboardCharacterVoiceRef(
      storyboardDb(rows, JSON.stringify([4, 12]), '小狐狸：森林知道。 / 林岚：你怎么知道？'),
      99,
      7
    ),
    'https://cdn.example/fox.mp3'
  );
});
