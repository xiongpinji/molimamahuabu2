import { createServer } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const SMOKE_PAGE_PATHS = Object.freeze(['/', '/login', '/canvas', '/factory', '/script-analysis'])
const PUBLIC_MODEL_CATALOG_PATH = '/api/v1/canvas/model-catalog'
const LOGIN_PATH = '/api/v1/auth/login'
const AUTH_ME_PATH = '/api/v1/auth/me'
const MALICIOUS_SW_PATH = '/platform-smoke-malicious-sw.js'
const ALLOWED_API_READ_PATHS = new Set([AUTH_ME_PATH, PUBLIC_MODEL_CATALOG_PATH])
const ARTIFACT_DIR = fileURLToPath(new URL('../platform-smoke-artifacts/', import.meta.url))
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

const PAGE_CHECKS = Object.freeze({
  '/': { selector: '.platform-header', text: '茉莉妈妈' },
  '/canvas': { selector: '.film-list', text: '新建画布' },
  '/factory': { selector: '.film-list', text: '茉莉妈妈 AI 创作工作台' },
  '/script-analysis': { selector: '.script-analysis-page', text: '从原剧本到可执行分镜' },
})

function requireEnv(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`ZERO_COST_SMOKE_MISSING_ENV:${name}`)
  return value
}

function normalizePathname(value) {
  try {
    return new URL(value, 'http://smoke.invalid').pathname
  } catch {
    return String(value || '').split('?')[0]
  }
}

function assertNoURLCredentials(url) {
  if (url.username || url.password) {
    throw new Error(`ZERO_COST_SMOKE_URL_CREDENTIALS:${url.pathname}`)
  }
}

export function assertNavigationAllowed(value, allowedOrigin) {
  const url = new URL(value, allowedOrigin)
  assertNoURLCredentials(url)
  if (url.origin !== allowedOrigin || !SMOKE_PAGE_PATHS.includes(url.pathname)) {
    throw new Error(`ZERO_COST_SMOKE_FORBIDDEN_NAVIGATION:${url.pathname}`)
  }
}

export function assertRequestAllowed(method, value, allowedOrigin = '') {
  const normalizedMethod = String(method || 'GET').toUpperCase()
  const expectedOrigin = allowedOrigin || 'http://smoke.invalid'
  const url = new URL(value, expectedOrigin)
  assertNoURLCredentials(url)
  const pathname = normalizePathname(url.href)
  if (url.origin !== expectedOrigin) {
    throw new Error(`ZERO_COST_SMOKE_CROSS_ORIGIN_REQUEST:${normalizedMethod}:${pathname}`)
  }
  if (['GET', 'HEAD'].includes(normalizedMethod)) return
  if (normalizedMethod === 'POST' && pathname === LOGIN_PATH) return
  throw new Error(`ZERO_COST_SMOKE_FORBIDDEN_WRITE:${normalizedMethod}:${pathname}`)
}

export function isNonLoginWriteRequest(method, value) {
  const normalizedMethod = String(method || 'GET').toUpperCase()
  const pathname = normalizePathname(value)
  if (['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod)) return false
  return normalizedMethod !== 'POST' || pathname !== LOGIN_PATH
}

function isAllowedApiRequest(method, pathname) {
  const normalizedMethod = String(method || 'GET').toUpperCase()
  return (normalizedMethod === 'POST' && pathname === LOGIN_PATH)
    || (['GET', 'HEAD'].includes(normalizedMethod) && ALLOWED_API_READ_PATHS.has(pathname))
}

function readRuntimeConfig(localFixture) {
  const baseURL = requireEnv('PLATFORM_SMOKE_BASE_URL')
  const email = requireEnv('PLATFORM_SMOKE_EMAIL')
  const password = requireEnv('PLATFORM_SMOKE_PASSWORD')
  const parsed = new URL(baseURL)

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('ZERO_COST_SMOKE_INVALID_BASE_URL')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('ZERO_COST_SMOKE_BASE_URL_MUST_BE_ORIGIN')
  }
  if (localFixture) {
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) throw new Error('ZERO_COST_SMOKE_FIXTURE_NOT_LOOPBACK')
    if (!email.endsWith('.test') || password !== 'local-test-only') {
      throw new Error('ZERO_COST_SMOKE_FIXTURE_CREDENTIALS_INVALID')
    }
  } else if (parsed.protocol !== 'https:') {
    throw new Error('ZERO_COST_SMOKE_PRODUCTION_REQUIRES_HTTPS')
  }

  return { baseURL: parsed.origin, email, password }
}

