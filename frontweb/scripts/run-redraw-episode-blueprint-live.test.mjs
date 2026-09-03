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

test('generic runner rejects relative paths, unknown flags, stale hashes, and package paths inside state', async () => {
  const { parseArgs, loadEpisodePackage } = await import('./run-redraw-episode-blueprint-live.mjs')
  assert.throws(() => parseArgs(['--episode-package', 'relative.json', '--state-dir', 'C:/state', '--stage', 'preflight']), /REDRAW_EPISODE_PACKAGE_PATH_INVALID/)
  assert.throws(() => parseArgs(['--episode-package', 'C:/package.json', '--state-dir', 'C:/state', '--stage', 'preflight', '--provider-url', 'https://example.test']), /REDRAW_EPISODE_RUNNER_ARGUMENT_UNKNOWN/)

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
    assert.equal(manifest.tasks[0].status, 'completed_verified')
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

    fs.appendFileSync(path.join(stateDir, 'outputs', 'shots', 'shot-1.mp4'), 'drift')
    await assert.rejects(
      () => runStage(parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'verify']), { provider }),
      /REDRAW_EPISODE_ARTIFACT_HASH_MISMATCH/,
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

test('runtime source is free of the fixed Latin American fixture and Mateo shortcut', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')
  assert.doesNotMatch(source, /redrawLatinAmericanCase|redraw-latin-american-case|Mateo/)
})
