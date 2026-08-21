'use strict';

const { createHash } = require('node:crypto');
const { stableStringify } = require('./redrawAnalysisService');

const TOP_LEVEL_FIELDS = [
  'basePrompt',
  'dialogues',
  'language',
  'localePack',
  'modelPin',
  'promptLanguageLabel',
  'shot',
];
const SHOT_FIELDS = ['end_ms', 'id', 'start_ms'];
const DIALOGUE_FIELDS = ['end_ms', 'speaker_id', 'start_ms', 'text'];
const MODEL_PIN_FIELDS = ['config_id', 'config_updated_at', 'model'];
const LOCALE_PACK_FIELDS = [
  'calibration_manifest_sha256',
  'id',
  'language',
  'locale',
  'model_manifest_sha256',
  'prompt_language_label',
  'scope',
  'thresholds',
];
const THRESHOLD_FIELDS = [
  'dialogue_similarity_min',
  'language_probability_min',
  'speech_chars_per_second_max',
];

function compileNativeDialoguePrompt(input) {
  assertPlainObject(input, 'input');
  assertAllowedFields(input, TOP_LEVEL_FIELDS, 'input');

  const shot = normalizeShot(input.shot);
  const modelPin = normalizeModelPin(input.modelPin);
  const localePack = normalizeLocalePack(input.localePack);
  const language = languageCode(input.language, 'language', localePack.language);
  const promptLanguageLabel = promptSafeString(input.promptLanguageLabel, 'promptLanguageLabel');
  const basePrompt = promptSafeString(input.basePrompt, 'basePrompt');
  const dialogues = normalizeDialogues(input.dialogues, shot, localePack.thresholds.speech_chars_per_second_max);

  const approvedText = dialogues.map((line) => line.text).join('\n');
  const dialogueSnapshot = {
    schema_version: 'redraw-native-dialogue-prompt-v1',
    shot,
    language,
    prompt_language_label: promptLanguageLabel,
    locale_pack: {
      id: localePack.id,
      speech_chars_per_second_max: localePack.thresholds.speech_chars_per_second_max,
    },
    model_pin: modelPin,
    dialogues,
    approved_text: approvedText,
  };
  const dialogueSnapshotHash = sha256(stableStringify(dialogueSnapshot));
  const prompt = buildPrompt({
    basePrompt,
    language,
    promptLanguageLabel,
    dialogues: sortDialoguesForPrompt(dialogues),
  });
  const promptHash = sha256(stableStringify({
    prompt,
    dialogue_snapshot_hash: dialogueSnapshotHash,
  }));

  return {
    prompt,
    prompt_hash: promptHash,
    approved_text: approvedText,
    dialogue_snapshot: dialogueSnapshot,
    dialogue_snapshot_hash: dialogueSnapshotHash,
  };
}

function normalizeShot(shot) {
  assertPlainObject(shot, 'shot');
  assertAllowedFields(shot, SHOT_FIELDS, 'shot');
  const id = assertId(shot.id, 'shot.id');
  const startMs = integerMs(shot.start_ms, 'shot.start_ms');
  const endMs = integerMs(shot.end_ms, 'shot.end_ms');
  if (endMs <= startMs) fail('shot window invalid');
  return { id, start_ms: startMs, end_ms: endMs };
}

function normalizeModelPin(modelPin) {
  assertPlainObject(modelPin, 'modelPin');
  assertAllowedFields(modelPin, MODEL_PIN_FIELDS, 'modelPin');
  const configId = modelPin.config_id;
  if (!Number.isSafeInteger(configId) || configId <= 0) fail('modelPin.config_id invalid');
  return {
    config_id: configId,
    config_updated_at: nonEmptyString(modelPin.config_updated_at, 'modelPin.config_updated_at'),
    model: nonEmptyString(modelPin.model, 'modelPin.model'),
  };
}

