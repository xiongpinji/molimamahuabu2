import { test, expect } from '@playwright/test'

test('短剧流水线保持深色工作区并支持制作流程导航', async ({ page }) => {
  await page.goto('/film/new')

  await expect(page.getByRole('button', { name: /浅色|深色/ })).toHaveCount(0)
  await expect(page.locator('.quick-nav')).toBeVisible()
  await expect.poll(() => page.locator('textarea').first().evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).toBe('rgb(22, 22, 22)')

  await page.getByRole('button', { name: '收起制作流程' }).click()
  await expect(page.locator('.film-create')).toHaveClass(/sidebar-collapsed/)
  await expect(page.getByRole('button', { name: '展开制作流程' })).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => page.locator('.main').evaluate(
    (element) => getComputedStyle(element).marginLeft,
  )).toBe('52px')

  await page.getByRole('button', { name: '展开制作流程' }).click()
  const videoStep = page.getByRole('button', { name: '跳转到分镜视频' })
  await videoStep.press('Enter')
  await expect(videoStep).toBeFocused()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000)
})
