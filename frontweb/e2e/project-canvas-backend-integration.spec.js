import { test, expect } from '@playwright/test'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const backendRoot = fileURLToPath(new URL('../../backend-node/', import.meta.url))
const backendServer = path.join(backendRoot, 'src', 'server.js')
const simpleSkinGltfPath = fileURLToPath(new URL('../public/director-fixtures/khronos-simple-skin.gltf', import.meta.url))
const Database = require(path.join(backendRoot, 'node_modules', 'better-sqlite3'))
const { getFfmpegPath } = require(path.join(backendRoot, 'src', 'utils', 'ffmpegPath'))
const minimalMp3 = require(path.join(backendRoot, 'test', 'fixtures', 'minimalMp3'))
const { MINIMAL_MP4 } = require(path.join(backendRoot, 'test', 'fixtures', 'media'))

let backendProcess
let backendOrigin
let backendLogs = ''
let databasePath
let dramaId
let episodeId
let characterId
let storyboardId
let standaloneDramaId
let tempRoot
let ttsProvider
let imageProvider
let videoProvider
let validationWebm
const ttsProviderRequests = []
const imageProviderRequests = []
const videoProviderRequests = []
const videoProviderTasks = new Map()
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

test.setTimeout(60_000)
test.describe.configure({ mode: 'serial' })

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
      throw new Error(`真实后端提前退出（${backendProcess.exitCode}）\n${backendLogs}`)
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
  throw new Error(`真实后端未就绪：${lastError?.message || 'timeout'}\n${backendLogs}`)
}

async function stopBackend() {
  if (!backendProcess || backendProcess.exitCode != null) return
  const gracefulExit = Promise.race([
    once(backendProcess, 'exit').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 3_000)),
  ])
  backendProcess.kill('SIGTERM')
  if (!await gracefulExit && backendProcess.exitCode == null) {
    const forcedExit = Promise.race([
      once(backendProcess, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])
    backendProcess.kill('SIGKILL')
    await forcedExit
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

function embeddedGltfToGlb(source) {
  const document = JSON.parse(source)
  const offsets = []
  const chunks = []
  let byteLength = 0
  for (const entry of document.buffers || []) {
    const match = String(entry.uri || '').match(/^data:[^,]+;base64,(.+)$/)
    if (!match) throw new Error('验证资产必须是嵌入式 glTF')
    const chunk = Buffer.from(match[1], 'base64')
    offsets.push(byteLength)
    chunks.push(chunk)
    byteLength += chunk.length
    const padding = (4 - (byteLength % 4)) % 4
    if (padding) {
      chunks.push(Buffer.alloc(padding))
      byteLength += padding
    }
  }
  const binary = Buffer.concat(chunks)
  document.bufferViews = (document.bufferViews || []).map((view) => ({
    ...view,
    buffer: 0,
    byteOffset: offsets[view.buffer] + (view.byteOffset || 0),
  }))
  document.buffers = [{ byteLength: binary.length }]

  const json = Buffer.from(JSON.stringify(document), 'utf8')
  const jsonPadding = (4 - (json.length % 4)) % 4
  const paddedJson = jsonPadding ? Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)]) : json
  const totalLength = 12 + 8 + paddedJson.length + 8 + binary.length
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(totalLength, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(paddedJson.length, 0)
  jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const binaryHeader = Buffer.alloc(8)
  binaryHeader.writeUInt32LE(binary.length, 0)
  binaryHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, paddedJson, binaryHeader, binary])
}

async function clickNodeAction(page, node, actionName) {
  await node.click({ button: 'right', position: { x: 24, y: 24 } })
  const menu = page.getByRole('menu', { name: '节点操作' })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: actionName }).click()
}