function jsonResponse(response, status, value) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(value))
}

function fixturePage(pathname) {
  const labels = {
    '/': ['首页', '茉莉妈妈', '茉莉妈妈 AI 创作工作台'],
    '/canvas': ['画布', '新建画布', '画布项目'],
    '/factory': ['短剧工厂', '茉莉妈妈 AI 创作工作台', '新建项目'],
    '/script-analysis': ['剧本分析', '从原剧本到可执行分镜', '导演工作区'],
  }[pathname]
  if (!labels) return null
  const modelCatalogRead = pathname === '/canvas'
    ? `<script>fetch('${PUBLIC_MODEL_CATALOG_PATH}', { method: 'GET', credentials: 'same-origin' }).catch(() => {})</script>`
    : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${labels[0]}</title></head>
<body><header class="platform-header"><strong>茉莉妈妈</strong><nav>首页 画布 剧本分析 短剧工厂</nav></header>
<main class="${pathname === '/script-analysis' ? 'script-analysis-page' : 'film-list'}" data-smoke-page="${pathname}">
<section class="${pathname === '/script-analysis' ? 'workspace-hero' : 'smoke-first-screen'}"><h1>${labels[1]}</h1><p>${labels[2]}</p></section>
</main>${modelCatalogRead}</body></html>`
}

function loginFixturePage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>登录</title></head>
<body><main class="login-page"><h1>茉莉妈妈</h1><form id="login-form">
<label>邮箱<input name="email" type="email" placeholder="请输入邮箱" autocomplete="username"></label>
<label>密码<input name="password" type="password" placeholder="至少 12 个字符" autocomplete="current-password"></label>
<button type="submit">登录平台</button></form></main>
<script>document.getElementById('login-form').addEventListener('submit', async (event) => {
event.preventDefault(); const form = new FormData(event.currentTarget);
const response = await fetch('${LOGIN_PATH}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
if (!response.ok) throw new Error('login failed');
const identity = await fetch('${AUTH_ME_PATH}', { method: 'GET', credentials: 'same-origin' });
if (!identity.ok) throw new Error('identity failed'); location.assign('/');
});</script></body></html>`
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function startFixture(config) {
  const received = { nonLoginWrites: 0 }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', config.baseURL)
    const method = String(request.method || 'GET').toUpperCase()

    if (method === 'POST' && url.pathname === LOGIN_PATH) {
      let body
      try {
        body = JSON.parse(await readBody(request))
      } catch {
        return jsonResponse(response, 400, { success: false })
      }
      if (body.email !== config.email || body.password !== config.password) {
        return jsonResponse(response, 401, { success: false })
      }
      return jsonResponse(response, 200, {
        success: true,
        data: { token: 'fixture-session', user: { id: 'fixture-monitor', email: config.email, role: 'user' } },
      })
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      received.nonLoginWrites += 1
      return jsonResponse(response, 405, { success: false })
    }
    if (url.pathname === AUTH_ME_PATH) {
      return jsonResponse(response, 200, {
        success: true,
        data: { id: 'fixture-monitor', email: config.email, role: 'user' },
      })
    }
    if (url.pathname === MALICIOUS_SW_PATH) {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/javascript; charset=utf-8',
      })
      return response.end(`self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method === 'POST' && url.pathname === '/api/v1/images') {
    event.respondWith(fetch(event.request))
  }
})`)
    }
    if (url.pathname === PUBLIC_MODEL_CATALOG_PATH) {
      return jsonResponse(response, 200, {
        success: true,
        data: [{ kind: 'image', logical_model_id: 'fixture-image', capabilities: { resolutions: ['1k'] } }],
      })
    }
    if (url.pathname === '/login') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return response.end(loginFixturePage())
    }
    const page = fixturePage(url.pathname)
    if (page) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return response.end(page)
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })

  const base = new URL(config.baseURL)
  const port = Number(base.port || (base.protocol === 'https:' ? 443 : 80))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, base.hostname, resolve)
  })
  return {
    received,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

function safePath(url) {
  try {
    return new URL(url).pathname
  } catch {
    return 'invalid-url'
  }
}

async function assertVisible(locator, label) {
  await locator.first().waitFor({ state: 'visible', timeout: 15_000 })
  if (await locator.count() < 1) throw new Error(`ZERO_COST_SMOKE_MISSING_UI:${label}`)
}

async function assertHealthyPage(page, pathname, runtimeFailures) {
  const body = page.locator('body')
  await assertVisible(body, `${pathname}:body`)
  const health = await body.evaluate((element) => ({
    textLength: String(element.innerText || '').trim().length,
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  }))
  if (health.textLength < 10 || health.width < 100 || health.height < 100) {
    throw new Error(`ZERO_COST_SMOKE_BLANK_SCREEN:${pathname}`)
  }
  const check = PAGE_CHECKS[pathname]
  await assertVisible(page.locator(check.selector), `${pathname}:${check.selector}`)
  await assertVisible(page.getByText(check.text, { exact: false }), `${pathname}:${check.text}`)
  if (runtimeFailures.length) throw new Error(`ZERO_COST_SMOKE_RUNTIME_FAILURE:${runtimeFailures[0]}`)
}

async function writeSanitizedScreenshot(page, outputDir, name, email) {
  await page.evaluate(({ currentEmail }) => {
    const style = document.createElement('style')
    style.textContent = [
      'input, textarea, [contenteditable="true"] { color: transparent !important; text-shadow: none !important; }',
      '.platform-header__account-label, .platform-header__account, [data-sensitive] { visibility: hidden !important; }',
    ].join('\n')
    document.head.appendChild(style)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let value = node.nodeValue || ''
      if (currentEmail) value = value.split(currentEmail).join('[已脱敏]')
      value = value.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[已脱敏]')
      value = value.replace(/(?:\+?86[- ]?)?1[3-9]\d{9}/g, '[已脱敏]')
      node.nodeValue = value
    }
  }, { currentEmail: email })
  await page.screenshot({ path: path.join(outputDir, `sanitized-${name}.png`), fullPage: true })
}

