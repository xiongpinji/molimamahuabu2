import { test, expect } from '@playwright/test'

const homeCanvasStorageKey = 'moli-mama.home-canvas.v1'
const seededHomeCanvasState = {
  version: 1,
  nodes: [{
    id: 'e2e:seed',
    type: 'homeCanvasNode',
    position: { x: -420, y: -180 },
    data: { kind: 'text', title: 'E2E 种子节点', content: '用于覆盖画布事件层。' },
  }],
  edges: [],
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

  await canvas.click({ button: 'right', position: { x: 620, y: 390 } })
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
