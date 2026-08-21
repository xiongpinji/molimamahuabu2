import { test, expect } from '@playwright/test'

function apiData(data) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  }
}

function standaloneDrama(canvasLayout) {
  return {
    id: 3,
    title: 'E2E 自由画布',
    metadata: {
      project_type: 'canvas',
      canvas_layout: canvasLayout,
    },
    characters: [],
    scenes: [],
    props: [],
    episodes: [],
  }
}

function baseCanvasLayout(extra = {}) {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 0.75 },
    nodes: {},
    manual_edges: [],
    free_nodes: [],
    ...extra,
  }
}

function installStaticAndApiMocks(page, state) {
  return page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url
    const method = request.method()

    if (pathname.startsWith('/static/')) {
      const contentType = pathname.endsWith('.mp4')
        ? 'video/mp4'
        : pathname.endsWith('.mp3')
          ? 'audio/mpeg'
          : 'image/png'
      await route.fulfill({
        status: 200,
        contentType,
        body: Buffer.from([0x00, 0x00, 0x00, 0x18]),
      })
      return
    }

    if (!pathname.startsWith('/api/v1/')) {
      await route.continue()
      return
    }

    if (method === 'GET' && pathname === '/api/v1/dramas/3') {
      await route.fulfill(apiData(standaloneDrama(state.canvasLayout)))
      return
    }

    if (method === 'PUT' && pathname === '/api/v1/dramas/3/canvas-layout') {
      const payload = request.postDataJSON() || {}
      if (payload.canvas_layout) state.canvasLayout = payload.canvas_layout
      await route.fulfill(apiData(standaloneDrama(state.canvasLayout)))
      return
    }

    if (method === 'GET' && pathname === '/api/v1/assets') {
      await route.fulfill(apiData({ items: state.assets, total: state.assets.length }))
      return
    }

    if (method === 'GET' && pathname === '/api/v1/ai-configs') {
      const serviceType = url.searchParams.get('service_type')
      const configs = (state.aiConfigs || []).filter((config) => !serviceType || config.service_type === serviceType)
      await route.fulfill(apiData(configs))
      return
    }

    if (method === 'GET' && pathname === '/api/v1/canvas/model-catalog') {
      await route.fulfill(apiData(state.modelCatalog || []))
      return
    }

    if (method === 'POST' && pathname === '/api/v1/assets') {
      const payload = request.postDataJSON() || {}
      state.assetRequests.push(payload)
      const asset = {
        id: 900 + state.assetRequests.length,
        name: payload.name || `自由画布素材 ${state.assetRequests.length}`,
        ...payload,
      }
      state.assets.push(asset)
      await route.fulfill(apiData(asset))
      return
    }

    if (method === 'POST' && pathname === '/api/v1/images') {
      const payload = request.postDataJSON() || {}
      state.imageRequests.push(payload)
      const attempt = state.imageRequests.length
      await route.fulfill(apiData({ id: 400 + attempt, task_id: `img-task-${attempt}` }))
      return
    }

    if (method === 'GET' && /^\/api\/v1\/tasks\/img-task-\d+$/.test(pathname)) {
      const attempt = Number(pathname.split('-').at(-1))
      await route.fulfill(apiData({
        id: `img-task-${attempt}`,
        status: 'completed',
        result: { image_url: attempt === 1 ? '/static/free-image.png' : `/static/free-image-${attempt}.png` },
      }))
      return
    }

    if (method === 'POST' && pathname === '/api/v1/canvas/text/generate') {
      const payload = request.postDataJSON() || {}
      state.textRequests ||= []
      state.textRequests.push(payload)
      await route.fulfill(apiData({
        content: payload.prompt.includes('翻译') ? 'A natural English translation.' : 'AI 生成后的完整文本',
        model: payload.model || 'text-default',
      }))
      return
    }

    if (method === 'POST' && pathname === '/api/v1/videos') {
      const payload = request.postDataJSON() || {}
      state.videoRequests.push(payload)
      const attempt = state.videoRequests.length
      await route.fulfill(apiData({ id: 501 + attempt, task_id: `video-task-${attempt}` }))
      return
    }

    if (method === 'GET' && pathname === '/api/v1/tasks/video-task-1') {
      await route.fulfill(apiData({
        id: 'video-task-1',
        status: 'failed',
        error: '视频模型临时失败',
      }))
      return
    }

    if (method === 'GET' && pathname === '/api/v1/tasks/video-task-2') {
      await route.fulfill(apiData({
        id: 'video-task-2',
        status: 'completed',
        result: { video_url: '/static/free-video.mp4' },
      }))
      return
    }

    if (method === 'POST' && pathname === '/api/v1/audio/extract') {
      const payload = request.postDataJSON() || {}
      state.audioRequests.push(payload)
      await route.fulfill(apiData({ url: '/static/free-audio.mp3' }))
      return
    }

    if (method === 'GET' && ['/api/v1/images', '/api/v1/videos'].includes(pathname)) {
      await route.fulfill(apiData({ items: [] }))
      return
    }

    if (method === 'GET' && [
      '/api/v1/video-models',
      '/api/v1/voice-catalog',
      '/api/v1/character-library',
      '/api/v1/scene-library',
      '/api/v1/prop-library',
    ].includes(pathname)) {
      await route.fulfill(apiData({ items: [] }))
      return
    }

    await route.fulfill(apiData({ items: [] }))
  })
}

