import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const wrapperPath = fileURLToPath(new URL('./run-redraw-fumin-full-episode-live.mjs', import.meta.url))

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

function writeFile(root, relativePath, value) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, value)
  return target
}

function productionPackHash(pack) {
  const copy = JSON.parse(JSON.stringify(pack))
  delete copy.production_pack_hash
  return sha256(stableStringify(copy))
}

function makePackage(root) {
  const sourcePath = writeFile(root, 'source/source.mp4', 'source')
  const identityPath = writeFile(root, 'references/ava.png', 'identity')
  const motionPath = writeFile(root, 'references/shot-1.mp4', 'motion')
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
    characters: [{ id: 'lead', name: 'Ava', assets: [{ kind: 'identity', sha256: sha256(fs.readFileSync(identityPath)) }] }],
    dialogue: [{ speaker_id: 'lead', speaker_name: 'Ava', text: 'I know the truth.', start_ms: 1000, end_ms: 2600 }],
    visual_contract: { composition: 'close-up', references: [{ kind: 'motion', sha256: sha256(fs.readFileSync(motionPath)) }] },
    audio_contract: { locale: 'en-US', speech_required: true },
    prompt: 'Ava speaks English: I know the truth.',
  }
  pack.production_pack_hash = productionPackHash(pack)
  const episodePackage = {
    schema_version: 'redraw-episode-production-package-v1',
    blueprint_hash: blueprintHash,
    localization_hash: localizationHash,
    target: { locale: 'en-US', market: 'US' },
    source_media: { path: sourcePath, sha256: sha256(fs.readFileSync(sourcePath)) },
    identity_references: [{ character_id: 'lead', path: identityPath, sha256: sha256(fs.readFileSync(identityPath)) }],
    motion_references: [{ shot_id: 'shot-1', path: motionPath, sha256: sha256(fs.readFileSync(motionPath)) }],
    production_packs: [pack],
  }
  return writeFile(root, 'package/episode.json', `${JSON.stringify(episodePackage, null, 2)}\n`)
}

test('Fumin live wrapper delegates to the generic episode runner with provider=fumin', async () => {
  const runner = await import('./run-redraw-fumin-full-episode-live.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-fumin-wrapper-'))
  try {
    const packagePath = makePackage(root)
    const stateDir = path.join(root, 'state')
    const originalWrite = process.stdout.write
    let result
    try {
      process.stdout.write = () => true
      result = await runner.main([
        '--episode-package', packagePath,
        '--state-dir', stateDir,
        '--stage', 'preflight',
      ], {
        now: () => new Date('2026-09-03T10:00:00.000Z'),
      })
    } finally {
      process.stdout.write = originalWrite
    }

    assert.equal(result.provider, 'fumin')
    assert.equal(result.status, 'preflight_passed')
    assert.equal(result.production_packs[0].shot_id, 'shot-1')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Fumin live wrapper source does not load the fixed Latin American fixture', () => {
  const source = fs.readFileSync(wrapperPath, 'utf8')
  assert.doesNotMatch(source, /redrawLatinAmericanCase|redraw-latin-american-case|Mateo/)
  assert.match(source, /run-redraw-episode-blueprint-live/)
})
