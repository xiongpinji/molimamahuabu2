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
          image_url: '/static/e2e-storyboard.png',
          video_url: '/static/e2e-storyboard.mp4',
          audio_url: '/static/e2e-storyboard.mp3',
        },
      ],
    },
  ],
}

let mockAssets = []
let createdAssetPayload = null
let updatedAssetPayloads = []

function apiData(data) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  }
}

async function seedNodeStatus(page, statusMap) {
  await page.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, JSON.stringify(value))
  }, {
    key: 'moli_canvas_node_status:3',
    value: statusMap,
  })
}

test.beforeEach(async ({ page }) => {
  mockAssets = []
  createdAssetPayload = null
  updatedAssetPayloads = []

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url

    if (request.method() === 'GET' && pathname === '/api/v1/dramas/3') {
      await route.fulfill(apiData(drama))
      return
    }
    if (request.method() === 'GET' && pathname === '/api/v1/assets') {
      await route.fulfill(apiData({ items: mockAssets }))
      return
    }
    if (request.method() === 'GET' && ['/api/v1/images', '/api/v1/videos'].includes(pathname)) {
      await route.fulfill(apiData({ items: [] }))
      return
    }
    if (request.method() === 'GET' && pathname === '/api/v1/scene-library') {
      await route.fulfill(apiData({
        items: [
          {
            id: 77,
            name: '雨夜站台参考',
            ref_image: '/static/library-rain-station.png',
          },
        ],
      }))
      return
    }
    if (request.method() === 'GET' && ['/api/v1/character-library', '/api/v1/prop-library', '/api/v1/voice-catalog'].includes(pathname)) {
      await route.fulfill(apiData({ items: [] }))
      return
    }
    if (request.method() === 'POST' && pathname === '/api/v1/assets') {
      createdAssetPayload = request.postDataJSON()
      const asset = {
        id: 901,
        ...createdAssetPayload,
      }
      mockAssets.push(asset)
      await route.fulfill(apiData(asset))
      return
    }
    if (request.method() === 'PUT' && pathname === '/api/v1/assets/901') {
      const payload = request.postDataJSON()
      updatedAssetPayloads.push(payload)
      const index = mockAssets.findIndex((asset) => Number(asset.id) === 901)
      const asset = {
        ...(index >= 0 ? mockAssets[index] : { id: 901 }),
        ...payload,
      }
      if (index >= 0) mockAssets[index] = asset
      else mockAssets.push(asset)
      await route.fulfill(apiData(asset))
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

test('项目画布从素材库导入场景图、指派分镜并在刷新后恢复', async ({ page }) => {
  await page.goto('/film/3/canvas')

  const storyboardNode = page.locator('.vue-flow__node[data-id="sb:1001"]')
  await storyboardNode.click()

  const pane = page.locator('.vue-flow__pane')
  await pane.click({ button: 'right', position: { x: 1100, y: 680 } })
  const menu = page.getByRole('menu', { name: '添加画布节点' })
  await menu.getByRole('menuitem', { name: /素材库/ }).click()

  const picker = page.getByRole('dialog', { name: '从素材库加入画布' })
  await expect(picker).toBeVisible()
  const assetCard = picker.locator('.picker-card').filter({ hasText: '雨夜站台参考' })
  await expect(assetCard).toContainText('场景库')
  await assetCard.getByRole('button', { name: '选用', exact: true }).click()
  await expect(picker).toBeHidden()

  await expect.poll(() => createdAssetPayload).toMatchObject({
    drama_id: 3,
    name: '雨夜站台参考',
    type: 'image',
    category: 'canvas-library-pick',
    url: '/static/library-rain-station.png',
    metadata: {
      source: 'canvas_asset_picker',
      picker_source: 'scene',
      source_asset_id: 77,
    },
  })
  await expect.poll(() => updatedAssetPayloads).toContainEqual(expect.objectContaining({
    drama_id: 3,
    storyboard_id: 1001,
  }))

  const projectAssetNode = page.locator('.vue-flow__node[data-id="project-asset:901"]')
  await expect(projectAssetNode).toBeAttached()
  await expect(projectAssetNode).toContainText('雨夜站台参考')
  await expect(projectAssetNode).toContainText('已指派到分镜 #1001')
  await expect(projectAssetNode.locator('.node-status-overlay')).toContainText('已加入画布并指派到分镜')

  await page.reload()

  const restoredProjectAssetNode = page.locator('.vue-flow__node[data-id="project-asset:901"]')
  await expect(restoredProjectAssetNode).toBeAttached()
  await expect(restoredProjectAssetNode).toContainText('雨夜站台参考')
  await expect(restoredProjectAssetNode).toContainText('已指派到分镜 #1001')
})

test('项目画布恢复图片、视频和音频结果并提供结果复用入口', async ({ page }) => {
  await seedNodeStatus(page, {
    'sbimg:1001': {
      step: 'success',
      message: '图片已生成',
      resultUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="18"><rect width="32" height="18" fill="%23818cf8"/></svg>',
      resultType: 'image',
      promptText: '雨夜车站中的小茉',
      storyboardId: 1001,
      dramaId: 3,
      at: Date.now(),
    },
    'sbvid:1001': {
      step: 'success',
      message: '视频已生成',
      resultUrl: 'data:video/mp4;base64,AAAA',
      resultType: 'video',
      storyboardId: 1001,
      dramaId: 3,
      at: Date.now(),
    },
    'sbaud:1001:dialogue': {
      step: 'success',
      message: '音频已生成',
      resultUrl: 'data:audio/mpeg;base64,AAAA',
      resultType: 'audio',
      storyboardId: 1001,
      dramaId: 3,
      at: Date.now(),
    },
  })

  await page.goto('/film/3/canvas')

  const imageNode = page.locator('.vue-flow__node[data-id="sbimg:1001"]')
  const videoNode = page.locator('.vue-flow__node[data-id="sbvid:1001"]')
  const audioNode = page.locator('.vue-flow__node[data-id="sbaud:1001:dialogue"]')
  await expect(imageNode.locator('img[alt="节点生成结果预览"]')).toBeAttached()
  await expect(videoNode.locator('.node-status-overlay video')).toBeAttached()
  await expect(audioNode.locator('.node-status-overlay audio')).toBeAttached()

  const queue = page.getByLabel('画布节点运行队列')
  await expect(queue).toBeVisible()
  await expect(queue.locator('.queue-preview-image img[alt="队列结果预览"]')).toBeVisible()
  await expect(queue.locator('.queue-preview-video video')).toBeVisible()
  await expect(queue.locator('.queue-preview-audio audio')).toBeVisible()

  await imageNode.click({ button: 'right', position: { x: 12, y: 12 } })
  const menu = page.getByRole('menu', { name: '节点操作' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /打开结果/ })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /复制结果链接/ })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /下载结果/ })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /存入素材库/ })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /作为下游参考/ })).toBeVisible()
})

