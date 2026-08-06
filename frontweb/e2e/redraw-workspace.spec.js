import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const fixtureVideoPath = fileURLToPath(new URL('../../项目截图/1.mp4', import.meta.url))

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

const redrawAssets = [
  {
    id: 1201,
    version_id: 812,
    kind: 'character',
    localized_name: '林夏',
    localized_description: '主角，保留原片服装事实。',
    status: 'generated',
    approval_status: 'pending',
    asset_id: 2201,
    updated_at: '2026-08-06T08:10:00.000Z',
  },
  {
    id: 1202,
    version_id: 812,
    kind: 'scene',
    localized_name: '旧城天台',
    localized_description: '本地化场景与去人净景已生成。',
    status: 'generated',
    approval_status: 'pending',
    clean_plate_asset_id: 2202,
    updated_at: '2026-08-06T08:10:00.000Z',
  },
]

const approvedRedrawAssets = [
  {
    id: 1201,
    version_id: 812,
    version_number: 3,
    kind: 'character',
    localized_name: 'Maya',
    status: 'generated',
    approval_status: 'approved',
    asset_id: 2201,
    updated_at: '2026-08-06T08:20:00.000Z',
  },
  {
    id: 1202,
    version_id: 812,
    version_number: 3,
    kind: 'scene',
    localized_name: 'Brooklyn Loft',
    status: 'generated',
    approval_status: 'approved',
    clean_plate_asset_id: 2202,
    updated_at: '2026-08-06T08:20:00.000Z',
  },
  {
    id: 1203,
    version_id: 812,
    version_number: 3,
    kind: 'prop',
    localized_name: 'Brass Key',
    status: 'generated',
    approval_status: 'approved',
    asset_id: 2203,
    updated_at: '2026-08-06T08:20:00.000Z',
  },
]

const redrawShots = [
  {
    id: 1301,
    version_id: 812,
    batch_index: 1,
    shot_index: 1,
    start_ms: 0,
    end_ms: 12000,
    duration_ms: 12000,
    opening_state: 'Maya waits outside the door.',
    continuous_action: 'She turns the key and pushes the door.',
    ending_state: 'The door opens into the loft.',
    source_dialogue: ['你终于来了。'],
    localized_dialogue: ['You finally made it.'],
    prompt: '@Maya enters @Brooklyn Loft with @Brass Key',
    negative_prompt: 'blurred face',
    references: [{ asset_id: 1201, kind: 'character', version_number: 3, approval_status: 'approved', name: 'Maya' }],
    model: 'fixture-video-model-from-backend',
    duration: 12,
    resolution: '720p',
    count: 1,
    quote: { amount: 4 },
    quote_snapshot: { amount: 4 },
    generation_availability: { ok: true },
    source_video_ref: { asset_id: 910, url: 'https://fixtures.example/source.mp4', thumbnail_url: '', start_ms: 0, end_ms: 12000 },
    new_video_ref: null,
    status: 'draft',
    updated_at: '2026-08-06T08:30:00.000Z',
    generation: { task_id: null, status: null, progress: null, message: null },
    billing: { held: 0, charged: 0, released: 0, quote: { amount: 4 } },
  },
  {
    id: 1302,
    version_id: 812,
    batch_index: 1,
    shot_index: 2,
    start_ms: 12000,
    end_ms: 24000,
    duration_ms: 12000,
    opening_state: 'Maya stands at the threshold.',
    continuous_action: 'She scans the empty room.',
    ending_state: 'She notices a light upstairs.',
    source_dialogue: [],
    localized_dialogue: [],
    prompt: '@Maya scans @Brooklyn Loft',
    negative_prompt: '',
    references: [{ asset_id: 1201, kind: 'character', version_number: 3, approval_status: 'approved', name: 'Maya' }],
    model: 'fixture-video-model-from-backend',
    duration: 12,
    resolution: '720p',
    count: 1,
    quote: { amount: 6 },
    quote_snapshot: { amount: 6 },
    generation_availability: { ok: true },
    source_video_ref: { asset_id: 910, url: 'https://fixtures.example/source.mp4', start_ms: 12000, end_ms: 24000 },
    new_video_ref: null,
    status: 'failed',
    error_code: 'PROVIDER_FAILED',
    error_message: '供应商明确失败，可修改后独立重试',
    updated_at: '2026-08-06T08:31:00.000Z',
    generation: { task_id: 'task-failed-1302', status: 'failed', progress: 22, message: '供应商失败' },
    billing: { held: 0, charged: 0, released: 6, quote: { amount: 6 } },
  },
  {
    id: 1303,
    version_id: 812,
    batch_index: 2,
    shot_index: 3,
    start_ms: 24000,
    end_ms: 36000,
    duration_ms: 12000,
    opening_state: 'Maya reaches the staircase.',
    continuous_action: 'She walks up without looking back.',
    ending_state: 'She disappears above the landing.',
    source_dialogue: ['别回头。'],
    localized_dialogue: ["Don't look back."],
    prompt: '@Maya climbs the staircase',
    negative_prompt: '',
    references: [{ asset_id: 1201, kind: 'character', version_number: 3, approval_status: 'approved', name: 'Maya' }],
    model: 'fixture-video-model-from-backend',
    duration: 12,
    resolution: '720p',
    count: 1,
    quote: { amount: 8 },
    quote_snapshot: { amount: 8 },
    generation_availability: { ok: true },
    source_video_ref: { asset_id: 910, url: 'https://fixtures.example/source.mp4', start_ms: 24000, end_ms: 36000 },
    new_video_ref: { video_url: 'https://fixtures.example/generated.mp4' },
    status: 'completed',
    updated_at: '2026-08-06T08:32:00.000Z',
    generation: { task_id: 'task-completed-1303', status: 'completed', progress: 100, message: '完成' },
    billing: { held: 0, charged: 8, released: 0, quote: { amount: 8 } },
  },
]

