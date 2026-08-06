import { test, expect } from '@playwright/test'

test.skip(
  !/^(1|true|yes)$/i.test(String(process.env.VITE_PUBLIC_PLATFORM_MODE || '')),
  '充值中心浏览器验收需要以 VITE_PUBLIC_PLATFORM_MODE=1 启动前端',
)

const rechargePackages = [
  {
    id: 'plus',
    name: 'PLUS',
    badge_text: '3.20 折',
    ad_title: '轻量创作起步',
    ad_subtitle: '适合个人创作者',
    button_text: '选择 PLUS',
    amount_cents: 9900,
    credits: 12000,
    starts_at: null,
    ends_at: null,
    image_url: '/static/uploads/recharge-packages/plus.webp',
    accent_color: '#ff7139',
    sort_order: 0,
    is_featured: 0,
    status: 'active',
  },
  {
    id: 'pro',
    name: 'PRO',
    badge_text: '最受欢迎',
    ad_title: '高频短剧生产',
    ad_subtitle: '推荐工作室使用',
    button_text: '选择 PRO',
    amount_cents: 29900,
    credits: 42000,
    starts_at: null,
    ends_at: '2026-12-31T15:59:59.000Z',
    image_url: '/static/uploads/recharge-packages/pro.webp',
    accent_color: '#8c6cff',
    sort_order: 1,
    is_featured: 1,
    status: 'active',
  },
  {
    id: 'max',
    name: 'MAX',
    badge_text: '2.88 折',
    ad_title: '团队协作扩容',
    ad_subtitle: '覆盖连续生产',
    button_text: '选择 MAX',
    amount_cents: 69900,
    credits: 98000,
    starts_at: null,
    ends_at: null,
    image_url: '/static/uploads/recharge-packages/max.webp',
    accent_color: '#4d8dff',
    sort_order: 2,
    is_featured: 0,
    status: 'active',
  },
  {
    id: 'ultra',
    name: 'ULTRA',
    badge_text: '旗舰',
    ad_title: '规模化内容工厂',
    ad_subtitle: '适合成熟团队',
    button_text: '选择 ULTRA',
    amount_cents: 119900,
    credits: 180000,
    starts_at: null,
    ends_at: null,
    image_url: '/static/uploads/recharge-packages/ultra.webp',
    accent_color: '#51b7c8',
    sort_order: 3,
    is_featured: 0,
    status: 'active',
  },
]

const concurrentPackage = {
  ...rechargePackages[0],
  id: 'scale',
  name: 'SCALE',
  badge_text: '并发新增',
  ad_title: '新加入的第五个套餐',
  image_url: '/static/uploads/recharge-packages/scale.webp',
  sort_order: 4,
}

const rechargeOrders = [
  {
    id: 'order-1',
    package_name: 'PLUS',
    amount_cents: 9900,
    credits: 12000,
    status: 'paid',
    created_at: '2026-08-01T08:00:00.000Z',
    paid_at: '2026-08-01T08:01:00.000Z',
  },
]

function json(data, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify({ success: status < 400, data }),
  }
}

function createCalls() {
  return {
    adminPackageGets: 0,
    adminPackageCreates: 0,
    apiPosts: [],
    createOrders: 0,
    orderPayloads: [],
    packageUpdates: [],
    uploadContentTypes: [],
  }
}

async function seedAdminSession(page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'recharge-browser-session',
      user: { id: 'admin-1', email: 'admin@example.com', role: 'admin' },
    }))
    window.localStorage.setItem('moli_mama_tenant_id', 'tenant-1')
  })
}

