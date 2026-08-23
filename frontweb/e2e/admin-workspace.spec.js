import { test, expect } from '@playwright/test'

function json(data) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  }
}

async function mockAdminWorkspace(page, calls) {
  calls.models ||= [
    {
      model: 'grok-imagine-video',
      display_name: 'Grok Imagine Video',
      public_note: '适合视频创作与分镜预演',
      category: 'video',
      credits: 20,
      status: 'enabled',
    },
    {
      model: 'gpt-image-2',
      display_name: 'GPT Image 2',
      public_note: '',
      category: 'image',
      credits: null,
      status: 'unconfigured',
    },
  ]

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())
    const method = request.method()

    if (method === 'GET' && pathname === '/api/v1/platform-admin/users') {
      return route.fulfill(json([
        { id: 'user-1', email: 'creator@example.com', role: 'user', status: 'active', tenant_count: 1 },
        { id: 'user-2', email: 'paused@example.com', role: 'support', status: 'disabled', tenant_count: 2 },
      ]))
    }

    if (method === 'PATCH' && pathname === '/api/v1/platform-admin/users/user-1/status') {
      calls.accountStatus += 1
      return route.fulfill(json({
        id: 'user-1',
        email: 'creator@example.com',
        role: 'user',
        status: 'disabled',
        tenant_count: 1,
      }))
    }

    if (method === 'GET' && pathname === '/api/v1/billing/prices') {
      return route.fulfill(json(calls.models))
    }

    if (method === 'PUT' && pathname.startsWith('/api/v1/billing/prices/')) {
      calls.modelSave += 1
      const model = decodeURIComponent(pathname.split('/').pop())
      const body = request.postDataJSON()
      calls.modelUpdates.push({ model, body })
      const current = calls.models.find((item) => item.model === model) || {}
      const saved = {
        ...current,
        model,
        ...body,
      }
      const index = calls.models.findIndex((item) => item.model === model)
      if (index >= 0) calls.models[index] = saved
      else calls.models.push(saved)
      return route.fulfill(json(saved))
    }

    if (method === 'GET' && pathname === '/api/v1/billing/admin/users') {
      return route.fulfill(json([
        { id: 'user-1', email: 'creator@example.com', role: 'user', status: 'active', tenant_count: 1 },
      ]))
    }

    if (method === 'GET' && pathname === '/api/v1/billing/admin/tenants') {
      return route.fulfill(json([
        { id: 'tenant-1', name: '茉莉工作室', available: 3200 },
      ]))
    }

    if (method === 'GET' && pathname === '/api/v1/billing/admin/credit-transactions') {
      return route.fulfill(json([
        {
          id: 'tx-1',
          tenant_name: '茉莉工作室',
          amount: 100,
          reason: '测试调账',
          event_type: 'admin_adjustment',
          created_at: '2026-07-26T09:00:00Z',
        },
      ]))
    }

    if (method === 'GET' && pathname === '/api/v1/billing/admin/redeem-codes') {
      return route.fulfill(json([]))
    }

    if (method === 'GET' && pathname === '/api/v1/billing/admin/reconciliation/anomalies') {
      return route.fulfill(json([]))
    }

    if (method === 'GET' && pathname === '/api/v1/billing/admin/reconciliation/history') {
      return route.fulfill(json([]))
    }

    return route.fulfill(json({}))
  })
}

async function openBillingAdmin(page) {
  await page.goto('/billing-admin')
  const tokenInput = page.getByPlaceholder('输入平台管理员令牌')
  if (await tokenInput.isVisible()) {
    await tokenInput.fill('admin-token-with-at-least-32-characters')
    await page.getByRole('button', { name: '验证并读取' }).click()
  }
  await expect(page.getByRole('tab', { name: '模型计费' })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'browser-session-token',
      user: { id: 'current-admin', email: 'admin@example.com', role: 'admin' },
    }))
  })
})

