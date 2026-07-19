import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendDirectorCamera,
  appendDirectorObject,
  duplicateDirectorObject,
  appendActionClip,
  appendShot,
  createDirectorTimeline,
  findActiveActionClips,
  findActiveShot,
  interpolateMotionTransform,
  normalizeDirectorTimeline,
  proportionalScaleFromAxis,
  removeDirectorObject,
  upsertMotionKeyframe,
  updateDirectorObject,
} from '../src/utils/directorTimeline.js'
import { buildCanvasLayoutPayload } from '../src/utils/canvasLayout.js'

const characters = [{ id: 1, name: '小满' }, { id: 2, name: '阿姨' }]

test('DR-002 项目角色自动进入统一导演场景对象', () => {
  const state = createDirectorTimeline(characters)
  const projectCharacters = state.objects.filter((object) => object.type === 'character')
  assert.deepEqual(projectCharacters.map((object) => object.name), ['小满', '阿姨'])
  assert.deepEqual(projectCharacters.map((object) => object.assetRef.characterId), ['1', '2'])
  assert.equal(normalizeDirectorTimeline(state, characters).objects.filter((object) => object.type === 'character').length, 2)
})

test('DR-002 项目删除角色后清理对应导演场景对象', () => {
  const initial = normalizeDirectorTimeline({
    ...createDirectorTimeline([{ id: 1, name: '角色A' }, { id: 2, name: '角色B' }]),
  }, [{ id: 1, name: '角色A' }, { id: 2, name: '角色B' }])
  const next = normalizeDirectorTimeline(initial, [{ id: 1, name: '角色A' }])
  assert.deepEqual(next.objects.filter((object) => object.assetRef?.kind === 'project-character').map((object) => object.name), ['角色A'])
})

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
    boneRotations: {},
  })
  assert.deepEqual(state.characterAssets['2'], { modelUrl: '', scale: 1, actions: {}, boneRotations: {} })
})

test('DR-007 骨骼关节旋转会标准化保存并过滤非法值', () => {
  const timeline = normalizeDirectorTimeline({
    ...createDirectorTimeline([{ id: 7, name: '演员' }]),
    characterAssets: {
      7: {
        modelUrl: '/actor.glb',
        boneRotations: { Spine: [0.1, 0.2, 0.3], Invalid: 'bad' },
      },
    },
  }, [{ id: 7, name: '演员' }])
  assert.deepEqual(timeline.characterAssets['7'].boneRotations, { Spine: [0.1, 0.2, 0.3] })
})

test('导演时间线 v1 会迁移到 v2 并生成稳定机位', () => {
  const state = normalizeDirectorTimeline({
    version: 1,
    sequence: { name: '旧序列' },
    shots: [{ id: 's1', camera: 'wide', duration: 2 }],
  })
  assert.equal(state.version, 2)
  assert.equal(state.shots[0].cameraId, 'legacy-camera-wide')
  assert.equal(state.sequence.activeCameraId, 'legacy-camera-wide')
  assert.equal(state.cameras[0].id, 'legacy-camera-wide')
})

test('导演时间线 v2 会修复循环层级和悬空相机引用', () => {
  const state = normalizeDirectorTimeline({
    version: 2,
    objects: [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ],
    cameras: [{ id: 'cam-1', fov: 60 }],
    shots: [{ id: 's1', cameraId: 'missing', duration: 2 }],
    extensions: { future: true },
  })
  assert.ok(state.objects.some((object) => object.parentId === ''))
  assert.equal(state.shots[0].cameraId, 'cam-1')
  assert.deepEqual(state.extensions, { future: true })
})

test('DR-003 场景对象命令支持新增、变换和级联删除', () => {
  let state = appendDirectorObject(createDirectorTimeline(), 'group', { id: 'group-1', name: '演员组' })
  state = appendDirectorObject(state, 'box', { id: 'box-1', parentId: 'group-1' })
  state = updateDirectorObject(state, 'box-1', { transform: { position: [1, 2, 3] } })
  assert.deepEqual(state.objects.find((object) => object.id === 'box-1').transform.position, [1, 2, 3])
  state = removeDirectorObject(state, 'group-1')
  assert.equal(state.objects.length, 0)
})

