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
      await route.fulfill(apiData({ id: 401, task_id: 'img-task-1' }))
      return
    }

    if (method === 'GET' && pathname === '/api/v1/tasks/img-task-1') {
      await route.fulfill(apiData({
        id: 'img-task-1',
        status: 'completed',
        result: { image_url: '/static/free-image.png' },
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
      '/api/v1/ai-configs',
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
      has: page.getByRole('textbox', { name: '生成提示词' }),
    })
    await expect(node).toHaveCount(1)
    await expect(node).toHaveClass(/selected/)
    await expect(node.getByRole('textbox', { name: '节点标题' })).toHaveValue('图片')
    await expect(node.getByRole('button', { name: '上传' })).toBeVisible()
    await expect.poll(() => state.canvasLayout.free_nodes.length).toBe(1)
    expect(state.canvasLayout.free_nodes[0].data).toMatchObject({
      kind: 'image',
      title: '图片',
      content: '',
      model: '',
      aspectRatio: '16:9',
    })

    const originalPosition = { ...state.canvasLayout.free_nodes[0].position }
    const dragHandle = node.locator('.node-drag-grip')
    await expect(dragHandle).toHaveCount(1)
    await page.mouse.move(20, 20)
    await expect.poll(() => dragHandle.evaluate((element) => ({
      opacity: getComputedStyle(element).opacity,
      pointerEvents: getComputedStyle(element).pointerEvents,
    }))).toEqual({ opacity: '0', pointerEvents: 'none' })

    await node.hover()
    await expect.poll(() => dragHandle.evaluate((element) => ({
      opacity: getComputedStyle(element).opacity,
      pointerEvents: getComputedStyle(element).pointerEvents,
      cursor: getComputedStyle(element).cursor,
    }))).toEqual({ opacity: '1', pointerEvents: 'auto', cursor: 'grab' })

    const dragHandleBox = await dragHandle.boundingBox()
    expect(dragHandleBox).not.toBeNull()
    await page.mouse.move(
      dragHandleBox.x + dragHandleBox.width / 2,
      dragHandleBox.y + dragHandleBox.height / 2,
    )
    await page.mouse.down()
    await page.mouse.move(
      dragHandleBox.x + dragHandleBox.width / 2 + 120,
      dragHandleBox.y + dragHandleBox.height / 2 + 80,
      { steps: 8 },
    )
    await page.mouse.up()

    await expect.poll(() => state.canvasLayout.free_nodes[0].position).not.toEqual(originalPosition)
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
    await node.getByRole('button', { name: '生成', exact: true }).click()

    await expect.poll(() => state.imageRequests).toEqual([{
      drama_id: 3,
      prompt: '生成一张雨夜花园图',
      model: 'lib-image-e2e',
      aspect_ratio: '16:9',
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
    await node.getByRole('button', { name: '生成', exact: true }).click()

    await expect.poll(() => state.videoRequests.length).toBe(1)
    await expect(node).toContainText('失败')
    await expect(node).toContainText('视频模型临时失败')

    await node.getByRole('button', { name: '重试', exact: true }).click()
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
    await node.getByRole('button', { name: '生成', exact: true }).click()

    await expect.poll(() => state.audioRequests).toEqual([{
      drama_id: 3,
      text: '茉莉妈妈短剧制作平台欢迎你',
      tts_model: 'voice-e2e',
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
