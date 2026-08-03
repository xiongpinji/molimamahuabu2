import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  DIRECTOR_CAMERA_ASSETS,
  DIRECTOR_PERSON_ASSETS,
  DIRECTOR_POSE_CONTROLS,
  DIRECTOR_PROP_ASSETS,
  appendConfiguredCrowd,
  isDirectorTouchpadGesture,
  releaseDirectorGroup,
} from '../src/utils/director-parity.js'
import {
  appendDirectorObject,
  createDirectorTimeline,
  normalizeDirectorTimeline,
} from '../src/utils/directorTimeline.js'

const stageSource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/CanvasDirectorStage.vue', import.meta.url)), 'utf8')

test('核心导演台资产常量覆盖人物、道具、机位和姿势控制', () => {
  assert.deepEqual(DIRECTOR_PROP_ASSETS.map((asset) => asset.name), [
    '椅子', '方桌', '圆桌', '沙发', '墙段 2m', '墙段 3m', '柱子', '楼梯段', '小树', '大树',
    '石头', '灌木', '轿车', '自行车', '路灯', '长椅', '垃圾桶', '方向箭头', '区域标记', '图片板',
  ])
  assert.deepEqual(DIRECTOR_CAMERA_ASSETS.map((asset) => asset.name), [
    '正面中景', '正面特写', '正面全景', '侧面跟拍', '侧面近景', '背面中景', '俯拍全景', '45° 俯拍',
    '低角度仰拍', '低角度广角', '过肩镜头', '过肩镜头 (右)', '鸟瞰', '荷兰角', '远景跟踪', 'POV 第一视角',
  ])
  assert.deepEqual(DIRECTOR_PERSON_ASSETS.map((asset) => asset.name), [
    '标准素体', '女性素体', '儿童素体', '壮实素体', '纤细素体', '群众 (3人)', '群众 (5人)',
  ])
  assert.equal(DIRECTOR_POSE_CONTROLS.length, 33)
  for (const label of ['身体前倾', '头部转头', '左肩前举', '右肘弯曲', '左膝弯曲', '右踝内外翻']) {
    assert.ok(DIRECTOR_POSE_CONTROLS.some((control) => control.label === label), `缺少姿势控制：${label}`)
  }
})

test('群众阵列生成可解散的真实分组对象', () => {
  const crowded = appendConfiguredCrowd(createDirectorTimeline(), { rows: 2, columns: 4, spacing: 1.5 })
  const group = crowded.objects.find((object) => object.type === 'group')
  const people = crowded.objects.filter((object) => object.type === 'humanoid')

  assert.equal(group.name, '群众组1')
  assert.equal(people.length, 8)
  assert.ok(people.every((person) => person.parentId === group.id))
  assert.deepEqual(people.at(-1).transform.position, [2.25, 0, 0.75])

  const released = releaseDirectorGroup(crowded, group.id)
  assert.equal(released.objects.some((object) => object.id === group.id), false)
  assert.equal(released.objects.filter((object) => object.type === 'humanoid').length, 8)
  assert.ok(released.objects.every((object) => object.parentId !== group.id))
})

test('相机注视模式支持不锁定、手动坐标和对象目标', () => {
  const manual = normalizeDirectorTimeline({ cameras: [{ id: 'manual-look-at', lookAtMode: 'manual', target: [1.25, 2.5, -3.75] }] })
  assert.equal(manual.cameras[0].lookAtMode, 'manual')
  assert.deepEqual(manual.cameras[0].target, [1.25, 2.5, -3.75])

  const none = normalizeDirectorTimeline({ cameras: [{ id: 'free-camera', lookAtMode: 'none' }] })
  assert.equal(none.cameras[0].lookAtMode, 'none')

  assert.ok(stageSource.includes('<option value="none">不锁定</option>'))
  assert.ok(stageSource.includes('<option value="manual">手动坐标</option>'))
  assert.ok(stageSource.includes('updateCameraTarget(index, $event.target.value)'))
  assert.match(stageSource, /function updateCameraLookAtSelection\(value\)/)
})

test('核心人物变换、姿势、机位和灯光交互保留真实入口', () => {
  for (const label of ['移动工具', '旋转工具', '缩放工具', '角色姿势', '构图预设', '灯光列表', '添加灯光']) {
    assert.ok(stageSource.includes(label), `缺少导演台交互：${label}`)
  }
  assert.match(stageSource, /function directorStageObjectForSelection\(object\)/)
  assert.match(stageSource, /transformControls\.addEventListener\('mouseUp', persistTransformControlChange\)/)
  assert.match(stageSource, /function persistBoneRotations/)
  assert.match(stageSource, /function updateCameraAngle\(field, value\)/)
  assert.match(stageSource, /function updateSelectedLight\(field, value\)/)
  assert.match(stageSource, /name: '三点布光'[\s\S]*主光[\s\S]*辅光[\s\S]*轮廓光/)
})

test('触控板双指滑动与鼠标滚轮使用不同相机交互判定', () => {
  assert.equal(isDirectorTouchpadGesture({ deltaX: 12, deltaY: 0, deltaMode: 0 }), true)
  assert.equal(isDirectorTouchpadGesture({ deltaX: 0, deltaY: 8, deltaMode: 0 }), true)
  assert.equal(isDirectorTouchpadGesture({ deltaX: 0, deltaY: 100, deltaMode: 0 }), false)
  assert.equal(isDirectorTouchpadGesture({ deltaX: 0, deltaY: 3, deltaMode: 1 }), false)
})

test('窄屏仍展示属性检查器并覆盖在视口右侧', () => {
  const narrowStyles = stageSource.slice(stageSource.indexOf('@media (max-width: 680px)'))
  assert.doesNotMatch(narrowStyles, /\.director-stage__inspector\s*\{\s*display:\s*none/)
  assert.match(narrowStyles, /\.director-stage__inspector\s*\{[^}]*position:\s*absolute[^}]*display:\s*block/)
})

test('导演状态保存播放、关键帧和相机预设参数', () => {
  let state = appendDirectorObject(createDirectorTimeline(), 'box', { id: 'prop-1', name: '方桌' })
  state = normalizeDirectorTimeline({
    ...state,
    sequence: {
      ...state.sequence,
      playbackRate: 1.5,
      shotLoop: true,
      animationViewMode: 'follow',
      orientationMode: 'path',
    },
    motionTracks: [{
      id: 'track-1',
      objectId: 'prop-1',
      keyframes: [{
        id: 'kf-1',
        time: 0,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        easing: 'ease-in-out',
        speedPreset: '英雄时刻',
        pathMode: 'curve',
        roll: 12,
      }],
    }],
  })

  assert.equal(state.sequence.playbackRate, 1.5)
  assert.equal(state.sequence.shotLoop, true)
  assert.equal(state.sequence.animationViewMode, 'follow')
  assert.equal(state.sequence.orientationMode, 'path')
  assert.deepEqual(
    (({ easing, speedPreset, pathMode, roll }) => ({ easing, speedPreset, pathMode, roll }))(state.motionTracks[0].keyframes[0]),
    { easing: 'ease-in-out', speedPreset: '英雄时刻', pathMode: 'curve', roll: 12 },
  )
})