test.beforeAll(async () => {
  ttsProvider = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      ttsProviderRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(200, { 'content-type': 'audio/mpeg' })
      response.end(minimalMp3)
    })
  })
  await new Promise((resolve) => ttsProvider.listen(0, '127.0.0.1', resolve))
  imageProvider = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/images/generations') {
      response.writeHead(404)
      response.end()
      return
    }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      imageProviderRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }))
    })
  })
  await new Promise((resolve) => imageProvider.listen(0, '127.0.0.1', resolve))
  videoProvider = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/videos') {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const taskId = `canvas-video-${videoProviderRequests.length + 1}`
        const shouldFail = String(body.prompt || '').includes('模拟失败')
        videoProviderRequests.push({ taskId, body })
        videoProviderTasks.set(taskId, { shouldFail, polls: 0 })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ task_id: taskId, status: 'queued' }))
      })
      return
    }
    const taskMatch = request.method === 'GET' && request.url?.match(/^\/videos\/(canvas-video-\d+)$/)
    if (taskMatch) {
      const task = videoProviderTasks.get(taskMatch[1])
      if (!task) {
        response.writeHead(404)
        response.end()
        return
      }
      task.polls += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      if (task.shouldFail) {
        response.end(JSON.stringify({ id: taskMatch[1], status: 'failed', error: '本地供应商模拟失败' }))
      } else if (task.polls === 1) {
        response.end(JSON.stringify({ id: taskMatch[1], status: 'processing' }))
      } else {
        response.end(JSON.stringify({
          id: taskMatch[1],
          status: 'completed',
          video_url: `http://127.0.0.1:${videoProvider.address().port}/output.mp4`,
        }))
      }
      return
    }
    if (request.method === 'GET' && request.url === '/output.mp4') {
      response.writeHead(200, { 'content-type': 'video/mp4' })
      response.end(MINIMAL_MP4)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise((resolve) => videoProvider.listen(0, '127.0.0.1', resolve))
  const port = await reservePort()
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-canvas-browser-backend-'))
  const validationWebmPath = path.join(tempRoot, 'director-validation.webm')
  const generatedWebm = spawnSync(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12',
    '-t', '0.5', '-c:v', 'libvpx-vp9', '-an', '-y', validationWebmPath,
  ], { encoding: 'utf8', timeout: 10_000 })
  if (generatedWebm.status !== 0) {
    throw new Error(`导演台验证 WebM 生成失败：${generatedWebm.stderr || generatedWebm.error?.message || generatedWebm.status}`)
  }
  validationWebm = fs.readFileSync(validationWebmPath)
  if (validationWebm.length < 1024) throw new Error('导演台验证 WebM 内容无效')
  databasePath = path.join(tempRoot, 'canvas.sqlite')
  const storagePath = path.join(tempRoot, 'storage')
  const configRoot = path.join(tempRoot, 'configs')
  fs.mkdirSync(configRoot, { recursive: true })
  fs.writeFileSync(
    path.join(configRoot, 'config.yaml'),
    [
      'app:',
      '  name: LocalMiniDrama browser integration',
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

  const db = new Database(databasePath)
  try {
    const now = new Date().toISOString()
    dramaId = Number(db.prepare(
      `INSERT INTO dramas (title, style, status, metadata, created_at, updated_at)
       VALUES (?, 'realistic', 'draft', ?, ?, ?)`,
    ).run('真实后端项目画布', JSON.stringify({ aspect_ratio: '16:9' }), now, now).lastInsertRowid)
    standaloneDramaId = Number(db.prepare(
      `INSERT INTO dramas (title, style, status, metadata, created_at, updated_at)
       VALUES (?, 'realistic', 'draft', ?, ?, ?)`,
    ).run('真实后端独立画布', JSON.stringify({
      project_type: 'canvas',
      canvas_layout: {
        version: 1,
        viewport: { x: 0, y: 0, zoom: 0.75 },
        nodes: {},
        manual_edges: [],
        free_nodes: [{
          id: 'free:image:same-chain',
          type: 'homeCanvasNode',
          position: { x: 240, y: 220 },
          data: {
            kind: 'image',
            title: '真实图片节点',
            content: '待配置图片提示词',
            model: '',
            aspectRatio: '16:9',
          },
        }, {
          id: 'free:video:same-chain',
          type: 'homeCanvasNode',
          position: { x: 600, y: 220 },
          data: {
            kind: 'video',
            title: '真实视频节点',
            content: '待配置视频提示词',
            model: '',
            aspectRatio: '16:9',
            duration: 5,
          },
        }],
        manual_edges: [{
          id: 'manual:free-image-to-video',
          source: 'free:image:same-chain',
          target: 'free:video:same-chain',
          data: { manual: true },
        }],
      },
    }), now, now).lastInsertRowid)
    episodeId = Number(db.prepare(
      `INSERT INTO episodes (drama_id, episode_number, title, script_content, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?)`,
    ).run(dramaId, '第一集', '小茉在雨夜车站撑开红伞。', now, now).lastInsertRowid)
    characterId = Number(db.prepare(
      `INSERT INTO characters (drama_id, name, role, appearance, sort_order, created_at, updated_at)
       VALUES (?, ?, 'main', ?, 1, ?, ?)`,
    ).run(dramaId, '小茉', '短发，蓝色外套', now, now).lastInsertRowid)
    const sceneId = Number(db.prepare(
      `INSERT INTO scenes (drama_id, episode_id, location, time, prompt, image_url, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)`,
    ).run(
      dramaId,
      episodeId,
      '雨夜车站',
      '夜晚',
      '湿润站台与暖色路灯',
      '/static/library-rain-station.png',
      now,
      now,
    ).lastInsertRowid)
    const propId = Number(db.prepare(
      `INSERT INTO props (drama_id, episode_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(dramaId, episodeId, '红伞', '雨夜里的红色长柄伞', now, now).lastInsertRowid)
    storyboardId = Number(db.prepare(
      `INSERT INTO storyboards
        (episode_id, scene_id, storyboard_number, title, description, duration, characters, status, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, 5, ?, 'pending', ?, ?)`,
    ).run(
      episodeId,
      sceneId,
      '雨夜相遇',
      '小茉走入车站，红伞在灯下展开。',
      JSON.stringify([characterId]),
      now,
      now,
    ).lastInsertRowid)
    db.prepare('INSERT INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)').run(storyboardId, propId)
  } finally {
    db.close()
  }

  const libraryResponse = await fetch(`${backendOrigin}/api/v1/scene-library`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      drama_id: dramaId,
      location: '雨夜站台参考',
      prompt: '雨夜车站参考图',
      image_url: '/static/library-rain-station.png',
      source_type: 'generated',
    }),
  })
  if (!libraryResponse.ok) {
    throw new Error(`场景素材初始化失败：${libraryResponse.status} ${await libraryResponse.text()}`)
  }

  for (const config of [
    {
      service_type: 'image',
      name: '画布图片模型',
      provider: 'openai',
      base_url: `http://127.0.0.1:${imageProvider.address().port}/v1`,
      api_key: 'test-no-request-key',
      model: ['canvas-image-alpha', 'canvas-image-beta'],
      default_model: 'canvas-image-alpha',
      is_default: true,
    },
    {
      service_type: 'video',
      name: '画布视频模型',
      provider: 'aihubcc',
      api_protocol: 'aihubcc',
      base_url: `http://127.0.0.1:${videoProvider.address().port}`,
      api_key: 'integration-secret',
      model: ['seedance-2.0-720p'],
      default_model: 'seedance-2.0-720p',
      endpoint: '/videos',
      query_endpoint: '/videos/{taskId}',
      is_default: true,
    },
    {
      service_type: 'tts',
      name: '画布音频模型',
      provider: 'openai',
      base_url: `http://127.0.0.1:${ttsProvider.address().port}`,
      api_key: 'test-no-request-key',
      model: ['canvas-tts-alpha', 'canvas-tts-beta'],
      default_model: 'canvas-tts-alpha',
      is_default: true,
    },
  ]) {
    const configResponse = await fetch(`${backendOrigin}/api/v1/ai-configs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    })
    if (!configResponse.ok) {
      throw new Error(`AI 模型配置初始化失败：${configResponse.status} ${await configResponse.text()}`)
    }
  }
})

test.afterAll(async () => {
  await stopBackend()
  if (ttsProvider) await new Promise((resolve) => ttsProvider.close(resolve))
  if (imageProvider) await new Promise((resolve) => imageProvider.close(resolve))
  if (videoProvider) await new Promise((resolve) => videoProvider.close(resolve))
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
})

test('独立项目画布图片节点通过真实后端同链路生成、入库并刷新恢复', async ({ page }) => {
  const forwardedRequests = []
  const failedResponses = []
  const providerRequestOffset = imageProviderRequests.length
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const source = new URL(request.url())
    forwardedRequests.push(`${request.method()} ${source.pathname}`)
    const response = await route.fetch({
      url: `${backendOrigin}${source.pathname}${source.search}`,
    })
    if (!response.ok()) {
      failedResponses.push({
        method: request.method(),
        path: source.pathname,
        status: response.status(),
        body: await response.text(),
      })
    }
    await route.fulfill({ response })
  })
  await page.route('**/static/**', async (route) => {
    const source = new URL(route.request().url())
    const response = await route.fetch({
      url: `${backendOrigin}${source.pathname}${source.search}`,
    })
    await route.fulfill({ response })
  })

  await page.goto(`/canvas/${standaloneDramaId}`)

  await expect(page.getByRole('banner').getByText('真实后端独立画布', { exact: true })).toBeVisible()
  await expect(page.getByRole('banner')).not.toContainText('集')
  const nodeId = 'free:image:same-chain'
  const node = page.locator(`.vue-flow__node[data-id="${nodeId}"]`)
  await expect(node).toContainText('真实图片节点')
  await node.getByRole('button', { name: '配置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑图片节点' })
  await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder('描述希望生成的图片内容').fill('雨夜花园里一朵白色茉莉花，电影光影')
  await dialog.getByPlaceholder('留空使用系统默认模型').fill('canvas-image-alpha')
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(dialog).toBeHidden()
  await node.getByRole('button', { name: '生成', exact: true }).click()

  await expect.poll(() => imageProviderRequests.length - providerRequestOffset).toBe(1)
  expect(imageProviderRequests[providerRequestOffset]).toMatchObject({
    model: 'canvas-image-alpha',
    prompt: expect.stringContaining('白色茉莉花'),
  })

  await expect.poll(() => readDatabase((db) => {
    const image = db.prepare(
      `SELECT id, drama_id, storyboard_id, model, prompt, status, task_id, image_url, local_path
       FROM image_generations
       WHERE drama_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(standaloneDramaId)
    const task = image?.task_id
      ? db.prepare('SELECT id, type, resource_id, status, error, result FROM async_tasks WHERE id = ?').get(image.task_id)
      : null
    const asset = db.prepare(
      `SELECT id, drama_id, storyboard_id, category, type, url, metadata
       FROM assets
       WHERE drama_id = ? AND category = 'canvas-result' ORDER BY id DESC LIMIT 1`,
    ).get(standaloneDramaId)
    const metadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(standaloneDramaId).metadata)
    const freeNode = metadata.canvas_layout?.free_nodes?.find((item) => item.id === nodeId)
    return {
      image,
      task,
      asset: asset ? { ...asset, metadata: JSON.parse(asset.metadata || '{}') } : null,
      freeNode,
    }
  }), { timeout: 10_000 }).toMatchObject({
    image: {
      drama_id: standaloneDramaId,
      storyboard_id: null,
      model: 'canvas-image-alpha',
      prompt: '雨夜花园里一朵白色茉莉花，电影光影',
      status: 'completed',
      task_id: expect.any(String),
      image_url: expect.stringMatching(/^\/static\//),
      local_path: expect.stringMatching(/^projects\/.+\/images\//),
    },
    task: {
      type: 'image_generation',
      resource_id: String(standaloneDramaId),
      status: 'completed',
      error: null,
      result: expect.stringContaining('"image_generation_id"'),
    },
    asset: {
      drama_id: standaloneDramaId,
      storyboard_id: null,
      category: 'canvas-result',
      type: 'image',
      url: expect.stringMatching(/^\/static\//),
      metadata: {
        canvas_node_id: nodeId,
        task_id: expect.any(String),
        model: 'canvas-image-alpha',
      },
    },
    freeNode: {
      id: nodeId,
      data: expect.objectContaining({
        kind: 'image',
        status: 'success',
        url: expect.stringMatching(/^\/static\//),
        taskId: expect.any(String),
        savedAssetId: expect.any(String),
        assetSaveStatus: 'success',
      }),
    },
  })

  await expect(node).toContainText('已生成')
  await expect(node.locator('img[alt="真实图片节点"]')).toBeVisible()
  await page.reload()
  const restored = page.locator(`.vue-flow__node[data-id="${nodeId}"]`)
  await expect(restored).toContainText('已生成')
  await expect(restored.locator('img[alt="真实图片节点"]')).toBeVisible()

  expect(failedResponses).toEqual([])
  expect(forwardedRequests).toEqual(expect.arrayContaining([
    `GET /api/v1/dramas/${standaloneDramaId}`,
    'POST /api/v1/images',
    'POST /api/v1/assets',
    `PUT /api/v1/dramas/${standaloneDramaId}/canvas-layout`,
  ]))
  expect(forwardedRequests.some((request) => /^GET \/api\/v1\/tasks\/[^/]+$/.test(request))).toBe(true)
})

test('独立项目画布视频节点使用上游首帧，异步失败可重试并完成入库恢复', async ({ page }) => {
  const forwardedRequests = []
  const failedResponses = []
  const providerRequestOffset = videoProviderRequests.length
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const source = new URL(request.url())
    forwardedRequests.push(`${request.method()} ${source.pathname}`)
    const response = await route.fetch({
      url: `${backendOrigin}${source.pathname}${source.search}`,
    })
    if (!response.ok()) {
      failedResponses.push({
        method: request.method(),
        path: source.pathname,
        status: response.status(),
        body: await response.text(),
      })
    }
    await route.fulfill({ response })
  })
  await page.route('**/static/**', async (route) => {
    const source = new URL(route.request().url())
    const response = await route.fetch({
      url: `${backendOrigin}${source.pathname}${source.search}`,
    })
    await route.fulfill({ response })
  })

  await page.goto(`/canvas/${standaloneDramaId}`)
  const imageNode = page.locator('.vue-flow__node[data-id="free:image:same-chain"]')
  const videoNodeId = 'free:video:same-chain'
  const videoNode = page.locator(`.vue-flow__node[data-id="${videoNodeId}"]`)
  const upstreamImageUrl = await imageNode.locator('img[alt="真实图片节点"]').getAttribute('src')
  expect(upstreamImageUrl).toMatch(/^\/static\//)

  await videoNode.getByRole('button', { name: '配置', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '编辑视频节点' })
  await dialog.getByPlaceholder('描述希望生成的视频内容').fill('模拟失败：镜头缓慢推近白色茉莉花')
  await dialog.getByPlaceholder('留空使用系统默认模型').fill('seedance-2.0-720p')
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click()
  await videoNode.getByRole('button', { name: '生成', exact: true }).click()

  await expect(videoNode.locator('.node-status')).toHaveText('失败', { timeout: 30_000 })
  await expect(videoNode).toContainText('本地供应商模拟失败')
  const failedRequest = videoProviderRequests[providerRequestOffset]
  expect(failedRequest.body).toMatchObject({
    model: 'seedance-2.0-720p',
    prompt: expect.stringContaining('模拟失败'),
  })
  expect(failedRequest.body.first_image_url).toBe(failedRequest.body.reference_image_urls[0])
  expect(failedRequest.body.first_image_url).toMatch(/^https?:\/\//)

  await videoNode.getByRole('button', { name: '配置', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '编辑视频节点' })
  await dialog.getByPlaceholder('描述希望生成的视频内容').fill('镜头缓慢推近白色茉莉花，单镜头连续运动')
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click()
  await videoNode.getByRole('button', { name: '重试', exact: true }).click()

  await expect.poll(() => videoProviderRequests.length - providerRequestOffset).toBe(2)
  const successfulRequest = videoProviderRequests[providerRequestOffset + 1]
  await expect.poll(
    () => videoProviderTasks.get(successfulRequest.taskId)?.polls,
    { timeout: 20_000 },
  ).toBe(1)
  await expect.poll(() => readDatabase((db) => (
    db.prepare(
      `SELECT status FROM video_generations
       WHERE provider_task_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(successfulRequest.taskId)?.status
  ))).toBe('processing')

  await page.reload()
  const resumedVideoNode = page.locator(`.vue-flow__node[data-id="${videoNodeId}"]`)
  await expect(resumedVideoNode.locator('.node-status')).toHaveText('运行中')
  await expect(resumedVideoNode.locator('.node-status')).toHaveText('已生成', { timeout: 30_000 })
  await expect(resumedVideoNode.locator('video')).toBeVisible()

  expect(successfulRequest.body).toMatchObject({
    model: 'seedance-2.0-720p',
    prompt: expect.stringContaining('单镜头连续运动'),
  })
  expect(successfulRequest.body.first_image_url).toBe(successfulRequest.body.reference_image_urls[0])
  expect(successfulRequest.body.first_image_url).toMatch(/^https?:\/\//)
  expect(videoProviderTasks.get(successfulRequest.taskId)?.polls).toBeGreaterThanOrEqual(2)

  await expect.poll(() => readDatabase((db) => {
    const generations = db.prepare(
      `SELECT id, drama_id, storyboard_id, model, prompt, first_frame_url, reference_image_urls,
              status, task_id, provider_task_id, video_url, local_path, error_msg
       FROM video_generations
       WHERE drama_id = ? ORDER BY id`,
    ).all(standaloneDramaId)
    const completed = generations.find((item) => item.status === 'completed')
    const task = completed?.task_id
      ? db.prepare('SELECT id, type, resource_id, status, error, result FROM async_tasks WHERE id = ?').get(completed.task_id)
      : null
    const asset = db.prepare(
      `SELECT id, drama_id, storyboard_id, category, type, url, metadata
       FROM assets
       WHERE drama_id = ? AND category = 'canvas-result' AND type = 'video'
       ORDER BY id DESC LIMIT 1`,
    ).get(standaloneDramaId)
    const metadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(standaloneDramaId).metadata)
    const freeNode = metadata.canvas_layout?.free_nodes?.find((item) => item.id === videoNodeId)
    return {
      generations,
      completed,
      task,
      asset: asset ? { ...asset, metadata: JSON.parse(asset.metadata || '{}') } : null,
      freeNode,
    }
  }), { timeout: 10_000 }).toMatchObject({
    generations: [
      expect.objectContaining({
        drama_id: standaloneDramaId,
        storyboard_id: null,
        status: 'failed',
        provider_task_id: expect.any(String),
        error_msg: expect.stringContaining('本地供应商模拟失败'),
      }),
      expect.objectContaining({
        drama_id: standaloneDramaId,
        storyboard_id: null,
        status: 'completed',
        provider_task_id: successfulRequest.taskId,
      }),
    ],
    completed: {
      drama_id: standaloneDramaId,
      storyboard_id: null,
      model: 'seedance-2.0-720p',
      prompt: '镜头缓慢推近白色茉莉花，单镜头连续运动',
      first_frame_url: upstreamImageUrl,
      reference_image_urls: JSON.stringify([upstreamImageUrl]),
      status: 'completed',
      task_id: expect.any(String),
      provider_task_id: successfulRequest.taskId,
      video_url: expect.stringMatching(/\/output\.mp4$/),
      local_path: expect.stringMatching(/^projects\/.+\/videos\//),
      error_msg: null,
    },
    task: {
      type: 'video_generation',
      resource_id: String(standaloneDramaId),
      status: 'completed',
      error: null,
      result: expect.stringContaining('"video_generation_id"'),
    },
    asset: {
      drama_id: standaloneDramaId,
      storyboard_id: null,
      category: 'canvas-result',
      type: 'video',
      url: expect.stringMatching(/\/output\.mp4$/),
      metadata: {
        canvas_node_id: videoNodeId,
        task_id: expect.any(String),
        model: 'seedance-2.0-720p',
      },
    },
    freeNode: {
      id: videoNodeId,
      data: expect.objectContaining({
        kind: 'video',
        status: 'success',
        url: expect.stringMatching(/\/output\.mp4$/),
        taskId: expect.any(String),
        savedAssetId: expect.any(String),
        assetSaveStatus: 'success',
      }),
    },
  })

  await page.reload()
  const restored = page.locator(`.vue-flow__node[data-id="${videoNodeId}"]`)
  await expect(restored).toContainText('已生成')
  await expect(restored.locator('video')).toBeVisible()
  expect(failedResponses).toEqual([])
  expect(forwardedRequests).toEqual(expect.arrayContaining([
    'POST /api/v1/videos',
    'POST /api/v1/assets',
    `PUT /api/v1/dramas/${standaloneDramaId}/canvas-layout`,
  ]))
  expect(forwardedRequests.some((request) => /^GET \/api\/v1\/tasks\/[^/]+$/.test(request))).toBe(true)
})

test('项目画布通过真实后端持久化节点操作、连线和素材指派', async ({ page }) => {
  const forwardedRequests = []
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const source = new URL(request.url())
    forwardedRequests.push(`${request.method()} ${source.pathname}`)
    const response = await route.fetch({
      url: `${backendOrigin}${source.pathname}${source.search}`,
    })
    await route.fulfill({ response })
  })

  await page.goto(`/film/${dramaId}/canvas`)

  await expect(page.getByRole('banner').getByText('真实后端项目画布', { exact: true })).toBeVisible()
  const sourceNode = page.locator(`.vue-flow__node[data-id="sb:${storyboardId}"]`)
  await expect(sourceNode).toContainText('雨夜相遇')
  await expect(page.getByText('小茉', { exact: true })).toBeVisible()
  await expect(page.getByText('雨夜车站', { exact: true })).toBeVisible()
  await expect(page.getByText('红伞', { exact: true })).toBeVisible()

  await clickNodeAction(page, sourceNode, /复制分镜/)
  await expect.poll(() => readDatabase((db) => db.prepare(
    'SELECT COUNT(*) AS count FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL',
  ).get(episodeId).count)).toBe(2)
  await expect(page.getByText('雨夜相遇 副本', { exact: true })).toBeVisible()

  await clickNodeAction(page, sourceNode, /追加下游分镜/)
  await expect.poll(() => readDatabase((db) => db.prepare(
    'SELECT COUNT(*) AS count FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL',
  ).get(episodeId).count)).toBe(3)
  await expect(page.getByText('下游分镜 3', { exact: true })).toBeVisible()

  await clickNodeAction(page, sourceNode, /插入下游分镜/)
  await expect.poll(() => readDatabase((db) => db.prepare(
    'SELECT COUNT(*) AS count FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL',
  ).get(episodeId).count)).toBe(4)
  await expect(page.getByText('插入分镜 4', { exact: true })).toBeVisible()

  const savedState = readDatabase((db) => {
    const metadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(dramaId).metadata)
    const created = db.prepare(
      `SELECT id, title FROM storyboards
       WHERE episode_id = ? AND deleted_at IS NULL AND id != ? ORDER BY id ASC`,
    ).all(episodeId, storyboardId)
    return { metadata, created }
  })
  const appended = savedState.created.find((item) => item.title === '下游分镜 3')
  const inserted = savedState.created.find((item) => item.title === '插入分镜 4')
  expect(appended).toBeTruthy()
  expect(inserted).toBeTruthy()
  expect(savedState.metadata.canvas_layout.manual_edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: `sb:${storyboardId}`, target: `sb:${inserted.id}` }),
    expect.objectContaining({ source: `sb:${inserted.id}`, target: `sb:${appended.id}` }),
  ]))
  expect(savedState.metadata.canvas_layout.manual_edges).not.toContainEqual(expect.objectContaining({
    source: `sb:${storyboardId}`,
    target: `sb:${appended.id}`,
  }))

  await sourceNode.dispatchEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
  })
  await expect(sourceNode).toHaveClass(/selected/)
  const pane = page.locator('.vue-flow__pane')
  await pane.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      buttons: 2,
      clientX: rect.right - 80,
      clientY: rect.bottom - 80,
    }))
  })
  const menu = page.getByRole('menu', { name: '添加画布节点' })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: /素材库/ }).click()

  const picker = page.getByRole('dialog', { name: '从素材库加入画布' })
  await expect(picker).toBeVisible()
  const assetCard = picker.locator('.picker-card').filter({ hasText: '雨夜站台参考' })
  await expect(assetCard).toBeVisible()
  await assetCard.getByRole('button', { name: '选用', exact: true }).click()

  await expect.poll(() => readDatabase((db) => db.prepare(
    `SELECT id, name, storyboard_id, category FROM assets
     WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
  ).get(dramaId))).toEqual(expect.objectContaining({
    name: '雨夜站台参考',
    storyboard_id: storyboardId,
    category: 'canvas-library-pick',
  }))
  const assignedAsset = readDatabase((db) => db.prepare(
    'SELECT id FROM assets WHERE drama_id = ? AND storyboard_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
  ).get(dramaId, storyboardId))
  const assetNode = page.locator(`.vue-flow__node[data-id="project-asset:${assignedAsset.id}"]`)
  await expect(assetNode).toContainText('雨夜站台参考')
  await expect(assetNode).toContainText(`已指派到分镜 #${storyboardId}`)

  await page.reload()

  await expect(page.locator(`.vue-flow__node[data-id="sb:${inserted.id}"]`)).toContainText('插入分镜 4')
  await expect(page.locator(`.vue-flow__node[data-id="sb:${appended.id}"]`)).toContainText('下游分镜 3')
  await expect(page.locator(`.vue-flow__edge[data-id^="manual:sb:${storyboardId}:"][data-id$=":sb:${inserted.id}:in"]`)).toBeAttached()
  await expect(page.locator(`.vue-flow__edge[data-id^="manual:sb:${inserted.id}:"][data-id$=":sb:${appended.id}:in"]`)).toBeAttached()
  await expect(page.locator(`.vue-flow__node[data-id="project-asset:${assignedAsset.id}"]`)).toContainText('雨夜站台参考')

  expect(forwardedRequests).toEqual(expect.arrayContaining([
    `GET /api/v1/dramas/${dramaId}`,
    'POST /api/v1/storyboards',
    `PUT /api/v1/dramas/${dramaId}/canvas-layout`,
    'POST /api/v1/assets',
    `PUT /api/v1/assets/${assignedAsset.id}`,
  ]))
})

test('项目画布通过真实后端保存节点配置并在刷新后恢复', async ({ page }) => {
  const forwardedRequests = []
  const failedResponses = []
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const source = new URL(request.url())
    forwardedRequests.push(`${request.method()} ${source.pathname}`)
    const response = await route.fetch({
      url: `${backendOrigin}${source.pathname}${source.search}`,
    })
    if (!response.ok()) {
      failedResponses.push({
        method: request.method(),
        path: source.pathname,
        status: response.status(),
        body: await response.text(),
      })
    }
    await route.fulfill({ response })
  })

  await page.goto(`/film/${dramaId}/canvas`)

  const sourceNode = page.locator(`.vue-flow__node[data-id="sb:${storyboardId}"]`)
  await sourceNode.dispatchEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
  })
  await expect(sourceNode).toHaveClass(/selected/)
  const panel = page.locator('.canvas-node-panel.sb-panel')
  await expect(panel).toBeVisible()

  await panel.getByPlaceholder('分镜标题').fill('雨夜配置闭环')
  await panel.getByPlaceholder('分镜标题').blur()
  await panel.getByPlaceholder('画面动作').fill('小茉收起红伞，向站台灯光走去。')
  await panel.getByPlaceholder('角色对白').fill('小茉：终于等到你了。')
  await panel.getByPlaceholder('图片提示词').fill('雨夜站台，蓝色外套少女收起红伞，电影光影。')
  await panel.getByPlaceholder('视频提示词').fill('镜头缓慢推进，小茉收伞后抬头，雨滴从伞沿滑落。')

  const cameraSelects = panel.locator('.camera-control-grid .el-select')
  await expect(cameraSelects).toHaveCount(5)
  await cameraSelects.nth(0).click()
  await page.getByRole('option', { name: '前左 45°' }).click()
  await cameraSelects.nth(1).click()
  await page.getByRole('option', { name: '低角度仰拍' }).click()
  await cameraSelects.nth(2).click()
  await page.getByRole('option', { name: '近景/特写' }).click()
  await cameraSelects.nth(3).click()
  await page.getByRole('option', { name: '黄金时段' }).click()
  await cameraSelects.nth(4).click()
  await page.getByRole('option', { name: '四宫格', exact: true }).click()

  const generation = panel.locator('.generation-section')
  const generationSelects = generation.locator('.el-select')
  await expect(generationSelects).toHaveCount(5)
  await generationSelects.nth(0).click()
  await page.getByRole('option', { name: 'canvas-image-beta' }).click()
  await generationSelects.nth(1).click()
  await page.getByRole('option', { name: 'canvas-video-beta' }).click()
  await generationSelects.nth(2).click()
  await page.getByRole('option', { name: 'canvas-tts-beta' }).click()
  await generationSelects.nth(3).click()
  await page.getByRole('option', { name: '9:16 竖屏' }).click()
  await generationSelects.nth(4).click()
  await page.getByRole('option', { name: '720p 高清' }).click()
  const durationInput = generation.locator('.duration-input input')
  await durationInput.fill('9')
  await durationInput.press('Enter')

  await panel.getByRole('button', { name: '保存', exact: true }).click()

  await expect.poll(() => readDatabase((db) => {
    const storyboard = db.prepare(
      `SELECT title, action, dialogue, image_prompt, video_prompt, angle_h, angle_v,
              angle_s, lighting_style, grid_frame_type, image_model, video_model, audio_model, duration
       FROM storyboards WHERE id = ?`,
    ).get(storyboardId)
    const metadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(dramaId).metadata)
    return { storyboard, metadata }
  })).toEqual({
    storyboard: {
      title: '雨夜配置闭环',
      action: '小茉收起红伞，向站台灯光走去。',
      dialogue: '小茉：终于等到你了。',
      image_prompt: '雨夜站台，蓝色外套少女收起红伞，电影光影。',
      video_prompt: expect.stringContaining('镜头缓慢推进，小茉收伞后抬头，雨滴从伞沿滑落。'),
      angle_h: 'front_left',
      angle_v: 'low',
      angle_s: 'close_up',
      lighting_style: 'golden_hour',
      grid_frame_type: 'quad_grid',
      image_model: 'canvas-image-beta',
      video_model: 'canvas-video-beta',
      audio_model: 'canvas-tts-beta',
      duration: 9,
    },
    metadata: expect.objectContaining({
      aspect_ratio: '9:16',
      video_resolution: '720p',
    }),
  })

  await page.evaluate(({ storageKey, nodeId }) => {
    window.localStorage.setItem(storageKey, JSON.stringify({
      [nodeId]: {
        step: 'success',
        message: '本镜生成参数已保存',
        resultType: 'text',
        at: Date.now(),
      },
    }))
  }, {
    storageKey: `moli_canvas_node_status:${dramaId}`,
    nodeId: `sb:${storyboardId}`,
  })

  await page.reload()
  await sourceNode.dispatchEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
  })
  await expect(sourceNode).toHaveClass(/selected/)
  await expect(panel.getByPlaceholder('分镜标题')).toHaveValue('雨夜配置闭环')
  await expect(panel.getByPlaceholder('画面动作')).toHaveValue('小茉收起红伞，向站台灯光走去。')
  await expect(panel.getByPlaceholder('角色对白')).toHaveValue('小茉：终于等到你了。')
  await expect(panel.getByPlaceholder('图片提示词')).toHaveValue('雨夜站台，蓝色外套少女收起红伞，电影光影。')
  await expect(panel.getByPlaceholder('视频提示词')).toHaveValue(/镜头缓慢推进，小茉收伞后抬头，雨滴从伞沿滑落。/)
  await expect(panel.getByPlaceholder('视频提示词')).toHaveValue(/VOICE CONTINUITY/)
  await expect(panel.locator('.camera-control-grid')).toContainText('前左 45°')
  await expect(panel.locator('.camera-control-grid')).toContainText('低角度仰拍')
  await expect(panel.locator('.camera-control-grid')).toContainText('近景/特写')
  await expect(panel.locator('.camera-control-grid')).toContainText('黄金时段')
  await expect(generation).toContainText('canvas-image-beta')
  await expect(generation).toContainText('canvas-video-beta')
  await expect(generation).toContainText('canvas-tts-beta')
  await expect(generation).toContainText('9:16 竖屏')
  await expect(generation).toContainText('720p 高清')
  await expect(durationInput).toHaveValue('9')
  const audioButton = panel.getByRole('button', { name: '配音', exact: true })
  await expect(audioButton).toBeEnabled()
  await audioButton.click()
  await expect.poll(() => ttsProviderRequests.at(-1)).toEqual(expect.objectContaining({
    model: 'canvas-tts-beta',
    input: '小茉：终于等到你了。',
  }))
  await expect.poll(() => ({
    audioLocalPath: readDatabase((db) => db.prepare(
      'SELECT audio_local_path FROM storyboards WHERE id = ?',
    ).get(storyboardId).audio_local_path),
    failedResponses,
  })).toEqual({
    audioLocalPath: expect.stringMatching(/^audio\/tts_sb/),
    failedResponses: [],
  })

  expect(forwardedRequests).toEqual(expect.arrayContaining([
    `GET /api/v1/dramas/${dramaId}`,
    `PUT /api/v1/storyboards/${storyboardId}`,
    `PUT /api/v1/dramas/${dramaId}/outline`,
    'POST /api/v1/audio/extract',
  ]))
})

