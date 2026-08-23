/**
 * 视频模型的角色声音能力分级。
 *
 * 这是路由策略，不是对供应商效果的承诺：
 * - reference_audio：可以把角色参考音频作为模型输入；
 * - native_audio_prompt：模型生成原生音频，使用文字提示约束角色声线；
 * - silent：模型本身不生成音频，必须走后期 TTS/混音。
 */

const POLICIES = Object.freeze({
  reference_audio: Object.freeze({
    key: 'reference_audio',
    label: '参考音频',
    tone: 'success',
    description: '优先使用分镜锁定的角色参考音频。',
  }),
  native_audio_prompt: Object.freeze({
    key: 'native_audio_prompt',
    label: '文字声线提示',
    tone: 'warning',
    description: '模型生成原生音频，使用角色级文字锚点保持声线；不等同于音色克隆。',
  }),
  silent: Object.freeze({
    key: 'silent',
    label: '静音后期配音',
    tone: 'info',
    description: '模型不生成原生音频，需使用 TTS 或后期混音。',
  }),
});

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function isSeedance2Model(model) {
  return /seedance[\s._-]*2(?:[\s._-]*0)?/i.test(String(model || ''));
}

function isVeo2Model(model) {
  return /veo[\s._-]*2(?:[\s._-]*0)?(?:[\s._-]|$)/i.test(String(model || ''));
}

function isVeo3Model(model) {
  return /veo[\s._-]*3(?:[\s._-]*[01])?(?:[\s._-]|$)/i.test(String(model || ''));
}

function classifyVideoVoicePolicy({ protocol, provider, model } = {}) {
  const p = normalize(protocol);
  const vendor = normalize(provider);
  const m = normalize(model);

  if (isSeedance2Model(m)) return POLICIES.reference_audio;
  if (p === 'veo2' || isVeo2Model(m)) return POLICIES.silent;

  // Veo 3/3.1、Grok 视频的音频由模型原生生成；其余未明确支持参考音频的
  // 模型也沿用当前后端文字锚点回退策略，但 UI 会明确标注“非克隆”。
  if (p === 'veo3' || isVeo3Model(m) || p.includes('deepwl_grok') || /grok.*video/i.test(m)) {
    return POLICIES.native_audio_prompt;
  }
  if (vendor === 'gemini' || vendor === 'google') return POLICIES.native_audio_prompt;
  return POLICIES.native_audio_prompt;
}

function policyForConfig(config = {}) {
  const models = Array.isArray(config.model)
    ? config.model
    : config.model != null
      ? [config.model]
      : [];
  const candidates = models.length ? models : [config.default_model];
  const policies = candidates
    .map((model) => String(model || '').trim())
    .filter(Boolean)
    .map((model) => ({
      model,
      ...classifyVideoVoicePolicy({
        protocol: config.api_protocol,
        provider: config.provider,
        model,
      }),
    }));
  const defaultModel = String(config.default_model || '').trim();
  return policies.find((item) => item.model === defaultModel) || policies[0] || null;
}

function enrichVideoConfig(config = {}) {
  const models = Array.isArray(config.model)
    ? config.model
    : config.model != null
      ? [config.model]
      : [];
  const voicePolicies = models.map((model) => ({
    model: String(model || '').trim(),
    ...classifyVideoVoicePolicy({
      protocol: config.api_protocol,
      provider: config.provider,
      model,
    }),
  })).filter((item) => item.model);
  const primary = policyForConfig(config);
  return {
    ...config,
    voice_policy: primary?.key || null,
    voice_policy_label: primary?.label || null,
    voice_policy_tone: primary?.tone || 'info',
    voice_policy_description: primary?.description || null,
    voice_policies: voicePolicies,
  };
}

module.exports = {
  POLICIES,
  classifyVideoVoicePolicy,
  enrichVideoConfig,
  isSeedance2Model,
  isVeo2Model,
  isVeo3Model,
  policyForConfig,
};
