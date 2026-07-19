import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import {
  appendActionClip,
  normalizeDirectorTimeline,
  updateDirectorObject,
} from '../src/utils/directorTimeline.js'

function percentile95(values) {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)]
}

function makePressureFixture() {
  const characters = Array.from({ length: 20 }, (_, index) => ({ id: `character-${index}`, name: `角色 ${index}` }))
  const objects = Array.from({ length: 100 }, (_, index) => ({
    id: `object-${index}`,
    type: index < 20 ? 'camera' : 'box',
    name: `对象 ${index}`,
    transform: { position: [index, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }))
  const cameras = objects.slice(0, 20).map((object, index) => ({
    id: `camera-${index}`,
    objectId: object.id,
    name: `机位 ${index}`,
    fov: 50,
    aspect: 16 / 9,
  }))
  const clips = Array.from({ length: 200 }, (_, index) => ({
    id: `clip-${index}`,
    characterId: `character-${index % characters.length}`,
    action: 'Idle',
    start: index % 100,
    duration: 2,
  }))
  const tracks = characters.map((character) => ({
    id: `track-${character.id}`,
    characterId: character.id,
    clips: clips.filter((clip) => clip.characterId === character.id),
  }))
  return {
    characters,
    state: {
      version: 2,
      sequence: { duration: 100, fps: 24 },
      shots: [{ id: 'shot-1', name: '压力镜头', duration: 100, camera: 'director', cameraId: 'camera-0' }],
      objects,
      cameras,
      tracks,
    },
  }
}

test('DR-014 100 场景对象加 20 项目角色、20 相机、200 片段满足性能门', (context) => {
  const { characters, state } = makePressureFixture()
  const worstRounds = []
  const serializationRounds = []
  let normalized

  for (let round = 0; round < 5; round += 1) {
    normalized = normalizeDirectorTimeline(state, characters)
    assert.equal(normalized.objects.length, 120)
    assert.equal(normalized.cameras.length, 20)
    assert.equal(normalized.tracks.reduce((sum, track) => sum + track.clips.length, 0), 200)

    const commandSamples = []
    for (let index = 0; index < 100; index += 1) {
      const startedAt = performance.now()
      normalized = updateDirectorObject(normalized, `object-${index}`, { name: `第 ${round}-${index} 次更新` })
      commandSamples.push(performance.now() - startedAt)
    }
    const appendStartedAt = performance.now()
    normalized = appendActionClip(normalized, 'character-0', 'Walk', { start: 1, duration: 2 })
    commandSamples.push(performance.now() - appendStartedAt)
    worstRounds.push(percentile95(commandSamples))

    const serializationSamples = []
    for (let index = 0; index < 20; index += 1) {
      const startedAt = performance.now()
      const json = JSON.stringify(normalized)
      serializationSamples.push(performance.now() - startedAt)
      assert.ok(Buffer.byteLength(json, 'utf8') < 2 * 1024 * 1024)
      assert.doesNotMatch(json, /data:application\/octet-stream|ArrayBuffer|Uint8Array/)
    }
    serializationRounds.push(percentile95(serializationSamples))
  }

  const worstCommandP95 = Math.max(...worstRounds)
  const worstSerializationP95 = Math.max(...serializationRounds)
  context.diagnostic(`五轮最差命令 p95=${worstCommandP95.toFixed(2)}ms；五轮最差序列化 p95=${worstSerializationP95.toFixed(2)}ms`)
  assert.ok(worstCommandP95 < 50, `五轮最差命令 p95 ${worstCommandP95.toFixed(2)}ms`)
  assert.ok(worstSerializationP95 < 100, `五轮最差序列化 p95 ${worstSerializationP95.toFixed(2)}ms`)
})
