import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const backendRoot = fileURLToPath(new URL('../../backend-node/', import.meta.url))
const backendServer = path.join(backendRoot, 'src', 'server.js')
const Database = require(path.join(backendRoot, 'node_modules', 'better-sqlite3'))
const sharp = require(path.join(backendRoot, 'node_modules', 'sharp'))
const assetService = require(path.join(backendRoot, 'src', 'services', 'assetService'))

let backendProcess
let backendOrigin
let backendLogs = ''
let databasePath
let tempRoot
let storagePath
let dramaId
let sourceAssetId
const nodeId = 'free:image:toolbar-same-chain'
const realAihubccEnabled = process.env.RUN_REAL_AIHUBCC_IMAGE_NODE_CHAIN === '1'
const realAihubccBaseUrl = String(process.env.AIHUBCC_BASE_URL || '').trim()
const realAihubccApiKey = String(process.env.AIHUBCC_API_KEY || '').trim()
const realAihubccModel = String(process.env.AIHUBCC_IMAGE_MODEL || '').trim()

test.setTimeout(90_000)
test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'canvas-e2e-session',
      user: { id: 'canvas-e2e-user', email: 'canvas-e2e@example.com', role: 'user' },
    }))
  })
})

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function waitForHealth(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (backendProcess?.exitCode != null) {
      throw new Error(`图片工具后端提前退出（${backendProcess.exitCode}）\n${backendLogs}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`health status ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`图片工具后端未就绪：${lastError?.message || 'timeout'}\n${backendLogs}`)
}

async function stopBackend() {
  if (!backendProcess || backendProcess.exitCode != null) return
  const gracefulExit = Promise.race([
    once(backendProcess, 'exit').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 3_000)),
  ])
  backendProcess.kill('SIGTERM')
  if (!await gracefulExit && backendProcess.exitCode == null) {
    backendProcess.kill('SIGKILL')
    await Promise.race([
      once(backendProcess, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])
  }
}

function readDatabase(callback) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    return callback(db)
  } finally {
    db.close()
  }
}

