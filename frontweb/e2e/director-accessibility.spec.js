import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { fulfillEmptyProjectAssets, fulfillMockDrama } from './mockDrama.js'

const evidenceScreenshot = fileURLToPath(new URL('../../.omx/evidence/local/20260716/director-1280x720.png', import.meta.url))
const pressureScreenshot = fileURLToPath(new URL('../../.omx/evidence/local/20260716/director-pressure-100-20-200.png', import.meta.url))
const simpleSkinValidationUrl = '/director-fixtures/khronos-simple-skin.gltf'

test.use({ viewport: { width: 1280, height: 720 } })
test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/dramas/3', (route) => fulfillMockDrama(route))
  await page.route('**/api/v1/assets?**', (route) => fulfillEmptyProjectAssets(route))
})

test('导演台在 1280×720 可操作并保持完整键盘焦点循环', async ({ page }) => {
  await page.goto('/film/3/canvas')

  const opener = page.getByRole('button', { name: '打开 3D 导演台' })
  await expect(opener).toBeVisible()
  await opener.focus()
  await opener.press('Enter')

  const dialog = page.getByRole('dialog', { name: '3D 导演台' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toBeFocused()
  await expect(page.locator('.director-stage__sidebar')).toBeVisible()
  await expect(page.locator('.director-stage__viewport')).toBeVisible()
  await expect(page.getByLabel('属性检查器')).toBeVisible()
  await page.getByRole('button', { name: '动画时间轴' }).click()
  await expect(page.getByLabel('导演时间线')).toBeVisible()

  for (const locator of [
    page.locator('.director-stage__sidebar'),
    page.locator('.director-stage__viewport'),
    page.getByLabel('属性检查器'),
    page.getByLabel('导演时间线'),
  ]) {
    const box = await locator.boundingBox()
    expect(box).not.toBeNull()
    expect(box.width).toBeGreaterThan(0)
    expect(box.height).toBeGreaterThan(0)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(1280)
    expect(box.y + box.height).toBeLessThanOrEqual(720)
  }
  const timelineControlsBox = await page.locator('.timeline-controls').boundingBox()
  const timelineScrubberBox = await page.getByLabel('时间线位置').boundingBox()
  expect(timelineControlsBox).not.toBeNull()
  expect(timelineScrubberBox).not.toBeNull()
  expect(timelineScrubberBox.width).toBeGreaterThanOrEqual(96)
  expect(timelineControlsBox.x + timelineControlsBox.width).toBeLessThanOrEqual(timelineScrubberBox.x)

  const expectedLandmarks = new Set([
    '导演台帮助',
    '搜索场景对象',
    '移动工具',
    '播放',
    '时间线位置',
    'AI 识图导入',
    '关闭导演台',
  ])
  await page.getByRole('button', { name: '关闭导演台' }).focus()
  const visited = []
  for (let index = 0; index < 400; index += 1) {
    await page.keyboard.press('Tab')
    const active = await page.locator(':focus').evaluate((element) => ({
      name: element.getAttribute('aria-label') || element.textContent?.trim() || element.getAttribute('placeholder') || '',
      insideDirector: Boolean(element.closest('.director-stage')),
    }))
    expect(active.insideDirector).toBe(true)
    visited.push(active.name)
    expectedLandmarks.delete(active.name)
    if (index > 0 && active.name === visited[0]) break
  }
  expect([...expectedLandmarks], `未遍历到焦点地标；实际顺序：${visited.join(' -> ')}`).toEqual([])
  expect(visited.at(-1)).toBe(visited[0])

  await page.getByRole('button', { name: '导演台帮助' }).click()
  const helpDialog = page.getByRole('dialog', { name: '导演台帮助' })
  await expect(helpDialog).toBeVisible()
  await expect(page.getByRole('button', { name: '关闭导演台帮助' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(helpDialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: '导演台帮助' })).toBeFocused()

  await dialog.screenshot({ path: evidenceScreenshot })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test('导演台真实渲染帧率与重复挂载生命周期保持稳定', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeAdd = window.addEventListener.bind(window)
    const nativeRemove = window.removeEventListener.bind(window)
    const keydownHandlers = new Set()
    window.addEventListener = (type, listener, options) => {
      if (type === 'keydown') keydownHandlers.add(listener)
      return nativeAdd(type, listener, options)
    }
    window.removeEventListener = (type, listener, options) => {
      if (type === 'keydown') keydownHandlers.delete(listener)
      return nativeRemove(type, listener, options)
    }
    window.__directorLifecycle = { keydownHandlers }
  })
  await page.goto('/film/3/canvas')
  const opener = page.getByRole('button', { name: '打开 3D 导演台' })
  await expect(opener).toBeVisible()
  const baselineKeydown = await page.evaluate(() => window.__directorLifecycle.keydownHandlers.size)
  let mountedKeydown = null

  for (let iteration = 0; iteration < 3; iteration += 1) {
    await opener.click()
    const dialog = page.getByRole('dialog', { name: '3D 导演台' })
    await expect(dialog).toBeVisible()
    await expect(page.locator('canvas.director-stage__canvas')).toHaveCount(1)
    const currentMountedKeydown = await page.evaluate(() => window.__directorLifecycle.keydownHandlers.size)
    expect(currentMountedKeydown).toBeGreaterThan(baselineKeydown)
    if (mountedKeydown === null) mountedKeydown = currentMountedKeydown
    else expect(currentMountedKeydown).toBe(mountedKeydown)

    if (iteration === 0) {
      const sampledFps = await page.evaluate(() => new Promise((resolve) => {
        let frames = 0
        const startedAt = performance.now()
        const sample = (now) => {
          frames += 1
          if (now - startedAt >= 5000) resolve(frames / ((now - startedAt) / 1000))
          else requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }))
      console.info(`DR-014 当前真实场景 5 秒平均 FPS=${sampledFps.toFixed(2)}`)
      expect(sampledFps).toBeGreaterThanOrEqual(30)
    }

    await page.getByRole('button', { name: '关闭导演台' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('canvas.director-stage__canvas')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.__directorLifecycle.keydownHandlers.size)).toBe(baselineKeydown)
  }
})

test('DR-005 捕获机位后切走返回保持位置和方向且复制不丢失', async ({ page }) => {
  const savedTimelines = []
  await page.route('**/api/v1/dramas/3', async (route) => {
    await fulfillMockDrama(route, {
      version: 2,
      sequence: { duration: 4, fps: 24, activeCameraId: 'accept-camera' },
      shots: [{ id: 'accept-shot', name: '验收镜头', camera: 'director', cameraId: 'accept-camera', transition: 'cut', start: 0, duration: 4 }],
      objects: [{ id: 'accept-camera-object', type: 'camera', name: '验收机位', visible: true, locked: false, transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
      cameras: [{ id: 'accept-camera', objectId: 'accept-camera-object', name: '验收机位', fov: 50, aspect: 16 / 9, near: 0.1, far: 1000 }],
      tracks: [], characterAssets: {}, motionTracks: [],
    })
  })
  await page.route('**/api/v1/dramas/3/canvas-layout', async (route) => {
    savedTimelines.push(route.request().postDataJSON().canvas_layout.director_timeline)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) })
  })

  await page.goto('/film/3/canvas')
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  await page.getByRole('button', { name: /验收机位 camera/ }).click()
  await page.getByRole('button', { name: '导演视角', exact: true }).click()
  await page.getByRole('button', { name: '从当前视角更新机位' }).click()
  await expect.poll(() => savedTimelines.length).toBeGreaterThanOrEqual(1)
  const captured = savedTimelines.at(-1).cameras.find((camera) => camera.id === 'accept-camera')
  const capturedObject = savedTimelines.at(-1).objects.find((object) => object.id === 'accept-camera-object')
  expect(captured.quaternion).toHaveLength(4)
  expect(captured.quaternion.every(Number.isFinite)).toBe(true)

  await page.getByRole('button', { name: '机位视角', exact: true }).click()
  await page.getByRole('button', { name: '从当前视角更新机位' }).click()
  await expect.poll(() => savedTimelines.length).toBeGreaterThanOrEqual(2)
  const returned = savedTimelines.at(-1).cameras.find((camera) => camera.id === 'accept-camera')
  const returnedObject = savedTimelines.at(-1).objects.find((object) => object.id === 'accept-camera-object')
  for (let index = 0; index < 4; index += 1) expect(Math.abs(returned.quaternion[index] - captured.quaternion[index])).toBeLessThanOrEqual(1e-4)
  for (let index = 0; index < 3; index += 1) expect(Math.abs(returnedObject.transform.position[index] - capturedObject.transform.position[index])).toBeLessThanOrEqual(1e-4)

  await page.getByRole('button', { name: '复制对象' }).click()
  await expect.poll(() => savedTimelines.at(-1)?.cameras.length).toBe(2)
  expect(savedTimelines.at(-1).cameras.at(-1).quaternion).toEqual(captured.quaternion)
  expect(savedTimelines.at(-1).cameras.at(-1).target).toEqual(captured.target)
})

test('动作片段可编辑、保存、刷新恢复并删除', async ({ page }) => {
  let persistedTimeline = {
    version: 2,
    sequence: { duration: 4, fps: 24 },
    shots: [{ id: 'clip-shot', name: '动作验收镜头', camera: 'director', transition: 'cut', start: 0, duration: 4 }],
    objects: [],
    cameras: [],
    tracks: [{
      id: 'character-a-track',
      characterId: 'character-a',
      clips: [{ id: 'editable-clip', characterId: 'character-a', action: 'Run', start: 0.5, duration: 2 }],
    }],
    characterAssets: {},
    motionTracks: [],
  }
  await page.route('**/api/v1/dramas/3', async (route) => {
    await fulfillMockDrama(route, persistedTimeline)
  })
  await page.route('**/api/v1/dramas/3/canvas-layout', async (route) => {
    persistedTimeline = route.request().postDataJSON().canvas_layout.director_timeline
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) })
  })

  await page.goto('/film/3/canvas')
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  await page.getByRole('button', { name: '动画时间轴' }).click()
  await page.getByRole('button', { name: '角色A Run 动作片段' }).click()
  await page.getByLabel('动作片段动作').selectOption('Wave')
  await expect.poll(() => persistedTimeline.tracks[0].clips[0].action).toBe('Wave')
  await page.getByLabel('动作片段开始时间').fill('1.5')
  await page.getByLabel('动作片段开始时间').press('Tab')
  await expect.poll(() => persistedTimeline.tracks[0].clips[0].start).toBe(1.5)
  await page.getByLabel('动作片段时长').fill('0.75')
  await page.getByLabel('动作片段时长').press('Tab')

  await expect.poll(() => persistedTimeline.tracks[0].clips[0]).toMatchObject({
    id: 'editable-clip',
    action: 'Wave',
    start: 1.5,
    duration: 0.75,
  })

  await page.reload()
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  await page.getByRole('button', { name: '动画时间轴' }).click()
  await page.getByRole('button', { name: '角色A Wave 动作片段' }).click()
  await expect(page.getByLabel('动作片段动作')).toHaveValue('Wave')
  await expect(page.getByLabel('动作片段开始时间')).toHaveValue('1.5')
  await expect(page.getByLabel('动作片段时长')).toHaveValue('0.75')

  await page.getByRole('button', { name: '删除动作片段' }).click()
  await expect.poll(() => persistedTimeline.tracks.flatMap((track) => track.clips).some((clip) => clip.id === 'editable-clip')).toBe(false)
  await expect(page.getByRole('button', { name: '角色A Wave 动作片段' })).toHaveCount(0)
})

