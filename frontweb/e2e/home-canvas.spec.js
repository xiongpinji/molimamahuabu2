import { test, expect } from '@playwright/test'

const homeCanvasStorageKey = 'moli-mama.home-canvas.v1'
const seededHomeCanvasState = {
  version: 1,
  nodes: [{
    id: 'e2e:seed',
    type: 'homeCanvasNode',
    position: { x: 600, y: 500 },
    data: { kind: 'text', title: 'E2E 种子节点', content: '用于覆盖画布事件层。' },
  }],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 0.75 },
}
const edgeHomeCanvasState = {
  version: 1,
  nodes: [
    {
      id: 'e2e:source',
      type: 'homeCanvasNode',
      position: { x: 360, y: 420 },
      data: { kind: 'text', title: 'E2E 源节点', content: '边重连起点' },
    },
    {
      id: 'e2e:target-a',
      type: 'homeCanvasNode',
      position: { x: 760, y: 420 },
      data: { kind: 'text', title: 'E2E 目标节点 A', content: '边重连旧目标' },
    },
    {
      id: 'e2e:target-b',
      type: 'homeCanvasNode',
      position: { x: 760, y: 700 },
      data: { kind: 'text', title: 'E2E 目标节点 B', content: '边重连新目标' },
    },
  ],
  edges: [{ id: 'e2e:edge', source: 'e2e:source', target: 'e2e:target-a', type: 'smoothstep' }],
  viewport: { x: 0, y: 0, zoom: 0.75 },
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ storageKey, state }) => {
    window.localStorage.setItem(storageKey, JSON.stringify(state))
  }, { storageKey: homeCanvasStorageKey, state: seededHomeCanvasState })
  await page.goto('/canvas')
  await expect(page.locator('.home-starter-panel')).toHaveCount(0)
})

test('右键添加文本节点并支持删除、撤销和重做', async ({ page }) => {
  const canvas = page.locator('.canvas-main')

  await canvas.click({ button: 'right', position: { x: 1100, y: 700 } })
  await expect(page.getByText('在此添加')).toBeVisible()
  await page.getByRole('button', { name: '文本节点' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('标题').fill('E2E 回归节点')
  await dialog.getByLabel('内容').fill('验证首页自由画布关键交互')
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('E2E 回归节点')).toBeVisible()

  await page.locator('.vue-flow__node').filter({ hasText: 'E2E 回归节点' }).click()
  await page.keyboard.press('Delete')
  await expect(page.getByText('E2E 回归节点')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '撤销' })).toBeEnabled()

  await page.keyboard.press('Control+z')
  await expect(page.getByText('E2E 回归节点')).toBeVisible()
  await page.keyboard.press('Control+Shift+z')
  await expect(page.getByText('E2E 回归节点')).toHaveCount(0)
})

test('复制粘贴选中节点会生成带偏移的副本', async ({ page }) => {
  const seedNode = page.locator('.vue-flow__node').filter({ hasText: 'E2E 种子节点' })

  await seedNode.click()
  await expect(seedNode).toHaveClass(/selected/)
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')

  const pastedNodes = page.locator('.vue-flow__node').filter({ hasText: 'E2E 种子节点' })
  await expect(pastedNodes).toHaveCount(2)
  await expect.poll(async () => page.evaluate((storageKey) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}')
    return state.nodes?.map((node) => [node.position.x, node.position.y]) || []
  }, homeCanvasStorageKey)).toEqual([[600, 500], [640, 540]])
  await expect.poll(async () => page.evaluate((storageKey) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}')
    return state.nodes?.length || 0
  }, homeCanvasStorageKey)).toBe(2)
})

test('拖动边目标端点会更新连接目标并持久化', async ({ page }) => {
  await page.addInitScript(({ storageKey, state }) => {
    window.localStorage.setItem(storageKey, JSON.stringify(state))
  }, { storageKey: homeCanvasStorageKey, state: edgeHomeCanvasState })
  await page.reload()

  const edge = page.locator('.vue-flow__edge[data-id="e2e:edge"]')
  await expect(edge).toHaveCount(1)
  const updater = edge.locator('.vue-flow__edgeupdater-target')
  const targetHandle = page.locator('.vue-flow__node').filter({ hasText: 'E2E 目标节点 B' }).locator('.vue-flow__handle.target')
  await expect(targetHandle).toHaveCount(1)

  const updaterBox = await updater.boundingBox()
  const targetBox = await targetHandle.boundingBox()
  expect(updaterBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  await page.mouse.move(updaterBox.x + updaterBox.width / 2, updaterBox.y + updaterBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 })
  await page.mouse.up()

  await expect.poll(async () => page.evaluate((storageKey) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}')
    return state.edges?.find((item) => item.id === 'e2e:edge')?.target || null
  }, homeCanvasStorageKey)).toBe('e2e:target-b')
})

test('Ctrl 加滚轮缩放，普通滚轮保持画布平移', async ({ page }) => {
  const canvas = page.locator('.canvas-main')
  const viewport = page.locator('.vue-flow__transformationpane')
  const zoomLabel = page.locator('.zoom-label')
  const initialZoom = await zoomLabel.textContent()
  const initialTransform = await viewport.evaluate((element) => element.style.transform)

  await canvas.hover({ position: { x: 620, y: 390 } })
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -240)
  await page.keyboard.up('Control')
  await expect(zoomLabel).not.toHaveText(initialZoom)
  const zoomedZoom = await zoomLabel.textContent()

  const zoomedTransform = await viewport.evaluate((element) => element.style.transform)
  await page.mouse.wheel(0, 240)
  await expect(zoomLabel).toHaveText(zoomedZoom)
  await expect.poll(() => viewport.evaluate((element) => element.style.transform)).not.toBe(zoomedTransform)
  await expect.poll(() => viewport.evaluate((element) => element.style.transform)).not.toBe(initialTransform)
})
