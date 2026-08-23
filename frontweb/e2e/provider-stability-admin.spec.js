import { test, expect } from '@playwright/test'

function json(data, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify({ success: status < 400, data }),
  }
}

async function setSession(page, role) {
  await page.addInitScript((role) => {
    localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'browser-session-token',
      user: { id: 'current-user', email: 'user@example.com', role },
    }))
  }, role)
}

function routePayload(canaryPaused = false) {
  return {
    configs: [{
      id: 101,
      name: '主图片中转',
      provider: 'openai',
      relay_host: 'relay.example.com',
      default_model: 'upstream-image',
      logical_model_id: 'logical-image',
      priority: 100,
      failover_enabled: true,
      admin_paused: false,
      canary_paused: canaryPaused,
      verification_status: 'verified',
      health: { state: 'degraded', consecutive_failures: 1 },
      last_switch_at: '2026-08-16T08:00:00.000Z',
    }],
    requests: [{
      id: 'route-request-1',
      logical_model_id: 'logical-image',
      business_type: 'image_generation',
      state: 'succeeded',
      credit_state: 'confirmed',
      updated_at: '2026-08-16T08:00:01.000Z',
    }],
  }
}

function summaryPayload(canaryPaused = false) {
  return {
    mode: 'enforce',
    budget: {
      budget_day: '2026-08-19',
      budget_month: '2026-08',
      daily_limit_micros: 20_000_000,
      monthly_limit_micros: 600_000_000,
      daily_used_micros: 7_500_000,
      monthly_used_micros: 125_000_000,
      daily_remaining_micros: 12_500_000,
      monthly_remaining_micros: 475_000_000,
      daily_unknown_micros: 500_000,
      monthly_unknown_micros: 500_000,
    },
    routes: [{
      route_id: 101,
      route_name: '线路-a1b2c3d4',
      logical_model_id: 'logical-image',
      service_type: 'image',
      canary_paused: canaryPaused,
      public_state: 'hidden',
      would_be_hidden: true,
      latest_zero_cost_check: {
        state: 'degraded',
        category: 'provider_read_only_failed',
        checked_at: '2026-08-19T01:00:00.000Z',
      },
      latest_real_success_at: '2026-08-17T01:00:00.000Z',
      evidence_expires_at: '2026-08-18T01:00:00.000Z',
      evidence_state: 'stale',
      budget_block_reason: null,
    }],
  }
}

function eventsPayload() {
  return ['P0', 'P1', 'P2', 'P3'].map((alertLevel, index) => ({
    id: index + 1,
    alert_level: alertLevel,
    severity: ['critical', 'error', 'warning', 'info'][index],
    event_type: `safe_event_${index}`,
    logical_model_id: 'logical-image',
    task_state: index ? 'succeeded' : 'failed',
    credit_state: index ? 'confirmed' : 'held',
    safe_details: { category: `safe_category_${index}` },
    created_at: `2026-08-19T0${index}:00:00.000Z`,
  }))
}

function firstRunsPage() {
  return {
    items: [
      {
        id: 'run-success',
        logical_model_id: 'logical-image',
        route_name: '线路-a1b2c3d4',
        service_type: 'image',
        state: 'succeeded',
        cost: { reserved_micros: 400_000, actual_micros: 400_000, currency: 'CNY' },
        times: { updated_at: '2026-08-19T02:00:00.000Z' },
        error_category: null,
        reconcilable: false,
      },
      {
        id: 'run-unknown',
        logical_model_id: 'logical-video',
        route_name: '线路-e5f6a7b8',
        service_type: 'video',
        state: 'result_unknown',
        cost: { reserved_micros: 950_000, actual_micros: null, currency: 'CNY' },
        times: { updated_at: '2026-08-19T01:00:00.000Z' },
        error_category: 'query_protocol_error',
        reconcilable: true,
      },
    ],
    pagination: { limit: 2, has_more: true, next_cursor: 'next-safe-cursor' },
  }
}