function configureReferenceImageCapability() {
  const db = new Database(databasePath)
  try {
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO ai_service_configs
        (service_type, provider, api_protocol, name, base_url, api_key, model,
         default_model, endpoint, priority, is_default, is_active, settings,
         verification_status, verified_at, verification_evidence, created_at, updated_at)
       VALUES
        ('storyboard_image', 'aihubcc', 'aihubcc', ?, ?, ?, ?, ?,
         '/videos', 100, 1, 1, ?, 'verified', ?, ?, ?, ?)`,
    ).run(
      'AIHubCC gpt-image-2-3.5k 图片节点真实同链',
      realAihubccBaseUrl || 'https://example.invalid/v1',
      realAihubccApiKey || 'e2e-capability-only-key',
      JSON.stringify([realAihubccModel || 'gpt-image-2-3.5k']),
      realAihubccModel || 'gpt-image-2-3.5k',
      JSON.stringify({
        supports_upscale: true,
        supports_detail_enhance: true,
        supports_outpaint: true,
        supports_markup_retouch: true,
        supports_panorama: true,
        supports_panorama_scene: true,
        supports_image_ideation: true,
        supports_angle_ideation: true,
        supports_character_views: true,
        supports_narrative_grid: true,
        supports_frame_forward: true,
        supports_frame_backward: true,
        supports_cinematic_relight: true,
      }),
      now,
      JSON.stringify({ source: 'local-playwright-provider-fixture' }),
      now,
      now,
    )
  } finally {
    db.close()
  }
}

function resetImageNodeToSource() {
  const db = new Database(databasePath)
  try {
    const row = db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(dramaId)
    const metadata = JSON.parse(row.metadata)
    const freeNode = metadata.canvas_layout.free_nodes.find((entry) => entry.id === nodeId)
    freeNode.data = {
      ...freeNode.data,
      status: 'success',
      url: '/static/toolbar-source.png',
      savedAssetId: String(sourceAssetId),
      assetSaveStatus: 'success',
      imageToolStatus: '',
      imageToolError: '',
      imageToolRetryOperation: '',
      imageToolRetryParameters: null,
    }
    db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(metadata), new Date().toISOString(), dramaId)
  } finally {
    db.close()
  }
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

async function proxyBackend(page) {
  await page.route('**/api/v1/**', async (route) => {
    const source = new URL(route.request().url())
    const response = await route.fetch({
      url: `${backendOrigin}${source.pathname}${source.search}`,
    })
    await route.fulfill({ response })
  })
  await page.route('**/static/**', async (route) => {
    const source = new URL(route.request().url())
    const response = await route.fetch({
      url: `${backendOrigin}${source.pathname}${source.search}`,
    })
    await route.fulfill({ response })
  })
}

test.beforeAll(async () => {
  const port = await reservePort()
  const tempBase = process.env.IMAGE_NODE_E2E_TEMP_ROOT || os.tmpdir()
  fs.mkdirSync(tempBase, { recursive: true })
  tempRoot = fs.mkdtempSync(path.join(tempBase, 'moli-image-toolbar-browser-'))
  databasePath = path.join(tempRoot, 'toolbar.sqlite')
  storagePath = path.join(tempRoot, 'storage')
  const configRoot = path.join(tempRoot, 'configs')
  fs.mkdirSync(configRoot, { recursive: true })
  fs.mkdirSync(storagePath, { recursive: true })
  fs.writeFileSync(
    path.join(configRoot, 'config.yaml'),
    [
      'app:',
      '  name: LocalMiniDrama image toolbar integration',
      '  version: test',
      'server:',
      '  host: 127.0.0.1',
      `  port: ${port}`,
      '  cors_origins:',
      '    - http://127.0.0.1:3013',
      'database:',
      '  type: sqlite',
      `  path: ${databasePath.replace(/\\/g, '/')}`,
      'storage:',
      '  type: local',
      `  local_path: ${storagePath.replace(/\\/g, '/')}`,
      `  base_url: http://127.0.0.1:${port}/static`,
      'vendor_lock:',
      '  enabled: false',
    ].join('\n'),
    'utf8',
  )

  backendOrigin = `http://127.0.0.1:${port}`
  backendProcess = spawn(process.execPath, [backendServer], {
    cwd: tempRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      PUBLIC_PLATFORM_MODE: '0',
      WEB_DIST_PATH: path.join(tempRoot, 'missing-web-dist'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  backendProcess.stdout.on('data', (chunk) => { backendLogs += chunk.toString() })
  backendProcess.stderr.on('data', (chunk) => { backendLogs += chunk.toString() })
  await waitForHealth(`${backendOrigin}/health`)

  const sourcePath = path.join(storagePath, 'toolbar-source.png')
  await sharp({
    create: {
      width: 320,
      height: 180,
      channels: 3,
      background: '#ead9bd',
    },
  })
    .composite([{
      input: Buffer.from(
        '<svg width="320" height="180"><rect x="80" y="30" width="160" height="120" rx="16" fill="#375a7f"/></svg>',
      ),
    }])
    .png()
    .toFile(sourcePath)

  const db = new Database(databasePath)
  try {
    const now = new Date().toISOString()
    dramaId = Number(db.prepare(
      `INSERT INTO dramas (title, style, status, metadata, created_at, updated_at)
       VALUES (?, 'realistic', 'draft', '{}', ?, ?)`,
    ).run('图片工具栏真实同链验收', now, now).lastInsertRowid)
    const sourceAsset = assetService.create(db, { info() {} }, {
      drama_id: dramaId,
      name: 'toolbar-source.png',
      type: 'image',
      category: 'canvas',
      url: '/static/toolbar-source.png',
      local_path: sourcePath,
      mime_type: 'image/png',
      width: 320,
      height: 180,
      file_size: fs.statSync(sourcePath).size,
    })
    sourceAssetId = sourceAsset.id
    const metadata = {
      project_type: 'canvas',
      canvas_layout: {
        version: 1,
        viewport: { x: 120, y: 80, zoom: 1 },
        nodes: {},
        manual_edges: [],
        free_nodes: [{
          id: nodeId,
          type: 'homeCanvasNode',
          position: { x: 300, y: 220 },
          data: {
            kind: 'image',
            title: '图片工具同链节点',
            content: '验证真实图片处理',
            status: 'success',
            url: sourceAsset.url,
            savedAssetId: String(sourceAsset.id),
            assetSaveStatus: 'success',
            imageToolHistory: [],
          },
        }],
      },
    }
    db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(metadata), now, dramaId)
  } finally {
    db.close()
  }
})

test.afterAll(async () => {
  await stopBackend()
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
})

