import { test, expect } from '@playwright/test'

const homeCanvasStorageKey = 'moli-mama.home-canvas.v1'
const pendingHomeCanvasStateKey = 'moli-mama.e2e.pending-home-canvas-state'
const referenceImageDataUrls = [
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22120%22%3E%3Crect width=%22200%22 height=%22120%22 fill=%22%23f27645%22/%3E%3C/svg%3E',
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22120%22%3E%3Crect width=%22200%22 height=%22120%22 fill=%22%234563f2%22/%3E%3C/svg%3E',
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22120%22%3E%3Crect width=%22200%22 height=%22120%22 fill=%22%2345b86b%22/%3E%3C/svg%3E',
]
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
      position: { x: 960, y: 420 },
      data: { kind: 'text', title: 'E2E 目标节点 A', content: '边重连旧目标' },
    },
    {
      id: 'e2e:target-b',
      type: 'homeCanvasNode',
      position: { x: 960, y: 680 },
      data: { kind: 'text', title: 'E2E 目标节点 B', content: '边重连新目标' },
    },
  ],
  edges: [{ id: 'e2e:edge', source: 'e2e:source', target: 'e2e:target-a', type: 'smoothstep' }],
  viewport: { x: 0, y: 0, zoom: 0.75 },
}
const mentionHomeCanvasState = {
  version: 1,
  nodes: [
    {
      id: 'e2e:image-reference',
      type: 'homeCanvasNode',
      position: { x: 360, y: 420 },
      data: {
        kind: 'image',
        title: '女主角定妆照',
        content: '',
        url: referenceImageDataUrls[0],
      },
    },
    {
      id: 'e2e:video-target',
      type: 'homeCanvasNode',
      position: { x: 900, y: 420 },
      data: { kind: 'video', title: '出场镜头', content: '女主角走入画面 ' },
    },
  ],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 0.75 },
}
const generatedMentionHomeCanvasState = {
  ...mentionHomeCanvasState,
  nodes: mentionHomeCanvasState.nodes.map((node) => (
    node.id === 'e2e:image-reference'
      ? {
          ...node,
          data: {
            ...node.data,
            resultUrls: [node.data.url],
          },
        }
      : node
  )),
}
const numberedMentionHomeCanvasState = {
  ...mentionHomeCanvasState,
  nodes: [
    mentionHomeCanvasState.nodes[0],
    {
      ...mentionHomeCanvasState.nodes[0],
      id: 'e2e:image-reference-2',
      position: { x: 360, y: 680 },
      data: { ...mentionHomeCanvasState.nodes[0].data, title: '雨夜街道', url: referenceImageDataUrls[1] },
    },
    {
      ...mentionHomeCanvasState.nodes[0],
      id: 'e2e:image-reference-3',
      position: { x: 360, y: 940 },
      data: { ...mentionHomeCanvasState.nodes[0].data, title: '跑车侧面', url: referenceImageDataUrls[2] },
    },
    mentionHomeCanvasState.nodes[1],
  ],
  edges: [
    { id: 'e2e:reference-1', source: 'e2e:image-reference', target: 'e2e:video-target', type: 'smoothstep', data: { contract: { input: 'reference-image', order: 0 } } },
    { id: 'e2e:reference-2', source: 'e2e:image-reference-2', target: 'e2e:video-target', type: 'smoothstep', data: { contract: { input: 'reference-image', order: 1 } } },
    { id: 'e2e:reference-3', source: 'e2e:image-reference-3', target: 'e2e:video-target', type: 'smoothstep', data: { contract: { input: 'reference-image', order: 2 } } },
  ],
}
const editorFitHomeCanvasState = {
  version: 1,
  nodes: [
    {
      id: 'e2e:fit:image',
      type: 'homeCanvasNode',
      position: { x: 300, y: 600 },
      data: { kind: 'image', title: '完整适配图片节点', content: '' },
    },
    {
      id: 'e2e:fit:video',
      type: 'homeCanvasNode',
      position: { x: 1100, y: 600 },
      data: { kind: 'video', title: '完整适配视频节点', content: '' },
    },
    {
      id: 'e2e:fit:audio',
      type: 'homeCanvasNode',
      position: { x: 1900, y: 600 },
      data: { kind: 'audio', title: '完整适配音频节点', content: '' },
    },
    {
      id: 'e2e:fit:text',
      type: 'homeCanvasNode',
      position: { x: 2700, y: 600 },
      data: { kind: 'text', title: '完整适配文本节点', content: '完整显示文本编辑内容。' },
    },
  ],
  edges: [],
  viewport: { x: 160, y: 180, zoom: 0.2 },
}

async function loadHomeCanvasState(page, state) {
  await page.evaluate(({ pendingKey, nextState }) => {
    window.localStorage.setItem(pendingKey, JSON.stringify(nextState))
  }, {
    pendingKey: pendingHomeCanvasStateKey,
    nextState: state,
  })
  await page.reload()
  await expect(page.locator('.home-starter-panel')).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ storageKey, pendingKey }) => {
    window.localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'canvas-e2e-session',
      user: { id: 'canvas-e2e-user', email: 'canvas-e2e@example.com', role: 'user' },
    }))
    const pendingState = window.localStorage.getItem(pendingKey)
    if (pendingState) {
      window.localStorage.setItem(storageKey, pendingState)
      window.localStorage.removeItem(pendingKey)
    }
  }, {
    storageKey: homeCanvasStorageKey,
    pendingKey: pendingHomeCanvasStateKey,
  })
  await page.goto('/canvas/local')
  await loadHomeCanvasState(page, seededHomeCanvasState)
})

