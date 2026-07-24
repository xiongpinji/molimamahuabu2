export const AIHUBCC_IMAGE_MODELS = [
  'gpt-image-2',
  'gpt-image-2-1k',
  'gpt-image-2-2k',
  'gpt-image-2-3.5k',
  'gemini-image',
  'gemini-image-pro',
  'nano-banana-pro-4K',
  'gemini-3.1-flash-image-landscape',
  'gemini-3.1-flash-image-landscape-2k',
  'gemini-3.1-flash-image-portrait',
  'gemini-3.1-flash-image-portrait-2k',
  'gemini-3.1-flash-image-square',
  'gemini-3.1-flash-image-square-2k',
  'gemini-3.0-pro-image-landscape',
  'gemini-3.0-pro-image-landscape-2k',
  'gemini-3.0-pro-image-portrait',
  'gemini-3.0-pro-image-portrait-2k',
  'gemini-3.0-pro-image-square',
  'gemini-3.0-pro-image-square-2k',
  'imagen-4.0-generate-preview-landscape',
  'imagen-4.0-generate-preview-portrait',
]

export const AIHUBCC_VIDEO_MODELS = [
  'omni-fast',
  'omni-fast-v2v',
  'omni-fast-no-water',
  'omni-fast-v2v-no-water',
  'Seedance-2.0-mini-480p',
  'Seedance-2.0-fast-480p',
  'Seedance-2.0-480p',
  'Seedance-2.0-mini-720p',
  'Seedance-2.0-fast-720p',
  'Seedance-2.0-720p',
  'Seedance-2.0-1080p',
  'Seedance-2.0-4k',
  'grok-imagine-video',
  'grok-imagine-video-1.5-preview',
  'veo_3_1_t2v_fast_landscape_4s',
  'veo_3_1_t2v_fast_landscape_6s',
  'veo_3_1_t2v_fast_portrait_4s',
  'veo_3_1_t2v_fast_portrait_6s',
  'veo_3_1_i2v_s_fast_landscape_4s_fl',
  'veo_3_1_i2v_s_fast_landscape_6s_fl',
  'veo_3_1_i2v_s_fast_portrait_4s_fl',
  'veo_3_1_i2v_s_fast_portrait_6s_fl',
  'veo_3_1_r2v_fast_landscape',
  'veo_3_1_r2v_fast_portrait',
]

export const AIHUBCC_VIDEO_POSTPROCESS_MODELS = ['veo-clean']

export function isAihubccFlowImageModel(model) {
  const name = String(model || '').trim().toLowerCase()
  return /^gemini-3\.[01]-(?:pro|flash)-image-/.test(name)
    || /^imagen-4\.0-generate-preview-/.test(name)
}