export async function runBlockedWriteProbe() {
  const config = readRuntimeConfig(true)
  const fixture = await startFixture(config)
  let browser
  let blockedRequestCount = 0
  try {
    const { chromium } = await import('@playwright/test')
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ baseURL: config.baseURL, serviceWorkers: 'block' })
    const page = await context.newPage()
    await page.route('**/*', async (route) => {
      const request = route.request()
      try {
        assertRequestAllowed(request.method(), request.url(), config.baseURL)
      } catch {
        blockedRequestCount += 1
        return route.abort('blockedbyclient')
      }
      return route.continue()
    })
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    const browserResult = await page.evaluate(async () => {
      try {
        await fetch('/api/v1/images', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        return 'reached-server'
      } catch {
        return 'blocked'
      }
    })
    if (browserResult !== 'blocked' || blockedRequestCount !== 1) {
      throw new Error('ZERO_COST_SMOKE_NEGATIVE_PROBE_NOT_BLOCKED')
    }
    const ordinaryBlockedRequestCount = blockedRequestCount
    const serviceWorkerRegistration = await page.evaluate(async (scriptPath) => {
      if (!('serviceWorker' in navigator)) return { blocked: false, supported: false }
      try {
        await navigator.serviceWorker.register(scriptPath, { scope: '/' })
        const becameReady = await Promise.race([
          navigator.serviceWorker.ready.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
        ])
        return { blocked: !becameReady, supported: true }
      } catch {
        return { blocked: true, supported: true }
      }
    }, MALICIOUS_SW_PATH)
    const serviceWorkerRegistrationBlocked = serviceWorkerRegistration.blocked
    if (!serviceWorkerRegistrationBlocked) {
      await page.reload({ waitUntil: 'domcontentloaded' })
    }
    const serviceWorkerControlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller))
    const beforeServiceWorkerProbe = blockedRequestCount
    const serviceWorkerBrowserResult = await page.evaluate(async () => {
      try {
        await fetch('/api/v1/images', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        return 'reached-server'
      } catch {
        return 'blocked'
      }
    })
    const serviceWorkerBlockedRequestCount = blockedRequestCount - beforeServiceWorkerProbe
    await context.close()
    if (
      !serviceWorkerRegistration.supported
      || !serviceWorkerRegistrationBlocked
      || serviceWorkerControlled
      || serviceWorkerBrowserResult !== 'blocked'
      || serviceWorkerBlockedRequestCount < 1
    ) {
      throw new Error('ZERO_COST_SMOKE_SERVICE_WORKER_BYPASS_DETECTED')
    }
    if (fixture.received.nonLoginWrites !== 0) {
      throw new Error('ZERO_COST_SMOKE_NEGATIVE_PROBE_REACHED_FIXTURE')
    }
    return {
      blockedRequestCount: ordinaryBlockedRequestCount,
      serviceWorkerRegistrationBlocked,
      serviceWorkerControlled,
      serviceWorkerBlockedRequestCount,
      fixtureWriteCount: fixture.received.nonLoginWrites,
    }
  } finally {
    if (browser) await browser.close()
    await fixture.close()
  }
}

