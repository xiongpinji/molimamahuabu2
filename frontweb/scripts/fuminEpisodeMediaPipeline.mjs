import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function fail(code, detail = '') {
  const error = new Error(`${code}${detail ? `: ${detail}` : ''}`)
  error.code = code
  throw error
}

function assertKeepDuration(keepDurationMs) {
  if (!Number.isInteger(keepDurationMs) || keepDurationMs <= 0 || keepDurationMs > 5000) {
    fail('FUMIN_MEDIA_KEEP_DURATION_INVALID', String(keepDurationMs))
  }
}

export function buildNormalizeUnitArgs({ inputPath, outputPath, keepDurationMs }) {
  assertKeepDuration(keepDurationMs)
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
    '-ss', '0.000', '-i', inputPath,
    '-t', (keepDurationMs / 1000).toFixed(3),
    '-map', '0:v:0', '-map', '0:a:0',
    '-vf', 'scale=480:864,fps=24',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', outputPath,
  ]
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function sameOrInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function lstat(filePath) {
  try { return fs.lstatSync(filePath) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function assertNoLinks(filePath) {
  if (typeof filePath !== 'string' || !filePath || /[\0\r\n]/u.test(filePath)) {
    fail('FUMIN_MEDIA_PATH_UNSAFE', String(filePath))
  }
  const resolved = path.resolve(filePath)
  const parsed = path.parse(resolved)
  let current = parsed.root
  for (const segment of path.relative(parsed.root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const stat = lstat(current)
    if (!stat) break
    if (stat.isSymbolicLink() || path.resolve(fs.realpathSync(current)) !== path.resolve(current)) {
      fail('FUMIN_MEDIA_PATH_UNSAFE', current)
    }
  }
  return resolved
}

function ensureSafeDirectory(directoryPath) {
  const resolved = path.resolve(directoryPath)
  const parsed = path.parse(resolved)
  let current = parsed.root
  for (const segment of path.relative(parsed.root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const before = lstat(current)
    if (!before) fs.mkdirSync(current)
    const stat = lstat(current)
    if (!stat?.isDirectory() || stat.isSymbolicLink()
      || path.resolve(fs.realpathSync(current)) !== path.resolve(current)) {
      fail('FUMIN_MEDIA_PATH_UNSAFE', current)
    }
  }
}

function assertOutputPath(outputRoot, outputPath) {
  if (!path.isAbsolute(outputRoot) || !path.isAbsolute(outputPath)) fail('FUMIN_MEDIA_PATH_INVALID')
  const root = assertNoLinks(outputRoot)
  const target = path.resolve(outputPath)
  if (!sameOrInside(root, target) || target === root) fail('FUMIN_MEDIA_OUTPUT_ESCAPE', target)
  assertNoLinks(path.dirname(target))
  assertNoLinks(target)
  return { root, target }
}

function run(command, args, code) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000,
  })
  if (result.error || result.status !== 0) {
    fail(code, result.error?.message || result.stderr || `exit ${result.status}`)
  }
  return result.stdout
}

function ratio(value) {
  const [numerator, denominator = '1'] = String(value || '').split('/')
  return Number(numerator) / Number(denominator)
}

export function probeNormalizedMedia(filePath, { ffprobePath = process.env.FFPROBE_PATH || 'ffprobe' } = {}) {
  let payload
  try {
    payload = JSON.parse(run(ffprobePath, [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
    ], 'FUMIN_MEDIA_FFPROBE_FAILED'))
  } catch (error) {
    if (error?.code) throw error
    fail('FUMIN_MEDIA_FFPROBE_INVALID', error.message)
  }
  const video = payload.streams?.find((stream) => stream.codec_type === 'video')
  const audio = payload.streams?.find((stream) => stream.codec_type === 'audio')
  if (!video) fail('FUMIN_MEDIA_VIDEO_MISSING')
  if (!audio) fail('FUMIN_MEDIA_AUDIO_MISSING')
  return {
    duration_seconds: Number(payload.format?.duration),
    width: Number(video.width),
    height: Number(video.height),
    video_codec: String(video.codec_name || ''),
    pixel_format: String(video.pix_fmt || ''),
    frame_rate: ratio(video.avg_frame_rate || video.r_frame_rate),
    audio_codec: String(audio.codec_name || ''),
    has_audio: true,
    audio_sample_rate: Number(audio.sample_rate),
    audio_channels: Number(audio.channels),
    audio_duration_seconds: Number(audio.duration ?? payload.format?.duration),
    audio_start_seconds: Number(audio.start_time || 0),
  }
}

function validateCanonicalMedia(media, expectedDurationMs, toleranceSeconds) {
  if (!Number.isInteger(expectedDurationMs) || expectedDurationMs <= 0) {
    fail('FUMIN_MEDIA_EXPECTED_DURATION_INVALID')
  }
  const expected = expectedDurationMs / 1000
  if (!Number.isFinite(media.duration_seconds)
    || Math.abs(media.duration_seconds - expected) > toleranceSeconds) {
    fail('FUMIN_MEDIA_DURATION_INVALID', String(media.duration_seconds))
  }
  if (media.width !== 480 || media.height !== 864 || media.video_codec !== 'h264'
    || media.pixel_format !== 'yuv420p' || Math.abs(media.frame_rate - 24) > 0.001) {
    fail('FUMIN_MEDIA_VIDEO_PROFILE_INVALID')
  }
  if (media.audio_codec !== 'aac' || media.audio_sample_rate !== 48000 || media.audio_channels !== 2) {
    fail('FUMIN_MEDIA_AUDIO_PROFILE_INVALID')
  }
  if (!Number.isFinite(media.audio_duration_seconds) || media.audio_duration_seconds <= 0
    || media.audio_start_seconds > 0.05
    || media.audio_start_seconds + media.audio_duration_seconds < expected - toleranceSeconds) {
    fail('FUMIN_MEDIA_AUDIO_DURATION_INVALID')
  }
  return { ...media, media_passed: true }
}

export function validateNormalizedMedia(media, expectedDurationMs, toleranceSeconds = 0.08) {
  assertKeepDuration(expectedDurationMs)
  return validateCanonicalMedia(media, expectedDurationMs, toleranceSeconds)
}

export function validateAssembledMedia(media, expectedDurationMs) {
  return validateCanonicalMedia(media, expectedDurationMs, 0.15)
}

function publishExclusive(stagingPath, outputPath) {
  try {
    fs.linkSync(stagingPath, outputPath)
  } catch (error) {
    if (error?.code === 'EEXIST') fail('FUMIN_MEDIA_OUTPUT_EXISTS', outputPath)
    fail('FUMIN_MEDIA_PUBLISH_FAILED', error?.message)
  }
}

export function normalizeUnitArtifact({
  inputPath,
  outputPath,
  outputRoot,
  keepDurationMs,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
}) {
  assertKeepDuration(keepDurationMs)
  const { root, target } = assertOutputPath(outputRoot, outputPath)
  const input = assertNoLinks(inputPath)
  const inputStat = lstat(input)
  if (!inputStat?.isFile() || inputStat.isSymbolicLink()) fail('FUMIN_MEDIA_INPUT_MISSING', input)
  const inputHash = sha256File(input)
  ensureSafeDirectory(root)
  ensureSafeDirectory(path.dirname(target))
  assertOutputPath(root, target)
  if (lstat(target)) fail('FUMIN_MEDIA_OUTPUT_EXISTS', target)
  const stagingPath = path.join(path.dirname(target), `.fumin-${process.pid}-${crypto.randomUUID()}.mp4`)
  try {
    run(ffmpegPath, buildNormalizeUnitArgs({
      inputPath: input,
      outputPath: stagingPath,
      keepDurationMs,
    }), 'FUMIN_MEDIA_FFMPEG_FAILED')
    if (sha256File(input) !== inputHash) fail('FUMIN_MEDIA_ARTIFACT_HASH_MISMATCH', input)
    const stat = lstat(stagingPath)
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 1) fail('FUMIN_MEDIA_OUTPUT_MISSING')
    const media = validateNormalizedMedia(probeNormalizedMedia(stagingPath, { ffprobePath }), keepDurationMs)
    if (sha256File(input) !== inputHash) fail('FUMIN_MEDIA_ARTIFACT_HASH_MISMATCH', input)
    const stagingHash = sha256File(stagingPath)
    assertOutputPath(root, target)
    publishExclusive(stagingPath, target)
    const finalHash = sha256File(target)
    if (finalHash !== stagingHash) fail('FUMIN_MEDIA_PUBLISH_HASH_MISMATCH')
    return { path: target, sha256: finalHash, media }
  } finally {
    const stat = lstat(stagingPath)
    if (stat?.isFile() && !stat.isSymbolicLink()) fs.rmSync(stagingPath)
  }
}

