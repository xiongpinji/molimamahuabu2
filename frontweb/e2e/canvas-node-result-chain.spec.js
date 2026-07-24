import { test, expect } from '@playwright/test'

const nodeStatusKey = 'moli_canvas_node_status:3'

function mockDrama() {
  return {
    id: 3,
    title: '画布节点结果回归项目',
    metadata: {
      image_model: 'lib-image-default',
      video_model: 'grok-video-3',
      aspect_ratio: '16:9',
      video_resolution: '480p',
    },
    characters: [],
    scenes: [],
    props: [],
    episodes: [{
      id: 31,
      episode_number: 1,
      title: '第一集',
      script_content: '人物进入森林。',
      storyboards: [
        {
          id: 301,
          episode_id: 31,
          storyboard_number: 1,
          title: '已完成镜头',
          shot_title: '已完成镜头',
          description: '雨后森林，人物站在树根旁。',
          image_prompt: '雨后森林，电影感。',
          video_prompt: '人物警觉地观察四周。',
          duration: 5,
          status: 'pending',
        },
        {
          id: 302,
          episode_id: 31,
          storyboard_number: 2,
          title: '待重试镜头',
          shot_title: '待重试镜头',
          description: '人物继续向前。',
          image_prompt: '人物穿过湿润森林。',
          video_prompt: '人物从树影下走出。',
          duration: 5,
          status: 'pending',
        },
      ],
    }],
  }
}

test.use({ viewport: { width: 1440, height: 900 } })

test('CV-NODE-RESULT-001 画布节点结果恢复、素材引用复制、定位和失败重试闭环', async ({ page }) => {
  let retryImageCreated = false
  const imageRequests = []
  const assetRequests = []

  await page.addInitScript((storageKey) => {
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__copiedText = text
        },
      },
    })
    window.localStorage.setItem(storageKey, JSON.stringify({
      'sb:301': {
        step: 'success',
        message: '节点执行完成',
        resultUrl: '/static/generated-main.png',
        resultNodeId: 'sbimg:301',
        resultType: 'image',
        resultLabel: '图片已生成',
        savedAssetId: 77,
        savedAssetName: '已完成镜头结果',
        savedAssetUrl: '/static/generated-main.png',
        promptText: '雨后森林，电影感。',
        storyboardId: 301,
        at: Date.now(),
      },
      'sb:302': {
        step: 'failed',
        message: '旧任务失败',
        errorDetail: '旧任务失败',
        retryStep: 'image',
        retryLabel: '重试图片任务',
        promptText: '人物穿过湿润森林。',
        storyboardId: 302,
        at: Date.now(),
      },
    }))
  }, nodeStatusKey)

  await page.route('**/static/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    })
  })

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (path === '/api/v1/dramas/3' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: mockDrama() }) })
      return
    }
    if (path === '/api/v1/ai-configs' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [{ service_type: 'image', is_active: true, is_default: true, model: 'lib-image-default' }] }) })
      return
    }
    if (path === '/api/v1/images' && method === 'GET') {
      const storyboardId = Number(url.searchParams.get('storyboard_id'))
      const items = storyboardId === 301
        ? [{ id: 401, storyboard_id: 301, status: 'completed', image_url: '/static/generated-main.png', local_path: 'generated-main.png' }]
        : storyboardId === 302 && retryImageCreated
          ? [{ id: 402, storyboard_id: 302, status: 'completed', image_url: '/static/generated-retry.png', local_path: 'generated-retry.png' }]
          : []
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { items } }) })
      return
    }
    if (path === '/api/v1/images' && method === 'POST') {
      imageRequests.push(request.postDataJSON() || {})
      retryImageCreated = true
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: 402, image_url: '/static/generated-retry.png' } }) })
      return
    }
    if (path === '/api/v1/videos' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { items: [] } }) })
      return
    }
    if (path === '/api/v1/assets' && method === 'GET') {
      const type = url.searchParams.get('type')
      const items = type === 'image'
        ? [{ id: 77, name: '已完成镜头结果', type: 'image', url: '/static/generated-main.png', category: 'canvas-result' }]
        : []
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { items, total: items.length } }) })
      return
    }
    if (path === '/api/v1/assets' && method === 'POST') {
      const payload = request.postDataJSON() || {}
      assetRequests.push(payload)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { ...payload, id: 88, name: payload.name || '重试结果', url: payload.url } }) })
      return
    }
    if (path === '/api/v1/dramas/3/canvas-layout' || path === '/api/v1/dramas/3/outline') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) })
  })

  await page.goto('/film/3/canvas')

  const completedNode = page.locator('.vue-flow__node[data-id="sb:301"]')
  await expect(completedNode).toBeVisible()
  await expect(completedNode).toContainText('图片已生成')
  await expect(completedNode.getByRole('button', { name: '复制素材引用' })).toBeVisible()
  await expect(completedNode.getByRole('button', { name: '查看素材' })).toBeVisible()

  const runQueue = page.getByLabel('画布节点运行队列')
  await expect(runQueue).toContainText('0 进行中 · 1 完成 · 1 异常')
  const successQueueItem = runQueue.locator('.run-queue-item', { hasText: '已完成镜头' })
  await expect(successQueueItem).toContainText('图片已生成')
  await expect(successQueueItem.getByRole('button', { name: '复制' })).toBeVisible()
  await successQueueItem.getByRole('button', { name: '复制' }).click()
  await expect.poll(() => page.evaluate(() => window.__copiedText || '')).toBe('/static/generated-main.png')
  await successQueueItem.getByRole('button', { name: '定位' }).click()
  await expect(page.locator('.vue-flow__node[data-id="sbimg:301"]')).toBeVisible()

  await completedNode.click({ button: 'right' })
  await expect(page.getByRole('menu', { name: '节点操作' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /复制素材引用/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /定位结果节点/ })).toBeVisible()
  await page.getByRole('menuitem', { name: /复制素材引用/ }).click()
  await expect.poll(() => page.evaluate(() => window.__copiedText || '')).toContain('@素材(已完成镜头结果#77) /static/generated-main.png')

  await completedNode.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /定位结果节点/ }).click()
  await expect(page.locator('.vue-flow__node[data-id="sbimg:301"]')).toBeVisible()

  const failedNode = page.locator('.vue-flow__node[data-id="sb:302"]')
  await expect(failedNode).toBeVisible()
  await failedNode.getByRole('button', { name: '重试图片任务' }).click()

  await expect.poll(() => imageRequests.length).toBe(1)
  expect(imageRequests[0]).toMatchObject({
    storyboard_id: 302,
    drama_id: 3,
    model: 'lib-image-default',
  })
  await expect.poll(() => assetRequests.length).toBe(1)
  expect(assetRequests[0]).toMatchObject({
    drama_id: 3,
    storyboard_id: 302,
    type: 'image',
    category: 'canvas-result',
    url: '/static/generated-retry.png',
  })
  await expect(failedNode).toContainText('图片已生成')
  await expect(failedNode.getByRole('button', { name: '复制素材引用' })).toBeVisible()

  await completedNode.getByRole('button', { name: '查看素材' }).click()
  await expect.poll(() => page.evaluate(() => ({
    pathname: window.location.pathname,
    assetId: new URLSearchParams(window.location.search).get('assetId'),
    type: new URLSearchParams(window.location.search).get('type'),
  }))).toEqual({
    pathname: '/media-library',
    assetId: '77',
    type: 'image',
  })
  await expect(page.locator('.media-card.targeted', { hasText: '已完成镜头结果' })).toContainText('画布结果定位')
})

