export const VIDEO_DURATION_OPTIONS = Object.freeze(
  Array.from({ length: 11 }, (_, index) => index + 5),
)
const USMERCARI_VIDEO_DURATION_OPTIONS = Object.freeze(
  Array.from({ length: 12 }, (_, index) => index + 4),
)

const USMERCARI_VIDEO_MODELS = new Set(['MiniMax H3', 'seedance-2.0-fast', 'seedance-2.0-mini'])

export function videoDurationOptionsForModel(model, declaredOptions = VIDEO_DURATION_OPTIONS) {
  if (USMERCARI_VIDEO_MODELS.has(String(model || '').trim())) return USMERCARI_VIDEO_DURATION_OPTIONS
  return Array.isArray(declaredOptions) && declaredOptions.length ? declaredOptions : VIDEO_DURATION_OPTIONS
}

function parseSettings(settings) {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) return settings
  try {
    const parsed = JSON.parse(settings || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_) {
    return {}
  }
}

export function readVideoDurationSetting(settings, model = '') {
  const options = videoDurationOptionsForModel(model)
  const duration = Number(parseSettings(settings).video_duration)
  return options.includes(duration) ? duration : 5
}

export function mergeVideoDurationSetting(settings, duration, model = '') {
  const options = videoDurationOptionsForModel(model)
  const value = Number(duration)
  return {
    ...parseSettings(settings),
    video_duration: options.includes(value) ? value : 5,
  }
}