function imageFixture(name) {
  const color = ({ plus: '#ff7139', pro: '#8c6cff', max: '#4d8dff', ultra: '#51b7c8' })[name] || '#ff7139'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="460" viewBox="0 0 900 460"><rect width="900" height="460" fill="${color}"/><circle cx="680" cy="120" r="170" fill="#ffffff" fill-opacity=".2"/></svg>`
}

async function mockRechargeApi(page, calls, options = {}) {
  const configured = options.configured ?? false
  const orderFailure = options.orderFailure ?? false
  let adminPackages = rechargePackages.map((item) => ({ ...item }))

  await page.route('**/static/uploads/recharge-packages/**', async (route) => {
    const filename = new URL(route.request().url()).pathname.split('/').pop() || ''
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: imageFixture(filename.split('.')[0]),
    })
  })

  // Root-only equivalent of **/api/**; the raw glob would also match Vite's /src/api modules.
  await page.route(/^https?:\/\/[^/]+\/api\/(?:.*)$/, async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())
    const method = request.method()
    if (method === 'POST') calls.apiPosts.push({ method, pathname })

    if (method === 'GET' && pathname === '/api/v1/billing/account') {
      return route.fulfill(json({ available: 88600, held: 0, spent: 11400 }))
    }
    if (method === 'GET' && pathname === '/api/v1/billing/recharge/alipay/config') {
      return route.fulfill(json({
        configured,
        fixed_ratio_credits_per_yuan: 100,
        min_amount_yuan: '1.00',
        max_amount_yuan: '50000.00',
      }))
    }
    if (method === 'GET' && pathname === '/api/v1/billing/recharge/packages') {
      return route.fulfill(json(rechargePackages))
    }
    if (method === 'GET' && pathname === '/api/v1/billing/recharge/alipay/orders') {
      return route.fulfill(json(rechargeOrders))
    }
    if (method === 'POST' && pathname === '/api/v1/billing/recharge/alipay/orders') {
      calls.createOrders += 1
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: { message: '浏览器验收不允许创建支付订单' } }),
      })
    }
    if (method === 'GET' && pathname === '/api/v1/billing/admin/recharge-packages') {
      calls.adminPackageGets += 1
      if (calls.adminPackageGets <= Number(options.initialAdminGetFailures || 0)) {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: { message: '模拟首次套餐加载失败' } }),
        })
      }
      if (options.adminGetDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, Number(options.adminGetDelayMs)))
      }
      if (options.orderReadbackFailure && calls.orderPayloads.length > 0) {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: { message: '模拟排序回读失败' } }),
        })
      }
      return route.fulfill(json(adminPackages))
    }
    if (method === 'POST' && pathname === '/api/v1/billing/admin/recharge-packages') {
      calls.adminPackageCreates += 1
      const body = request.postDataJSON()
      const saved = {
        ...body,
        id: `created-${calls.adminPackageCreates}`,
        amount_cents: Math.round(Number(body.amount_yuan) * 100),
        is_featured: body.is_featured ? 1 : 0,
      }
      adminPackages.push(saved)
      return route.fulfill(json(saved, 201))
    }
    if (method === 'POST' && pathname === '/api/v1/billing/admin/recharge-packages/image') {
      const body = request.postDataBuffer()?.toString('latin1') || ''
      const contentType = /Content-Type:\s*([^\r\n]+)/i.exec(body)?.[1] || ''
      calls.uploadContentTypes.push(contentType)
      if (options.uploadResponseGate) await options.uploadResponseGate
      const url = ({
        'image/jpeg': '/static/uploads/recharge-packages/uploaded-jpg.jpg',
        'image/png': '/static/uploads/recharge-packages/uploaded-png.png',
        'image/webp': '/static/uploads/recharge-packages/uploaded-webp.webp',
      })[contentType]
      return route.fulfill(json({
        url,
        local_path: url.replace('/static/', ''),
      }))
    }
    const updateMatch = pathname.match(/^\/api\/v1\/billing\/admin\/recharge-packages\/([^/]+)$/)
    if (method === 'PUT' && updateMatch && updateMatch[1] !== 'order') {
      const packageId = decodeURIComponent(updateMatch[1])
      const body = request.postDataJSON()
      calls.packageUpdates.push({ method, pathname, body })
      if (options.adminUpdateResponseGate) await options.adminUpdateResponseGate
      if (options.adminUpdateDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, Number(options.adminUpdateDelayMs)))
      }
      if (body.is_featured) {
        adminPackages = adminPackages.map((item) => ({ ...item, is_featured: 0 }))
      }
      const index = adminPackages.findIndex((item) => item.id === packageId)
      const saved = {
        ...adminPackages[index],
        ...body,
        id: packageId,
        amount_cents: Math.round(Number(body.amount_yuan) * 100),
        is_featured: body.is_featured ? 1 : 0,
      }
      adminPackages[index] = saved
      return route.fulfill(json(saved))
    }
    if (method === 'PUT' && pathname === '/api/v1/billing/admin/recharge-packages/order') {
      const packageIds = request.postDataJSON().package_ids
      calls.orderPayloads.push(packageIds)
      if (options.orderDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, Number(options.orderDelayMs)))
      }
      if (orderFailure) {
        if (options.concurrentPackageOnOrderFailure && !adminPackages.some((item) => item.id === concurrentPackage.id)) {
          adminPackages = [...adminPackages, { ...concurrentPackage }]
        }
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: { message: '模拟排序失败' } }),
        })
      }
      const reordered = packageIds.map((id, index) => ({
        ...adminPackages.find((item) => item.id === id),
        sort_order: index,
      }))
      adminPackages = reordered
      return route.fulfill(json(reordered))
    }

    if (method === 'GET' && pathname === '/api/v1/billing/prices') return route.fulfill(json([]))
    if (method === 'GET' && pathname === '/api/v1/billing/admin/users') return route.fulfill(json([]))
    if (method === 'GET' && pathname === '/api/v1/billing/admin/tenants') return route.fulfill(json([]))
    if (method === 'GET' && pathname === '/api/v1/billing/admin/credit-transactions') return route.fulfill(json([]))
    if (method === 'GET' && pathname === '/api/v1/billing/admin/redeem-codes') return route.fulfill(json([]))
    if (method === 'GET' && pathname === '/api/v1/billing/admin/reconciliation/anomalies') return route.fulfill(json([]))
    if (method === 'GET' && pathname === '/api/v1/billing/admin/reconciliation/history') return route.fulfill(json([]))
    if (method === 'GET' && pathname === '/api/v1/billing/admin/ledger/settings') {
      return route.fulfill(json({ credit_value_micros: 1000 }))
    }
    if (method === 'GET' && pathname === '/api/v1/billing/admin/ledger/report') {
      return route.fulfill(json({ summary: {}, rows: [] }))
    }

    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: { message: `未模拟接口：${method} ${pathname}` } }),
    })
  })
}

async function openRechargeCenter(page, calls, options = {}) {
  await seedAdminSession(page)
  await mockRechargeApi(page, calls, options)
  await page.goto('/recharge')
  await expect(page.locator('.recharge-package-card')).toHaveCount(4)
}

function field(panel, label) {
  return panel.locator('.editor-form label').filter({ hasText: label })
}

test('支付暂停时展示四个管理员套餐并阻止套餐与自定义下单', async ({ page }) => {
  const calls = createCalls()
  await openRechargeCenter(page, calls)

  const cards = page.locator('.recharge-package-card')
  for (const [index, fixture] of rechargePackages.entries()) {
    const card = cards.nth(index)
    await expect(card).toContainText(fixture.name)
    await expect(card).toContainText(fixture.badge_text)
    await expect(card).toContainText(fixture.ad_title)
    await expect(card).toContainText(fixture.ad_subtitle)
  }
  await expect(cards.nth(1)).toContainText('推荐套餐')

  const packageButtons = page.locator('.package-purchase')
  await expect(packageButtons).toHaveCount(4)
  for (const button of await packageButtons.all()) {
    await expect(button).toBeDisabled()
    await expect(button).toHaveText('支付通道准备中')
    await button.dispatchEvent('click')
  }

  await page.getByRole('button', { name: '自定义充值' }).click()
  const amount = page.getByRole('spinbutton', { name: '充值金额' })
  await amount.fill('12.34')
  await amount.press('Tab')
  await expect(page.locator('.credit-preview strong')).toHaveText('1,234')
  await expect(page.locator('.ratio')).toHaveText('1 元 = 100 积分')
  await expect(page.locator('.order-summary')).toContainText('1 : 100')
  const customButton = page.locator('.custom-purchase')
  await expect(customButton).toBeDisabled()
  await customButton.dispatchEvent('click')

  await expect.poll(() => calls.createOrders).toBe(0)
  expect(calls.apiPosts).toEqual([])

  const probeStatus = await page.evaluate(async () => {
    const response = await fetch('/api/v2/fail-close-probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ probe: true }),
    })
    return response.status
  })
  expect(probeStatus).toBe(404)
  expect(calls.apiPosts).toEqual([{
    method: 'POST',
    pathname: '/api/v2/fail-close-probe',
  }])
})

test('支付通道就绪时非法自定义金额显示验证且不创建订单', async ({ page }) => {
  const calls = createCalls()
  await openRechargeCenter(page, calls, { configured: true })
  await page.getByRole('button', { name: '自定义充值' }).click()

  const amount = page.getByRole('spinbutton', { name: '充值金额' })
  await amount.fill('')
  await page.locator('.custom-purchase').click()
  await expect(page.getByText('充值金额需在 1.00 至 50000.00 元之间')).toBeVisible()
  await expect.poll(() => calls.createOrders).toBe(0)
  expect(calls.apiPosts).toEqual([])
})

for (const viewport of [
  { width: 1440, height: 900, columns: 4 },
  { width: 1024, height: 900, columns: 2 },
  { width: 390, height: 844, columns: 1 },
]) {
  test(`${viewport.width}px 视口展示 ${viewport.columns} 列套餐且广告图高 230px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const calls = createCalls()
    await openRechargeCenter(page, calls)

    const cards = page.locator('.recharge-package-card')
    const boxes = await cards.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }))
    const columnXs = [...new Set(boxes.map(({ x }) => Math.round(x)))]
    expect(columnXs).toHaveLength(viewport.columns)

    for (const image of await page.locator('.package-image-wrap').all()) {
      const box = await image.boundingBox()
      expect(box).not.toBeNull()
      expect(box.height).toBeGreaterThanOrEqual(228)
      expect(box.height).toBeLessThanOrEqual(232)
    }

    const pageWidth = await page.locator('html').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }))
    expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.clientWidth + 1)

    const featuredTransform = await cards.nth(1).evaluate((element) => getComputedStyle(element).transform)
    if (viewport.width === 390) expect(featuredTransform).toBe('none')
    if (viewport.width === 1440) expect(featuredTransform).not.toBe('none')
    expect(calls.createOrders).toBe(0)
    expect(calls.apiPosts).toEqual([])
  })
}

