import { test, expect } from '@playwright/test'
import { fulfillEmptyProjectAssets, fulfillMockDrama } from './mockDrama.js'

function baseTimeline(objects = [], cameras = []) {
  return {
    version: 2,
    sequence: { duration: 4, fps: 24, activeCameraId: cameras[0]?.id || '' },
    shots: [{
      id: 'parity-shot', name: '功能对齐镜头', camera: 'director', cameraId: cameras[0]?.id || '',
      transition: 'cut', start: 0, duration: 4,
    }],
    objects,
    cameras,
    tracks: [],
    characterAssets: {},
    motionTracks: [],
  }
}

async function openDirector(page) {
  await page.goto('/film/3/canvas')
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  await expect(page.getByRole('dialog', { name: '3D 导演台' })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'director-parity-session',
      user: { id: 'director-parity-user', email: 'director@example.com', role: 'user' },
    }))
  })
  await page.route('**/api/v1/assets?**', (route) => fulfillEmptyProjectAssets(route))
})

test('人物根对象位置编辑会整体保存且不破坏姿势数据', async ({ page }) => {
  const savedTimelines = []
  const timeline = baseTimeline([{
    id: 'movable-role', type: 'humanoid', name: '可移动人物', visible: true, locked: false,
    assetRef: { kind: 'female' },
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }])
  await page.route('**/api/v1/dramas/3', (route) => fulfillMockDrama(route, timeline, { characters: [] }))
  await page.route('**/api/v1/dramas/3/canvas-layout', async (route) => {
    savedTimelines.push(route.request().postDataJSON().canvas_layout.director_timeline)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) })
  })

  await openDirector(page)
  await page.getByRole('button', { name: /可移动人物 humanoid/ }).click()
  await page.getByLabel('视口变换工具').getByRole('button', { name: '移动工具' }).click()
  const canvasBox = await page.locator('canvas.director-stage__canvas').boundingBox()
  expect(canvasBox).not.toBeNull()
  const beforeDragSaves = savedTimelines.length
  for (const yRatio of [0.75, 0.7, 0.8, 0.65, 0.85]) {
    const startX = canvasBox.x + canvasBox.width / 2 + 20
    await page.mouse.move(startX, canvasBox.y + canvasBox.height * yRatio)
    await page.mouse.down()
    await page.mouse.move(startX + 60, canvasBox.y + canvasBox.height * yRatio, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    const position = savedTimelines.at(-1)?.objects.find((object) => object.id === 'movable-role')?.transform.position || []
    if (position.some((value) => Math.abs(value) > 1e-4)) break
  }
  expect(savedTimelines.length).toBeGreaterThan(beforeDragSaves)
  expect(savedTimelines.at(-1).objects.find((object) => object.id === 'movable-role').transform.position.some((value) => Math.abs(value) > 1e-4)).toBe(true)

  const positionGroup = page.getByLabel('属性检查器').locator('.inspector-group').filter({ hasText: '位置（米）' }).first()
  await positionGroup.locator('input').first().fill('1.5')
  await positionGroup.locator('input').first().dispatchEvent('change')

  await expect.poll(() => savedTimelines.at(-1)?.objects.find((object) => object.id === 'movable-role')?.transform.position[0]).toBe(1.5)
  expect(savedTimelines.at(-1).objects.find((object) => object.id === 'movable-role').poseRotations).toEqual({})
})

test('摄影机角度调节实时更新机位位置并保存角度和方向', async ({ page }) => {
  const savedTimelines = []
  const cameraObject = {
    id: 'angle-camera-object', type: 'camera', name: '角度机位', visible: true, locked: false,
    transform: { position: [0, 1.8, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }
  const camera = {
    id: 'angle-camera', objectId: cameraObject.id, name: '角度机位', fov: 50, aspect: 16 / 9,
    near: 0.1, far: 1000, target: [0, 1, 0], azimuth: 0, elevation: 9.09, distance: 5.06, roll: 0,
  }
  const timeline = baseTimeline([cameraObject], [camera])
  await page.route('**/api/v1/dramas/3', (route) => fulfillMockDrama(route, timeline, { characters: [] }))
  await page.route('**/api/v1/dramas/3/canvas-layout', async (route) => {
    savedTimelines.push(route.request().postDataJSON().canvas_layout.director_timeline)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) })
  })

  await openDirector(page)
  await page.getByRole('button', { name: /角度机位 camera/ }).click()
  await page.getByLabel('方位角（°）').fill('90')
  await page.getByLabel('仰角（°）').fill('30')
  await page.getByLabel('横滚角（°）').fill('-18')

  await expect.poll(() => savedTimelines.at(-1)?.cameras.find((entry) => entry.id === camera.id)?.roll).toBe(-18)
  const savedCamera = savedTimelines.at(-1).cameras.find((entry) => entry.id === camera.id)
  const savedObject = savedTimelines.at(-1).objects.find((entry) => entry.id === cameraObject.id)
  expect(savedCamera.azimuth).toBe(90)
  expect(savedCamera.elevation).toBe(30)
  expect(savedCamera.quaternion).toHaveLength(4)
  expect(savedObject.transform.position[0]).toBeGreaterThan(4)
})

