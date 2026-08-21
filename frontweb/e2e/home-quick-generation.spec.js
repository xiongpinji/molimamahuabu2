import { test, expect } from '@playwright/test'

const catalog = [
  { category: 'text', model: 'text-model', display_name: '文字模型', public_note: '适合文字扩写与改写', credits: 5, billing_unit: 'request' },
  { category: 'image', model: 'image-model', display_name: '图片模型', public_note: '适合图片创作', credits: 8, billing_unit: 'request' },
  { category: 'video', model: 'video-model', display_name: '视频模型', public_note: '适合视频创作', credits: 12, billing_unit: 'second' },
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

test('首页模型选择器展示公开目录名称与所选模型备注', async ({ page }) => {
  const homeCatalog = [
    { category: 'video', model: 'video-public-raw', display_name: '视频公开版', public_note: '适合广告分镜与短剧预演', credits: 12, billing_unit: 'second' },
    { category: 'video', model: 'video-without-note', display_name: '视频简洁版', public_note: '   ', credits: 10, billing_unit: 'second' },
  ]
  await prepare(page, async (_request, url) => (
    url.pathname === '/api/v1/billing/catalog' ? homeCatalog : undefined
  ))

  await page.goto('/')

  const modelSelect = page.getByLabel('生成模型')
  await expect(modelSelect).toHaveValue('video-public-raw')
  await expect(modelSelect.locator('option:checked')).toHaveText('视频公开版')
  await expect(page.locator('.home-model-note')).toHaveText('适合广告分镜与短剧预演')
  await expect(modelSelect.locator('option')).toHaveCount(2)

  await modelSelect.selectOption('video-without-note')
  await expect(modelSelect.locator('option:checked')).toHaveText('视频简洁版')
  await expect(page.locator('.home-model-note')).toHaveCount(0)
})

test('自由创作刷新公开目录后更新默认模型与备注且空备注不占空间', async ({ page }) => {
  let catalogReads = 0
  let submitted
  const catalogs = [
    [
      { category: 'text', model: 'first-public-raw', display_name: '初始公开文字模型', public_note: '初始目录备注', credits: 12, billing_unit: 'request' },
    ],
    [
      { category: 'text', model: 'refreshed-public-raw', display_name: '刷新后公开文字模型', public_note: '刷新后的目录备注', credits: 14, billing_unit: 'request' },
      { category: 'text', model: 'refreshed-no-note', display_name: '刷新后无备注模型', public_note: '', credits: 9, billing_unit: 'request' },
    ],
  ]
  await prepare(page, async (request, url) => {
    if (url.pathname === '/api/v1/billing/catalog') {
      const response = catalogs[Math.min(catalogReads, catalogs.length - 1)]
      catalogReads += 1
      return response
    }
    if (request.method() === 'POST' && url.pathname === '/api/v1/canvas/text/generate') {
      submitted = request.postDataJSON()
      return { content: '刷新目录后的文字结果。', model: submitted.model }
    }
    return undefined
  })

  await page.goto('/free-create?mode=text')

  const modelField = page.locator('.form-item').filter({ hasText: '模型' })
  const modelSelect = modelField.getByRole('combobox')
  await expect(modelField.getByText('初始公开文字模型', { exact: true })).toBeVisible()
  await expect(modelField.locator('.model-public-note')).toHaveText('初始目录备注')

  await page.reload()

  await expect(modelField.getByText('刷新后公开文字模型', { exact: true })).toBeVisible()
  await expect(modelField.locator('.model-public-note')).toHaveText('刷新后的目录备注')
  await expect(modelField.getByText('初始公开文字模型', { exact: true })).toHaveCount(0)

  await modelField.locator('.el-select').click()
  await page.getByRole('option', { name: '刷新后无备注模型' }).click()
  await expect(modelField.getByText('刷新后无备注模型', { exact: true })).toBeVisible()
  await expect(modelField.locator('.model-public-note')).toHaveCount(0)
  await page.locator('.prompt-input textarea').fill('使用刷新后的模型生成文字')
  await page.getByRole('button', { name: '生成文字' }).click()
  await expect(page.getByText('刷新目录后的文字结果。')).toBeVisible()
  expect(submitted.model).toBe('refreshed-no-note')
})

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