test('DR-004 Shift 等比缩放与变换数值写入统一保存链', async ({ page }) => {
  const savedTimelines = []
  await page.route('**/api/v1/dramas/3', async (route) => {
    await fulfillMockDrama(route, {
      version: 2, sequence: { duration: 4, fps: 24 },
      shots: [{ id: 'transform-shot', name: '变换镜头', camera: 'director', transition: 'cut', start: 0, duration: 4 }],
      objects: [{ id: 'transform-box', type: 'box', name: '变换验收对象', visible: true, locked: false, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 2, 3] } }],
      cameras: [], tracks: [], characterAssets: {}, motionTracks: [],
    })
  })
  await page.route('**/api/v1/dramas/3/canvas-layout', async (route) => {
    savedTimelines.push(route.request().postDataJSON().canvas_layout.director_timeline)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) })
  })

  await page.goto('/film/3/canvas')
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  await page.getByRole('button', { name: /变换验收对象 box/ }).click()
  await page.getByLabel('视口变换工具').getByRole('button', { name: '移动工具' }).click()
  const canvasBox = await page.locator('canvas.director-stage__canvas').boundingBox()
  expect(canvasBox).not.toBeNull()
  const beforeDragSaves = savedTimelines.length
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(canvasBox.x + canvasBox.width / 2 + 70, canvasBox.y + canvasBox.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => savedTimelines.length).toBeGreaterThan(beforeDragSaves)
  const draggedPosition = savedTimelines.at(-1).objects.find((object) => object.id === 'transform-box').transform.position
  expect(draggedPosition.some((value) => Math.abs(value) > 1e-4)).toBe(true)
  const inspector = page.getByLabel('属性检查器')
  const scaleInputs = inspector.locator('.inspector-group').filter({ has: page.locator('strong', { hasText: '缩放' }) }).first().locator('input')
  const beforeScaleSaves = savedTimelines.length
  await scaleInputs.nth(1).evaluate((input) => {
    input.value = '4'
    input.dispatchEvent(new KeyboardEvent('change', { bubbles: true, shiftKey: true }))
  })
  await expect.poll(() => savedTimelines.length).toBeGreaterThan(beforeScaleSaves)
  expect(savedTimelines.at(-1).objects.find((object) => object.id === 'transform-box').transform.scale).toEqual([2, 4, 6])

  const positionInputs = inspector.locator('.inspector-group').filter({ has: page.locator('strong', { hasText: '位置（米）' }) }).first().locator('input')
  await positionInputs.nth(0).fill('2.5')
  await positionInputs.nth(0).dispatchEvent('change')
  await expect.poll(() => savedTimelines.at(-1)?.objects.find((object) => object.id === 'transform-box').transform.position[0]).toBe(2.5)
})