test('三点布光创建三盏真实灯光并支持强度和颜色实时保存', async ({ page }) => {
  const savedTimelines = []
  const timeline = baseTimeline()
  await page.route('**/api/v1/dramas/3', (route) => fulfillMockDrama(route, timeline, { characters: [] }))
  await page.route('**/api/v1/dramas/3/canvas-layout', async (route) => {
    savedTimelines.push(route.request().postDataJSON().canvas_layout.director_timeline)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) })
  })

  await openDirector(page)
  await page.getByRole('button', { name: '三点布光', exact: true }).click()
  await expect.poll(() => savedTimelines.at(-1)?.objects.filter((object) => object.type === 'light').length).toBe(3)
  expect(savedTimelines.at(-1).objects.filter((object) => object.type === 'light').map((object) => object.name)).toEqual(['主光', '辅光', '轮廓光'])

  await page.getByLabel('灯光强度').fill('6.5')
  await page.getByRole('button', { name: '霓虹粉' }).click()
  await expect.poll(() => savedTimelines.at(-1)?.objects.find((object) => object.name === '主光')?.light.color).toBe('#ff4fd8')
  expect(savedTimelines.at(-1).objects.find((object) => object.name === '主光').light.intensity).toBe(6.5)
})

test('参考站资产、群众、体型姿势、关键帧和标签设置进入真实保存链', async ({ page }) => {
  const savedTimelines = []
  const timeline = baseTimeline([{
    id: 'parity-role', type: 'humanoid', name: '对齐人物', visible: true, locked: false,
    assetRef: { kind: 'male' },
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  }])
  await page.route('**/api/v1/dramas/3', (route) => fulfillMockDrama(route, timeline, { characters: [] }))
  await page.route('**/api/v1/dramas/3/canvas-layout', async (route) => {
    savedTimelines.push(route.request().postDataJSON().canvas_layout.director_timeline)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) })
  })

  await openDirector(page)
  await page.getByRole('button', { name: '资产', exact: true }).click()
  await expect(page.locator('.director-asset-card')).toHaveCount(20)
  await page.locator('.director-asset-card').filter({ hasText: '椅子' }).click()
  await expect.poll(() => savedTimelines.at(-1)?.objects.some((object) => object.name === '椅子')).toBe(true)

  await page.getByRole('button', { name: '机位', exact: true }).click()
  await expect(page.locator('.director-asset-card')).toHaveCount(16)
  await page.locator('.director-asset-card').filter({ hasText: '荷兰角' }).click()
  await expect.poll(() => savedTimelines.at(-1)?.cameras.some((camera) => camera.name === '荷兰角' && camera.roll === -16)).toBe(true)

  await page.getByRole('button', { name: '模板', exact: true }).click()
  await expect(page.locator('.director-asset-card')).toHaveCount(20)
  await page.getByRole('button', { name: '大纲', exact: true }).click()
  await page.getByRole('button', { name: '+ 群众阵列', exact: true }).click()
  const crowdDialog = page.getByRole('dialog', { name: '群众阵列' })
  await crowdDialog.getByLabel('行数').fill('2')
  await crowdDialog.getByLabel('列数').fill('3')
  await crowdDialog.getByLabel('间距').fill('1.5')
  await crowdDialog.getByRole('button', { name: '添加群众' }).click()
  await expect.poll(() => savedTimelines.at(-1)?.objects.filter((object) => object.parentId && object.name.startsWith('群众')).length).toBe(6)
  await page.getByRole('button', { name: /解散分组 群众组/ }).click()
  await expect.poll(() => savedTimelines.at(-1)?.objects.some((object) => object.type === 'group' && object.name.startsWith('群众组'))).toBe(false)

  await page.getByRole('button', { name: /对齐人物 humanoid/ }).click()
  await page.getByRole('button', { name: '儿童素体', exact: true }).click()
  await page.getByLabel('颜色', { exact: true }).fill('#35d7ff')
  await expect.poll(() => savedTimelines.at(-1)?.objects.find((object) => object.id === 'parity-role')?.assetRef).toMatchObject({
    kind: 'child',
    color: '#35d7ff',
  })
  await page.getByRole('button', { name: '姿势', exact: true }).click()
  await page.getByRole('button', { name: '招手', exact: true }).click()
  await expect.poll(() => Object.keys(savedTimelines.at(-1)?.objects.find((object) => object.id === 'parity-role')?.poseRotations || {}).length).toBeGreaterThan(0)

  await page.getByRole('button', { name: '动画时间轴' }).click()
  await page.getByRole('button', { name: '添加关键帧', exact: true }).click()
  await page.locator('.motion-keyframe').click()
  await page.getByRole('button', { name: '子弹时间', exact: true }).click()
  await expect.poll(() => savedTimelines.at(-1)?.motionTracks[0]?.keyframes[0]?.speedPreset).toBe('子弹时间')

  await page.getByRole('button', { name: '标签', exact: true }).click()
  await page.getByLabel('机位辅助线').check()
  await expect.poll(() => savedTimelines.at(-1)?.environment.showCameraGuides).toBe(true)
})
