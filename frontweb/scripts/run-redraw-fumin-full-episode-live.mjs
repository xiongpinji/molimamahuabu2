import { pathToFileURL } from 'node:url'

export {
  createProviderAdapter,
  loadEpisodePackage,
  parseArgs,
  runStage,
} from './run-redraw-episode-blueprint-live.mjs'

export async function main(argv = process.argv.slice(2), adapters = {}) {
  const runner = await import('./run-redraw-episode-blueprint-live.mjs')
  return runner.main(argv, {
    providerName: 'fumin',
    ...adapters,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(String(error?.code || error?.message || 'REDRAW_FUMIN_EPISODE_RUNNER_FAILED'))
    process.exitCode = 1
  })
}
