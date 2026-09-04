import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(new URL('./run-redraw-episode-blueprint-live.mjs', import.meta.url))

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function file(root, relativePath, body) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, body)
  return target
}

function packHash(pack) {
  const copy = JSON.parse(JSON.stringify(pack))
  delete copy.production_pack_hash
  return sha256(stableStringify(copy))
}

function canonicalHash(value, omittedKey) {
  const copy = JSON.parse(JSON.stringify(value))
  if (omittedKey) delete copy[omittedKey]
  return sha256(stableStringify(copy))
}

function makeExecutionPlan(pkg, units) {
  const pack = pkg.production_packs[0]
  const plan = {
    schema_version: 'redraw-provider-execution-plan-v1',
    provider: 'planned-provider',
    units: units || [{
      schema_version: 'fumin-episode-execution-unit-v1',
      unit_id: `${pack.shot_id}.part-01`,
      parent_shot_id: pack.shot_id,
      part_index: 1,
      part_count: 1,
      source_start_ms: pack.start_ms,
      source_end_ms: pack.end_ms,
      keep_duration_ms: pack.duration_ms,
      provider_duration_seconds: 5,
      parent_production_pack_hash: pack.production_pack_hash,
      dialogue: pack.dialogue,
      identity_reference_ids: ['lead-main'],
      motion_reference_id: 'shot-1-motion',
      prompt: pack.prompt,
    }],
  }
  plan.execution_plan_hash = canonicalHash(plan)
  return plan
}

function makeEpisodePackage(root, overrides = {}) {
  const sourcePath = file(root, 'source/master.mp4', Buffer.from('master-video'))
  const identityPath = file(root, 'refs/marcus.png', Buffer.from('identity-marcus'))
  const motionPath = file(root, 'refs/shot-1.mp4', Buffer.from('motion-shot-1'))
  const blueprintHash = 'b'.repeat(64)
  const localizationHash = 'c'.repeat(64)
  const pack = {
    schema_version: 'redraw-shot-production-pack-v1',
    shot_id: 'shot-1',
    start_ms: 0,
    end_ms: 5000,
    duration_ms: 5000,
    blueprint_hash: blueprintHash,
    localization_hash: localizationHash,
    characters: [{ id: 'lead', name: 'Marcus', assets: [{ kind: 'identity', sha256: sha256(fs.readFileSync(identityPath)) }] }],
    dialogue: [{ speaker_id: 'lead', speaker_name: 'Marcus', text: 'We leave tonight.', start_ms: 700, end_ms: 2300 }],
    visual_contract: { composition: 'medium shot', references: [{ kind: 'motion', sha256: sha256(fs.readFileSync(motionPath)) }] },
    audio_contract: { locale: 'en-US', speech_required: true },
    prompt: 'Marcus says in English: We leave tonight.',
  }
  pack.production_pack_hash = packHash(pack)
  const episodePackage = {
    schema_version: 'redraw-episode-production-package-v1',
    blueprint_hash: blueprintHash,
    localization_hash: localizationHash,
    target: { locale: 'en-US', market: 'US' },
    source_media: {
      path: sourcePath,
      sha256: sha256(fs.readFileSync(sourcePath)),
    },
    identity_references: [{ id: 'lead-main', character_id: 'lead', path: identityPath, sha256: sha256(fs.readFileSync(identityPath)) }],
    motion_references: [{ id: 'shot-1-motion', shot_id: 'shot-1', path: motionPath, sha256: sha256(fs.readFileSync(motionPath)) }],
    production_packs: [pack],
    ...overrides,
  }
  const packagePath = file(root, 'package/episode-package.json', `${JSON.stringify(episodePackage, null, 2)}\n`)
  return { packagePath, episodePackage, sourcePath, identityPath, motionPath }
}