function normalizeLocalePack(localePack) {
  assertPlainObject(localePack, 'localePack');
  assertAllowedFields(localePack, LOCALE_PACK_FIELDS, 'localePack');
  assertPlainObject(localePack.thresholds, 'localePack.thresholds');
  assertAllowedFields(localePack.thresholds, THRESHOLD_FIELDS, 'localePack.thresholds');
  const max = localePack.thresholds.speech_chars_per_second_max;
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) {
    fail('localePack.thresholds.speech_chars_per_second_max invalid');
  }
  return {
    id: nonEmptyString(localePack.id, 'localePack.id'),
    language: languageCode(localePack.language, 'localePack.language'),
    thresholds: {
      speech_chars_per_second_max: max,
    },
  };
}

function normalizeDialogues(dialogues, shot, maxCharsPerSecond) {
  if (!Array.isArray(dialogues) || dialogues.length === 0) fail('dialogues invalid');
  const normalized = dialogues.map((dialogue, index) => normalizeDialogue(dialogue, index, shot, maxCharsPerSecond));
  const ordered = sortDialoguesForPrompt(normalized);

  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start_ms < ordered[index - 1].end_ms) {
      fail('dialogue windows overlap');
    }
  }
  return normalized;
}

function sortDialoguesForPrompt(dialogues) {
  return [...dialogues].sort((left, right) => left.start_ms - right.start_ms
    || left.end_ms - right.end_ms
    || left.speaker_id.localeCompare(right.speaker_id)
    || left.text.localeCompare(right.text));
}

function normalizeDialogue(dialogue, index, shot, maxCharsPerSecond) {
  const label = `dialogues[${index}]`;
  assertPlainObject(dialogue, label);
  assertAllowedFields(dialogue, DIALOGUE_FIELDS, label);
  const startMs = integerMs(dialogue.start_ms, `${label}.start_ms`);
  const endMs = integerMs(dialogue.end_ms, `${label}.end_ms`);
  if (endMs <= startMs || startMs < shot.start_ms || endMs > shot.end_ms) {
    fail(`${label} window invalid`);
  }
  const speakerId = promptSafeString(dialogue.speaker_id, `${label}.speaker_id`);
  const text = promptSafeString(dialogue.text, `${label}.text`);
  const durationSeconds = (endMs - startMs) / 1000;
  const charsPerSecond = Array.from(text).length / durationSeconds;
  if (charsPerSecond > maxCharsPerSecond) {
    fail(`${label} speech rate exceeds pack threshold`);
  }
  return {
    speaker_id: speakerId,
    start_ms: startMs,
    end_ms: endMs,
    text,
  };
}

function buildPrompt({ basePrompt, language, promptLanguageLabel, dialogues }) {
  const lines = [
    basePrompt,
    `目标对白语言：${promptLanguageLabel}（${language}）。`,
    '生成画面、环境声和角色口型同步的原生对白音轨。不要出现任何字幕，不允许添加背景 BGM。',
    '只使用以下已批准对白，不得添加、改写或翻译为其他文本：',
    ...dialogues.map((line) => `${formatSeconds(line.start_ms)}-${formatSeconds(line.end_ms)} 秒，@${line.speaker_id} 用${promptLanguageLabel}说:<${line.text}>`),
  ];
  return lines.join('\n');
}

function formatSeconds(ms) {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function integerMs(value, name) {
  if (typeof value === 'boolean' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${name} invalid`);
  }
  return value;
}

function assertId(value, name) {
  if (typeof value === 'boolean' || value == null || String(value).trim() === '') {
    fail(`${name} invalid`);
  }
  return typeof value === 'number' ? value : String(value);
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${name} invalid`);
  }
  return value.trim();
}

function promptSafeString(value, name) {
  const text = nonEmptyString(value, name);
  if (/[\u0000-\u001F\u007F<>]/.test(text)) {
    fail(`${name} invalid`);
  }
  return text;
}

function languageCode(value, name, expected = null) {
  const code = nonEmptyString(value, name);
  if (!/^[a-z]{2,8}$/.test(code) || (expected && code !== expected)) {
    fail(`${name} invalid`);
  }
  return code;
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${name} must be object`);
  }
}

function assertAllowedFields(value, allowed, name) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${name}.${key} unknown`);
  }
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function fail(message) {
  const error = new Error(message);
  error.code = 'REDRAW_NATIVE_DIALOGUE_PROMPT_INVALID';
  throw error;
}

module.exports = {
  compileNativeDialoguePrompt,
};
