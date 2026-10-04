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

/**
 * 分镜时长不在模型可选档位时，取不小于它的最短档位（都小于时取最长档）。
 * 例如 3 秒分镜在 4/8/10 秒模型上按 4 秒生成，合成整集时再按分镜时长裁回。
 */
export function submittableVideoDuration(duration, capability) {
  const value = Number(duration)
  if (!Number.isFinite(value) || value <= 0) return undefined
  const allowed = videoDurationOptionsForCapability(capability).slice().sort((a, b) => a - b)
  if (allowed.includes(value)) return value
  return allowed.find((option) => option >= value) ?? allowed[allowed.length - 1]
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
