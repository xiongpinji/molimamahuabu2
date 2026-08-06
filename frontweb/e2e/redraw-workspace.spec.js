import { test, expect } from '@playwright/test'

const project = {
  id: 41,
  title: '转绘输入验收项目',
  status: 'draft',
  default_locale: 'zh-CN',
  default_market: 'CN',
  updated_at: '2026-08-06T08:00:00.000Z',
}

const workBase = {
  id: 710,
  project_id: project.id,
  source_asset_id: 910,
  status: 'draft',
  current_step: 1,
  task_id: '',
  task_status: '',
  task_progress: 0,
}

const processingWork = {
  ...workBase,
  status: 'processing',
  task_id: 'task-redraw-710',
  task_status: 'processing',
  task_progress: 68,
  task_message: '正在分析源片',
  analysis_quote: { credits: 6 },
}

const stylePresets = [
  { id: 11, name: '二维清透', category: 'two_dimensional', preview_url: '' },
  { id: 12, name: '三维质感', category: 'three_dimensional', preview_url: '' },
  { id: 13, name: '真人电影', category: 'live_action', preview_url: '' },
  { id: 14, name: '二维厚涂', category: 'two_dimensional', preview_url: '' },
]

const localeOptions = [
  { locale: 'zh-CN', market: 'CN' },
  { locale: 'en-US', market: 'US' },
]

function apiData(data) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  }
}

async function installFixtures(page, state) {
  await page.addInitScript(() => {
    window.localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'e2e-redraw-token',
      user: { id: 'user-redraw-e2e', email: 'redraw-e2e@example.test', role: 'admin' },
    }))
  })
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url
    const method = request.method()

    if (method === 'GET' && pathname === '/api/v1/redraw/projects') {
      await route.fulfill(apiData(state.projects))
      return
    }
    if (method === 'POST' && pathname === '/api/v1/redraw/projects') {
      state.projects = [project]
      state.requests.push({ method, pathname, body: request.postDataJSON() })
      await route.fulfill(apiData(project))
      return
    }
    if (method === 'GET' && pathname === `/api/v1/redraw/projects/${project.id}`) {
      await route.fulfill(apiData(project))
      return
    }
    if (method === 'GET' && pathname === '/api/v1/redraw/style-presets') {
      await route.fulfill(apiData(stylePresets))
      return
    }
    if (method === 'GET' && pathname === '/api/v1/redraw/locales') {
      await route.fulfill(apiData(localeOptions))
      return
    }
    if (method === 'POST' && pathname === `/api/v1/redraw/projects/${project.id}/works`) {
      state.requests.push({
        method,
        pathname,
        bodyText: request.postDataBuffer().toString('utf8'),
      })
      state.work = { ...workBase, analysis_quote: state.quoteReady ? { credits: 6 } : null }
      await route.fulfill(apiData({ items: [state.work] }))
      return
    }
    if (method === 'GET' && pathname === `/api/v1/redraw/works/${workBase.id}`) {
      state.work = {
        ...(state.work || workBase),
        ...(state.quoteReady ? { analysis_quote: { credits: 6 } } : { analysis_quote: null }),
      }
      await route.fulfill(apiData(state.work))
      return
    }
    if (method === 'POST' && pathname === `/api/v1/redraw/works/${workBase.id}/analyze`) {
      const contentType = request.headers()['content-type'] || ''
      const bodyText = request.postDataBuffer().toString('utf8')
      state.requests.push({ method, pathname, contentType, bodyText })
      state.work = { ...processingWork }
      await route.fulfill(apiData({ task_id: processingWork.task_id, status: 'processing' }))
      return
    }

    await route.fulfill(apiData({ items: [] }))
  })
}

async function assertNoPageHorizontalScroll(page) {
  await expect.poll(() => page.evaluate(() => ({
    html: document.documentElement.scrollWidth <= window.innerWidth + 1,
    body: document.body.scrollWidth <= window.innerWidth + 1,
  }))).toEqual({ html: true, body: true })
}

async function assertTextFits(page, text) {
  const locator = page.getByText(text, { exact: false }).first()
  await expect(locator).toBeVisible()
  await expect.poll(() => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      visible: rect.width > 0 && rect.height > 0,
      fits: element.scrollWidth <= Math.ceil(element.clientWidth) + 1,
    }
  })).toEqual({ visible: true, fits: true })
}

async function createProjectFromGlobalEntry(page) {
  await page.goto('/')
  await page.getByRole('link', { name: '一键转绘' }).click()
  await expect(page).toHaveURL(/\/redraw$/)
  await expect(page.getByRole('heading', { name: '一键转绘项目' })).toBeVisible()
  await page.getByRole('button', { name: '新建转绘项目' }).click()
  await expect(page).toHaveURL(/\/redraw\/projects\/41\/works\/new\?step=1/)
  await expect(page.getByText('一键转绘工作台')).toBeVisible()
}

