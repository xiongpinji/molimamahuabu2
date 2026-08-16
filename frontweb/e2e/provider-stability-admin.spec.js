import { test, expect } from '@playwright/test'

function json(data) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
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

test('管理员可见供应商故障和自动切换日志且页面不泄露密钥', async ({ page }) => {
  await setSession(page, 'admin')
  const calls = { routes: 0, events: 0 }
  await page.route('**/api/v1/**', async (route) => {
    const { pathname } = new URL(route.request().url())

    if (pathname === '/api/v1/ai-configs') return route.fulfill(json([]))
    if (pathname === '/api/v1/ai-configs/vendor-lock') {
      return route.fulfill(json({ enabled: false, config_file: '' }))
    }
    if (pathname === '/api/v1/settings/generation') {
      return route.fulfill(json({ concurrency: 3, video_concurrency: 3 }))
    }
    if (pathname === '/api/v1/admin/provider-stability/routes') {
      calls.routes += 1
      return route.fulfill(json({
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
      }))
    }
    if (pathname === '/api/v1/admin/provider-stability/events') {
      calls.events += 1
      return route.fulfill(json([
        {
          id: 1,
          severity: 'critical',
          event_type: 'provider_failure',
          logical_model_id: 'logical-image',
          task_state: 'failed',
          credit_state: 'held',
          safe_details: { category: 'provider_unavailable' },
          created_at: '2026-08-16T08:00:00.000Z',
        },
        {
          id: 2,
          severity: 'warning',
          event_type: 'route_switched',
          logical_model_id: 'logical-image',
          task_state: 'succeeded',
          credit_state: 'confirmed',
          safe_details: { category: 'provider_unavailable', state: 'switching' },
          created_at: '2026-08-16T08:00:01.000Z',
        },
      ]))
    }

    return route.fulfill(json({}))
  })

  await page.goto('/ai-config')
  await page.getByRole('tab', { name: '稳定性' }).click()

  await expect(page.getByRole('heading', { name: '模型稳定性与自动切换' })).toBeVisible()
  await expect(page.getByText('主图片中转 · relay.example.com · #101')).toBeVisible()
  await expect(page.getByText(/P0 · provider_failure · logical-image/)).toBeVisible()
  await expect(page.getByRole('cell', { name: 'route_switched' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'confirmed' }).first()).toBeVisible()
  await expect.poll(() => calls).toEqual({ routes: 1, events: 1 })

  const body = await page.locator('body').innerText()
  for (const secret of ['sk-never-return-this', 'token=hidden', 'signed.example', 'prompt text']) {
    expect(body).not.toContain(secret)
  }
})

test('普通用户无法进入供应商稳定性管理页', async ({ page }) => {
  await setSession(page, 'user')
  await page.route('**/api/v1/**', (route) => route.fulfill(json([])))
  await page.goto('/ai-config')

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('region', { name: '供应商稳定性管理' })).toHaveCount(0)
})