test('项目画布恢复失败写回并暴露原因与重试入口', async ({ page }) => {
  await seedNodeStatus(page, {
    'sb:1001': {
      step: 'failed',
      message: '视频供应商任务失败',
      errorDetail: '供应商返回超时，请重试当前分镜视频。',
      retryStep: 'video',
      retryLabel: '重试视频',
      recoverable: true,
      storyboardId: 1001,
      dramaId: 3,
      at: Date.now(),
    },
  })

  await page.goto('/film/3/canvas')

  const storyboardNode = page.locator('.vue-flow__node[data-id="sb:1001"]')
  const failedOverlay = storyboardNode.locator('.node-status-overlay.step-failed')
  await expect(failedOverlay).toBeVisible()
  await expect(failedOverlay).toContainText('视频供应商任务失败')
  await expect(failedOverlay).toContainText('可点击重试继续执行')
  await expect(failedOverlay.getByRole('button', { name: '复制原因' })).toBeVisible()
  await expect(failedOverlay.getByRole('button', { name: '重试视频' })).toBeVisible()

  const queue = page.getByLabel('画布节点运行队列')
  await expect(queue.locator('.run-queue-item.tone-failed')).toContainText('视频供应商任务失败')
  await expect(queue.locator('.run-queue-item.tone-failed').getByRole('button', { name: '原因' })).toBeVisible()
  await expect(queue.locator('.run-queue-item.tone-failed').getByRole('button', { name: '重试' })).toBeVisible()

  await storyboardNode.click({ button: 'right', position: { x: 12, y: 12 } })
  const menu = page.getByRole('menu', { name: '节点操作' })
  await expect(menu.getByRole('menuitem', { name: /重试失败节点/ })).toBeVisible()
})
