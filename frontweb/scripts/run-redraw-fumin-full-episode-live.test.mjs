import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const wrapperPath = fileURLToPath(new URL('./run-redraw-fumin-full-episode-live.mjs', import.meta.url))
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe'
const durations = [
  1200, 2433, 7134, 866, 2200, 1567, 967, 1066, 1800, 7367, 7700, 933,
  734, 733, 933, 4134, 4966, 7967, 3633, 2234, 1266, 1734, 1400, 3766,
]
const asrModelIds = ['Systran/faster-whisper-base', 'Systran/faster-whisper-small']

function haveMediaTools() {
  try {
    execFileSync(ffmpegPath, ['-version'], { stdio: 'ignore' })
    execFileSync(ffprobePath, ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath))
}

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
  return sha256(stableStringify(copy))
}

function writeFile(root, relativePath, value) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, value)
  return target
}

function productionPackHash(pack) {
  return canonicalHash(pack, 'production_pack_hash')
}

function createMotion(filePath, durationSeconds = 10) {
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
    '-f', 'lavfi', '-i', `color=c=green:s=480x864:r=24:d=${durationSeconds}`,
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', filePath,
  ])
}

function createRaw(filePath) {
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
    '-f', 'lavfi', '-i', 'color=c=blue:s=480x864:r=24:d=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', '-movflags', '+faststart', filePath,
  ])
}

function makePackage(root, { shotDurations = [5000], motionPath } = {}) {
  const sourcePath = writeFile(root, 'source/source.mp4', 'source-package-binding-only')
  const resolvedMotionPath = motionPath || writeFile(root, 'references/motion.mp4', 'motion-not-used-by-explicit-provider')
  const motionHash = sha256File(resolvedMotionPath)
  const blueprintHash = 'b'.repeat(64)
  const localizationHash = 'c'.repeat(64)
  let cursor = 0
  const productionPacks = shotDurations.map((duration, index) => {
    const shotId = `shot-${String(index + 1).padStart(2, '0')}`
    const startMs = cursor
    cursor += duration
    const pack = {
      schema_version: 'redraw-shot-production-pack-v1',
      shot_id: shotId,
      start_ms: startMs,
      end_ms: cursor,
      duration_ms: duration,
      blueprint_hash: blueprintHash,
      localization_hash: localizationHash,
      characters: [],
      dialogue: [],
      visual_contract: { composition: 'locked composition', references: [{ kind: 'motion', sha256: motionHash }] },
      audio_contract: { locale: 'en-US', speech_required: false },
      prompt: `Shot ${index + 1}. Ambient sound only.`,
    }
    pack.production_pack_hash = productionPackHash(pack)
    return pack
  })
  const episodePackage = {
    schema_version: 'redraw-episode-production-package-v1',
    blueprint_hash: blueprintHash,
    localization_hash: localizationHash,
    target: { locale: 'en-US', market: 'US' },
    source_media: { path: sourcePath, sha256: sha256File(sourcePath) },
    identity_references: [],
    motion_references: productionPacks.map((pack) => ({
      id: `motion-${pack.shot_id}`,
      kind: 'motion',
      shot_id: pack.shot_id,
      path: resolvedMotionPath,
      sha256: motionHash,
      mime_type: 'video/mp4',
    })),
    production_packs: productionPacks,
  }
  return writeFile(root, 'package/episode.json', `${JSON.stringify(episodePackage, null, 2)}\n`)
}

async function quietMain(main, argv, adapters) {
  const originalWrite = process.stdout.write
  try {
    process.stdout.write = () => true
    return await main(argv, adapters)
  } finally {
    process.stdout.write = originalWrite
  }
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify(payload) },
  }
}

function downloadResponse(bytes) {
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
  }
}

