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

// 仅记录已经完成真实生成并校验结果文件的 NewAPI 模型能力；
// 这不是对供应商未测试参数的推断。
const NEWAPI_MODEL_CAPABILITIES = Object.freeze({
  'seedance-2.0-fast': Object.freeze({
    validated: true, response_mode: 'async', duration: Object.freeze({ min: 4, max: 15 }),
    ratios: Object.freeze(['16:9', '9:16', '1:1']), resolutions: Object.freeze(['480p', '720p']),
    reference_images_max: 9, reference_videos_max: 3, reference_audios_max: 3,
    audio_mode: 'native_with_reference_audio',
    verified_observation: Object.freeze({ output: '864x496 H264/AAC, 5.04s', latency_seconds: 204 }),
  }),
  'seedance-2.0': Object.freeze({
    validated: true, response_mode: 'async', duration: Object.freeze({ min: 4, max: 15 }),
    ratios: Object.freeze(['16:9', '9:16', '1:1']), resolutions: Object.freeze(['480p', '720p']),
    reference_images_max: 9, reference_videos_max: 3, reference_audios_max: 3,
    audio_mode: 'native_with_reference_audio',
    verified_observation: Object.freeze({ output: '864x496 H264/AAC, 5.04s', latency_seconds: 226 }),
  }),
  'seedance-2.0-mini': Object.freeze({
    validated: true, response_mode: 'async', duration: Object.freeze({ min: 4, max: 15 }),
    ratios: Object.freeze(['16:9', '9:16', '1:1']), resolutions: Object.freeze(['480p', '720p']),
    reference_images_max: 9, reference_videos_max: 3, reference_audios_max: 3,
    audio_mode: 'native_with_reference_audio',
    verified_observation: Object.freeze({ output: '864x496 H264/AAC, 4.04s', latency_seconds: 233 }),
  }),
  'seedance-2.5': Object.freeze({
    validated: true, response_mode: 'async', duration: Object.freeze({ min: 4, max: 15 }),
    ratios: Object.freeze(['16:9', '9:16', '1:1']), resolutions: Object.freeze(['480p', '720p']),
    reference_images_max: 9, reference_videos_max: 3, reference_audios_max: 3,
    audio_mode: 'native_with_reference_audio',
    verified_observation: Object.freeze({ output: '854x480 H264/AAC, 5.04s', latency_seconds: 318 }),
  }),
  minimax_h3_image_audio_to_video_v2: Object.freeze({
    validated: true, response_mode: 'async', duration: Object.freeze({ min: 4, max: 15 }),
    ratios: Object.freeze(['16:9', '9:16', '1:1']), resolutions: Object.freeze(['768p']),
    requires_reference: true, reference_images_max: 9, reference_videos_max: 3, reference_audios_max: 3,
    audio_mode: 'native_with_reference_audio',
    notes: '480p 会被供应商拒绝；至少需要一张参考图或一段参考音频。',
    verified_observation: Object.freeze({ output: '1344x768 H264/AAC, 5.17s', latency_seconds: 153 }),
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
  const enriched = {
    ...config,
    voice_policy: primary?.key || null,
    voice_policy_label: primary?.label || null,
    voice_policy_tone: primary?.tone || 'info',
    voice_policy_description: primary?.description || null,
    voice_policies: voicePolicies,
  };
  if (normalize(config.provider) === 'newapi' || normalize(config.api_protocol) === 'newapi_video') {
    enriched.model_capabilities = Object.fromEntries(
      models
        .map((model) => String(model || '').trim())
        .filter((model) => NEWAPI_MODEL_CAPABILITIES[model])
        .map((model) => [model, NEWAPI_MODEL_CAPABILITIES[model]])
    );
  }
  return enriched;
}

module.exports = {
  POLICIES,
  NEWAPI_MODEL_CAPABILITIES,
  classifyVideoVoicePolicy,
  enrichVideoConfig,
  isSeedance2Model,
  isVeo2Model,
  isVeo3Model,
  policyForConfig,
};