function assertArtifactId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
    || value.includes('..') || path.isAbsolute(value)) {
    fail('FUMIN_MEDIA_ARTIFACT_ID_UNSAFE', String(value))
  }
  return value
}

export function validateExecutionUnits(units) {
  if (!Array.isArray(units) || units.length === 0) fail('FUMIN_MEDIA_UNITS_INVALID')
  const unitIds = new Set()
  const closedParents = new Set()
  let parent = null
  let expectedPart = 0
  let previous = null
  for (const unit of units) {
    const unitId = assertArtifactId(unit?.unit_id)
    const parentId = assertArtifactId(unit?.parent_shot_id)
    assertKeepDuration(unit?.keep_duration_ms)
    if (unitIds.has(unitId)) fail('FUMIN_MEDIA_UNIT_DUPLICATE', unitId)
    unitIds.add(unitId)
    if (parentId !== parent) {
      if (parent != null) closedParents.add(parent)
      if (closedParents.has(parentId)) fail('FUMIN_MEDIA_PARENT_NONCONTIGUOUS', parentId)
      parent = parentId
      expectedPart = 1
      previous = null
    } else {
      expectedPart += 1
    }
    if (!Number.isInteger(unit.part_index) || unit.part_index !== expectedPart
      || !Number.isInteger(unit.part_count) || unit.part_count < expectedPart) {
      fail('FUMIN_MEDIA_UNIT_SEQUENCE_INVALID', unitId)
    }
    if (previous && Number.isInteger(previous.source_end_ms) && Number.isInteger(unit.source_start_ms)
      && previous.source_end_ms !== unit.source_start_ms) {
      fail('FUMIN_MEDIA_UNIT_SEQUENCE_INVALID', unitId)
    }
    previous = unit
  }
  for (let index = 0; index < units.length;) {
    const first = units[index]
    let count = 0
    while (index < units.length && units[index].parent_shot_id === first.parent_shot_id) {
      count += 1
      index += 1
    }
    if (count !== first.part_count) fail('FUMIN_MEDIA_UNIT_SEQUENCE_INVALID', first.parent_shot_id)
  }
  return units
}

