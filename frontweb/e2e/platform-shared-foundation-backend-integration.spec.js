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
const userAuth = require(path.join(backendRoot, 'src', 'services', 'userAuthService'))
const tenantService = require(path.join(backendRoot, 'src', 'services', 'tenantService'))
const creditLedger = require(path.join(backendRoot, 'src', 'services', 'creditLedgerService'))
const subscriptionBilling = require(path.join(backendRoot, 'src', 'services', 'subscriptionBillingService'))
const redeemCodes = require(path.join(backendRoot, 'src', 'services', 'redeem-code-service'))
const recharge = require(path.join(backendRoot, 'src', 'services', 'alipay-recharge-service'))
const modelPrices = require(path.join(backendRoot, 'src', 'services', 'modelPriceService'))

const FRONTEND_ORIGIN = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3013'
const JWT_SECRET = 'shared-foundation-browser-jwt-secret-value'
const ADMIN_TOKEN = 'shared-foundation-browser-admin-token'
const PASSWORD = 'SharedAcceptance!2026'
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

let backendProcess
let backendOrigin
let backendLogs = ''
let databasePath
let storagePath
let tempRoot
let tenantA
let tenantB
let dramaId
let redeemCode
const externalRequests = []

test.setTimeout(60_000)
test.use({ serviceWorkers: 'block' })
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

async function waitForHealth(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (backendProcess?.exitCode != null) {
      throw new Error(`公共底座真实后端提前退出（${backendProcess.exitCode}）\n${backendLogs}`)
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
  throw new Error(`公共底座真实后端未就绪：${lastError?.message || 'timeout'}\n${backendLogs}`)
}

async function stopBackend() {
  if (!backendProcess || backendProcess.exitCode != null) return
  const graceful = Promise.race([
    once(backendProcess, 'exit').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 3_000)),
  ])
  backendProcess.kill('SIGTERM')
  if (!await graceful && backendProcess.exitCode == null) {
    const forced = Promise.race([
      once(backendProcess, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])
    backendProcess.kill('SIGKILL')
    await forced
  }
}

function seedDatabase() {
  const db = new Database(databasePath)
  try {
    userAuth.ensureSchema(db)
    tenantService.ensureSchema(db)
    creditLedger.ensureSchema(db)
    subscriptionBilling.ensureSchema(db)
    redeemCodes.ensureSchema(db)
    recharge.ensureSchema(db)
    modelPrices.ensureSchema(db)

    const owner = userAuth.register(db, { email: 'owner@example.com', password: PASSWORD })
    const tenantAdmin = userAuth.register(db, { email: 'tenant-admin@example.com', password: PASSWORD })
    const member = userAuth.register(db, { email: 'member@example.com', password: PASSWORD })
    const otherOwner = userAuth.register(db, { email: 'other@example.com', password: PASSWORD })
    const platformAdmin = userAuth.register(db, { email: 'platform-admin@example.com', password: PASSWORD })
    db.prepare(`UPDATE platform_users SET role = 'admin', platform_role = 'admin'
      WHERE id = ?`).run(platformAdmin.id)

    tenantA = tenantService.createTenant(db, owner.id, {
      name: '公共底座验收团队',
      slug: 'shared-foundation-team',
    })
    tenantB = tenantService.createTenant(db, otherOwner.id, {
      name: '隔离团队',
      slug: 'isolated-team',
    })
    tenantService.addMemberByEmail(db, tenantA.id, owner.id, {
      email: tenantAdmin.email,
      role: 'admin',
    })
    tenantService.addMemberByEmail(db, tenantA.id, owner.id, {
      email: member.email,
      role: 'member',
    })
    creditLedger.setTenantAccountBalance(db, tenantA.id, 100)
    creditLedger.setTenantAccountBalance(db, tenantB.id, 50)

    redeemCode = redeemCodes.createCode(db, {
      label: '浏览器验收赠送',
      tenantId: tenantA.id,
      credits: 30,
      maxRedemptions: 1,
    }).code
    subscriptionBilling.upsertPlan(db, 'creator', {
      name: '创作版',
      description: '公共底座本地验收套餐',
      price_cents: 9900,
      monthly_credits: 1000,
      currency: 'CNY',
      status: 'active',
    })
    subscriptionBilling.upsertPlan(db, 'studio', {
      name: '工作室版',
      description: '幂等冲突验收套餐',
      price_cents: 19900,
      monthly_credits: 2500,
      currency: 'CNY',
      status: 'active',
    })
    recharge.createPackage(db, {
      name: '本地验收积分包',
      amount_yuan: '9.90',
      credits: 1200,
      image_url: '/static/uploads/recharge-packages/shared-foundation.png',
      ad_title: '本地展示，不发起支付',
      status: 'active',
    })
    modelPrices.set(db, 'gpt-image-2', 40, {
      displayName: '浏览器验收图片模型',
      publicNote: '仅用于公共目录脱敏验收',
      category: 'image',
      status: 'enabled',
      costUnit: 'image',
      cost_micros_per_unit: 12345,
      resolution_prices: {
        '2k': { credits: 40, cost_micros_per_unit: 12345 },
      },
    })

    const now = new Date().toISOString()
    dramaId = Number(db.prepare(`INSERT INTO dramas
      (title, style, status, metadata, user_id, tenant_id, created_at, updated_at)
      VALUES (?, 'realistic', 'draft', ?, ?, ?, ?, ?)`)
      .run(
        '公共底座素材项目',
        JSON.stringify({ project_type: 'canvas', aspect_ratio: '16:9' }),
        owner.id,
        tenantA.id,
        now,
        now,
      ).lastInsertRowid)
  } finally {
    db.close()
  }
}

