import { test, expect } from '@playwright/test'

const homeCanvasStorageKey = 'moli-mama.home-canvas.v1'
const pendingHomeCanvasStateKey = 'moli-mama.e2e.pending-home-canvas-state'
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
        url: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22120%22%3E%3Crect width=%22200%22 height=%22120%22 fill=%22%23f27645%22/%3E%3C/svg%3E',
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

test('节点编辑器显示在节点下方、随节点拖动并支持提示词全屏编辑', async ({ page }) => {
  const seedNode = page.locator('.vue-flow__node[data-id="e2e:seed"]')
  await seedNode.locator('.node-icon').click()

  const editor = page.locator('.node-expanded-editor')
  const visualNode = seedNode.locator('.home-canvas-node')
  const nodeBefore = await visualNode.boundingBox()
  const editorBefore = await editor.boundingBox()
  expect(nodeBefore).not.toBeNull()
  expect(editorBefore).not.toBeNull()
  expect(editorBefore.y).toBeGreaterThanOrEqual(nodeBefore.y + nodeBefore.height - 2)

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
  expect(Math.abs((editorAfter.x - editorBefore.x) - (nodeAfter.x - nodeBefore.x))).toBeLessThan(3)
  expect(Math.abs((editorAfter.y - editorBefore.y) - (nodeAfter.y - nodeBefore.y))).toBeLessThan(3)

  await editor.getByRole('button', { name: '全屏编辑' }).click()
  await expect(editor).toHaveClass(/is-fullscreen/)
  const fullscreenInput = editor.getByRole('textbox', { name: '文本内容' })
  await expect.poll(() => fullscreenInput.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(450)

  await editor.getByRole('button', { name: '全屏编辑' }).click()
  await expect(editor).not.toHaveClass(/is-fullscreen/)
  const restoredNode = await visualNode.boundingBox()
  const restoredEditor = await editor.boundingBox()
  expect(restoredEditor.y).toBeGreaterThanOrEqual(restoredNode.y + restoredNode.height - 2)
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

test('视频节点已连接的图片仍可被 @ 引用且不会重复连线', async ({ page }) => {
  const connectedState = {
    ...mentionHomeCanvasState,
    edges: [{
      id: 'e2e:image-reference-to-video',
      source: 'e2e:image-reference',
      target: 'e2e:video-target',
      type: 'smoothstep',
    }],
  }
  await loadHomeCanvasState(page, connectedState)

  const videoNode = page.locator('.vue-flow__node[data-id="e2e:video-target"]')
  await videoNode.click()
  await page.getByRole('button', { name: '全屏编辑' }).click()
  const promptInput = page.getByRole('textbox', { name: '生成提示词' })
  await promptInput.fill('沿用参考角色 @')

  const mentionMenu = page.getByLabel('@选择参考图')
  await expect(mentionMenu).toBeVisible()
  await expect(mentionMenu.getByRole('button', { name: '女主角定妆照' })).toBeVisible()
  await mentionMenu.getByRole('button', { name: '女主角定妆照' }).click()

  await expect(promptInput).toHaveValue('沿用参考角色 @女主角定妆照 ')
  await expect(page.locator('.vue-flow__edge')).toHaveCount(1)
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
  await expect(editor.getByRole('tab', { name: '全能参考' })).toBeDisabled()
  await expect(editor.getByRole('tab', { name: '视频编辑' })).toBeDisabled()

  await editor.getByRole('tab', { name: '首尾帧' }).click()
  await expect(editor.getByRole('tab', { name: '首尾帧' })).toHaveAttribute('aria-selected', 'true')
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
  await edge.locator('.vue-flow__edge-path').click({ force: true })
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
