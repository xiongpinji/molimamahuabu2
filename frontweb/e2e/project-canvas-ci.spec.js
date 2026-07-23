import { test, expect } from '@playwright/test'

const drama = {
  id: 3,
  title: 'E2E 项目画布',
  metadata: {},
  characters: [
    { id: 11, name: '小茉', role: 'main', appearance: '短发，蓝色外套' },
  ],
  scenes: [
    { id: 21, location: '雨夜车站', time: '夜晚', prompt: '湿润站台与暖色路灯' },
  ],
  props: [
    { id: 31, name: '红伞', description: '雨夜里的红色长柄伞' },
  ],
  episodes: [
    {
      id: 101,
      episode_number: 1,
      title: '第一集',
      script_content: '小茉在雨夜车站撑开红伞。',
      storyboards: [
        {
          id: 1001,
          episode_id: 101,
          storyboard_number: 1,
          title: '雨夜相遇',
          description: '小茉走入车站，红伞在灯下展开。',
          duration: 5,
          status: 'pending',
          characters: [11],
          scene_id: 21,
          prop_ids: [31],
        },
      ],
    },
  ],
}

function apiData(data) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  }
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url

    if (request.method() === 'GET' && pathname === '/api/v1/dramas/3') {
      await route.fulfill(apiData(drama))
      return
    }
    if (request.method() === 'GET' && ['/api/v1/assets', '/api/v1/images', '/api/v1/videos'].includes(pathname)) {
      await route.fulfill(apiData({ items: [] }))
      return
    }
    if (request.method() === 'PUT' && pathname === '/api/v1/dramas/3/canvas-layout') {
      await route.fulfill(apiData(request.postDataJSON()?.canvas_layout || {}))
      return
    }

    await route.fulfill(apiData({ items: [] }))
  })
})

test('项目画布加载业务节点并打开统一配置面板', async ({ page }) => {
  await page.goto('/film/3/canvas')

  await expect(page.getByRole('banner').getByText('E2E 项目画布', { exact: true })).toBeVisible()
  await expect(page.locator('.vue-flow')).toBeVisible()
  await expect(page.locator('.vue-flow__node[data-id="sb:1001"]')).toContainText('雨夜相遇')
  await expect(page.getByText('小茉', { exact: true })).toBeVisible()
  await expect(page.getByText('雨夜车站', { exact: true })).toBeVisible()
  await expect(page.getByText('红伞', { exact: true })).toBeVisible()

  await page.locator('.vue-flow__node[data-id="sb:1001"]').click()
  const panel = page.locator('.canvas-node-panel.sb-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('分镜 #1')
  await expect(panel).toContainText('引用素材')
  await expect(panel).toContainText('摄影控制')
})

test('项目画布支持右键添加入口、Ctrl 缩放、Space 平移和快捷分组选择', async ({ page }) => {
  await page.goto('/film/3/canvas')

  const canvas = page.locator('.canvas-main')
  const pane = page.locator('.vue-flow__pane')
  const viewport = page.locator('.vue-flow__transformationpane')
  await expect(pane).toBeVisible()

  await pane.click({ button: 'right', position: { x: 1100, y: 680 } })
  const menu = page.getByRole('menu', { name: '添加画布节点' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveCount(13)
  await expect(menu.getByRole('menuitem', { name: /分镜/ })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /3D 导演台/ })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /素材库/ })).toBeVisible()
  await menu.getByRole('menuitem', { name: /^角色 角色设定$/ }).click()
  await expect(page.getByRole('dialog', { name: '新建角色' })).toBeVisible()
  await page.getByRole('dialog', { name: '新建角色' }).getByRole('button', { name: '取消' }).click()

  const initialTransform = await viewport.evaluate((element) => element.style.transform)
  await canvas.hover({ position: { x: 700, y: 420 } })
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -240)
  await page.keyboard.up('Control')
  await expect.poll(() => viewport.evaluate((element) => element.style.transform)).not.toBe(initialTransform)

  await page.keyboard.down('Space')
  await expect(canvas).toHaveClass(/space-panning/)
  const paneBox = await pane.boundingBox()
  expect(paneBox).not.toBeNull()
  await page.mouse.move(paneBox.x + paneBox.width - 100, paneBox.y + paneBox.height - 100)
  await page.mouse.down()
  await page.mouse.move(paneBox.x + paneBox.width - 180, paneBox.y + paneBox.height - 160, { steps: 8 })
  await page.mouse.up()
  await page.keyboard.up('Space')
  await expect(canvas).not.toHaveClass(/space-panning/)

  await page.keyboard.press('Control+a')
  await expect(page.locator('.vue-flow__node[data-id="sb:1001"]')).toHaveClass(/selected/)
})