function shotBatches(shots) {
  return [1, 2].map((batchIndex) => {
    const items = shots.filter((shot) => shot.batch_index === batchIndex)
    return {
      batch_index: batchIndex,
      duration_ms: items.reduce((total, shot) => total + shot.duration_ms, 0),
      shots: items,
    }
  }).filter((batch) => batch.shots.length)
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
const browserErrorsByPage = new WeakMap()

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
  await page.route('https://fixtures.example/*.mp4', async (route) => {
    await route.fulfill({ path: fixtureVideoPath, contentType: 'video/mp4' })
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
      state.workGets = (state.workGets || 0) + 1
      if (typeof state.onGetWork === 'function') state.onGetWork(state)
      state.work = {
        ...(state.work || workBase),
        ...(state.quoteReady ? { analysis_quote: { credits: 6 } } : { analysis_quote: null }),
      }
      await route.fulfill(apiData(state.work))
      return
    }
    if (method === 'PUT' && /^\/api\/v1\/redraw\/shots\/\d+$/.test(pathname)) {
      const shotId = Number(pathname.split('/').at(-1))
      const body = request.postDataJSON()
      const shot = state.work?.shots?.find((item) => item.id === shotId)
      if (!shot) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ success: false }) })
        return
      }
      Object.assign(shot, body, {
        count: 1,
        references: body.references,
        updated_at: `2026-08-06T08:4${state.requests.length}:00.000Z`,
      })
      state.work.batches = shotBatches(state.work.shots)
      state.requests.push({ method, pathname, body })
      await route.fulfill(apiData(shot))
      return
    }
    if (method === 'POST' && /^\/api\/v1\/redraw\/shots\/\d+\/generate$/.test(pathname)) {
      const shotId = Number(pathname.split('/')[5])
      const body = request.postDataJSON()
      const shot = state.work?.shots?.find((item) => item.id === shotId)
      shot.status = 'processing'
      shot.generation = { task_id: `task-shot-${shotId}`, status: 'processing', progress: 12, message: '供应商处理中' }
      shot.billing = { held: shot.billing.quote.amount, charged: 0, released: 0, quote: shot.billing.quote }
      state.work.batches = shotBatches(state.work.shots)
      state.requests.push({ method, pathname, body })
      await route.fulfill(apiData({ shot_id: shotId, task_id: shot.generation.task_id, status: 'processing' }))
      return
    }
    if (method === 'POST' && pathname === `/api/v1/redraw/works/${workBase.id}/generate-batch`) {
      const body = request.postDataJSON()
      for (const shot of state.work?.shots || []) {
        if (!body.shot_ids.includes(shot.id)) continue
        shot.status = 'processing'
        shot.generation = { task_id: `task-batch-${shot.id}`, status: 'processing', progress: 5, message: '批量任务已提交' }
      }
      state.work.batches = shotBatches(state.work.shots)
      state.requests.push({ method, pathname, body })
      await route.fulfill(apiData({ status: 'processing', items: body.shot_ids.map((shotId) => ({ shot_id: shotId })) }))
      return
    }
    if (method === 'GET' && pathname === '/api/v1/redraw/versions/812/assets') {
      await route.fulfill(apiData(state.assets))
      return
    }
    if (method === 'GET' && pathname === '/api/v1/redraw/versions/812/generation-gate') {
      await route.fulfill(apiData(state.gate))
      return
    }
    if (method === 'GET' && pathname.startsWith('/api/v1/redraw/assets/') && pathname.endsWith('/quote')) {
      await route.fulfill(apiData({
        asset_id: Number(pathname.split('/')[5]),
        model: 'fixture-redraw-model',
        credits: state.assetQuoteReady ? 8 : null,
        priced: state.assetQuoteReady,
      }))
      return
    }
    if (method === 'POST' && pathname.startsWith('/api/v1/redraw/assets/') && pathname.endsWith('/review')) {
      const assetId = Number(pathname.split('/')[5])
      const body = request.postDataJSON()
      const asset = state.assets.find((item) => item.id === assetId)
      if (!asset) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ success: false }) })
        return
      }
      asset.approval_status = body.action
      asset.updated_at = body.action === 'approved' ? '2026-08-06T08:11:00.000Z' : '2026-08-06T08:12:00.000Z'
      state.gate = buildAssetGate(state.assets)
      state.requests.push({ method, pathname, body })
      await route.fulfill(apiData({
        asset,
        gate: state.gate,
        version_id: 812,
        status: state.gate.ok ? 'ready_to_generate' : 'asset_review',
        current_step: state.gate.current_step,
        updated_at: asset.updated_at,
      }))
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