test('文本节点单击后在专属编辑器直接编辑，不再依赖配置弹窗', async ({ page }) => {
  const seedNode = page.locator('.vue-flow__node[data-id="e2e:seed"]')

  await seedNode.click()
  const editor = page.locator('.node-expanded-editor')
  await expect(seedNode).toHaveClass(/selected/)
  await expect(seedNode.locator('.home-canvas-node')).toHaveClass(/is-selected/)
  await expect(seedNode.getByRole('textbox', { name: '节点标题' })).toHaveValue('E2E 种子节点')
  await expect(editor.getByRole('textbox', { name: '文本内容' })).toHaveValue('用于覆盖画布事件层。')
  await expect(seedNode.getByRole('button', { name: '配置' })).toHaveCount(0)

  await editor.getByRole('textbox', { name: '文本内容' }).fill('节点内直接编辑后的内容')
  await editor.getByRole('textbox', { name: '文本内容' }).blur()

  await expect.poll(async () => page.evaluate((storageKey) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}')
    return state.nodes?.find((node) => node.id === 'e2e:seed')?.data?.content || ''
  }, homeCanvasStorageKey)).toBe('节点内直接编辑后的内容')
})

test('节点编辑器锚定节点、完整保持在视口内并支持提示词全屏编辑', async ({ page }) => {
  const seedNode = page.locator('.vue-flow__node[data-id="e2e:seed"]')
  await seedNode.locator('.node-icon').click()

  const editor = page.locator('.node-expanded-editor')
  const visualNode = seedNode.locator('.home-canvas-node')
  const nodeBefore = await visualNode.boundingBox()
  const editorBefore = await editor.boundingBox()
  const viewport = page.viewportSize()
  expect(nodeBefore).not.toBeNull()
  expect(editorBefore).not.toBeNull()
  expect(await editor.evaluate((element) => element.parentElement === document.body)).toBe(true)
  await expect.poll(() => editor.evaluate((element) => getComputedStyle(element).position)).toBe('fixed')
  expect(editorBefore.x).toBeGreaterThanOrEqual(0)
  expect(editorBefore.y).toBeGreaterThanOrEqual(0)
  expect(editorBefore.x + editorBefore.width).toBeLessThanOrEqual(viewport.width)
  expect(editorBefore.y + editorBefore.height).toBeLessThanOrEqual(viewport.height)
  await expect(editor).toHaveAttribute('data-editor-dock', 'bottom')

  const dragHandle = seedNode.locator('.node-icon')
  const dragBox = await dragHandle.boundingBox()
  expect(dragBox).not.toBeNull()
  await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(dragBox.x + dragBox.width / 2 + 140, dragBox.y + dragBox.height / 2 + 80, { steps: 8 })
  await page.mouse.up()

  const nodeAfter = await visualNode.boundingBox()
  const editorAfter = await editor.boundingBox()
  expect(nodeAfter).not.toBeNull()
  expect(editorAfter).not.toBeNull()
  const expectedEditorLeftAfter = Math.min(
    Math.max(16, nodeAfter.x + nodeAfter.width / 2 - editorAfter.width / 2),
    Math.max(16, viewport.width - editorAfter.width - 16),
  )
  expect(Math.abs(editorAfter.x - expectedEditorLeftAfter)).toBeLessThan(5)
  expect(Math.abs((editorAfter.y - editorBefore.y) - (nodeAfter.y - nodeBefore.y))).toBeLessThan(5)
  expect(editorAfter.x).toBeGreaterThanOrEqual(0)
  expect(editorAfter.y).toBeGreaterThanOrEqual(0)
  expect(editorAfter.x + editorAfter.width).toBeLessThanOrEqual(viewport.width)
  expect(editorAfter.y + editorAfter.height).toBeLessThanOrEqual(viewport.height)

  const anchoredGap = async () => {
    const [nodeBox, editorBox] = await Promise.all([
      visualNode.boundingBox(),
      editor.boundingBox(),
    ])
    return Math.abs((editorBox.y - nodeBox.y - nodeBox.height) - 12)
  }
  const canvasBox = await page.locator('.canvas-main').boundingBox()
  const transformationPane = page.locator('.vue-flow__transformationpane')
  const transformBeforeZoom = await transformationPane.evaluate((element) => element.style.transform)
  await page.mouse.move(canvasBox.x + canvasBox.width - 30, canvasBox.y + 100)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -120)
  await page.keyboard.up('Control')
  await expect.poll(() => transformationPane.evaluate((element) => element.style.transform)).not.toBe(transformBeforeZoom)
  await expect.poll(anchoredGap).toBeLessThan(5)
  const transformBeforePan = await transformationPane.evaluate((element) => element.style.transform)
  await page.mouse.wheel(0, 120)
  await expect.poll(() => transformationPane.evaluate((element) => element.style.transform)).not.toBe(transformBeforePan)
  await expect.poll(anchoredGap).toBeLessThan(5)

  await editor.getByRole('button', { name: '全屏编辑' }).click()
  await expect(editor).toHaveClass(/is-fullscreen/)
  const fullscreenInput = editor.getByRole('textbox', { name: '文本内容' })
  await expect.poll(() => fullscreenInput.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(450)

  await editor.getByRole('button', { name: '全屏编辑' }).click()
  await expect(editor).not.toHaveClass(/is-fullscreen/)
  const restoredEditor = await editor.boundingBox()
  expect(restoredEditor.x).toBeGreaterThanOrEqual(0)
  expect(restoredEditor.y).toBeGreaterThanOrEqual(0)
  expect(restoredEditor.x + restoredEditor.width).toBeLessThanOrEqual(viewport.width)
  expect(restoredEditor.y + restoredEditor.height).toBeLessThanOrEqual(viewport.height)
})

