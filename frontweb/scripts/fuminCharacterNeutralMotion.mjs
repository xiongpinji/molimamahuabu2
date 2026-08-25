function fail(message) {
  throw Object.assign(new Error(`FUMIN_CHARACTER_NEUTRAL_MOTION_PROBE_FAILED: ${message}`), {
    code: 'FUMIN_CHARACTER_NEUTRAL_MOTION_PROBE_FAILED',
  })
}

function seconds(milliseconds) {
  const value = Number(milliseconds)
  if (!Number.isFinite(value) || value < 0) throw new TypeError('milliseconds must be non-negative')
  return (value / 1000).toFixed(3)
}

export function buildCharacterNeutralFilter() {
  return [
    'scale=496:864:force_original_aspect_ratio=decrease',
    'pad=496:864:(ow-iw)/2:(oh-ih)/2',
    'scale=124:216:flags=area',
    'gblur=sigma=12:steps=3',
    'scale=496:864:flags=neighbor',
    'format=gray',
    'fps=24',
  ].join(',')
}

export function buildCharacterNeutralMotionArgs({ sourcePath, outputPath, startMs, durationMs }) {
  if (!sourcePath || !outputPath || !Number.isInteger(startMs) || !Number.isInteger(durationMs)
    || startMs < 0 || durationMs <= 0) {
    throw new TypeError('character-neutral motion arguments are invalid')
  }
  return [
    '-hide_banner', '-loglevel', 'error',
    '-ss', seconds(startMs), '-i', sourcePath, '-t', seconds(durationMs),
    '-map', '0:v:0', '-an', '-vf', buildCharacterNeutralFilter(),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-y', outputPath,
  ]
}

export function validateCharacterNeutralMotionProbe(probe, expectedDurationMs) {
  const expectedSeconds = Number(expectedDurationMs) / 1000
  const durationSeconds = Number(probe?.duration_seconds)
  const frameRate = Number(probe?.frame_rate)
  if (!Number.isFinite(expectedSeconds) || expectedSeconds <= 0
    || !Number.isFinite(durationSeconds) || Math.abs(durationSeconds - expectedSeconds) > 0.25
    || Number(probe?.width) !== 496 || Number(probe?.height) !== 864
    || !Number.isFinite(frameRate) || Math.abs(frameRate - 24) > 0.01
    || String(probe?.video_codec || '').toLowerCase() !== 'h264'
    || probe?.has_audio !== false) {
    fail('输出媒体不满足 9:16、24fps、H.264、无音轨或时长合同')
  }
  return {
    duration_seconds: durationSeconds,
    width: 496,
    height: 864,
    frame_rate: frameRate,
    video_codec: 'h264',
    has_audio: false,
    privacy_transform_scope: 'full_frame',
    source_identity_obscured: true,
    source_text_obscured: true,
    review_status: 'pending',
  }
}


