export const VIDEO_DURATION_OPTIONS = Object.freeze(
  Array.from({ length: 11 }, (_, index) => index + 5),
)

function parseSettings(settings) {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) return settings
  try {
    const parsed = JSON.parse(settings || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_) {
    return {}
  }
}

export function readVideoDurationSetting(settings) {
  const duration = Number(parseSettings(settings).video_duration)
  return VIDEO_DURATION_OPTIONS.includes(duration) ? duration : 5
}

export function mergeVideoDurationSetting(settings, duration) {
  const value = Number(duration)
  return {
    ...parseSettings(settings),
    video_duration: VIDEO_DURATION_OPTIONS.includes(value) ? value : 5,
  }
}