test('CV-ASSET-LIB-001 分镜面板从当前项目素材库指派参考图并回显', async ({ page }) => {
  let assigned = false
  const assetListQueries = []
  const assetUpdateRequests = []

  await page.route('**/static/**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    })
  })

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (path === '/api/v1/dramas/3' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: mockDrama() }) })
      return
    }
    if (path === '/api/v1/storyboards/301' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: mockDrama().episodes[0].storyboards[0] }) })
      return
    }
    if (path === '/api/v1/ai-configs' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [{ service_type: 'image', is_active: true, is_default: true, model: 'lib-image-default' }] }) })
      return
    }
    if (path === '/api/v1/video-models' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [{ model: 'grok-video-3', is_active: true }] }) })
      return
    }
    if (path === '/api/v1/images' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { items: [] } }) })
      return
    }
    if (path === '/api/v1/videos' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { items: [] } }) })
      return
    }
    if (['/api/v1/character-library', '/api/v1/scene-library', '/api/v1/prop-library'].includes(path) && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { items: [] } }) })
      return
    }
    if (path === '/api/v1/assets' && method === 'GET') {
      assetListQueries.push(Object.fromEntries(url.searchParams.entries()))
      const storyboardId = Number(url.searchParams.get('storyboard_id'))
      const dramaId = Number(url.searchParams.get('drama_id'))
      const items = storyboardId === 301
        ? (assigned ? [{ id: 501, name: '森林参考图', type: 'image', local_path: 'forest-ref.png', storyboard_id: 301 }] : [])
        : dramaId === 3
          ? [{ id: 501, name: '森林参考图', type: 'image', local_path: 'forest-ref.png', drama_id: 3 }]
          : []
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { items } }) })
      return
    }
    if (path === '/api/v1/assets/501' && method === 'PUT') {
      const payload = request.postDataJSON() || {}
      assetUpdateRequests.push(payload)
      assigned = true
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: 501, name: '森林参考图', type: 'image', local_path: 'forest-ref.png', ...payload } }) })
      return
    }
    if (path === '/api/v1/dramas/3/canvas-layout' || path === '/api/v1/dramas/3/outline') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) })
  })

  await page.goto('/film/3/canvas')
  const storyboardNode = page.locator('.vue-flow__node[data-id="sb:301"] .canvas-sb-node')
  await expect(storyboardNode).toBeVisible()
  await storyboardNode.evaluate((element) => element.click())

  const panel = page.locator('.sb-panel')
  await expect(panel).toContainText('分镜 #1')
  await panel.getByRole('button', { name: '+素材库' }).evaluate((element) => element.click())
  await page.getByRole('menuitem', { name: '指派参考图' }).click()

  const pickerDialog = page.getByRole('dialog', { name: '从素材库指派参考图' })
  await expect(pickerDialog).toBeVisible()
  await expect(pickerDialog.locator('.picker-name', { hasText: '森林参考图' })).toBeVisible()
  expect(assetListQueries).toEqual(expect.arrayContaining([
    expect.objectContaining({ drama_id: '3', type: 'image' }),
  ]))

  await pickerDialog.locator('.picker-card', { hasText: '森林参考图' }).getByRole('button', { name: '选用' }).click()
  await expect.poll(() => assetUpdateRequests.length).toBe(1)
  expect(assetUpdateRequests[0]).toMatchObject({ drama_id: 3, storyboard_id: 301 })
  await expect(panel.locator('.reference-strip')).toContainText('森林参考图')
})