test('节点靠近视口底部时编辑器仍固定在节点下方', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1000 })
  await loadHomeCanvasState(page, {
    ...seededHomeCanvasState,
    viewport: { x: 0, y: 250, zoom: 0.75 },
  })

  const node = page.locator('.vue-flow__node[data-id="e2e:seed"]')
  const transformationPane = page.locator('.vue-flow__transformationpane')
  const transformBeforeSelection = await transformationPane.evaluate((element) => element.style.transform)
  await node.click()

  const editor = page.locator('.node-expanded-editor')
  await expect(editor).toBeVisible()
  await expect(editor).toHaveAttribute('data-editor-dock', 'bottom')
  await page.evaluate(() => new Promise((resolve) => {
    let frameCount = 0
    const waitForFrames = () => {
      frameCount += 1
      if (frameCount >= 6) resolve()
      else window.requestAnimationFrame(waitForFrames)
    }
    window.requestAnimationFrame(waitForFrames)
  }))
  expect(await transformationPane.evaluate((element) => element.style.transform)).toBe(transformBeforeSelection)

  const [nodeBox, editorBox, documentLayout] = await Promise.all([
    node.locator('.home-canvas-node').boundingBox(),
    editor.boundingBox(),
    page.evaluate(() => ({
      bodyClientHeight: document.body.clientHeight,
      bodyClientWidth: document.body.clientWidth,
      bodyScrollHeight: document.body.scrollHeight,
      bodyScrollWidth: document.body.scrollWidth,
      rootClientHeight: document.documentElement.clientHeight,
      rootClientWidth: document.documentElement.clientWidth,
      rootScrollHeight: document.documentElement.scrollHeight,
      rootScrollWidth: document.documentElement.scrollWidth,
    })),
  ])
  const viewport = page.viewportSize()

  expect(nodeBox).not.toBeNull()
  expect(editorBox).not.toBeNull()
  expect(Math.abs((editorBox.y - nodeBox.y - nodeBox.height) - 12)).toBeLessThan(5)
  expect(editorBox.y + editorBox.height).toBeLessThanOrEqual(viewport.height)
  expect(documentLayout.bodyScrollHeight).toBeLessThanOrEqual(documentLayout.bodyClientHeight + 1)
  expect(documentLayout.bodyScrollWidth).toBeLessThanOrEqual(documentLayout.bodyClientWidth + 1)
  expect(documentLayout.rootScrollHeight).toBeLessThanOrEqual(documentLayout.rootClientHeight + 1)
  expect(documentLayout.rootScrollWidth).toBeLessThanOrEqual(documentLayout.rootClientWidth + 1)
})

test('节点贴住视口底边时编辑器钉在视口内且不缩成不可操作尺寸', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1000 })
  await loadHomeCanvasState(page, {
    ...seededHomeCanvasState,
    viewport: { x: 0, y: 450, zoom: 0.75 },
  })

  const node = page.locator('.vue-flow__node[data-id="e2e:seed"]')
  const transformationPane = page.locator('.vue-flow__transformationpane')
  const transformBeforeSelection = await transformationPane.evaluate((element) => element.style.transform)
  await node.locator('.node-icon').click()

  const editor = page.locator('.node-expanded-editor')
  await expect(editor).toBeVisible()
  await expect(editor).toHaveAttribute('data-editor-dock', 'viewport')
  const [nodeBox, editorBox] = await Promise.all([
    node.locator('.home-canvas-node').boundingBox(),
    editor.boundingBox(),
  ])
  const viewport = page.viewportSize()

  expect(nodeBox).not.toBeNull()
  expect(editorBox).not.toBeNull()
  expect(editorBox.width).toBeGreaterThanOrEqual(258)
  expect(editorBox.x).toBeGreaterThanOrEqual(0)
  expect(editorBox.y).toBeGreaterThanOrEqual(0)
  expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(viewport.width)
  expect(editorBox.y + editorBox.height).toBeLessThanOrEqual(viewport.height)
  const overlapWidth = Math.max(0, Math.min(editorBox.x + editorBox.width, nodeBox.x + nodeBox.width) - Math.max(editorBox.x, nodeBox.x))
  const overlapHeight = Math.max(0, Math.min(editorBox.y + editorBox.height, nodeBox.y + nodeBox.height) - Math.max(editorBox.y, nodeBox.y))
  expect(overlapWidth * overlapHeight).toBeLessThan(1)
  expect(await transformationPane.evaluate((element) => element.style.transform)).toBe(transformBeforeSelection)
})

test('节点水平居中且贴底时编辑器使用上方空隙且不覆盖节点', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1000 })
  await loadHomeCanvasState(page, {
    ...seededHomeCanvasState,
    viewport: { x: -320, y: 280, zoom: 1 },
  })

  const node = page.locator('.vue-flow__node[data-id="e2e:seed"]')
  const transformationPane = page.locator('.vue-flow__transformationpane')
  const transformBeforeSelection = await transformationPane.evaluate((element) => element.style.transform)
  await node.locator('.node-icon').click()

  const editor = page.locator('.node-expanded-editor')
  await expect(editor).toBeVisible()
  await expect(editor).toHaveAttribute('data-editor-dock', 'viewport')
  const [nodeBox, editorBox] = await Promise.all([
    node.locator('.home-canvas-node').boundingBox(),
    editor.boundingBox(),
  ])
  const viewport = page.viewportSize()

  expect(nodeBox).not.toBeNull()
  expect(editorBox).not.toBeNull()
  expect(editorBox.width).toBeGreaterThanOrEqual(258)
  expect(editorBox.x).toBeGreaterThanOrEqual(0)
  expect(editorBox.y).toBeGreaterThanOrEqual(0)
  expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(viewport.width)
  expect(editorBox.y + editorBox.height).toBeLessThanOrEqual(viewport.height)
  expect(Math.abs((nodeBox.y - editorBox.y - editorBox.height) - 12)).toBeLessThan(5)
  expect(await transformationPane.evaluate((element) => element.style.transform)).toBe(transformBeforeSelection)
})

