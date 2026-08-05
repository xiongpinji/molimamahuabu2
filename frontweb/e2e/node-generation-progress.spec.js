import { test, expect } from '@playwright/test'

const storageKey = 'moli-mama.home-canvas.v1'
const runningCanvasState = {
  version: 1,
  nodes: [
    {
      id: 'running:text',
      type: 'homeCanvasNode',
      position: { x: 120, y: 120 },
      data: { kind: 'text', title: '文本生成', content: '生成文本', status: 'running', generationActive: true, progress: 0, progressKnown: false },
    },
    {
      id: 'running:image',
      type: 'homeCanvasNode',
      position: { x: 560, y: 120 },
      data: { kind: 'image', title: '图片生成', content: '生成图片', status: 'running', generationActive: true, progress: 42, progressKnown: true },
    },
    {
      id: 'running:video',
      type: 'homeCanvasNode',
      position: { x: 120, y: 640 },
      data: { kind: 'video', title: '视频生成', content: '生成视频', status: 'running', generationActive: true, progress: 0, progressKnown: false },
    },
    {
      id: 'running:audio',
      type: 'homeCanvasNode',
      position: { x: 860, y: 640 },
      data: { kind: 'audio', title: '音频生成', content: '生成音频', status: 'running', generationActive: true, progress: 73, progressKnown: true },
    },
    {
      id: 'running:upload',
      type: 'homeCanvasNode',
      position: { x: 1300, y: 120 },
      data: { kind: 'image', title: '图片上传', content: '上传进行中', status: 'running', generationActive: false },
    },
    {
      id: 'running:translate',
      type: 'homeCanvasNode',
      position: { x: 1300, y: 640 },
      data: { kind: 'text', title: '文本翻译', content: '翻译进行中', status: 'running' },
    },
  ],
  edges: [],
  viewport: { x: 180, y: 160, zoom: 0.55 },
}

test('四类自由节点生成态显示旋转动画和真实或不定进度', async ({ page }, testInfo) => {
  await page.route('**/api/v1/dramas**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [], total: 0 }),
  }))
  await page.addInitScript(({ key, state }) => {
    window.localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'node-progress-e2e',
      user: { id: 'node-progress-e2e', email: 'node-progress@example.com', role: 'user' },
    }))
    window.localStorage.setItem(key, JSON.stringify(state))
  }, { key: storageKey, state: runningCanvasState })

  await page.goto('/canvas/local')

  for (const id of ['running:text', 'running:image', 'running:video', 'running:audio']) {
    const state = page.locator(`.vue-flow__node[data-id="${id}"] .node-generation-state`)
    await expect(state).toBeVisible()
    await expect(state.locator('.node-generation-spinner')).toBeVisible()
    await expect.poll(() => state.locator('.node-generation-spinner').evaluate((element) => getComputedStyle(element).animationName)).toMatch(/^generation-spin/)
  }

  for (const [id, progress] of [['running:image', '42'], ['running:audio', '73']]) {
    const state = page.locator(`.vue-flow__node[data-id="${id}"] .node-generation-state`)
    await expect(state).toHaveAttribute('aria-valuenow', progress)
    await expect(state.locator('strong')).toHaveText(`${progress}%`)
    await expect(state.locator('.node-generation-progress-track')).not.toHaveClass(/is-indeterminate/)
  }

  for (const id of ['running:text', 'running:video']) {
    const state = page.locator(`.vue-flow__node[data-id="${id}"] .node-generation-state`)
    await expect(state).not.toHaveAttribute('aria-valuenow', /.+/)
    await expect(state.locator('strong')).toHaveCount(0)
    await expect(state.locator('.node-generation-progress-track')).toHaveClass(/is-indeterminate/)
    await expect.poll(() => state.locator('.node-generation-progress-track i').evaluate((element) => getComputedStyle(element).animationName)).toMatch(/^generation-progress-slide/)
  }

  for (const id of ['running:upload', 'running:translate']) {
    const node = page.locator(`.vue-flow__node[data-id="${id}"]`)
    await expect(node.locator('.node-generation-state')).toHaveCount(0)
    await node.click({ force: true })
    const editor = page.locator('.node-expanded-editor')
    await expect(editor).toBeVisible()
    await expect(editor.locator('.generation-progress')).toHaveCount(0)
    await expect(editor.locator('.run-spinner')).toHaveCount(0)
  }

  await page.screenshot({ path: testInfo.outputPath('node-generation-progress.png'), fullPage: true })
})

