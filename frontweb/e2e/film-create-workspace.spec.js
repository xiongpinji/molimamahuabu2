import { test, expect } from '@playwright/test'

test('短剧流水线保持深色工作区并支持制作流程导航', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'film-create-e2e-session',
      user: { id: 'film-create-e2e-user', email: 'film-create-e2e@example.com', role: 'user' },
    }))
  })
  await page.goto('/film/new')

  await page.evaluate(() => {
    document.documentElement.classList.remove('dark')
    document.documentElement.classList.add('light')
  })

  await expect(page.getByRole('button', { name: /浅色|深色/ })).toHaveCount(0)
  await expect(page.locator('.quick-nav')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const background = (selector) => getComputedStyle(document.querySelector(selector)).backgroundColor
    const color = (selector) => getComputedStyle(document.querySelector(selector)).color
    return {
      navigation: background('.quick-nav'),
      workbench: background('.script-workbench-unified'),
      resourceBlock: background('.resource-block'),
      storyInput: background('.story-textarea'),
      sectionTitle: color('.section-title'),
    }
  })).toEqual({
    navigation: 'rgb(17, 17, 17)',
    workbench: 'rgb(17, 17, 17)',
    resourceBlock: 'rgb(22, 22, 22)',
    storyInput: 'rgb(22, 22, 22)',
    sectionTitle: 'rgb(248, 248, 248)',
  })
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