test('图片工具栏裁剪保留原图并新建结果节点，刷新后形成真实同链', async ({ page }) => {
  await proxyBackend(page)
  await page.goto(`/canvas/${dramaId}`)

  const node = page.locator(`.vue-flow__node[data-id="${nodeId}"]`)
  await expect(node).toContainText('图片工具同链节点')
  await node.click()
  const toolbar = node.locator('.image-node-toolbar')
  await expect(toolbar).toBeVisible()
  await expect(toolbar.locator('.toolbar-icon')).toHaveCount(10)
  await toolbar.getByRole('button', { name: /工具/ }).hover()
  await expect(toolbar.locator('.toolbar-menu')).toBeVisible()
  await expect(toolbar).not.toContainText('对口型')
  await expect(toolbar).not.toContainText('未接通')
  await toolbar.getByRole('button', { name: '裁剪/压缩/镜像', exact: true }).click()

  const cropDialog = page.getByRole('dialog', { name: '裁剪' })
  await expect(cropDialog).toBeVisible()
  const cropStage = cropDialog.locator('.crop-stage')
  const cropperContainer = cropDialog.locator('.cropper-container')
  await expect(cropperContainer).toBeVisible()
  const immersiveDialogBox = await cropDialog.locator('.el-dialog').boundingBox()
  expect(immersiveDialogBox?.width).toBeGreaterThan(1300)
  expect(immersiveDialogBox?.height).toBeGreaterThan(800)
  await expect(cropStage).toHaveCSS('height', '430px')
  await expect(cropperContainer).toHaveCSS('height', '430px')
  await cropDialog.getByRole('button', { name: '应用并生成新素材' }).click()
  await expect(page.getByText('图片处理完成，已生成新素材')).toBeVisible()
  await expect(cropDialog).toBeHidden()

  await expect.poll(() => readDatabase((db) => {
    const asset = db.prepare(
      `SELECT id, url, local_path, width, height, mime_type, metadata
       FROM assets WHERE id != ? AND drama_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(sourceAssetId, dramaId)
    const task = db.prepare(
      `SELECT id, type, status, error, result
       FROM async_tasks WHERE type = 'image_tool_crop' ORDER BY created_at DESC LIMIT 1`,
    ).get()
    const metadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(dramaId).metadata)
    const sourceNode = metadata.canvas_layout.free_nodes.find((item) => item.id === nodeId)
    const resultNode = metadata.canvas_layout.free_nodes.find(
      (item) => item.id !== nodeId && item.data?.imageToolTaskId === task?.id,
    )
    return {
      asset: asset ? { ...asset, metadata: JSON.parse(asset.metadata || '{}') } : null,
      task,
      sourceNode,
      resultNode,
    }
  })).toMatchObject({
    asset: {
      mime_type: 'image/png',
      metadata: {
        sourceAssetId,
        sourceNodeId: nodeId,
        operation: 'crop',
        engine: 'sharp',
        taskId: expect.any(String),
      },
    },
    task: {
      type: 'image_tool_crop',
      status: 'completed',
      error: null,
      result: expect.stringContaining('"resultAssetId"'),
    },
    sourceNode: {
      data: expect.objectContaining({
        imageToolStatus: 'success',
        savedAssetId: String(sourceAssetId),
        url: '/static/toolbar-source.png',
        imageToolHistory: expect.arrayContaining([
          expect.objectContaining({ operation: 'crop', status: 'success' }),
        ]),
      }),
    },
    resultNode: {
      data: expect.objectContaining({
        kind: 'image',
        sourceImageToolNodeId: nodeId,
        imageToolOperation: 'crop',
        savedAssetId: expect.any(String),
        url: expect.stringMatching(/^\/static\//),
      }),
    },
  })

  const { cropAsset, cropResultNodeId } = readDatabase((db) => {
    const asset = db.prepare(
      `SELECT id, url, local_path, width, height
       FROM assets WHERE id != ? AND drama_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(sourceAssetId, dramaId)
    const metadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(dramaId).metadata)
    const resultNode = metadata.canvas_layout.free_nodes.find(
      (item) => item.id !== nodeId && item.data?.savedAssetId === String(asset.id),
    )
    return { cropAsset: asset, cropResultNodeId: resultNode?.id }
  })
  expect(cropResultNodeId).toEqual(expect.any(String))
  expect(cropAsset.width).toBeLessThan(320)
  expect(cropAsset.height).toBeLessThan(180)
  expect(fs.existsSync(cropAsset.local_path)).toBe(true)
  expect(sha256(path.join(storagePath, 'toolbar-source.png'))).not.toBe(sha256(cropAsset.local_path))
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator(`.vue-flow__node[data-id="${nodeId}"] img`))
    .toHaveAttribute('src', /\/static\/toolbar-source\.png$/)
  const restored = page.locator(`.vue-flow__node[data-id="${cropResultNodeId}"]`)
  await expect(restored).toContainText('图片工具同链节点 · 编辑结果')
  await restored.click()
  const restoredToolbar = restored.locator('.image-node-toolbar')
  await expect(restoredToolbar).toBeVisible()
})

