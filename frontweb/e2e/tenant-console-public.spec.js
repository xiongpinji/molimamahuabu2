import { test, expect } from '@playwright/test'

test.skip(
  !/^(1|true|yes)$/i.test(String(process.env.VITE_PUBLIC_PLATFORM_MODE || '')),
  '公开平台角色矩阵需要以 VITE_PUBLIC_PLATFORM_MODE=1 启动前端',
)

function json(data) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  }
}

async function seedSession(page, user) {
  await page.addInitScript((currentUser) => {
    localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'browser-session-token',
      user: currentUser,
    }))
    localStorage.setItem('moli_mama_tenant_id', 'tenant-1')
  }, user)
}

async function mockTenantConsole(page, role, calls, tenantRows) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())
    const method = request.method()

    if (method === 'GET' && pathname === '/api/v1/tenants') {
      return route.fulfill(json(tenantRows || [
        { id: 'tenant-1', name: '茉莉工作室', slug: 'moli-studio', role },
      ]))
    }
    if (method === 'GET' && pathname === '/api/v1/billing/account') {
      return route.fulfill(json({ available: 120, held: 0, spent: 30 }))
    }
    if (method === 'GET' && pathname === '/api/v1/billing/credit-transactions') {
      return route.fulfill(json([]))
    }
    if (method === 'GET' && /^\/api\/v1\/tenants\/tenant-\d+\/members$/.test(pathname)) {
      return route.fulfill(json([
        { user_id: 'owner-1', email: 'owner@example.com', role: 'owner', status: 'active' },
        { user_id: 'admin-1', email: 'admin@example.com', role: 'admin', status: 'active' },
        { user_id: 'member-1', email: 'member@example.com', role: 'member', status: 'active' },
      ]))
    }
    if (method === 'PATCH' && pathname === '/api/v1/tenants/tenant-1/members/member-1/role') {
      calls.roleChanges.push(request.postDataJSON())
      return route.fulfill(json({
        user_id: 'member-1',
        email: 'member@example.com',
        role: 'admin',
        status: 'active',
      }))
    }
    if (method === 'POST' && pathname === '/api/v1/tenants/tenant-2/members') {
      calls.addMembers.push(request.postDataJSON())
      return route.fulfill({
        ...json({ user_id: 'new-member', email: 'new@example.com', role: 'member' }),
        status: 201,
      })
    }
    return route.fulfill(json({}))
  })
}

test('owner 可在工作区内调整成员角色', async ({ page }) => {
  const calls = { roleChanges: [] }
  await seedSession(page, { id: 'owner-1', email: 'owner@example.com', role: 'user' })
  await mockTenantConsole(page, 'owner', calls)

  await page.goto('/tenant-console')
  await expect(page.getByRole('heading', { name: '成员管理' })).toBeVisible()
  await page.locator('.el-table .el-select').last().click()
  await page.locator('.el-select-dropdown__item:visible').filter({ hasText: '管理员' }).click()

  await expect.poll(() => calls.roleChanges).toEqual([{ role: 'admin' }])
  await expect(page.getByText('成员角色已更新')).toBeVisible()
})

test('tenant admin 只能邀请和移除普通成员', async ({ page }) => {
  const calls = { roleChanges: [], addMembers: [] }
  await seedSession(page, { id: 'admin-1', email: 'admin@example.com', role: 'user' })
  await mockTenantConsole(page, 'admin', calls)

  await page.goto('/tenant-console')
  await expect(page.getByRole('heading', { name: '成员管理' })).toBeVisible()
  await expect(page.locator('.el-table .el-select')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '移除' })).toHaveCount(1)

  await page.locator('.member-form .el-select').click()
  const options = page.locator('.el-select-dropdown__item:visible')
  await expect(options).toHaveCount(1)
  await expect(options).toHaveText(['成员'])
})

test('从 owner 切换到 admin 工作区时重置待邀请角色', async ({ page }) => {
  const calls = { roleChanges: [], addMembers: [] }
  await seedSession(page, { id: 'owner-1', email: 'owner@example.com', role: 'user' })
  await mockTenantConsole(page, 'owner', calls, [
    { id: 'tenant-1', name: '所有者工作区', slug: 'owner-studio', role: 'owner' },
    { id: 'tenant-2', name: '管理员工作区', slug: 'admin-studio', role: 'admin' },
  ])

  await page.goto('/tenant-console')
  await page.locator('.member-form .el-select').click()
  await page.locator('.el-select-dropdown__item:visible').filter({ hasText: '管理员' }).click()
  await page.getByRole('button', { name: /管理员工作区/ }).click()
  await page.getByPlaceholder('成员邮箱').fill('new@example.com')
  await page.getByRole('button', { name: '添加', exact: true }).click()

  await expect.poll(() => calls.addMembers).toEqual([
    { email: 'new@example.com', role: 'member' },
  ])
})