test('项目画布节点覆盖层显示真实或不定生成进度', async ({ page }) => {
  const projectId = 48
  await page.addInitScript(({ statusKey }) => {
    window.localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'project-node-progress-e2e',
      user: { id: 'project-node-progress-e2e', email: 'project-progress@example.com', role: 'user' },
    }))
    window.localStorage.setItem(statusKey, JSON.stringify({
      'sb:481': { step: 'image', message: '图片生成中', progress: 42, at: Date.now() },
      'sb:482': { step: 'video', message: '视频生成中', at: Date.now() },
      'sb:483': { step: 'prompt', message: '角色提示词生成中', at: Date.now() },
    }))
  }, { statusKey: `moli_canvas_node_status:${projectId}` })

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === `/api/v1/dramas/${projectId}` && request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            id: projectId,
            title: '项目节点进度验证',
            metadata: {
              project_type: 'canvas',
              canvas_layout: {
                version: 1,
                viewport: { x: 0, y: 0, zoom: 0.65 },
                nodes: {},
                manual_edges: [],
                free_nodes: [{
                  id: 'project-running:image',
                  type: 'homeCanvasNode',
                  position: { x: 1040, y: 160 },
                  data: {
                    kind: 'image',
                    title: '编辑框动画节点',
                    content: '验证运行按钮旋转动画',
                    status: 'running',
                    generationActive: true,
                    progress: 42,
                    progressKnown: true,
                  },
                }],
              },
            },
            characters: [],
            scenes: [],
            props: [],
            episodes: [{
              id: 480,
              episode_number: 1,
              title: '第一集',
              script_content: '测试内容',
              storyboards: [
                { id: 481, episode_id: 480, storyboard_number: 1, title: '真实进度节点', description: '图片生成', status: 'pending' },
                { id: 482, episode_id: 480, storyboard_number: 2, title: '不定进度节点', description: '视频生成', status: 'pending' },
                { id: 483, episode_id: 480, storyboard_number: 3, title: '提示词生成节点', description: '角色提示词生成', status: 'pending' },
              ],
            }],
          },
        }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { items: [], total: 0 } }),
    })
  })

  await page.goto(`/film/${projectId}/canvas`)

  const actual = page.locator('.vue-flow__node[data-id="sb:481"] .status-progress')
  await expect(actual).toBeVisible()
  await expect(actual).toHaveAttribute('aria-valuenow', '42')
  await expect(actual.locator('strong')).toHaveText('42%')
  await expect(actual.locator('.status-progress-track')).not.toHaveClass(/is-indeterminate/)

  const indeterminate = page.locator('.vue-flow__node[data-id="sb:482"] .status-progress')
  await expect(indeterminate).toBeVisible()
  await expect(indeterminate).not.toHaveAttribute('aria-valuenow', /.+/)
  await expect(indeterminate.locator('.status-progress-track')).toHaveClass(/is-indeterminate/)
  await expect.poll(() => indeterminate.locator('.status-progress-track i').evaluate((element) => getComputedStyle(element).animationName)).toMatch(/^status-progress-slide/)

  const prompt = page.locator('.vue-flow__node[data-id="sb:483"] .status-progress')
  await expect(prompt).toBeVisible()
  await expect(prompt).not.toHaveAttribute('aria-valuenow', /.+/)
  await expect(prompt.locator('.status-progress-track')).toHaveClass(/is-indeterminate/)

  await page.goto(`/canvas/${projectId}`)
  await page.locator('.vue-flow__node[data-id="project-running:image"]').click()
  const editor = page.locator('.node-expanded-editor')
  await expect(editor).toBeVisible()
  await expect(editor.getByRole('progressbar', { name: '生成进度' })).toHaveAttribute('aria-valuenow', '42')
  const runButton = editor.getByRole('button', { name: '节点生成进行中' })
  await expect(runButton.locator('.run-spinner')).toBeVisible()
  await expect(runButton).not.toContainText('生成中')
  await expect.poll(() => runButton.locator('.run-spinner').evaluate((element) => getComputedStyle(element).animationName)).toMatch(/^generation-spin/)
})