function createOfflineFetch(rawBytes, { unknownAt = null } = {}) {
  const calls = []
  const generationKeys = []
  let executionUnits = []
  let generationPosts = 0

  return {
    calls,
    generationKeys,
    get generationPosts() { return generationPosts },
    bindExecutionUnits(units) { executionUnits = units },
    async fetchImpl(value, options = {}) {
      const url = new URL(String(value))
      const method = String(options.method || 'GET').toUpperCase()
      calls.push({ url: url.href, method })

      if (url.hostname === 'fumin.ai' && url.pathname === '/api/v3/files/uploads' && method === 'POST') {
        const number = calls.filter((call) => call.url.includes('/api/v3/files/uploads')).length
        return jsonResponse({ id: `asset-${number}`, url: `https://offline.test/assets/${number}` })
      }
      if (url.hostname === 'fumin.ai' && url.pathname === '/api/v3/contents/generations/tasks' && method === 'POST') {
        generationPosts += 1
        const body = JSON.parse(String(options.body || '{}'))
        assert.equal(body.model, 'seedance-2.0-mini')
        assert.deepEqual(body.content.map((item) => item.type), ['text', 'video_url'])
        assert.match(body.content[0].text, /Ambient sound only/)
        assert.match(body.content[1].video_url.url, /^https:\/\/offline\.test\/assets\/\d+$/u)
        assert.equal(body.duration, 5)
        assert.equal(body.resolution, '480p')
        assert.equal(body.ratio, '9:16')
        assert.equal(body.generate_audio, true)
        assert.equal(body.watermark, false)
        assert.doesNotMatch(String(options.body), /"references"|"asset_id"|"prompt"|"aspect_ratio"/)
        const unit = executionUnits[generationPosts - 1]
        assert.ok(unit, `missing execution unit for generation ${generationPosts}`)
        generationKeys.push(`${unit.unit_id}:${unit.unit_hash}`)
        return jsonResponse({ id: `task-${generationPosts}` })
      }
      const poll = url.pathname.match(/^\/api\/v3\/contents\/generations\/tasks\/task-(\d+)$/u)
      if (url.hostname === 'fumin.ai' && poll && method === 'GET') {
        const number = Number(poll[1])
        if (number === unknownAt) throw new Error('offline injected status boundary')
        return jsonResponse({ status: 'completed', video_url: `https://offline.test/download/task-${number}` })
      }
      if (url.hostname === 'offline.test' && /^\/download\/task-\d+$/u.test(url.pathname) && method === 'GET') {
        return downloadResponse(rawBytes)
      }
      throw new Error(`UNEXPECTED_OFFLINE_FETCH:${method}:${url.href}`)
    },
  }
}

function offlineAdapters(fetchHarness) {
  return {
    apiKey: 'offline-test-key',
    verifierPython: 'offline-not-used',
    ffmpegPath,
    ffprobePath,
    fetchImpl: fetchHarness.fetchImpl.bind(fetchHarness),
    sleep: async () => {},
    transcribeConsensus: async () => asrModelIds.map((modelId) => ({
      model_id: modelId,
      language: 'en',
      probability: 1,
      text: '',
      evidence: 'ambient-audio-only',
    })),
    now: () => new Date('2026-09-04T00:00:00.000Z'),
  }
}

