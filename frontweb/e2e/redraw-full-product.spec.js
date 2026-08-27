import { expect, test } from '@playwright/test'

import { genericFullProductAcceptance } from './fixtures/redraw-generic-project.js'

const enabled = process.env.REDRAW_E2E_FAKE_PROVIDER === '1'
const runRedrawFullProductFlow = enabled
  ? (await import('./redraw-backend-integration.spec.js')).runRedrawFullProductFlow
  : null

test.skip(
  !enabled,
  '本地完整链必须显式启用 REDRAW_E2E_FAKE_PROVIDER=1',
)

test('通用三镜从空库完成生成、候选 QA、整集发布与刷新恢复', async ({ page }) => {
  expect(typeof runRedrawFullProductFlow).toBe('function')
  const evidence = await runRedrawFullProductFlow({ page })

  expect(evidence).toMatchObject(genericFullProductAcceptance)
  expect(evidence.network).toEqual({ public_requests: 0, real_provider_requests: 0 })
})
