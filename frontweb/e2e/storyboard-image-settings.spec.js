import { test, expect } from '@playwright/test'

test.use({ viewport: { width: 1440, height: 900 } })

test('CV-IMG-001 分镜图模型与宫格设置可保存恢复并用于生图', async ({ page }) => {
  const storyboard = {
    id: 301,
    episode_id: 31,
    storyboard_number: 1,
    title: '林中遇险',
    description: '雨后原始森林深处，人物在树根旁停下。',
    image_prompt: '雨后原始森林，人物站在古树根旁，电影感写实画面。',
    video_prompt: '人物警觉地观察四周。',
    duration: 5,
    status: 'pending',
    image_model: null,
    grid_frame_type: 'single',
    video_model: null,
  }
  const imageRequests = []
  const updateRequests = []
  const project = () => ({
    id: 3,
    title: '浏览器回归项目',
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
      storyboards: [{ ...storyboard }],
    }],
  })

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    if (path === '/api/v1/dramas/3' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: project() }) })
      return
    }
    if (path === '/api/v1/storyboards/301' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { ...storyboard } }) })
      return
    }
    if (path === '/api/v1/storyboards/301' && method === 'PUT') {
      const payload = request.postDataJSON() || {}
      updateRequests.push(payload)
      Object.assign(storyboard, payload)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { ...storyboard } }) })
      return
    }
    if (path === '/api/v1/video-models' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: ['grok-video-3'] }) })
      return
    }
    if (path === '/api/v1/image-models' && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: ['lib-image-default', 'lib-image-grid'],
        }),
      })
      return
    }
    if (path === '/api/v1/audio-models' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) })
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
    if (path === '/api/v1/assets' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { items: [] } }) })
      return
    }
    if (path === '/api/v1/images' && method === 'POST') {
      const payload = request.postDataJSON() || {}
      imageRequests.push(payload)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: 401, image_url: '/static/generated-grid.png' } }) })
      return
    }
    if (path === '/api/v1/dramas/3/canvas-layout' || path === '/api/v1/dramas/3/outline') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) })
  })

  await page.goto('/film/3/canvas')
  const storyboardNode = page.locator('.vue-flow__node[data-id="sb:301"]')
  await expect(storyboardNode).toBeVisible()
  await storyboardNode.locator('.canvas-sb-node').evaluate((element) => element.click())

  const panel = page.locator('.sb-panel')
  await expect(panel).toContainText('分镜 #1')

  const imageModelSelect = panel.locator('.generation-options .model-select').first()
  await expect(imageModelSelect.locator('input')).toBeEnabled()
  await imageModelSelect.locator('.el-select__wrapper').evaluate((element) => element.click())
  const imageModelOption = page.locator('.el-select-dropdown:visible .el-select-dropdown__item').filter({ hasText: 'lib-image-grid' })
  await expect(imageModelOption).toBeVisible()
  await imageModelOption.click()
  await expect.poll(() => storyboard.image_model).toBe('lib-image-grid')

  const gridSelect = panel.locator('.camera-control-grid .el-select').last()
  await gridSelect.locator('.el-select__wrapper').evaluate((element) => element.click())
  const gridOption = page.locator('.el-select-dropdown:visible .el-select-dropdown__item').filter({ hasText: '九宫格' })
  await expect(gridOption).toBeVisible()
  await gridOption.click()
  await expect.poll(() => storyboard.grid_frame_type).toBe('nine_grid')
  expect(updateRequests).toEqual(expect.arrayContaining([
    expect.objectContaining({ image_model: 'lib-image-grid' }),
    expect.objectContaining({ grid_frame_type: 'nine_grid' }),
  ]))

  await page.reload()
  const restoredNode = page.locator('.vue-flow__node[data-id="sb:301"] .canvas-sb-node')
  await expect(restoredNode).toBeVisible()
  await restoredNode.click()
  const restoredPanel = page.locator('.sb-panel')
  await expect(restoredPanel.locator('.generation-options .model-select').first().locator('.el-select__placeholder')).toHaveText('lib-image-grid')
  await expect(restoredPanel.locator('.camera-control-grid .el-select').last().locator('.el-select__placeholder')).toHaveText('九宫格')

  await restoredPanel.getByRole('button', { name: '生图' }).evaluate((element) => element.click())
  await expect.poll(() => imageRequests.length).toBe(1)
  expect(imageRequests[0]).toMatchObject({
    storyboard_id: 301,
    drama_id: 3,
    model: 'lib-image-grid',
    frame_type: 'nine_grid',
  })
  await expect(page.locator('.el-message').filter({ hasText: '生图完成' })).toBeVisible()
})