function buildAssetGate(assets) {
  const missing = assets
    .filter((asset) => asset.approval_status !== 'approved')
    .map((asset) => ({
      kind: asset.kind,
      asset_id: asset.id,
      shot_ids: asset.kind === 'character' ? ['shot-01'] : ['shot-02'],
      anchor: `asset-${asset.id}-${asset.kind}`,
    }))
  return { ok: missing.length === 0, missing, current_step: missing.length === 0 ? 3 : 2 }
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

function generationFixtureState() {
  const shots = structuredClone(redrawShots)
  return {
    projects: [project],
    quoteReady: true,
    assetQuoteReady: true,
    work: {
      ...workBase,
      current_step: 3,
      current_version: 1,
      version_id: 812,
      status: 'ready_to_generate',
      shots,
      batches: shotBatches(shots),
    },
    assets: structuredClone(approvedRedrawAssets),
    gate: { ok: true, missing: [], current_step: 3 },
    requests: [],
  }
}

test.describe('一键转绘输入与分析流程', () => {
  test.beforeEach(async ({ page }) => {
    const browserErrors = []
    browserErrorsByPage.set(page, browserErrors)
    page.on('pageerror', (error) => browserErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
  })

  test.afterEach(async ({ page }) => {
    expect(browserErrorsByPage.get(page) || []).toEqual([])
  })

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

  test('第二步资产审核批准后开放门禁，退回后重新关闭', async ({ page }) => {
    const state = {
      projects: [project],
      quoteReady: true,
      assetQuoteReady: true,
      work: { ...workBase, current_step: 2, status: 'asset_review', version_id: 812 },
      assets: redrawAssets.map((asset) => ({ ...asset })),
      gate: buildAssetGate(redrawAssets),
      requests: [],
    }
    await installFixtures(page, state)
    await page.setViewportSize({ width: 1440, height: 900 })

    await page.goto('/redraw/projects/41/works/710?step=2')
    await expect(page.getByText('确认本地化资产后再进入批量转绘')).toBeVisible()
    await expect(page.getByText('还有资产需要确认')).toBeVisible()
    await expect(page.getByText('2 项待处理')).toBeVisible()

    await page.getByRole('button', { name: '批准' }).first().click()
    await expect(page.getByText('1 项待处理')).toBeVisible()
    await page.getByRole('button', { name: '场景' }).click()
    await page.getByRole('button', { name: '批准' }).click()
    await expect(page.getByText('资产已全部确认，可进入批量转绘')).toBeVisible()
    await expect(page.getByText('已开放')).toBeVisible()
    await expect(page.getByRole('button', { name: '03 批量转绘' })).toBeEnabled()

    await page.getByRole('button', { name: '角色' }).click()
    await page.getByRole('button', { name: '退回' }).click()
    await expect(page.getByText('还有资产需要确认')).toBeVisible()
    await expect(page.getByText('1 项待处理')).toBeVisible()
    await expect(page.getByText('已开放')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '03 批量转绘' })).toBeDisabled()
    expect(state.requests.filter((entry) => entry.pathname.endsWith('/review'))).toHaveLength(3)
  })

  test('第二步资产审核移动端无横向页面滚动', async ({ page }) => {
    const state = {
      projects: [project],
      quoteReady: true,
      assetQuoteReady: true,
      work: { ...workBase, current_step: 2, status: 'asset_review', version_id: 812 },
      assets: redrawAssets.map((asset) => ({ ...asset })),
      gate: buildAssetGate(redrawAssets),
      requests: [],
    }
    await installFixtures(page, state)
    await page.setViewportSize({ width: 390, height: 844 })

    await page.goto('/redraw/projects/41/works/710?step=2')
    await expect(page.getByText('确认本地化资产后再进入批量转绘')).toBeVisible()
    await expect(page.getByText('本次预计扣除 8 积分')).toBeVisible()
    await assertNoPageHorizontalScroll(page)
    await assertTextFits(page, '确认本地化资产后再进入批量转绘')
  })

  test('第三步按后端快照编辑、单镜提交、失败重试并切换已完成新片', async ({ page }) => {
    const state = generationFixtureState()
    await installFixtures(page, state)
    await page.setViewportSize({ width: 1440, height: 1000 })

    await page.goto('/redraw/projects/41/works/710?step=3')
    await expect(page.getByRole('heading', { name: '按分镜生成并从后端恢复真实进度' })).toBeVisible()
    await expect(page.getByText('本次预计扣除 10 积分')).toBeVisible()
    await expect(page.getByText('批量总价 10 积分')).toBeVisible()
    await expect(page.getByText('分镜价格明细')).toBeVisible()
    await expect(page.getByText('本次预计扣除 4 积分')).toBeVisible()
    await expect(page.getByText('@角色 Maya · v3')).toBeVisible()
    await expect(page.locator('.shot-preview video')).toHaveAttribute('src', /source\.mp4#t=0/)

    await page.getByRole('textbox', { name: '连续动作' }).fill('She unlocks the door, enters, and keeps moving forward.')
    await page.getByRole('button', { name: '保存镜头' }).click()
    await expect.poll(() => state.requests.filter((entry) => entry.method === 'PUT' && entry.pathname === '/api/v1/redraw/shots/1301').length).toBe(1)
    const saved = state.requests.find((entry) => entry.method === 'PUT' && entry.pathname === '/api/v1/redraw/shots/1301')
    expect(saved.body.updated_at).toBe('2026-08-06T08:30:00.000Z')
    expect(saved.body.count).toBe(1)
    expect(saved.body.references).toEqual([{ redraw_asset_id: 1201, kind: 'character', version_number: 3 }])

    await page.getByRole('button', { name: '生成本镜头' }).click()
    await expect.poll(() => state.requests.some((entry) => entry.pathname === '/api/v1/redraw/shots/1301/generate')).toBe(true)
    const generated = state.requests.find((entry) => entry.pathname === '/api/v1/redraw/shots/1301/generate')
    expect(generated.body).toEqual({
      model: 'fixture-video-model-from-backend',
      duration: 12,
      resolution: '720p',
    })
    expect(generated.body).not.toHaveProperty('count')
    expect(generated.body).not.toHaveProperty('credit_amount')
    expect(generated.body).not.toHaveProperty('new_video_ref')

    await page.getByRole('button', { name: /镜头 2/ }).click()
    await expect(page.getByText('供应商明确失败，可修改后独立重试')).toBeVisible()
    await page.getByRole('button', { name: '独立重试' }).click()
    await expect.poll(() => state.requests.some((entry) => entry.pathname === '/api/v1/redraw/shots/1302/generate')).toBe(true)
    const retried = state.requests.find((entry) => entry.pathname === '/api/v1/redraw/shots/1302/generate')
    expect(retried.body.retry).toBe(true)
    expect(retried.body).not.toHaveProperty('count')

    await page.getByRole('button', { name: '已完成', exact: true }).click()
    await page.getByRole('button', { name: /镜头 3/ }).click()
    await expect(page.getByRole('button', { name: '新片' })).toBeEnabled()
    await page.getByRole('button', { name: '新片' }).click()
    await expect(page.locator('.shot-preview video')).toHaveAttribute('src', /generated\.mp4#t=24/)
    await assertNoPageHorizontalScroll(page)
  })

  test('第三步未定价或生成能力关闭时禁用提交并显示后端原因', async ({ page }) => {
    const state = generationFixtureState()
    state.work.shots[0].quote = null
    state.work.shots[0].quote_snapshot = null
    state.work.shots[0].billing = { held: 0, charged: 0, released: 0, quote: null }
    state.work.shots[0].generation_availability = {
      ok: false,
      code: 'no_verified_video_model',
      reason: '当前语言市场没有已验证可读的视频生成能力',
    }
    await installFixtures(page, state)

    await page.goto('/redraw/projects/41/works/710?step=3')
    await expect(page.getByText('当前语言市场没有已验证可读的视频生成能力')).toHaveCount(2)
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '批量生成 2 镜' })).toBeDisabled()
  })

  test('第三步轮询从处理中到完成后停止且保留选中镜头', async ({ page }) => {
    const state = generationFixtureState()
    state.onGetWork = (fixtureState) => {
      const shot = fixtureState.work?.shots?.find((item) => item.id === 1301)
      if (!shot || shot.status !== 'processing' || fixtureState.workGets < 3) return
      shot.status = 'completed'
      shot.generation = { task_id: 'task-shot-1301', status: 'completed', progress: 100, message: '完成' }
      shot.billing = { held: 0, charged: 4, released: 0, quote: { amount: 4 } }
      shot.new_video_ref = { video_url: 'https://fixtures.example/generated.mp4' }
      fixtureState.work.batches = shotBatches(fixtureState.work.shots)
    }
    await installFixtures(page, state)

    await page.goto('/redraw/projects/41/works/710?step=3')
    await page.getByRole('button', { name: '生成本镜头' }).click()
    await expect(page.getByRole('button', { name: /镜头 1/ })).toHaveClass(/active/)
    await expect(page.getByRole('button', { name: '新片' })).toBeEnabled({ timeout: 8000 })
    await expect(page.locator('.shot-editor__heading').getByText('镜头 1')).toBeVisible()
    await page.getByRole('button', { name: '新片' }).click()
    await expect(page.locator('.shot-preview video')).toHaveAttribute('src', /generated\.mp4#t=0/)
    const getCountAfterCompletion = state.workGets
    await page.waitForTimeout(3200)
    expect(state.workGets).toBeLessThanOrEqual(getCountAfterCompletion + 1)
  })

  test('第三步批量提交仅发送当前版本和复数镜头 ID', async ({ page }) => {
    const state = generationFixtureState()
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=3')

    await page.getByRole('button', { name: '批量生成 2 镜' }).click()
    await expect.poll(() => state.requests.some((entry) => entry.pathname === '/api/v1/redraw/works/710/generate-batch')).toBe(true)
    const batch = state.requests.find((entry) => entry.pathname === '/api/v1/redraw/works/710/generate-batch')
    expect(batch.body).toEqual({ version_id: 812, shot_ids: [1301, 1302] })
    expect(batch.body).not.toHaveProperty('shot_id')
    expect(batch.body).not.toHaveProperty('count')
  })

  test('第三步移动端批次、预览、编辑和积分合同无横向溢出', async ({ page }) => {
    const state = generationFixtureState()
    await installFixtures(page, state)
    await page.setViewportSize({ width: 390, height: 844 })

    await page.goto('/redraw/projects/41/works/710?step=3')
    await expect(page.getByText('按分镜生成并从后端恢复真实进度')).toBeVisible()
    await expect(page.getByText('本次预计扣除 10 积分')).toBeVisible()
    await expect(page.getByText('本次预计扣除 4 积分')).toBeVisible()
    await expect(page.getByText('建议保持 10–15 秒')).toBeVisible()
    await assertNoPageHorizontalScroll(page)
    await assertTextFits(page, '本次预计扣除 4 积分')
  })
})
