import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { EPISODE_VIDEO_ROUTES } from './episodeVideoRouteRegistry.mjs'
import { runFallbackEpisode } from './run-redraw-video-model-fallback-live.mjs'

const HEAD = '8'.repeat(40)

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function canonicalHash(value, omittedKey) {
  const copy = JSON.parse(JSON.stringify(value))
  if (omittedKey) delete copy[omittedKey]
  return crypto.createHash('sha256').update(stableStringify(copy)).digest('hex')
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-fallback-'))
  const packagePath = path.join(root, 'episode-package.json')
  fs.writeFileSync(packagePath, '{"fixture":true}\n')
  return { root, packagePath, stateDir: path.join(root, 'state') }
}

function units() {
  return Array.from({ length: 28 }, (_, index) => ({
    unit_id: index === 0 ? 'shot-01.part-01' : `shot-${String(index + 1).padStart(2, '0')}.part-01`,
    unit_hash: String(index + 1).padStart(64, '0'),
  }))
}

function fakeDependencies(outcomes) {
  const stageCalls = []
  const providerRoutes = []
  const allUnits = units()
  return {
    stageCalls,
    providerRoutes,
    currentHead: () => HEAD,
    loadEpisodePackage: (packagePath) => ({
      package_path: packagePath,
      blueprint_hash: 'b'.repeat(64),
      localization_hash: 'c'.repeat(64),
      production_packs: Array.from({ length: 24 }, (_, index) => ({ shot_id: `shot-${index + 1}` })),
    }),
    createProvider: ({ route, beforeGenerationSubmit }) => {
      providerRoutes.push(route.id)
      return { name: route.id, route, beforeGenerationSubmit }
    },
    runStage: async (options, { provider }) => {
      stageCalls.push([provider.name, options.stage, options.unitId || null])
      if (options.stage === 'preflight') {
        return {
          package_sha256: 'd'.repeat(64),
          execution_plan_hash: `${providerRoutes.length}`.padStart(64, '0'),
          execution_units: allUnits,
        }
      }
      if (options.stage === 'shot') {
        await provider.beforeGenerationSubmit({
          route_id: provider.name,
          unit_id: options.unitId,
          model: provider.route.model,
        })
        const outcome = outcomes[provider.name] || 'success'
        if (outcome === 'explicit') {
          const error = new Error(`${provider.name} explicit failure`)
          error.code = 'FAKE_PROVIDER_FAILED'
          error.provider_terminal_failure = true
          error.provider_reason = `${provider.name} explicit failure`
          throw error
        }
        if (outcome === 'unknown') {
          const error = new Error(`${provider.name} unknown`)
          error.code = 'FAKE_PROVIDER_STATUS_UNKNOWN'
          error.indeterminate = true
          throw error
        }
        if (outcome === 'verification') {
          const error = new Error(`${provider.name} artifact rejected`)
          error.code = 'FAKE_ARTIFACT_REJECTED'
          throw error
        }
        return { status: 'completed_verified' }
      }
      if (options.stage === 'sequence') {
        for (const item of allUnits.slice(1)) {
          await provider.beforeGenerationSubmit({
            route_id: provider.name,
            unit_id: item.unit_id,
            model: provider.route.model,
          })
        }
        return { status: 'in_progress' }
      }
      if (options.stage === 'assemble') {
        return { status: 'assembled_verified', episode_artifact: { sha256: 'e'.repeat(64), artifact_id: 'outputs/episode/episode.mp4' } }
      }
      if (options.stage === 'verify') {
        return {
          status: 'assembled_verified',
          episode_artifact: { sha256: 'e'.repeat(64), artifact_id: 'outputs/episode/episode.mp4' },
          tasks: [{ verification: { role: { review_status: 'pending_external_review' } } }],
        }
      }
      throw new Error(`unexpected stage ${options.stage}`)
    },
    now: () => new Date('2026-09-05T00:00:00.000Z'),
  }
}

function readManifest(stateDir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'fallback-manifest.json'), 'utf8'))
}

