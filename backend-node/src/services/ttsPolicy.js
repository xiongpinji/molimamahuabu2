'use strict';

/**
 * 产品决策：默认停用独立 TTS。
 * 一键转绘 / 成片链路改用视频模型原生语音；如需临时恢复，设置 TTS_ENABLED=1。
 */
const TTS_DISABLED_CODE = 'TTS_DISABLED';
const TTS_DISABLED_MESSAGE = 'TTS 已停用：请使用视频模型原生语音能力';

function isTtsEnabled(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.TTS_ENABLED || '').trim());
}

function createTtsDisabledError(message = TTS_DISABLED_MESSAGE) {
  const error = new Error(message);
  error.code = TTS_DISABLED_CODE;
  return error;
}

function assertTtsEnabled(env = process.env) {
  if (!isTtsEnabled(env)) {
    throw createTtsDisabledError();
  }
}

module.exports = {
  TTS_DISABLED_CODE,
  TTS_DISABLED_MESSAGE,
  isTtsEnabled,
  createTtsDisabledError,
  assertTtsEnabled,
};
