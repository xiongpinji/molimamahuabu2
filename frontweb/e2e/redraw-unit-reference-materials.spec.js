import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const frontRoot = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = path.resolve(frontRoot, '..')
const backend = createRequire(path.join(repoRoot, 'backend-node/package.json'))
const frontend = createRequire(path.join(frontRoot, 'package.json'))
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

// This worker may connect only to its own ephemeral HTTP server. The browser has
// a separate exact-origin interceptor below. Install before any backend import.
function guardOwnedLoopback() {
  const deny = kind => { throw new Error(`G4_LOCAL_TEST_FORBIDS_${kind}`) }
  for (const [name, exports] of [
    ['./src/config/index.js', { loadConfig: () => deny('DEFAULT_CONFIG') }],
    ['./src/db/index.js', { getDb: () => deny('DEFAULT_DATABASE'), closeDb: () => deny('DEFAULT_DATABASE') }],
  ]) { const id = backend.resolve(name); backend.cache[id] = { id, filename: id, loaded: true, exports } }
  const servers = new Set(), listen = net.Server.prototype.listen
  net.Server.prototype.listen = function (...args) {
    if (!(this instanceof http.Server) || args[0] !== 0 || args[1] !== '127.0.0.1') deny('LISTENER')
    servers.add(this); this.once('close', () => servers.delete(this))
    try { return listen.apply(this, args) } catch (error) { servers.delete(this); throw error }
  }
  function livePort(host, port) {
    if (host !== '127.0.0.1' || !Number.isSafeInteger(Number(port)) || Number(port) <= 0
      || ![...servers].some(server => server.listening && server.address()?.address === host && server.address().port === Number(port))) deny('NETWORK')
  }
  const connect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0]
    if (first && typeof first === 'object') {
      if (first.path || first.socketPath) deny('NETWORK')
      livePort(first.host, first.port)
    } else livePort(typeof args[1] === 'string' ? args[1] : undefined, first)
    return connect.apply(this, args)
  }
  tls.connect = () => deny('TLS'); https.request = https.get = () => deny('TLS')
  function httpTarget(input, options) {
    if (typeof input === 'string' || input instanceof URL) {
      const url = new URL(input)
      if (url.protocol !== 'http:' || url.username || url.password) deny('NETWORK')
      if (options && typeof options === 'object' && ['host', 'hostname', 'port', 'protocol', 'socketPath'].some(key => key in options)) deny('OVERRIDE')
      livePort(url.hostname, url.port || 80)
    } else {
      if (!input || input.socketPath || input.path?.startsWith('http') || input.protocol && input.protocol !== 'http:') deny('NETWORK')
      livePort(input.hostname || input.host, input.port || 80)
    }
  }
  for (const method of ['request', 'get']) {
    const original = http[method]
    http[method] = function (...args) { httpTarget(args[0], args[1]); return original.apply(this, args) }
  }
  const nativeFetch = global.fetch
  global.fetch = async (input, init) => {
    httpTarget(typeof input === 'string' || input instanceof URL ? input : input?.url)
    if (init?.dispatcher) deny('DISPATCHER')
    return nativeFetch(input, { ...init, redirect: 'error' })
  }
}