function normalizedArtifactArray(units, artifacts) {
  if (Array.isArray(artifacts)) {
    if (artifacts.every((item) => typeof item === 'string')) {
      return artifacts.map((filePath, index) => ({ unit_id: units[index]?.unit_id, path: filePath }))
    }
    return artifacts
  }
  if (artifacts && typeof artifacts === 'object') {
    return units.map((unit) => {
      const value = artifacts[unit.unit_id]
      return typeof value === 'string' ? { unit_id: unit.unit_id, path: value } : value
    })
  }
  return []
}

export function validateArtifactMapping(units, artifacts) {
  validateExecutionUnits(units)
  const items = normalizedArtifactArray(units, artifacts)
  if (items.length !== units.length) fail('FUMIN_MEDIA_ARTIFACT_MAPPING_INVALID')
  const seen = new Set()
  for (let index = 0; index < units.length; index += 1) {
    const item = items[index]
    if (!item || item.unit_id !== units[index].unit_id || typeof item.path !== 'string'
      || !item.path || seen.has(item.unit_id)) {
      fail('FUMIN_MEDIA_ARTIFACT_MAPPING_INVALID', units[index].unit_id)
    }
    seen.add(item.unit_id)
    if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) {
      fail('FUMIN_MEDIA_ARTIFACT_HASH_INVALID', item.unit_id)
    }
    if (item.actual_sha256 && item.sha256 && item.actual_sha256 !== item.sha256) {
      fail('FUMIN_MEDIA_ARTIFACT_HASH_MISMATCH', item.unit_id)
    }
  }
  return items
}