test('3D 导演台通过真实后端保存镜头与角色动作并在刷新后恢复', async ({ page }) => {
  const forwardedRequests = []
  const forwardedResponses = []
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const source = new URL(request.url())
    forwardedRequests.push(`${request.method()} ${source.pathname}`)
    const response = await route.fetch({
      url: `${backendOrigin}${source.pathname}${source.search}`,
    })
    forwardedResponses.push({ path: source.pathname, status: response.status() })
    await route.fulfill({ response })
  })

  const readDirectorTimeline = () => readDatabase((db) => {
    const metadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(dramaId).metadata)
    return metadata.canvas_layout?.director_timeline || null
  })

  await page.goto(`/film/${dramaId}/canvas`)
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  await page.getByRole('button', { name: '动画时间轴' }).click()

  const shotEditor = page.locator('.shot-editor')
  const shotName = shotEditor.getByRole('textbox', { name: '名称' })
  await shotName.fill('真实持久化镜头')
  await shotName.press('Tab')
  await expect.poll(() => readDirectorTimeline()?.shots?.[0]?.name).toBe('真实持久化镜头')

  await shotEditor.getByRole('combobox', { name: '转场', exact: true }).selectOption('dissolve')
  await expect.poll(() => readDirectorTimeline()?.shots?.[0]?.transition).toBe('dissolve')
  const transitionDuration = shotEditor.getByRole('spinbutton', { name: '转场时长（秒）' })
  await transitionDuration.fill('0.5')
  await transitionDuration.press('Tab')
  await expect.poll(() => readDirectorTimeline()?.shots?.[0]?.transitionDuration).toBe(0.5)

  await page.getByLabel('时间线位置').fill('2')
  await shotEditor.getByRole('button', { name: '在播放头切开镜头' }).click()
  await expect.poll(() => readDirectorTimeline()?.shots?.map((shot) => ({
    name: shot.name,
    start: shot.start,
    duration: shot.duration,
    transition: shot.transition,
  }))).toEqual([
    { name: '真实持久化镜头', start: 0, duration: 2, transition: 'dissolve' },
    { name: '真实持久化镜头（后段）', start: 2, duration: 2, transition: 'cut' },
  ])

  await page.getByLabel('选择动作').selectOption('Wave')
  await page.locator('.action-editor').getByRole('button', { name: '添加', exact: true }).click()
  await expect.poll(() => readDirectorTimeline()?.tracks?.flatMap((track) => track.clips).find((clip) => clip.action === 'Wave')?.action).toBe('Wave')
  await page.getByLabel('动作片段开始时间').fill('1.25')
  await page.getByLabel('动作片段开始时间').press('Tab')
  await page.getByLabel('动作片段时长').fill('1.5')
  await page.getByLabel('动作片段时长').press('Tab')

  await expect.poll(() => {
    const timeline = readDirectorTimeline()
    const track = timeline?.tracks?.find((entry) => entry.characterId === String(characterId))
    return {
      shot: timeline?.shots?.[0],
      cutShot: timeline?.shots?.[1],
      track,
      clip: track?.clips?.find((clip) => clip.action === 'Wave'),
    }
  }).toEqual({
    shot: expect.objectContaining({
      name: '真实持久化镜头',
      transition: 'dissolve',
      transitionDuration: 0.5,
      start: 0,
    }),
    cutShot: expect.objectContaining({
      name: '真实持久化镜头（后段）',
      transition: 'cut',
      transitionDuration: 0,
      start: 2,
      duration: 2,
    }),
    track: expect.objectContaining({
      characterId: String(characterId),
    }),
    clip: expect.objectContaining({
      characterId: String(characterId),
      action: 'Wave',
      start: 1.25,
      duration: 1.5,
    }),
  })

  const dramaReadsBeforeReload = forwardedRequests.filter((entry) => entry === `GET /api/v1/dramas/${dramaId}`).length
  await page.getByRole('button', { name: '关闭导演台' }).click()
  await page.reload()
  await expect.poll(() => forwardedRequests.filter((entry) => entry === `GET /api/v1/dramas/${dramaId}`).length).toBeGreaterThan(dramaReadsBeforeReload)
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  await page.getByRole('button', { name: '动画时间轴' }).click()

  await expect(page.locator('.shot-list-item')).toHaveCount(2)
  await expect(page.locator('.shot-list-item').first()).toContainText('真实持久化镜头')
  await expect(page.locator('.shot-list-item').nth(1)).toContainText('真实持久化镜头（后段）')
  await page.locator('.shot-list-item').first().click()
  await expect(shotEditor.getByRole('textbox', { name: '名称' })).toHaveValue('真实持久化镜头')
  await expect(shotEditor.getByRole('combobox', { name: '转场', exact: true })).toHaveValue('dissolve')
  await expect(shotEditor.getByRole('spinbutton', { name: '转场时长（秒）' })).toHaveValue('0.5')
  await page.getByRole('button', { name: '小茉 Wave 动作片段' }).click()
  await expect(page.getByLabel('动作片段开始时间')).toHaveValue('1.25')
  await expect(page.getByLabel('动作片段时长')).toHaveValue('1.5')

  expect(forwardedRequests).toEqual(expect.arrayContaining([
    `GET /api/v1/dramas/${dramaId}`,
    `PUT /api/v1/dramas/${dramaId}/canvas-layout`,
  ]))
  expect(forwardedResponses.every(({ status }) => status >= 200 && status < 300)).toBe(true)
})

