import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe'

function haveMediaTools() {
  try {
    execFileSync(ffmpegPath, ['-version'], { stdio: 'ignore' })
    execFileSync(ffprobePath, ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function createRaw(rawPath) {
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
    '-f', 'lavfi', '-i', 'color=c=blue:s=240x432:r=30:d=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', rawPath,
  ])
}

test('normalize arguments trim from zero to the exact keep duration with the canonical media profile', async () => {
  const { buildNormalizeUnitArgs } = await import('./fuminEpisodeMediaPipeline.mjs')
  const args = buildNormalizeUnitArgs({
    inputPath: 'raw.mp4',
    outputPath: 'normalized.mp4',
    keepDurationMs: 1266,
  })
  assert.equal(args[args.indexOf('-ss') + 1], '0.000')
  assert.equal(args[args.indexOf('-t') + 1], '1.266')
  assert.equal(args[args.indexOf('-vf') + 1], 'scale=480:864,fps=24')
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264')
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p')
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac')
  assert.equal(args[args.indexOf('-ar') + 1], '48000')
  assert.equal(args[args.indexOf('-ac') + 1], '2')
  assert.equal(args.at(-1), 'normalized.mp4')
})

test('normalize arguments reject non-integer, zero, and over-five-second keep durations', async () => {
  const { buildNormalizeUnitArgs } = await import('./fuminEpisodeMediaPipeline.mjs')
  for (const keepDurationMs of [0, -1, 5001, 1.25, Number.NaN]) {
    assert.throws(
      () => buildNormalizeUnitArgs({ inputPath: 'raw.mp4', outputPath: 'out.mp4', keepDurationMs }),
      { code: 'FUMIN_MEDIA_KEEP_DURATION_INVALID' },
    )
  }
})

test('single-unit normalization creates a probed, hash-bound 1.266 second canonical artifact', { skip: !haveMediaTools() }, async () => {
  const { normalizeUnitArtifact } = await import('./fuminEpisodeMediaPipeline.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-normalize-'))
  try {
    const rawPath = path.join(root, 'raw.mp4')
    const outputRoot = path.join(root, 'outputs')
    const outputPath = path.join(outputRoot, 'units', 'shot-1.part-01.mp4')
    createRaw(rawPath)
    const result = normalizeUnitArtifact({
      inputPath: rawPath,
      outputPath,
      outputRoot,
      keepDurationMs: 1266,
      ffmpegPath,
      ffprobePath,
    })
    assert.equal(result.path, outputPath)
    assert.match(result.sha256, /^[a-f0-9]{64}$/)
    assert.equal(result.sha256, crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex'))
    assert.equal(result.media.width, 480)
    assert.equal(result.media.height, 864)
    assert.equal(result.media.video_codec, 'h264')
    assert.equal(result.media.pixel_format, 'yuv420p')
    assert.equal(result.media.frame_rate, 24)
    assert.equal(result.media.audio_codec, 'aac')
    assert.equal(result.media.audio_sample_rate, 48000)
    assert.equal(result.media.audio_channels, 2)
    assert.ok(Math.abs(result.media.duration_seconds - 1.266) <= 0.08)
    assert.ok(result.media.audio_duration_seconds > 1.18)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('single-unit normalization never overwrites a final and cleans staging files after ffmpeg or probe failure', { skip: !haveMediaTools() }, async () => {
  const { normalizeUnitArtifact } = await import('./fuminEpisodeMediaPipeline.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-normalize-fail-'))
  try {
    const rawPath = path.join(root, 'raw.mp4')
    const outputRoot = path.join(root, 'outputs')
    const unitDir = path.join(outputRoot, 'units')
    const outputPath = path.join(unitDir, 'shot-1.part-01.mp4')
    createRaw(rawPath)
    fs.mkdirSync(unitDir, { recursive: true })
    fs.writeFileSync(outputPath, 'existing')
    assert.throws(
      () => normalizeUnitArtifact({ inputPath: rawPath, outputPath, outputRoot, keepDurationMs: 1266, ffmpegPath, ffprobePath }),
      { code: 'FUMIN_MEDIA_OUTPUT_EXISTS' },
    )
    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'existing')
    fs.rmSync(outputPath)

    for (const paths of [
      { ffmpegPath: path.join(root, 'missing-ffmpeg.exe'), ffprobePath },
      { ffmpegPath, ffprobePath: path.join(root, 'missing-ffprobe.exe') },
    ]) {
      assert.throws(
        () => normalizeUnitArtifact({ inputPath: rawPath, outputPath, outputRoot, keepDurationMs: 1266, ...paths }),
      )
      assert.equal(fs.existsSync(outputPath), false)
      assert.deepEqual(fs.existsSync(unitDir) ? fs.readdirSync(unitDir) : [], [])
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function r4Units() {
  const units = []
  let unitNumber = 0
  let cursor = 0
  for (let parentNumber = 1; parentNumber <= 24; parentNumber += 1) {
    const partCount = parentNumber <= 4 ? 2 : 1
    for (let partIndex = 1; partIndex <= partCount; partIndex += 1) {
      unitNumber += 1
      const keepDurationMs = unitNumber === 28 ? 2475 : 2454
      units.push({
        unit_id: `shot-${String(parentNumber).padStart(2, '0')}.part-${String(partIndex).padStart(2, '0')}`,
        parent_shot_id: `shot-${String(parentNumber).padStart(2, '0')}`,
        part_index: partIndex,
        part_count: partCount,
        source_start_ms: cursor,
        source_end_ms: cursor + keepDurationMs,
        keep_duration_ms: keepDurationMs,
      })
      cursor += keepDurationMs
    }
  }
  return units
}

test('execution units reject reordered, missing, non-contiguous parent, drifted hash, and unsafe IDs', async () => {
  const { assembleNormalizedEpisode, validateExecutionUnits, validateArtifactMapping } = await import('./fuminEpisodeMediaPipeline.mjs')
  const units = r4Units()
  const reordered = [...units]
  ;[reordered[0], reordered[1]] = [reordered[1], reordered[0]]
  assert.throws(() => validateExecutionUnits(reordered), { code: 'FUMIN_MEDIA_UNIT_SEQUENCE_INVALID' })
  assert.throws(() => validateExecutionUnits([...units.slice(0, 2), units[4], ...units.slice(2, 4), ...units.slice(5)]), { code: 'FUMIN_MEDIA_PARENT_NONCONTIGUOUS' })
  assert.throws(() => validateExecutionUnits([{ ...units[0], unit_id: '../escape' }]), { code: 'FUMIN_MEDIA_ARTIFACT_ID_UNSAFE' })
  assert.throws(
    () => validateArtifactMapping(units, units.slice(1).map((unit) => ({ unit_id: unit.unit_id, path: 'x.mp4' }))),
    { code: 'FUMIN_MEDIA_ARTIFACT_MAPPING_INVALID' },
  )
  assert.throws(
    () => validateArtifactMapping(units, units.map((unit) => ({ unit_id: unit.unit_id, path: 'x.mp4' }))),
    { code: 'FUMIN_MEDIA_ARTIFACT_HASH_INVALID' },
  )
  assert.throws(
    () => validateArtifactMapping(units, units.map((unit) => ({ unit_id: unit.unit_id, path: 'x.mp4', sha256: 'not-a-sha' }))),
    { code: 'FUMIN_MEDIA_ARTIFACT_HASH_INVALID' },
  )
  const files = units.map((unit) => ({ unit_id: unit.unit_id, path: 'x.mp4', sha256: 'a'.repeat(64) }))
  assert.throws(
    () => validateArtifactMapping(units, [{ ...files[0], sha256: 'b'.repeat(64), actual_sha256: 'c'.repeat(64) }, ...files.slice(1)]),
    { code: 'FUMIN_MEDIA_ARTIFACT_HASH_MISMATCH' },
  )

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-hash-required-'))
  try {
    const artifactPath = path.join(root, 'unit.mp4')
    fs.writeFileSync(artifactPath, 'drifted')
    const unit = { ...units[0], part_count: 1 }
    assert.throws(
      () => assembleNormalizedEpisode({
        units: [unit],
        unitArtifacts: [{ unit_id: unit.unit_id, path: artifactPath, sha256: 'a'.repeat(64) }],
        outputRoot: path.join(root, 'outputs'),
      }),
      { code: 'FUMIN_MEDIA_ARTIFACT_HASH_MISMATCH' },
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('28 valid five-second raws become 28 normalized units, 24 parents, and one 68.733 second episode', { skip: !haveMediaTools(), timeout: 180_000 }, async () => {
  const { finalizeEpisodeMedia } = await import('./fuminEpisodeMediaPipeline.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-r4-media-'))
  try {
    const source = path.join(root, 'source.mp4')
    const rawDir = path.join(root, 'raw')
    const outputRoot = path.join(root, 'outputs')
    fs.mkdirSync(rawDir)
    createRaw(source)
    const units = r4Units()
    const rawArtifacts = units.map((unit) => {
      const rawPath = path.join(rawDir, `${unit.unit_id}.mp4`)
      try { fs.linkSync(source, rawPath) } catch { fs.copyFileSync(source, rawPath) }
      return { unit_id: unit.unit_id, path: rawPath, sha256: crypto.createHash('sha256').update(fs.readFileSync(rawPath)).digest('hex') }
    })
    const result = finalizeEpisodeMedia({ units, rawArtifacts, outputRoot, ffmpegPath, ffprobePath })
    assert.equal(result.normalized_units.length, 28)
    assert.equal(result.parent_shots.length, 24)
    assert.equal(result.parent_shots[0].parent_shot_id, 'shot-01')
    assert.equal(result.parent_shots.at(-1).parent_shot_id, 'shot-24')
    assert.match(result.episode.sha256, /^[a-f0-9]{64}$/)
    assert.equal(result.episode.media.width, 480)
    assert.equal(result.episode.media.height, 864)
    assert.equal(result.episode.media.has_audio, true)
    assert.ok(result.episode.media.audio_duration_seconds > 68.58)
    assert.ok(Math.abs(result.episode.media.duration_seconds - 68.733) <= 0.15)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
