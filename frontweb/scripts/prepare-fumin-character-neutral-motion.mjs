#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { redrawLatinAmericanCase } from '../e2e/fixtures/redraw-latin-american-case.js'
import {
  buildCharacterNeutralMotionArgs,
  validateCharacterNeutralMotionProbe,
} from './fuminCharacterNeutralMotion.mjs'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')
const { getFfmpegPath, getFfprobePath } = require(path.join(
  repositoryRoot,
  'backend-node',
  'src',
  'utils',
  'ffmpegPath',
))

function fail(code, message = code) {
  throw Object.assign(new Error(`${code}: ${message}`), { code })
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function parseRate(value) {
  const text = String(value || '')
  if (!text.includes('/')) return Number(text)
  const [left, right] = text.split('/').map(Number)
  return right ? left / right : Number.NaN
}

function runProcess(executable, args, code) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10 * 60 * 1000,
  })
  if (result.error || result.status !== 0) {
    fail(code, String(result.error?.message || result.stderr || result.stdout || result.status).slice(0, 1000))
  }
  return result.stdout
}

function probeMedia(filePath) {
  const parsed = JSON.parse(runProcess(getFfprobePath(), [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
  ], 'FUMIN_CHARACTER_NEUTRAL_MOTION_FFPROBE_FAILED'))
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video')
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio')
  if (!video) fail('FUMIN_CHARACTER_NEUTRAL_MOTION_VIDEO_MISSING')
  return {
    duration_seconds: Number(parsed.format?.duration),
    width: Number(video.width),
    height: Number(video.height),
    frame_rate: parseRate(video.avg_frame_rate || video.r_frame_rate),
    video_codec: String(video.codec_name || ''),
    has_audio: Boolean(audio),
  }
}

function createContactSheet(videoPath, outputPath) {
  runProcess(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-i', videoPath,
    '-vf', 'fps=1,scale=124:-2,tile=8x1', '-frames:v', '1', '-y', outputPath,
  ], 'FUMIN_CHARACTER_NEUTRAL_MOTION_CONTACT_SHEET_FAILED')
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!['--source', '--output-root'].includes(flag) || !value || value.startsWith('--')) {
      fail('FUMIN_CHARACTER_NEUTRAL_MOTION_ARGUMENT_INVALID')
    }
    options[flag === '--source' ? 'source' : 'outputRoot'] = path.resolve(value)
  }
  if (!options.source || !options.outputRoot) fail('FUMIN_CHARACTER_NEUTRAL_MOTION_ARGUMENT_INVALID')
  return options
}

export function prepareCharacterNeutralMotion({ source, outputRoot }) {
  if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    fail('FUMIN_CHARACTER_NEUTRAL_MOTION_SOURCE_MISSING')
  }
  if (sha256File(source) !== redrawLatinAmericanCase.source.sha256) {
    fail('FUMIN_CHARACTER_NEUTRAL_MOTION_SOURCE_HASH_MISMATCH')
  }
  if (fs.existsSync(outputRoot)) fail('FUMIN_CHARACTER_NEUTRAL_MOTION_OUTPUT_EXISTS')
  const parent = path.dirname(outputRoot)
  fs.mkdirSync(parent, { recursive: true })
  const staging = fs.mkdtempSync(path.join(parent, `.${path.basename(outputRoot)}.staging-`))
  let published = false
  try {
    const motionRoot = path.join(staging, 'motion')
    const contactRoot = path.join(staging, 'contact-sheets')
    fs.mkdirSync(motionRoot)
    fs.mkdirSync(contactRoot)
    const shots = redrawLatinAmericanCase.sourceFacts.shots.map((shot, index) => {
      const number = String(index + 1).padStart(2, '0')
      const motionName = `shot-${number}-character-neutral.mp4`
      const contactName = `shot-${number}-contact-sheet.jpg`
      const motionPath = path.join(motionRoot, motionName)
      const contactPath = path.join(contactRoot, contactName)
      const durationMs = shot.end_ms - shot.start_ms
      runProcess(getFfmpegPath(), buildCharacterNeutralMotionArgs({
        sourcePath: source,
        outputPath: motionPath,
        startMs: shot.start_ms,
        durationMs,
      }), 'FUMIN_CHARACTER_NEUTRAL_MOTION_BUILD_FAILED')
      const probe = validateCharacterNeutralMotionProbe(probeMedia(motionPath), durationMs)
      createContactSheet(motionPath, contactPath)
      return {
        shot_number: index + 1,
        shot_id: shot.id,
        source_start_ms: shot.start_ms,
        source_end_ms: shot.end_ms,
        conditioning_mode: 'character_neutral_motion',
        motion: {
          artifact_id: `motion/${motionName}`,
          sha256: sha256File(motionPath),
          bytes: fs.statSync(motionPath).size,
          ...probe,
        },
        contact_sheet: {
          artifact_id: `contact-sheets/${contactName}`,
          sha256: sha256File(contactPath),
          bytes: fs.statSync(contactPath).size,
        },
      }
    })
    const manifest = {
      schema_version: 'fumin-character-neutral-motion-pack-v1',
      created_at: new Date().toISOString(),
      case_id: redrawLatinAmericanCase.id,
      source_sha256: redrawLatinAmericanCase.source.sha256,
      supplier_call_performed: false,
      paid_submit_count: 0,
      review_status: 'pending',
      shots,
    }
    fs.writeFileSync(
      path.join(staging, 'character-neutral-motion-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    )
    fs.renameSync(staging, outputRoot)
    published = true
    return manifest
  } finally {
    if (!published) fs.rmSync(staging, { recursive: true, force: true })
  }
}

async function main() {
  const manifest = prepareCharacterNeutralMotion(parseArgs(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify({
    schema_version: manifest.schema_version,
    shot_count: manifest.shots.length,
    review_status: manifest.review_status,
    paid_submit_count: 0,
  }, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(String(error?.code || error?.message || 'FUMIN_CHARACTER_NEUTRAL_MOTION_FAILED'))
    process.exitCode = 1
  })
}