test('图片节点灯光入口提供参考站同级预设并即时写入 3D 环境', async ({ page }) => {
  await proxyBackend(page)
  await page.goto(`/canvas/${dramaId}`)

  const node = page.locator(`.vue-flow__node[data-id="${nodeId}"]`)
  await node.click()
  const toolbar = node.locator('.image-node-toolbar')
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: '灯光', exact: true }).click()

  const director = page.getByRole('dialog', { name: '灯光调节' })
  await expect(director).toBeVisible()
  const presets = director.getByLabel('灯光预设')
  await expect(presets.getByRole('button')).toHaveCount(18)
  await presets.getByRole('button', { name: '黄金时刻', exact: true }).click()
  await expect(director.getByLabel('天空颜色')).toHaveValue('#7c2d12')
  await expect(director.getByLabel('环境光')).toHaveValue('0.9')
  await expect(director.getByLabel('方向光')).toHaveValue('0')
  await expect(director.getByLabel('灯光列表').getByRole('button', { name: '夕阳主光', exact: true })).toBeVisible()
  await expect(director.getByLabel('灯光列表').getByRole('button', { name: '金色轮廓', exact: true })).toBeVisible()
})

test('标记修图完整工具集可仅确认标记并生成本地新素材', async ({ page }) => {
  await proxyBackend(page)
  resetImageNodeToSource()
  await page.goto(`/canvas/${dramaId}`)

  const node = page.locator(`.vue-flow__node[data-id="${nodeId}"]`)
  await node.click()
  const toolbar = node.locator('.image-node-toolbar')
  await toolbar.getByRole('button', { name: /工具/ }).hover()
  await toolbar.getByRole('button', { name: '标记修图', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: '标记修图' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('标记工具').getByRole('button')).toHaveCount(9)
  await dialog.getByRole('button', { name: '文本', exact: true }).click()
  await dialog.locator('.markup-text input').fill('重点')
  const surface = dialog.locator('.markup-canvas svg')
  await surface.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    element.setPointerCapture = () => {}
    element.releasePointerCapture = () => {}
    element.hasPointerCapture = () => false
    element.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      pointerId: 1,
      clientX: bounds.left + (bounds.width * 0.4),
      clientY: bounds.top + (bounds.height * 0.4),
    }))
    element.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      button: 0,
      pointerId: 1,
      clientX: bounds.left + (bounds.width * 0.4),
      clientY: bounds.top + (bounds.height * 0.4),
    }))
  })
  await expect(surface.locator('text')).toContainText('重点')
  await expect(dialog.getByLabel('标记图层')).toContainText('文本')
  await expect(dialog.getByRole('button', { name: '标记并修改' })).toBeDisabled()
  await dialog.getByRole('button', { name: '仅确认标记' }).click()
  await expect(page.getByText('图片处理完成，已生成新素材')).toBeVisible()

  await expect.poll(() => readDatabase((db) => {
    const task = db.prepare(
      `SELECT result FROM async_tasks
       WHERE type = 'image_tool_markup_retouch' ORDER BY rowid DESC LIMIT 1`,
    ).get()
    if (!task?.result) return null
    const result = JSON.parse(task.result)
    const asset = db.prepare('SELECT local_path, metadata FROM assets WHERE id = ?')
      .get(result.resultAssetId)
    return {
      exists: fs.existsSync(asset.local_path),
      metadata: JSON.parse(asset.metadata || '{}'),
    }
  })).toMatchObject({
    exists: true,
    metadata: {
      operation: 'markup_retouch',
      engine: 'sharp',
      parameters: {
        mode: 'markup_only',
        strokeCount: 1,
      },
    },
  })
})

