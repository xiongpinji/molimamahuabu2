import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { EPISODE_VIDEO_ROUTES } from './episodeVideoRouteRegistry.mjs'
import * as fallback from './run-redraw-video-model-fallback-live.mjs'

const { runFallbackEpisode } = fallback

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
  return Array.from({ length: 28 }, (_, index) => {
    const unit = { unit_id: index === 0 ? 'shot-01.part-01' : `shot-${String(index + 1).padStart(2, '0')}.part-01` }
    return { ...unit, unit_hash: canonicalHash(unit) }
  })
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
        const plan = { provider: provider.name, units: allUnits }
        plan.execution_plan_hash = canonicalHash(plan)
        const manifest = {
          status: 'preflight_passed',
          provider: provider.name,
          package_sha256: fileHash(options.episodePackage),
          execution_plan: plan,
          execution_plan_hash: plan.execution_plan_hash,
          execution_units: allUnits,
          tasks: [],
        }
        fs.mkdirSync(options.stateDir, { recursive: true })
        fs.writeFileSync(path.join(options.stateDir, 'private-manifest.json'), JSON.stringify(manifest))
        return manifest
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
        const artifactId = `outputs/units/${options.unitId}.mp4`
        const artifactPath = path.join(options.stateDir, artifactId)
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
        fs.writeFileSync(artifactPath, `offline-video-${provider.name}-${options.unitId}`)
        const task = {
          unit_id: options.unitId,
          unit_hash: allUnits.find((unit) => unit.unit_id === options.unitId).unit_hash,
          status: 'completed_verified',
          artifact: { artifact_id: artifactId, sha256: fileHash(artifactPath) },
          visual_review_status: 'pending_external_review',
          verification: { role: { passed: true, review_status: 'pending_external_review' } },
        }
        const manifestPath = path.join(options.stateDir, 'private-manifest.json')
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        manifest.status = 'in_progress'
        manifest.tasks.push(task)
        fs.writeFileSync(manifestPath, JSON.stringify(manifest))
        return task
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

function optionsFor(item) {
  return { episodePackage: item.packagePath, stateDir: item.stateDir, sourceHead: HEAD, keys: { fumin: 'key-fumin', toapis: 'key-toapis', feituo: 'key-feituo' } }
}

async function approveGate(item, deps, binding = readManifest(item.stateDir).gate_review?.binding) {
  assert.equal(typeof fallback.recordFallbackGateReview, 'function', 'a product-callable review recorder is required')
  return fallback.recordFallbackGateReview(optionsFor(item), { decision: 'approved', reviewer: 'offline-reviewer', binding }, deps)
}

async function resume(item, deps) {
  assert.equal(typeof fallback.resumeFallbackEpisode, 'function', 'an independent approved-state resume function is required')
  return fallback.resumeFallbackEpisode(optionsFor(item), deps)
}