test('图片工具栏菜单展开时编辑器避让全部可见控件', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1000 })
  await loadHomeCanvasState(page, {
    ...mentionHomeCanvasState,
    viewport: { x: -200, y: 400, zoom: 0.75 },
  })

  const node = page.locator('.vue-flow__node[data-id="e2e:image-reference"]')
  await node.click()
  const toolbar = node.locator('.image-node-toolbar')
  await expect(toolbar).toBeVisible()
  const editor = page.locator('.node-expanded-editor')
  await expect(editor).toBeVisible()

  await expect.poll(async () => {
    const [editorBox, toolbarBox] = await Promise.all([
      editor.boundingBox(),
      toolbar.boundingBox(),
    ])
    if (!editorBox || !toolbarBox) return Number.POSITIVE_INFINITY
    const overlapWidth = Math.max(0, Math.min(editorBox.x + editorBox.width, toolbarBox.x + toolbarBox.width) - Math.max(editorBox.x, toolbarBox.x))
    const overlapHeight = Math.max(0, Math.min(editorBox.y + editorBox.height, toolbarBox.y + toolbarBox.height) - Math.max(editorBox.y, toolbarBox.y))
    return overlapWidth * overlapHeight
  }).toBeLessThan(1)

  await toolbar.getByRole('button', { name: /工具/ }).hover()
  await expect(toolbar.locator('.toolbar-menu')).toBeVisible()
  await expect(editor).toHaveCount(0)

  const documentLayout = await page.evaluate(() => ({
    rootClientWidth: document.documentElement.clientWidth,
    rootScrollWidth: document.documentElement.scrollWidth,
    rootClientHeight: document.documentElement.clientHeight,
    rootScrollHeight: document.documentElement.scrollHeight,
  }))
  expect(documentLayout.rootScrollWidth).toBeLessThanOrEqual(documentLayout.rootClientWidth + 1)
  expect(documentLayout.rootScrollHeight).toBeLessThanOrEqual(documentLayout.rootClientHeight + 1)
})

test('节点完全移出视口时编辑器隐藏且节点移回后自动恢复', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1000 })
  await loadHomeCanvasState(page, {
    ...seededHomeCanvasState,
    viewport: { x: 0, y: 120, zoom: 0.75 },
  })

  const node = page.locator('.vue-flow__node[data-id="e2e:seed"]')
  await node.locator('.node-icon').click()
  const editor = page.locator('.node-expanded-editor')
  await expect(editor).toBeVisible()

  const viewport = page.viewportSize()
  const pane = page.locator('.vue-flow__pane')
  await pane.hover({ position: { x: 24, y: 420 } })
  await page.mouse.wheel(0, 2400)
  await expect.poll(async () => {
    const box = await node.locator('.home-canvas-node').boundingBox()
    return box && (box.y + box.height <= 16 || box.y >= viewport.height - 16)
  }).toBeTruthy()
  await expect(editor).toHaveAttribute('data-editor-dock', 'hidden')
  await expect(editor).toHaveCSS('visibility', 'hidden')
  await expect(editor).toHaveCSS('pointer-events', 'none')

  await page.mouse.wheel(0, -2400)
  await expect.poll(async () => {
    const box = await node.locator('.home-canvas-node').boundingBox()
    return box && box.y + box.height > 16 && box.y < viewport.height - 16
  }).toBeTruthy()
  await expect(editor).toBeVisible()
  await expect(editor).not.toHaveAttribute('data-editor-dock', 'hidden')
})