test('图片调整预设即时预览并将完整参数写入真实派生素材', async ({ page }) => {
  await proxyBackend(page)
  resetImageNodeToSource()
  await page.goto(`/canvas/${dramaId}`)

  const node = page.locator(`.vue-flow__node[data-id="${nodeId}"]`)
  await node.click()
  const toolbar = node.locator('.image-node-toolbar')
  await toolbar.getByRole('button', { name: /工具/ }).hover()
  await toolbar.getByRole('button', { name: '图片调整', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: '图片调整' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('tab')).toHaveCount(4)
  await dialog.getByRole('button', { name: '鲜艳', exact: true }).click()
  await expect(dialog.locator('.preview-canvas img')).toHaveCSS(
    'filter',
    /saturate\(1\.4375\).*contrast\(1\.08\)/,
  )
  await dialog.getByRole('tab', { name: '颜色', exact: true }).click()
  await expect(dialog.getByText(/自然饱和度 125/)).toBeVisible()
  await dialog.getByRole('button', { name: '应用并生成新素材' }).click()
  await expect(page.getByText('图片处理完成，已生成新素材')).toBeVisible()

  await expect.poll(() => readDatabase((db) => {
    const asset = db.prepare(
      `SELECT local_path, metadata FROM assets
       WHERE drama_id = ? AND id != ? ORDER BY id DESC LIMIT 1`,
    ).get(dramaId, sourceAssetId)
    return asset ? {
      localPath: asset.local_path,
      metadata: JSON.parse(asset.metadata || '{}'),
    } : null
  })).toMatchObject({
    localPath: expect.any(String),
    metadata: {
      operation: 'adjust',
      engine: 'sharp',
      parameters: {
        exposure: 0,
        brightness: 1,
        vibrance: 1.25,
        saturation: 1.15,
        contrast: 1.08,
        temperature: 0,
        tint: 0,
        hue: 0,
        sharpness: 0,
        clarity: 0,
        blur: 0,
      },
    },
  })
})

test('宫格裁剪选择指定区域并真实生成对应数量素材', async ({ page }) => {
  await proxyBackend(page)
  resetImageNodeToSource()
  await page.goto(`/canvas/${dramaId}`)

  const node = page.locator(`.vue-flow__node[data-id="${nodeId}"]`)
  await expect(node).toBeVisible()
  const nodeCountBefore = await page.locator('article.home-canvas-node').count()
  const sourceUrl = await node.locator('img').getAttribute('src')
  await node.click()
  const toolbar = node.locator('.image-node-toolbar')
  await toolbar.getByRole('button', { name: /工具/ }).hover()
  await toolbar.getByRole('button', { name: '宫格裁剪', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: '宫格裁剪' })
  await expect(dialog.getByLabel('宫格选择').getByRole('button')).toHaveCount(9)
  await dialog.getByRole('button', { name: '取消全选', exact: true }).click()
  await dialog.getByRole('button', { name: '第 1 行第 2 列', exact: true }).click()
  await dialog.getByRole('button', { name: '第 3 行第 1 列', exact: true }).click()
  await expect(dialog.getByText('已选择 2 / 9 格')).toBeVisible()
  await dialog.getByRole('button', { name: '应用并生成新素材' }).click()
  await expect(page.getByText('图片处理完成，已生成新素材')).toBeVisible()

  await expect.poll(() => readDatabase((db) => {
    const task = db.prepare(
      `SELECT id, result FROM async_tasks
       WHERE type = 'image_tool_grid_crop' ORDER BY rowid DESC LIMIT 1`,
    ).get()
    if (!task?.result) return null
    const resultAssets = JSON.parse(task.result).resultAssets
    const metadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(dramaId).metadata)
    const sourceNode = metadata.canvas_layout.free_nodes.find((item) => item.id === nodeId)
    const resultNodes = metadata.canvas_layout.free_nodes.filter(
      (item) => item.id !== nodeId && item.data?.imageToolTaskId === task.id,
    )
    return { resultAssets, sourceNode, resultNodes }
  })).toMatchObject({
    resultAssets: [
      expect.objectContaining({ row: 0, column: 1 }),
      expect.objectContaining({ row: 2, column: 0 }),
    ],
    sourceNode: {
      data: expect.objectContaining({
        url: '/static/toolbar-source.png',
        savedAssetId: String(sourceAssetId),
        imageToolStatus: 'success',
      }),
    },
    resultNodes: [
      {
        data: expect.objectContaining({
          kind: 'image',
          sourceImageToolNodeId: nodeId,
          imageToolOperation: 'grid_crop',
          savedAssetId: expect.any(String),
          url: expect.stringMatching(/^\/static\//),
        }),
      },
      {
        data: expect.objectContaining({
          kind: 'image',
          sourceImageToolNodeId: nodeId,
          imageToolOperation: 'grid_crop',
          savedAssetId: expect.any(String),
          url: expect.stringMatching(/^\/static\//),
        }),
      },
    ],
  })
  await expect(node.locator('img')).toHaveAttribute('src', sourceUrl)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('article.home-canvas-node')).toHaveCount(nodeCountBefore + 2)
  await expect(page.locator(`.vue-flow__node[data-id="${nodeId}"] img`)).toHaveAttribute('src', sourceUrl)
})

test('专业调色、LUT 最近项与专业设定具有可操作交互', async ({ page }) => {
  configureReferenceImageCapability()
  await proxyBackend(page)
  await page.goto(`/canvas/${dramaId}`)
  const node = page.locator(`.vue-flow__node[data-id="${nodeId}"]`)
  const sourceUrl = await node.locator('img').getAttribute('src')
  const nodeCountBefore = await page.locator('article.home-canvas-node').count()
  const focusToolbar = async () => {
    await node.click()
    await page.keyboard.press('Escape')
    return node.locator('.image-node-toolbar')
  }
  let toolbar = await focusToolbar()

  await toolbar.getByRole('button', { name: /工具/ }).hover()
  await toolbar.getByRole('button', { name: '图片调整', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '图片调整' })
  await expect(dialog.getByText('RGB 曲线')).toBeVisible()
  await dialog.getByRole('button', { name: '添加控制点' }).click()
  await expect(dialog.getByText('控制点 2')).toBeVisible()
  await dialog.getByRole('button', { name: '应用并生成新素材' }).click()
  await expect(page.getByText('图片处理完成，已生成新素材')).toBeVisible()
  await expect(page.locator('article.home-canvas-node')).toHaveCount(nodeCountBefore + 1)
  await expect(node.locator('img')).toHaveAttribute('src', sourceUrl)

  toolbar = await focusToolbar()
  await toolbar.getByRole('button', { name: /工具/ }).hover()
  await toolbar.getByRole('button', { name: 'LUT 调色', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'LUT 调色' })
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'identity-2.cube',
    mimeType: 'text/plain',
    buffer: Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'),
  })
  await dialog.getByRole('button', { name: '最近使用' }).click()
  await expect(dialog.getByRole('button', { name: /identity-2\.cube/ })).toBeVisible()
  await dialog.getByRole('button', { name: '应用并生成新素材' }).click()
  await expect(page.getByText('图片处理完成，已生成新素材')).toBeVisible()
  await expect(page.locator('article.home-canvas-node')).toHaveCount(nodeCountBefore + 2)
  await expect(node.locator('img')).toHaveAttribute('src', sourceUrl)

  toolbar = await focusToolbar()
  await toolbar.getByRole('button', { name: /设定/ }).hover()
  await toolbar.getByRole('button', { name: '背景重构', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '背景重构' })
  await expect(dialog.getByRole('textbox')).toHaveValue(/重新构建完整且透视一致的背景环境/)
  await dialog.getByRole('button', { name: '取消' }).click()

  toolbar = await focusToolbar()
  await toolbar.getByRole('button', { name: /设定/ }).hover()
  await toolbar.getByRole('button', { name: '全景镜头扩张', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '全景镜头扩张' })
  await expect(dialog.getByRole('textbox')).toHaveValue(/扩展为自然的超广角全景镜头画面/)
  await dialog.getByRole('button', { name: '取消' }).click()

  toolbar = await focusToolbar()
  await toolbar.getByRole('button', { name: /设定/ }).hover()
  await toolbar.getByRole('button', { name: '氛围重塑', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '氛围重塑' })
  await expect(dialog.getByRole('textbox')).toHaveValue(/重塑环境光、空气透视与整体氛围/)
  await dialog.getByRole('button', { name: '取消' }).click()

  toolbar = await focusToolbar()
  await toolbar.getByRole('button', { name: /工具/ }).hover()
  await toolbar.getByRole('button', { name: '画面联想', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '画面联想' })
  await expect(dialog.getByRole('textbox')).toHaveValue('')
  await dialog.getByRole('button', { name: '取消' }).click()
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('article.home-canvas-node')).toHaveCount(nodeCountBefore + 2)
  await expect(page.locator(`.vue-flow__node[data-id="${nodeId}"] img`)).toHaveAttribute('src', sourceUrl)
})