test('管理员完整编辑字段实时更新预览并支持三种广告图片格式', async ({ page }) => {
  const calls = createCalls()
  await seedAdminSession(page)
  await mockRechargeApi(page, calls)
  await page.goto('/billing-admin?tab=recharge')

  const admin = page.locator('.package-admin')
  await expect(admin.locator('.sortable-item')).toHaveCount(4)
  expect(calls.adminPackageGets).toBe(1)
  await admin.locator('.sortable-item').filter({ hasText: 'PLUS' }).click()

  for (const label of [
    '套餐名称',
    '角标文案',
    '广告主标题',
    '广告副标题',
    '按钮文案',
    '强调色',
    '售价（元）',
    '到账积分',
    '开始时间',
    '结束时间',
    '状态',
    '推荐套餐',
    '广告图片',
  ]) {
    await expect(field(admin, label)).toBeVisible()
  }

  await field(admin, '套餐名称').locator('input').fill('PLUS 新版')
  await field(admin, '角标文案').locator('input').fill('限时加赠')
  await field(admin, '广告主标题').locator('input').fill('实时预览新标题')
  await field(admin, '广告副标题').locator('input').fill('管理员可修改全部广告内容')
  await field(admin, '按钮文案').locator('input').fill('立即补充积分')
  await field(admin, '售价（元）').getByRole('spinbutton').fill('15.01')
  await field(admin, '到账积分').getByRole('spinbutton').fill('1501')

  const expectedEndsAt = await page.evaluate(() => new Date(2027, 0, 2, 3, 4, 5).toISOString())
  const endsAt = field(admin, '结束时间').getByRole('combobox')
  await endsAt.fill('2027-01-02 03:04:05')
  await endsAt.press('Tab')

  await field(admin, '状态').locator('.el-select__wrapper').click()
  await page.locator('.el-select-dropdown__item:visible').filter({ hasText: '停用' }).click()
  await field(admin, '推荐套餐').locator('.el-switch').click()

  await field(admin, '强调色').getByRole('button', { name: '颜色选择器' }).click()
  const colorDialog = page.getByRole('dialog')
  await colorDialog.getByRole('textbox').fill('#2f7ed8')
  await colorDialog.getByRole('button', { name: '确定' }).click()

  const preview = admin.locator('.preview-column')
  await expect(preview).toContainText('PLUS 新版')
  await expect(preview).toContainText('限时加赠')
  await expect(preview).toContainText('实时预览新标题')
  await expect(preview).toContainText('管理员可修改全部广告内容')
  const previewButton = preview.locator('.package-purchase')
  await expect(previewButton).toHaveText('立即补充积分')
  await expect(previewButton).toBeDisabled()

  const fileInput = admin.locator('input[type="file"]')
  for (const upload of [
    { name: 'banner.jpg', mimeType: 'image/jpeg', url: '/static/uploads/recharge-packages/uploaded-jpg.jpg' },
    { name: 'banner.png', mimeType: 'image/png', url: '/static/uploads/recharge-packages/uploaded-png.png' },
    { name: 'banner.webp', mimeType: 'image/webp', url: '/static/uploads/recharge-packages/uploaded-webp.webp' },
  ]) {
    await fileInput.setInputFiles({
      name: upload.name,
      mimeType: upload.mimeType,
      buffer: Buffer.from('mock-recharge-ad-image'),
    })
    await expect(field(admin, '广告图片').locator('input').first()).toHaveValue(upload.url)
    await expect(preview.locator('.package-image')).toHaveAttribute('src', upload.url)
  }
  expect(calls.uploadContentTypes).toEqual(['image/jpeg', 'image/png', 'image/webp'])
  expect(calls.apiPosts).toEqual([
    { method: 'POST', pathname: '/api/v1/billing/admin/recharge-packages/image' },
    { method: 'POST', pathname: '/api/v1/billing/admin/recharge-packages/image' },
    { method: 'POST', pathname: '/api/v1/billing/admin/recharge-packages/image' },
  ])

  await admin.getByRole('button', { name: '保存套餐' }).click()
  await expect.poll(() => calls.packageUpdates).toEqual([{
    method: 'PUT',
    pathname: '/api/v1/billing/admin/recharge-packages/plus',
    body: {
      name: 'PLUS 新版',
      badge_text: '限时加赠',
      ad_title: '实时预览新标题',
      ad_subtitle: '管理员可修改全部广告内容',
      button_text: '立即补充积分',
      amount_yuan: '15.01',
      credits: 1501,
      starts_at: null,
      ends_at: expectedEndsAt,
      image_url: '/static/uploads/recharge-packages/uploaded-webp.webp',
      accent_color: '#2f7ed8',
      sort_order: 0,
      is_featured: true,
      status: 'inactive',
    },
  }])
  await expect.poll(() => calls.adminPackageGets).toBe(2)
  await page.reload()
  await expect.poll(() => calls.adminPackageGets).toBe(3)
  await expect(admin.locator('.sortable-item')).toHaveCount(4)
  await admin.locator('.sortable-item').filter({ hasText: 'PLUS' }).click()
  await expect(field(admin, '套餐名称').locator('input')).toHaveValue('PLUS 新版')
  await expect(field(admin, '角标文案').locator('input')).toHaveValue('限时加赠')
  await expect(field(admin, '广告主标题').locator('input')).toHaveValue('实时预览新标题')
  await expect(field(admin, '广告副标题').locator('input')).toHaveValue('管理员可修改全部广告内容')
  await expect(field(admin, '按钮文案').locator('input')).toHaveValue('立即补充积分')
  await expect(field(admin, '售价（元）').getByRole('spinbutton')).toHaveValue('15.01')
  await expect(field(admin, '到账积分').getByRole('spinbutton')).toHaveValue('1501')
  await expect(field(admin, '结束时间').getByRole('combobox')).toHaveValue('2027-01-02 03:04:05')
  await expect(field(admin, '状态')).toContainText('停用')
  await expect(field(admin, '推荐套餐').getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  await expect(field(admin, '广告图片').locator('input').first()).toHaveValue('/static/uploads/recharge-packages/uploaded-webp.webp')
  await expect(preview).toContainText('PLUS 新版')
  await expect(preview).toContainText('限时加赠')
  await expect(preview).toContainText('管理员可修改全部广告内容')
  await expect(preview).toContainText('实时预览新标题')
  await expect(preview).toContainText('¥15.01')
  await expect(preview).toContainText('1,501')
  await expect.poll(() => preview.locator('.recharge-package-card').evaluate(
    (element) => element.style.getPropertyValue('--package-accent'),
  )).toBe('#2f7ed8')
  await expect(previewButton).toHaveText('立即补充积分')
  await expect(previewButton).toBeDisabled()

  await previewButton.dispatchEvent('click')
  await expect.poll(() => calls.createOrders).toBe(0)
  expect(calls.apiPosts).toHaveLength(3)
})

test('Enter 与 Space 键盘排序提交完整顺序且不会触发行选择或丢失当前草稿', async ({ page }) => {
  const calls = createCalls()
  await seedAdminSession(page)
  await mockRechargeApi(page, calls)
  await page.goto('/billing-admin?tab=recharge')

  const admin = page.locator('.package-admin')
  await expect(admin.locator('.sortable-item')).toHaveCount(4)
  await admin.locator('.sortable-item').filter({ hasText: 'PLUS' }).click()
  const titleInput = field(admin, '广告主标题').locator('input')
  const imageInput = field(admin, '广告图片').locator('input').first()
  await titleInput.fill('尚未保存的 PLUS 草稿')
  await imageInput.fill('/static/uploads/recharge-packages/plus-draft.webp')

  const proRow = admin.locator('.sortable-item').filter({ hasText: 'PRO' })
  const moveDown = proRow.getByRole('button', { name: '下移 PRO' })
  await moveDown.focus()
  await page.keyboard.press('Enter')

  await expect.poll(() => calls.orderPayloads).toEqual([
    ['plus', 'max', 'pro', 'ultra'],
  ])
  await expect(titleInput).toHaveValue('尚未保存的 PLUS 草稿')
  await expect(imageInput).toHaveValue('/static/uploads/recharge-packages/plus-draft.webp')
  await expect(admin.locator('.sortable-item--active')).toContainText('PLUS')
  expect(calls.apiPosts).toEqual([])

  const maxRow = admin.locator('.sortable-item').filter({ hasText: 'MAX' })
  const moveUp = maxRow.getByRole('button', { name: '上移 MAX' })
  await moveUp.focus()
  await page.keyboard.press('Space')

  await expect.poll(() => calls.orderPayloads).toEqual([
    ['plus', 'max', 'pro', 'ultra'],
    ['max', 'plus', 'pro', 'ultra'],
  ])
  await expect(titleInput).toHaveValue('尚未保存的 PLUS 草稿')
  await expect(imageInput).toHaveValue('/static/uploads/recharge-packages/plus-draft.webp')
  await expect(admin.locator('.sortable-item--active')).toContainText('PLUS')
})

test('排序集合过期后回读含并发新增项的服务端顺序并保留编辑草稿', async ({ page }) => {
  const calls = createCalls()
  await seedAdminSession(page)
  await mockRechargeApi(page, calls, { orderFailure: true, concurrentPackageOnOrderFailure: true })
  await page.goto('/billing-admin?tab=recharge')

  const admin = page.locator('.package-admin')
  await expect(admin.locator('.sortable-item')).toHaveCount(4)
  await admin.locator('.sortable-item').filter({ hasText: 'PLUS' }).click()
  const titleInput = field(admin, '广告主标题').locator('input')
  const imageInput = field(admin, '广告图片').locator('input').first()
  await titleInput.fill('并发回读也要保留的草稿')
  await imageInput.fill('/static/uploads/recharge-packages/concurrent-draft.webp')
  await admin.locator('.sortable-item').filter({ hasText: 'PLUS' }).getByRole('button', { name: '下移 PLUS' }).click()

  await expect(page.getByText('套餐排序失败，已同步服务器最新数据').last()).toBeVisible()
  await expect(admin.locator('.sortable-item')).toHaveCount(5)
  await expect(admin.locator('.sortable-copy > strong')).toHaveText(['PLUS', 'PRO', 'MAX', 'ULTRA', 'SCALE'])
  await expect(titleInput).toHaveValue('并发回读也要保留的草稿')
  await expect(imageInput).toHaveValue('/static/uploads/recharge-packages/concurrent-draft.webp')
  await expect.poll(() => calls.adminPackageGets).toBe(2)
  await expect.poll(() => calls.orderPayloads).toEqual([
    ['pro', 'plus', 'max', 'ultra'],
  ])
})

test('排序与服务端回读均失败时恢复本地顺序并保留编辑草稿', async ({ page }) => {
  const calls = createCalls()
  await seedAdminSession(page)
  await mockRechargeApi(page, calls, { orderFailure: true, orderReadbackFailure: true })
  await page.goto('/billing-admin?tab=recharge')

  const admin = page.locator('.package-admin')
  await expect(admin.locator('.sortable-item')).toHaveCount(4)
  await admin.locator('.sortable-item').filter({ hasText: 'PLUS' }).click()
  const titleInput = field(admin, '广告主标题').locator('input')
  await titleInput.fill('排序失败也要保留的草稿')
  await admin.locator('.sortable-item').filter({ hasText: 'PLUS' }).getByRole('button', { name: '下移 PLUS' }).click()

  await expect(page.getByText('套餐排序与服务器同步均失败，已恢复本地顺序').last()).toBeVisible()
  await expect(admin.locator('.sortable-copy > strong')).toHaveText(['PLUS', 'PRO', 'MAX', 'ULTRA'])
  await expect(titleInput).toHaveValue('排序失败也要保留的草稿')
  await expect.poll(() => calls.adminPackageGets).toBe(2)
  await expect.poll(() => calls.orderPayloads).toEqual([
    ['pro', 'plus', 'max', 'ultra'],
  ])
  expect(calls.apiPosts).toEqual([])
})

test('管理员套餐首次加载失败时阻止写入，重试成功后才解除禁用', async ({ page }) => {
  const calls = createCalls()
  await seedAdminSession(page)
  await mockRechargeApi(page, calls, { initialAdminGetFailures: 1, adminGetDelayMs: 250 })
  await page.goto('/billing-admin?tab=recharge')

  const admin = page.locator('.package-admin')
  const loadError = admin.locator('.package-load-error')
  await expect(loadError).toContainText('套餐列表加载失败')
  await expect(loadError.getByRole('button', { name: '重新加载' })).toBeVisible()
  await expect(admin.getByText('暂无充值套餐')).toHaveCount(0)
  await expect(admin.locator('.sortable-item')).toHaveCount(0)

  const createEntry = admin.getByRole('button', { name: '新增套餐' })
  const saveButton = admin.getByRole('button', { name: '创建套餐' })
  const uploadButton = field(admin, '广告图片').getByRole('button', { name: '上传图片' })
  await expect(createEntry).toBeDisabled()
  await expect(saveButton).toBeDisabled()
  await expect(uploadButton).toBeDisabled()
  await expect(field(admin, '套餐名称').locator('input')).toBeDisabled()
  await expect(field(admin, '广告主标题').locator('input')).toBeDisabled()
  await expect(field(admin, '售价（元）').getByRole('spinbutton')).toBeDisabled()
  await expect(field(admin, '到账积分').getByRole('spinbutton')).toBeDisabled()
  await expect(field(admin, '广告图片').locator('input').first()).toBeDisabled()
  await createEntry.dispatchEvent('click')
  await saveButton.dispatchEvent('click')
  await uploadButton.dispatchEvent('click')
  expect(calls.adminPackageCreates).toBe(0)
  expect(calls.orderPayloads).toEqual([])
  expect(calls.apiPosts).toEqual([])

  const retryButton = loadError.getByRole('button', { name: '重新加载' })
  await Promise.all([
    retryButton.dispatchEvent('click'),
    retryButton.dispatchEvent('click'),
  ])
  await expect.poll(() => calls.adminPackageGets).toBe(2)
  await expect(admin.locator('.package-load-error')).toHaveCount(0)
  await expect(admin.locator('.sortable-item')).toHaveCount(4)
  await expect(createEntry).toBeEnabled()
  await expect(saveButton).toBeEnabled()
  const nameInput = field(admin, '套餐名称').locator('input')
  await expect(nameInput).toBeEnabled()
  await nameInput.fill('重试后可编辑')
  await expect(nameInput).toHaveValue('重试后可编辑')
  expect(calls.adminPackageCreates).toBe(0)
  expect(calls.orderPayloads).toEqual([])
})

test('管理员套餐排序与保存互斥且双击保存只发送一个更新请求', async ({ page }) => {
  const calls = createCalls()
  await seedAdminSession(page)
  await mockRechargeApi(page, calls, { adminUpdateDelayMs: 250, orderDelayMs: 250 })
  await page.goto('/billing-admin?tab=recharge')

  const admin = page.locator('.package-admin')
  await expect(admin.locator('.sortable-item')).toHaveCount(4)
  await admin.locator('.sortable-item').filter({ hasText: 'PLUS' }).click()
  await field(admin, '广告主标题').locator('input').fill('串行化套餐管理')

  const saveButton = admin.getByRole('button', { name: '保存套餐' })
  const moveDown = admin.locator('.sortable-item').filter({ hasText: 'PLUS' }).getByRole('button', { name: '下移 PLUS' })
  await moveDown.dispatchEvent('click')
  await saveButton.dispatchEvent('click')
  await expect.poll(() => calls.orderPayloads).toHaveLength(1)
  expect(calls.packageUpdates).toEqual([])
  await expect(moveDown).toBeEnabled()

  await Promise.all([
    saveButton.dispatchEvent('click'),
    saveButton.dispatchEvent('click'),
  ])
  await expect.poll(() => calls.packageUpdates).toHaveLength(1)
  await expect(saveButton).toBeEnabled()
  expect(calls.packageUpdates[0].body.ad_title).toBe('串行化套餐管理')
})

test('管理员套餐上传期间锁定选择并将延迟图片留在原套餐草稿', async ({ page }) => {
  const calls = createCalls()
  let releaseUpload
  let releaseSave
  const uploadResponseGate = new Promise((resolve) => { releaseUpload = resolve })
  const adminUpdateResponseGate = new Promise((resolve) => { releaseSave = resolve })
  await seedAdminSession(page)
  await mockRechargeApi(page, calls, { uploadResponseGate, adminUpdateResponseGate })
  await page.goto('/billing-admin?tab=recharge')

  const admin = page.locator('.package-admin')
  await expect(admin.locator('.sortable-item')).toHaveCount(4)
  const plusRow = admin.locator('.sortable-item').filter({ hasText: 'PLUS' })
  const proRow = admin.locator('.sortable-item').filter({ hasText: 'PRO' })
  await plusRow.click()
  const imageUrl = field(admin, '广告图片').locator('input').first()
  const uploadAction = admin.locator('input[type="file"]').setInputFiles({
    name: 'plus-late.png',
    mimeType: 'image/png',
    buffer: Buffer.from('delayed-plus-image'),
  })

  await expect.poll(() => calls.uploadContentTypes).toEqual(['image/png'])
  await expect(plusRow).toHaveAttribute('aria-disabled', 'true')
  await expect(proRow).toHaveAttribute('aria-disabled', 'true')
  await expect(proRow).toHaveAttribute('tabindex', '-1')
  await proRow.dispatchEvent('click')
  await proRow.dispatchEvent('keydown', { key: 'Enter' })
  await expect(admin.locator('.sortable-item--active')).toContainText('PLUS')
  await expect(imageUrl).toHaveValue('/static/uploads/recharge-packages/plus.webp')

  releaseUpload()
  await uploadAction
  await expect(imageUrl).toHaveValue('/static/uploads/recharge-packages/uploaded-png.png')
  await expect(plusRow).toHaveAttribute('aria-disabled', 'false')
  await expect(proRow).toHaveAttribute('tabindex', '0')

  const saveButton = admin.getByRole('button', { name: '保存套餐' })
  await saveButton.dispatchEvent('click')
  await expect.poll(() => calls.packageUpdates).toHaveLength(1)
  await expect(proRow).toHaveAttribute('aria-disabled', 'true')
  await proRow.dispatchEvent('click')
  await proRow.dispatchEvent('keydown', { key: 'Enter' })
  await expect(admin.locator('.sortable-item--active')).toContainText('PLUS')
  expect(calls.packageUpdates[0].body.image_url).toBe('/static/uploads/recharge-packages/uploaded-png.png')

  releaseSave()
  await expect(saveButton).toBeEnabled()
  await expect(proRow).toHaveAttribute('aria-disabled', 'false')
  await proRow.click()
  await expect(admin.locator('.sortable-item--active')).toContainText('PRO')
  await expect(imageUrl).toHaveValue('/static/uploads/recharge-packages/pro.webp')
})
