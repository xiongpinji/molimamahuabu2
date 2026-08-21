export const VIDEO_RESOLUTION_OPTIONS = Object.freeze(['480p', '720p', '1080p'])

const USMERCARI_VIDEO_RESOLUTIONS = Object.freeze({
  'MiniMax H3': Object.freeze(['1440p']),
  'seedance-2.0-fast': Object.freeze(['480p', '720p']),
  'seedance-2.0-mini': Object.freeze(['480p', '720p']),
})

export function videoResolutionOptionsForModel(model, declaredOptions = VIDEO_RESOLUTION_OPTIONS) {
  const verified = USMERCARI_VIDEO_RESOLUTIONS[String(model || '').trim()]
  if (verified) return verified
  return Array.isArray(declaredOptions) && declaredOptions.length
    ? declaredOptions
    : VIDEO_RESOLUTION_OPTIONS
}

export function coerceVideoResolutionForModel(model, resolution, declaredOptions = VIDEO_RESOLUTION_OPTIONS) {
  const options = videoResolutionOptionsForModel(model, declaredOptions)
  const current = String(resolution || '').trim().toLowerCase()
  return options.includes(current) ? current : options.at(-1)
}
