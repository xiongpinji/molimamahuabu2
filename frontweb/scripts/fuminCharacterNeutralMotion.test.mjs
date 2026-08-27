import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCharacterNeutralFilter,
  buildCharacterNeutralMotionArgs,
  validateCharacterNeutralMotionProbe,
} from './fuminCharacterNeutralMotion.mjs'

test('身份中性动作参考固定使用 9:16 全帧强降采样模糊灰度滤镜', () => {
  assert.equal(buildCharacterNeutralFilter(), [
    'scale=496:864:force_original_aspect_ratio=decrease',
    'pad=496:864:(ow-iw)/2:(oh-ih)/2',
    'scale=124:216:flags=area',
    'gblur=sigma=12:steps=3',
    'scale=496:864:flags=neighbor',
    'format=gray',
    'fps=24',
  ].join(','))
})

test('动作参考命令只读指定时间段、去音轨并输出 H.264', () => {
  const args = buildCharacterNeutralMotionArgs({
    sourcePath: 'C:/private/source.mp4',
    outputPath: 'C:/private/shot-01.mp4',
    startMs: 0,
    durationMs: 8000,
  })
  assert.deepEqual(args.slice(0, 8), [
    '-hide_banner', '-loglevel', 'error', '-ss', '0.000', '-i', 'C:/private/source.mp4', '-t',
  ])
  assert.equal(args[8], '8.000')
  assert.ok(args.includes('-an'))
  assert.ok(args.includes('libx264'))
  assert.ok(args.includes('yuv420p'))
  assert.equal(args.at(-1), 'C:/private/shot-01.mp4')
})

test('只有可读 496x864、24fps、无音轨、时长匹配的参考才进入人工审核', () => {
  const accepted = validateCharacterNeutralMotionProbe({
    duration_seconds: 8.01,
    width: 496,
    height: 864,
    frame_rate: 24,
    video_codec: 'h264',
    has_audio: false,
  }, 8000)
  assert.deepEqual(accepted, {
    duration_seconds: 8.01,
    width: 496,
    height: 864,
    frame_rate: 24,
    video_codec: 'h264',
    has_audio: false,
    privacy_transform_scope: 'full_frame',
    source_identity_obscured: true,
    source_text_obscured: true,
    review_status: 'pending',
  })

  for (const probe of [
    { ...accepted, width: 495 },
    { ...accepted, height: 863 },
    { ...accepted, frame_rate: 30 },
    { ...accepted, has_audio: true },
    { ...accepted, duration_seconds: 7.5 },
  ]) {
    assert.throws(
      () => validateCharacterNeutralMotionProbe(probe, 8000),
      /FUMIN_CHARACTER_NEUTRAL_MOTION_PROBE_FAILED/,
    )
  }
})