test('DR-005 删除相机对象会修复镜头引用', () => {
  let state = appendDirectorCamera(createDirectorTimeline(), { id: 'cam-custom', objectId: 'cam-object' })
  state = normalizeDirectorTimeline({ ...state, shots: [{ ...state.shots[0], cameraId: 'cam-custom' }] })
  state = removeDirectorObject(state, 'cam-object')
  assert.notEqual(state.shots[0].cameraId, 'cam-custom')
})

test('DR-005 相机方向与观察目标可标准化并在复制时保留', () => {
  let state = appendDirectorCamera(createDirectorTimeline(), {
    id: 'cam-captured',
    objectId: 'cam-captured-object',
    quaternion: [0.1, -0.2, 0.3, 0.9],
    target: [1, 2, 3],
  })
  state = duplicateDirectorObject(state, 'cam-captured-object')
  const duplicate = state.cameras.at(-1)
  assert.deepEqual(duplicate.quaternion, [0.1, -0.2, 0.3, 0.9])
  assert.deepEqual(duplicate.target, [1, 2, 3])

  const legacy = normalizeDirectorTimeline({ cameras: [{ id: 'legacy' }] }).cameras[0]
  assert.equal(legacy.quaternion, null)
  assert.deepEqual(legacy.target, [0, 0.8, 0])
})

test('DR-004 Shift 缩放按变化最大的轴保持原始比例', () => {
  assert.deepEqual(proportionalScaleFromAxis([1, 2, 3], [1, 4, 3]), [2, 4, 6])
  assert.deepEqual(proportionalScaleFromAxis([1, 1, 1], [0.5, 1, 1]), [0.5, 0.5, 0.5])
})

test('G005 全局场景参数可标准化并刷新恢复', () => {
  const state = normalizeDirectorTimeline({
    environment: {
      sceneScale: 3,
      scenePosition: [1, 2, 3],
      sceneRotation: [0.1, 0.2, 0.3],
      panoramaRotation: 45,
      panoramaRadius: 80,
      showCharacterLabels: false,
      gridSnap: true,
      groundSnap: false,
      showGround: false,
      groundOpacity: 0.35,
      groundHeight: -0.2,
    },
  })
  assert.equal(state.environment.sceneScale, 3)
  assert.deepEqual(state.environment.scenePosition, [1, 2, 3])
  assert.deepEqual(state.environment.sceneRotation, [0.1, 0.2, 0.3])
  assert.equal(state.environment.panoramaRotation, 45)
  assert.equal(state.environment.panoramaRadius, 80)
  assert.equal(state.environment.showCharacterLabels, false)
  assert.equal(state.environment.gridSnap, true)
  assert.equal(state.environment.groundSnap, false)
  assert.equal(state.environment.showGround, false)
  assert.equal(state.environment.groundOpacity, 0.35)
  assert.equal(state.environment.groundHeight, -0.2)
})

test('G005 时间轴循环模式可标准化保存', () => {
  const state = normalizeDirectorTimeline({ sequence: { loop: true } })
  assert.equal(state.sequence.loop, true)
  assert.equal(normalizeDirectorTimeline({ sequence: { loop: 'true' } }).sequence.loop, false)
})

