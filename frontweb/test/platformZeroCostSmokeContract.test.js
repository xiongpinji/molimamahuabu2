import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sourcePaths = {
  runner: new URL('../scripts/run-platform-zero-cost-smoke.mjs', import.meta.url),
  spec: new URL('../e2e/platform-zero-cost-smoke.spec.js', import.meta.url),
  workflow: new URL('../../.github/workflows/platform-zero-cost-smoke.yml', import.meta.url),
}

async function readSources() {
  return Object.fromEntries(await Promise.all(
    Object.entries(sourcePaths).map(async ([name, url]) => [name, await readFile(url, 'utf8')]),
  ))
}

test('workflow 每五分钟运行且不重叠', async () => {
  const { workflow } = await readSources()

  assert.match(workflow, /cron:\s*['"]\*\/5 \* \* \* \*['"]/, '必须使用五分钟 cron')
  assert.match(workflow, /concurrency:\s*[\s\S]*?group:\s*platform-zero-cost-smoke/)
  assert.match(workflow, /cancel-in-progress:\s*false/)
  assert.match(workflow, /permissions:\s*[\s\S]*?contents:\s*read/)
})

test('workflow 只从 Encrypted Secrets 注入生产凭据', async () => {
  const { workflow } = await readSources()

  for (const name of ['PLATFORM_SMOKE_BASE_URL', 'PLATFORM_SMOKE_EMAIL', 'PLATFORM_SMOKE_PASSWORD']) {
    assert.match(workflow, new RegExp(`${name}:\\s*\\$\\{\\{ secrets\\.${name} \\}\\}`))
  }
  assert.doesNotMatch(workflow, /monitor@example\.test|local-test-only|molimama\.vip/i)
})

test('workflow 只上传脱敏截图和安全 trace 且保留七天', async () => {
  const { workflow } = await readSources()

  assert.match(workflow, /retention-days:\s*7/)
  assert.match(workflow, /platform-smoke-artifacts\/sanitized-\*\.png/)
  assert.match(workflow, /platform-smoke-artifacts\/safe-trace\.json/)
  assert.doesNotMatch(workflow, /trace\.zip|test-results|playwright-report/i)
})

test('运行脚本强制三个环境变量并禁止生产默认值', async () => {
  const { runner } = await readSources()

  for (const name of ['PLATFORM_SMOKE_BASE_URL', 'PLATFORM_SMOKE_EMAIL', 'PLATFORM_SMOKE_PASSWORD']) {
    assert.match(runner, new RegExp(`requireEnv\\(['"]${name}['"]\\)`))
  }
  assert.doesNotMatch(runner, /molimama\.vip|sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+/i)
  assert.doesNotMatch(runner, /PLATFORM_SMOKE_(?:EMAIL|PASSWORD)\s*\|\||PLATFORM_SMOKE_(?:EMAIL|PASSWORD)\s*\?\?/)
})

test('浏览器只导航允许页面并读取公开模型目录', async () => {
  const { runner } = await readSources()

  assert.match(runner, /const SMOKE_PAGE_PATHS\s*=\s*Object\.freeze\(\[\s*['"]\/['"],\s*['"]\/login['"],\s*['"]\/canvas['"],\s*['"]\/factory['"],\s*['"]\/script-analysis['"]\s*\]\)/)
  assert.match(runner, /const PUBLIC_MODEL_CATALOG_PATH\s*=\s*['"]\/api\/v1\/canvas\/model-catalog['"]/)

  const { assertNavigationAllowed } = await import(sourcePaths.runner.href)
  for (const pathname of ['/', '/login', '/canvas', '/factory', '/script-analysis']) {
    assert.doesNotThrow(() => assertNavigationAllowed(`https://app.example${pathname}`, 'https://app.example'))
  }
  assert.throws(
    () => assertNavigationAllowed('https://app.example/recharge', 'https://app.example'),
    /ZERO_COST_SMOKE_FORBIDDEN_NAVIGATION/,
  )
  assert.throws(
    () => assertNavigationAllowed('https://outside.example/login', 'https://app.example'),
    /ZERO_COST_SMOKE_FORBIDDEN_NAVIGATION/,
  )
})

test('请求门禁仅允许登录 POST，拦截生成、充值、积分和资产写入', async () => {
  const { assertRequestAllowed } = await import(sourcePaths.runner.href)

  const origin = 'https://app.example'
  assert.doesNotThrow(() => assertRequestAllowed('GET', `${origin}/assets/index.js`, origin))
  assert.doesNotThrow(() => assertRequestAllowed('HEAD', `${origin}/moli-mama-logo.png`, origin))
  assert.doesNotThrow(() => assertRequestAllowed('POST', `${origin}/api/v1/auth/login`, origin))
  assert.doesNotThrow(() => assertRequestAllowed('GET', `${origin}/api/v1/auth/me`, origin))
  assert.doesNotThrow(() => assertRequestAllowed('HEAD', `${origin}/api/v1/auth/me`, origin))
  assert.doesNotThrow(() => assertRequestAllowed('GET', `${origin}/api/v1/canvas/model-catalog`, origin))

  for (const path of [
    '/api/v1/assets',
    '/api/v1/billing/account',
    '/api/v1/dramas',
    '/api/v1/script-analysis/projects',
  ]) {
    assert.throws(
      () => assertRequestAllowed('GET', `${origin}${path}`, origin),
      /ZERO_COST_SMOKE_FORBIDDEN_API_READ/,
    )
  }

  for (const path of [
    '/api/v1/images',
    '/api/v1/videos',
    '/api/v1/canvas/text/generate',
    '/api/v1/billing/recharge/alipay/orders',
    '/api/v1/billing/holds',
    '/api/v1/assets',
  ]) {
    assert.throws(() => assertRequestAllowed('POST', path), /ZERO_COST_SMOKE_FORBIDDEN_WRITE/)
  }
  assert.throws(() => assertRequestAllowed('PUT', '/api/v1/dramas/1/canvas-layout'), /ZERO_COST_SMOKE_FORBIDDEN_WRITE/)
  assert.throws(
    () => assertRequestAllowed('POST', 'https://outside.example/api/v1/auth/login', 'https://app.example'),
    /ZERO_COST_SMOKE_CROSS_ORIGIN_REQUEST/,
  )
  assert.throws(
    () => assertRequestAllowed('GET', 'https://outside.example/assets/logo.png', 'https://app.example'),
    /ZERO_COST_SMOKE_CROSS_ORIGIN_REQUEST/,
  )
})

test('安全产物不使用原生 Playwright trace 或记录请求秘密', async () => {
  const sources = await readSources()
  const combined = `${sources.runner}\n${sources.spec}\n${sources.workflow}`

  assert.doesNotMatch(combined, /context\.tracing|trace:\s*['"](?:on|retain-on-failure)|trace\.zip/i)
  assert.doesNotMatch(combined, /postData\(|postDataJSON\(|allHeaders\(|headers\(\)|storageState\(/)
  assert.doesNotMatch(combined, /['"](?:Cookie|Authorization)['"]\s*:/i)
  assert.match(sources.runner, /safe-trace\.json/)
  assert.match(sources.runner, /sanitized-/)
  assert.match(sources.spec, /test\.use\(\{\s*trace:\s*['"]off['"]\s*\}\)/)
})

test('本地 fixture 只允许回环地址并由脚本启停', async () => {
  const { runner } = await readSources()

  assert.match(runner, /--local-fixture/)
  assert.match(runner, /127\.0\.0\.1|localhost/)
  assert.match(runner, /server\.listen/)
  assert.match(runner, /server\.close/)
  assert.match(runner, /local-test-only/)
})

test('两个浏览器上下文都禁用 Service Worker 绕过请求门禁', async () => {
  const { runner, spec } = await readSources()

  assert.equal((runner.match(/serviceWorkers:\s*['"]block['"]/g) || []).length, 2)
  assert.match(runner, /platform-smoke-malicious-sw\.js/)
  assert.match(spec, /serviceWorkerRegistrationBlocked/)
  assert.match(spec, /serviceWorkerBlockedRequestCount/)
  assert.match(spec, /fixtureWriteCount/)
})
