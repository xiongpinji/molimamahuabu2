export const IMAGE_TOOL_REFERENCE_CAPABILITY_KEYS = Object.freeze([
  'supports_outpaint',
  'supports_markup_retouch',
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

export function isAuditedSeedream45ReferenceConfig(config = {}) {
  const model = String(config.model || '').trim()
  return config.serviceType === 'storyboard_image'
    && String(config.provider || '').trim().toLowerCase() === 'volcengine'
    && String(config.protocol || '').trim().toLowerCase() === 'volcengine'
    && /^doubao-seedream-4-5(?:-\d+)?$/.test(model)
}

export function applyImageToolReferenceCapabilities(settings, config) {
  const next = { ...(settings || {}) }
  for (const key of IMAGE_TOOL_REFERENCE_CAPABILITY_KEYS) delete next[key]
  if (isAuditedSeedream45ReferenceConfig(config)) {
    for (const key of IMAGE_TOOL_REFERENCE_CAPABILITY_KEYS) next[key] = true
  }
  return next
}