test('ordinary unit page checks and prepares actual local materials through its owned HTTP server', async ({ browser }, testInfo) => {
  const previousCwd = process.cwd(), temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-unit-materials-browser-'))
  const cleanup = [], logs = [], counts = { get: 0, post: 0 }, unexpectedRequests = []
  let server, context, gate, lateEntered, postFinished, stopBuild, primaryError, holdNext = false, holdNextPost = false
  try {
    guardOwnedLoopback()
    const launchRelative = path.relative(os.tmpdir(), previousCwd)
    if (!launchRelative || launchRelative.startsWith('..') || path.isAbsolute(launchRelative)) throw Error('launch requires a fresh OS-temp cwd')
    // esbuild captures defaultWD at module initialization. Keep its child cwd in
    // the launcher's retained temp, not the page directory cleaned below.
    const { build } = await import('vite'), { default: vue } = await import('@vitejs/plugin-vue')
    const viteRequire = createRequire(frontend.resolve('vite/package.json'))
    if (viteRequire.resolve('esbuild') !== frontend.resolve('esbuild')) throw Error('build service module differs')
    stopBuild = viteRequire('esbuild').stop
    process.chdir(temporary)
    const { fixture } = backend('./test/helpers/redrawUnitReferenceDerivationFixture')
    // Pre-approved synthetic blueprint/review/queue; not an empty-project or human quality acceptance.
    const h = await fixture({ after(fn) { cleanup.push(fn) } })
    const handlers = backend('./src/routes/redraw')(h.db, { error: (...args) => logs.push(args) },
      { cfg: { storage: { local_path: h.root } }, canReadArtifact: h.ctx.canReadArtifact })
    const record = { version_id: h.versionId, blueprint_hash: h.blueprint.blueprint_hash,
      localization_hash: h.localization.localization_hash, updated_at: h.localization.review.updated_at }
    const entryRoot = path.join(temporary, 'page'), outDir = path.join(temporary, 'built')
    fs.mkdirSync(entryRoot)
    fs.writeFileSync(path.join(entryRoot, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>本地单元素材验收</title></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>', { flag: 'wx' })
    fs.writeFileSync(path.join(entryRoot, 'entry.js'), `import { createApp, h } from 'vue';
      import { ElButton } from 'element-plus';
      import Review from '@/components/redraw/RedrawExecutionPlanReviewPanel.vue';
      createApp({ render: () => h(Review, { record: ${JSON.stringify(record)}, blocked: false }) })
        .component('el-button', ElButton).mount('#app');
      document.body.style.cssText = 'background:#0f172a;color:#e2e8f0;margin:32px;font:16px sans-serif';`, { flag: 'wx' })
    await build({ configFile: false, envDir: false, plugins: [vue()], root: entryRoot,
      resolve: { alias: { '@': path.join(frontRoot, 'src'), vue: frontend.resolve('vue/dist/vue.runtime.esm-bundler.js'),
        'element-plus': path.join(frontRoot, 'node_modules/element-plus/es/index.mjs') } },
      build: { outDir, emptyOutDir: false } })
    const express = backend('express'), app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.tenant = { id: 'tenant-a' }; req.user = { id: req.get('x-fixture-owner') === 'other' ? 'other' : 'user-a' }; next()
    })
    app.get('/api/v1/redraw/versions/:id/execution-plan/review', handlers.getExecutionPlanReview)
    app.get('/api/v1/redraw/versions/:id/execution-queue', handlers.getExecutionQueue)
    const route = '/api/v1/redraw/versions/:id/execution-queues/:queueId/units/:unitId/reference-materials'
    app.get(route, async (req, res) => {
      counts.get++
      if (holdNext) { holdNext = false; lateEntered.resolve(); await gate.promise }
      await handlers.getUnitReferenceMaterials(req, res)
    })
    app.post(route, async (req, res) => {
      counts.post++; const finished = deferred(); postFinished = finished.promise
      try {
        if (holdNextPost) { holdNextPost = false; lateEntered.resolve(); await gate.promise }
        await handlers.prepareUnitReferenceMaterials(req, res)
      } finally { finished.resolve() }
    })
    app.use(express.static(outDir)); app.use((_req, res) => res.status(404).end())
    server = http.createServer(app)
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const origin = `http://127.0.0.1:${server.address().port}`
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' })
    await context.route('**/*', request => {
      if (new URL(request.request().url()).origin === origin) return request.continue()
      unexpectedRequests.push(request.request().url()); return request.abort()
    })
    const page = await context.newPage(), pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(origin)
    const panel = page.getByRole('region', { name: '执行单元素材' }), select = page.getByLabel('选择执行单元')
    await expect(select).toBeEnabled()
    expect(counts).toEqual({ get: 0, post: 0 })
    const selected = h.queueState.queue.units[1], other = h.queueState.queue.units[0]
    await select.selectOption(selected.id)
    const checkButton = panel.getByRole('button', { name: '检查素材', exact: true }), prepareButton = panel.getByRole('button', { name: '本地准备', exact: true })
    await expect(prepareButton).toBeDisabled()
    h.db.pragma('query_only = ON')
    const checkResponse = page.waitForResponse(response => response.url().includes('/reference-materials') && response.request().method() === 'GET')
    await checkButton.click(); const first = await (await checkResponse).json()
    await expect(prepareButton).toBeEnabled()
    expect(first.data.status).toBe('needs_preparation'); expect(counts).toEqual({ get: 1, post: 0 })
    h.db.pragma('query_only = OFF')
    // Keep an actual POST pending while the real parent resets and reloads its review/queue.
    const originalPanel = await panel.elementHandle(), beforePendingRefresh = h.db.prepare('SELECT total_changes() n').get().n
    gate = deferred(); lateEntered = deferred(); holdNextPost = true
    const preparedResponse = page.waitForResponse(response => response.url().includes('/reference-materials') && response.request().method() === 'POST')
    await prepareButton.click(); await lateEntered.promise
    const refreshButton = page.getByRole('button', { name: '刷新计划', exact: true })
    const queueRefresh = page.waitForResponse(response => response.url().endsWith('/execution-queue') && response.request().method() === 'GET')
    await refreshButton.click(); expect((await queueRefresh).status()).toBe(200)
    await expect(refreshButton).toBeEnabled(); await expect(select).toBeEnabled()
    await select.selectOption(selected.id)
    const samePanelInstance = await originalPanel.evaluate(element => element.isConnected)
    expect(samePanelInstance).toBe(true)
    await expect(checkButton).toBeDisabled(); await expect(prepareButton).toBeDisabled()
    expect(counts).toEqual({ get: 1, post: 1 })
    const pendingCounts = { ...counts }, pendingRefreshWrites = h.db.prepare('SELECT total_changes() n').get().n - beforePendingRefresh
    expect(pendingRefreshWrites).toBe(0)
    gate.resolve(); const prepared = (await (await preparedResponse).json()).data
    await expect(checkButton).toBeEnabled(); await expect(prepareButton).toBeDisabled()
    await expect(panel.getByText('待检查素材', { exact: true })).toBeVisible()
    await expect(panel.getByText('已准备（仅本地素材）', { exact: true })).toHaveCount(0)
    expect(counts).toEqual({ get: 1, post: 1 })
    // The stale POST may finish locally, but only this explicit GET can restore its asset DTO.
    const reconciledResponse = page.waitForResponse(response => response.url().includes('/reference-materials') && response.request().method() === 'GET')
    await checkButton.click(); const reconciled = (await (await reconciledResponse).json()).data
    expect(reconciled.prepared_materials).toEqual(prepared)
    await expect(panel.getByText('已准备（仅本地素材）', { exact: true })).toBeVisible()
    expect(counts).toEqual({ get: 2, post: 1 }); expect(h.db.prepare('SELECT count(*) n FROM redraw_unit_reference_derivations').get().n).toBe(1)
    for (const ref of prepared.references) {
      const row = h.db.prepare('SELECT local_path FROM assets WHERE id = ?').get(ref.asset_id)
      const bytes = fs.readFileSync(path.join(h.root, row.local_path))
      expect(sha(bytes)).toBe(ref.sha256)
      fs.writeFileSync(testInfo.outputPath(`${ref.requirement_id}.mp4`), bytes, { flag: 'wx' })
    }
    await page.screenshot({ path: testInfo.outputPath('prepared-page.png'), fullPage: true })
    const before = h.db.prepare('SELECT total_changes() n').get().n
    h.db.pragma('query_only = ON')
    await page.reload(); await expect(select).toBeEnabled(); await select.selectOption(selected.id); await checkButton.click()
    await expect(panel.getByText('已准备（仅本地素材）', { exact: true })).toBeVisible()
    expect(counts).toEqual({ get: 3, post: 1 }); expect(h.db.prepare('SELECT total_changes() n').get().n).toBe(before)
    // Delay an actual GET, switch A -> B -> A, then deliver it: no old success may refill the page.
    gate = deferred(); lateEntered = deferred(); holdNext = true
    await checkButton.click(); await lateEntered.promise
    await select.selectOption(other.id); await select.selectOption(selected.id); gate.resolve()
    await expect(checkButton).toBeEnabled(); await expect(prepareButton).toBeDisabled()
    await expect(panel.getByText('待检查素材', { exact: true })).toBeVisible()
    const endpoint = `/api/v1/redraw/versions/${h.versionId}/execution-queues/${h.queueState.queue.id}/units/${encodeURIComponent(selected.id)}/reference-materials`
    const query = { review_id: String(h.queueState.saved_review.id), plan_hash: h.queueState.preview.plan_hash, unit_hash: selected.unit_hash }
    const getStatus = (extra = {}, headers = {}) => page.evaluate(async ({ endpoint, query, extra, headers }) => {
      const response = await fetch(`${endpoint}?${new URLSearchParams({ ...query, ...extra })}`, { headers })
      return { status: response.status, body: await response.json() }
    }, { endpoint, query, extra, headers })
    expect((await getStatus({}, { 'x-fixture-owner': 'other' })).status).toBe(404)
    expect((await getStatus({ plan_hash: '0'.repeat(64) })).status).toBe(409)
    expect((await getStatus({ path: 'forbidden' })).status).toBe(400)
    expect(counts).toEqual({ get: 7, post: 1 }); expect(pageErrors).toEqual([]); expect(unexpectedRequests).toEqual([])
    fs.writeFileSync(testInfo.outputPath('actual-materials-receipt.json'), JSON.stringify({ scope: 'pre-approved synthetic inputs, actual services and media; no provider/full-product acceptance',
      first: first.data, prepared, counts, pageErrors, unexpectedRequests, logs,
      refreshWhilePreparing: { samePanelInstance, pendingCounts, pendingRefreshWrites, reconciled },
      storageWritesOnRefresh: h.db.prepare('SELECT total_changes() n').get().n - before }, null, 2), { flag: 'wx' })
  } catch (error) {
    primaryError = error
  } finally {
    gate?.resolve()
    const failures = []
    if (postFinished) try { await postFinished } catch (error) { failures.push(error) }
    if (context) try { await context.close() } catch (error) { failures.push(error) }
    if (server) try { await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) } catch (error) { failures.push(error) }
    if (stopBuild) try { await stopBuild() } catch (error) { failures.push(error) }
    for (const finish of cleanup) try { await finish() } catch (error) { failures.push(error) }
    process.chdir(previousCwd)
    // Exact directory was made by this test and checked against the OS temp parent.
    try {
      if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('g4-unit-materials-browser-')) throw Error('unsafe cleanup target')
      fs.rmSync(temporary, { recursive: true, force: true })
    } catch (error) { failures.push(error) }
    fs.writeFileSync(testInfo.outputPath('cleanup-receipt.json'), JSON.stringify({
      primary: primaryError ? String(primaryError.stack || primaryError) : null,
      failures: failures.map(error => String(error.stack || error)), serverClosed: !server?.listening,
      browserContextClosed: !context || context.pages().length === 0,
      temporary, temporaryRemoved: !fs.existsSync(temporary), fixtureCleanupCount: cleanup.length,
    }, null, 2), { flag: 'wx' })
    if (primaryError && !failures.length) throw primaryError
    if (primaryError || failures.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...failures], 'primary and owned fixture cleanup errors')
  }
})