test('管理中心导航统一三个真实管理入口', async ({ page }) => {
  const calls = { accountStatus: 0, modelSave: 0, modelUpdates: [] }
  await mockAdminWorkspace(page, calls)

  await page.goto('/account-admin')
  await expect(page.getByRole('navigation', { name: '管理中心' })).toBeVisible()
  await expect(page.getByRole('link', { name: /账号与权限/ })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { name: '账号与权限', exact: true })).toBeVisible()
  await expect(page.getByText('2', { exact: true }).first()).toBeVisible()
  await expect.poll(() => page.locator('.admin-workspace').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).toBe('rgb(8, 8, 8)')

  await page.getByRole('link', { name: /工作区与积分/ }).click()
  await expect(page).toHaveURL(/\/tenant-console$/)
  await expect(page.getByRole('heading', { name: '工作区与积分', exact: true })).toBeVisible()
  await expect(page.getByText('租户控制台仅在公开平台模式启用')).toBeVisible()

  await page.getByRole('link', { name: /运营与计费/ }).click()
  await expect(page).toHaveURL(/\/billing-admin$/)
  await expect(page.getByRole('heading', { name: '运营与计费', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: '模型计费' })).toBeVisible()
})

test('账号状态修改继续调用原有 RBAC 接口', async ({ page }) => {
  const calls = { accountStatus: 0, modelSave: 0, modelUpdates: [] }
  await mockAdminWorkspace(page, calls)

  await page.goto('/account-admin')
  await page.getByRole('button', { name: '暂停账号' }).first().click()
  await page.getByRole('button', { name: '确定' }).click()

  await expect.poll(() => calls.accountStatus).toBe(1)
  await expect(page.locator('.account-panel .el-tag').filter({ hasText: '已暂停' })).toHaveCount(2)
})

test('管理员令牌解锁后可读取并保存模型计费', async ({ page }) => {
  const calls = { accountStatus: 0, modelSave: 0, modelUpdates: [] }
  await mockAdminWorkspace(page, calls)

  await openBillingAdmin(page)
  await expect(page.locator('.model-row').first().locator('input').first()).toHaveValue('Grok Imagine Video')
  await page.locator('.model-row').first().getByRole('button', { name: '保存' }).click()

  await expect.poll(() => calls.modelSave).toBe(1)
  await expect(page.getByText('Grok Imagine Video 已保存')).toBeVisible()
})

test('管理员可筛选模型并为每个模型设置独立积分', async ({ page }) => {
  const calls = { accountStatus: 0, modelSave: 0, modelUpdates: [] }
  await mockAdminWorkspace(page, calls)

  await openBillingAdmin(page)

  await expect(page.getByText('未定价 1')).toBeVisible()
  await page.getByPlaceholder('搜索模型名称、ID 或公开备注').fill('gpt-image')
  await expect(page.locator('.model-row')).toHaveCount(1)

  const imageRow = page.locator('.model-row').filter({ hasText: 'gpt-image-2' })
  await imageRow.locator('.model-field').filter({ hasText: '用户收费（积分）' }).getByRole('spinbutton').fill('8')
  await imageRow.getByRole('button', { name: '保存' }).click()

  await page.getByPlaceholder('搜索模型名称、ID 或公开备注').fill('grok')
  const videoRow = page.locator('.model-row').filter({ hasText: 'grok-imagine-video' })
  await videoRow.locator('.model-field').filter({ hasText: '480P 用户收费' }).getByRole('spinbutton').fill('35')
  await videoRow.getByRole('button', { name: '保存' }).click()

  await expect.poll(() => calls.modelUpdates.map(({ model, body }) => ({
    model,
    credits: body.credits,
  }))).toEqual([
    { model: 'gpt-image-2', credits: 8 },
    { model: 'grok-imagine-video', credits: 35 },
  ])
})