test('DR-012 浏览器录制可由用户取消并恢复导出入口', async ({ page }) => {
  await page.addInitScript(() => {
    const track = { requestFrame() {}, stop() {} }
    HTMLCanvasElement.prototype.captureStream = () => ({ getVideoTracks: () => [track], getTracks: () => [track] })
    class TestMediaRecorder {
      static isTypeSupported() { return true }
      constructor() { this.state = 'inactive'; this.onstop = null; this.onerror = null; this.ondataavailable = null }
      start() { this.state = 'recording' }
      requestData() {}
      stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()) }
    }
    window.MediaRecorder = TestMediaRecorder
  })
  await page.goto('/film/3/canvas')
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  await page.getByRole('button', { name: '动画时间轴' }).click()
  await page.getByRole('button', { name: '导出 WebM 视频' }).click()
  const cancel = page.getByRole('button', { name: '取消导出' })
  await expect(cancel).toBeVisible()
  await cancel.click()
  await expect(page.getByText('已取消视频导出')).toBeVisible()
  await expect(page.getByRole('button', { name: '导出 WebM 视频' })).toBeEnabled()
})

test('DR-012 服务端导出达到轮询上限后显示超时且不下载', async ({ page }) => {
  await page.addInitScript(() => {
    const track = { requestFrame() {}, stop() {} }
    HTMLCanvasElement.prototype.captureStream = () => ({ getVideoTracks: () => [track], getTracks: () => [track] })
    class TestMediaRecorder {
      static isTypeSupported() { return true }
      constructor() { this.state = 'inactive'; this.onstop = null; this.onerror = null; this.ondataavailable = null }
      start() { this.state = 'recording' }
      requestData() { this.ondataavailable?.({ data: new Blob([new Uint8Array(2048)], { type: 'video/webm' }) }) }
      stop() { this.requestData(); this.state = 'inactive'; queueMicrotask(() => this.onstop?.()) }
    }
    window.MediaRecorder = TestMediaRecorder
  })
  await page.route('**/api/v1/dramas/3', async (route) => {
    await fulfillMockDrama(route, {
      version: 2, sequence: { duration: 0.25, fps: 24 },
      shots: [{ id: 'timeout-shot', name: '超时镜头', camera: 'director', transition: 'cut', start: 0, duration: 0.25 }],
      objects: [], cameras: [], tracks: [], characterAssets: {}, motionTracks: [],
    })
  })
  await page.route('**/api/v1/dramas/3/director/export', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { task_id: 'timeout-task', poll_max_attempts: 3 } }) }))
  let pollCount = 0
  await page.route('**/api/v1/tasks/timeout-task', (route) => {
    pollCount += 1
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: 'timeout-task', status: 'running', progress: 50 } }) })
  })

  await page.goto('/film/3/canvas')
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  await page.getByRole('button', { name: '动画时间轴' }).click()
  await page.clock.install()
  const downloads = []
  page.on('download', (download) => downloads.push(download))
  await page.getByRole('button', { name: '服务端导出 MP4' }).click()
  for (let attempt = 0; attempt < 4 && pollCount < 3; attempt += 1) {
    await page.clock.runFor(1000)
    await page.evaluate(() => Promise.resolve())
  }
  await expect.poll(() => pollCount).toBe(3)
  await page.evaluate(() => Promise.resolve())
  await expect(page.getByText('服务端转码超时')).toBeVisible()
  await expect(page.getByRole('button', { name: '服务端导出 MP4' })).toBeEnabled()
  expect(downloads).toHaveLength(0)
})