test('missing keys skip every route before preflight, upload, or generation submission', async () => {
  const item = fixture()
  try {
    const deps = fakeDependencies({})
    await assert.rejects(
      () => runFallbackEpisode({
        episodePackage: item.packagePath,
        stateDir: item.stateDir,
        sourceHead: HEAD,
        keys: {},
      }, deps),
      { code: 'REDRAW_EPISODE_NO_PROVIDER_KEY' },
    )
    const manifest = readManifest(item.stateDir)
    assert.equal(deps.stageCalls.length, 0)
    assert.equal(manifest.generation_attempts.length, 0)
    assert.equal(manifest.routes.every((route) => route.status === 'skipped_missing_key'), true)
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('default source HEAD lookup works from the script directory before any provider work', async () => {
  const item = fixture()
  try {
    const deps = fakeDependencies({})
    delete deps.currentHead
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
    await assert.rejects(
      () => runFallbackEpisode({
        episodePackage: item.packagePath,
        stateDir: item.stateDir,
        sourceHead,
        keys: {},
      }, deps),
      { code: 'REDRAW_EPISODE_NO_PROVIDER_KEY' },
    )
    assert.equal(deps.stageCalls.length, 0)
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('an explicit gate failure falls back and the first passing route owns all 28 units', async () => {
  const item = fixture()
  try {
    const deps = fakeDependencies({ 'fumin-fast': 'explicit' })
    const manifest = await runFallbackEpisode({
      episodePackage: item.packagePath,
      stateDir: item.stateDir,
      sourceHead: HEAD,
      keys: { fumin: 'key-fumin', toapis: 'key-toapis', feituo: 'key-feituo' },
    }, deps)

    assert.equal(manifest.status, 'completed_verified')
    assert.equal(manifest.visual_review_status, 'pending_external_review')
    assert.equal(manifest.winner_route_id, 'toapis-fast')
    assert.equal(manifest.generation_attempts.length, 29)
    assert.deepEqual(
      manifest.generation_attempts.map((attempt) => attempt.route_id),
      ['fumin-fast', ...Array(28).fill('toapis-fast')],
    )
    assert.equal(manifest.episode_artifact.sha256, 'e'.repeat(64))
    assert.deepEqual(deps.providerRoutes, ['fumin-fast', 'toapis-fast'])
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('three explicit failures plus the fourth winner reaches but never exceeds 31 submissions', async () => {
  const item = fixture()
  try {
    const deps = fakeDependencies({
      'fumin-fast': 'explicit',
      'toapis-fast': 'explicit',
      'toapis-wan3': 'explicit',
    })
    const manifest = await runFallbackEpisode({
      episodePackage: item.packagePath,
      stateDir: item.stateDir,
      sourceHead: HEAD,
      keys: { fumin: 'key-fumin', toapis: 'key-toapis', feituo: 'key-feituo' },
    }, deps)
    assert.equal(manifest.winner_route_id, 'feituo-seedance-2.5')
    assert.equal(manifest.generation_attempts.length, 31)
    assert.equal(manifest.generation_attempts.filter((attempt) => attempt.route_id === 'feituo-seedance-2.5').length, 28)
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('unknown gate state stops globally without constructing the next provider', async () => {
  const item = fixture()
  try {
    const deps = fakeDependencies({ 'fumin-fast': 'unknown' })
    await assert.rejects(
      () => runFallbackEpisode({
        episodePackage: item.packagePath,
        stateDir: item.stateDir,
        sourceHead: HEAD,
        keys: { fumin: 'key-fumin', toapis: 'key-toapis', feituo: 'key-feituo' },
      }, deps),
      { code: 'FAKE_PROVIDER_STATUS_UNKNOWN' },
    )
    const manifest = readManifest(item.stateDir)
    assert.equal(manifest.status, 'needs_attention')
    assert.equal(manifest.generation_attempts.length, 1)
    assert.deepEqual(deps.providerRoutes, ['fumin-fast'])
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('a completed but rejected artifact stops globally instead of mixing models', async () => {
  const item = fixture()
  try {
    const deps = fakeDependencies({ 'fumin-fast': 'verification' })
    await assert.rejects(
      () => runFallbackEpisode({
        episodePackage: item.packagePath,
        stateDir: item.stateDir,
        sourceHead: HEAD,
        keys: { fumin: 'key-fumin', toapis: 'key-toapis' },
      }, deps),
      { code: 'FAKE_ARTIFACT_REJECTED' },
    )
    const manifest = readManifest(item.stateDir)
    assert.equal(manifest.status, 'failed')
    assert.equal(manifest.generation_attempts.length, 1)
    assert.deepEqual(deps.providerRoutes, ['fumin-fast'])
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('state reuse and source HEAD drift fail before any provider work', async () => {
  const item = fixture()
  try {
    const deps = fakeDependencies({})
    fs.mkdirSync(item.stateDir)
    fs.writeFileSync(path.join(item.stateDir, 'occupied.txt'), 'do not overwrite')
    await assert.rejects(
      () => runFallbackEpisode({
        episodePackage: item.packagePath,
        stateDir: item.stateDir,
        sourceHead: HEAD,
        keys: { fumin: 'key-fumin' },
      }, deps),
      { code: 'REDRAW_EPISODE_FALLBACK_STATE_EXISTS' },
    )
    assert.equal(deps.stageCalls.length, 0)

    const second = fixture()
    try {
      await assert.rejects(
        () => runFallbackEpisode({
          episodePackage: second.packagePath,
          stateDir: second.stateDir,
          sourceHead: '7'.repeat(40),
          keys: { fumin: 'key-fumin' },
        }, deps),
        { code: 'REDRAW_EPISODE_SOURCE_HEAD_MISMATCH' },
      )
      assert.equal(fs.existsSync(second.stateDir), false)
    } finally {
      fs.rmSync(second.root, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('an existing empty state directory is rejected as reuse before provider work', async () => {
  const item = fixture()
  try {
    const deps = fakeDependencies({})
    fs.mkdirSync(item.stateDir)
    await assert.rejects(
      () => runFallbackEpisode({
        episodePackage: item.packagePath,
        stateDir: item.stateDir,
        sourceHead: HEAD,
        keys: { fumin: 'key-fumin' },
      }, deps),
      { code: 'REDRAW_EPISODE_FALLBACK_STATE_EXISTS' },
    )
    assert.equal(deps.stageCalls.length, 0)
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('approved route registry remains the sole default route source', () => {
  assert.equal(EPISODE_VIDEO_ROUTES.length, 4)
  assert.deepEqual(EPISODE_VIDEO_ROUTES.map((route) => route.id), [
    'fumin-fast',
    'toapis-fast',
    'toapis-wan3',
    'feituo-seedance-2.5',
  ])
})

test('default generic runner completes a 28-unit offline episode through one winning route', async () => {
  const item = fixture()
  try {
    const sourcePath = path.join(item.root, 'source.mp4')
    const motionPath = path.join(item.root, 'motion.mp4')
    fs.writeFileSync(sourcePath, 'offline-source-binding')
    fs.writeFileSync(motionPath, 'offline-motion-binding')
    const blueprintHash = 'b'.repeat(64)
    const localizationHash = 'c'.repeat(64)
    let cursor = 0
    const productionPacks = Array.from({ length: 24 }, (_, index) => {
      const duration = index < 4 ? 6000 : 5000
      const shotId = `shot-${String(index + 1).padStart(2, '0')}`
      const pack = {
        schema_version: 'redraw-shot-production-pack-v1',
        shot_id: shotId,
        start_ms: cursor,
        end_ms: cursor + duration,
        duration_ms: duration,
        blueprint_hash: blueprintHash,
        localization_hash: localizationHash,
        characters: [],
        dialogue: [],
        visual_contract: {},
        audio_contract: { locale: 'en-US', speech_required: false },
        prompt: `Offline prompt ${shotId}. Ambient sound only.`,
      }
      cursor += duration
      pack.production_pack_hash = canonicalHash(pack)
      return pack
    })
    const motionReferences = productionPacks.map((pack) => ({
      id: `motion-${pack.shot_id}`,
      kind: 'motion',
      shot_id: pack.shot_id,
      path: motionPath,
      sha256: fileHash(motionPath),
      mime_type: 'video/mp4',
      duration_ms: pack.duration_ms,
    }))
    fs.writeFileSync(item.packagePath, `${JSON.stringify({
      schema_version: 'redraw-episode-production-package-v1',
      blueprint_hash: blueprintHash,
      localization_hash: localizationHash,
      target: { locale: 'en-US', market: 'US' },
      source_media: { path: sourcePath, sha256: fileHash(sourcePath), mime_type: 'video/mp4' },
      identity_references: [],
      motion_references: motionReferences,
      production_packs: productionPacks,
    }, null, 2)}\n`)

    const providerFactory = ({ route, beforeGenerationSubmit }) => {
      const executionUnits = productionPacks.flatMap((pack, packIndex) => {
        const count = packIndex < 4 ? 2 : 1
        return Array.from({ length: count }, (_, partIndex) => {
          const partStart = pack.start_ms + (partIndex * (pack.duration_ms / count))
          const unit = {
            schema_version: 'offline-provider-execution-unit-v1',
            unit_id: `${pack.shot_id}.part-${String(partIndex + 1).padStart(2, '0')}`,
            parent_shot_id: pack.shot_id,
            part_index: partIndex + 1,
            part_count: count,
            source_start_ms: partStart,
            source_end_ms: partStart + (pack.duration_ms / count),
            keep_duration_ms: pack.duration_ms / count,
            provider_duration_seconds: 5,
            parent_production_pack_hash: pack.production_pack_hash,
            dialogue: [],
            identity_reference_ids: [],
            motion_reference_id: `motion-${pack.shot_id}`,
            prompt: pack.prompt,
          }
          unit.unit_hash = canonicalHash(unit)
          return unit
        })
      })
      const plan = {
        schema_version: 'redraw-provider-execution-plan-v1',
        provider: route.id,
        units: executionUnits,
      }
      plan.execution_plan_hash = canonicalHash(plan)
      return {
        name: route.id,
        async prepareEpisode() { return plan },
        async uploadReference(reference) {
          return {
            url: `https://assets.example/${reference.id}`,
            asset_id: `asset-${reference.id}`,
            mime_type: reference.mime_type,
            sha256: reference.sha256,
            duration_seconds: Number(reference.duration_ms) / 1000,
          }
        },
        async submitGeneration({ unit }) {
          await beforeGenerationSubmit({ route_id: route.id, unit_id: unit.unit_id, model: route.model })
          return { task_id: `task-${unit.unit_id}` }
        },
        async pollGeneration({ task_id }) { return { video_url: `https://assets.example/${task_id}.mp4` } },
        async downloadResult({ output_path }) {
          fs.mkdirSync(path.dirname(output_path), { recursive: true })
          fs.writeFileSync(output_path, 'offline-video')
          return { path: output_path, sha256: fileHash(output_path) }
        },
        async inspectArtifact() {
          return { media: { has_audio: true }, language: { locale: 'en-US', passed: true }, role: { passed: true }, dialogue: { exact_dialogue_present: true } }
        },
        async finalizeArtifact({ raw_path, output_path }) {
          fs.mkdirSync(path.dirname(output_path), { recursive: true })
          fs.copyFileSync(raw_path, output_path)
          return { path: output_path, sha256: fileHash(output_path) }
        },
        async assembleEpisode({ output_path }) {
          fs.mkdirSync(path.dirname(output_path), { recursive: true })
          fs.writeFileSync(output_path, 'offline-episode')
          return { path: output_path, sha256: fileHash(output_path) }
        },
        async inspectEpisode() { return { media: { has_audio: true } } },
      }
    }

    const result = await runFallbackEpisode({
      episodePackage: item.packagePath,
      stateDir: item.stateDir,
      sourceHead: HEAD,
      keys: { fumin: 'never-persist-this-secret' },
    }, {
      currentHead: () => HEAD,
      createProvider: providerFactory,
      now: () => new Date('2026-09-05T00:00:00.000Z'),
    })

    assert.equal(result.status, 'completed_verified')
    assert.equal(result.winner_route_id, 'fumin-fast')
    assert.equal(result.generation_attempts.length, 28)
    const child = JSON.parse(fs.readFileSync(path.join(item.stateDir, 'routes', 'fumin-fast', 'private-manifest.json'), 'utf8'))
    assert.equal(child.tasks.length, 28)
    assert.equal(child.tasks.every((task) => task.status === 'completed_verified'), true)
    assert.doesNotMatch(fs.readFileSync(path.join(item.stateDir, 'fallback-manifest.json'), 'utf8'), /never-persist-this-secret/u)
    assert.doesNotMatch(fs.readFileSync(path.join(item.stateDir, 'public-fallback-evidence.json'), 'utf8'), /never-persist-this-secret|child_state_dir/u)
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})
