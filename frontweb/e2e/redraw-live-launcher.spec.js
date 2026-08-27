import { expect, test } from '@playwright/test'

import { redrawLiveNineShotProject } from './fixtures/redraw-live-nine-shot-project.js'
import { createRedrawLiveProductHarness, redactLiveProductSummary } from './support/redraw-live-product-harness.mjs'

test('dry-run launcher prepares nine reference-ready shots with zero generate and zero external fetch', async () => {
  expect(redrawLiveNineShotProject.shots).toHaveLength(9)
  expect(() => JSON.stringify(redrawLiveNineShotProject)).not.toThrow()
  expect(JSON.stringify(redrawLiveNineShotProject)).not.toMatch(/[A-Za-z]:\\\\|\/Users\/|\/home\//)

  const harness = await createRedrawLiveProductHarness({ fixture: redrawLiveNineShotProject })
  try {
    const result = await harness.prepareDryRun()
    expect(result.counts).toMatchObject({ generationSubmits: 0, externalFetches: 0, fakeProviderCalls: 0 })
    expect(result.shots).toHaveLength(9)
    expect(result.shots.every((shot) => shot.preparation_state === 'reference_ready')).toBe(true)
    expect(result.context).toMatchObject({ authToken: expect.any(String), tenantId: expect.any(String), workId: expect.any(Number), versionId: expect.any(Number) })
    expect(result.context.shotIds).toHaveLength(9)
    expect(result.context.authToken).not.toBe('')
    expect(result.summary).toMatchObject({ dry_run: true, shot_count: 9, reference_ready: 9, generation_submits: 0 })
    const text = JSON.stringify(redactLiveProductSummary(result))
    expect(text).not.toContain(result.context.authToken)
    expect(text).not.toMatch(/Authorization|Bearer|FUMIN_API_KEY|[A-Za-z]:\\\\|\/Users\/|\/home\//)
  } finally {
    await harness.close()
  }
})

test('launcher guard blocks generate routes and non-localhost fetches before side effects', async () => {
  const harness = await createRedrawLiveProductHarness({ fixture: redrawLiveNineShotProject })
  try {
    await expect(harness.guardedFetch('https://example.com/')).rejects.toThrow(/external fetch blocked/)
    await expect(harness.guardedFetch('/api/v1/redraw/shots/1/generate', { method: 'POST' })).rejects.toThrow(/generate route blocked/)
    const result = await harness.prepareDryRun()
    expect(result.counts).toMatchObject({ generationSubmits: 0, externalFetches: 0, fakeProviderCalls: 0 })
  } finally {
    await harness.close()
  }
})