async function installBackendGate(page) {
  externalRequests.length = 0
  const frontend = new URL(FRONTEND_ORIGIN)
  const backend = new URL(backendOrigin)
  await page.context().route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin === frontend.origin && url.pathname.startsWith('/api/v1/')) {
      const response = await route.fetch({ url: `${backend.origin}${url.pathname}${url.search}` })
      await route.fulfill({ response })
      return
    }
    if (url.origin === frontend.origin && url.pathname.startsWith('/static/')) {
      const response = await route.fetch({ url: `${backend.origin}${url.pathname}${url.search}` })
      await route.fulfill({ response })
      return
    }
    if (url.origin === frontend.origin || url.origin === backend.origin
        || url.protocol === 'data:' || url.protocol === 'blob:') {
      await route.continue()
      return
    }
    externalRequests.push({ method: request.method(), url: `${url.origin}${url.pathname}` })
    await route.abort('blockedbyclient')
  })
}

async function loginFromRedirect(page, target, email) {
  await page.goto(target)
  await expect(page).toHaveURL(/\/login\?redirect=/)
  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').fill(PASSWORD)
  await page.getByRole('button', { name: '登录平台' }).click()
  const expected = new URL(target, FRONTEND_ORIGIN)
  await expect(page).toHaveURL((url) => url.pathname === expected.pathname
    && [...expected.searchParams].every(([key, value]) => url.searchParams.get(key) === value))
  await expect.poll(() => page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem('moli_mama_session') || '{}')
    return session.user?.email || ''
  })).toBe(email)
}

async function browserApi(page, endpoint, options = {}) {
  return page.evaluate(async ({ endpoint: url, options: input }) => {
    const session = JSON.parse(localStorage.getItem('moli_mama_session') || '{}')
    const tenantId = localStorage.getItem('moli_mama_tenant_id') || ''
    const headers = {
      Authorization: `Bearer ${session.token || ''}`,
      'X-Tenant-Id': tenantId,
      ...(input.headers || {}),
    }
    if (input.body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetch(`/api/v1${url}`, {
      method: input.method || 'GET',
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      sessionUserId: session.user?.id || null,
      tenantId,
    }
  }, { endpoint, options })
}

function containsSensitiveIdentity(value) {
  const sensitive = /(provider|protocol|config.?id|upstream|relay|evidence|cost|credential|secret|token|password|api.?key|base.?url|hostname|domain|endpoint)/i
  if (Array.isArray(value)) return value.some(containsSensitiveIdentity)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => sensitive.test(key) || containsSensitiveIdentity(child))
}

async function assertNoHorizontalLeak(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }))
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport)
}

