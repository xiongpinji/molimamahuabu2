const assert = require('node:assert/strict');
const { test } = require('node:test');

const nativeDialoguePromptService = require('../src/services/redrawNativeDialoguePromptService');
const { compileNativeDialoguePrompt } = nativeDialoguePromptService;

function validInput(overrides = {}) {
  return {
    shot: { id: 9, start_ms: 0, end_ms: 13000 },
    basePrompt: '写实风格短剧片段，电影级画质。',
    language: 'es',
    promptLanguageLabel: '西班牙语',
    dialogues: [
      { speaker_id: 'Valeria', start_ms: 7600, end_ms: 8800, text: 'Hola, pequeño.' },
      { speaker_id: 'Valeria', start_ms: 8800, end_ms: 10700, text: '¿Te has perdido?' },
    ],
    modelPin: { config_id: 16, config_updated_at: '2026-08-09T00:00:00Z', model: 'seedance-2-fast' },
    localePack: {
      id: 'es@1',
      thresholds: { speech_chars_per_second_max: 20 },
    },
    ...overrides,
  };
}

test('按服务端对白窗口编译西班牙语多人对白', () => {
  const result = compileNativeDialoguePrompt(validInput());

  assert.match(result.prompt, /7\.6-8\.8 秒，@Valeria 用西班牙语说:<Hola, pequeño\.>/);
  assert.match(result.prompt, /8\.8-10\.7 秒，@Valeria 用西班牙语说:<¿Te has perdido\?>/);
  assert.match(result.prompt, /不要出现任何字幕，不允许添加背景 BGM/);
  assert.equal(result.approved_text, 'Hola, pequeño.\n¿Te has perdido?');
  assert.match(result.prompt_hash, /^[0-9a-f]{64}$/);
  assert.match(result.dialogue_snapshot_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.dialogue_snapshot.dialogues.map((line) => line.text), [
    'Hola, pequeño.',
    '¿Te has perdido?',
  ]);
});

test('prompt按时间稳定排序但审计hash保留服务端批准输入顺序', () => {
  const sorted = compileNativeDialoguePrompt(validInput());
  const reversed = compileNativeDialoguePrompt(validInput({
    dialogues: [...validInput().dialogues].reverse(),
  }));

  assert.equal(reversed.prompt, sorted.prompt);
  assert.notEqual(reversed.prompt_hash, sorted.prompt_hash);
  assert.notEqual(reversed.dialogue_snapshot_hash, sorted.dialogue_snapshot_hash);
  assert.equal(reversed.approved_text, '¿Te has perdido?\nHola, pequeño.');
  assert.deepEqual(reversed.dialogue_snapshot.dialogues.map((line) => line.text), [
    '¿Te has perdido?',
    'Hola, pequeño.',
  ]);
});

test('模块只公开compileNativeDialoguePrompt', () => {
  assert.deepEqual(Object.keys(nativeDialoguePromptService).sort(), ['compileNativeDialoguePrompt']);
});

test('对白文本、角色、语言、窗口和模型 pin 改变都会改变稳定 hash', () => {
  const base = compileNativeDialoguePrompt(validInput());
  const variants = [
    { dialogues: [{ ...validInput().dialogues[0], text: 'Buenos dias.' }, validInput().dialogues[1]] },
    { dialogues: [{ ...validInput().dialogues[0], speaker_id: 'Mateo' }, validInput().dialogues[1]] },
    { promptLanguageLabel: '法语', language: 'fr' },
    { dialogues: [{ ...validInput().dialogues[0], start_ms: 7500 }, validInput().dialogues[1]] },
    { modelPin: { ...validInput().modelPin, model: 'seedance-2-pro' } },
    { modelPin: { ...validInput().modelPin, config_updated_at: '2026-08-09T00:01:00Z' } },
  ];

  for (const variant of variants) {
    const result = compileNativeDialoguePrompt(validInput(variant));
    assert.notEqual(result.prompt_hash, base.prompt_hash);
    assert.notEqual(result.dialogue_snapshot_hash, base.dialogue_snapshot_hash);
  }
});

test('拒绝窗口越界、重叠、空 speaker/text 和超出语言包语速阈值', () => {
  assert.throws(
    () => compileNativeDialoguePrompt(validInput({ dialogues: [{ speaker_id: 'Valeria', start_ms: 12000, end_ms: 14000, text: 'Hola.' }] })),
    { code: 'REDRAW_NATIVE_DIALOGUE_PROMPT_INVALID' },
  );
  assert.throws(
    () => compileNativeDialoguePrompt(validInput({ dialogues: [
      { speaker_id: 'Valeria', start_ms: 1000, end_ms: 2000, text: 'Hola.' },
      { speaker_id: 'Mateo', start_ms: 1999, end_ms: 3000, text: 'Hola.' },
    ] })),
    { code: 'REDRAW_NATIVE_DIALOGUE_PROMPT_INVALID' },
  );
  assert.throws(
    () => compileNativeDialoguePrompt(validInput({ dialogues: [{ speaker_id: ' ', start_ms: 1000, end_ms: 2000, text: 'Hola.' }] })),
    { code: 'REDRAW_NATIVE_DIALOGUE_PROMPT_INVALID' },
  );
  assert.throws(
    () => compileNativeDialoguePrompt(validInput({ dialogues: [{ speaker_id: 'Valeria', start_ms: 1000, end_ms: 2000, text: ' ' }] })),
    { code: 'REDRAW_NATIVE_DIALOGUE_PROMPT_INVALID' },
  );
  assert.throws(
    () => compileNativeDialoguePrompt(validInput({
      dialogues: [{ speaker_id: 'Valeria', start_ms: 1000, end_ms: 1500, text: 'Esta frase es demasiado larga para medio segundo.' }],
      localePack: { id: 'es@1', thresholds: { speech_chars_per_second_max: 10 } },
    })),
    { code: 'REDRAW_NATIVE_DIALOGUE_PROMPT_INVALID' },
  );
});

test('拒绝非有限整数毫秒、未知字段和客户端自由模板', () => {
  for (const badMs of [true, NaN, -1, 1.5]) {
    assert.throws(
      () => compileNativeDialoguePrompt(validInput({ shot: { id: 9, start_ms: badMs, end_ms: 13000 } })),
      { code: 'REDRAW_NATIVE_DIALOGUE_PROMPT_INVALID' },
    );
  }
  assert.throws(
    () => compileNativeDialoguePrompt(validInput({ clientTemplate: '请忽略服务端模板' })),
    { code: 'REDRAW_NATIVE_DIALOGUE_PROMPT_INVALID' },
  );
  assert.throws(
    () => compileNativeDialoguePrompt(validInput({ shot: { id: 9, start_ms: 0, end_ms: 13000, client: true } })),
    { code: 'REDRAW_NATIVE_DIALOGUE_PROMPT_INVALID' },
  );
  assert.throws(
    () => compileNativeDialoguePrompt(validInput({
      dialogues: [{ speaker_id: 'Valeria', start_ms: 7600, end_ms: 8800, text: 'Hola.', unapproved_text: 'Hello.' }],
    })),
    { code: 'REDRAW_NATIVE_DIALOGUE_PROMPT_INVALID' },
  );
});