test('G005 对象运动关键帧可新增、覆盖并线性插值', () => {
  let state = appendDirectorObject(createDirectorTimeline(), 'box', { id: 'moving-box' })
  state = upsertMotionKeyframe(state, 'moving-box', 0, { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
  state = upsertMotionKeyframe(state, 'moving-box', 4, { position: [4, 2, 0], rotation: [0, 1, 0], scale: [2, 2, 2] })
  assert.equal(state.motionTracks[0].keyframes.length, 2)
  assert.deepEqual(interpolateMotionTransform(state, 'moving-box', 2), { position: [2, 1, 0], rotation: [0, 0.5, 0], scale: [1.5, 1.5, 1.5] })
  state = upsertMotionKeyframe(state, 'moving-box', 4, { position: [8, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
  assert.equal(state.motionTracks[0].keyframes.length, 2)
  assert.deepEqual(interpolateMotionTransform(state, 'moving-box', 4).position, [8, 0, 0])
})

test('G005 程序化角色类型和素体种类随场景对象保存', () => {
  const state = appendDirectorObject(createDirectorTimeline(), 'humanoid', {
    id: 'role-1', name: '女性素体 1', assetRef: { kind: 'female' },
  })
  assert.equal(state.objects[0].type, 'humanoid')
  assert.equal(state.objects[0].name, '女性素体 1')
  assert.equal(state.objects[0].assetRef.kind, 'female')
  assert.equal(normalizeDirectorTimeline(state).objects[0].assetRef.kind, 'female')
})

test('DR-007 程序化角色姿势旋转随场景对象持久化', () => {
  let state = appendDirectorObject(createDirectorTimeline(), 'humanoid', { id: 'role-pose', assetRef: { kind: 'female' } })
  state = updateDirectorObject(state, 'role-pose', {
    poseRotations: { spine: [0.2, 0.1, 0], leftElbow: [1.4, 0, 0], rightKnee: [0.8, 0, 0] },
  })
  const restored = normalizeDirectorTimeline(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(restored.objects[0].poseRotations, {
    spine: [0.2, 0.1, 0], leftElbow: [1.4, 0, 0], rightKnee: [0.8, 0, 0],
  })
})

test('G005 AI 识图引用的地址、资产和描述可标准化保存', () => {
  const state = appendDirectorObject(createDirectorTimeline(), 'group', {
    id: 'ai-scene',
    assetRef: { kind: 'ai-scene-reference', url: '/uploads/ref.png', assetId: 42, description: '雨夜街道与霓虹灯' },
  })
  const restored = normalizeDirectorTimeline(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(restored.objects[0].assetRef, {
    kind: 'ai-scene-reference', url: '/uploads/ref.png', assetId: 42, description: '雨夜街道与霓虹灯',
  })
})

test('G005 场景对象锁定状态可保存并阻止默认丢失', () => {
  const state = appendDirectorObject(createDirectorTimeline(), 'box', { id: 'locked-box', locked: true })
  assert.equal(state.objects[0].locked, true)
  assert.equal(normalizeDirectorTimeline(JSON.parse(JSON.stringify(state))).objects[0].locked, true)
})

test('G005 相机跟随、注视与构图线状态可标准化保存', () => {
  const state = normalizeDirectorTimeline({ cameras: [{
    id: 'camera-follow', followTargetId: 'role-1', lookAtMode: 'object', lookAtTargetId: 'role-2', showGuides: true,
  }] })
  assert.equal(state.cameras[0].followTargetId, 'role-1')
  assert.equal(state.cameras[0].lookAtMode, 'object')
  assert.equal(state.cameras[0].lookAtTargetId, 'role-2')
  assert.equal(state.cameras[0].showGuides, true)
})

test('G005 时间线缩放和最小化状态可标准化保存', () => {
  const state = normalizeDirectorTimeline({ sequence: { timelineZoom: 2.5, timelineCollapsed: true } })
  assert.equal(state.sequence.timelineZoom, 2.5)
  assert.equal(state.sequence.timelineCollapsed, true)
  assert.equal(normalizeDirectorTimeline({ sequence: { timelineZoom: 20 } }).sequence.timelineZoom, 4)
})

test('DR-003 对象和机位复制使用新稳定 ID 并保留属性', () => {
  let state = appendDirectorObject(createDirectorTimeline(), 'box', { id: 'source-box', name: '道具', transform: { position: [1, 2, 3], rotation: [0, 1, 0], scale: [2, 2, 2] } })
  state = duplicateDirectorObject(state, 'source-box')
  assert.equal(state.objects.length, 2)
  assert.notEqual(state.objects[1].id, 'source-box')
  assert.equal(state.objects[1].name, '道具 副本')
  assert.deepEqual(state.objects[1].position, undefined)
  assert.deepEqual(state.objects[1].transform.position, [1.5, 2, 3.5])
})
