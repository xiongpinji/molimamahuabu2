import { test, expect } from '@playwright/test'

const catalog = [
  { category: 'text', model: 'text-model', display_name: '文字模型', credits: 5, billing_unit: 'request' },
  { category: 'image', model: 'image-model', display_name: '图片模型', credits: 8, billing_unit: 'request' },
  { category: 'video', model: 'video-model', display_name: '视频模型', credits: 12, billing_unit: 'second' },
]

async function prepare(page, onRequest) {
  await page.addInitScript(() => {
    window.localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'home-quick-generation-session',
      user: { id: 'user-1', email: 'creator@example.com', role: 'user' },
    }))
  })
  await page.route('**/static/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.endsWith('.mp4')) {
      await route.fulfill({ contentType: 'video/mp4', body: Buffer.alloc(0) })
      return
    }
    const pixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    await route.fulfill({ contentType: 'image/png', body: pixel })
  })
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const responseData = await onRequest?.(request, url)
    if (responseData !== undefined) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: responseData }) })
      return
    }

    const defaults = {
      '/api/v1/billing/catalog': catalog,
      '/api/v1/billing/account': { available: 1000, held: 0, spent: 0 },
      '/api/v1/dramas': { items: [], pagination: { total: 0 } },
      '/api/v1/dramas/examples': [],
      '/api/v1/settings/generation': { video_generation_timeout_minutes: 1 },
      '/api/v1/auth/me': { id: 'user-1', email: 'creator@example.com', role: 'user' },
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: defaults[url.pathname] ?? {} }),
    })
  })
}

test('首页文字生成会自动提交独立文本接口并刷新余额', async ({ page }) => {
  let submitted
  let accountReads = 0
  await prepare(page, async (request, url) => {
    if (url.pathname === '/api/v1/billing/account') {
      accountReads += 1
      return { available: accountReads >= 3 ? 995 : 1000, held: 0, spent: accountReads >= 3 ? 5 : 0 }
    }
    if (request.method() === 'POST' && url.pathname === '/api/v1/canvas/text/generate') {
      submitted = request.postDataJSON()
      return { content: '这是一段真实接口返回的文字。', model: 'text-model' }
    }
    return undefined
  })

  await page.goto('/')
  await page.getByLabel('生成类型').selectOption('text')
  await expect(page.getByRole('button', { name: '文字无需参考图' })).toBeDisabled()
  await expect(page.getByLabel('画面比例')).toHaveCount(0)
  await expect(page.getByLabel('预计消耗积分')).toContainText('5')
  await page.getByLabel('描述想生成的内容').fill('写一句开场白')
  await page.locator('.home-generate').click()

  await expect(page).toHaveURL(/\/free-create\?mode=text&source=home$/)
  await expect(page.getByText('这是一段真实接口返回的文字。')).toBeVisible()
  expect(submitted.prompt).toBe('写一句开场白')
  expect(submitted.model).toBe('text-model')
  expect(submitted.drama_id).toBeUndefined()
  expect(String(submitted.request_id)).not.toBe('')
  expect(accountReads).toBeGreaterThanOrEqual(3)
})

test('首页图片参考图上传后会传入图片生成请求', async ({ page }) => {
  let submitted
  await prepare(page, async (request, url) => {
    if (request.method() === 'POST' && url.pathname === '/api/v1/upload/image') {
      return { url: '/static/uploads/reference.png', local_path: 'uploads/reference.png' }
    }
    if (request.method() === 'POST' && url.pathname === '/api/v1/images') {
      submitted = request.postDataJSON()
      return { image_url: '/static/generated/home-image.png' }
    }
    return undefined
  })

  await page.goto('/')
  await page.getByLabel('生成类型').selectOption('image')
  await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles({
    name: 'reference.png',
    mimeType: 'image/png',
    buffer: Buffer.from('reference-image'),
  })
  await expect(page.getByAltText('已上传的参考图')).toBeVisible()
  await expect(page.getByLabel('预计消耗积分')).toContainText('8')
  await page.getByLabel('描述想生成的内容').fill('生成一张海边插画')
  await page.locator('.home-generate').click()

  await expect(page).toHaveURL(/\/free-create\?mode=image&source=home$/)
  await expect(page.locator('img[src="/static/generated/home-image.png"]')).toBeVisible()
  expect(submitted).toMatchObject({
    prompt: '生成一张海边插画',
    model: 'image-model',
    aspect_ratio: '16:9',
    reference_images: ['/static/uploads/reference.png'],
  })
})

test('首页视频价格按秒计算且完整参数进入视频任务', async ({ page }) => {
  let submitted
  await prepare(page, async (request, url) => {
    if (request.method() === 'POST' && url.pathname === '/api/v1/videos') {
      submitted = request.postDataJSON()
      return { task_id: 'video-task-1' }
    }
    if (url.pathname === '/api/v1/tasks/video-task-1') {
      return { status: 'completed', result: JSON.stringify({ video_url: '/static/generated/home-video.mp4' }) }
    }
    return undefined
  })

  await page.goto('/')
  await expect(page.getByLabel('预计消耗积分')).toContainText('60')
  await page.getByLabel('视频时长').selectOption('10')
  await page.getByLabel('视频清晰度').selectOption('1080p')
  await expect(page.getByLabel('预计消耗积分')).toContainText('120')
  await page.getByLabel('描述想生成的内容').fill('生成一段云海延时视频')
  await page.locator('.home-generate').click()

  await expect(page).toHaveURL(/\/free-create\?mode=video&source=home$/)
  await expect(page.locator('video[src="/static/generated/home-video.mp4"]')).toBeVisible({ timeout: 10_000 })
  expect(submitted).toMatchObject({
    prompt: '生成一段云海延时视频',
    model: 'video-model',
    aspect_ratio: '16:9',
    duration: 10,
    resolution: '1080p',
  })
})
