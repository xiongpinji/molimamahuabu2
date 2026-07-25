const aiConfigService = require('./aiConfigService');

function selectTtsConfig(db, requestedModel) {
  const model = String(requestedModel || '').trim();
  const active = aiConfigService.listConfigs(db, 'tts').filter((item) => item.is_active);
  const config = model
    ? active.find((item) => item.default_model === model || item.model?.includes(model))
    : active.find((item) => item.is_default) || active[0];
  if (!config) {
    const error = new Error(model
      ? `未找到已启用的 TTS 模型：${model}`
      : '未配置已启用的 TTS 模型');
    error.code = 'TTS_MODEL_NOT_CONFIGURED';
    throw error;
  }
  return model ? { ...config, default_model: model } : config;
}

module.exports = { selectTtsConfig };