test('节点编辑器在不同画布缩放下完整显示且根容器不产生滚动条', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1000 })

  const editorSizeAtZoom = async (zoom) => {
    await loadHomeCanvasState(page, {
      ...seededHomeCanvasState,
      viewport: {
        x: 600 - seededHomeCanvasState.nodes[0].position.x * zoom,
        y: 260 - seededHomeCanvasState.nodes[0].position.y * zoom,
        zoom,
      },
    })
    await page.locator('.vue-flow__node[data-id="e2e:seed"]').click()
    const editor = page.locator('.node-expanded-editor')
    await expect(editor).toBeVisible()
    await expect(page.locator('.zoom-label')).toHaveText(`${Math.round(zoom * 100)}%`)
    return {
      box: await editor.boundingBox(),
      layout: await editor.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          clientHeight: element.clientHeight,
          clientWidth: element.clientWidth,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          scrollHeight: element.scrollHeight,
          scrollWidth: element.scrollWidth,
        }
      }),
      footerBox: await editor.locator('.editor-footer').boundingBox(),
      documentLayout: await page.evaluate(() => ({
        bodyClientHeight: document.body.clientHeight,
        bodyClientWidth: document.body.clientWidth,
        bodyScrollHeight: document.body.scrollHeight,
        bodyScrollWidth: document.body.scrollWidth,
        rootClientHeight: document.documentElement.clientHeight,
        rootClientWidth: document.documentElement.clientWidth,
        rootScrollHeight: document.documentElement.scrollHeight,
        rootScrollWidth: document.documentElement.scrollWidth,
      })),
    }
  }

  const compactEditor = await editorSizeAtZoom(0.2)
  const normalEditor = await editorSizeAtZoom(1)
  const viewport = page.viewportSize()

  expect(compactEditor.box).not.toBeNull()
  expect(normalEditor.box).not.toBeNull()
  expect(compactEditor.box.width).toBeGreaterThanOrEqual(480)
  expect(compactEditor.box.x).toBeGreaterThanOrEqual(0)
  expect(compactEditor.box.y).toBeGreaterThanOrEqual(0)
  expect(compactEditor.box.x + compactEditor.box.width).toBeLessThanOrEqual(viewport.width)
  expect(compactEditor.box.y + compactEditor.box.height).toBeLessThanOrEqual(viewport.height)
  expect(compactEditor.layout.scrollHeight).toBeLessThanOrEqual(compactEditor.layout.clientHeight + 1)
  expect(compactEditor.layout.scrollWidth).toBeLessThanOrEqual(compactEditor.layout.clientWidth + 1)
  expect(compactEditor.layout.overflowX).not.toMatch(/^(auto|scroll)$/)
  expect(compactEditor.layout.overflowY).not.toMatch(/^(auto|scroll)$/)
  expect(compactEditor.documentLayout.bodyScrollHeight).toBeLessThanOrEqual(compactEditor.documentLayout.bodyClientHeight + 1)
  expect(compactEditor.documentLayout.bodyScrollWidth).toBeLessThanOrEqual(compactEditor.documentLayout.bodyClientWidth + 1)
  expect(compactEditor.documentLayout.rootScrollHeight).toBeLessThanOrEqual(compactEditor.documentLayout.rootClientHeight + 1)
  expect(compactEditor.documentLayout.rootScrollWidth).toBeLessThanOrEqual(compactEditor.documentLayout.rootClientWidth + 1)
  expect(compactEditor.footerBox).not.toBeNull()
  expect(compactEditor.footerBox.y).toBeGreaterThanOrEqual(compactEditor.box.y)
  expect(compactEditor.footerBox.y + compactEditor.footerBox.height)
    .toBeLessThanOrEqual(compactEditor.box.y + compactEditor.box.height + 1)
  expect(normalEditor.box.x).toBeGreaterThanOrEqual(0)
  expect(normalEditor.box.y).toBeGreaterThanOrEqual(0)
  expect(normalEditor.box.x + normalEditor.box.width).toBeLessThanOrEqual(viewport.width)
  expect(normalEditor.box.y + normalEditor.box.height).toBeLessThanOrEqual(viewport.height)
  expect(normalEditor.layout.scrollHeight).toBeLessThanOrEqual(normalEditor.layout.clientHeight + 1)
  expect(normalEditor.layout.scrollWidth).toBeLessThanOrEqual(normalEditor.layout.clientWidth + 1)
  expect(normalEditor.layout.overflowX).not.toMatch(/^(auto|scroll)$/)
  expect(normalEditor.layout.overflowY).not.toMatch(/^(auto|scroll)$/)
  expect(normalEditor.documentLayout.bodyScrollHeight).toBeLessThanOrEqual(normalEditor.documentLayout.bodyClientHeight + 1)
  expect(normalEditor.documentLayout.bodyScrollWidth).toBeLessThanOrEqual(normalEditor.documentLayout.bodyClientWidth + 1)
  expect(normalEditor.documentLayout.rootScrollHeight).toBeLessThanOrEqual(normalEditor.documentLayout.rootClientHeight + 1)
  expect(normalEditor.documentLayout.rootScrollWidth).toBeLessThanOrEqual(normalEditor.documentLayout.rootClientWidth + 1)
})

test('所有节点类型和节点宽度都使用完整无滚动的编辑框', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1000 })
  await loadHomeCanvasState(page, editorFitHomeCanvasState)

  const viewport = page.viewportSize()
  for (const id of ['e2e:fit:image', 'e2e:fit:video', 'e2e:fit:audio', 'e2e:fit:text']) {
    const node = page.locator(`.vue-flow__node[data-id="${id}"]`)
    await node.click()

    const editor = page.locator('.node-expanded-editor')
    await expect(editor).toBeVisible()
    const [nodeBox, editorBox, footerBox, layout] = await Promise.all([
      node.locator('.home-canvas-node').boundingBox(),
      editor.boundingBox(),
      editor.locator('.editor-footer').boundingBox(),
      editor.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          clientHeight: element.clientHeight,
          clientWidth: element.clientWidth,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          scrollHeight: element.scrollHeight,
          scrollWidth: element.scrollWidth,
        }
      }),
    ])

    expect(nodeBox).not.toBeNull()
    expect(editorBox).not.toBeNull()
    expect(footerBox).not.toBeNull()
    expect(editorBox.x).toBeGreaterThanOrEqual(0)
    expect(editorBox.y).toBeGreaterThanOrEqual(0)
    expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(viewport.width)
    expect(editorBox.y + editorBox.height).toBeLessThanOrEqual(viewport.height)
    expect(layout.scrollHeight).toBeLessThanOrEqual(layout.clientHeight + 1)
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1)
    expect(layout.overflowX).not.toMatch(/^(auto|scroll)$/)
    expect(layout.overflowY).not.toMatch(/^(auto|scroll)$/)
    expect(footerBox.y).toBeGreaterThanOrEqual(editorBox.y)
    expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(editorBox.y + editorBox.height + 1)
    await expect(editor).toHaveAttribute('data-editor-dock', 'bottom')
    expect(Math.abs((editorBox.y - nodeBox.y - nodeBox.height) - 12)).toBeLessThan(5)
  }
})

