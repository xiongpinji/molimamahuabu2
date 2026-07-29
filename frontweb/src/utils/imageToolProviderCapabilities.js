export const IMAGE_TOOL_REFERENCE_CAPABILITY_KEYS = Object.freeze([
  'supports_outpaint',
  'supports_markup_retouch',
  'supports_upscale',
  'supports_detail_enhance',
  'supports_cinematic_relight',
  'supports_panorama',
  'supports_panorama_scene',
  'supports_image_ideation',
  'supports_angle_ideation',
  'supports_character_views',
  'supports_narrative_grid',
  'supports_frame_forward',
  'supports_frame_backward',
])

export function isAuditedImageToolReferenceConfig(config = {}) {
  return config.serviceType === 'storyboard_image'
    && String(config.provider || '').trim().toLowerCase() === 'aihubcc'
    && String(config.protocol || '').trim().toLowerCase() === 'aihubcc'
    && String(config.model || '').trim() === 'gpt-image-2-3.5k'
}

export function applyImageToolReferenceCapabilities(settings, config) {
  const next = { ...(settings || {}) }
  for (const key of IMAGE_TOOL_REFERENCE_CAPABILITY_KEYS) delete next[key]
  if (isAuditedImageToolReferenceConfig(config)) {
    for (const key of IMAGE_TOOL_REFERENCE_CAPABILITY_KEYS) next[key] = true
  }
  return next
}