test.beforeAll(async () => {
  const port = await reservePort()
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moli-shared-foundation-browser-'))
  databasePath = path.join(tempRoot, 'shared-foundation.sqlite')
  storagePath = path.join(tempRoot, 'storage')
  const rechargeImageDirectory = path.join(storagePath, 'uploads', 'recharge-packages')
  fs.mkdirSync(rechargeImageDirectory, { recursive: true })
  fs.writeFileSync(
    path.join(rechargeImageDirectory, 'shared-foundation.png'),
    Buffer.from(ONE_PIXEL_PNG, 'base64'),
  )
  const configRoot = path.join(tempRoot, 'configs')
  fs.mkdirSync(configRoot, { recursive: true })
  fs.writeFileSync(path.join(configRoot, 'config.yaml'), [
    'app:',
    '  name: LocalMiniDrama shared foundation acceptance',
    '  version: test',
    'server:',
    '  host: 127.0.0.1',
    `  port: ${port}`,
    '  cors_origins:',
    `    - ${FRONTEND_ORIGIN}`,
    'database:',
    '  type: sqlite',
    `  path: ${databasePath.replace(/\\/g, '/')}`,
    'storage:',
    '  type: local',
    `  local_path: ${storagePath.replace(/\\/g, '/')}`,
    `  base_url: http://127.0.0.1:${port}/static`,
    'vendor_lock:',
    '  enabled: false',
  ].join('\n'), 'utf8')

  backendOrigin = `http://127.0.0.1:${port}`
  backendProcess = spawn(process.execPath, [backendServer], {
    cwd: tempRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      PUBLIC_PLATFORM_MODE: '1',
      PLATFORM_JWT_SECRET: JWT_SECRET,
      PLATFORM_VERIFICATION_SECRET: JWT_SECRET,
      PLATFORM_ADMIN_TOKEN: ADMIN_TOKEN,
      PLATFORM_SECURE_COOKIES: '0',
      PLATFORM_EMAIL_VERIFICATION_ENABLED: '0',
      PROVIDER_CANARY_MODE: 'off',
      WEB_DIST_PATH: path.join(tempRoot, 'missing-web-dist'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  backendProcess.stdout.on('data', (chunk) => { backendLogs += chunk.toString() })
  backendProcess.stderr.on('data', (chunk) => { backendLogs += chunk.toString() })
  await waitForHealth(`${backendOrigin}/health`)
  seedDatabase()
})

test.afterAll(async () => {
  await stopBackend()
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
})

test.afterEach(async ({ page }) => {
  await page.context().unrouteAll({ behavior: 'ignoreErrors' })
  expect(externalRequests).toEqual([])
})

test('匿名跳登录并恢复地址；owner 完成租户、素材、兑换与订单闭环', async ({ page }) => {
  await installBackendGate(page)
  await loginFromRedirect(page, '/tenant-console', 'owner@example.com')
  await expect(page.getByText('公共底座验收团队', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('可用积分', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('100', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: '成员管理' })).toBeVisible()

  const upload = await page.evaluate(async ({ png, drama }) => {
    const session = JSON.parse(localStorage.getItem('moli_mama_session') || '{}')
    const tenantId = localStorage.getItem('moli_mama_tenant_id') || ''
    const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0))
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'image/png' }), 'browser-acceptance.png')
    form.append('drama_id', String(drama))
    const headers = { Authorization: `Bearer ${session.token}`, 'X-Tenant-Id': tenantId }
    const uploadedResponse = await fetch('/api/v1/upload/image', { method: 'POST', headers, body: form })
    const uploaded = await uploadedResponse.json()
    const createdResponse = await fetch('/api/v1/assets', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        drama_id: drama,
        name: '浏览器上传素材',
        type: 'image',
        category: 'acceptance',
        url: uploaded.data.url,
        local_path: uploaded.data.local_path,
        file_size: uploaded.data.size,
        mime_type: 'image/png',
      }),
    })
    const created = await createdResponse.json()
    const fileResponse = await fetch(uploaded.data.url, { headers })
    return {
      uploadStatus: uploadedResponse.status,
      createStatus: createdResponse.status,
      fileStatus: fileResponse.status,
      fileSize: (await fileResponse.arrayBuffer()).byteLength,
      asset: created.data,
    }
  }, { png: ONE_PIXEL_PNG, drama: dramaId })
  expect(upload.uploadStatus).toBe(200)
  expect(upload.createStatus).toBe(201)
  expect(upload.fileStatus).toBe(200)
  expect(upload.fileSize).toBeGreaterThan(0)

  await page.reload()
  await expect(page.getByText('公共底座验收团队', { exact: true }).first()).toBeVisible()
  const assets = await browserApi(page, `/assets?drama_id=${dramaId}`)
  expect(assets.status).toBe(200)
  expect(assets.body.data.items.some((item) => item.id === upload.asset.id && item.name === '浏览器上传素材')).toBe(true)

  await page.getByPlaceholder('MOLI-XXXX-XXXX-XXXX').fill(redeemCode)
  await page.getByRole('button', { name: '立即兑换' }).click()
  await expect(page.getByText('130', { exact: true }).first()).toBeVisible()
  await page.getByPlaceholder('MOLI-XXXX-XXXX-XXXX').fill(redeemCode)
  await page.getByRole('button', { name: '立即兑换' }).click()
  await expect(page.getByText(/已经使用过该兑换码/)).toBeVisible()

  const firstOrder = await browserApi(page, '/billing/orders', {
    method: 'POST',
    body: { plan_id: 'creator', client_order_key: 'browser-shared-order' },
  })
  const repeatedOrder = await browserApi(page, '/billing/orders', {
    method: 'POST',
    body: { plan_id: 'creator', client_order_key: 'browser-shared-order' },
  })
  const conflictingOrder = await browserApi(page, '/billing/orders', {
    method: 'POST',
    body: { plan_id: 'studio', client_order_key: 'browser-shared-order' },
  })
  expect(firstOrder.status).toBe(201)
  expect(repeatedOrder.body.data.id).toBe(firstOrder.body.data.id)
  expect(conflictingOrder.status).toBe(409)
  const listedOrders = await browserApi(page, '/billing/orders')
  expect(listedOrders.body.data).toHaveLength(1)
})

