import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DIRECTOR_CAMERA_ASSETS,
  DIRECTOR_PROP_ASSETS,
  DIRECTOR_POSE_MIRROR_SECTIONS,
  DIRECTOR_SCENE_TEMPLATES,
  DIRECTOR_SPEED_PRESETS,
  appendConfiguredCrowd,
  isDirectorTouchpadGesture,
  releaseDirectorGroup,
} from '../src/utils/director-parity.js'
import {
  appendDirectorObject,
  createDirectorTimeline,
  normalizeDirectorTimeline,
} from '../src/utils/directorTimeline.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const stageSource = fs.readFileSync(path.join(here, '../src/components/dramaCanvas/CanvasDirectorStage.vue'), 'utf8')

test('参考站资产库提供完整道具、机位和场景模板', () => {
  assert.deepEqual(DIRECTOR_PROP_ASSETS.map((asset) => asset.name), [
    '椅子', '方桌', '圆桌', '沙发', '墙段 2m', '墙段 3m', '柱子', '楼梯段', '小树', '大树',
    '石头', '灌木', '轿车', '自行车', '路灯', '长椅', '垃圾桶', '方向箭头', '区域标记', '图片板',
  ])
  assert.deepEqual(DIRECTOR_CAMERA_ASSETS.map((asset) => asset.name), [
    '正面中景', '正面特写', '正面全景', '侧面跟拍', '侧面近景', '背面中景', '俯拍全景', '45° 俯拍',
    '低角度仰拍', '低角度广角', '过肩镜头', '过肩镜头 (右)', '鸟瞰', '荷兰角', '远景跟踪', 'POV 第一视角',
  ])
  assert.deepEqual(DIRECTOR_SCENE_TEMPLATES.map((template) => template.name), [
    '空白场景', '单人口播', '产品讲解', '展板讲解', '双人对话', '访谈节目', '街头采访', '圆桌讨论',
    '课堂教学', '舞台演讲', '新闻发布会', '咖啡厅会面', '公园小憩', '街头同行', '街头道别',
    '车内对话', '追逐戏', '对峙打斗', '舞蹈表演', '庆祝时刻',
  ])
})

test('群众阵列按行列和间距生成可解散的真实分组', () => {
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

test('参考站动画速度预设和导演台主交互全部有可操作入口', () => {
  assert.deepEqual(DIRECTOR_SPEED_PRESETS.map((preset) => preset.name), [
    '无', '自定义', '蒙太奇', '英雄时刻', '子弹时间', '跳接', '闪进', '闪出',
  ])
  for (const label of [
    '大纲', '资产', 'AI识图', '+ 人物', '+ 机位', '+ 新建组', '+ 群众阵列', '解散分组',
    '显示标签', '字体大小', '底部标识', '机位辅助线', '动画(BATE)', '新建轨道',
    '保存当前', '删除当前', '整段循环', '镜头循环', '观察机位', '跟随镜头',
    '人物帧', '缓动曲线 / 参数', '确认构图', '导入模板 JSON',
  ]) {
    assert.ok(stageSource.includes(label), `缺少参考站交互：${label}`)
  }
  assert.deepEqual(DIRECTOR_POSE_MIRROR_SECTIONS.map((section) => section.label), [
    '手臂', '前臂', '手腕', '腿部', '小腿', '脚踝',
  ])
  assert.ok(stageSource.includes('mirrorPoseLeftToRight(section)'))
  assert.ok(stageSource.includes('orbitDirectorViewByDelta'))
})

test('触控板双指滑动与鼠标滚轮使用不同相机交互', () => {
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

test('导演状态保存标签、播放和关键帧参数', () => {
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
    environment: {
      ...state.environment,
      showObjectLabels: false,
      labelFontSize: 24,
      showBottomIds: true,
      showCameraGuides: true,
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
  assert.equal(state.environment.showObjectLabels, false)
  assert.equal(state.environment.labelFontSize, 24)
  assert.equal(state.environment.showBottomIds, true)
  assert.equal(state.environment.showCameraGuides, true)
  assert.deepEqual(
    (({ easing, speedPreset, pathMode, roll }) => ({ easing, speedPreset, pathMode, roll }))(state.motionTracks[0].keyframes[0]),
    { easing: 'ease-in-out', speedPreset: '英雄时刻', pathMode: 'curve', roll: 12 },
  )
})