function escapeConcatPath(filePath) {
  return path.resolve(filePath).replace(/\\/g, '/').replace(/'/g, "'\\''")
}

function concatArtifacts({
  inputs,
  inputDurationsMs,
  outputPath,
  outputRoot,
  expectedDurationMs,
  ffmpegPath,
  ffprobePath,
}) {
  if (!Array.isArray(inputDurationsMs) || inputDurationsMs.length !== inputs.length
    || inputDurationsMs.some((duration) => !Number.isInteger(duration) || duration <= 0)) {
    fail('FUMIN_MEDIA_CONCAT_DURATION_INVALID')
  }
  const { root, target } = assertOutputPath(outputRoot, outputPath)
  ensureSafeDirectory(root)
  ensureSafeDirectory(path.dirname(target))
  assertOutputPath(root, target)
  if (lstat(target)) fail('FUMIN_MEDIA_OUTPUT_EXISTS', target)
  const verifiedInputs = inputs.map((input) => {
    if (!input || typeof input.path !== 'string' || !/^[a-f0-9]{64}$/u.test(String(input.sha256 || ''))) {
      fail('FUMIN_MEDIA_ARTIFACT_HASH_INVALID')
    }
    const inputPath = assertNoLinks(input.path)
    const stat = lstat(inputPath)
    if (!stat?.isFile() || stat.isSymbolicLink()) fail('FUMIN_MEDIA_INPUT_MISSING', inputPath)
    if (sha256File(inputPath) !== input.sha256) fail('FUMIN_MEDIA_ARTIFACT_HASH_MISMATCH', inputPath)
    return { path: inputPath, sha256: input.sha256 }
  })
  const token = `${process.pid}-${crypto.randomUUID()}`
  const listPath = path.join(path.dirname(target), `.fumin-concat-${token}.txt`)
  const stagingPath = path.join(path.dirname(target), `.fumin-concat-${token}.mp4`)
  try {
    const list = verifiedInputs.flatMap((input, index) => [
      `file '${escapeConcatPath(input.path)}'`,
      `duration ${(inputDurationsMs[index] / 1000).toFixed(3)}`,
    ])
    fs.writeFileSync(listPath, `${list.join('\n')}\n`, { flag: 'wx' })
    run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-t', (expectedDurationMs / 1000).toFixed(3),
      '-map', '0:v:0', '-map', '0:a:0',
      '-vf', 'scale=480:864,fps=24',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', stagingPath,
    ], 'FUMIN_MEDIA_CONCAT_FAILED')
    for (const input of verifiedInputs) {
      if (sha256File(input.path) !== input.sha256) fail('FUMIN_MEDIA_ARTIFACT_HASH_MISMATCH', input.path)
    }
    const media = validateCanonicalMedia(
      probeNormalizedMedia(stagingPath, { ffprobePath }),
      expectedDurationMs,
      0.15,
    )
    const stagingHash = sha256File(stagingPath)
    assertOutputPath(root, target)
    publishExclusive(stagingPath, target)
    const finalHash = sha256File(target)
    if (finalHash !== stagingHash) fail('FUMIN_MEDIA_PUBLISH_HASH_MISMATCH')
    return { path: target, sha256: finalHash, media }
  } finally {
    for (const temporary of [listPath, stagingPath]) {
      const stat = lstat(temporary)
      if (stat?.isFile() && !stat.isSymbolicLink()) fs.rmSync(temporary)
    }
  }
}