export async function runSmoke({ localFixture = false } = {}) {
  const config = readRuntimeConfig(localFixture)
  const outputDir = ARTIFACT_DIR
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })

  let fixture
  let browser
  const safeTrace = []
  const violations = []
  const runtimeFailures = []
  let generationWriteCount = 0
  let nonLoginWriteCount = 0

  try {
    if (localFixture) fixture = await startFixture(config)
    const { chromium } = await import('@playwright/test')
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      baseURL: config.baseURL,
      colorScheme: 'dark',
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 900 },
    })
    const page = await context.newPage()
    let lastCatalogStatus = 0
    const catalogResponsePromise = page.waitForResponse((response) => {
      const responseURL = new URL(response.url())
      return responseURL.origin === config.baseURL
        && responseURL.pathname === PUBLIC_MODEL_CATALOG_PATH
        && response.request().method() === 'GET'
        && response.status() >= 200
        && response.status() < 300
    }, { timeout: 60_000 }).catch(() => null)

    page.on('pageerror', () => runtimeFailures.push('pageerror'))
    page.on('response', (response) => {
      const responseURL = new URL(response.url())
      const request = response.request()
      if (
        responseURL.origin === config.baseURL
        && responseURL.pathname === PUBLIC_MODEL_CATALOG_PATH
        && request.method() === 'GET'
      ) {
        lastCatalogStatus = response.status()
      }
      if (
        responseURL.origin === config.baseURL
        && isAllowedApiRequest(request.method(), responseURL.pathname)
      ) {
        safeTrace.push({
          step: 'allowed-api',
          method: request.method(),
          pathname: responseURL.pathname,
          status: response.status(),
        })
      }
      if (response.status() >= 500) runtimeFailures.push(`http-${response.status()}:${safePath(response.url())}`)
    })
    await page.route('**/*', async (route) => {
      const request = route.request()
      const requestURL = new URL(request.url())
      if (localFixture && requestURL.origin !== config.baseURL) {
        violations.push(`external-origin:${requestURL.hostname}`)
        return route.abort('blockedbyclient')
      }
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        try {
          assertNavigationAllowed(requestURL.href, config.baseURL)
        } catch (error) {
          violations.push(error.message)
          return route.abort('blockedbyclient')
        }
        return route.continue()
      }
      try {
        assertRequestAllowed(request.method(), requestURL.href, config.baseURL)
      } catch (error) {
        if (isNonLoginWriteRequest(request.method(), requestURL.href)) {
          nonLoginWriteCount += 1
          if (/\/(?:images|videos|canvas\/text\/generate)(?:\/|$)/.test(requestURL.pathname)) {
            generationWriteCount += 1
          }
        }
        violations.push(error.message)
        return route.abort('blockedbyclient')
      }
      return route.continue()
    })

    await page.goto('/login', { waitUntil: 'domcontentloaded' })
    await page.getByPlaceholder('请输入邮箱').fill(config.email)
    await page.getByPlaceholder('至少 12 个字符').fill(config.password)
    await Promise.all([
      page.waitForURL((url) => url.pathname !== '/login', { timeout: 15_000 }),
      page.getByRole('button', { name: '登录平台' }).click(),
    ])

    for (const pathname of SMOKE_PAGE_PATHS.filter((item) => item !== '/login')) {
      const response = await page.goto(pathname, { waitUntil: 'domcontentloaded' })
      const status = response?.status() || 0
      safeTrace.push({ step: 'page', pathname, status })
      if (status >= 500 || status === 0) throw new Error(`ZERO_COST_SMOKE_NAVIGATION_FAILED:${pathname}:${status}`)
      await assertHealthyPage(page, pathname, runtimeFailures)
      const screenshotName = pathname === '/' ? 'home' : pathname.slice(1).replaceAll('/', '-')
      await writeSanitizedScreenshot(page, outputDir, screenshotName, config.email)
    }

    const catalogResponse = await catalogResponsePromise
    const catalogStatus = catalogResponse?.status() || lastCatalogStatus
    safeTrace.push({ step: 'public-model-catalog', pathname: PUBLIC_MODEL_CATALOG_PATH, status: catalogStatus })
    if (!catalogResponse) {
      throw new Error(`ZERO_COST_SMOKE_MODEL_CATALOG_FAILED:${catalogStatus}`)
    }
    if (violations.length || nonLoginWriteCount !== 0 || generationWriteCount !== 0) {
      throw new Error(`ZERO_COST_SMOKE_WRITE_DETECTED:${violations[0] || 'unknown'}`)
    }
    if (fixture?.received.nonLoginWrites !== 0) throw new Error('ZERO_COST_SMOKE_FIXTURE_RECEIVED_WRITE')

    safeTrace.push({
      step: 'summary',
      generation_write_requests: generationWriteCount,
      non_login_write_requests: nonLoginWriteCount,
      runtime_failures: runtimeFailures.length,
      result: 'passed',
    })
    await context.close()
    return { generationWriteCount, nonLoginWriteCount, safeTrace }
  } catch (error) {
    safeTrace.push({
      step: 'summary',
      generation_write_requests: generationWriteCount,
      non_login_write_requests: nonLoginWriteCount,
      runtime_failures: runtimeFailures.length,
      result: 'failed',
      failure_code: String(error?.message || 'unknown').split(':')[0],
    })
    throw error
  } finally {
    await mkdir(outputDir, { recursive: true })
    await writeFile(path.join(outputDir, 'safe-trace.json'), `${JSON.stringify(safeTrace, null, 2)}\n`, { mode: 0o600 })
    if (browser) await browser.close()
    if (fixture) await fixture.close()
  }
}

async function main() {
  const localFixture = process.argv.includes('--local-fixture')
  const result = await runSmoke({ localFixture })
  console.log(`zero-cost smoke passed; generation write requests: ${result.generationWriteCount}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(String(error?.message || error))
    process.exitCode = 1
  })
}
