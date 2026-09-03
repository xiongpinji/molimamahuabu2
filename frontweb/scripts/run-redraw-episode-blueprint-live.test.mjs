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
        submitShot: async (context) => {
          seen.push(context)
          return { task_id: 'task-1', status: 'submitted' }
        },
      },
      now: () => new Date('2026-09-03T09:00:05.000Z'),
    })

    assert.equal(result.status, 'submitted')
    assert.equal(seen[0].pack.shot_id, 'shot-1')
    assert.equal(seen[0].pack.dialogue[0].text, 'We leave tonight.')
    assert.match(seen[0].pack.prompt, /Marcus/)
    assert.equal(seen[0].references.identities[0].character_id, 'lead')
    assert.equal(seen[0].references.motion[0].shot_id, 'shot-1')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runtime source is free of the fixed Latin American fixture and Mateo shortcut', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')
  assert.doesNotMatch(source, /redrawLatinAmericanCase|redraw-latin-american-case|Mateo/)
})
