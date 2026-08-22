import { test, expect } from '@playwright/test'

function json(data) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  }
}

const imageDataUrl = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22640%22 height=%22360%22%3E%3Crect width=%22640%22 height=%22360%22 fill=%22%2322201e%22/%3E%3C/svg%3E'

async function mockLibraryWorkspace(page) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())

    if (request.method() === 'GET' && pathname === '/api/v1/dramas/examples') {
      return route.fulfill(json([]))
    }

    if (request.method() === 'GET' && pathname === '/api/v1/dramas/3') {
      return route.fulfill(json({
        id: 3,
        title: '素材回填项目',
        episodes: [{
          id: 31,
          storyboards: [{ id: 311, storyboard_number: 1, title: '雨夜开场' }],
        }],
      }))
    }

    if (request.method() === 'GET' && pathname === '/api/v1/dramas') {
      return route.fulfill(json({
        items: [{
          id: 3,
          title: '素材回填项目',
          status: 'draft',
          metadata: { aspect_ratio: '16:9' },
          episodes: [],
        }],
        pagination: { page: 1, page_size: 100, total: 1 },
      }))
    }

    if (request.method() === 'GET' && pathname === '/api/v1/character-library') {
      return route.fulfill(json({
        items: [{
          id: 11,
          name: '茉莉',
          description: '短剧主角，温柔坚定',
          category: '主角',
          tags: '现代,都市',
          image_url: imageDataUrl,
        }],
        pagination: { page: 1, page_size: 24, total: 1 },
      }))
    }

    if (request.method() === 'GET' && pathname === '/api/v1/scene-library') {
      return route.fulfill(json({
        items: [{
          id: 21,
          location: '雨夜街道',
          time: '夜晚',
          description: '霓虹灯映在湿润路面',
          category: '都市',
          image_url: imageDataUrl,
        }],
        pagination: { page: 1, page_size: 24, total: 1 },
      }))
    }

    if (request.method() === 'GET' && pathname === '/api/v1/prop-library') {
      return route.fulfill(json({
        items: [{
          id: 31,
          name: '旧怀表',
          description: '推动剧情的关键物件',
          category: '关键道具',
          image_url: imageDataUrl,
        }],
        pagination: { page: 1, page_size: 24, total: 1 },
      }))
    }

    if (request.method() === 'GET' && pathname === '/api/v1/assets') {
      return route.fulfill(json({
        items: [{
          id: 41,
          drama_id: 3,
          type: 'image',
          name: '雨夜场景图',
          size: 2048,
          image_url: imageDataUrl,
        }],
        total: 1,
      }))
    }

    return route.fulfill(json({}))
  })
}

test.beforeEach(async ({ page }) => {
  await mockLibraryWorkspace(page)
})

test('项目页的三个素材入口打开统一独立工作区', async ({ page }) => {
  await page.goto('/factory')
  await page.getByRole('button', { name: '素材角色' }).click()

  await expect(page).toHaveURL(/\/materials\/characters$/)
  await expect(page.getByRole('heading', { name: '素材角色', exact: true })).toBeVisible()
  await expect(page.getByText('茉莉', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /浅色|暗色/ })).toHaveCount(0)
  await expect.poll(() => page.locator('.material-library-page').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).toBe('rgb(8, 8, 8)')

  await page.getByRole('link', { name: '场景', exact: true }).click()
  await expect(page).toHaveURL(/\/materials\/scenes$/)
  await expect(page.getByRole('heading', { name: '素材场景', exact: true })).toBeVisible()
  await expect(page.getByText('雨夜街道', { exact: true })).toBeVisible()

  await page.getByRole('link', { name: '道具', exact: true }).click()
  await expect(page).toHaveURL(/\/materials\/props$/)
  await expect(page.getByRole('heading', { name: '素材道具', exact: true })).toBeVisible()
  await expect(page.getByText('旧怀表', { exact: true })).toBeVisible()
})

test('媒体素材支持键盘选择并保留分镜回填入口', async ({ page }) => {
  await page.goto('/media-library')

  await expect(page.getByRole('heading', { name: '媒体素材库', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /浅色|暗色/ })).toHaveCount(0)
  const mediaCard = page.getByRole('button', { name: /雨夜场景图/ })
  await mediaCard.focus()
  await mediaCard.press('Space')
  await expect(mediaCard).toHaveClass(/selected/)

  await mediaCard.hover()
  await page.getByRole('button', { name: '使用', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '设为分镜参考图' })).toBeVisible()
  await expect(page.getByText('目标项目', { exact: true })).toBeVisible()
})

test('模型配置只在管理员独立工作区展示', async ({ page }) => {
  await page.goto('/ai-config')

  await expect(page.getByRole('heading', { name: '模型配置', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /浅色|暗色/ })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'AI 模型配置' })).toBeVisible()
  await expect.poll(() => page.locator('.admin-workspace').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )).toBe('rgb(8, 8, 8)')
})