function submissionUnknownRun() {
  return {
    id: 'run-submission-unknown',
    logical_model_id: 'logical-video',
    route_name: '线路-e5f6a7b8',
    service_type: 'video',
    state: 'submission_unknown',
    cost: { reserved_micros: 800_000, actual_micros: null, currency: 'CNY' },
    times: { updated_at: '2026-08-18T01:00:00.000Z' },
    error_category: 'result_unknown',
    reconcilable: false,
  }
}

async function mockAdminApis(page, state = {}) {
  state.canaryPaused = false
  state.reconcileCalls = 0
  state.pauseCalls = 0
  state.pages = []
  state.routeCalls = 0
  state.patches = []
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const { pathname, searchParams } = new URL(request.url())
    if (pathname === '/api/v1/ai-configs') return route.fulfill(json([]))
    if (pathname === '/api/v1/ai-configs/vendor-lock') {
      return route.fulfill(json({ enabled: false, config_file: '' }))
    }
    if (pathname === '/api/v1/settings/generation') {
      return route.fulfill(json({ concurrency: 3, video_concurrency: 3 }))
    }
    if (pathname === '/api/v1/admin/provider-stability/routes' && request.method() === 'GET') {
      state.routeCalls += 1
      return route.fulfill(json(routePayload(state.canaryPaused)))
    }
    if (pathname === '/api/v1/admin/provider-stability/events') {
      return route.fulfill(json(eventsPayload()))
    }
    if (pathname === '/api/v1/admin/provider-stability/canary/summary') {
      return route.fulfill(json(summaryPayload(state.canaryPaused)))
    }
    if (pathname === '/api/v1/admin/provider-stability/canary/runs') {
      const before = searchParams.get('before')
      state.pages.push(before || 'first')
      return route.fulfill(json(before ? {
        items: [submissionUnknownRun(), submissionUnknownRun()],
        pagination: { limit: 2, has_more: false, next_cursor: null },
      } : firstRunsPage()))
    }
    if (pathname === '/api/v1/admin/provider-stability/canary/runs/run-unknown/reconcile') {
      state.reconcileCalls += 1
      expect(request.postDataJSON()).toEqual({})
      return route.fulfill(json({
        id: 'run-unknown', state: 'result_unknown', reconciled: false,
        error_category: 'query_protocol_error', reconcilable: false,
      }))
    }
    if (pathname === '/api/v1/admin/provider-stability/routes/101' && request.method() === 'PATCH') {
      const body = request.postDataJSON()
      state.patches.push(body)
      if (Object.hasOwn(body, 'canary_paused')) {
        state.pauseCalls += 1
        state.canaryPaused = body.canary_paused
      }
      return route.fulfill(json({ ...routePayload(state.canaryPaused).configs[0], ...body }))
    }
    return route.fulfill(json({}))
  })
}