test('DR-002 GLB/VRM 加载区分权限、缺失、MIME 和损坏且场景仍可操作', async ({ page }) => {
  await page.route('**/director-fixtures/missing.glb', (route) => route.fulfill({ status: 404, contentType: 'model/gltf-binary', body: '' }))
  await page.route('**/director-fixtures/private.glb', (route) => route.fulfill({ status: 403, contentType: 'model/gltf-binary', body: '' }))
  await page.route('**/director-fixtures/wrong.glb', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'not a model' }))
  await page.route('**/director-fixtures/broken.glb', (route) => route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: 'broken model bytes' }))
  await page.goto('/film/3/canvas')
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  await page.getByRole('button', { name: '动画时间轴' }).click()
  const modelUrl = page.getByLabel('角色模型 URL')
  const loadModel = page.getByRole('button', { name: '加载模型' })
  const initialObjectCount = await page.locator('.stage-tree-row').count()
  const cases = [
    ['missing.glb', '模型加载失败：三维资源不存在（404）'],
    ['private.glb', '模型加载失败：无权限访问三维资源（403）'],
    ['wrong.glb', '模型加载失败：三维资源 MIME 类型错误：text/plain'],
    ['broken.glb', '模型加载失败：三维资源文件损坏或格式无效'],
  ]
  for (const [file, message] of cases) {
    await modelUrl.fill(`/director-fixtures/${file}`)
    await modelUrl.dispatchEvent('change')
    await loadModel.click()
    await expect(page.getByText(message, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '+ 立方体' }).click()
  }
  await modelUrl.fill(simpleSkinValidationUrl)
  await modelUrl.dispatchEvent('change')
  await loadModel.click()
  await expect(page.locator('.resource-status:not(.resource-status--row)')).toContainText('模型已加载')
  await expect(page.locator('.stage-tree-row')).toHaveCount(initialObjectCount + 4)
})