test('视频提示词输入 @ 不会列出未连线的图片节点', async ({ page }) => {
  await loadHomeCanvasState(page, mentionHomeCanvasState)

  const videoNode = page.locator('.vue-flow__node[data-id="e2e:video-target"]')
  await videoNode.click()
  const promptInput = page.getByRole('textbox', { name: '生成提示词' })
  await promptInput.fill('女主角走入画面 @')

  const mentionMenu = page.getByLabel('@选择参考图')
  await expect(mentionMenu).toBeVisible()
  await expect(mentionMenu.getByText('没有可引用的图片节点')).toBeVisible()
  await expect(mentionMenu.getByRole('button', { name: '女主角定妆照' })).toHaveCount(0)
  await expect(page.locator('.vue-flow__edge')).toHaveCount(0)
})

test('视频节点三张已连接参考图按序显示并插入带序号的 @ 引用', async ({ page }) => {
  await loadHomeCanvasState(page, numberedMentionHomeCanvasState)

  const videoNode = page.locator('.vue-flow__node[data-id="e2e:video-target"]')
  await videoNode.click()
  await page.getByRole('button', { name: '全屏编辑' }).click()
  const promptInput = page.getByRole('textbox', { name: '生成提示词' })
  await promptInput.fill('沿用参考角色 @')

  const mentionMenu = page.getByLabel('@选择参考图')
  await expect(mentionMenu).toBeVisible()
  const candidates = mentionMenu.getByRole('button')
  await expect(candidates).toHaveCount(3)
  await expect(candidates.nth(0)).toHaveAccessibleName('图片1')
  await expect(candidates.nth(1)).toHaveAccessibleName('图片2')
  await expect(candidates.nth(2)).toHaveAccessibleName('图片3')
  await mentionMenu.getByRole('button', { name: '图片3' }).click()

  await expect(promptInput).toHaveValue('沿用参考角色 @图片3 ')
  await expect(page.locator('.vue-flow__edge')).toHaveCount(3)
})

test('生成结果数组中的图片可被 @ 引用并支持双击全屏预览', async ({ page }) => {
  const connectedGeneratedState = {
    ...generatedMentionHomeCanvasState,
    edges: [{
      id: 'e2e:generated-image-reference-to-video',
      source: 'e2e:image-reference',
      target: 'e2e:video-target',
      type: 'smoothstep',
    }],
  }
  await loadHomeCanvasState(page, connectedGeneratedState)

  await expect.poll(async () => page.evaluate((storageKey) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}')
    return state.nodes?.find((node) => node.id === 'e2e:image-reference')?.data?.resultUrls?.[0] || ''
  }, homeCanvasStorageKey)).toMatch(/^data:image\//)

  const imageNode = page.locator('.vue-flow__node[data-id="e2e:image-reference"]')
  await imageNode.locator('.node-media').dblclick()
  await expect(page.getByRole('dialog', { name: '图片全屏预览' })).toBeVisible()
  await page.getByRole('button', { name: '关闭图片预览' }).click()
  await page.getByRole('button', { name: '关闭编辑器' }).click()
  await expect(page.locator('.node-expanded-editor')).toHaveCount(0)
  await imageNode.locator('.node-media').click()
  await expect(page.locator('.node-expanded-editor')).toBeVisible()

  const videoNode = page.locator('.vue-flow__node[data-id="e2e:video-target"]')
  await videoNode.click()
  await page.getByRole('textbox', { name: '生成提示词' }).fill('@')
  const mentionMenu = page.getByLabel('@选择参考图')
  await expect(mentionMenu.locator('img')).toHaveAttribute('src', /data:image/)
})

test('已连接参考图可以从节点编辑器取消', async ({ page }) => {
  const connectedState = {
    ...mentionHomeCanvasState,
    edges: [{
      id: 'e2e:image-reference-to-video',
      source: 'e2e:image-reference',
      target: 'e2e:video-target',
      type: 'smoothstep',
      data: {
        contract: { slot: 'reference-image', enabled: true, order: 0, weight: 1 },
      },
    }],
  }
  await loadHomeCanvasState(page, connectedState)

  await page.locator('.vue-flow__node[data-id="e2e:video-target"]').click()
  await page.getByRole('button', { name: '取消参考图' }).click()
  await expect(page.locator('.vue-flow__edge')).toHaveCount(0)
  await expect.poll(async () => page.evaluate((storageKey) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}')
    return state.edges?.length || 0
  }, homeCanvasStorageKey)).toBe(0)
})