test('管理员可查看预算、过期证据、未知运行和安全告警并执行受控操作', async ({ page }) => {
  await setSession(page, 'admin')
  const state = {}
  await mockAdminApis(page, state)

  await page.goto('/ai-config')
  await page.getByRole('tab', { name: '稳定性' }).click()

  await expect(page.getByRole('heading', { name: '模型稳定性与自动切换' })).toBeVisible()
  await expect(page.getByTestId('daily-canary-budget')).toContainText('¥7.50 / ¥20.00')
  await expect(page.getByTestId('monthly-canary-budget')).toContainText('¥125.00 / ¥600.00')
  await expect(page.getByText('已过期', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('主图片中转 · relay.example.com · #101')).toBeVisible()

  const runs = page.getByTestId('canary-run-row')
  await expect(runs.first()).toContainText('run-unknown')
  await expect(runs.first()).toContainText('结果未知')
  await page.getByRole('button', { name: '只读对账' }).click()
  await expect.poll(() => state.reconcileCalls).toBe(1)

  await page.getByRole('button', { name: '巡检暂停' }).click()
  await expect(page.getByText('证据失效后模型可能从用户目录隐藏')).toBeVisible()
  await page.getByRole('button', { name: '确定' }).click()
  await expect.poll(() => state.pauseCalls).toBe(1)
  await expect(page.getByTestId('canary-route-table').getByRole('button', { name: '恢复巡检' }))
    .toBeVisible()

  await page.getByRole('button', { name: '加载更多巡检记录' }).click()
  await expect.poll(() => state.pages.at(-1)).toBe('next-safe-cursor')
  await expect(page.getByText('run-submission-unknown')).toBeVisible()
  await expect(runs).toHaveCount(3)
  expect(await runs.allTextContents()).toEqual(expect.arrayContaining([
    expect.stringContaining('run-unknown'),
    expect.stringContaining('run-success'),
    expect.stringContaining('run-submission-unknown'),
  ]))

  for (const level of ['P0', 'P1', 'P2', 'P3']) {
    await expect(page.getByText(level, { exact: true }).first()).toBeVisible()
  }
  const body = await page.locator('body').innerText()
  for (const secret of [
    'sk-never-return-this', 'token=hidden', 'signed.example', 'prompt text',
    'Authorization', 'https://relay.example.com/v1',
  ]) expect(body).not.toContain(secret)
})

test('既有线路策略、逻辑模型移动、人工暂停和刷新交互不回归', async ({ page }) => {
  await setSession(page, 'admin')
  const state = {}
  await mockAdminApis(page, state)
  await page.goto('/ai-config')
  await page.getByRole('tab', { name: '稳定性' }).click()

  const routeTable = page.getByTestId('provider-route-table')
  await routeTable.getByRole('button', { name: '策略' }).click()
  const dialog = page.getByRole('dialog', { name: '稳定性策略' })
  await dialog.locator('input').nth(0).fill('logical-image-moved')
  await dialog.locator('input').nth(1).fill('80')
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect.poll(() => state.patches.some((body) => (
    body.logical_model_id === 'logical-image-moved'
      && body.priority === 80
      && body.failover_enabled === true
  ))).toBe(true)

  await routeTable.getByRole('button', { name: '暂停', exact: true }).click()
  await expect.poll(() => state.patches.some((body) => body.admin_paused === true)).toBe(true)

  const callsBeforeRefresh = state.routeCalls
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect.poll(() => state.routeCalls).toBeGreaterThan(callsBeforeRefresh)
})

test('巡检接口失败显示错误 toast', async ({ page }) => {
  await setSession(page, 'admin')
  await mockAdminApis(page, {})
  await page.route('**/api/v1/admin/provider-stability/canary/summary', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ success: false, error: { message: '巡检摘要暂不可用' } }),
  }))

  await page.goto('/ai-config')
  await page.getByRole('tab', { name: '稳定性' }).click()
  const matchingToasts = page.locator('.el-message--error').filter({ hasText: '巡检摘要暂不可用' })
  await expect(matchingToasts.first()).toBeVisible()
  await expect(matchingToasts).toHaveCount(1)
})

test('窄屏稳定性面板可纵向滚动且页面没有横向泄漏', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 })
  await setSession(page, 'admin')
  await mockAdminApis(page, {})
  await page.goto('/ai-config')
  await page.getByRole('tab', { name: '稳定性' }).click()

  const panel = page.getByRole('region', { name: '供应商稳定性管理' })
  await expect(panel).toBeVisible()
  const dimensions = await panel.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }))
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight)
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth)
})

test('普通用户无法进入供应商稳定性管理页', async ({ page }) => {
  await setSession(page, 'user')
  await page.route('**/api/v1/**', (route) => route.fulfill(json([])))
  await page.goto('/ai-config')

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('region', { name: '供应商稳定性管理' })).toHaveCount(0)
})
