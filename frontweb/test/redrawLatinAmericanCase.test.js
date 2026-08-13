import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildLocalIdentityPackInput,
  buildLocalCaseManifest,
  redrawLatinAmericanCase,
  validateSourceProbe,
} from '../e2e/fixtures/redraw-latin-american-case.js'

const fixtureRoot = fileURLToPath(new URL('../e2e/fixtures/redraw-latin-american-case/', import.meta.url))
const actorReferencePath = path.join(fixtureRoot, 'actor-cast-reference.png')

test('C 方案锁定用户指定源片的媒体合同', () => {
  assert.equal(
    redrawLatinAmericanCase.source.sha256,
    '24eb1d8ba3ff11e6aa3e547b7ac400f6b177dcf541d1af36354d3e46cc05e9ae',
  )
  assert.equal(redrawLatinAmericanCase.source.duration_ms, 68_733)
  assert.equal(redrawLatinAmericanCase.source.duration_tolerance_ms, 50)
  assert.deepEqual(redrawLatinAmericanCase.source.video, {
    width: 720,
    height: 1280,
    codec: 'hevc',
    frame_rate: 30,
  })
  assert.deepEqual(redrawLatinAmericanCase.source.audio, {
    codec: 'aac',
    channels: 1,
    sample_rate: 44_100,
  })
})

test('C 方案时间轴连续覆盖完整源片并映射为 69 秒供应商片段', () => {
  const shots = redrawLatinAmericanCase.sourceFacts.shots
  assert.equal(shots.length, 9)
  assert.equal(shots[0].start_ms, 0)
  assert.equal(shots.at(-1).end_ms, 68_733)
  assert.equal(
    shots.every((shot, index) => index === 0 || shots[index - 1].end_ms === shot.start_ms),
    true,
  )
  assert.equal(
    redrawLatinAmericanCase.generationDurations.reduce((sum, duration) => sum + duration, 0),
    69,
  )
  assert.equal(
    Object.keys(redrawLatinAmericanCase.shotPrompts).length,
    shots.length,
  )
})

test('C 方案固定成年拉美演员并使用美式英语', () => {
  assert.equal(redrawLatinAmericanCase.cast.length, 4)
  assert.equal(redrawLatinAmericanCase.cast.every((actor) => actor.age_min >= 18), true)
  assert.deepEqual(redrawLatinAmericanCase.cast.map((actor) => actor.id), [
    'mateo',
    'diego',
    'elena',
    'rafael',
  ])
  assert.deepEqual(redrawLatinAmericanCase.target, {
    language: 'en',
    locale: 'en-US',
    market: 'US',
    cast_direction: 'latin-american',
  })
  for (const prompt of Object.values(redrawLatinAmericanCase.shotPrompts)) {
    assert.match(prompt, /fixed Latino actor/i)
  }
})

test('C 方案为每个目标演员提供完整身份包输入', () => {
  for (const actor of redrawLatinAmericanCase.cast) {
    assert.deepEqual(buildLocalIdentityPackInput(actor), {
      target_actor_label: actor.target_name,
      confirmed_views: ['front', 'profile', 'full_body'],
      live_action_human_confirmed: true,
      adult_status: 'verified_18_plus',
      identity_consistency_confirmed: true,
    })
  }
})

test('C 方案演员概念图固定为已批准的照片级参考', () => {
  const bytes = fs.readFileSync(actorReferencePath)
  assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG')
  assert.equal(bytes.readUInt32BE(16), 941)
  assert.equal(bytes.readUInt32BE(20), 1672)
  assert.equal(
    crypto.createHash('sha256').update(bytes).digest('hex'),
    '35b1f9f65d819b12b11f61e17720f202a6ebb4292660a7fe93ec55fedddc319e',
  )
})

test('本地案例清单默认明确否认真实演员替换已验证', () => {
  assert.deepEqual(buildLocalCaseManifest().verification, {
    source_upload_verified: false,
    workflow_contract_verified: false,
    visual_actor_replacement_verified: false,
    provider_mode: 'local_fixture',
  })
})

test('本地案例媒体校验接受完全匹配的 FFprobe 摘要', () => {
  assert.deepEqual(validateSourceProbe({
    sha256: redrawLatinAmericanCase.source.sha256,
    duration_ms: 68_733.333,
    video: { width: 720, height: 1280, codec: 'hevc', frame_rate: 30 },
    audio: { codec: 'aac', channels: 1, sample_rate: 44_100 },
  }), {
    sha256: redrawLatinAmericanCase.source.sha256,
    duration_ms: 68_733.333,
    width: 720,
    height: 1280,
    video_codec: 'hevc',
    frame_rate: 30,
    audio_codec: 'aac',
    channels: 1,
    sample_rate: 44_100,
  })
})

for (const [name, mutate, pattern] of [
  ['哈希', (probe) => { probe.sha256 = '0'.repeat(64) }, /SHA-256/],
  ['时长', (probe) => { probe.duration_ms = 60_000 }, /时长/],
  ['尺寸', (probe) => { probe.video.width = 1280 }, /尺寸/],
  ['视频编码', (probe) => { probe.video.codec = 'h264' }, /视频编码/],
  ['帧率', (probe) => { probe.video.frame_rate = 25 }, /帧率/],
  ['音频流', (probe) => { probe.audio = null }, /音频流/],
]) {
  test(`本地案例媒体校验拒绝错误${name}`, () => {
    const probe = structuredClone({
      sha256: redrawLatinAmericanCase.source.sha256,
      duration_ms: 68_733.333,
      video: { width: 720, height: 1280, codec: 'hevc', frame_rate: 30 },
      audio: { codec: 'aac', channels: 1, sample_rate: 44_100 },
    })
    mutate(probe)
    assert.throws(() => validateSourceProbe(probe), pattern)
  })
}

test('package 提供 C 方案本地案例运行命令', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    fileURLToPath(new URL('../package.json', import.meta.url)),
    'utf8',
  ))
  assert.equal(
    packageJson.scripts['test:e2e:redraw-latam-case'],
    'node scripts/run-redraw-latin-american-case.mjs',
  )
})
