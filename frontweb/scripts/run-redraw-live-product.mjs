import { redrawLiveNineShotProject } from '../e2e/fixtures/redraw-live-nine-shot-project.js'
import { createRedrawLiveProductHarness, redactLiveProductSummary } from '../e2e/support/redraw-live-product-harness.mjs'

const harness = await createRedrawLiveProductHarness({ fixture: redrawLiveNineShotProject })

try {
  const result = await harness.prepareDryRun()
  process.stdout.write(`${JSON.stringify(redactLiveProductSummary(result), null, 2)}\n`)
} finally {
  await harness.close()
}