function freeNode(layout, id) {
  return layout.free_nodes.find((node) => node.id === id)
}

test.describe('独立自由画布节点真实运行闭环', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('moli_mama_session', JSON.stringify({
        token: 'standalone-canvas-e2e-session',
        user: { id: 'standalone-canvas-e2e-user', email: 'canvas-e2e@example.com', role: 'user' },
      }))
    })
  })

  test('自定义画布设置逐项生效、持久化并可恢复默认', async ({ page }) => {
    const state = {
      canvasLayout: baseCanvasLayout({
        manual_edges: [{
          id: 'manual:settings-edge',
          source: 'free:image:settings',
          target: 'free:image:settings-target',
          type: 'smoothstep',
          style: {
            stroke: '#22d3ee',
            strokeWidth: 1.8,
            strokeDasharray: '5, 5',
          },
          data: { manual: true },
        }],
        free_nodes: [
          {
            id: 'free:image:settings',
            type: 'homeCanvasNode',
            position: { x: 240, y: 220 },
            data: {
              kind: 'image',
              title: '背景候选图',
              content: '雨夜站台',
              url: '/static/settings-background.png',
              status: 'success',
            },
          },
          {
            id: 'free:image:settings-target',
            type: 'homeCanvasNode',
            position: { x: 820, y: 220 },
            data: {
              kind: 'image',
              title: '连线设置目标',
              content: '验证现有连线',
              status: 'idle',
            },
          },
        ],
      }),
      assets: [],
      imageRequests: [],
      videoRequests: [],
      audioRequests: [],
      assetRequests: [],
    }
    await installStaticAndApiMocks(page, state)

    await page.goto('/canvas/3')
    await expect(page.locator('.vue-flow__node[data-id="free:image:settings"]')).toBeVisible()
    await expect(page.getByText('暂无画布数据', { exact: true })).toHaveCount(0)
    const edgePath = page.locator('.vue-flow__edge-path')
    const edgeInteraction = page.locator('.vue-flow__edge-interaction')
    await expect(edgePath).toHaveCount(1)
    await page.getByRole('button', { name: '画布设置' }).click()
    const dialog = page.getByRole('dialog', { name: '自定义画布' })
    await expect(dialog).toBeVisible()
    const box = await dialog.boundingBox()
    expect(Math.round(box.width)).toBe(420)
    expect(Math.round(box.height)).toBe(400)

    for (const section of [
      '交互操作',
      '连线设置',
      '网格与显示',
      '节点与布局',
      '自定义背景',
      '画布主题',
      '连线色彩',
      '简化配色',
    ]) {
      await expect(dialog.getByText(section, { exact: true }).first()).toBeAttached()
    }

    await dialog.getByRole('button', { name: '缩放', exact: true }).click()
    await dialog.locator('label.setting-row').filter({ hasText: '连线显示粗细' }).locator('input').fill('6')
    await dialog.locator('label.setting-row').filter({ hasText: '连线焦点范围' }).locator('input').fill('30')
    const animationSwitch = dialog.locator('.setting-row').filter({ hasText: '开启连线动画' }).getByRole('switch')
    const focusOnlySwitch = dialog.locator('.setting-row').filter({ hasText: '仅显示焦点连线' }).getByRole('switch')
    await animationSwitch.click()
    await dialog.getByRole('button', { name: '火山', exact: true }).click()
    await dialog.locator('label.setting-row').filter({ hasText: '网格线间距' }).locator('input').fill('30')
    await dialog.locator('.setting-row').filter({ hasText: '显示导航小地图' }).getByRole('switch').click()
    await dialog.getByRole('button', { name: '暮光蓝', exact: true }).click()
    await dialog.getByRole('button', { name: '从画布选择' }).click()
    await dialog.locator('.background-picker button').first().click()

    await expect(page.locator('.vue-flow__minimap')).toBeVisible()
    await expect(edgePath).toHaveCSS('stroke-width', '6px')
    await expect(edgeInteraction).toHaveCSS('stroke-width', '30px')
    await expect(edgePath).toHaveCSS('stroke-dasharray', '8px, 8px')
    await expect.poll(async () => page.locator('.canvas-main').evaluate((canvas) => {
      const path = canvas.querySelector('.vue-flow__edge-path')
      const style = getComputedStyle(canvas)
      return getComputedStyle(path).stroke === style.getPropertyValue('--canvas-edge-color').trim()
    })).toBe(true)
    await focusOnlySwitch.click()
    await expect(edgePath).toHaveCSS('opacity', '0')
    await focusOnlySwitch.click()
    await expect(edgePath).toHaveCSS('opacity', '1')
    await edgeInteraction.dispatchEvent('click')
    await expect(page.locator('.vue-flow__edge')).toHaveClass(/selected/)
    await expect.poll(async () => page.locator('.canvas-main').evaluate((canvas) => {
      const path = canvas.querySelector('.vue-flow__edge-path')
      const style = getComputedStyle(canvas)
      return getComputedStyle(path).stroke === style.getPropertyValue('--canvas-edge-focus-color').trim()
    })).toBe(true)
    await dialog.hover({ position: { x: 20, y: 20 } })
    await animationSwitch.click()
    await expect(edgePath).toHaveCSS('stroke-dasharray', '5px, 5px')
    await animationSwitch.click()
    await expect(edgePath).toHaveCSS('stroke-dasharray', '8px, 8px')
    await expect.poll(() => state.canvasLayout.preferences).toMatchObject({
      wheel_action: 'zoom',
      edge_width: 6,
      edge_focus_radius: 30,
      edge_animation_enabled: true,
      edge_focus_only: false,
      edge_palette_key: 'volcano',
      grid_gap: 30,
      minimap_visible: true,
      theme_key: 'twilight-blue',
      background_enabled: true,
      background_url: '/static/settings-background.png',
    })

    await page.reload()
    await page.getByRole('button', { name: '画布设置' }).click()
    const restoredDialog = page.getByRole('dialog', { name: '自定义画布' })
    await expect(restoredDialog.getByRole('button', { name: '缩放', exact: true })).toHaveClass(/active/)
    await expect(restoredDialog.getByRole('button', { name: '暮光蓝', exact: true })).toHaveClass(/active/)
    await expect(restoredDialog.getByRole('button', { name: '火山', exact: true })).toHaveClass(/active/)
    await expect(page.locator('.vue-flow__minimap')).toBeVisible()
    await expect(page.locator('.vue-flow__edge-path')).toHaveCSS('stroke-width', '6px')
    await expect(page.locator('.vue-flow__edge-interaction')).toHaveCSS('stroke-width', '30px')
    await expect(page.locator('.vue-flow__edge-path')).toHaveCSS('stroke-dasharray', '8px, 8px')
    await expect.poll(async () => page.locator('.canvas-main').evaluate((canvas) => {
      const path = canvas.querySelector('.vue-flow__edge-path')
      const style = getComputedStyle(canvas)
      return getComputedStyle(path).stroke === style.getPropertyValue('--canvas-edge-color').trim()
    })).toBe(true)

    await restoredDialog.getByRole('button', { name: '恢复默认' }).click()
    await expect.poll(() => state.canvasLayout.preferences).toMatchObject({
      wheel_action: 'pan',
      edge_width: 2,
      edge_focus_radius: 12,
      edge_animation_enabled: false,
      edge_focus_only: false,
      grid_gap: 20,
      minimap_visible: false,
      theme_key: 'xuanhei',
      background_enabled: false,
    })
    await expect(page.locator('.vue-flow__edge-path')).toHaveCSS('stroke-width', '2px')
    await expect(page.locator('.vue-flow__edge-interaction')).toHaveCSS('stroke-width', '12px')
    await expect(page.locator('.vue-flow__edge-path')).toHaveCSS('stroke-dasharray', '5px, 5px')
    await expect(page.locator('.vue-flow__minimap')).toHaveCount(0)
  })

  test('多个节点可打组、整组实时拖动、组内执行、解组并撤销重做', async ({ page }) => {
    const state = {
      canvasLayout: baseCanvasLayout({
        free_nodes: [
          {
            id: 'free:text:group-a',
            type: 'homeCanvasNode',
            position: { x: 180, y: 260 },
            data: { kind: 'text', title: '组内文本 A', content: '生成组内文案 A', model: 'text-e2e' },
          },
          {
            id: 'free:text:group-b',
            type: 'homeCanvasNode',
            position: { x: 620, y: 260 },
            data: { kind: 'text', title: '组内文本 B', content: '生成组内文案 B', model: 'text-e2e' },
          },
          {
            id: 'free:text:outside',
            type: 'homeCanvasNode',
            position: { x: 1500, y: 260 },
            data: { kind: 'text', title: '组外文本', content: '不应执行组外文案', model: 'text-e2e' },
          },
        ],
      }),
      assets: [],
      imageRequests: [],
      videoRequests: [],
      audioRequests: [],
      textRequests: [],
      assetRequests: [],
    }
    await installStaticAndApiMocks(page, state)

    await page.goto('/canvas/3')
    const nodeA = page.locator('.vue-flow__node[data-id="free:text:group-a"]')
    const nodeB = page.locator('.vue-flow__node[data-id="free:text:group-b"]')
    await expect(nodeA).toBeVisible()
    const selectionBoxA = await nodeA.boundingBox()
    const selectionBoxB = await nodeB.boundingBox()
    expect(selectionBoxA).not.toBeNull()
    expect(selectionBoxB).not.toBeNull()
    await page.mouse.move(
      selectionBoxB.x + selectionBoxB.width + 24,
      Math.max(selectionBoxA.y + selectionBoxA.height, selectionBoxB.y + selectionBoxB.height) + 24,
    )
    await page.mouse.down()
    await page.mouse.move(
      selectionBoxA.x - 24,
      Math.min(selectionBoxA.y, selectionBoxB.y) - 24,
      { steps: 12 },
    )
    await page.mouse.up()

    const multiToolbar = page.getByRole('toolbar', { name: '多选节点操作' })
    await expect(multiToolbar).toContainText('2 个节点')
    await multiToolbar.getByRole('button', { name: '打组' }).click()

    const group = page.locator('.vue-flow__node[data-id^="canvas-group:"]')
    await expect(group).toHaveCount(1)
    await expect(group).toHaveClass(/selected/)
    const groupToolbar = page.getByRole('toolbar', { name: '节点组操作' })
    await expect(groupToolbar.getByRole('button', { name: '整组执行' })).toBeVisible()
    await expect.poll(() => state.canvasLayout.groups?.length || 0).toBe(1)

    const groupBeforeMemberMove = await group.boundingBox()
    const nodeABeforeMemberMove = await nodeA.boundingBox()
    const nodeBBeforeMemberMove = await nodeB.boundingBox()
    const nodeBPreview = await nodeB.locator('.text-preview').boundingBox()
    expect(groupBeforeMemberMove).not.toBeNull()
    expect(nodeABeforeMemberMove).not.toBeNull()
    expect(nodeBBeforeMemberMove).not.toBeNull()
    expect(nodeBPreview).not.toBeNull()
    await page.mouse.move(nodeBPreview.x + 80, nodeBPreview.y + 60)
    await page.mouse.down()
    await page.mouse.move(nodeBPreview.x + 380, nodeBPreview.y + 220, { steps: 10 })
    await page.mouse.up()

    const groupAfterMemberMove = await group.boundingBox()
    const nodeAAfterMemberMove = await nodeA.boundingBox()
    const nodeBAfterMemberMove = await nodeB.boundingBox()
    expect(nodeAAfterMemberMove.x).toBeCloseTo(nodeABeforeMemberMove.x, 0)
    expect(nodeAAfterMemberMove.y).toBeCloseTo(nodeABeforeMemberMove.y, 0)
    expect(nodeBAfterMemberMove.x).toBeGreaterThan(nodeBBeforeMemberMove.x + 250)
    expect(nodeBAfterMemberMove.y).toBeGreaterThan(nodeBBeforeMemberMove.y + 120)
    expect(groupAfterMemberMove.width).toBeGreaterThan(groupBeforeMemberMove.width + 250)
    expect(groupAfterMemberMove.height).toBeGreaterThan(groupBeforeMemberMove.height + 120)
    expect(groupAfterMemberMove.x + groupAfterMemberMove.width)
      .toBeGreaterThanOrEqual(nodeBAfterMemberMove.x + nodeBAfterMemberMove.width)
    expect(groupAfterMemberMove.y + groupAfterMemberMove.height)
      .toBeGreaterThanOrEqual(nodeBAfterMemberMove.y + nodeBAfterMemberMove.height)
    await expect.poll(() => Number(state.canvasLayout.groups?.[0]?.width || 0))
      .toBeGreaterThan(groupAfterMemberMove.width)

    await page.reload()
    const restoredGroup = page.locator('.vue-flow__node[data-id^="canvas-group:"]')
    await expect(restoredGroup).toHaveCount(1)
    const restoredGroupBox = await restoredGroup.boundingBox()
    expect(restoredGroupBox.width).toBeCloseTo(groupAfterMemberMove.width, 0)
    expect(restoredGroupBox.height).toBeCloseTo(groupAfterMemberMove.height, 0)
    await restoredGroup.locator('.canvas-group-title').click()
    const restoredToolbar = page.getByRole('toolbar', { name: '节点组操作' })
    await restoredToolbar.getByRole('button', { name: '整组执行' }).click()
    await expect.poll(() => state.textRequests.length).toBe(2)
    expect(state.textRequests.map((request) => request.prompt).sort()).toEqual([
      '生成组内文案 A',
      '生成组内文案 B',
    ])

    const beforeDragA = await nodeA.boundingBox()
    const beforeDragB = await nodeB.boundingBox()
    const titleBox = await restoredGroup.locator('.canvas-group-title').boundingBox()
    expect(beforeDragA).not.toBeNull()
    expect(beforeDragB).not.toBeNull()
    expect(titleBox).not.toBeNull()
    await page.mouse.move(titleBox.x + 20, titleBox.y + 12)
    await page.mouse.down()
    await page.mouse.move(titleBox.x + 140, titleBox.y + 92, { steps: 8 })
    const liveDragA = await nodeA.boundingBox()
    const liveDragB = await nodeB.boundingBox()
    expect(liveDragA.x).toBeGreaterThan(beforeDragA.x + 80)
    expect(liveDragB.y).toBeGreaterThan(beforeDragB.y + 45)
    await page.mouse.up()

    await restoredToolbar.getByRole('button', { name: '解组' }).click()
    await expect(restoredGroup).toHaveCount(0)
    await expect(nodeA).toBeVisible()
    await expect(nodeB).toBeVisible()
    await expect.poll(() => state.canvasLayout.groups?.length || 0).toBe(0)

    const historyToolbar = page.getByLabel('画布历史操作')
    await historyToolbar.getByRole('button', { name: '撤销' }).click()
    await expect(page.locator('.vue-flow__node[data-id^="canvas-group:"]')).toHaveCount(1)
    await historyToolbar.getByRole('button', { name: '重做' }).click()
    await expect(page.locator('.vue-flow__node[data-id^="canvas-group:"]')).toHaveCount(0)
  })

  test('右键新增图片节点直接进入节点内编辑、可拖动且不弹创建表单', async ({ page }) => {
    const state = {
      canvasLayout: baseCanvasLayout(),
      assets: [],
      imageRequests: [],
      videoRequests: [],
      audioRequests: [],
      assetRequests: [],
    }
    await installStaticAndApiMocks(page, state)

    await page.goto('/canvas/3')
    const pane = page.locator('.vue-flow__pane')
    await expect(pane).toBeVisible()
    await pane.click({ button: 'right', position: { x: 760, y: 420 } })
    await page.getByRole('menu', { name: '添加画布节点' })
      .getByRole('menuitem', { name: /^图片 图片生成节点$/ })
      .click()

    await expect(page.getByRole('dialog', { name: '添加图片节点' })).toHaveCount(0)
    const node = page.locator('.vue-flow__node').filter({
      has: page.getByRole('textbox', { name: '节点标题' }),
    })
    await expect(node).toHaveCount(1)
    await expect(node).toHaveClass(/selected/)
    await expect(node.getByRole('textbox', { name: '节点标题' })).toHaveValue('图片')
    await expect(node.getByRole('button', { name: '上传' })).toBeVisible()
    const editor = page.getByRole('region', { name: '图片节点编辑器' })
    await expect(editor.getByRole('textbox', { name: '生成提示词' })).toBeVisible()
    await expect.poll(() => state.canvasLayout.free_nodes.length).toBe(1)
    expect(state.canvasLayout.free_nodes[0].data).toMatchObject({
      kind: 'image',
      title: '图片',
      content: '',
      model: '',
      aspectRatio: '16:9',
    })

    const originalPosition = { ...state.canvasLayout.free_nodes[0].position }
    await editor.getByRole('button', { name: '关闭编辑器' }).click()
    const dragSurface = node.locator('.media-stage')
    await expect(dragSurface).toHaveCSS('cursor', 'grab')
    const dragSurfaceBox = await dragSurface.boundingBox()
    expect(dragSurfaceBox).not.toBeNull()
    await page.mouse.move(
      dragSurfaceBox.x + 28,
      dragSurfaceBox.y + 28,
    )
    await page.mouse.down()
    await page.mouse.move(
      dragSurfaceBox.x + 148,
      dragSurfaceBox.y + 108,
      { steps: 8 },
    )
    await page.mouse.up()

    await expect.poll(() => state.canvasLayout.free_nodes[0].position).not.toEqual(originalPosition)
  })

  test('新建图片节点后点击空白处保持节点可见', async ({ page }) => {
    const state = {
      canvasLayout: baseCanvasLayout(),
      assets: [],
      imageRequests: [],
      videoRequests: [],
      audioRequests: [],
      assetRequests: [],
    }
    await installStaticAndApiMocks(page, state)

    await page.goto('/canvas/3')
    const pane = page.locator('.vue-flow__pane')
    await expect(pane).toBeVisible({ timeout: 15_000 })
    await pane.click({ button: 'right', position: { x: 760, y: 420 } })
    await page.getByRole('menu', { name: '添加画布节点' })
      .getByRole('menuitem', { name: /^图片 图片生成节点$/ })
      .click()

    const node = page.locator('.vue-flow__node[data-id^="free:image:"]')
    await expect(node).toHaveCount(1)
    await expect(node).toBeVisible()

    await pane.click({ position: { x: 120, y: 120 } })
    await expect(node).toHaveCount(1)
    await expect(node).toBeVisible()
    await expect.poll(() => state.canvasLayout.free_nodes.length).toBe(1)
  })

  test('自由节点可选择已配置模型、右键复制并直接挂载项目素材', async ({ page }) => {
    const state = {
      canvasLayout: baseCanvasLayout({
        free_nodes: [{
          id: 'free:image:mount',
          type: 'homeCanvasNode',
          position: { x: 240, y: 220 },
          data: {
            kind: 'image',
            title: '待挂载图片',
            content: '雨夜站台',
            model: '',
            aspectRatio: '16:9',
          },
        }],
      }),
      assets: [{
        id: 77,
        name: '项目雨夜参考图',
        type: 'image',
        url: '/static/library-rain.png',
      }],
      modelCatalog: [
        { kind: 'image', model: 'canvas-image-alpha' },
        { kind: 'image', model: 'canvas-image-beta' },
      ],
      imageRequests: [],
      videoRequests: [],
      audioRequests: [],
      assetRequests: [],
    }
    await installStaticAndApiMocks(page, state)

    await page.goto('/canvas/3')
    const node = page.locator('.vue-flow__node[data-id="free:image:mount"]')
    await expect(node).toBeVisible()
    await node.click()
    const editor = page.getByRole('region', { name: '图片节点编辑器' })
    await expect(editor).toBeVisible()
    await expect(editor.getByRole('combobox', { name: '生成模型' }).locator('option')).toHaveText([
      '默认图片模型',
      'canvas-image-alpha',
      'canvas-image-beta',
    ])
    await editor.getByRole('combobox', { name: '生成模型' }).selectOption('canvas-image-beta')
    await expect.poll(() => freeNode(state.canvasLayout, 'free:image:mount')?.data?.model).toBe('canvas-image-beta')

    await editor.getByRole('button', { name: '关闭编辑器' }).click()
    await node.getByRole('button', { name: '素材库' }).click()
    const picker = page.getByRole('dialog', { name: '挂载素材到当前节点' })
    await expect(picker).toBeVisible()
    const assetCard = picker.locator('.picker-card').filter({ hasText: '项目雨夜参考图' })
    await assetCard.getByRole('button', { name: '选用', exact: true }).click()
    await expect(picker).toBeHidden()
    await expect(node.locator('img[alt="待挂载图片"]')).toBeVisible()
    await expect.poll(() => freeNode(state.canvasLayout, 'free:image:mount')?.data).toMatchObject({
      url: '/static/library-rain.png',
      savedAssetId: '77',
      status: 'success',
      assetSaveStatus: 'success',
    })
    expect(state.assetRequests).toHaveLength(0)

    await node.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: '节点操作' })
    await menu.getByRole('menuitem', { name: /^复制节点 克隆到右下方$/ }).click()
    await expect.poll(() => state.canvasLayout.free_nodes.length).toBe(2)
    const copied = state.canvasLayout.free_nodes.find((item) => item.id !== 'free:image:mount')
    expect(copied).toMatchObject({
      position: { x: 280, y: 260 },
      data: {
        title: '待挂载图片 副本',
        url: '/static/library-rain.png',
        savedAssetId: '77',
        status: 'success',
        taskId: '',
      },
    })

    const copiedNode = page.locator(`.vue-flow__node[data-id="${copied.id}"]`)
    await copiedNode.click({ button: 'right' })
    await page.getByRole('menu', { name: '节点操作' }).getByRole('menuitem', { name: /删除节点/ }).click()
    await expect.poll(() => state.canvasLayout.free_nodes.length).toBe(1)
  })

  test('图片和视频节点的模型选择器完整展示目录中的可选模型', async ({ page }) => {
    const state = {
      canvasLayout: baseCanvasLayout({
        free_nodes: [
          {
            id: 'free:image:model-selector',
            type: 'homeCanvasNode',
            position: { x: 180, y: 180 },
            data: {
              kind: 'image',
              title: '图片模型选择',
              content: '雨夜站台',
              model: 'canvas-image-alpha',
              aspectRatio: '16:9',
            },
          },
          {
            id: 'free:video:model-selector',
            type: 'homeCanvasNode',
            position: { x: 880, y: 180 },
            data: {
              kind: 'video',
              title: '视频模型选择',
              content: '列车驶入站台',
              model: 'canvas-video-alpha',
              aspectRatio: '16:9',
              duration: 5,
            },
          },
        ],
      }),
      assets: [],
      modelCatalog: [
        { kind: 'image', model: 'canvas-image-alpha' },
        { kind: 'image', model: 'canvas-image-beta' },
        { kind: 'video', model: 'canvas-video-alpha' },
        { kind: 'video', model: 'canvas-video-beta' },
      ],
      imageRequests: [],
      videoRequests: [],
      audioRequests: [],
      assetRequests: [],
    }
    await installStaticAndApiMocks(page, state)

    await page.goto('/canvas/3')

    const imageNode = page.locator('.vue-flow__node[data-id="free:image:model-selector"]')
    await imageNode.click()
    const imageEditor = page.getByRole('region', { name: '图片节点编辑器' })
    const imageModelSelect = imageEditor.getByRole('combobox', { name: '生成模型' })
    await expect(imageModelSelect.locator('option')).toHaveText([
      '默认图片模型',
      'canvas-image-alpha',
      'canvas-image-beta',
    ])
    await imageModelSelect.selectOption('canvas-image-beta')
    await expect.poll(() => freeNode(state.canvasLayout, 'free:image:model-selector')?.data?.model).toBe('canvas-image-beta')
    await imageEditor.getByRole('button', { name: '关闭编辑器' }).click()

    const videoNode = page.locator('.vue-flow__node[data-id="free:video:model-selector"]')
    await videoNode.click()
    const videoEditor = page.getByRole('region', { name: '视频节点编辑器' })
    const videoModelSelect = videoEditor.getByRole('combobox', { name: '生成模型' })
    await expect(videoModelSelect.locator('option')).toHaveText([
      '默认视频模型',
      'canvas-video-alpha',
      'canvas-video-beta',
    ])
    await videoModelSelect.selectOption('canvas-video-beta')
    await expect.poll(() => freeNode(state.canvasLayout, 'free:video:model-selector')?.data?.model).toBe('canvas-video-beta')
  })

  test('图片节点生成后使用项目 ID 请求、自动入库并刷新恢复', async ({ page }) => {
    const state = {
      canvasLayout: baseCanvasLayout({
        free_nodes: [{
          id: 'free:image:1',
          type: 'homeCanvasNode',
          position: { x: 240, y: 220 },
          data: {
            kind: 'image',
            title: 'E2E 图片节点',
            content: '生成一张雨夜花园图',
            model: 'lib-image-e2e',
            aspectRatio: '16:9',
          },
        }],
      }),
      assets: [],
      imageRequests: [],
      videoRequests: [],
      audioRequests: [],
      assetRequests: [],
    }
    await installStaticAndApiMocks(page, state)

    await page.goto('/canvas/3')
    const node = page.locator('.vue-flow__node[data-id="free:image:1"]')
    await expect(node).toContainText('E2E 图片节点')
    await node.click()
    const editor = page.getByRole('region', { name: '图片节点编辑器' })
    await expect(editor).toBeVisible()
    await editor.getByRole('button', { name: '生成', exact: true }).click()

    await expect.poll(() => state.imageRequests).toEqual([{
      drama_id: 3,
      prompt: '生成一张雨夜花园图',
      model: 'lib-image-e2e',
      aspect_ratio: '16:9',
      size: '2048x1152',
    }])
    expect(state.imageRequests[0]).not.toHaveProperty('storyboard_id')
    expect(state.imageRequests[0]).not.toHaveProperty('storyboardId')

    await expect.poll(() => state.assetRequests.length).toBe(1)
    expect(state.assetRequests[0]).toMatchObject({
      drama_id: 3,
      storyboard_id: null,
      category: 'canvas-result',
      type: 'image',
      url: '/static/free-image.png',
      metadata: {
        canvas_node_id: 'free:image:1',
        task_id: 'img-task-1',
        model: 'lib-image-e2e',
      },
    })

    await expect(node).toContainText('已生成')
    await expect(node.locator('img[alt="E2E 图片节点"]')).toBeVisible()
    await expect.poll(() => freeNode(state.canvasLayout, 'free:image:1')?.data).toMatchObject({
      kind: 'image',
      status: 'success',
      url: '/static/free-image.png',
      taskId: 'img-task-1',
      savedAssetId: '901',
      assetSaveStatus: 'success',
    })

    await page.reload()
    const restored = page.locator('.vue-flow__node[data-id="free:image:1"]')
    await expect(restored).toContainText('已生成')
    await expect(restored.locator('img[alt="E2E 图片节点"]')).toBeVisible()
  })

  test('文本节点可调用真实文本入口、写回结果并执行中英互译', async ({ page }) => {
    const state = {
      canvasLayout: baseCanvasLayout({
        free_nodes: [{
          id: 'free:text:1',
          type: 'homeCanvasNode',
          position: { x: 240, y: 220 },
          data: {
            kind: 'text',
            title: 'E2E 文本节点',
            content: '写一段雨夜花园旁白',
            model: 'text-e2e',
          },
        }],
      }),
      assets: [],
      imageRequests: [],
      videoRequests: [],
      audioRequests: [],
      textRequests: [],
      assetRequests: [],
    }
    await installStaticAndApiMocks(page, state)

    await page.goto('/canvas/3')
    const node = page.locator('.vue-flow__node[data-id="free:text:1"]')
    await node.click()
    const editor = page.getByRole('region', { name: '文本节点编辑器' })
    await editor.getByRole('button', { name: 'AI 生成文本' }).click()

    await expect.poll(() => state.textRequests[0]).toEqual({
      drama_id: 3,
      prompt: '写一段雨夜花园旁白',
      model: 'text-e2e',
    })
    await expect.poll(() => freeNode(state.canvasLayout, 'free:text:1')?.data).toMatchObject({
      content: 'AI 生成后的完整文本',
      status: 'success',
      error: '',
    })

    await editor.getByRole('button', { name: '中英互译' }).click()
    await expect.poll(() => state.textRequests.length).toBe(2)
    expect(state.textRequests[1].prompt).toContain('翻译成自然、准确的英文')
    await expect.poll(() => freeNode(state.canvasLayout, 'free:text:1')?.data?.content)
      .toBe('A natural English translation.')
  })

  test('图片节点多结果逐个生成、自动入库并可切换主结果', async ({ page }) => {
    const state = {
      canvasLayout: baseCanvasLayout({
        free_nodes: [{
          id: 'free:image:multi',
          type: 'homeCanvasNode',
          position: { x: 240, y: 220 },
          data: {
            kind: 'image',
            title: 'E2E 多结果图片',
            content: '雨夜茉莉花',
            model: 'lib-image-e2e',
            aspectRatio: '1:1',
            quantity: 2,
          },
        }],
      }),
      assets: [],
      imageRequests: [],
      videoRequests: [],
      audioRequests: [],
      assetRequests: [],
    }
    await installStaticAndApiMocks(page, state)

    await page.goto('/canvas/3')
    const node = page.locator('.vue-flow__node[data-id="free:image:multi"]')
    await node.click()
    const editor = page.getByRole('region', { name: '图片节点编辑器' })
    await editor.getByRole('button', { name: '生成', exact: true }).click()

    await expect.poll(() => state.imageRequests.length).toBe(2)
    await expect.poll(() => state.assetRequests.length).toBe(2)
    await expect.poll(() => freeNode(state.canvasLayout, 'free:image:multi')?.data).toMatchObject({
      status: 'success',
      url: '/static/free-image-2.png',
      resultUrls: ['/static/free-image.png', '/static/free-image-2.png'],
      savedAssetId: '902',
    })
    await expect(node.getByRole('button', { name: '设为当前结果' })).toHaveCount(2)
    await node.getByRole('button', { name: '设为当前结果' }).first().click()
    await expect.poll(() => freeNode(state.canvasLayout, 'free:image:multi')?.data?.url)
      .toBe('/static/free-image.png')
  })

  test('视频节点失败后可重试，并携带上游首帧引用且不污染分镜字段', async ({ page }) => {
    const state = {
      canvasLayout: baseCanvasLayout({
        manual_edges: [{
          id: 'manual:free:image:1::free:video:1:',
          source: 'free:image:1',
          target: 'free:video:1',
          type: 'smoothstep',
          data: { manual: true },
        }],
        free_nodes: [
          {
            id: 'free:image:1',
            type: 'homeCanvasNode',
            position: { x: 160, y: 220 },
            data: {
              kind: 'image',
              title: '上游首帧',
              content: '已生成首帧',
              url: '/static/upstream-first.png',
              status: 'success',
              savedAssetId: '800',
            },
          },
          {
            id: 'free:video:1',
            type: 'homeCanvasNode',
            position: { x: 520, y: 220 },
            data: {
              kind: 'video',
              title: 'E2E 视频节点',
              content: '镜头从花园推向人物',
              model: 'grok-video-e2e',
              aspectRatio: '16:9',
              duration: 5,
            },
          },
        ],
      }),
      assets: [],
      imageRequests: [],
      videoRequests: [],
      audioRequests: [],
      assetRequests: [],
    }
    await installStaticAndApiMocks(page, state)

    await page.goto('/canvas/3')
    const node = page.locator('.vue-flow__node[data-id="free:video:1"]')
    await expect(node).toContainText('E2E 视频节点')
    await node.click()
    const editor = page.getByRole('region', { name: '视频节点编辑器' })
    await expect(editor).toBeVisible()
    const automaticReferences = editor.getByRole('region', { name: '自动参考图' })
    await expect(automaticReferences).toContainText('1/1 已就绪')
    await expect(automaticReferences.locator('img[alt="上游首帧"]')).toBeVisible()
    await expect(automaticReferences.locator('[data-reference-state="ready"]')).toHaveCount(1)
    await editor.getByRole('button', { name: '生成', exact: true }).click()

    await expect.poll(() => state.videoRequests.length).toBe(1)
    await expect(node).toContainText('失败')
    await expect(node).toContainText('视频模型临时失败')

    await editor.getByRole('button', { name: '重试', exact: true }).click()
    await expect.poll(() => state.videoRequests.length).toBe(2)
    expect(state.videoRequests[1]).toMatchObject({
      drama_id: 3,
      prompt: '镜头从花园推向人物',
      model: 'grok-video-e2e',
      image_url: '/static/upstream-first.png',
      first_frame_url: '/static/upstream-first.png',
      reference_image_urls: ['/static/upstream-first.png'],
      aspect_ratio: '16:9',
      duration: 5,
    })
    expect(state.videoRequests[1]).not.toHaveProperty('storyboard_id')
    expect(state.videoRequests[1]).not.toHaveProperty('storyboardId')

    await expect.poll(() => state.assetRequests.length).toBe(1)
    expect(state.assetRequests[0]).toMatchObject({
      drama_id: 3,
      storyboard_id: null,
      category: 'canvas-result',
      type: 'video',
      url: '/static/free-video.mp4',
    })
    await expect(node).toContainText('已生成')
    await expect(node.locator('video')).toBeAttached()
    await expect.poll(() => freeNode(state.canvasLayout, 'free:video:1')?.data).toMatchObject({
      status: 'success',
      url: '/static/free-video.mp4',
      taskId: 'video-task-2',
      savedAssetId: '901',
    })
  })

  test('音频节点同步返回 URL 时成功预览并自动入库', async ({ page }) => {
    const state = {
      canvasLayout: baseCanvasLayout({
        free_nodes: [{
          id: 'free:audio:1',
          type: 'homeCanvasNode',
          position: { x: 240, y: 220 },
          data: {
            kind: 'audio',
            title: 'E2E 音频节点',
            content: '茉莉妈妈短剧制作平台欢迎你',
            model: 'voice-e2e',
          },
        }],
      }),
      assets: [],
      imageRequests: [],
      videoRequests: [],
      audioRequests: [],
      assetRequests: [],
    }
    await installStaticAndApiMocks(page, state)

    await page.goto('/canvas/3')
    const node = page.locator('.vue-flow__node[data-id="free:audio:1"]')
    await expect(node).toContainText('E2E 音频节点')
    await node.click()
    const editor = page.getByRole('region', { name: '音频节点编辑器' })
    await expect(editor).toBeVisible()
    await editor.getByRole('button', { name: '生成', exact: true }).click()

    await expect.poll(() => state.audioRequests).toEqual([{
      drama_id: 3,
      text: '茉莉妈妈短剧制作平台欢迎你',
      tts_model: 'voice-e2e',
      speed: 1,
      volume: 1,
      pitch: 0,
    }])
    expect(state.audioRequests[0]).not.toHaveProperty('storyboard_id')
    expect(state.audioRequests[0]).not.toHaveProperty('storyboardId')

    await expect(node).toContainText('已生成')
    await expect(node.locator('audio')).toBeAttached()
    await expect.poll(() => state.assetRequests.length).toBe(1)
    await expect.poll(() => state.assetRequests[0]).toMatchObject({
      drama_id: 3,
      storyboard_id: null,
      category: 'canvas-result',
      type: 'audio',
      url: '/static/free-audio.mp3',
    })
    await expect.poll(() => freeNode(state.canvasLayout, 'free:audio:1')?.data).toMatchObject({
      status: 'success',
      url: '/static/free-audio.mp3',
      savedAssetId: '901',
      assetSaveStatus: 'success',
      assetSaveError: '',
    })
  })
})