async function uploadSource(page) {
  await page.locator('input[type="file"][accept*="video/mp4"]').setInputFiles({
    name: 'redraw-source.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('ui-fixture-only-not-real-video'),
  })
  await page.getByRole('button', { name: '上传源片', exact: true }).click()
  await expect(page).toHaveURL(/\/redraw\/projects\/41\/works\/710\?step=1/)
  await expect(page.getByText('作品 710')).toBeVisible()
}

async function selectFreeStyleWithReference(page) {
  await page.getByText('自由风格').click()
  await page.getByPlaceholder('描述目标画面风格').fill('赛博苗寨实验影像')
  await page.getByPlaceholder('不希望出现的内容').fill('模糊、错字')
  await page.locator('.free-style-panel input[type="file"]').setInputFiles({
    name: 'reference.png',
    mimeType: 'image/png',
    buffer: Buffer.from('reference-image-fixture'),
  })
}

test.describe('一键转绘输入与分析流程', () => {
  test('桌面端覆盖入口、上传、四类风格、报价门禁、payload 与刷新恢复', async ({ page }) => {
    const state = { projects: [], quoteReady: false, work: null, requests: [] }
    await installFixtures(page, state)
    await page.setViewportSize({ width: 1440, height: 900 })

    await createProjectFromGlobalEntry(page)
    await expect(page.locator('.el-segmented').getByText('二维动漫风')).toBeVisible()
    await expect(page.locator('.el-segmented').getByText('三维动漫风')).toBeVisible()
    await expect(page.locator('.el-segmented').getByText('真人写实风格')).toBeVisible()
    await expect(page.locator('.el-segmented').getByText('自由风格')).toBeVisible()

    await page.getByText('二维清透').click()
    await expect(page.locator('.preset-card.active').filter({ hasText: '二维清透' })).toBeVisible()
    await selectFreeStyleWithReference(page)
    await expect(page.locator('.preset-card.active')).toHaveCount(0)

    await uploadSource(page)
    const startButton = page.getByRole('button', { name: '开始分析' })
    await expect(page.getByText('积分待管理员配置')).toBeVisible()
    await expect(startButton).toBeDisabled()

    state.quoteReady = true
    await page.reload()
    await expect(page.getByText('本次预计扣除 6 积分')).toBeVisible()
    await selectFreeStyleWithReference(page)
    await expect(startButton).toBeEnabled()
    await startButton.click()

    await expect(page.getByText('分析任务 task-redraw-710')).toBeVisible()
    await expect(page.locator('.task-card')).toContainText('processing')
    await expect(page.locator('.task-card')).toContainText('68%')

    const analyze = state.requests.find((entry) => entry.pathname === '/api/v1/redraw/works/710/analyze')
    expect(analyze).toBeTruthy()
    expect(analyze.contentType).toContain('multipart/form-data')
    expect(analyze.bodyText).toContain('name="locale"')
    expect(analyze.bodyText).toContain('zh-CN')
    expect(analyze.bodyText).toContain('name="market"')
    expect(analyze.bodyText).toContain('CN')
    expect(analyze.bodyText).toContain('name="aspect_ratio"')
    expect(analyze.bodyText).toContain('16:9')
    expect(analyze.bodyText).toContain('name="free_style"')
    expect(analyze.bodyText).toContain('赛博苗寨实验影像')
    expect(analyze.bodyText).toContain('reference.png')
    expect(analyze.bodyText).not.toContain('style_preset_id')

    await page.reload()
    await expect(page.getByText('分析任务 task-redraw-710')).toBeVisible()
    await expect(page.locator('.task-card')).toContainText('68%')
    await assertNoPageHorizontalScroll(page)
    await assertTextFits(page, '本次预计扣除 6 积分')
  })

  test('移动端工作台关键文字不溢出且无横向页面滚动', async ({ page }) => {
    const state = {
      projects: [project],
      quoteReady: true,
      work: { ...processingWork },
      requests: [],
    }
    await installFixtures(page, state)
    await page.setViewportSize({ width: 390, height: 844 })

    await page.goto('/redraw/projects/41/works/710?step=1')
    await expect(page).toHaveURL(/\/redraw\/projects\/41\/works\/710\?step=1/)
    await expect(page.getByText('上传源片并锁定转绘基础设置')).toBeVisible()
    await expect(page.getByText('源片与风格')).toBeVisible()
    await expect(page.getByText('分析任务 task-redraw-710')).toBeVisible()
    await expect(page.locator('.task-card')).toContainText('68%')
    await assertNoPageHorizontalScroll(page)
    await assertTextFits(page, '上传源片并锁定转绘基础设置')
  })
})
