import { test, expect } from '@playwright/test'

function json(data) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  }
}

async function mockProjectWorkspace(page) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())

    if (request.method() === 'GET' && pathname === '/api/v1/dramas/3') {
      return route.fulfill(json({
        id: 3,
        title: '项目工作区回归',
        description: '用于验证项目详情交互',
        style: 'realistic',
        metadata: {
          aspect_ratio: '16:9',
          style_prompt_en: 'cinematic realistic photography',
        },
        episodes: [],
        characters: [],
        scenes: [],
        props: [],
      }))
    }

    if (request.method() === 'GET' && pathname === '/api/v1/dramas/examples') {
      return route.fulfill(json([]))
    }

    if (request.method() === 'GET' && pathname === '/api/v1/dramas') {
      return route.fulfill(json({
        items: [{
          id: 3,
          title: '项目工作区回归',
          description: '用于验证项目列表交互',
          status: 'draft',
          metadata: { aspect_ratio: '16:9' },
          episodes: [],
        }],
        pagination: { page: 1, page_size: 50, total: 1 },
      }))
    }

    if (
      request.method() === 'GET'
      && ['/api/v1/character-library', '/api/v1/scene-library', '/api/v1/prop-library'].includes(pathname)
    ) {
      return route.fulfill(json({ items: [], pagination: { page: 1, page_size: 20, total: 0 } }))
    }

    return route.fulfill(json({}))
  })
}

test.beforeEach(async ({ page }) => {
  await mockProjectWorkspace(page)
})

test('项目列表保持深色工作区并可打开新建项目对话框', async ({ page }) => {
  await page.goto('/factory')

  await expect(page.getByRole('button', { name: /浅色|暗色/ })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '从剧本到成片，全程不换工具' })).toBeVisible()
  await expect(page.getByText('项目工作区回归', { exact: true })).toBeVisible()
  await expect.poll(() => page.locator('.film-list').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).toBe('rgb(8, 8, 8)')

  await page.getByRole('button', { name: '新建短剧', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建项目' })
  const dialogSurface = page.locator('.project-dialog.el-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByPlaceholder('输入项目标题')).toBeVisible()
  await expect.poll(() => dialogSurface.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).toBe('rgb(17, 17, 17)')
  await expect.poll(() => dialogSurface.locator('.el-input__wrapper').first().evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).toBe('rgb(22, 22, 22)')
})

test('项目详情保持深色表单并支持键盘切换资源分类', async ({ page }) => {
  await page.goto('/drama/3')

  await expect(page.getByRole('button', { name: /浅色|暗色/ })).toHaveCount(0)
  await expect(page.getByText('剧集信息', { exact: true })).toBeVisible()
  await expect.poll(() => page.locator('.info-form .el-input__wrapper').first().evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).toBe('rgb(22, 22, 22)')

  await page.evaluate(() => document.documentElement.classList.add('light'))
  await expect.poll(() => page.locator('.info-form .el-input__wrapper').first().evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).toBe('rgb(22, 22, 22)')

  const sceneTab = page.locator('.res-tab--lib').nth(1)
  await sceneTab.focus()
  await sceneTab.press('Enter')
  await expect(sceneTab).toHaveAttribute('aria-pressed', 'true')
  await expect(sceneTab).toBeFocused()

  await page.getByRole('button', { name: '返回列表' }).click()
  await expect(page).toHaveURL(/\/factory$/)
})
