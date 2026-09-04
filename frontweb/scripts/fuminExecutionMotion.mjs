import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function codedError(code, message = code) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function fail(code, message) {
  throw codedError(code, message)
}

function seconds(milliseconds) {
  return (milliseconds / 1000).toFixed(3)
}

function validPath(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function validateArguments({
  sourcePath,
  outputPath,
  offsetMs,
  keepDurationMs,
  providerDurationSeconds,
}) {
  const providerDurationMs = providerDurationSeconds * 1000
  if (!validPath(sourcePath)
    || !validPath(outputPath)
    || !Number.isInteger(offsetMs)
    || offsetMs < 0
    || !Number.isInteger(keepDurationMs)
    || keepDurationMs <= 0
    || !Number.isFinite(providerDurationSeconds)
    || providerDurationSeconds <= 0
    || !Number.isInteger(providerDurationMs)
    || keepDurationMs > providerDurationMs) {
    fail('FUMIN_EXECUTION_MOTION_ARGUMENT_INVALID')
  }
  return providerDurationMs
}

export function buildFuminExecutionMotionArgs(input) {
  const providerDurationMs = validateArguments(input)
  const {
    sourcePath,
    outputPath,
    offsetMs,
    keepDurationMs,
  } = input
  const paddingMs = providerDurationMs - keepDurationMs
  const filters = [
    `trim=duration=${seconds(keepDurationMs)}`,
    'setpts=PTS-STARTPTS',
  ]
  if (paddingMs > 0) {
    filters.push(`tpad=stop_mode=clone:stop_duration=${seconds(paddingMs)}`)
  }
  filters.push('fps=24', 'format=yuv420p')

  return [
    '-y', '-ss', seconds(offsetMs), '-i', sourcePath, '-an',
    '-map', '0:v:0', '-vf', filters.join(','),
    '-t', seconds(providerDurationMs),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '24',
    '-movflags', '+faststart', outputPath,
  ]
}

function parseRate(value) {
  const text = String(value ?? '')
  if (!text.includes('/')) return Number(text)
  const [numerator, denominator] = text.split('/').map(Number)
  return denominator ? numerator / denominator : Number.NaN
}

export function validateFuminExecutionMotionProbe(probe) {
  const hasRawStreams = Array.isArray(probe?.streams)
  const video = hasRawStreams
    ? probe.streams.find((stream) => stream?.codec_type === 'video')
    : null
  const durationSeconds = Number(
    probe?.format?.duration ?? probe?.duration_seconds ?? video?.duration,
  )
  if (!Number.isFinite(durationSeconds) || Math.abs(durationSeconds - 5) > 0.1) {
    fail('FUMIN_EXECUTION_MOTION_DURATION_INVALID')
  }

  const rawAudioPresent = hasRawStreams
    && probe.streams.some((stream) => stream?.codec_type === 'audio')
  if (rawAudioPresent || probe?.has_audio === true || Number(probe?.audio_stream_count) > 0) {
    fail('FUMIN_EXECUTION_MOTION_AUDIO_PRESENT')
  }
  if (!hasRawStreams && probe?.has_audio !== false && Number(probe?.audio_stream_count) !== 0) {
    fail('FUMIN_EXECUTION_MOTION_AUDIO_UNKNOWN')
  }
  if (hasRawStreams && !video) fail('FUMIN_EXECUTION_MOTION_VIDEO_MISSING')
  if (!hasRawStreams
    && probe?.width == null
    && probe?.height == null
    && probe?.video_codec == null
    && probe?.pix_fmt == null
    && probe?.frame_rate == null) {
    fail('FUMIN_EXECUTION_MOTION_VIDEO_MISSING')
  }

  const width = Number(video?.width ?? probe?.width)
  const height = Number(video?.height ?? probe?.height)
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    fail('FUMIN_EXECUTION_MOTION_VIDEO_INVALID')
  }
  const videoCodec = String(video?.codec_name ?? probe?.video_codec ?? '').toLowerCase()
  if (videoCodec !== 'h264') fail('FUMIN_EXECUTION_MOTION_CODEC_INVALID')
  const pixelFormat = String(video?.pix_fmt ?? probe?.pix_fmt ?? '').toLowerCase()
  if (pixelFormat !== 'yuv420p') fail('FUMIN_EXECUTION_MOTION_PIXEL_FORMAT_INVALID')
  const frameRate = parseRate(
    video?.avg_frame_rate ?? video?.r_frame_rate ?? probe?.frame_rate,
  )
  if (!Number.isFinite(frameRate) || Math.abs(frameRate - 24) > 0.01) {
    fail('FUMIN_EXECUTION_MOTION_FRAME_RATE_INVALID')
  }

  return {
    duration_seconds: durationSeconds,
    width,
    height,
    frame_rate: frameRate,
    video_codec: 'h264',
    pix_fmt: 'yuv420p',
    has_audio: false,
  }
}

function runProcess(command, args, code) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10 * 60 * 1000,
  })
  if (result.error || result.status !== 0) {
    fail(code, String(result.error?.message || result.stderr || result.stdout || result.status).slice(0, 1000))
  }
  return result.stdout
}

function probeArgs(filePath) {
  return ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath]
}

function parseProbe(stdout) {
  try {
    return JSON.parse(stdout)
  } catch {
    fail('FUMIN_EXECUTION_MOTION_FFPROBE_INVALID')
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export function materializeFuminExecutionMotion(input, adapters = {}) {
  validateArguments(input)
  const { sourcePath, outputPath } = input
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    fail('FUMIN_EXECUTION_MOTION_SOURCE_MISSING')
  }
  if (fs.existsSync(outputPath)) fail('FUMIN_EXECUTION_MOTION_OUTPUT_EXISTS')

  const parent = path.dirname(outputPath)
  fs.mkdirSync(parent, { recursive: true })
  const temporaryPath = path.join(
    parent,
    `.${path.basename(outputPath)}.tmp-${process.pid}-${crypto.randomUUID()}.mp4`,
  )
  const execute = adapters.runProcess || runProcess
  try {
    execute(
      adapters.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg',
      buildFuminExecutionMotionArgs({ ...input, outputPath: temporaryPath }),
      'FUMIN_EXECUTION_MOTION_FFMPEG_FAILED',
    )
    if (!fs.existsSync(temporaryPath)
      || !fs.statSync(temporaryPath).isFile()
      || fs.statSync(temporaryPath).size <= 0) {
      fail('FUMIN_EXECUTION_MOTION_OUTPUT_MISSING')
    }

    const rawProbe = execute(
      adapters.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe',
      probeArgs(temporaryPath),
      'FUMIN_EXECUTION_MOTION_FFPROBE_FAILED',
    )
    const probe = validateFuminExecutionMotionProbe(parseProbe(rawProbe))
    const evidence = {
      outputPath,
      sha256: sha256File(temporaryPath),
      bytes: fs.statSync(temporaryPath).size,
      duration_seconds: probe.duration_seconds,
      probe,
    }
    try {
      fs.linkSync(temporaryPath, outputPath)
    } catch (error) {
      if (error?.code === 'EEXIST') fail('FUMIN_EXECUTION_MOTION_OUTPUT_EXISTS')
      fail('FUMIN_EXECUTION_MOTION_PUBLISH_FAILED', error?.message)
    }
    return evidence
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true })
  }
}