test('视频节点展示参考模式与图片序列，并将模式切换写回画布', async ({ page }) => {
  const connectedState = {
    ...mentionHomeCanvasState,
    edges: [{
      id: 'e2e:image-reference-to-video',
      source: 'e2e:image-reference',
      target: 'e2e:video-target',
      type: 'smoothstep',
      data: {
        contract: { input: 'reference-image', enabled: true, order: 0, weight: 1 },
      },
    }],
  }
  await loadHomeCanvasState(page, connectedState)

  await page.locator('.vue-flow__node[data-id="e2e:video-target"]').click()
  const editor = page.getByRole('region', { name: '视频节点编辑器' })
  await expect(editor.getByRole('tab', { name: '多图参考' })).toHaveAttribute('aria-selected', 'true')
  await expect(editor.locator('.reference-card figcaption')).toHaveText('图片1')
  await expect(editor.getByRole('tab', { name: '动作模仿' })).toBeDisabled()
  await expect(editor.getByRole('tab', { name: '全能参考' })).toBeEnabled()
  await expect(editor.getByRole('tab', { name: '视频编辑' })).toBeDisabled()

  const promptInput = editor.getByRole('textbox', { name: '生成提示词' })
  await promptInput.focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await editor.locator('.reference-card').click({ button: 'right' })
  await expect(promptInput).toHaveValue('女主角 @图片1 走入画面 ')
  await expect.poll(async () => page.evaluate((storageKey) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}')
    return state.nodes?.find((node) => node.id === 'e2e:video-target')?.data?.content || ''
  }, homeCanvasStorageKey)).toContain('@图片1')

  await editor.getByRole('tab', { name: '首尾帧' }).click()
  await expect(editor.getByRole('tab', { name: '首尾帧' })).toHaveAttribute('aria-selected', 'true')
  await expect(editor.locator('.first-last-frame-slot')).toHaveCount(2)
  await expect(editor.locator('[data-frame-slot="first"] figcaption')).toHaveText('首帧 · 图片1')
  await expect(editor.locator('[data-frame-slot="last"] figcaption')).toHaveText('尾帧 · 未设置')
  await expect.poll(async () => page.evaluate((storageKey) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}')
    return state.edges?.[0]?.data?.contract?.input || ''
  }, homeCanvasStorageKey)).toBe('first-frame')

  await editor.getByRole('tab', { name: '多图参考' }).click()
  await expect.poll(async () => page.evaluate((storageKey) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}')
    return state.edges?.[0]?.data?.contract?.input || ''
  }, homeCanvasStorageKey)).toBe('reference-image')
})

test('视频节点无参考图时保存首尾帧模式，并在新增两张参考图后恢复首尾帧槽位', async ({ page }) => {
  await loadHomeCanvasState(page, mentionHomeCanvasState)

  await page.locator('.vue-flow__node[data-id="e2e:video-target"]').click()
  let editor = page.getByRole('region', { name: '视频节点编辑器' })
  await editor.getByRole('tab', { name: '首尾帧' }).click()
  await expect(editor.getByRole('tab', { name: '首尾帧' })).toHaveAttribute('aria-selected', 'true')
  await expect(editor.locator('.first-last-frame-slot')).toHaveCount(2)
  await expect(editor.locator('[data-frame-slot="first"] figcaption')).toHaveText('首帧 · 未设置')
  await expect(editor.locator('[data-frame-slot="last"] figcaption')).toHaveText('尾帧 · 未设置')
  await expect.poll(async () => page.evaluate((storageKey) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}')
    return state.nodes?.find((node) => node.id === 'e2e:video-target')?.data?.videoReferenceMode || ''
  }, homeCanvasStorageKey)).toBe('first-last')

  const firstLastState = {
    ...mentionHomeCanvasState,
    nodes: [
      ...mentionHomeCanvasState.nodes.map((node) => (
        node.id === 'e2e:video-target'
          ? { ...node, data: { ...node.data, videoReferenceMode: 'first-last' } }
          : node
      )),
      {
        id: 'e2e:image-reference-last',
        type: 'homeCanvasNode',
        position: { x: 360, y: 720 },
        data: {
          kind: 'image',
          title: '尾帧参考图',
          content: '',
          url: referenceImageDataUrls[1],
        },
      },
    ],
    edges: [
      {
        id: 'e2e:first-reference-to-video',
        source: 'e2e:image-reference',
        target: 'e2e:video-target',
        type: 'smoothstep',
        data: { contract: { input: 'reference-image', enabled: true, order: 0, weight: 1 } },
      },
      {
        id: 'e2e:last-reference-to-video',
        source: 'e2e:image-reference-last',
        target: 'e2e:video-target',
        type: 'smoothstep',
        data: { contract: { input: 'reference-image', enabled: true, order: 1, weight: 1 } },
      },
    ],
  }
  await loadHomeCanvasState(page, firstLastState)
  await page.locator('.vue-flow__node[data-id="e2e:video-target"]').click()
  editor = page.getByRole('region', { name: '视频节点编辑器' })
  await expect(editor.getByRole('tab', { name: '首尾帧' })).toHaveAttribute('aria-selected', 'true')
  await expect(editor.locator('.first-last-frame-slot')).toHaveCount(2)
  await expect(editor.locator('[data-frame-slot="first"] img')).toHaveCount(1)
  await expect(editor.locator('[data-frame-slot="last"] img')).toHaveCount(1)
  await expect(editor.locator('[data-frame-slot="first"] figcaption')).toHaveText('首帧 · 图片1')
  await expect(editor.locator('[data-frame-slot="last"] figcaption')).toHaveText('尾帧 · 图片2')
  await expect.poll(async () => page.evaluate((storageKey) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}')
    return state.edges?.map((edge) => edge.data?.contract?.input).join(',') || ''
  }, homeCanvasStorageKey)).toBe('first-frame,last-frame')
})

test('选中节点后按 Delete 删除，编辑输入时不会误删', async ({ page }) => {
  const seedNode = page.locator('.vue-flow__node[data-id="e2e:seed"]')
  await seedNode.locator('.node-icon').click()
  const editor = page.locator('.node-expanded-editor')
  await expect(editor).toBeVisible()

  const contentInput = editor.getByRole('textbox', { name: '文本内容' })
  await contentInput.click()
  await page.keyboard.press('Delete')
  await expect(seedNode).toHaveCount(1)

  await seedNode.locator('.node-icon').click()
  await page.keyboard.press('Delete')
  await expect(seedNode).toHaveCount(0)
})