test('a technically completed first shot persists waiting for visual review without sequence or assembly', async () => {
  const item = fixture()
  try {
    const deps = fakeDependencies({})
    const result = await runFallbackEpisode(optionsFor(item), deps)
    assert.equal(result.status, 'waiting_first_shot_review')
    assert.equal(readManifest(item.stateDir).status, 'waiting_first_shot_review')
    assert.equal(result.generation_attempts.length, 1)
    assert.deepEqual(deps.stageCalls.map((call) => call[1]), ['preflight', 'shot'])
    assert.equal(result.gate_review.status, 'pending_external_review')
    const child = JSON.parse(fs.readFileSync(path.join(item.stateDir, 'routes', 'fumin-fast', 'private-manifest.json'), 'utf8'))
    assert.equal(result.gate_review.binding.artifact_sha256, child.tasks[0].artifact.sha256)
    assert.equal(result.gate_review.binding.unit_hash, child.execution_units[0].unit_hash)
    assert.equal(result.gate_review.binding.execution_plan_hash, child.execution_plan_hash)
    assert.equal(result.gate_review.binding.package_sha256, fileHash(item.packagePath))
    assert.equal(result.gate_review.binding.source_head, HEAD)
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

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
    const waiting = await runFallbackEpisode({
      episodePackage: item.packagePath,
      stateDir: item.stateDir,
      sourceHead: HEAD,
      keys: { fumin: 'key-fumin', toapis: 'key-toapis', feituo: 'key-feituo' },
    }, deps)

    assert.equal(waiting.status, 'waiting_first_shot_review')
    await approveGate(item, deps)
    const manifest = await resume(item, deps)
    assert.equal(manifest.status, 'technical_verified_pending_visual_review')
    assert.equal(manifest.visual_review_status, 'pending_external_review')
    assert.equal(manifest.winner_route_id, 'toapis-fast')
    assert.equal(manifest.generation_attempts.length, 29)
    assert.deepEqual(
      manifest.generation_attempts.map((attempt) => attempt.route_id),
      ['fumin-fast', ...Array(28).fill('toapis-fast')],
    )
    assert.equal(manifest.episode_artifact.sha256, 'e'.repeat(64))
    assert.deepEqual(deps.providerRoutes, ['fumin-fast', 'toapis-fast', 'toapis-fast'])
    assert.equal(deps.stageCalls.filter((call) => call[1] === 'shot' && call[0] === 'toapis-fast').length, 1)
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
    await runFallbackEpisode({
      episodePackage: item.packagePath,
      stateDir: item.stateDir,
      sourceHead: HEAD,
      keys: { fumin: 'key-fumin', toapis: 'key-toapis', feituo: 'key-feituo' },
    }, deps)
    await approveGate(item, deps)
    const manifest = await resume(item, deps)
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

test('resume requires recorded approval and missing keys never submit after approval', async () => {
  const item = fixture()
  try {
    const deps = fakeDependencies({})
    await runFallbackEpisode(optionsFor(item), deps)
    assert.equal(typeof fallback.resumeFallbackEpisode, 'function')
    await assert.rejects(() => resume(item, deps), { code: 'REDRAW_EPISODE_GATE_REVIEW_REQUIRED' })
    await approveGate(item, deps)
    await assert.rejects(() => fallback.resumeFallbackEpisode({ ...optionsFor(item), keys: {} }, deps), { code: 'REDRAW_EPISODE_NO_PROVIDER_KEY' })
    assert.equal(deps.stageCalls.length, 2)
    assert.equal(readManifest(item.stateDir).generation_attempts.length, 1)
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

for (const field of ['source_head', 'package_sha256', 'execution_plan_hash', 'unit_hash', 'artifact_sha256', 'artifact_id', 'run_id', 'route_id']) {
  test(`review rejects stale or mismatched ${field} without provider work`, async () => {
    const item = fixture()
    try {
      const deps = fakeDependencies({})
      const waiting = await runFallbackEpisode(optionsFor(item), deps)
      assert.equal(waiting.status, 'waiting_first_shot_review')
      await assert.rejects(() => approveGate(item, deps, { ...waiting.gate_review.binding, [field]: 'wrong' }), { code: 'REDRAW_EPISODE_GATE_REVIEW_BINDING_MISMATCH' })
      assert.equal(deps.stageCalls.length, 2)
      assert.equal(readManifest(item.stateDir).gate_review.status, 'pending_external_review')
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true })
    }
  })
}

for (const mutation of ['artifact-bytes', 'artifact-path', 'unit-hash', 'plan-hash', 'plan-body', 'task-unknown', 'task-failed', 'duplicate-task', 'extra-task', 'package', 'head']) {
  test(`approved resume rejects changed ${mutation} before provider construction`, async () => {
    const item = fixture()
    try {
      const deps = fakeDependencies({})
      await runFallbackEpisode(optionsFor(item), deps)
      await approveGate(item, deps)
      const childPath = path.join(item.stateDir, 'routes', 'fumin-fast', 'private-manifest.json')
      const child = JSON.parse(fs.readFileSync(childPath, 'utf8'))
      if (mutation === 'artifact-bytes') fs.appendFileSync(path.join(path.dirname(childPath), child.tasks[0].artifact.artifact_id), 'tampered')
      if (mutation === 'artifact-path') child.tasks[0].artifact.artifact_id = '../foreign.mp4'
      if (mutation === 'unit-hash') child.tasks[0].unit_hash = '0'.repeat(64)
      if (mutation === 'plan-hash') child.execution_plan_hash = '0'.repeat(64)
      if (mutation === 'plan-body') child.execution_plan.units[1].unexpected = true
      if (mutation === 'task-unknown') child.tasks[0].status = 'needs_attention'
      if (mutation === 'task-failed') child.tasks[0].status = 'failed'
      if (mutation === 'duplicate-task') child.tasks.push(child.tasks[0])
      if (mutation === 'extra-task') child.tasks.push({ unit_id: 'shot-02.part-01', status: 'provider_processing' })
      if (mutation === 'package') fs.appendFileSync(item.packagePath, ' ')
      if (mutation === 'head') deps.currentHead = () => '7'.repeat(40)
      fs.writeFileSync(childPath, JSON.stringify(child))
      await assert.rejects(() => resume(item, deps), { code: mutation === 'head' ? 'REDRAW_EPISODE_SOURCE_HEAD_MISMATCH' : 'REDRAW_EPISODE_GATE_REVIEW_BINDING_MISMATCH' })
      assert.equal(deps.providerRoutes.length, 1)
      assert.equal(deps.stageCalls.length, 2)
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true })
    }
  })
}

test('a rejected review is durable and cannot be overwritten or resumed', async () => {
  const item = fixture()
  try {
    const deps = fakeDependencies({})
    const waiting = await runFallbackEpisode(optionsFor(item), deps)
    assert.equal(typeof fallback.recordFallbackGateReview, 'function')
    const rejected = await fallback.recordFallbackGateReview(optionsFor(item), { decision: 'rejected', reviewer: 'offline-reviewer', binding: waiting.gate_review.binding }, deps)
    assert.equal(rejected.status, 'first_shot_review_rejected')
    await assert.rejects(() => approveGate(item, deps), { code: 'REDRAW_EPISODE_GATE_REVIEW_STATE_INVALID' })
    await assert.rejects(() => resume(item, deps), { code: 'REDRAW_EPISODE_GATE_REVIEW_STATE_INVALID' })
    assert.equal(deps.stageCalls.length, 2)
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('parallel resumes acquire one local execution lock and never repeat the gate POST', async () => {
  const item = fixture()
  let release
  try {
    const deps = fakeDependencies({})
    await runFallbackEpisode(optionsFor(item), deps)
    await approveGate(item, deps)
    const execute = deps.runStage
    let entered
    const enteredSequence = new Promise((resolve) => { entered = resolve })
    const holdSequence = new Promise((resolve) => { release = resolve })
    deps.runStage = async (options, adapters) => {
      if (options.stage === 'sequence') { entered(); await holdSequence }
      return execute(options, adapters)
    }
    const first = resume(item, deps)
    await enteredSequence
    await assert.rejects(() => resume(item, deps), { code: 'REDRAW_EPISODE_FALLBACK_EXECUTION_LOCKED' })
    release()
    const result = await first
    assert.equal(result.generation_attempts.length, 28)
    assert.equal(deps.stageCalls.filter((call) => call[1] === 'shot').length, 1)
    await assert.rejects(() => resume(item, deps), { code: 'REDRAW_EPISODE_GATE_REVIEW_STATE_INVALID' })
  } finally {
    release?.()
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('public fallback evidence omits arbitrary provider diagnostics and absolute paths', async () => {
  const item = fixture()
  try {
    const deps = fakeDependencies({})
    const execute = deps.runStage
    deps.runStage = async (options, adapters) => {
      if (options.stage !== 'shot') return execute(options, adapters)
      const error = new Error(`provider opaque secret-123 at ${item.root}`)
      error.code = 'unknown provider secret-123'
      error.indeterminate = true
      throw error
    }
    await assert.rejects(() => runFallbackEpisode(optionsFor(item), deps))
    const evidence = fs.readFileSync(path.join(item.stateDir, 'public-fallback-evidence.json'), 'utf8')
    assert.doesNotMatch(evidence, /secret-123|redraw-fallback-|child_state_dir|C:\\\\Users|key-fumin/u)
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

for (const externalCode of ['provider-secret-code-123', null]) {
  test(`real CLI stderr hides an untrusted ${externalCode ? 'error code' : 'error message'}`, () => {
    const item = fixture()
    try {
      const scriptPath = fileURLToPath(new URL('./run-redraw-video-model-fallback-live.mjs', import.meta.url))
      const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.dirname(scriptPath), encoding: 'utf8', windowsHide: true }).trim()
      // Inject an offline local failure while executing the real CLI entry point and catch.
      const preload = `import fs from 'node:fs';
        const read = fs.readFileSync;
        fs.readFileSync = function (target, ...args) {
          if (String(target) === ${JSON.stringify(item.packagePath)}) {
            const error = new Error(${JSON.stringify(`provider-secret-message-456 at ${item.root}`)});
            ${externalCode ? `error.code = ${JSON.stringify(externalCode)};` : ''}
            throw error;
          }
          return read.call(this, target, ...args);
        };`
      const missingKeyPath = path.join(item.root, 'nonexistent-key-file')
      const child = spawnSync(process.execPath, [
        '--import', `data:text/javascript,${encodeURIComponent(preload)}`, scriptPath,
        '--episode-package', item.packagePath, '--state-dir', item.stateDir, '--source-head', sourceHead,
        '--fumin-key-file', missingKeyPath, '--toapis-key-file', missingKeyPath, '--feituo-key-file', missingKeyPath,
      ], {
        cwd: path.dirname(scriptPath), encoding: 'utf8', windowsHide: true,
        env: {
          PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
          GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory',
          GIT_CONFIG_VALUE_0: path.resolve(path.dirname(scriptPath), '../..').replace(/\\/gu, '/'),
        },
      })
      assert.equal(child.error, undefined)
      assert.equal(child.status, 1)
      assert.equal(child.stdout, '')
      assert.equal(child.stderr.trim(), 'REDRAW_EPISODE_FALLBACK_FAILED')
      assert.doesNotMatch(child.stderr, /provider-secret|redraw-fallback-/u)
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true })
    }
  })
}

test('real CLI stderr also suppresses raw HEAD subprocess diagnostics', () => {
  const item = fixture()
  try {
    const scriptPath = fileURLToPath(new URL('./run-redraw-video-model-fallback-live.mjs', import.meta.url))
    const missingKeyPath = path.join(item.root, 'nonexistent-key-file')
    const child = spawnSync(process.execPath, [
      scriptPath, '--episode-package', item.packagePath, '--state-dir', item.stateDir, '--source-head', HEAD,
      '--fumin-key-file', missingKeyPath, '--toapis-key-file', missingKeyPath, '--feituo-key-file', missingKeyPath,
    ], {
      cwd: path.dirname(scriptPath), encoding: 'utf8', windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GIT_DIR: path.join(item.root, 'private-nonexistent-git') },
    })
    assert.equal(child.error, undefined)
    assert.equal(child.status, 1)
    assert.equal(child.stderr.trim(), 'REDRAW_EPISODE_FALLBACK_FAILED')
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('a pending reread cannot be hidden by a not-applicable task review status', async () => {
  const item = fixture()
  try {
    const deps = fakeDependencies({})
    await runFallbackEpisode(optionsFor(item), deps)
    await approveGate(item, deps)
    const execute = deps.runStage
    deps.runStage = async (options, adapters) => {
      const result = await execute(options, adapters)
      if (options.stage === 'verify') result.tasks = [{ visual_review_status: 'not_applicable', verify_reread: { role: { review_status: 'pending_external_review' } } }]
      return result
    }
    const result = await resume(item, deps)
    assert.equal(result.status, 'technical_verified_pending_visual_review')
    assert.equal(result.visual_review_status, 'pending_external_review')
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('an unknown current error overrides a previously recorded explicit provider failure', async () => {
  const item = fixture()
  try {
    const deps = fakeDependencies({})
    const execute = deps.runStage
    deps.runStage = async (options, adapters) => {
      if (options.stage !== 'shot') return execute(options, adapters)
      const childPath = path.join(options.stateDir, 'private-manifest.json')
      const child = JSON.parse(fs.readFileSync(childPath, 'utf8'))
      child.tasks = [{ failure_class: 'explicit_provider_failure' }]
      fs.writeFileSync(childPath, JSON.stringify(child))
      const error = new Error('unknown current operation')
      error.indeterminate = true
      error.code = 'FAKE_PROVIDER_STATUS_UNKNOWN'
      throw error
    }
    await assert.rejects(() => runFallbackEpisode(optionsFor(item), deps), { code: 'FAKE_PROVIDER_STATUS_UNKNOWN' })
    assert.deepEqual(deps.providerRoutes, ['fumin-fast'])
    assert.equal(readManifest(item.stateDir).status, 'needs_attention')
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('a caller-limited three-route run cannot reach the historical fourth route or exceed 30 submissions', async () => {
  const item = fixture()
  try {
    const deps = fakeDependencies({ 'fumin-fast': 'explicit', 'toapis-fast': 'explicit' })
    deps.routes = EPISODE_VIDEO_ROUTES.slice(0, 3)
    await runFallbackEpisode(optionsFor(item), deps)
    await approveGate(item, deps)
    const result = await resume(item, deps)
    assert.equal(result.generation_attempts.length, 30)
    assert.equal(result.routes.length, 3)
    assert.equal(deps.providerRoutes.includes('feituo-seedance-2.5'), false)
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('the same winner unit cannot be submitted twice even during one approved resume', async () => {
  const item = fixture()
  try {
    const deps = fakeDependencies({})
    await runFallbackEpisode(optionsFor(item), deps)
    await approveGate(item, deps)
    const execute = deps.runStage
    deps.runStage = async (options, adapters) => {
      const result = await execute(options, adapters)
      if (options.stage === 'sequence') await adapters.provider.beforeGenerationSubmit({ route_id: 'fumin-fast', model: EPISODE_VIDEO_ROUTES[0].model, unit_id: 'shot-02.part-01' })
      return result
    }
    await assert.rejects(() => resume(item, deps), { code: 'REDRAW_EPISODE_FALLBACK_DUPLICATE_SUBMISSION' })
    assert.equal(readManifest(item.stateDir).generation_attempts.length, 28)
    assert.equal(deps.stageCalls.some((call) => call[1] === 'assemble'), false)
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
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

    const runOptions = {
      episodePackage: item.packagePath,
      stateDir: item.stateDir,
      sourceHead: HEAD,
      keys: { fumin: 'never-persist-this-secret' },
    }
    const dependencies = {
      currentHead: () => HEAD,
      createProvider: providerFactory,
      now: () => new Date('2026-09-05T00:00:00.000Z'),
    }
    const waiting = await runFallbackEpisode(runOptions, dependencies)
    assert.equal(waiting.status, 'waiting_first_shot_review')
    await approveGate(item, dependencies)
    const result = await fallback.resumeFallbackEpisode(runOptions, dependencies)

    assert.equal(result.status, 'technical_verified_pending_visual_review')
    assert.equal(result.visual_review_status, 'not_recorded')
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