export function assembleNormalizedEpisode({
  units,
  unitArtifacts,
  outputRoot,
  episodeOutputPath = path.join(outputRoot, 'episode.mp4'),
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
}) {
  const artifacts = validateArtifactMapping(units, unitArtifacts)
  const verified = artifacts.map((artifact, index) => {
    const inputPath = assertNoLinks(artifact.path)
    const stat = lstat(inputPath)
    if (!stat?.isFile() || stat.isSymbolicLink()) fail('FUMIN_MEDIA_INPUT_MISSING', artifact.unit_id)
    const actualHash = sha256File(inputPath)
    if (actualHash !== artifact.sha256) {
      fail('FUMIN_MEDIA_ARTIFACT_HASH_MISMATCH', artifact.unit_id)
    }
    const media = validateNormalizedMedia(
      probeNormalizedMedia(inputPath, { ffprobePath }),
      units[index].keep_duration_ms,
    )
    if (sha256File(inputPath) !== actualHash) {
      fail('FUMIN_MEDIA_ARTIFACT_HASH_MISMATCH', artifact.unit_id)
    }
    return { ...artifact, path: inputPath, sha256: actualHash, media }
  })
  const parentShots = []
  for (let index = 0; index < units.length;) {
    const parentId = units[index].parent_shot_id
    const groupUnits = []
    const groupArtifacts = []
    while (index < units.length && units[index].parent_shot_id === parentId) {
      groupUnits.push(units[index])
      groupArtifacts.push(verified[index])
      index += 1
    }
    const expectedDurationMs = groupUnits.reduce((sum, unit) => sum + unit.keep_duration_ms, 0)
    const parent = concatArtifacts({
      inputs: groupArtifacts,
      inputDurationsMs: groupUnits.map((unit) => unit.keep_duration_ms),
      outputPath: path.join(outputRoot, 'parents', `${parentId}.mp4`),
      outputRoot,
      expectedDurationMs,
      ffmpegPath,
      ffprobePath,
    })
    parentShots.push({ parent_shot_id: parentId, unit_ids: groupUnits.map((unit) => unit.unit_id), ...parent })
  }
  const totalDurationMs = units.reduce((sum, unit) => sum + unit.keep_duration_ms, 0)
  const episode = concatArtifacts({
    inputs: parentShots,
    inputDurationsMs: parentShots.map((parent) => units
      .filter((unit) => unit.parent_shot_id === parent.parent_shot_id)
      .reduce((sum, unit) => sum + unit.keep_duration_ms, 0)),
    outputPath: episodeOutputPath,
    outputRoot,
    expectedDurationMs: totalDurationMs,
    ffmpegPath,
    ffprobePath,
  })
  return { normalized_units: verified, parent_shots: parentShots, episode }
}

export function finalizeEpisodeMedia({
  units,
  rawArtifacts,
  outputRoot,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
  episodeOutputPath,
}) {
  const raws = validateArtifactMapping(units, rawArtifacts)
  const normalized = raws.map((raw, index) => {
    const actualHash = fs.existsSync(raw.path) ? sha256File(raw.path) : null
    if (actualHash !== raw.sha256) fail('FUMIN_MEDIA_ARTIFACT_HASH_MISMATCH', raw.unit_id)
    const normalizedArtifact = {
      unit_id: raw.unit_id,
      ...normalizeUnitArtifact({
        inputPath: raw.path,
        outputPath: path.join(outputRoot, 'units', `${raw.unit_id}.mp4`),
        outputRoot,
        keepDurationMs: units[index].keep_duration_ms,
        ffmpegPath,
        ffprobePath,
      }),
    }
    if (sha256File(raw.path) !== raw.sha256) fail('FUMIN_MEDIA_ARTIFACT_HASH_MISMATCH', raw.unit_id)
    return normalizedArtifact
  })
  return assembleNormalizedEpisode({
    units,
    unitArtifacts: normalized,
    outputRoot,
    episodeOutputPath,
    ffmpegPath,
    ffprobePath,
  })
}
