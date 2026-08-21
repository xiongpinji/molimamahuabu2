import { test, expect } from '@playwright/test'

test.skip(
  process.env.REDRAW_PRODUCTION_PREVIEW !== '1',
  '该合同只对已经构建的生产预览运行',
)

async function installSessionAndApiFixtures(page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'redraw-entry-preview-token',
      user: {
        id: 'redraw-entry-preview-user',
        email: 'redraw-entry-preview@example.test',
        role: 'admin',
      },
    }))
  })

  await page.route('**/api/v1/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    })
  })
}

for (const viewport of [
  { name: '桌面端', width: 1440, height: 900 },
  { name: '移动端', width: 390, height: 844 },
]) {
  test(`${viewport.name}生产导航隐藏入口但保留直达路由`, async ({ page }) => {
    expect(process.env.PLAYWRIGHT_BASE_URL, '生产预览合同必须显式指定 PLAYWRIGHT_BASE_URL').toBeTruthy()

    await installSessionAndApiFixtures(page)
    await page.setViewportSize({ width: viewport.width, height: viewport.height })

    await page.goto('/')
    await expect(page.getByRole('navigation', { name: '主要功能' })).toBeVisible()
    await expect(page.getByRole('link', { name: '短剧工厂' })).toBeVisible()
    expect(await page.locator('html').innerHTML()).not.toContain('/@vite/client')
    await expect(page.getByRole('link', { name: '一键转绘' })).toHaveCount(0)

    await page.goto('/redraw')
    await expect(page.getByRole('heading', { name: '一键转绘项目' })).toBeVisible()
  })
}