test('图片工具栏逐项真实触发 AIHubCC gpt-image-2-3.5k 并完成供应商产物持久化同链', async ({ page }, testInfo) => {
  test.skip(!realAihubccEnabled, '需要显式启用真实 AIHubCC 付费同链')
  testInfo.setTimeout(28_800_000)
  const requestedOperations = new Set(
    String(process.env.AIHUBCC_REAL_IMAGE_OPERATIONS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )
  const cases = [
    { operation: 'upscale', menu: null, button: '高清', dialog: '高清增强', width: 640, height: 360 },
    { operation: 'detail_enhance', menu: '设定', button: '细节纹理增强', dialog: '细节纹理增强', width: 320, height: 180 },
    { operation: 'outpaint', menu: '工具', button: '扩图', dialog: '扩图', aspectRatio: 16 / 9 },
    { operation: 'markup_retouch', menu: '工具', button: '标记修图', dialog: '标记修图', width: 320, height: 180, markup: true },
    { operation: 'cinematic_relight', menu: '设定', button: '电影级光影校正', dialog: '电影级光影校正', width: 320, height: 180 },
    { operation: 'panorama', menu: null, button: '720全景', dialog: '720全景', aspectRatio: 2 },
    { operation: 'panorama_scene', menu: '设定', button: '生成全景场景', dialog: '生成全景场景', aspectRatio: 2 },
    { operation: 'image_ideation', menu: '工具', button: '画面联想', dialog: '画面联想', width: 320, height: 180 },
    { operation: 'angle_ideation', menu: '工具', button: '角度联想', dialog: '角度联想', width: 320, height: 180 },
    { operation: 'character_views', menu: '设定', button: '角色三视图', dialog: '角色三视图', aspectRatio: 4 / 3 },
    { operation: 'narrative_grid', menu: '设定', button: '多机位叙事九宫格', dialog: '多机位叙事九宫格', aspectRatio: 1 },
    { operation: 'frame_forward', menu: '设定', button: '画面推演-3秒后', dialog: '画面推演-3秒后', width: 320, height: 180 },
    { operation: 'frame_backward', menu: '设定', button: '画面推演-5秒前', dialog: '画面推演-5秒前', width: 320, height: 180 },
  ].filter((item) => requestedOperations.size === 0 || requestedOperations.has(item.operation))
  const capabilitiesResponse = await fetch(`${backendOrigin}/api/v1/image-tools/capabilities`)
  expect(capabilitiesResponse.ok).toBe(true)
  const capabilitiesPayload = await capabilitiesResponse.json()
  for (const item of cases) {
    const capability = capabilitiesPayload?.data?.operations?.[item.operation]
    if (!capability?.available) {
      throw new Error(`AIHUBCC_CAPABILITY_UNAVAILABLE ${item.operation} ${JSON.stringify(capability)}`)
    }
    expect(capability).toMatchObject({
      available: true,
      engine: 'provider-image-edit',
      protocol: 'aihubcc',
      model: realAihubccModel,
    })
  }
  await proxyBackend(page)
  resetImageNodeToSource()
  await page.goto(`/canvas/${dramaId}`)

  for (const [index, item] of cases.entries()) {
    const beforeTaskRowId = readDatabase((db) => (
      db.prepare('SELECT COALESCE(MAX(rowid), 0) AS value FROM async_tasks').get().value
    ))
    const node = page.locator(`.vue-flow__node[data-id="${nodeId}"]`)
    await expect(node).toContainText('图片工具同链节点')
    await node.click()
    const toolbar = node.locator('.image-node-toolbar')
    await expect(toolbar).toBeVisible()
    if (item.menu) {
      await toolbar.getByRole('button', { name: new RegExp(`^${item.menu}`) }).click()
    }
    const operationButton = toolbar.getByRole('button', { name: item.button, exact: true })
    await expect(operationButton).toBeEnabled()
    await operationButton.click()

    const dialog = page.getByRole('dialog', { name: item.dialog })
    await expect(dialog).toBeVisible()
    if (item.markup) {
      await dialog.getByRole('textbox', { name: '修图要求' }).fill('将标记区域调整为自然的浅蓝色，并保持其他内容不变')
      const surface = dialog.locator('.markup-canvas svg')
      await surface.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        element.setPointerCapture = () => {}
        element.releasePointerCapture = () => {}
        element.hasPointerCapture = () => false
        const dispatch = (type, x, y) => element.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          button: 0,
          pointerId: 1,
          clientX: bounds.left + (bounds.width * x),
          clientY: bounds.top + (bounds.height * y),
        }))
        dispatch('pointerdown', 0.4, 0.4)
        dispatch('pointermove', 0.5, 0.5)
        dispatch('pointermove', 0.6, 0.6)
        dispatch('pointerup', 0.6, 0.6)
      })
      await expect(surface.locator('polyline')).toHaveCount(1)
    } else {
      await expect(dialog.getByLabel('图片效果预览')).toBeVisible()
      await expect(dialog.locator('.preview-caption')).toContainText('原图保持不变')
    }
    await dialog.getByRole('button', {
      name: item.markup ? '标记并修改' : '应用并生成新素材',
    }).click()
    const successMessage = page.locator('.el-message--success').filter({
      hasText: '图片处理完成，已生成新素材',
    })
    const failureAlert = toolbar.getByRole('alert')
    const errorMessage = page.locator('.el-message--error').last()
    const outcome = await Promise.race([
      successMessage.waitFor({ state: 'visible', timeout: 3_900_000 }).then(() => 'success'),
      failureAlert.waitFor({ state: 'visible', timeout: 3_900_000 }).then(() => 'failed'),
      errorMessage.waitFor({ state: 'visible', timeout: 3_900_000 }).then(() => 'error'),
    ])
    if (outcome !== 'success') {
      const safeLogs = backendLogs
        .replaceAll(realAihubccApiKey, '[REDACTED]')
        .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
        .slice(-12_000)
      const message = outcome === 'failed'
        ? await failureAlert.textContent()
        : await errorMessage.textContent()
      throw new Error(`${item.operation}: ${message}\n${safeLogs}`)
    }

    const persisted = await expect.poll(() => readDatabase((db) => {
      const task = db.prepare(
        `SELECT rowid, id, status, error, result
         FROM async_tasks WHERE type = ? AND rowid > ?
         ORDER BY rowid DESC LIMIT 1`,
      ).get(`image_tool_${item.operation}`, beforeTaskRowId)
      if (!task?.result) return null
      const result = JSON.parse(task.result)
      const asset = db.prepare(
        `SELECT id, url, local_path, mime_type, width, height, file_size, metadata
         FROM assets WHERE id = ?`,
      ).get(result.resultAssetId)
      const metadata = JSON.parse(db.prepare(
        'SELECT metadata FROM dramas WHERE id = ?',
      ).get(dramaId).metadata)
      const sourceNode = metadata.canvas_layout.free_nodes.find((entry) => entry.id === nodeId)
      const resultNode = metadata.canvas_layout.free_nodes.find(
        (entry) => entry.id !== nodeId && entry.data?.imageToolTaskId === task.id,
      )
      return {
        task,
        asset: asset ? { ...asset, metadata: JSON.parse(asset.metadata || '{}') } : null,
        sourceNode,
        resultNode,
      }
    }), { timeout: 30_000 }).toMatchObject({
      task: {
        status: 'completed',
        error: null,
        result: expect.stringContaining('"resultAssetId"'),
      },
      asset: {
        ...(item.width ? { width: item.width, height: item.height } : {}),
        file_size: expect.any(Number),
        metadata: {
          operation: item.operation,
          engine: 'provider-image-edit',
          engineVersion: expect.stringContaining(realAihubccModel),
          taskId: expect.any(String),
        },
      },
      sourceNode: {
        data: expect.objectContaining({
          imageToolStatus: 'success',
          savedAssetId: String(sourceAssetId),
          url: '/static/toolbar-source.png',
          imageToolHistory: expect.arrayContaining([
            expect.objectContaining({ operation: item.operation, status: 'success' }),
          ]),
        }),
      },
      resultNode: {
        data: expect.objectContaining({
          kind: 'image',
          sourceImageToolNodeId: nodeId,
          imageToolOperation: item.operation,
          savedAssetId: expect.any(String),
          url: expect.stringMatching(/^\/static\//),
        }),
      },
    })
    expect(persisted).toBeUndefined()

    const resultAsset = readDatabase((db) => {
      const task = db.prepare(
        `SELECT result FROM async_tasks WHERE type = ? AND rowid > ?
         ORDER BY rowid DESC LIMIT 1`,
      ).get(`image_tool_${item.operation}`, beforeTaskRowId)
      const result = JSON.parse(task.result)
      return db.prepare(
        `SELECT local_path, mime_type, width, height, file_size
         FROM assets WHERE id = ?`,
      ).get(result.resultAssetId)
    })
    expect(resultAsset.file_size).toBeGreaterThan(0)
    expect(fs.existsSync(resultAsset.local_path)).toBe(true)
    const resultArtifact = await sharp(resultAsset.local_path, {
      failOn: 'warning',
    }).metadata()
    const expectedMime = {
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
    }[resultArtifact.format]
    expect(resultAsset.mime_type).toBe(expectedMime)
    if (item.width) {
      expect(resultArtifact.width).toBe(item.width)
      expect(resultArtifact.height).toBe(item.height)
    } else {
      expect(resultArtifact.width).toBeGreaterThan(0)
      expect(resultArtifact.height).toBeGreaterThan(0)
      expect(resultArtifact.width / resultArtifact.height).toBeCloseTo(item.aspectRatio, 2)
    }

    await page.reload({ waitUntil: 'networkidle' })
    const restored = page.locator(`.vue-flow__node[data-id="${nodeId}"]`)
    await restored.click()
    await restored.locator('.image-node-toolbar button[title="处理历史"]').click()
    await expect(restored.locator('.toolbar-history')).toContainText(item.dialog)
    await expect(restored.locator('.toolbar-history')).toContainText('已完成')

    if (index < cases.length - 1) {
      resetImageNodeToSource()
      await page.reload({ waitUntil: 'networkidle' })
    }
  }
})
