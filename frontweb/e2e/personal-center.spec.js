import { test, expect } from '@playwright/test'

const payloads = {
  '/api/v1/auth/me': { id: 'user-1', email: 'creator@example.com', role: 'user' },
  '/api/v1/billing/account': { available: 860, held: 40, spent: 1100 },
  '/api/v1/tenants': [{ id: 'tenant-1', name: '个人创作空间', slug: 'creator', role: 'owner' }],
  '/api/v1/billing/credit-transactions': [
    { id: 'tx-1', event_type: 'confirm', amount: -60, model: 'gpt-image-2-3.5k', reason: '图片生成', created_at: '2026-07-30T01:00:00Z' },
    { id: 'tx-2', event_type: 'redeem', amount: 1000, reason: '兑换码', created_at: '2026-07-29T01:00:00Z' },
  ],
  '/api/v1/dramas': [{ id: 4, title: '服装角色多视图', metadata: { project_type: 'canvas' }, updated_at: '2026-07-30T02:00:00Z' }],
  '/api/v1/billing/audit-events?limit=30': [{ id: 'audit-1', event_type: 'auth.login.success', outcome: 'success', created_at: '2026-07-30T00:00:00Z' }],
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'personal-center-session',
      user: { id: 'user-1', email: 'creator@example.com', role: 'user' },
    }))
    window.localStorage.setItem('moli_mama_tenant_id', 'tenant-1')
  })
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const key = `${url.pathname}${url.search}`
    const data = payloads[key] ?? payloads[url.pathname]
    if (data === undefined) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ success: false }) })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) })
  })
})

test('个人中心展示真实账户数据并可切换核心模块', async ({ page }) => {
  await page.goto('/personal-center')
  await expect(page.getByRole('heading', { name: '个人信息' })).toBeVisible()
  await expect(page.getByText('creator@example.com')).toBeVisible()
  await expect(page.getByText('860', { exact: true }).first()).toBeVisible()

  await page.getByRole('button', { name: /积分账单/ }).click()
  await expect(page.getByText('gpt-image-2-3.5k')).toBeVisible()
  await page.getByRole('button', { name: /用量统计/ }).click()
  await expect(page.getByText('1 次 · 60 积分')).toBeVisible()
  await page.getByRole('button', { name: /我的作品/ }).click()
  await expect(page.getByRole('link', { name: /服装角色多视图/ })).toHaveAttribute('href', '/canvas/4')
  await page.getByRole('button', { name: /登录与安全/ }).click()
  await expect(page.getByText('账户登录 · 成功')).toBeVisible()
})

test('未接通模块不展示模拟数据且移动端导航可用', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/personal-center')
  await page.getByRole('button', { name: /站内消息/ }).click()
  await expect(page.getByRole('heading', { name: '站内消息', level: 1 })).toBeVisible()
  await expect(page.getByText(/尚未开放/)).toBeVisible()
  await expect(page.locator('.center-rail')).toBeVisible()
})

test('单个数据接口失败不影响账户工作区和作品加载', async ({ page }) => {
  await page.route('**/api/v1/billing/audit-events?limit=30', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: { message: '审计记录暂时不可用' } }),
    })
  })

  await page.goto('/personal-center')
  await expect(page.getByText('860', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('个人创作空间', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: /我的作品/ }).click()
  await expect(page.getByRole('link', { name: /服装角色多视图/ })).toBeVisible()
  await page.getByRole('button', { name: /登录与安全/ }).click()
  await expect(page.getByText('近期账户活动暂时无法加载')).toBeVisible()
})

test('积分接口失败时不把默认零值呈现为真实余额', async ({ page }) => {
  await page.route('**/api/v1/billing/account', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: { message: '积分账户暂时不可用' } }),
    })
  })

  await page.goto('/personal-center')
  await expect(page.locator('.balance-pill strong')).toHaveText('加载失败')
  await expect(page.locator('.metric-grid article').filter({ hasText: '可用积分' }).locator('strong')).toHaveText('—')
  await expect(page.getByText('个人创作空间', { exact: true }).first()).toBeVisible()
})
