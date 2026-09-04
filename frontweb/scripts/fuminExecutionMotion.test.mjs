import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  buildFuminExecutionMotionArgs,
  materializeFuminExecutionMotion,
  validateFuminExecutionMotionProbe,
} from './fuminExecutionMotion.mjs'

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function rawProbe(overrides = {}) {
  return {
    streams: [{
      codec_type: 'video',
      codec_name: 'h264',
      pix_fmt: 'yuv420p',
      width: 496,
      height: 864,
      avg_frame_rate: '24/1',
    }],
    format: { duration: '5.000000' },
    ...overrides,
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-execution-motion-test-'))
  const sourcePath = path.join(root, 'source.mp4')
  const outputPath = path.join(root, 'nested', 'unit.mp4')
  fs.writeFileSync(sourcePath, 'source')
  return { root, sourcePath, outputPath }
}

test('slices the unit window and pads only the reference to five seconds', () => {
  const args = buildFuminExecutionMotionArgs({
    sourcePath: 'shot.mp4',
    outputPath: 'unit.mp4',
    offsetMs: 4037,
    keepDurationMs: 3097,
    providerDurationSeconds: 5,
  })

  assert.deepEqual(args.slice(0, 6), ['-y', '-ss', '4.037', '-i', 'shot.mp4', '-an'])
  assert.ok(args.some((arg) => arg.includes('trim=duration=3.097')))
  assert.ok(args.some((arg) => arg.includes('tpad=stop_mode=clone:stop_duration=1.903')))
  assert.ok(args.includes('libx264'))
  assert.ok(args.includes('yuv420p'))
  assert.ok(args.some((arg) => arg.includes('fps=24')))
  assert.equal(args.at(-1), 'unit.mp4')
})

test('a complete five-second unit is trimmed without padding', () => {
  const args = buildFuminExecutionMotionArgs({
    sourcePath: 'shot.mp4',
    outputPath: 'unit.mp4',
    offsetMs: 0,
    keepDurationMs: 5000,
    providerDurationSeconds: 5,
  })

  assert.ok(args.some((arg) => arg.includes('trim=duration=5.000')))
  assert.equal(args.some((arg) => arg.includes('tpad=')), false)
  assert.ok(args.includes('-an'))
})

test('rejects invalid paths, offsets, keep durations, and provider durations', () => {
  const valid = {
    sourcePath: 'shot.mp4',
    outputPath: 'unit.mp4',
    offsetMs: 0,
    keepDurationMs: 5000,
    providerDurationSeconds: 5,
  }
  for (const changes of [
    { sourcePath: '' },
    { outputPath: '   ' },
    { offsetMs: -1 },
    { offsetMs: 1.5 },
    { offsetMs: Number.NaN },
    { keepDurationMs: 0 },
    { keepDurationMs: 5001 },
    { keepDurationMs: 1.5 },
    { providerDurationSeconds: 0 },
    { providerDurationSeconds: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(
      () => buildFuminExecutionMotionArgs({ ...valid, ...changes }),
      /FUMIN_EXECUTION_MOTION_ARGUMENT_INVALID/,
    )
  }
})

test('accepts common raw ffprobe JSON for five-second silent H.264 yuv420p 24fps video', () => {
  assert.deepEqual(validateFuminExecutionMotionProbe(rawProbe()), {
    duration_seconds: 5,
    width: 496,
    height: 864,
    frame_rate: 24,
    video_codec: 'h264',
    pix_fmt: 'yuv420p',
    has_audio: false,
  })
})

test('rejects invalid duration and any audio stream with stable error codes', () => {
  assert.throws(
    () => validateFuminExecutionMotionProbe(rawProbe({ format: { duration: '4.899' } })),
    { code: 'FUMIN_EXECUTION_MOTION_DURATION_INVALID' },
  )
  assert.throws(
    () => validateFuminExecutionMotionProbe(rawProbe({
      streams: [
        ...rawProbe().streams,
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      has_audio: false,
    })),
    { code: 'FUMIN_EXECUTION_MOTION_AUDIO_PRESENT' },
  )
})

test('fails closed for missing or invalid video, codec, pixel format, and frame rate', () => {
  const video = rawProbe().streams[0]
  const cases = [
    [rawProbe({ streams: [] }), 'FUMIN_EXECUTION_MOTION_VIDEO_MISSING'],
    [rawProbe({ streams: [{ ...video, width: 0 }] }), 'FUMIN_EXECUTION_MOTION_VIDEO_INVALID'],
    [rawProbe({ streams: [{ ...video, height: -1 }] }), 'FUMIN_EXECUTION_MOTION_VIDEO_INVALID'],
    [rawProbe({ streams: [{ ...video, codec_name: 'hevc' }] }), 'FUMIN_EXECUTION_MOTION_CODEC_INVALID'],
    [rawProbe({ streams: [{ ...video, pix_fmt: 'yuv444p' }] }), 'FUMIN_EXECUTION_MOTION_PIXEL_FORMAT_INVALID'],
    [rawProbe({ streams: [{ ...video, avg_frame_rate: '30000/1001' }] }), 'FUMIN_EXECUTION_MOTION_FRAME_RATE_INVALID'],
    [{ duration_seconds: 5, has_audio: false }, 'FUMIN_EXECUTION_MOTION_VIDEO_MISSING'],
  ]
  for (const [probe, code] of cases) {
    assert.throws(() => validateFuminExecutionMotionProbe(probe), { code })
  }
})

test('supports normalized probes but requires explicit no-audio evidence', () => {
  const normalized = {
    duration_seconds: 5.05,
    width: 160,
    height: 90,
    frame_rate: 24,
    video_codec: 'h264',
    pix_fmt: 'yuv420p',
    has_audio: false,
  }
  assert.equal(validateFuminExecutionMotionProbe(normalized).duration_seconds, 5.05)
  assert.throws(
    () => validateFuminExecutionMotionProbe({ ...normalized, has_audio: undefined }),
    { code: 'FUMIN_EXECUTION_MOTION_AUDIO_UNKNOWN' },
  )
})

test('materialization rejects an existing final target without invoking ffmpeg', () => {
  const item = fixture()
  try {
    fs.mkdirSync(path.dirname(item.outputPath), { recursive: true })
    fs.writeFileSync(item.outputPath, 'keep-me')
    let called = false
    assert.throws(() => materializeFuminExecutionMotion({
      ...item,
      offsetMs: 0,
      keepDurationMs: 5000,
      providerDurationSeconds: 5,
    }, {
      runProcess: () => { called = true },
    }), { code: 'FUMIN_EXECUTION_MOTION_OUTPUT_EXISTS' })
    assert.equal(called, false)
    assert.equal(fs.readFileSync(item.outputPath, 'utf8'), 'keep-me')
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('ffmpeg failure leaves no final target or temporary artifact', () => {
  const item = fixture()
  try {
    assert.throws(() => materializeFuminExecutionMotion({
      ...item,
      offsetMs: 0,
      keepDurationMs: 1000,
      providerDurationSeconds: 5,
    }, {
      runProcess: (_command, args, code) => {
        fs.mkdirSync(path.dirname(args.at(-1)), { recursive: true })
        fs.writeFileSync(args.at(-1), 'partial')
        throw Object.assign(new Error(code), { code })
      },
    }), { code: 'FUMIN_EXECUTION_MOTION_FFMPEG_FAILED' })
    assert.equal(fs.existsSync(item.outputPath), false)
    assert.deepEqual(fs.readdirSync(path.dirname(item.outputPath)), [])
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('ffprobe failure or rejected probe leaves no final target', () => {
  for (const probeResult of [
    () => { throw Object.assign(new Error('probe failed'), { code: 'FUMIN_EXECUTION_MOTION_FFPROBE_FAILED' }) },
    () => JSON.stringify(rawProbe({ format: { duration: '4.0' } })),
  ]) {
    const item = fixture()
    try {
      assert.throws(() => materializeFuminExecutionMotion({
        ...item,
        offsetMs: 0,
        keepDurationMs: 1000,
        providerDurationSeconds: 5,
      }, {
        runProcess: (_command, args, code) => {
          if (code === 'FUMIN_EXECUTION_MOTION_FFMPEG_FAILED') {
            fs.writeFileSync(args.at(-1), 'encoded-output')
            return ''
          }
          return probeResult()
        },
      }))
      assert.equal(fs.existsSync(item.outputPath), false)
      assert.deepEqual(fs.readdirSync(path.dirname(item.outputPath)), [])
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true })
    }
  }
})

test('successful materialization publishes SHA-256-bound local evidence', () => {
  const item = fixture()
  const outputBytes = Buffer.from('encoded-output')
  const calls = []
  try {
    const evidence = materializeFuminExecutionMotion({
      ...item,
      offsetMs: 0,
      keepDurationMs: 1000,
      providerDurationSeconds: 5,
    }, {
      ffmpegPath: 'ffmpeg-test',
      ffprobePath: 'ffprobe-test',
      runProcess: (command, args, code) => {
        calls.push({ command, args, code })
        if (code === 'FUMIN_EXECUTION_MOTION_FFMPEG_FAILED') {
          fs.writeFileSync(args.at(-1), outputBytes)
          return ''
        }
        assert.equal(args.at(-1).includes('.tmp-'), true)
        return JSON.stringify(rawProbe())
      },
    })

    assert.deepEqual(calls.map(({ command }) => command), ['ffmpeg-test', 'ffprobe-test'])
    assert.equal(fs.readFileSync(item.outputPath).equals(outputBytes), true)
    assert.equal(evidence.outputPath, item.outputPath)
    assert.equal(evidence.sha256, sha256(outputBytes))
    assert.equal(evidence.bytes, outputBytes.length)
    assert.equal(evidence.duration_seconds, 5)
    assert.equal(evidence.probe.has_audio, false)
    assert.deepEqual(Object.keys(evidence).sort(), [
      'bytes', 'duration_seconds', 'outputPath', 'probe', 'sha256',
    ])
    assert.deepEqual(fs.readdirSync(path.dirname(item.outputPath)), ['unit.mp4'])
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

function executableAvailable(command) {
  const result = spawnSync(command, ['-version'], { encoding: 'utf8', windowsHide: true })
  return !result.error && result.status === 0
}

const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe'
const mediaToolsAvailable = executableAvailable(ffmpegPath) && executableAvailable(ffprobePath)

test('real ffmpeg fixture produces an approximately five-second silent video', {
  skip: mediaToolsAvailable ? false : 'ffmpeg/ffprobe are unavailable',
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-execution-motion-real-'))
  try {
    const sourcePath = path.join(root, 'source.mp4')
    const outputPath = path.join(root, 'output', 'unit.mp4')
    const created = spawnSync(ffmpegPath, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      sourcePath,
    ], { encoding: 'utf8', windowsHide: true })
    assert.equal(created.status, 0, created.stderr)

    const evidence = materializeFuminExecutionMotion({
      sourcePath,
      outputPath,
      offsetMs: 0,
      keepDurationMs: 1000,
      providerDurationSeconds: 5,
    }, { ffmpegPath, ffprobePath })

    assert.ok(Math.abs(evidence.duration_seconds - 5) <= 0.1)
    assert.equal(evidence.probe.has_audio, false)
    assert.equal(evidence.probe.video_codec, 'h264')
    assert.equal(evidence.probe.pix_fmt, 'yuv420p')
    assert.equal(evidence.probe.frame_rate, 24)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
