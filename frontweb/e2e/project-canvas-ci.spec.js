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
let savedCanvasLayout = null
let savedWorkflowGroups = []
let mockDrama = null
let nextStoryboardId = 2001
let createdStoryboardPayloads = []
let updatedStoryboardPayloads = []
let boundVoicePayloads = []

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
  await page.addInitScript(() => {
    window.localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'canvas-e2e-session',
      user: { id: 'canvas-e2e-user', email: 'canvas-e2e@example.com', role: 'user' },
    }))
  })
  mockAssets = []
  createdAssetPayload = null
  updatedAssetPayloads = []
  savedCanvasLayout = null
  savedWorkflowGroups = []
  mockDrama = JSON.parse(JSON.stringify(drama))
  nextStoryboardId = 2001
  createdStoryboardPayloads = []
  updatedStoryboardPayloads = []
  boundVoicePayloads = []

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url

    if (request.method() === 'GET' && pathname === '/api/v1/dramas/3') {
      await route.fulfill(apiData({
        ...mockDrama,
        metadata: {
          ...mockDrama.metadata,
          ...(savedCanvasLayout ? { canvas_layout: savedCanvasLayout } : {}),
          workflow_groups: savedWorkflowGroups,
        },
      }))
      return
    }
    if (request.method() === 'GET' && pathname === '/api/v1/assets') {
      await route.fulfill(apiData({ items: mockAssets }))
      return
    }
    if (request.method() === 'GET' && pathname === '/api/v1/storyboards/1001') {
      await route.fulfill(apiData(mockDrama.episodes[0].storyboards[0]))
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
    if (request.method() === 'GET' && pathname === '/api/v1/voice-catalog') {
      await route.fulfill(apiData({
        items: [
          {
            id: 'xiaomo-fixed-voice',
            label: '小茉固定音色',
            preview_url: '/static/e2e-xiaomo-voice.mp3',
            language: 'zh-CN',
            available: true,
          },
        ],
      }))
      return
    }
    if (request.method() === 'GET' && ['/api/v1/character-library', '/api/v1/prop-library'].includes(pathname)) {
      await route.fulfill(apiData({ items: [] }))
      return
    }
    if (request.method() === 'POST' && pathname === '/api/v1/storyboards') {
      const payload = request.postDataJSON() || {}
      createdStoryboardPayloads.push(payload)
      const storyboard = {
        id: nextStoryboardId++,
        status: 'pending',
        characters: [],
        prop_ids: [],
        ...payload,
      }
      const episode = mockDrama.episodes.find((item) => Number(item.id) === Number(payload.episode_id))
      episode?.storyboards?.push(storyboard)
      await route.fulfill(apiData(storyboard))
      return
    }
    if (request.method() === 'PUT' && pathname === '/api/v1/storyboards/1001') {
      const payload = request.postDataJSON() || {}
      updatedStoryboardPayloads.push(payload)
      Object.assign(mockDrama.episodes[0].storyboards[0], payload)
      await route.fulfill(apiData(mockDrama.episodes[0].storyboards[0]))
      return
    }
    if (request.method() === 'POST' && pathname === '/api/v1/characters/11/sd2-voice-catalog') {
      const payload = request.postDataJSON() || {}
      boundVoicePayloads.push(payload)
      Object.assign(mockDrama.characters[0], {
        voice_catalog_id: payload.voice_id,
        sd2_voice_catalog_id: payload.voice_id,
      })
      await route.fulfill(apiData(mockDrama.characters[0]))
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
    if (request.method() === 'POST' && pathname === '/api/v1/upload/media') {
      const formBody = request.postDataBuffer()?.toString('utf8') || ''
      const type = formBody.includes('video/mp4') ? 'video' : 'image'
      const asset = {
        id: 902 + mockAssets.length,
        drama_id: 3,
        name: type === 'video' ? '项目视频.mp4' : '项目图片.png',
        type,
        url: type === 'video'
          ? 'data:video/mp4;base64,AAAA'
          : 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22120%22%3E%3Crect width=%22200%22 height=%22120%22 fill=%22%23f27645%22/%3E%3C/svg%3E',
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
      const payload = request.postDataJSON() || {}
      if (payload.canvas_layout) savedCanvasLayout = payload.canvas_layout
      if (Array.isArray(payload.workflow_groups)) savedWorkflowGroups = payload.workflow_groups
      await route.fulfill(apiData({
        ...mockDrama,
        metadata: {
          ...mockDrama.metadata,
          ...(savedCanvasLayout ? { canvas_layout: savedCanvasLayout } : {}),
          workflow_groups: savedWorkflowGroups,
        },
      }))
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

test('项目画布拖入本地图片和视频后创建对应项目素材节点', async ({ page }) => {
  await page.goto('/film/3/canvas')
  const acceptsSystemFiles = await page.locator('.canvas-main').evaluate((canvas) => {
    const protectedDragOver = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(protectedDragOver, 'dataTransfer', {
      value: {
        files: [],
        items: [{ kind: 'file', type: 'image/png' }],
        types: ['Files'],
      },
    })
    const accepted = canvas.dispatchEvent(protectedDragOver) === false
    if (!accepted) return false

    const transfer = new DataTransfer()
    transfer.items.add(new File(['image'], '项目图片.png', { type: 'image/png' }))
    transfer.items.add(new File(['video'], '项目视频.mp4', { type: 'video/mp4' }))
    const rect = canvas.getBoundingClientRect()
    canvas.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }))
    return true
  })
  expect(acceptsSystemFiles).toBe(true)

  await expect.poll(() => mockAssets.map((asset) => asset.type).sort()).toEqual(['image', 'video'])
  const assetNodes = page.locator('.vue-flow__node[data-id^="project-asset:"]')
  await expect(assetNodes).toHaveCount(2)
  await expect(assetNodes.filter({ hasText: '项目图片.png' }).getByAltText('项目图片.png')).toHaveAttribute('src', /^data:image\//)
  await expect(assetNodes.filter({ hasText: '项目视频.mp4' }).locator('video.asset-media')).toHaveAttribute('src', /^data:video\//)
  await expect.poll(() => Object.keys(savedCanvasLayout?.nodes || {}).filter((id) => id.startsWith('project-asset:')).length).toBe(2)
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

  await canvas.hover({ position: { x: 700, y: 420 } })
  const initialWheelState = await viewport.evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    return { y: matrix.m42, zoom: matrix.a }
  })
  await page.mouse.wheel(0, 240)
  await expect.poll(() => viewport.evaluate((element) => (
    new DOMMatrixReadOnly(getComputedStyle(element).transform).m42
  ))).not.toBe(initialWheelState.y)
  const defaultWheelState = await viewport.evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    return { zoom: matrix.a }
  })
  expect(defaultWheelState.zoom).toBeCloseTo(initialWheelState.zoom, 5)

  const initialTransform = await viewport.evaluate((element) => element.style.transform)
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

test('项目画布持久化节点拖拽、手工连线和工作流分组并在刷新后恢复', async ({ page }) => {
  await page.goto('/film/3/canvas')

  const storyboardNode = page.locator('.vue-flow__node[data-id="sb:1001"]')
  await expect(storyboardNode).toBeVisible()
  await storyboardNode.dragTo(page.locator('.vue-flow__pane'), {
    sourcePosition: { x: 18, y: 18 },
    targetPosition: { x: 1080, y: 620 },
  })

  await expect.poll(() => savedCanvasLayout?.nodes?.['sb:1001']).toEqual(expect.objectContaining({
    x: expect.any(Number),
    y: expect.any(Number),
  }))
  const savedStoryboardPosition = { ...savedCanvasLayout.nodes['sb:1001'] }

  const sourceHandle = page.locator('.vue-flow__node[data-id="sbimg:1001"] .vue-flow__handle.source')
  const targetHandle = page.locator('.vue-flow__node[data-id="sbtxt:1001"] .vue-flow__handle.target')
  await expect(sourceHandle).toBeVisible()
  await expect(targetHandle).toBeVisible()
  const sourceBox = await sourceHandle.boundingBox()
  const targetBox = await targetHandle.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 16 })
  await page.mouse.up()

  await expect.poll(() => savedCanvasLayout?.manual_edges || []).toContainEqual(expect.objectContaining({
    source: 'sbimg:1001',
    target: 'sbtxt:1001',
    data: expect.objectContaining({
      manual: true,
      contract: expect.objectContaining({ order: 1 }),
    }),
  }))

  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+g')
  const groupDialog = page.getByRole('dialog', { name: '创建工作流' })
  await expect(groupDialog).toBeVisible()
  await groupDialog.getByRole('textbox').fill('E2E 连贯工作流')
  await groupDialog.getByRole('button', { name: '创建', exact: true }).click()

  await expect.poll(() => savedWorkflowGroups).toContainEqual(expect.objectContaining({
    title: 'E2E 连贯工作流',
    storyboard_ids: [1001],
  }))
  await expect(storyboardNode).toContainText('E2E 连贯工作流')

  await page.reload()

  const restoredStoryboardNode = page.locator('.vue-flow__node[data-id="sb:1001"]')
  await expect(restoredStoryboardNode).toContainText('E2E 连贯工作流')
  await expect.poll(async () => {
    const transform = await restoredStoryboardNode.evaluate((element) => element.style.transform)
    const match = transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)
    if (!match) return Number.POSITIVE_INFINITY
    return Math.max(
      Math.abs(Number(match[1]) - savedStoryboardPosition.x),
      Math.abs(Number(match[2]) - savedStoryboardPosition.y),
    )
  }).toBeLessThanOrEqual(5)
  await expect(page.locator('.vue-flow__edge[data-id^="manual:sbimg:1001:"]')).toBeAttached()
})

