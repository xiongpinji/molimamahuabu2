import { redrawLatinAmericanCase } from '../e2e/fixtures/redraw-latin-american-case.js'
import { redrawLiveNineShotProject } from '../e2e/fixtures/redraw-live-nine-shot-project.js'
import {
  buildRedrawLiveProductFixture,
  createRedrawLiveProductHarness,
  redactLiveProductSummary,
} from '../e2e/support/redraw-live-product-harness.mjs'

const fixture = buildRedrawLiveProductFixture(
  redrawLatinAmericanCase,
  redrawLiveNineShotProject.required_inputs,
)
let harness

try {
  harness = await createRedrawLiveProductHarness({ fixture })
  const result = await harness.prepareDryRun()
  process.stdout.write(`${JSON.stringify(redactLiveProductSummary(result), null, 2)}\n`)
} catch (error) {
  const message = String(error?.message || '')
  if (/required local media is missing/i.test(message)) {
    process.stdout.write(`${JSON.stringify({
      status: 'blocked',
      blocker: 'required_local_media_missing',
      required_inputs: { source_video: 1, identity_images: 5, motion_references: 9 },
    }, null, 2)}\n`)
    process.exitCode = 2
  } else {
    throw error
  }
} finally {
  await harness?.close()
}