test('CC0 SimpleSkin 验证资产加载可见网格、骨骼和动画并在保存刷新后恢复', async ({ page }) => {
  let persistedTimeline = {
    version: 2,
    sequence: { duration: 2, fps: 24, currentTime: 0 },
    shots: [{ id: 'simple-skin-shot', name: 'SimpleSkin 验证镜头', camera: 'director', transition: 'cut', start: 0, duration: 2 }],
    objects: [{
      id: 'project-character:character-a',
      type: 'character',
      name: '角色A',
      visible: true,
      locked: false,
      assetRef: { kind: 'project-character', characterId: 'character-a' },
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }],
    cameras: [],
    tracks: [{ id: 'simple-skin-track', characterId: 'character-a', clips: [{ id: 'simple-skin-clip', characterId: 'character-a', action: 'Run', start: 0, duration: 2 }] }],
    characterAssets: {},
    motionTracks: [],
  }
  await page.route('**/api/v1/dramas/3', (route) => fulfillMockDrama(route, persistedTimeline))
  await page.route('**/api/v1/dramas/3/canvas-layout', async (route) => {
    persistedTimeline = route.request().postDataJSON().canvas_layout.director_timeline
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) })
  })

  await page.goto('/film/3/canvas')
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  await page.getByRole('button', { name: '动画时间轴' }).click()
  await page.getByRole('button', { name: '加载 CC0 验证模型' }).click()

  const modelStatus = page.locator('.resource-status--row').filter({ hasText: '模型：' })
  await expect(modelStatus).toContainText('可见网格 1 · 骨骼 2 · 动画 1')
  await page.getByLabel('选择动作').selectOption('Run')
  const actionStatus = page.locator('.resource-status--row').filter({ hasText: '动作：' })
  await expect(actionStatus).toContainText('使用模型内置动画 1')
  await page.getByRole('button', { name: '角色A Run 动作片段' }).click()
  await expect(page.getByLabel('动作片段时长')).toHaveAttribute('min', '0.25')
  await expect.poll(() => persistedTimeline.characterAssets?.['character-a']?.modelUrl).toBe(simpleSkinValidationUrl)

  const modelScale = page.getByLabel('模型缩放')
  await modelScale.fill('1.25')
  await modelScale.press('Tab')
  await expect.poll(() => persistedTimeline.characterAssets?.['character-a']?.scale).toBe(1.25)

  await page.reload()
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  await page.getByRole('button', { name: '动画时间轴' }).click()
  await expect(page.getByLabel('角色模型 URL')).toHaveValue(simpleSkinValidationUrl)
  await expect(page.getByLabel('模型缩放')).toHaveValue('1.25')
  await expect(modelStatus).toContainText('可见网格 1 · 骨骼 2 · 动画 1')
  await page.getByLabel('选择动作').selectOption('Run')
  await expect(actionStatus).toContainText('使用模型内置动画 1')
})