test('Fumin live wrapper delegates to the generic episode runner and prefers an explicit provider', async () => {
  const runner = await import('./run-redraw-fumin-full-episode-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-fumin-wrapper-'))
  try {
    const packagePath = makePackage(root)
    const stateDir = path.join(root, 'state')
    const provider = { name: 'fumin' }
    const result = await quietMain(runner.main, [
      '--episode-package', packagePath,
      '--state-dir', stateDir,
      '--stage', 'preflight',
    ], {
      provider,
      providerName: 'must-not-replace-fumin',
      now: () => new Date('2026-09-03T10:00:00.000Z'),
    })

    assert.equal(result.provider, 'fumin')
    assert.equal(result.status, 'preflight_passed')
    assert.equal(result.production_packs[0].shot_id, 'shot-01')
    assert.equal(result.execution_mode, 'legacy-shot')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Fumin wrapper installs planner, motion materializer, and media dependencies with providerName locked last', () => {
  const source = fs.readFileSync(wrapperPath, 'utf8')
  assert.match(source, /buildFuminEpisodeExecutionPlan/u)
  assert.match(source, /materializeFuminExecutionMotion/u)
  assert.match(source, /normalizeUnitArtifact/u)
  assert.match(source, /assembleNormalizedEpisode/u)
  assert.match(source, /\.\.\.adapters,[\s\S]*providerName:\s*['"]fumin['"]/u)
})

test('default Fumin adapter preflight materializes one hash-bound five-second motion without HTTP', { skip: !haveMediaTools(), timeout: 120_000 }, async () => {
  const { main } = await import('./run-redraw-fumin-full-episode-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-fumin-preflight-'))
  try {
    const motionPath = path.join(root, 'motion.mp4')
    createMotion(motionPath, 5)
    const packagePath = makePackage(root, { motionPath })
    const stateDir = path.join(root, 'state')
    let fetchCalls = 0
    const result = await quietMain(main, [
      '--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight',
    ], {
      apiKey: 'offline-test-key',
      verifierPython: 'offline-not-used',
      ffmpegPath,
      ffprobePath,
      fetchImpl: async () => { fetchCalls += 1; throw new Error('preflight must not fetch') },
      now: () => new Date('2026-09-04T00:00:00.000Z'),
    })

    assert.equal(fetchCalls, 0)
    assert.equal(result.provider, 'fumin')
    assert.equal(result.execution_mode, 'provider-units')
    assert.equal(result.execution_units.length, 1)
    assert.ok(result.execution_units.every((unit) => unit.provider_duration_seconds === 5))
    assert.equal(result.tasks.length, 0)
    assert.match(result.execution_plan_hash, /^[a-f0-9]{64}$/u)
    assert.equal(result.execution_plan_hash, result.execution_plan.execution_plan_hash)
    const unit = result.execution_units[0]
    assert.ok(unit.materialized_motion)
    const materializedPath = path.join(stateDir, ...unit.materialized_motion.artifact_id.split('/'))
    assert.equal(fs.existsSync(materializedPath), true)
    assert.equal(sha256File(materializedPath), unit.materialized_motion.sha256)
    assert.equal(unit.unit_hash, canonicalHash(unit, 'unit_hash'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('28 planned units complete through offline fake HTTP, normalization, assembly, and verification', { skip: !haveMediaTools(), timeout: 600_000 }, async () => {
  const { main } = await import('./run-redraw-fumin-full-episode-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-fumin-e2e-'))
  try {
    const motionPath = path.join(root, 'motion.mp4')
    const rawPath = path.join(root, 'raw.mp4')
    createMotion(motionPath)
    createRaw(rawPath)
    const packagePath = makePackage(root, { shotDurations: durations, motionPath })
    const stateDir = path.join(root, 'state')
    const fake = createOfflineFetch(fs.readFileSync(rawPath))
    const adapters = offlineAdapters(fake)
    const args = (stage) => ['--episode-package', packagePath, '--state-dir', stateDir, '--stage', stage]

    const preflight = await quietMain(main, args('preflight'), adapters)
    assert.equal(fake.calls.length, 0)
    assert.equal(preflight.execution_units.length, 28)
    assert.equal(preflight.execution_units.reduce((sum, unit) => sum + unit.keep_duration_ms, 0), 68_733)
    assert.ok(preflight.execution_units.every((unit) => unit.provider_duration_seconds === 5))
    for (const unit of preflight.execution_units) {
      assert.equal(unit.motion_reference_id, `motion-${unit.parent_shot_id}`)
      const materializedPath = path.join(stateDir, ...unit.materialized_motion.artifact_id.split('/'))
      assert.equal(sha256File(materializedPath), unit.materialized_motion.sha256)
    }
    fake.bindExecutionUnits(preflight.execution_units)

    const sequenced = await quietMain(main, args('sequence'), adapters)
    assert.equal(fake.generationPosts, 28)
    assert.equal(fake.generationKeys.length, 28)
    assert.equal(new Set(fake.generationKeys).size, 28)
    assert.deepEqual(
      fake.generationKeys,
      preflight.execution_units.map((unit) => `${unit.unit_id}:${unit.unit_hash}`),
    )
    assert.equal(fake.calls.length, 112)
    assert.equal(sequenced.tasks.length, 28)
    assert.ok(sequenced.tasks.every((task) => task.status === 'completed_verified'))
    for (const task of sequenced.tasks) {
      assert.match(task.unit_hash, /^[a-f0-9]{64}$/u)
      assert.match(task.raw_artifact.sha256, /^[a-f0-9]{64}$/u)
      assert.match(task.artifact.sha256, /^[a-f0-9]{64}$/u)
      assert.equal(task.verification.dialogue.speech_required, false)
      assert.equal(task.verification.dialogue.consensus_passed, true)
      assert.equal(task.verification.dialogue.models.length, 2)
      assert.ok(task.verification.dialogue.models.every((model) => model.text === '' && model.evidence === 'ambient-audio-only'))
    }

    const assembled = await quietMain(main, args('assemble'), adapters)
    assert.equal(assembled.status, 'assembled_verified')
    assert.match(assembled.episode_artifact.sha256, /^[a-f0-9]{64}$/u)
    assert.equal(assembled.episode_verification.media.width, 480)
    assert.equal(assembled.episode_verification.media.height, 864)
    assert.equal(assembled.episode_verification.media.has_audio, true)
    assert.ok(assembled.episode_verification.media.audio_duration_seconds > 68.58)
    assert.ok(Math.abs(assembled.episode_verification.media.duration_seconds - 68.733) <= 0.15)

    const verified = await quietMain(main, args('verify'), adapters)
    assert.equal(verified.verification.status, 'passed')
    assert.equal(verified.execution_plan_hash, preflight.execution_plan_hash)
    assert.equal(fake.generationPosts, 28)
    assert.equal(fake.calls.length, 112)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('status unknown on unit 9 stops sequence and restart before unit 10 without another POST', { skip: !haveMediaTools(), timeout: 600_000 }, async () => {
  const { main } = await import('./run-redraw-fumin-full-episode-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-fumin-unknown-'))
  try {
    const motionPath = path.join(root, 'motion.mp4')
    const rawPath = path.join(root, 'raw.mp4')
    createMotion(motionPath)
    createRaw(rawPath)
    const packagePath = makePackage(root, { shotDurations: durations, motionPath })
    const stateDir = path.join(root, 'state')
    const fake = createOfflineFetch(fs.readFileSync(rawPath), { unknownAt: 9 })
    const adapters = offlineAdapters(fake)
    const args = (stage) => ['--episode-package', packagePath, '--state-dir', stateDir, '--stage', stage]

    const preflight = await quietMain(main, args('preflight'), adapters)
    fake.bindExecutionUnits(preflight.execution_units)
    await assert.rejects(
      () => quietMain(main, args('sequence'), adapters),
      { code: 'FUMIN_EPISODE_STATUS_UNKNOWN' },
    )
    assert.equal(fake.generationPosts, 9)
    assert.equal(fake.calls.length, 35)
    let manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'private-manifest.json'), 'utf8'))
    assert.equal(manifest.tasks.length, 9)
    assert.equal(manifest.tasks[8].unit_id, preflight.execution_units[8].unit_id)
    assert.equal(manifest.tasks[8].status, 'needs_attention')
    assert.deepEqual(
      preflight.execution_units.slice(9).map((unit) => unit.unit_id)
        .filter((unitId) => manifest.tasks.some((task) => task.unit_id === unitId)),
      [],
    )

    await assert.rejects(
      () => quietMain(main, args('sequence'), adapters),
      { code: 'REDRAW_EPISODE_UNIT_ALREADY_SUBMITTED' },
    )
    assert.equal(fake.generationPosts, 9)
    assert.equal(fake.calls.length, 35)
    manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'private-manifest.json'), 'utf8'))
    assert.equal(manifest.tasks.length, 9)
    assert.equal(manifest.tasks[8].status, 'needs_attention')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Fumin live wrapper source does not load the fixed Latin American fixture', () => {
  const source = fs.readFileSync(wrapperPath, 'utf8')
  assert.doesNotMatch(source, /redrawLatinAmericanCase|redraw-latin-american-case|Mateo/u)
  assert.match(source, /run-redraw-episode-blueprint-live/u)
})