test('preflight persists immutable provider execution plan and derived unit hashes without upload or submit', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-execution-plan-'))
  try {
    const { packagePath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'state')
    const calls = { prepare: 0, upload: 0, submit: 0 }
    let prepareInput
    const provider = {
      name: 'planned-provider',
      async prepareEpisode(input) {
        calls.prepare += 1
        prepareInput = input
        input.package.target.locale = 'mutated-by-provider'
        return makeExecutionPlan(JSON.parse(fs.readFileSync(packagePath, 'utf8')))
      },
      async uploadReference() { calls.upload += 1 },
      async submitGeneration() { calls.submit += 1 },
    }
    const result = await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), {
      provider,
      now: () => new Date('2026-09-04T00:00:00Z'),
    })
    const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'private-manifest.json'), 'utf8'))

    assert.deepEqual(calls, { prepare: 1, upload: 0, submit: 0 })
    assert.equal(prepareInput.state_dir, stateDir)
    assert.equal(prepareInput.mode, 'materialize')
    assert.equal(manifest.target.locale, 'en-US')
    assert.equal(result.execution_plan.schema_version, 'redraw-provider-execution-plan-v1')
    assert.equal(result.execution_units.length, 1)
    assert.match(result.execution_units[0].unit_hash, /^[a-f0-9]{64}$/)
    assert.equal(result.execution_units[0].unit_hash, canonicalHash(result.execution_plan.units[0]))
    assert.equal(result.execution_plan_hash, result.execution_plan.execution_plan_hash)
    assert.deepEqual(manifest.execution_units, result.execution_units)
    assert.equal(manifest.tasks.length, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('execution plan validation rejects invalid hashes and reference bindings before any upload or submit', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-execution-plan-invalid-'))
  try {
    const { packagePath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'state')
    let providerCalls = 0
    const provider = {
      name: 'planned-provider',
      async prepareEpisode({ package: pkg }) {
        const plan = makeExecutionPlan(pkg)
        plan.units[0].motion_reference_id = 'missing-motion'
        return plan
      },
      async uploadReference() { providerCalls += 1 },
      async submitGeneration() { providerCalls += 1 },
    }
    await assert.rejects(
      () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), { provider }),
      /REDRAW_EPISODE_EXECUTION_PLAN_HASH_MISMATCH|REDRAW_EPISODE_EXECUTION_UNIT_REFERENCE_INVALID/,
    )
    assert.equal(providerCalls, 0)
    assert.equal(fs.existsSync(path.join(stateDir, 'private-manifest.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('sequence persists before upload and stops at the first unknown unit', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-unit-sequence-'))
  try {
    const { packagePath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'state')
    const submitted = []
    const raw = Buffer.from('raw-unit')
    let plan
    const provider = {
      name: 'planned-provider',
      async prepareEpisode({ package: pkg }) {
        const pack = pkg.production_packs[0]
        const units = [[0, 1600], [1600, 3200], [3200, 5000]].map(([start, end], index) => ({
          schema_version: 'fumin-episode-execution-unit-v1',
          unit_id: `shot-1.part-0${index + 1}`,
          parent_shot_id: 'shot-1',
          part_index: index + 1,
          part_count: 3,
          source_start_ms: start,
          source_end_ms: end,
          keep_duration_ms: end - start,
          provider_duration_seconds: 5,
          parent_production_pack_hash: pack.production_pack_hash,
          dialogue: [],
          identity_reference_ids: ['lead-main'],
          motion_reference_id: 'shot-1-motion',
          prompt: `part ${index + 1}`,
        }))
        plan = makeExecutionPlan(pkg, units)
        return plan
      },
      async uploadReference() {
        const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'private-manifest.json'), 'utf8'))
        assert.equal(manifest.tasks.at(-1).status, 'reference_upload_started')
        return { asset_id: 'asset' }
      },
      async submitGeneration({ unit }) {
        submitted.push(unit.unit_id)
        if (unit.unit_id === 'shot-1.part-02') {
          const error = new Error('provider result status unknown')
          error.code = 'FUMIN_EPISODE_STATUS_UNKNOWN'
          throw error
        }
        return { task_id: `task-${unit.unit_id}` }
      },
      async pollGeneration() { return { video_url: 'https://example.test/raw.mp4' } },
      async downloadResult({ output_path }) {
        fs.mkdirSync(path.dirname(output_path), { recursive: true })
        fs.writeFileSync(output_path, raw)
        return { path: output_path, sha256: sha256(raw) }
      },
      async inspectArtifact({ unit }) { return { unit_id: unit.unit_id, passed: true } },
    }
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), { provider })
    await assert.rejects(
      () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'sequence']), { provider }),
      (error) => error.code === 'FUMIN_EPISODE_STATUS_UNKNOWN',
    )
    const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'private-manifest.json'), 'utf8'))
    assert.deepEqual(submitted, ['shot-1.part-01', 'shot-1.part-02'])
    assert.equal(manifest.tasks[0].status, 'completed_verified')
    assert.equal(manifest.tasks[1].status, 'needs_attention')
    assert.equal(manifest.tasks.length, 2)
    assert.equal(manifest.execution_plan_hash, plan.execution_plan_hash)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('sequence skips matching completed units and refuses any existing incomplete unit', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-unit-resume-'))
  try {
    const { packagePath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'state')
    const provider = { name: 'planned-provider', async prepareEpisode({ package: pkg }) { return makeExecutionPlan(pkg) } }
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), { provider })
    const manifestPath = path.join(stateDir, 'private-manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.tasks.push({
      unit_id: manifest.execution_units[0].unit_id,
      unit_hash: manifest.execution_units[0].unit_hash,
      shot_id: 'shot-1',
      status: 'completed_verified',
    })
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    const skipped = await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'sequence']), { provider })
    assert.equal(skipped.tasks.length, 1)

    manifest.tasks[0].status = 'provider_processing'
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await assert.rejects(
      () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'sequence']), { provider }),
      /REDRAW_EPISODE_UNIT_ALREADY_SUBMITTED/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('unit stage fails closed on execution unit, task hash, or plan hash drift', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  for (const drift of ['unit', 'task', 'plan']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `redraw-unit-${drift}-drift-`))
    try {
      const { packagePath } = makeEpisodePackage(root)
      const stateDir = path.join(root, 'state')
      let calls = 0
      const provider = {
        name: 'planned-provider',
        async prepareEpisode({ package: pkg }) { return makeExecutionPlan(pkg) },
        async uploadReference() { calls += 1 },
        async submitGeneration() { calls += 1 },
        async pollGeneration() {},
        async downloadResult() {},
        async inspectArtifact() {},
      }
      await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), { provider })
      const manifestPath = path.join(stateDir, 'private-manifest.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      if (drift === 'unit') manifest.execution_units[0].prompt = 'drifted'
      if (drift === 'plan') manifest.execution_plan_hash = '0'.repeat(64)
      if (drift === 'task') manifest.tasks.push({ unit_id: manifest.execution_units[0].unit_id, unit_hash: '0'.repeat(64), status: 'completed_verified' })
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      await assert.rejects(
        () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'shot', '--unit-id', 'shot-1.part-01']), { provider }),
        /REDRAW_EPISODE_(?:EXECUTION_PLAN|EXECUTION_UNIT|TASK_UNIT)_HASH_MISMATCH/,
      )
      assert.equal(calls, 0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('planned unit keeps independently hashed raw and finalized artifacts', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-unit-finalize-'))
  try {
    const { packagePath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'state')
    const rawBytes = Buffer.from('raw-five-second-artifact')
    const finalBytes = Buffer.from('trimmed-final-artifact')
    const inspected = []
    const provider = {
      name: 'planned-provider',
      async prepareEpisode({ package: pkg }) { return makeExecutionPlan(pkg) },
      async uploadReference() { return { asset_id: 'asset' } },
      async submitGeneration() { return { task_id: 'task-1' } },
      async pollGeneration() { return { video_url: 'https://example.test/raw.mp4' } },
      async downloadResult({ output_path }) { fs.mkdirSync(path.dirname(output_path), { recursive: true }); fs.writeFileSync(output_path, rawBytes); return { path: output_path, sha256: sha256(rawBytes) } },
      async inspectArtifact({ output_path }) {
        inspected.push(path.relative(stateDir, output_path).replace(/\\/g, '/'))
        const digest = sha256(fs.readFileSync(output_path))
        if (inspected.length === 1) {
          assert.equal(digest, sha256(rawBytes))
          return { phase: 'raw', passed: true }
        }
        assert.equal(digest, sha256(finalBytes))
        return { phase: 'final', passed: true }
      },
      async finalizeArtifact({ raw_path, output_path, unit }) {
        assert.equal(sha256(fs.readFileSync(raw_path)), sha256(rawBytes))
        assert.equal(unit.unit_id, 'shot-1.part-01')
        fs.mkdirSync(path.dirname(output_path), { recursive: true })
        fs.writeFileSync(output_path, finalBytes)
        return { path: output_path, sha256: sha256(finalBytes) }
      },
    }
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), { provider })
    const result = await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'shot', '--unit-id', 'shot-1.part-01']), { provider })
    assert.equal(result.raw_artifact.sha256, sha256(rawBytes))
    assert.equal(result.artifact.sha256, sha256(finalBytes))
    assert.notEqual(result.raw_artifact.artifact_id, result.artifact.artifact_id)
    assert.deepEqual(inspected, ['outputs/raw/shot-1.part-01.mp4', 'outputs/units/shot-1.part-01.mp4'])
    assert.deepEqual(result.raw_verification, { phase: 'raw', passed: true })
    assert.deepEqual(result.verification, { phase: 'final', passed: true })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('finalized artifact must pass its own inspection before a unit can complete', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-unit-final-inspection-'))
  try {
    const { packagePath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'state')
    const rawBytes = Buffer.from('valid-raw')
    const finalBytes = Buffer.from('corrupt-final')
    const error = Object.assign(new Error('final audio missing'), { code: 'FUMIN_EPISODE_OUTPUT_AUDIO_MISSING' })
    let inspections = 0
    const provider = {
      name: 'planned-provider',
      async prepareEpisode({ package: pkg }) { return makeExecutionPlan(pkg) },
      async uploadReference() { return { asset_id: 'asset' } },
      async submitGeneration() { return { task_id: 'task-1' } },
      async pollGeneration() { return { video_url: 'https://example.test/raw.mp4' } },
      async downloadResult({ output_path }) { fs.mkdirSync(path.dirname(output_path), { recursive: true }); fs.writeFileSync(output_path, rawBytes); return { path: output_path, sha256: sha256(rawBytes) } },
      async inspectArtifact() { inspections += 1; if (inspections === 2) throw error; return { phase: 'raw', passed: true } },
      async finalizeArtifact({ output_path }) { fs.mkdirSync(path.dirname(output_path), { recursive: true }); fs.writeFileSync(output_path, finalBytes); return { path: output_path, sha256: sha256(finalBytes) } },
    }
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), { provider })
    await assert.rejects(
      () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'shot', '--unit-id', 'shot-1.part-01']), { provider }),
      (caught) => caught.code === error.code,
    )
    const task = JSON.parse(fs.readFileSync(path.join(stateDir, 'private-manifest.json'), 'utf8')).tasks[0]
    assert.equal(inspections, 2)
    assert.equal(task.status, 'failed')
    assert.deepEqual(task.raw_verification, { phase: 'raw', passed: true })
    assert.notEqual(task.status, 'completed_verified')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('public evidence write failure preserves a completed verified provider task and blocks resubmission', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-unit-evidence-failure-'))
  try {
    const { packagePath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'state')
    const bytes = Buffer.from('verified-unit')
    let submits = 0
    const provider = {
      name: 'planned-provider',
      async prepareEpisode({ package: pkg }) { return makeExecutionPlan(pkg) },
      async uploadReference() { return { asset_id: 'asset' } },
      async submitGeneration() { submits += 1; return { task_id: 'task-1' } },
      async pollGeneration() { return { video_url: 'https://example.test/raw.mp4' } },
      async downloadResult({ output_path }) { fs.mkdirSync(path.dirname(output_path), { recursive: true }); fs.writeFileSync(output_path, bytes); return { path: output_path, sha256: sha256(bytes) } },
      async inspectArtifact() { return { phase: 'raw', passed: true } },
    }
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), { provider })
    fs.mkdirSync(path.join(stateDir, 'shot-1.part-01-public-evidence.json'))
    await assert.rejects(
      () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'shot', '--unit-id', 'shot-1.part-01']), { provider }),
      (error) => error.code === 'REDRAW_EPISODE_PUBLIC_EVIDENCE_WRITE_FAILED',
    )
    const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'private-manifest.json'), 'utf8'))
    assert.equal(manifest.tasks[0].status, 'completed_verified')
    assert.equal(manifest.tasks[0].artifact.sha256, sha256(bytes))
    assert.deepEqual(manifest.tasks[0].verification, { phase: 'raw', passed: true })
    assert.match(manifest.tasks[0].public_evidence_error.code, /^(?:EPERM|EISDIR|ENOTEMPTY)$/)
    assert.match(manifest.tasks[0].public_evidence_error.at, /^\d{4}-/)
    assert.equal(manifest.tasks[0].error_code, undefined)
    const resumed = await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'sequence']), { provider })
    assert.equal(resumed.tasks[0].status, 'completed_verified')
    assert.equal(submits, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('provider execution plans reject unsafe unit ids before upload or submit', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  for (const unitId of ['unit/1', 'unit\\1', 'unit:1', 'unit 1', '..', '.unit', 'unit.']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-unit-id-invalid-'))
    try {
      const { packagePath } = makeEpisodePackage(root)
      const stateDir = path.join(root, 'state')
      let externalCalls = 0
      const provider = {
        name: 'planned-provider',
        async prepareEpisode({ package: pkg }) {
          const plan = makeExecutionPlan(pkg)
          plan.units[0].unit_id = unitId
          plan.execution_plan_hash = canonicalHash(plan, 'execution_plan_hash')
          return plan
        },
        async uploadReference() { externalCalls += 1 },
        async submitGeneration() { externalCalls += 1 },
      }
      await assert.rejects(
        () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), { provider }),
        /REDRAW_EPISODE_EXECUTION_UNIT_ID_INVALID/,
      )
      assert.equal(externalCalls, 0)
      assert.equal(fs.existsSync(path.join(stateDir, 'private-manifest.json')), false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('legacy shot ids remain accepted but output path collisions fail closed at preflight', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-legacy-path-collision-'))
  try {
    const base = makeEpisodePackage(root)
    const first = { ...base.episodePackage.production_packs[0], shot_id: 'unit/1', start_ms: 0, end_ms: 2500, duration_ms: 2500 }
    const second = { ...base.episodePackage.production_packs[0], shot_id: 'unit_1', start_ms: 2500, end_ms: 5000, duration_ms: 2500, dialogue: [] }
    first.production_pack_hash = packHash(first)
    second.production_pack_hash = packHash(second)
    base.episodePackage.production_packs = [first, second]
    base.episodePackage.motion_references = [
      { ...base.episodePackage.motion_references[0], id: 'motion-a', shot_id: first.shot_id },
      { ...base.episodePackage.motion_references[0], id: 'motion-b', shot_id: second.shot_id },
    ]
    fs.writeFileSync(base.packagePath, `${JSON.stringify(base.episodePackage, null, 2)}\n`)
    await assert.rejects(
      () => runStage(parseArgs(['--episode-package', base.packagePath, '--state-dir', path.join(root, 'state'), '--stage', 'preflight']), { provider: { name: 'legacy-provider' } }),
      /REDRAW_EPISODE_EXECUTION_PATH_COLLISION/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('planned assemble uses final artifacts in execution-unit order and passes an immutable plan', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-unit-assemble-'))
  try {
    const { packagePath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'state')
    const packageValue = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
    const base = makeExecutionPlan(packageValue).units[0]
    const units = [1, 2].map((part) => ({ ...base, unit_id: `shot-1.part-0${part}`, part_index: part, part_count: 2, source_start_ms: (part - 1) * 2500, source_end_ms: part * 2500, keep_duration_ms: 2500 }))
    const provider = { name: 'planned-provider', async prepareEpisode({ package: pkg }) { return makeExecutionPlan(pkg, units) } }
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), { provider })
    const manifestPath = path.join(stateDir, 'private-manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.tasks = manifest.execution_units.map((unit, index) => {
      const bytes = Buffer.from(`final-${index + 1}`)
      const artifactPath = file(stateDir, `outputs/units/${unit.unit_id}.mp4`, bytes)
      return { unit_id: unit.unit_id, unit_hash: unit.unit_hash, shot_id: unit.parent_shot_id, status: 'completed_verified', artifact: { artifact_id: path.relative(stateDir, artifactPath).replace(/\\/g, '/'), sha256: sha256(bytes), size: bytes.length } }
    })
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    let assembleInput
    const episodeBytes = Buffer.from('episode')
    provider.assembleEpisode = async (input) => {
      assembleInput = input
      input.execution_plan.units.reverse()
      fs.mkdirSync(path.dirname(input.output_path), { recursive: true })
      fs.writeFileSync(input.output_path, episodeBytes)
      return { path: input.output_path, sha256: sha256(episodeBytes) }
    }
    provider.inspectEpisode = async () => ({ media: { duration_seconds: 5, has_audio: true } })
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'assemble']), { provider })
    assert.deepEqual(assembleInput.unit_paths.map((item) => path.basename(item)), ['shot-1.part-01.mp4', 'shot-1.part-02.mp4'])
    const persisted = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    assert.deepEqual(persisted.execution_plan.units.map((unit) => unit.unit_id), ['shot-1.part-01', 'shot-1.part-02'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

async function makeVerifyState(root) {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const { packagePath } = makeEpisodePackage(root)
  const stateDir = path.join(root, 'isolated-state')
  await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), {
    provider: { name: 'fake-provider' },
  })
  const shotBytes = Buffer.from('verified-shot-mp4')
  const shotPath = file(stateDir, 'outputs/shots/shot-1.mp4', shotBytes)
  const manifestPath = path.join(stateDir, 'private-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.tasks = [{
    shot_id: 'shot-1',
    status: 'completed_verified',
    artifact: {
      artifact_id: 'outputs/shots/shot-1.mp4',
      sha256: sha256(shotBytes),
      size: shotBytes.length,
    },
  }]
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { packagePath, stateDir, manifestPath, manifest, shotPath, shotBytes, parseArgs, runStage }
}

test('generic runner preflight validates an absolute episode package and performs zero provider calls', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-runner-'))
  try {
    const { packagePath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'isolated-state')
    const options = parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight'])
    const calls = []
    const result = await runStage(options, {
      provider: { name: 'fake-provider', preflight: () => calls.push('provider') },
      now: () => new Date('2026-09-03T09:00:00.000Z'),
    })

    assert.equal(result.schema_version, 'redraw-episode-live-state-v1')
    assert.equal(result.status, 'preflight_passed')
    assert.equal(result.provider, 'fake-provider')
    assert.equal(result.production_packs.length, 1)
    assert.equal(result.production_packs[0].prompt, 'Marcus says in English: We leave tonight.')
    assert.deepEqual(calls, [])
    assert.equal(fs.existsSync(path.join(stateDir, 'private-manifest.json')), true)
    assert.doesNotMatch(JSON.stringify(result), /master\.mp4|marcus\.png|shot-1\.mp4/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('preflight manifest, public evidence, return value and stdout contain metadata instead of media bytes', async () => {
  const { main } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-preflight-metadata-'))
  const originalWrite = process.stdout.write
  try {
    const { packagePath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'isolated-state')
    let stdout = ''
    process.stdout.write = (chunk) => {
      stdout += String(chunk)
      return true
    }
    const result = await main([
      '--episode-package', packagePath,
      '--state-dir', stateDir,
      '--stage', 'preflight',
    ], {
      provider: { name: 'fake-provider' },
      now: () => new Date('2026-09-03T09:00:00.000Z'),
    })
    const publicEvidence = JSON.parse(fs.readFileSync(path.join(stateDir, 'public-preflight-evidence.json'), 'utf8'))
    const privateManifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'private-manifest.json'), 'utf8'))
    const stdoutValue = JSON.parse(stdout)

    for (const value of [result, stdoutValue, publicEvidence, privateManifest]) {
      const serialized = JSON.stringify(value)
      assert.doesNotMatch(serialized, /"bytes"\s*:/)
      assert.doesNotMatch(serialized, /"type"\s*:\s*"Buffer"|"data"\s*:\s*\[\s*\d/)
      assert.doesNotMatch(serialized, /master-video|identity-marcus|motion-shot-1/)
      assert.equal(value.source_media.size, Buffer.byteLength('master-video'))
      assert.equal(value.references.identities[0].size, Buffer.byteLength('identity-marcus'))
      assert.equal(value.references.motion[0].size, Buffer.byteLength('motion-shot-1'))
    }
  } finally {
    process.stdout.write = originalWrite
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('generic runner rejects relative paths, unknown flags, stale hashes, and package paths inside state', async () => {
  const { parseArgs, loadEpisodePackage } = await import('./run-redraw-episode-blueprint-live.mjs')
  assert.throws(() => parseArgs(['--episode-package', 'relative.json', '--state-dir', 'C:/state', '--stage', 'preflight']), /REDRAW_EPISODE_PACKAGE_PATH_INVALID/)
  assert.throws(() => parseArgs(['--episode-package', 'C:/package.json', '--state-dir', 'C:/state', '--stage', 'preflight', '--provider-url', 'https://example.test']), /REDRAW_EPISODE_RUNNER_ARGUMENT_UNKNOWN/)
  assert.throws(() => parseArgs(['--episode-package', 'C:/package.json', '--state-dir', 'C:/state', '--stage', 'shot', '--shot-id', 'shot-1', '--unit-id', 'unit-1']), /REDRAW_EPISODE_SHOT_UNIT_AMBIGUOUS/)
  assert.throws(() => parseArgs(['--episode-package', 'C:/package.json', '--state-dir', 'C:/state', '--stage', 'sequence', '--unit-id', 'unit-1']), /REDRAW_EPISODE_RUNNER_ARGUMENT_INVALID/)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-runner-'))
  try {
    const { episodePackage } = makeEpisodePackage(root)
    const insideState = path.join(root, 'state')
    const insidePackage = file(insideState, 'episode-package.json', `${JSON.stringify(episodePackage)}\n`)
    assert.throws(() => parseArgs(['--episode-package', insidePackage, '--state-dir', insideState, '--stage', 'preflight']), /REDRAW_EPISODE_STATE_OVERLAPS_INPUT/)

    episodePackage.production_packs[0].prompt = 'changed after hash'
    const stalePackage = file(root, 'package/stale.json', `${JSON.stringify(episodePackage)}\n`)
    assert.throws(() => loadEpisodePackage(stalePackage, path.join(root, 'state-2')), /REDRAW_EPISODE_PRODUCTION_PACK_HASH_MISMATCH/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('shot stage reads character dialogue prompt and references from production packs only', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-runner-'))
  try {
    const { packagePath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'isolated-state')
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), {
      provider: { name: 'fake-provider' },
      now: () => new Date('2026-09-03T09:00:00.000Z'),
    })
    const seen = []
    const result = await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'shot', '--shot-id', 'shot-1']), {
      provider: {
        name: 'fake-provider',
        uploadReference: async () => ({ asset_id: 'asset' }),
        submitGeneration: async (context) => {
          seen.push(context)
          return { task_id: 'task-1' }
        },
        pollGeneration: async () => ({ video_url: 'https://example.test/result.mp4' }),
        downloadResult: async ({ output_path }) => {
          fs.mkdirSync(path.dirname(output_path), { recursive: true })
          fs.writeFileSync(output_path, 'video')
          return { path: output_path, sha256: sha256(fs.readFileSync(output_path)), bytes: fs.statSync(output_path).size }
        },
        inspectArtifact: async () => ({ media: { has_audio: true }, language: { passed: true }, role: { passed: true }, dialogue: { exact_dialogue_present: true } }),
      },
      now: () => new Date('2026-09-03T09:00:05.000Z'),
    })

    assert.equal(result.status, 'completed_verified')
    assert.equal(seen[0].pack.shot_id, 'shot-1')
    assert.equal(seen[0].pack.dialogue[0].text, 'We leave tonight.')
    assert.match(seen[0].pack.prompt, /Marcus/)
    assert.equal(seen[0].uploaded_references.length, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('cross-stage package binding rejects package and manifest pack drift before provider calls', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-package-bind-'))
  try {
    const { packagePath, episodePackage } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'isolated-state')
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), {
      provider: { name: 'fake-provider' },
    })

    const mutatedPackage = JSON.parse(JSON.stringify(episodePackage))
    mutatedPackage.production_packs[0].prompt = 'same upstream hashes but a different prompt'
    mutatedPackage.production_packs[0].production_pack_hash = packHash(mutatedPackage.production_packs[0])
    fs.writeFileSync(packagePath, `${JSON.stringify(mutatedPackage, null, 2)}\n`)
    let providerCalls = 0
    const provider = {
      name: 'fake-provider',
      uploadReference: async () => { providerCalls += 1; return { asset_id: 'asset' } },
      submitGeneration: async () => { providerCalls += 1; return { task_id: 'task' } },
      pollGeneration: async () => { providerCalls += 1; return { video_url: 'https://example.test/shot.mp4' } },
      downloadResult: async () => { providerCalls += 1; return {} },
      inspectArtifact: async () => { providerCalls += 1; return {} },
      assembleEpisode: async () => { providerCalls += 1; return {} },
      inspectEpisode: async () => { providerCalls += 1; return {} },
    }
    await assert.rejects(
      () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'shot', '--shot-id', 'shot-1']), { provider }),
      /REDRAW_EPISODE_PACKAGE_STALE/,
    )
    assert.equal(providerCalls, 0)

    fs.writeFileSync(packagePath, `${JSON.stringify(episodePackage, null, 2)}\n`)
    const manifestPath = path.join(stateDir, 'private-manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.production_packs[0].production_pack_hash = '0'.repeat(64)
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await assert.rejects(
      () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'shot', '--shot-id', 'shot-1']), { provider }),
      /REDRAW_EPISODE_PACKAGE_STALE/,
    )
    assert.equal(providerCalls, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('identity references match exact character ids without Marcus arc substring collisions', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-ref-match-'))
  try {
    const arcPath = file(root, 'refs/arc.png', Buffer.from('identity-arc'))
    const { packagePath, episodePackage } = makeEpisodePackage(root)
    episodePackage.identity_references = [
      { id: 'arc-wrong', character_id: 'arc', path: arcPath, sha256: sha256(fs.readFileSync(arcPath)) },
      episodePackage.identity_references?.[0] || null,
    ].filter(Boolean)
    fs.writeFileSync(packagePath, `${JSON.stringify(episodePackage, null, 2)}\n`)
    const stateDir = path.join(root, 'isolated-state')
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), {
      provider: { name: 'fake-provider' },
    })
    const uploaded = []
    const provider = {
      name: 'fake-provider',
      uploadReference: async (reference) => {
        uploaded.push(reference.id)
        return { asset_id: `asset-${reference.id}` }
      },
      submitGeneration: async () => ({ task_id: 'task-shot-1' }),
      pollGeneration: async () => ({ video_url: 'https://example.test/shot-1.mp4' }),
      downloadResult: async ({ output_path }) => {
        fs.mkdirSync(path.dirname(output_path), { recursive: true })
        fs.writeFileSync(output_path, 'video')
        return { path: output_path, sha256: sha256(fs.readFileSync(output_path)), bytes: fs.statSync(output_path).size }
      },
      inspectArtifact: async () => ({ media: { has_audio: true }, language: { passed: true }, role: { passed: true }, dialogue: { exact_dialogue_present: true } }),
    }
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'shot', '--shot-id', 'shot-1']), { provider })
    assert.deepEqual(uploaded, ['lead-main', 'shot-1-motion'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('shot stage runs the real provider lifecycle and persists every boundary', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-lifecycle-'))
  try {
    const { packagePath, identityPath, motionPath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'isolated-state')
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), {
      provider: { name: 'fake-provider' },
      now: () => new Date('2026-09-03T09:00:00.000Z'),
    })
    const calls = []
    const resultBytes = Buffer.from('verified-local-mp4')
    const provider = {
      name: 'fake-provider',
      uploadReference: async (reference) => {
        calls.push(['uploadReference', path.basename(reference.path), reference.sha256, reference.bytes.length])
        assert.equal(Buffer.isBuffer(reference.bytes), true)
        return { asset_id: `asset-${path.basename(reference.path)}` }
      },
      submitGeneration: async ({ pack, uploaded_references }) => {
        calls.push(['submitGeneration', pack.shot_id, uploaded_references.length])
        return { task_id: 'task-shot-1' }
      },
      pollGeneration: async ({ task_id }) => {
        calls.push(['pollGeneration', task_id])
        return { video_url: 'https://example.test/shot-1.mp4' }
      },
      downloadResult: async ({ video_url, output_path }) => {
        calls.push(['downloadResult', video_url, path.basename(output_path)])
        fs.mkdirSync(path.dirname(output_path), { recursive: true })
        fs.writeFileSync(output_path, resultBytes, { flag: 'wx' })
        return { path: output_path, sha256: sha256(resultBytes), bytes: resultBytes.length }
      },
      inspectArtifact: async ({ output_path, pack }) => {
        calls.push(['inspectArtifact', path.basename(output_path), pack.dialogue[0].text])
        return {
          media: { width: 496, height: 864, duration_seconds: 5.02, has_audio: true },
          language: { locale: 'en-US', passed: true },
          role: { characters: ['lead'], passed: true },
          dialogue: { exact_dialogue_present: true, text: 'We leave tonight.' },
        }
      },
    }

    const result = await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'shot', '--shot-id', 'shot-1']), {
      provider,
      now: () => new Date('2026-09-03T09:00:05.000Z'),
    })
    const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'private-manifest.json'), 'utf8'))

    assert.deepEqual(calls, [
      ['uploadReference', path.basename(identityPath), sha256(fs.readFileSync(identityPath)), fs.statSync(identityPath).size],
      ['uploadReference', path.basename(motionPath), sha256(fs.readFileSync(motionPath)), fs.statSync(motionPath).size],
      ['submitGeneration', 'shot-1', 2],
      ['pollGeneration', 'task-shot-1'],
      ['downloadResult', 'https://example.test/shot-1.mp4', 'shot-1.mp4'],
      ['inspectArtifact', 'shot-1.mp4', 'We leave tonight.'],
    ])
    assert.equal(result.status, 'completed_verified')
    assert.equal(result.artifact.sha256, sha256(resultBytes))
    assert.equal(result.artifact.size, resultBytes.length)
    assert.equal(manifest.tasks[0].status, 'completed_verified')
    assert.equal(manifest.tasks[0].artifact.size, resultBytes.length)
    assert.doesNotMatch(JSON.stringify(manifest), /"bytes"\s*:/)
    assert.equal(manifest.tasks[0].submission_started_at, '2026-09-03T09:00:05.000Z')
    assert.doesNotMatch(JSON.stringify(result), /example\.test|asset-/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('shot stage keeps private uploaded asset IDs for generation POST while public evidence is redacted', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const { createFuminEpisodeProviderAdapter } = await import('./fuminEpisodeProviderAdapter.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-fumin-assets-'))
  try {
    const { packagePath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'isolated-state')
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), {
      provider: { name: 'fumin' },
    })
    const postedBodies = []
    let uploadCount = 0
    const videoBytes = Buffer.from('verified-local-mp4')
    const adapter = createFuminEpisodeProviderAdapter({
      apiKey: 'test-key',
      fetchImpl: async (url, options = {}) => {
        if (String(url).includes('/files/uploads')) {
          uploadCount += 1
          return { ok: true, text: async () => JSON.stringify({ id: `asset-${uploadCount}`, url: 'https://fumin.test/ref.png?token=secret' }) }
        }
        if (String(url).includes('/contents/generations/tasks') && options.method === 'POST') {
          postedBodies.push(JSON.parse(String(options.body)))
          return { ok: true, text: async () => JSON.stringify({ id: 'task-1' }) }
        }
        if (String(url).includes('/contents/generations/tasks/task-1')) {
          return { ok: true, text: async () => JSON.stringify({ status: 'succeeded', output: { video_url: 'https://fumin.test/result.mp4' } }) }
        }
        if (String(url) === 'https://fumin.test/result.mp4') {
          return { ok: true, arrayBuffer: async () => videoBytes }
        }
        throw new Error(`unexpected url ${url}`)
      },
      sleep: async () => {},
      runProcess: () => JSON.stringify({
        streams: [{ codec_type: 'video', width: 496, height: 864, codec_name: 'h264' }, { codec_type: 'audio', channels: 2, codec_name: 'aac' }],
        format: { duration: '5.02' },
      }),
      transcribeConsensus: async () => [
        { model_id: 'Systran/faster-whisper-base', language: 'en', probability: 0.99, text: 'We leave tonight.' },
        { model_id: 'Systran/faster-whisper-small', language: 'en', probability: 0.99, text: 'We leave tonight.' },
      ],
    })
    const result = await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'shot', '--shot-id', 'shot-1']), { provider: adapter })
    const privateManifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'private-manifest.json'), 'utf8'))
    const publicEvidence = JSON.parse(fs.readFileSync(path.join(stateDir, 'shot-1-public-evidence.json'), 'utf8'))

    assert.deepEqual(postedBodies[0].references.map((item) => item.asset_id), ['asset-1', 'asset-2'])
    assert.equal(privateManifest.tasks[0].uploaded_references[0].asset_id, 'asset-1')
    assert.equal(privateManifest.tasks[0].uploaded_references[0].size, Buffer.byteLength('identity-marcus'))
    assert.doesNotMatch(JSON.stringify(privateManifest), /"bytes"\s*:/)
    assert.doesNotMatch(JSON.stringify(result), /asset-1|fumin\.test|token|test-key/)
    assert.doesNotMatch(JSON.stringify(publicEvidence), /asset-1|fumin\.test|token|test-key/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('shot stage marks unknown provider results as needs_attention without retrying', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-unknown-'))
  try {
    const { packagePath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'isolated-state')
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), {
      provider: { name: 'fake-provider' },
    })
    let submitCalls = 0
    const error = new Error('timeout')
    error.code = 'REDRAW_EPISODE_PROVIDER_RESULT_UNKNOWN'
    await assert.rejects(
      () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'shot', '--shot-id', 'shot-1']), {
        provider: {
          name: 'fake-provider',
          uploadReference: async () => ({ asset_id: 'asset' }),
          submitGeneration: async () => {
            submitCalls += 1
            throw error
          },
          pollGeneration: async () => ({}),
          downloadResult: async () => ({}),
          inspectArtifact: async () => ({}),
        },
      }),
      (caught) => caught.code === 'REDRAW_EPISODE_PROVIDER_RESULT_UNKNOWN',
    )
    const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'private-manifest.json'), 'utf8'))
    assert.equal(submitCalls, 1)
    assert.equal(manifest.tasks[0].status, 'needs_attention')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('package schema fail-closes provider overrides, unknown production pack fields and symlink references', async (t) => {
  const { loadEpisodePackage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-security-'))
  try {
    const base = makeEpisodePackage(root)
    const withProvider = { ...base.episodePackage, provider: { base_url: 'https://evil.test', api_key: 'secret' } }
    const providerPath = file(root, 'package/provider-override.json', `${JSON.stringify(withProvider)}\n`)
    assert.throws(() => loadEpisodePackage(providerPath, path.join(root, 'state-a')), /REDRAW_EPISODE_PACKAGE_FIELD_FORBIDDEN/)

    const withUnknownPack = JSON.parse(JSON.stringify(base.episodePackage))
    withUnknownPack.production_packs[0].model = 'other-model'
    withUnknownPack.production_packs[0].production_pack_hash = packHash(withUnknownPack.production_packs[0])
    const unknownPackPath = file(root, 'package/unknown-pack.json', `${JSON.stringify(withUnknownPack)}\n`)
    assert.throws(() => loadEpisodePackage(unknownPackPath, path.join(root, 'state-b')), /REDRAW_EPISODE_PRODUCTION_PACK_FIELD_FORBIDDEN/)

    const symlinkPath = path.join(root, 'refs', 'identity-link.png')
    try {
      fs.symlinkSync(base.identityPath, symlinkPath)
    } catch (error) {
      t.skip(`symlink unavailable on this host: ${error.message}`)
      return
    }
    const withSymlink = JSON.parse(JSON.stringify(base.episodePackage))
    withSymlink.identity_references[0].path = symlinkPath
    const symlinkPackage = file(root, 'package/symlink.json', `${JSON.stringify(withSymlink)}\n`)
    assert.throws(() => loadEpisodePackage(symlinkPackage, path.join(root, 'state-c')), /REDRAW_EPISODE_REFERENCE_SYMLINK_REJECTED/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('assemble and verify stages rehash and inspect local completed artifacts', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-verify-'))
  try {
    const { packagePath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'isolated-state')
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), {
      provider: { name: 'fake-provider' },
    })
    const shotBytes = Buffer.from('shot-mp4')
    const episodeBytes = Buffer.from('episode-mp4')
    const provider = {
      name: 'fake-provider',
      uploadReference: async () => ({ asset_id: 'asset' }),
      submitGeneration: async () => ({ task_id: 'task-shot-1' }),
      pollGeneration: async () => ({ video_url: 'https://example.test/shot-1.mp4' }),
      downloadResult: async ({ output_path }) => {
        fs.mkdirSync(path.dirname(output_path), { recursive: true })
        fs.writeFileSync(output_path, shotBytes, { flag: 'wx' })
        return { path: output_path, sha256: sha256(shotBytes), bytes: shotBytes.length }
      },
      inspectArtifact: async () => ({ media: { has_audio: true }, language: { passed: true }, role: { passed: true }, dialogue: { exact_dialogue_present: true } }),
      assembleEpisode: async ({ output_path, shot_paths }) => {
        assert.equal(shot_paths.length, 1)
        fs.mkdirSync(path.dirname(output_path), { recursive: true })
        fs.writeFileSync(output_path, episodeBytes, { flag: 'wx' })
        return { path: output_path, sha256: sha256(episodeBytes), bytes: episodeBytes.length }
      },
      inspectEpisode: async ({ output_path }) => ({ media: { has_audio: true }, path: output_path }),
    }
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'shot', '--shot-id', 'shot-1']), { provider })
    const assembled = await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'assemble']), { provider })
    assert.equal(assembled.status, 'assembled_verified')
    assert.equal(assembled.episode_artifact.sha256, sha256(episodeBytes))
    assert.equal(assembled.episode_artifact.size, episodeBytes.length)
    assert.doesNotMatch(fs.readFileSync(path.join(stateDir, 'private-manifest.json'), 'utf8'), /"bytes"\s*:/)

    fs.appendFileSync(path.join(stateDir, 'outputs', 'shots', 'shot-1.mp4'), 'drift')
    await assert.rejects(
      () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'verify']), { provider }),
      /REDRAW_EPISODE_ARTIFACT_HASH_MISMATCH/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('verify rejects traversal, absolute and disallowed-directory artifact ids before inspecting them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-verify-paths-'))
  try {
    const state = await makeVerifyState(root)
    const outsideShot = file(root, 'outside-shot.mp4', Buffer.from('outside-shot'))
    const outsideEpisode = file(root, 'outside-episode.mp4', Buffer.from('outside-episode'))
    const privateShot = file(state.stateDir, 'private-shot.mp4', Buffer.from('private-shot'))
    const cases = [
      { target: 'shot', artifactId: '../outside-shot.mp4', artifactPath: outsideShot },
      { target: 'shot', artifactId: outsideShot, artifactPath: outsideShot },
      { target: 'shot', artifactId: 'private-shot.mp4', artifactPath: privateShot },
      { target: 'episode', artifactId: '../outside-episode.mp4', artifactPath: outsideEpisode },
      { target: 'episode', artifactId: outsideEpisode, artifactPath: outsideEpisode },
      { target: 'episode', artifactId: 'outputs/shots/shot-1.mp4', artifactPath: state.shotPath },
    ]

    for (const item of cases) {
      const manifest = JSON.parse(JSON.stringify(state.manifest))
      const artifact = { artifact_id: item.artifactId, sha256: sha256(fs.readFileSync(item.artifactPath)) }
      if (item.target === 'shot') manifest.tasks[0].artifact = artifact
      else manifest.episode_artifact = artifact
      fs.writeFileSync(state.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      let shotInspections = 0
      let episodeInspections = 0
      await assert.rejects(
        () => state.runStage(state.parseArgs(['--episode-package', state.packagePath, '--state-dir', state.stateDir, '--stage', 'verify']), {
          provider: {
            name: 'fake-provider',
            inspectArtifact: async () => { shotInspections += 1; return { media: { has_audio: true } } },
            inspectEpisode: async () => { episodeInspections += 1; return { media: { has_audio: true } } },
          },
        }),
        (error) => error.code === 'REDRAW_EPISODE_ARTIFACT_PATH_INVALID',
      )
      if (item.target === 'shot') assert.equal(shotInspections, 0)
      else assert.equal(episodeInspections, 0)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('verify rejects non-canonical artifact ids before inspecting them', async (t) => {
  const artifactIds = [
    'outputs/shots/./shot-1.mp4',
    'outputs\\shots\\shot-1.mp4',
    'outputs//shots/shot-1.mp4',
    'outputs/shots/shot-1.mp4/',
    'outputs/shots',
    'outputs/shots/shot-1.mp4:ads',
    'C:outputs/shots/shot-1.mp4',
  ]

  for (const artifactId of artifactIds) {
    await t.test(artifactId, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-verify-canonical-paths-'))
      try {
        const state = await makeVerifyState(root)
        if (artifactId.endsWith(':ads')) fs.writeFileSync(`${state.shotPath}:ads`, state.shotBytes)
        const manifest = JSON.parse(JSON.stringify(state.manifest))
        manifest.tasks[0].artifact.artifact_id = artifactId
        fs.writeFileSync(state.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
        let inspections = 0
        await assert.rejects(
          () => state.runStage(state.parseArgs(['--episode-package', state.packagePath, '--state-dir', state.stateDir, '--stage', 'verify']), {
            provider: {
              name: 'fake-provider',
              inspectArtifact: async () => { inspections += 1; return { media: { has_audio: true } } },
            },
          }),
          (error) => error.code === 'REDRAW_EPISODE_ARTIFACT_PATH_INVALID',
        )
        assert.equal(inspections, 0)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }
})

test('verify rejects symlink shot and episode artifacts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-verify-symlink-'))
  try {
    const state = await makeVerifyState(root)
    const outsideShot = file(root, 'outside-shot.mp4', Buffer.from('outside-shot'))
    const shotLink = path.join(state.stateDir, 'outputs', 'shots', 'shot-link.mp4')
    try {
      fs.symlinkSync(outsideShot, shotLink, 'file')
    } catch (error) {
      t.skip(`symlink unavailable on this host: ${error.message}`)
      return
    }
    const shotManifest = JSON.parse(JSON.stringify(state.manifest))
    shotManifest.tasks[0].artifact = { artifact_id: 'outputs/shots/shot-link.mp4', sha256: sha256(fs.readFileSync(outsideShot)) }
    fs.writeFileSync(state.manifestPath, `${JSON.stringify(shotManifest, null, 2)}\n`)
    await assert.rejects(
      () => state.runStage(state.parseArgs(['--episode-package', state.packagePath, '--state-dir', state.stateDir, '--stage', 'verify']), {
        provider: { name: 'fake-provider', inspectArtifact: async () => ({ media: { has_audio: true } }) },
      }),
      (error) => error.code === 'REDRAW_EPISODE_ARTIFACT_PATH_INVALID',
    )

    const outsideEpisode = file(root, 'outside-episode.mp4', Buffer.from('outside-episode'))
    const episodeLink = path.join(state.stateDir, 'outputs', 'episode', 'episode-link.mp4')
    fs.mkdirSync(path.dirname(episodeLink), { recursive: true })
    fs.symlinkSync(outsideEpisode, episodeLink, 'file')
    const episodeManifest = JSON.parse(JSON.stringify(state.manifest))
    episodeManifest.episode_artifact = { artifact_id: 'outputs/episode/episode-link.mp4', sha256: sha256(fs.readFileSync(outsideEpisode)) }
    fs.writeFileSync(state.manifestPath, `${JSON.stringify(episodeManifest, null, 2)}\n`)
    await assert.rejects(
      () => state.runStage(state.parseArgs(['--episode-package', state.packagePath, '--state-dir', state.stateDir, '--stage', 'verify']), {
        provider: {
          name: 'fake-provider',
          inspectArtifact: async () => ({ media: { has_audio: true } }),
          inspectEpisode: async () => ({ media: { has_audio: true } }),
        },
      }),
      (error) => error.code === 'REDRAW_EPISODE_ARTIFACT_PATH_INVALID',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('assemble and verify stages reject stale episode packages before provider calls', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-stage-bind-'))
  try {
    const { packagePath, episodePackage } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'isolated-state')
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), {
      provider: { name: 'fake-provider' },
    })
    const shotBytes = Buffer.from('shot-mp4')
    const provider = {
      name: 'fake-provider',
      uploadReference: async () => ({ asset_id: 'asset' }),
      submitGeneration: async () => ({ task_id: 'task-shot-1' }),
      pollGeneration: async () => ({ video_url: 'https://example.test/shot-1.mp4' }),
      downloadResult: async ({ output_path }) => {
        fs.mkdirSync(path.dirname(output_path), { recursive: true })
        fs.writeFileSync(output_path, shotBytes, { flag: 'wx' })
        return { path: output_path, sha256: sha256(shotBytes), bytes: shotBytes.length }
      },
      inspectArtifact: async () => ({ media: { has_audio: true }, language: { passed: true }, role: { passed: true }, dialogue: { exact_dialogue_present: true } }),
      assembleEpisode: async () => { throw new Error('assemble provider must not be called') },
      inspectEpisode: async () => { throw new Error('episode inspect provider must not be called') },
    }
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'shot', '--shot-id', 'shot-1']), { provider })

    const mutatedPackage = JSON.parse(JSON.stringify(episodePackage))
    mutatedPackage.production_packs[0].prompt = 'changed before assemble'
    mutatedPackage.production_packs[0].production_pack_hash = packHash(mutatedPackage.production_packs[0])
    fs.writeFileSync(packagePath, `${JSON.stringify(mutatedPackage, null, 2)}\n`)
    await assert.rejects(
      () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'assemble']), { provider }),
      /REDRAW_EPISODE_PACKAGE_STALE/,
    )
    await assert.rejects(
      () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'verify']), { provider }),
      /REDRAW_EPISODE_PACKAGE_STALE/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('assemble and verify stages revalidate manifest production pack bodies before provider calls', async () => {
  const { parseArgs, runStage } = await import('./run-redraw-episode-blueprint-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-episode-manifest-pack-bind-'))
  try {
    const { packagePath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'isolated-state')
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight']), {
      provider: { name: 'fake-provider' },
    })
    const shotBytes = Buffer.from('shot-mp4')
    const provider = {
      name: 'fake-provider',
      uploadReference: async () => ({ asset_id: 'asset' }),
      submitGeneration: async () => ({ task_id: 'task-shot-1' }),
      pollGeneration: async () => ({ video_url: 'https://example.test/shot-1.mp4' }),
      downloadResult: async ({ output_path }) => {
        fs.mkdirSync(path.dirname(output_path), { recursive: true })
        fs.writeFileSync(output_path, shotBytes, { flag: 'wx' })
        return { path: output_path, sha256: sha256(shotBytes), bytes: shotBytes.length }
      },
      inspectArtifact: async () => ({ media: { has_audio: true }, language: { passed: true }, role: { passed: true }, dialogue: { exact_dialogue_present: true } }),
    }
    await runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'shot', '--shot-id', 'shot-1']), { provider })

    const manifestPath = path.join(stateDir, 'private-manifest.json')
    const drifted = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    drifted.production_packs[0].prompt = 'manifest body changed but hash was not updated'
    drifted.production_packs[0].duration_ms = 6000
    drifted.production_packs[0].end_ms = 6000
    fs.writeFileSync(manifestPath, `${JSON.stringify(drifted, null, 2)}\n`)
    let adapterCalls = 0
    const assembleProvider = {
      name: 'fake-provider',
      assembleEpisode: async () => { adapterCalls += 1; return {} },
      inspectEpisode: async () => { adapterCalls += 1; return {} },
      inspectArtifact: async () => { adapterCalls += 1; return {} },
    }
    await assert.rejects(
      () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'assemble']), { provider: assembleProvider }),
      /REDRAW_EPISODE_PACKAGE_STALE/,
    )
    await assert.rejects(
      () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'verify']), { provider: assembleProvider }),
      /REDRAW_EPISODE_PACKAGE_STALE/,
    )
    assert.equal(adapterCalls, 0)

    const malformed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    delete malformed.production_packs[0].prompt
    fs.writeFileSync(manifestPath, `${JSON.stringify(malformed, null, 2)}\n`)
    await assert.rejects(
      () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'assemble']), { provider: assembleProvider }),
      /REDRAW_EPISODE_PACKAGE_STALE/,
    )
    assert.equal(adapterCalls, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runtime source is free of the fixed Latin American fixture and Mateo shortcut', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')
  assert.doesNotMatch(source, /redrawLatinAmericanCase|redraw-latin-american-case|Mateo/)
})
