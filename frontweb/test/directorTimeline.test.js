import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendActionClip,
  appendShot,
  createDirectorTimeline,
  findActiveActionClips,
  findActiveShot,
  normalizeDirectorTimeline,
} from '../src/utils/directorTimeline.js'
import { buildCanvasLayoutPayload } from '../src/utils/canvasLayout.js'

const characters = [{ id: 1, name: '小满' }, { id: 2, name: '阿姨' }]

test('导演时间线会按镜头顺序重算切点和总时长', () => {
  const state = normalizeDirectorTimeline({
    shots: [
      { id: 'a', name: '开场', duration: 2 },
      { id: 'b', name: '反打', duration: 3, transition: 'dissolve', transitionDuration: 0.5 },
    ],
  }, characters)

  assert.deepEqual(state.shots.map((shot) => shot.start), [0, 2])
  assert.equal(state.sequence.duration, 5)
  assert.equal(state.shots[1].transition, 'dissolve')
  assert.equal(state.shots[1].transitionDuration, 0.5)
})

test('镜头和动作片段可保存后重新标准化恢复', () => {
  const original = appendActionClip(
    appendShot(createDirectorTimeline(characters), { name: '转场镜头', transition: 'wipe', transitionDuration: 0.75 }),
    '2',
    'Wave',
    { start: 4, duration: 1.5 },
  )

  const restored = normalizeDirectorTimeline(JSON.parse(JSON.stringify(original)), characters)
  assert.equal(restored.shots.length, 2)
  assert.equal(restored.shots[1].start, 4)
  assert.equal(restored.shots[1].transition, 'wipe')
  assert.deepEqual(restored.tracks.find((track) => track.characterId === '2').clips.at(-1), {
    id: original.tracks.find((track) => track.characterId === '2').clips.at(-1).id,
    characterId: '2',
    action: 'Wave',
    start: 4,
    duration: 1.5,
  })
})

test('可按时间找到活动镜头和角色动作片段', () => {
  const state = appendActionClip(
    createDirectorTimeline(characters),
    '1',
    'Run',
    { start: 1, duration: 2 },
  )

  assert.equal(findActiveShot(state, 0.5).name, '镜头 1')
  assert.equal(findActiveShot(appendShot(state), 4.1).name, '镜头 2')
  assert.equal(findActiveActionClips(state, 1.5).some((clip) => clip.action === 'Run'), true)
  assert.equal(findActiveActionClips(state, 0.5).length, 1)
})

test('画布布局保存时保留导演时间线', () => {
  const directorTimeline = createDirectorTimeline(characters)
  const payload = buildCanvasLayoutPayload(
    [{ id: 'node-1', type: 'canvasScript', position: { x: 12, y: 24 } }],
    { x: 1, y: 2, zoom: 0.8 },
    { director_timeline: directorTimeline },
  )

  assert.deepEqual(payload.director_timeline, directorTimeline)
  assert.deepEqual(payload.nodes['node-1'], { x: 12, y: 24 })
})

test('真实模型与动作资源会随导演时间线标准化保存', () => {
  const state = normalizeDirectorTimeline({
    characterAssets: {
      1: {
        model_url: 'https://cdn.example/xiaoman.glb',
        model_asset_id: 17,
        scale: 2,
        actions: {
          Run: { action_url: 'https://cdn.example/run.glb', clip_name: 'RunFast', asset_id: 23 },
        },
      },
    },
  }, characters)

  assert.deepEqual(state.characterAssets['1'], {
    modelUrl: 'https://cdn.example/xiaoman.glb',
    modelAssetId: 17,
    scale: 2,
    actions: { Run: { url: 'https://cdn.example/run.glb', clipName: 'RunFast', assetId: 23 } },
  })
  assert.deepEqual(state.characterAssets['2'], { modelUrl: '', scale: 1, actions: {} })
})
