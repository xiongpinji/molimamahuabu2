const DEFAULT_VIDEO_DURATIONS = Object.freeze([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
const LINGJING_VIDEO_DURATIONS = Object.freeze([4, 5, 6, 8, 10, 11, 15])

export function getSupportedVideoDurationsForModel(model) {
  return String(model || '').trim().toLowerCase() === 'lingjing-video-v1'
    ? LINGJING_VIDEO_DURATIONS
    : DEFAULT_VIDEO_DURATIONS
}

export function normalizeVideoDurationForModel(model, value) {
  const supported = getSupportedVideoDurationsForModel(model)
  const duration = Math.round(Number(value))
  const requested = Number.isFinite(duration) ? duration : supported[0]
  return supported.find((item) => item >= requested) ?? supported[supported.length - 1]
}