test('member、tenant admin 与平台管理员的页面和后端权限一致且公开 DTO 脱敏', async ({ page }) => {
  await installBackendGate(page)
  await loginFromRedirect(page, '/tenant-console', 'member@example.com')
  await expect(page.getByRole('heading', { name: '成员管理' })).toHaveCount(0)
  const memberCreate = await browserApi(page, '/billing/orders', {
    method: 'POST',
    body: { plan_id: 'creator', client_order_key: 'member-browser-order' },
  })
  expect(memberCreate.status, JSON.stringify(memberCreate)).toBe(404)
  const forbiddenAdmin = await browserApi(page, '/billing/prices')
  expect(forbiddenAdmin.status).toBe(403)
  const publicCatalog = await browserApi(page, '/billing/catalog')
  expect(publicCatalog.status).toBe(200)
  expect(containsSensitiveIdentity(publicCatalog.body.data)).toBe(false)
  expect((await page.locator('body').innerText()).toLowerCase()).not.toContain('provider')

  await page.evaluate(() => localStorage.clear())
  await loginFromRedirect(page, '/tenant-console', 'tenant-admin@example.com')
  await expect(page.getByRole('heading', { name: '成员管理' })).toBeVisible()
  const tenantAdminOrder = await browserApi(page, '/billing/orders', {
    method: 'POST',
    body: { plan_id: 'creator', client_order_key: 'tenant-admin-browser-order' },
  })
  expect(tenantAdminOrder.status).toBe(201)

  await page.evaluate(() => localStorage.clear())
  await loginFromRedirect(page, '/billing-admin?tab=models', 'platform-admin@example.com')
  await expect(page.getByText('模型计费', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('积分对账', { exact: true }).first()).toBeVisible()
  const adminPrices = await browserApi(page, '/billing/prices')
  expect(adminPrices.status).toBe(200)
  const adminImagePrice = adminPrices.body.data.find((item) => item.model === 'gpt-image-2')
  expect(adminImagePrice.credits).toBe(40)
  expect(adminImagePrice.cost_micros_per_unit).toBe(12345)
})

test('390、1024、1440 三种视口刷新后均无页面级横向泄漏', async ({ page }) => {
  await installBackendGate(page)
  await loginFromRedirect(page, '/tenant-console', 'owner@example.com')
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    await page.reload()
    await expect(page.getByText('公共底座验收团队', { exact: true }).first()).toBeVisible()
    await assertNoHorizontalLeak(page)
  }
})