test('项目画布通过节点右键菜单复制、追加和插入分镜并持久化重连', async ({ page }) => {
  await page.goto('/film/3/canvas')

  const sourceNode = page.locator('.vue-flow__node[data-id="sb:1001"]')
  await expect(sourceNode).toBeVisible()

  await sourceNode.click({ button: 'right', position: { x: 24, y: 24 } })
  let menu = page.getByRole('menu', { name: '节点操作' })
  await menu.getByRole('menuitem', { name: /复制分镜/ }).click()

  await expect.poll(() => createdStoryboardPayloads).toContainEqual(expect.objectContaining({
    episode_id: 101,
    storyboard_number: 2,
    title: '雨夜相遇 副本',
  }))
  await expect(page.locator('.vue-flow__node[data-id="sb:2001"]')).toContainText('雨夜相遇 副本')
  await expect.poll(() => savedCanvasLayout?.nodes?.['sb:2001']).toEqual(expect.objectContaining({
    x: expect.any(Number),
    y: expect.any(Number),
  }))

  await sourceNode.click({ button: 'right', position: { x: 24, y: 24 } })
  menu = page.getByRole('menu', { name: '节点操作' })
  await menu.getByRole('menuitem', { name: /追加下游分镜/ }).click()

  await expect.poll(() => createdStoryboardPayloads).toContainEqual(expect.objectContaining({
    episode_id: 101,
    storyboard_number: 3,
    title: '下游分镜 3',
  }))
  await expect(page.locator('.vue-flow__node[data-id="sb:2002"]')).toContainText('下游分镜 3')
  await expect.poll(() => savedCanvasLayout?.manual_edges || []).toContainEqual(expect.objectContaining({
    source: 'sb:1001',
    target: 'sb:2002',
    data: { manual: true },
  }))

  await sourceNode.click({ button: 'right', position: { x: 24, y: 24 } })
  menu = page.getByRole('menu', { name: '节点操作' })
  await menu.getByRole('menuitem', { name: /插入下游分镜/ }).click()

  await expect.poll(() => createdStoryboardPayloads).toContainEqual(expect.objectContaining({
    episode_id: 101,
    storyboard_number: 4,
    title: '插入分镜 4',
  }))
  await expect(page.locator('.vue-flow__node[data-id="sb:2003"]')).toContainText('插入分镜 4')
  await expect.poll(() => savedCanvasLayout?.manual_edges || []).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: 'sb:1001', target: 'sb:2003', data: { manual: true } }),
    expect.objectContaining({ source: 'sb:2003', target: 'sb:2002', data: { manual: true } }),
  ]))
  expect(savedCanvasLayout.manual_edges).not.toContainEqual(expect.objectContaining({
    source: 'sb:1001',
    target: 'sb:2002',
  }))

  await page.reload()

  await expect(page.locator('.vue-flow__node[data-id="sb:2001"]')).toContainText('雨夜相遇 副本')
  await expect(page.locator('.vue-flow__node[data-id="sb:2002"]')).toContainText('下游分镜 3')
  await expect(page.locator('.vue-flow__node[data-id="sb:2003"]')).toContainText('插入分镜 4')
  await expect(page.locator('.vue-flow__edge[data-id^="manual:sb:1001:"][data-id$=":sb:2003:in"]')).toBeAttached()
  await expect(page.locator('.vue-flow__edge[data-id^="manual:sb:2003:"][data-id$=":sb:2002:in"]')).toBeAttached()
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

