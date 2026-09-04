import { pathToFileURL } from 'node:url'
import { buildFuminEpisodeExecutionPlan } from './fuminEpisodeExecutionPlan.mjs'
import { materializeFuminExecutionMotion } from './fuminExecutionMotion.mjs'
import {
  assembleNormalizedEpisode,
  normalizeUnitArtifact,
} from './fuminEpisodeMediaPipeline.mjs'
import { createFuminEpisodeProviderAdapter } from './fuminEpisodeProviderAdapter.mjs'

export {
  loadEpisodePackage,
  parseArgs,
  runStage,
} from './run-redraw-episode-blueprint-live.mjs'

export async function main(argv = process.argv.slice(2), adapters = {}) {
  const runner = await import('./run-redraw-episode-blueprint-live.mjs')
  const provider = adapters.provider || createFuminEpisodeProviderAdapter({
    buildExecutionPlan: buildFuminEpisodeExecutionPlan,
    materializeMotion: materializeFuminExecutionMotion,
    normalizeUnitArtifact,
    assembleNormalizedEpisode,
    ...adapters,
  })
  return runner.main(argv, {
    ...adapters,
    provider,
    providerName: 'fumin',
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(String(error?.code || error?.message || 'REDRAW_FUMIN_EPISODE_RUNNER_FAILED'))
    process.exitCode = 1
  })
}