test('导演台 100 对象、20 相机、200 片段真实渲染平均 FPS 不低于 30', async ({ page }) => {
  await page.route('**/api/v1/dramas/3', async (route) => {
    const safeCharacterIds = ['character-a', 'character-b']
    const objects = Array.from({ length: 100 }, (_, index) => ({
      id: `pressure-object-${index}`,
      type: index < 20 ? 'camera' : 'box',
      name: `压力对象 ${index}`,
      visible: true,
      locked: false,
      transform: {
        position: [(index % 10) - 5, Math.floor(index / 50) * 1.2, Math.floor(index / 10) - 5],
        rotation: [0, 0, 0],
        scale: [0.2, 0.2, 0.2],
      },
    }))
    const cameras = objects.slice(0, 20).map((object, index) => ({
      id: `pressure-camera-${index}`,
      objectId: object.id,
      name: `压力机位 ${index}`,
      fov: 50,
      aspect: 16 / 9,
      near: 0.1,
      far: 1000,
    }))
    const clips = Array.from({ length: 200 }, (_, index) => ({
      id: `pressure-clip-${index}`,
      characterId: safeCharacterIds[index % safeCharacterIds.length],
      action: 'Idle',
      start: index % 100,
      duration: 1,
    }))
    const tracks = safeCharacterIds.map((characterId, index) => ({
      id: `pressure-track-${index}`,
      characterId,
      clips: clips.filter((clip) => clip.characterId === characterId),
    }))
    await fulfillMockDrama(route, {
      version: 2,
      sequence: { duration: 100, fps: 24 },
      shots: [{ id: 'pressure-shot', name: '压力镜头', camera: 'director', cameraId: cameras[0].id, transition: 'cut', start: 0, duration: 100 }],
      objects,
      cameras,
      tracks,
      characterAssets: {},
      motionTracks: [],
    })
  })

  await page.goto('/film/3/canvas')
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  const dialog = page.getByRole('dialog', { name: '3D 导演台' })
  await expect(dialog).toBeVisible()
  await expect(page.locator('.stage-tree-row')).toHaveCount(102)
  await page.getByRole('button', { name: '动画时间轴' }).click()
  await expect(page.getByRole('option', { name: /压力机位/ })).toHaveCount(20)
  await expect(page.locator('.timeline-action')).toHaveCount(200)

  const sampledFps = await page.evaluate(() => new Promise((resolve) => {
    let frames = 0
    const startedAt = performance.now()
    const sample = (now) => {
      frames += 1
      if (now - startedAt >= 5000) resolve(frames / ((now - startedAt) / 1000))
      else requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }))
  console.info(`DR-014 100/20/200 压力场景 5 秒平均 FPS=${sampledFps.toFixed(2)}`)
  expect(sampledFps).toBeGreaterThanOrEqual(30)
  await dialog.screenshot({ path: pressureScreenshot })
})
