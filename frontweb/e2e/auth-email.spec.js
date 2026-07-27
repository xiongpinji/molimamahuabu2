import { test, expect } from '@playwright/test'

function json(data) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  }
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/**', async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())

    if (pathname === '/api/v1/auth/register/code') {
      return route.fulfill(json({ message: '验证码已发送' }))
    }
    if (pathname === '/api/v1/auth/register') {
      return route.fulfill(json({
        token: 'registered-token',
        user: { id: 'user-1', email: 'creator@example.com', role: 'user' },
      }))
    }
    if (pathname === '/api/v1/auth/password/code') {
      return route.fulfill(json({ message: '如该邮箱已注册，验证码将发送至邮箱' }))
    }
    if (pathname === '/api/v1/auth/password/reset') {
      return route.fulfill(json({ message: '密码已重置，请重新登录' }))
    }
    return route.fulfill(json({}))
  })
})

test('用户通过邮箱验证码注册并登录', async ({ page }) => {
  const codeRequest = page.waitForRequest('**/api/v1/auth/register/code')
  const registerRequest = page.waitForRequest('**/api/v1/auth/register')

  await page.goto('/login')
  await page.getByRole('tab', { name: '注册' }).click()
  await page.getByLabel('邮箱', { exact: true }).fill('creator@example.com')
  await page.getByRole('button', { name: '获取验证码' }).click()
  expect((await codeRequest).postDataJSON()).toEqual({ email: 'creator@example.com' })

  await page.getByLabel('邮箱验证码').fill('123456')
  await page.getByLabel('新密码', { exact: true }).fill('A-secure-password-2026')
  await page.getByLabel('确认新密码').fill('A-secure-password-2026')
  await page.getByRole('button', { name: '注册并登录' }).click()

  expect((await registerRequest).postDataJSON()).toEqual({
    email: 'creator@example.com',
    password: 'A-secure-password-2026',
    verification_code: '123456',
  })
  await expect(page).toHaveURL(/\/$/)
})

test('已有用户通过邮箱验证码找回密码', async ({ page }) => {
  const codeRequest = page.waitForRequest('**/api/v1/auth/password/code')
  const resetRequest = page.waitForRequest('**/api/v1/auth/password/reset')

  await page.goto('/login')
  await page.getByRole('tab', { name: '找回密码' }).click()
  await page.getByLabel('邮箱', { exact: true }).fill('creator@example.com')
  await page.getByRole('button', { name: '获取验证码' }).click()
  expect((await codeRequest).postDataJSON()).toEqual({ email: 'creator@example.com' })

  await page.getByLabel('邮箱验证码').fill('654321')
  await page.getByLabel('新密码', { exact: true }).fill('A-new-password-2026')
  await page.getByLabel('确认新密码').fill('A-new-password-2026')
  await page.getByRole('button', { name: '重置密码' }).click()

  expect((await resetRequest).postDataJSON()).toEqual({
    email: 'creator@example.com',
    verification_code: '654321',
    new_password: 'A-new-password-2026',
  })
  await expect(page.getByRole('tab', { name: '登录' })).toHaveAttribute('aria-selected', 'true')
})