test('3D 导演台通过真实后端上传 CC0 角色资产并从素材库刷新恢复', async ({ page }) => {
  const forwardedResponses = []
  const modelResponses = []
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const source = new URL(request.url())
    const response = await route.fetch({
      url: `${backendOrigin}${source.pathname}${source.search}`,
    })
    forwardedResponses.push({ method: request.method(), path: source.pathname, status: response.status() })
    await route.fulfill({ response })
  })
  await page.route(/\/static\/.*\.glb(?:\?|$)/, async (route) => {
    const source = new URL(route.request().url())
    const response = await route.fetch({
      url: `${backendOrigin}${source.pathname}${source.search}`,
    })
    modelResponses.push(response.status())
    await route.fulfill({ response })
  })

  const readDirectorTimeline = () => readDatabase((db) => {
    const metadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(dramaId).metadata)
    return metadata.canvas_layout?.director_timeline || null
  })
  const validationGlb = embeddedGltfToGlb(fs.readFileSync(simpleSkinGltfPath, 'utf8'))
  expect(validationGlb.subarray(0, 4).toString('utf8')).toBe('glTF')

  await page.goto(`/film/${dramaId}/canvas`)
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  await page.getByRole('button', { name: '动画时间轴' }).click()
  await page.getByLabel('上传角色模型').setInputFiles({
    name: 'khronos-simple-skin.glb',
    mimeType: 'model/gltf-binary',
    buffer: validationGlb,
  })
  await expect(page.locator('.resource-status').filter({ hasText: '角色模型已上传' })).toBeVisible()

  await expect.poll(() => readDatabase((db) => db.prepare(
    `SELECT id, name, type, category, url, local_path
     FROM assets WHERE drama_id = ? AND name = ? ORDER BY id DESC LIMIT 1`,
  ).get(dramaId, 'khronos-simple-skin.glb'))).toEqual(expect.objectContaining({
    name: 'khronos-simple-skin.glb',
    type: 'model',
    category: 'director',
    url: expect.stringMatching(/\/models\/[^/]+\.glb$/),
    local_path: expect.stringMatching(/\/models\/[^/]+\.glb$/),
  }))
  const asset = readDatabase((db) => db.prepare(
    'SELECT id, url, local_path FROM assets WHERE drama_id = ? AND name = ? ORDER BY id DESC LIMIT 1',
  ).get(dramaId, 'khronos-simple-skin.glb'))
  expect(fs.existsSync(path.join(tempRoot, 'storage', asset.local_path))).toBe(true)
  expect(fs.readFileSync(path.join(tempRoot, 'storage', asset.local_path)).subarray(0, 4).toString('utf8')).toBe('glTF')

  await expect.poll(() => readDirectorTimeline()?.characterAssets?.[String(characterId)]).toEqual(expect.objectContaining({
    modelAssetId: asset.id,
    modelUrl: asset.url,
  }))
  const librarySelect = page.locator('.resource-library select')
  await expect(librarySelect).toContainText('khronos-simple-skin.glb')
  await page.getByRole('button', { name: '加载 CC0 验证模型' }).click()
  await expect(page.getByLabel('角色模型 URL')).toHaveValue('/director-fixtures/khronos-simple-skin.gltf')
  await librarySelect.selectOption(String(asset.id))
  await page.getByRole('button', { name: '应用为模型' }).click()
  await expect(page.getByLabel('角色模型 URL')).toHaveValue(asset.url)
  await expect.poll(() => readDirectorTimeline()?.characterAssets?.[String(characterId)]).toEqual(expect.objectContaining({
    modelAssetId: asset.id,
    modelUrl: asset.url,
  }))

  await page.getByRole('button', { name: '加载模型' }).click()
  const modelStatus = page.locator('.resource-status--row').filter({ hasText: '模型：' })
  await expect(modelStatus).toContainText('可见网格 1 · 骨骼 2 · 动画 1')

  const dramaReadsBeforeReload = forwardedResponses.filter((entry) => (
    entry.method === 'GET' && entry.path === `/api/v1/dramas/${dramaId}`
  )).length
  await page.getByRole('button', { name: '关闭导演台' }).click()
  await page.reload()
  await expect.poll(() => forwardedResponses.filter((entry) => (
    entry.method === 'GET' && entry.path === `/api/v1/dramas/${dramaId}`
  )).length).toBeGreaterThan(dramaReadsBeforeReload)
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  await page.getByRole('button', { name: '动画时间轴' }).click()
  await expect(page.getByLabel('角色模型 URL')).toHaveValue(asset.url)
  await expect(page.locator('.resource-library select')).toContainText('khronos-simple-skin.glb')
  await expect(modelStatus).toContainText('可见网格 1 · 骨骼 2 · 动画 1')

  expect(forwardedResponses).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: 'POST', path: '/api/v1/upload/model', status: 200 }),
    expect.objectContaining({ method: 'PUT', path: `/api/v1/dramas/${dramaId}/canvas-layout`, status: 200 }),
    expect.objectContaining({ method: 'GET', path: '/api/v1/assets', status: 200 }),
  ]))
  expect(forwardedResponses.every(({ status }) => status >= 200 && status < 300)).toBe(true)
  expect(modelResponses.length).toBeGreaterThan(0)
  expect(modelResponses.every((status) => status >= 200 && status < 300)).toBe(true)
})

