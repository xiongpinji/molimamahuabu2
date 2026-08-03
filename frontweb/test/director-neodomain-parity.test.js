import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { normalizeDirectorTimeline } from '../src/utils/directorTimeline.js'

const stageSource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/CanvasDirectorStage.vue', import.meta.url)), 'utf8')
const timelineSource = readFileSync(fileURLToPath(new URL('../src/utils/directorTimeline.js', import.meta.url)), 'utf8')

test('相机注视模式支持不锁定、手动坐标、对象目标和旧 origin 兼容', () => {
  const manual = normalizeDirectorTimeline({ cameras: [{ id: 'manual-look-at', lookAtMode: 'manual', target: [1.25, 2.5, -3.75] }] })
  assert.equal(manual.cameras[0].lookAtMode, 'manual')
  assert.deepEqual(manual.cameras[0].target, [1.25, 2.5, -3.75])

  const none = normalizeDirectorTimeline({ cameras: [{ id: 'free-camera', lookAtMode: 'none' }] })
  assert.equal(none.cameras[0].lookAtMode, 'none')

  const legacy = normalizeDirectorTimeline({ cameras: [{ id: 'legacy-camera', lookAtMode: 'origin', target: [0, 0.8, 0] }] })
  assert.equal(legacy.cameras[0].lookAtMode, 'manual')

  assert.ok(stageSource.includes('<option value="none">不锁定</option>'))
  assert.ok(stageSource.includes('<option value="manual">手动坐标</option>'))
  assert.ok(stageSource.includes(':value="cameraLookAtSelection"'))
  assert.ok(stageSource.includes('updateCameraTarget(index, $event.target.value)'))
  assert.match(stageSource, /function updateCameraLookAtSelection\(value\)/)
  assert.match(stageSource, /const cameraLookAtObjects = computed\(\(\) => cameraTargetObjects\.value\)/)
  assert.match(stageSource, /const keepsTargetLocked = Boolean\(lookAtObject\) \|\| boundCamera\.lookAtMode === 'manual'/)
  assert.match(timelineSource, /value\.lookAtMode === 'origin'[\s\S]*\? 'manual'/)
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

test('窄屏仍展示属性检查器并覆盖在视口右侧', () => {
  const narrowStyles = stageSource.slice(stageSource.indexOf('@media (max-width: 680px)'))
  assert.doesNotMatch(narrowStyles, /\.director-stage__inspector\s*\{\s*display:\s*none/)
  assert.match(narrowStyles, /\.director-stage__inspector\s*\{[^}]*position:\s*absolute[^}]*display:\s*block/)
})