test('项目画布选择音色后绑定唯一角色并在刷新后恢复', async ({ page }) => {
  await page.goto('/film/3/canvas')

  const storyboardNode = page.locator('.vue-flow__node[data-id="sb:1001"]')
  await storyboardNode.click()

  const panel = page.locator('.canvas-node-panel.sb-panel')
  await panel.getByRole('button', { name: '+素材库', exact: true }).click()
  await page.getByRole('menuitem', { name: '设为分镜音频', exact: true }).click()

  const picker = page.getByRole('dialog', { name: '从素材库选择分镜音频' })
  await expect(picker).toBeVisible()
  const voiceCard = picker.locator('.picker-card').filter({ hasText: '小茉固定音色' })
  await expect(voiceCard).toContainText('音色库')
  await voiceCard.getByRole('button', { name: '选用', exact: true }).click()
  await expect(picker).toBeHidden()

  await expect.poll(() => updatedStoryboardPayloads).toContainEqual(expect.objectContaining({
    audio_url: '/static/e2e-xiaomo-voice.mp3',
  }))
  await expect.poll(() => createdAssetPayload).toMatchObject({
    drama_id: 3,
    storyboard_id: 1001,
    type: 'audio',
    category: 'voice',
    name: '小茉固定音色',
    url: '/static/e2e-xiaomo-voice.mp3',
    metadata: {
      attached_slot: 'audio',
      attached_storyboard_id: 1001,
      voice_catalog_id: 'xiaomo-fixed-voice',
    },
  })
  await expect.poll(() => boundVoicePayloads).toEqual([
    { voice_id: 'xiaomo-fixed-voice' },
  ])
  await expect(page.locator('.el-message__content').filter({
    hasText: '已将音色设为本镜音频并绑定分镜角色',
  })).toBeVisible()

  await page.reload()

  const restoredStoryboardNode = page.locator('.vue-flow__node[data-id="sb:1001"]')
  await expect(restoredStoryboardNode).toContainText('音频')
  await restoredStoryboardNode.click()
  const restoredPanel = page.locator('.canvas-node-panel.sb-panel')
  await expect(restoredPanel.locator('.reference-chip').filter({ hasText: '小茉固定音色' })).toBeVisible()
  expect(mockDrama.episodes[0].storyboards[0].audio_url).toBe('/static/e2e-xiaomo-voice.mp3')
  expect(mockDrama.characters[0].voice_catalog_id).toBe('xiaomo-fixed-voice')
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
