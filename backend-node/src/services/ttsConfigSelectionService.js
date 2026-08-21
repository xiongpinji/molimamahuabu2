const aiConfigService = require('./aiConfigService');

function resolveTtsModel(config) {
  const configured = config?.default_model
    || (Array.isArray(config?.model) ? config.model[0] : config?.model);
  if (configured && String(configured).trim()) return String(configured).trim();
  const provider = String(config?.provider || '').toLowerCase();
  return provider === 'minimax' ? 'speech-02-hd' : 'tts-1';
}

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

module.exports = { resolveTtsModel, selectTtsConfig };
