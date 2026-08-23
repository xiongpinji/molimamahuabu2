export const VIDEO_DURATION_OPTIONS = Object.freeze(
  Array.from({ length: 11 }, (_, index) => index + 5),
)

function declaredVideoDurations(capability) {
  if (!Array.isArray(capability?.durations)) return []
  return [...new Set(capability.durations
    .map(Number)
    .filter((duration) => Number.isSafeInteger(duration) && duration > 0))]
}

export function videoDurationOptionsForCapability(capability) {
  const declared = declaredVideoDurations(capability)
  return declared.length ? declared : [...VIDEO_DURATION_OPTIONS]
}

export function assertVideoDurationAllowed(duration, capability) {
  const value = Number(duration)
  const allowed = videoDurationOptionsForCapability(capability)
  if (!Number.isSafeInteger(value) || !allowed.includes(value)) {
    throw new Error(`当前模型视频时长仅支持 ${allowed.join('、')} 秒`)
  }
  return value
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

export function readVideoDurationSetting(settings, capability) {
  const duration = Number(parseSettings(settings).video_duration)
  const allowed = videoDurationOptionsForCapability(capability)
  return allowed.includes(duration) ? duration : allowed[0]
}

export function mergeVideoDurationSetting(settings, duration, capability) {
  const value = Number(duration)
  const allowed = videoDurationOptionsForCapability(capability)
  return {
    ...parseSettings(settings),
    video_duration: allowed.includes(value) ? value : allowed[0],
  }
}