test('管理员可编辑、搜索并重载现有模型的公开元数据', async ({ page }) => {
  const calls = { accountStatus: 0, modelSave: 0, modelUpdates: [] }
  await mockAdminWorkspace(page, calls)
  await openBillingAdmin(page)

  const modelSearch = page.getByPlaceholder('搜索模型名称、ID 或公开备注')
  await modelSearch.fill('分镜预演')
  await expect(page.locator('.model-row')).toHaveCount(1)
  await modelSearch.fill('')

  const videoRow = page.locator('.model-row').filter({ hasText: 'grok-imagine-video' })
  const displayName = videoRow.locator('.model-field').filter({ hasText: '展示名称' }).getByRole('textbox')
  const publicNote = videoRow.locator('.model-field').filter({ hasText: '公开备注' }).getByRole('textbox')
  await expect(displayName).toHaveValue('Grok Imagine Video')
  await expect(displayName).toHaveAttribute('maxlength', '120')
  await expect(publicNote).toHaveValue('适合视频创作与分镜预演')
  await expect(publicNote).toHaveAttribute('maxlength', '500')

  await displayName.fill('Grok 视频专业版')
  await publicNote.fill('  适合广告分镜与短剧预演  ')
  await videoRow.getByRole('button', { name: '保存' }).click()

  await expect.poll(() => calls.modelUpdates.at(-1)).toMatchObject({
    model: 'grok-imagine-video',
    body: {
      display_name: 'Grok 视频专业版',
      public_note: '适合广告分镜与短剧预演',
      category: 'video',
      credits: 20,
      status: 'enabled',
    },
  })

  await page.reload()
  const reloadedRow = page.locator('.model-row').filter({ hasText: 'grok-imagine-video' })
  await expect(reloadedRow.locator('.model-field').filter({ hasText: '展示名称' }).getByRole('textbox')).toHaveValue('Grok 视频专业版')
  await expect(reloadedRow.locator('.model-field').filter({ hasText: '公开备注' }).getByRole('textbox')).toHaveValue('适合广告分镜与短剧预演')
})

test('新增模型校验并重置展示名称与可选公开备注', async ({ page }) => {
  const calls = { accountStatus: 0, modelSave: 0, modelUpdates: [] }
  await mockAdminWorkspace(page, calls)
  await openBillingAdmin(page)

  const form = page.locator('.new-model')
  const modelId = form.locator('.model-field').filter({ hasText: '模型 ID' }).getByRole('textbox')
  const displayName = form.locator('.model-field').filter({ hasText: '展示名称' }).getByRole('textbox')
  const publicNote = form.locator('.model-field').filter({ hasText: '公开备注' }).getByRole('textbox')
  await expect(displayName).toHaveAttribute('maxlength', '120')
  await expect(publicNote).toHaveAttribute('maxlength', '500')

  await modelId.fill('new-video-model')
  await form.getByRole('button', { name: '新增模型' }).click()
  await expect(page.getByText('请填写 1-120 个字符的展示名称')).toBeVisible()
  await expect.poll(() => calls.modelSave).toBe(0)

  await displayName.fill('新视频模型')
  await publicNote.fill('  仅用于快速预览  ')
  await form.getByRole('button', { name: '新增模型' }).click()

  await expect.poll(() => calls.modelUpdates.at(-1)).toMatchObject({
    model: 'new-video-model',
    body: {
      display_name: '新视频模型',
      public_note: '仅用于快速预览',
      status: 'enabled',
    },
  })
  await expect(modelId).toHaveValue('')
  await expect(displayName).toHaveValue('')
  await expect(publicNote).toHaveValue('')

  await page.getByPlaceholder('搜索模型名称、ID 或公开备注').fill('快速预览')
  const newRow = page.locator('.model-row').filter({ hasText: 'new-video-model' })
  await expect(newRow).toBeVisible()
  await expect(newRow.locator('.model-field').filter({ hasText: '公开备注' }).getByRole('textbox')).toHaveValue('仅用于快速预览')
})
