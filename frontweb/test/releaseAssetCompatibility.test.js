import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  finalizeReleaseAssets,
  readPreviousReleaseAssets,
} from '../scripts/release-asset-compat.mjs'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moli-release-assets-'))
  await fs.mkdir(path.join(root, 'assets'), { recursive: true })
  return root
}

test('构建只保留当前资源和紧邻上一版本资源', async (t) => {
  const distDir = await fixture()
  t.after(() => fs.rm(distDir, { recursive: true, force: true }))

  await fs.writeFile(path.join(distDir, 'assets', 'previous.js'), 'previous')
  await fs.writeFile(path.join(distDir, 'assets', 'two-releases-old.js'), 'old')
  await fs.writeFile(path.join(distDir, '.release-assets.json'), JSON.stringify({
    schema_version: 1,
    current_assets: ['assets/previous.js'],
    previous_assets: ['assets/two-releases-old.js'],
  }))

  const previousAssets = await readPreviousReleaseAssets(distDir)
  assert.deepEqual(previousAssets, ['assets/previous.js'])

  await fs.writeFile(path.join(distDir, 'assets', 'current.js'), 'current')
  await finalizeReleaseAssets(distDir, previousAssets, ['assets/current.js'])

  assert.equal(await fs.readFile(path.join(distDir, 'assets', 'current.js'), 'utf8'), 'current')
  assert.equal(await fs.readFile(path.join(distDir, 'assets', 'previous.js'), 'utf8'), 'previous')
  await assert.rejects(fs.access(path.join(distDir, 'assets', 'two-releases-old.js')))

  const manifest = JSON.parse(await fs.readFile(path.join(distDir, '.release-assets.json'), 'utf8'))
  assert.deepEqual(manifest, {
    schema_version: 1,
    current_assets: ['assets/current.js'],
    previous_assets: ['assets/previous.js'],
  })
})

test('首次启用兼容清单时把现有构建视为上一版本', async (t) => {
  const distDir = await fixture()
  t.after(() => fs.rm(distDir, { recursive: true, force: true }))

  await fs.writeFile(path.join(distDir, 'assets', 'existing.js'), 'existing')
  assert.deepEqual(await readPreviousReleaseAssets(distDir), ['assets/existing.js'])
})

test('同一候选重复构建仍保留原线上上一版本', async (t) => {
  const distDir = await fixture()
  t.after(() => fs.rm(distDir, { recursive: true, force: true }))

  await fs.writeFile(path.join(distDir, 'assets', 'live.js'), 'live')
  const firstPrevious = await readPreviousReleaseAssets(distDir)
  await fs.writeFile(path.join(distDir, 'assets', 'candidate.js'), 'candidate')
  await finalizeReleaseAssets(distDir, firstPrevious, ['assets/candidate.js'])

  const repeatedPrevious = await readPreviousReleaseAssets(distDir)
  await finalizeReleaseAssets(distDir, repeatedPrevious, ['assets/candidate.js'])

  assert.equal(await fs.readFile(path.join(distDir, 'assets', 'live.js'), 'utf8'), 'live')
  assert.equal(await fs.readFile(path.join(distDir, 'assets', 'candidate.js'), 'utf8'), 'candidate')
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(distDir, '.release-assets.json'), 'utf8')),
    {
      schema_version: 1,
      current_assets: ['assets/candidate.js'],
      previous_assets: ['assets/live.js'],
    },
  )
})