test('普通单击只保留一个选中节点，选中连线后可按 Delete 删除', async ({ page }) => {
  await loadHomeCanvasState(page, edgeHomeCanvasState)

  await page.locator('.vue-flow__node[data-id="e2e:source"]').click()
  await page.locator('.vue-flow__node[data-id="e2e:target-a"]').click()
  await expect(page.locator('.vue-flow__node.selected')).toHaveCount(1)
  await expect(page.locator('.vue-flow__node[data-id="e2e:target-a"]')).toHaveClass(/selected/)

  const edge = page.locator('.vue-flow__edge[data-id="e2e:edge"]')
  const edgePoint = await edge.locator('.vue-flow__edge-path').evaluate((path) => {
    const point = path.getPointAtLength(path.getTotalLength() * 0.2)
    const screenPoint = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM())
    return { x: screenPoint.x, y: screenPoint.y }
  })
  await page.mouse.click(edgePoint.x, edgePoint.y)
  await expect(edge).toHaveClass(/selected/)
  await page.keyboard.press('Delete')
  await expect(edge).toHaveCount(0)
  await expect.poll(async () => page.evaluate((storageKey) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}')
    return state.edges?.length || 0
  }, homeCanvasStorageKey)).toBe(0)
})

test('右键添加文本节点并支持删除、撤销和重做', async ({ page }) => {
  const canvas = page.locator('.canvas-main')

  await canvas.click({ button: 'right', position: { x: 1100, y: 700 } })
  await expect(page.getByText('在此添加')).toBeVisible()
  await page.getByRole('button', { name: '文本节点' }).click()

  await expect(page.getByRole('dialog')).toHaveCount(0)
  const createdNode = page.locator('.vue-flow__node.selected')
  const editor = page.locator('.node-expanded-editor')
  await expect(createdNode).toHaveCount(1)
  await createdNode.getByRole('textbox', { name: '节点标题' }).fill('E2E 回归节点')
  await editor.getByRole('textbox', { name: '文本内容' }).fill('验证首页自由画布关键交互')
  await editor.getByRole('textbox', { name: '文本内容' }).blur()
  await expect(page.getByText('E2E 回归节点')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  await page.keyboard.press('Delete')
  await expect(page.getByText('E2E 回归节点')).toHaveCount(0)
  await expect(page.getByLabel('画布历史操作').getByRole('button', { name: '撤销' })).toBeEnabled()

  await page.keyboard.press('Control+z')
  await expect(page.getByText('E2E 回归节点')).toBeVisible()
  await page.keyboard.press('Control+Shift+z')
  await expect(page.getByText('E2E 回归节点')).toHaveCount(0)
})

test('复制粘贴选中节点会生成带偏移的副本', async ({ page }) => {
  const seedNode = page.locator('.vue-flow__node').filter({ hasText: 'E2E 种子节点' })

  await seedNode.locator('.node-icon').click()
  await expect(seedNode).toHaveClass(/selected/)
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')

  const pastedTitles = page.getByRole('textbox', { name: '节点标题' })
  await expect(pastedTitles).toHaveCount(2)
  await expect.poll(async () => page.evaluate((storageKey) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}')
    return state.nodes?.map((node) => [node.position.x, node.position.y]) || []
  }, homeCanvasStorageKey)).toEqual([[600, 500], [640, 540]])
  await expect.poll(async () => page.evaluate((storageKey) => {
    const state = JSON.parse(window.localStorage.getItem(storageKey) || '{}')
    return state.nodes?.length || 0
  }, homeCanvasStorageKey)).toBe(2)
})

test('本地画布右键节点可复制删除，媒体节点不展示无效运行入口', async ({ page }) => {
  const canvas = page.locator('.canvas-main')
  await canvas.click({ button: 'right', position: { x: 1080, y: 680 } })
  await expect(page.getByRole('button', { name: '音频节点' })).toBeVisible()
  await page.getByRole('button', { name: '图片节点' }).click()

  const imageNode = page.locator('.vue-flow__node.selected')
  const editor = page.locator('.node-expanded-editor')
  await expect(editor).toContainText('本地草稿仅保存内容')
  await expect(editor.getByRole('button', { name: '上传' })).toHaveCount(0)
  await expect(editor.getByRole('button', { name: '生成' })).toHaveCount(0)
  await expect(editor.getByRole('button', { name: '配置' })).toHaveCount(0)

  await imageNode.click({ button: 'right' })
  await expect(page.getByText(/节点操作 · 图片/)).toBeVisible()
  await page.getByRole('button', { name: '复制节点' }).click()
  await expect(page.getByRole('textbox', { name: '节点标题' })).toHaveCount(3)
  const duplicate = page.locator('.vue-flow__node.selected')
  await expect(duplicate.getByRole('textbox', { name: '节点标题' })).toHaveValue('图片 副本')

  await duplicate.click({ button: 'right' })
  await page.locator('.home-context-menu').getByRole('button', { name: '删除节点' }).click()
  await expect(page.getByRole('textbox', { name: '节点标题' })).toHaveCount(2)
})

test('拖动边目标端点会更新连接目标并持久化', async ({ page }) => {
  await loadHomeCanvasState(page, edgeHomeCanvasState)

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

test('按住 Space 配合鼠标左键拖动画布', async ({ page }) => {
  const pane = page.locator('.vue-flow__pane')
  const viewport = page.locator('.vue-flow__transformationpane')
  const initialTransform = await viewport.evaluate((element) => element.style.transform)
  const paneBox = await pane.boundingBox()
  expect(paneBox).not.toBeNull()

  const start = { x: paneBox.x + 120, y: paneBox.y + 120 }
  await page.keyboard.down('Space')
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 140, start.y + 90, { steps: 8 })
  await page.mouse.up()
  await page.keyboard.up('Space')

  await expect.poll(() => viewport.evaluate((element) => element.style.transform)).not.toBe(initialTransform)
})
