import { test, expect } from '@playwright/test'

const homeCanvasStorageKey = 'moli-mama.home-canvas.v1'
const projectCanvasLayout = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 0.75 },
  nodes: {},
  manual_edges: [],
  free_nodes: [{
    id: 'project-zoom-node',
    type: 'homeCanvasNode',
    position: { x: 480, y: 360 },
    data: { kind: 'text', title: '项目画布缩放节点', content: '验证完整项目画布仍能缩放' },
  }],
}

const projectDrama = {
  id: 3,
  title: '导航缩放测试项目',
  metadata: { project_type: 'canvas', canvas_layout: projectCanvasLayout },
  characters: [],
  scenes: [],
  props: [],
  episodes: [],
}

function json(data) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  }
}

async function dispatchWheel(locator, init = {}) {
  return locator.evaluate((element, wheelInit) => {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -120,
      ...wheelInit,
    })
    const dispatchResult = element.dispatchEvent(event)
    return { defaultPrevented: event.defaultPrevented, dispatchResult }
  }, init)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((storageKey) => {
    localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'navigation-zoom-e2e-session',
      user: { id: 'navigation-zoom-user', email: 'zoom@example.com', role: 'user' },
    }))
    localStorage.setItem(storageKey, JSON.stringify({
      version: 1,
      nodes: [{
        id: 'zoom-node',
        type: 'homeCanvasNode',
        position: { x: 480, y: 360 },
        data: { kind: 'text', title: '缩放测试节点', content: '验证画布仍能缩放' },
      }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 0.75 },
    }))
  }, homeCanvasStorageKey)

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const { pathname } = new URL(route.request().url())
    if (request.method() === 'GET' && pathname === '/api/v1/dramas/3') {
      return route.fulfill(json(projectDrama))
    }
    if (request.method() === 'PUT' && pathname === '/api/v1/dramas/3/canvas-layout') {
      return route.fulfill(json({
        ...projectDrama,
        metadata: { ...projectDrama.metadata, canvas_layout: request.postDataJSON()?.canvas_layout },
      }))
    }
    if (pathname === '/api/v1/tenants') {
      return route.fulfill(json([{ id: 'tenant-1', name: '茉莉企业', slug: 'moli-enterprise', role: 'owner' }]))
    }
    if (pathname === '/api/v1/billing/account') {
      return route.fulfill(json({ available: 100, held: 0, spent: 0 }))
    }
    if (pathname.includes('/members') || pathname.includes('/credit-transactions')) {
      return route.fulfill(json([]))
    }
    return route.fulfill(json([]))
  })
})

for (const pageCase of [
  { name: '首页', path: '/', selector: '.platform-header' },
  { name: '企业页面', path: '/tenant-console', selector: '.platform-header' },
]) {
  test(`${pageCase.name}导航栏阻止 Ctrl 滚轮整页缩放`, async ({ page }) => {
    await page.goto(pageCase.path)
    const header = page.locator(pageCase.selector)
    await expect(header).toBeVisible()

    await expect(dispatchWheel(header, { ctrlKey: true })).resolves.toEqual({
      defaultPrevented: true,
      dispatchResult: false,
    })
    await expect(dispatchWheel(header)).resolves.toEqual({
      defaultPrevented: false,
      dispatchResult: true,
    })
  })
}

test('画布导航固定且 Ctrl 滚轮仍只缩放画布内容', async ({ page }) => {
  await page.goto('/canvas/local')
  const header = page.locator('.canvas-topbar')
  const canvas = page.locator('.canvas-main')
  const viewport = page.locator('.vue-flow__transformationpane')
  await expect(header).toBeVisible()
  await expect(viewport).toBeVisible()

  await expect(dispatchWheel(header, { ctrlKey: true })).resolves.toEqual({
    defaultPrevented: true,
    dispatchResult: false,
  })

  const transformBefore = await viewport.getAttribute('style')
  await expect(dispatchWheel(canvas, { ctrlKey: true })).resolves.toEqual({
    defaultPrevented: true,
    dispatchResult: false,
  })
  await expect.poll(() => viewport.getAttribute('style')).not.toBe(transformBefore)
})

test('完整项目画布导航固定且 Ctrl 滚轮仍只缩放 DramaCanvas', async ({ page }) => {
  await page.goto('/canvas/3')
  const header = page.locator('.canvas-topbar')
  const canvas = page.locator('.canvas-main')
  const viewport = page.locator('.vue-flow__transformationpane')
  await expect(header).toBeVisible()
  await expect(viewport).toBeVisible()

  await expect(dispatchWheel(header, { ctrlKey: true })).resolves.toEqual({
    defaultPrevented: true,
    dispatchResult: false,
  })

  const transformBefore = await viewport.getAttribute('style')
  await canvas.hover({ position: { x: 700, y: 420 } })
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -240)
  await page.keyboard.up('Control')
  await expect.poll(() => viewport.getAttribute('style')).not.toBe(transformBefore)
})
