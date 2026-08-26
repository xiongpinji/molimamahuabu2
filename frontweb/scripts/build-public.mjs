import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import {
  collectBuildAssets,
  finalizeReleaseAssets,
  readPreviousReleaseAssets,
} from './release-asset-compat.mjs'

process.env.VITE_PUBLIC_PLATFORM_MODE = 'true'
const distDir = fileURLToPath(new URL('../dist', import.meta.url))
const previousAssets = await readPreviousReleaseAssets(distDir)
const buildResult = await build({ build: { emptyOutDir: false } })
await finalizeReleaseAssets(distDir, previousAssets, collectBuildAssets(buildResult))
