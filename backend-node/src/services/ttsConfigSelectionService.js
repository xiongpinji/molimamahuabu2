const aiConfigService = require('./aiConfigService');

function selectTtsConfig(db, requestedModel) {
  const model = String(requestedModel || '').trim();
  if (!model) return null;

  const config = aiConfigService.listConfigs(db, 'tts')
    .filter((item) => item.is_active)
    .find((item) => item.default_model === model || item.model?.includes(model));
  if (!config) {
    const error = new Error(`未找到已启用的 TTS 模型：${model}`);
    error.code = 'TTS_MODEL_NOT_CONFIGURED';
    throw error;
  }
  return { ...config, default_model: model };
}

module.exports = { selectTtsConfig };
