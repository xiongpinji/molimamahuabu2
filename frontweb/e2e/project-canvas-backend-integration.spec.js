import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const backendRoot = fileURLToPath(new URL('../../backend-node/', import.meta.url))
const backendServer = path.join(backendRoot, 'src', 'server.js')
const Database = require(path.join(backendRoot, 'node_modules', 'better-sqlite3'))

let backendProcess
let backendOrigin
let backendLogs = ''
let databasePath
let dramaId
let episodeId
let storyboardId
let tempRoot

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

async function clickNodeAction(page, node, actionName) {
  await node.click({ button: 'right', position: { x: 24, y: 24 } })
  const menu = page.getByRole('menu', { name: '节点操作' })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: actionName }).click()
}

test.beforeAll(async () => {
  const port = await reservePort()
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-canvas-browser-backend-'))
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
    episodeId = Number(db.prepare(
      `INSERT INTO episodes (drama_id, episode_number, title, script_content, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?)`,
    ).run(dramaId, '第一集', '小茉在雨夜车站撑开红伞。', now, now).lastInsertRowid)
    const characterId = Number(db.prepare(
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
})

test.afterAll(async () => {
  await stopBackend()
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
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