test('3D 导演台通过真实后端转码 MP4、登记视频资产并下载工件', async ({ page }) => {
  const forwardedResponses = []
  const staticResponses = []
  const validationWebmBase64 = validationWebm.toString('base64')
  await page.addInitScript(({ webmBase64 }) => {
    const bytes = Uint8Array.from(atob(webmBase64), (character) => character.charCodeAt(0))
    const track = { requestFrame() {}, stop() {} }
    HTMLCanvasElement.prototype.captureStream = () => ({
      getVideoTracks: () => [track],
      getTracks: () => [track],
    })
    class ValidationMediaRecorder {
      static isTypeSupported(type) {
        return String(type).startsWith('video/webm')
      }

      constructor() {
        this.state = 'inactive'
        this.onstop = null
        this.onerror = null
        this.ondataavailable = null
        this.emitted = false
      }

      start() {
        this.state = 'recording'
      }

      requestData() {
        if (this.emitted) return
        this.emitted = true
        this.ondataavailable?.({ data: new Blob([bytes], { type: 'video/webm' }) })
      }

      stop() {
        this.requestData()
        this.state = 'inactive'
        queueMicrotask(() => this.onstop?.())
      }
    }
    window.MediaRecorder = ValidationMediaRecorder
  }, { webmBase64: validationWebmBase64 })

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const source = new URL(request.url())
    const response = await route.fetch({
      url: `${backendOrigin}${source.pathname}${source.search}`,
    })
    forwardedResponses.push({ method: request.method(), path: source.pathname, status: response.status() })
    await route.fulfill({ response })
  })
  await page.route('**/static/**', async (route) => {
    const source = new URL(route.request().url())
    const response = await route.fetch({
      url: `${backendOrigin}${source.pathname}${source.search}`,
    })
    staticResponses.push({
      path: decodeURIComponent(source.pathname),
      status: response.status(),
      contentType: response.headers()['content-type'],
    })
    await route.fulfill({ response })
  })

  const taskIdsBefore = new Set(readDatabase((db) => db.prepare(
    "SELECT id FROM async_tasks WHERE type = 'director_export'",
  ).all().map((row) => row.id)))

  await page.goto(`/film/${dramaId}/canvas`)
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  await page.getByRole('button', { name: '动画时间轴' }).click()
  const shotItems = page.locator('.shot-list-item')
  for (let count = await shotItems.count(); count > 1; count -= 1) {
    await shotItems.last().click()
    await page.locator('.shot-editor').getByRole('button', { name: '删除镜头' }).click()
    await expect(shotItems).toHaveCount(count - 1)
  }
  await expect.poll(() => readDatabase((db) => {
    const metadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(dramaId).metadata)
    return metadata.canvas_layout?.director_timeline?.shots?.length
  })).toBe(1)

  await shotItems.first().click()
  const shotDuration = page.locator('.shot-editor').getByRole('spinbutton', { name: '时长（秒）', exact: true })
  await shotDuration.fill('0.25')
  await shotDuration.press('Tab')
  await expect.poll(() => readDatabase((db) => {
    const metadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(dramaId).metadata)
    return metadata.canvas_layout?.director_timeline?.sequence?.duration
  })).toBe(0.25)

  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  await page.getByRole('button', { name: '服务端导出 MP4' }).click()
  const download = await downloadPromise
  await expect(page.getByText('视频已导出（MP4）', { exact: true })).toBeVisible()
  expect(download.suggestedFilename()).toBe('真实后端项目画布.mp4')
  const downloadedPath = await download.path()
  expect(fs.readFileSync(downloadedPath).subarray(4, 8).toString('ascii')).toBe('ftyp')

  await expect.poll(() => readDatabase((db) => db.prepare(
    "SELECT id, status, error, result FROM async_tasks WHERE type = 'director_export' ORDER BY created_at DESC LIMIT 1",
  ).get()), { timeout: 30_000 }).toEqual(expect.objectContaining({
    status: 'completed',
    error: null,
    result: expect.any(String),
  }))
  const completedTask = readDatabase((db) => db.prepare(
    "SELECT id, status, error, result FROM async_tasks WHERE type = 'director_export' ORDER BY created_at DESC LIMIT 1",
  ).get())
  expect(taskIdsBefore.has(completedTask.id)).toBe(false)
  const result = JSON.parse(completedTask.result)
  expect(result).toEqual(expect.objectContaining({
    format: 'mp4',
    asset_id: expect.any(Number),
    local_path: expect.stringMatching(/\/videos\/director\/director_.*\.mp4$/),
    metadata_path: expect.stringMatching(/\/videos\/director\/director_.*\.json$/),
    timeline_summary: expect.objectContaining({
      duration: 0.25,
      shot_count: expect.any(Number),
      track_count: expect.any(Number),
      action_clip_count: expect.any(Number),
    }),
  }))

  const outputPath = path.join(tempRoot, 'storage', result.local_path)
  const metadataPath = path.join(tempRoot, 'storage', result.metadata_path)
  expect(fs.existsSync(outputPath)).toBe(true)
  expect(fs.readFileSync(outputPath).subarray(4, 8).toString('ascii')).toBe('ftyp')
  expect(fs.existsSync(metadataPath)).toBe(true)
  expect(JSON.parse(fs.readFileSync(metadataPath, 'utf8'))).toEqual(expect.objectContaining({
    drama_id: dramaId,
    task_id: completedTask.id,
    timeline_summary: expect.objectContaining({ duration: 0.25 }),
  }))
  expect(readDatabase((db) => db.prepare(
    'SELECT id, type, category, url, local_path, mime_type, file_size FROM assets WHERE id = ?',
  ).get(result.asset_id))).toEqual(expect.objectContaining({
    id: result.asset_id,
    type: 'video',
    category: 'director',
    url: expect.stringMatching(/\/videos\/director\/director_.*\.mp4$/),
    local_path: result.local_path,
    mime_type: 'video/mp4',
    file_size: expect.any(Number),
  }))

  expect(staticResponses.filter(({ path: responsePath }) => responsePath.endsWith('.mp4'))).toEqual([
    expect.objectContaining({
      path: `/static/${result.local_path}`,
      status: 200,
      contentType: expect.stringMatching(/^video\/mp4/),
    }),
  ])
  expect(forwardedResponses).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: 'POST', path: `/api/v1/dramas/${dramaId}/director/export`, status: 200 }),
    expect.objectContaining({ method: 'GET', path: expect.stringMatching(/^\/api\/v1\/tasks\//), status: 200 }),
  ]))
  expect(forwardedResponses.every(({ status }) => status >= 200 && status < 300)).toBe(true)
})
