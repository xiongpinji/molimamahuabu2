import fs from 'node:fs/promises'
import path from 'node:path'

const MANIFEST_NAME = '.release-assets.json'

function normalizeAssetPath(value) {
  const raw = String(value || '').replaceAll('\\', '/')
  const normalized = path.posix.normalize(raw)
  if (!raw.startsWith('assets/') || normalized !== raw || normalized.includes('../')) {
    throw new Error(`Invalid release asset path: ${value}`)
  }
  return normalized
}

async function listAssetFiles(distDir, relativeDir = 'assets') {
  const directory = path.join(distDir, ...relativeDir.split('/'))
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  const files = []
  for (const entry of entries) {
    const relativePath = `${relativeDir}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...await listAssetFiles(distDir, relativePath))
    } else if (entry.isFile()) {
      files.push(relativePath)
    }
  }
  return files.sort()
}

async function readManifest(distDir) {
  try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(distDir, MANIFEST_NAME), 'utf8'),
    )
    if (manifest.schema_version !== 1 || !Array.isArray(manifest.current_assets)) {
      throw new Error('Invalid release asset manifest')
    }
    return {
      currentAssets: [...new Set(manifest.current_assets.map(normalizeAssetPath))].sort(),
      previousAssets: [...new Set(
        (manifest.previous_assets || []).map(normalizeAssetPath),
      )].sort(),
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function areSameAssets(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export async function readPreviousReleaseAssets(distDir) {
  const manifest = await readManifest(distDir)
  return manifest?.currentAssets || listAssetFiles(distDir)
}

export function collectBuildAssets(buildResult) {
  const outputs = (Array.isArray(buildResult) ? buildResult : [buildResult])
    .flatMap((result) => result?.output || [])
  return [...new Set(outputs
    .map((entry) => entry?.fileName)
    .filter((fileName) => String(fileName || '').startsWith('assets/'))
    .map(normalizeAssetPath))].sort()
}

export async function finalizeReleaseAssets(distDir, previousAssets, currentAssets) {
  const previous = previousAssets.map(normalizeAssetPath)
  const current = [...new Set(currentAssets.map(normalizeAssetPath))].sort()
  if (current.length === 0) throw new Error('Vite build produced no release assets')

  const existingManifest = await readManifest(distDir)
  const retainedPrevious = existingManifest
    && areSameAssets(existingManifest.currentAssets, current)
    ? existingManifest.previousAssets
    : previous
  const previousToKeep = [...new Set(retainedPrevious)]
    .filter((relativePath) => !current.includes(relativePath))
    .sort()

  const keep = new Set([...previousToKeep, ...current])
  for (const relativePath of await listAssetFiles(distDir)) {
    if (!keep.has(relativePath)) {
      await fs.rm(path.join(distDir, ...relativePath.split('/')))
    }
  }

  await fs.writeFile(path.join(distDir, MANIFEST_NAME), `${JSON.stringify({
    schema_version: 1,
    current_assets: current,
    previous_assets: previousToKeep,
  }, null, 2)}\n`)
}
