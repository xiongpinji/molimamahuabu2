import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MANIFEST_NAME = 'private-manifest.json'
const HEX_64 = /^[a-f0-9]{64}$/i
const ALLOWED_FLAGS = new Set(['episode-package', 'state-dir', 'stage', 'shot-id'])
const ALLOWED_STAGES = new Set(['preflight', 'shot', 'assemble', 'verify'])

function codedError(code, message = code) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function fail(code, message) {
  throw codedError(code, message)
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath))
}

function isAbsolutePath(value) {
  return typeof value === 'string' && path.isAbsolute(value)
}

function normalizeAbsolute(value, code) {
  if (!isAbsolutePath(value)) fail(code, value)
  return path.resolve(value)
}

function realish(value) {
  return path.resolve(value)
}

function sameOrInside(parent, child) {
  const left = realish(parent)
  const right = realish(child)
  const relative = path.relative(left, right)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function assertNoOverlap(stateDir, targets) {
  for (const target of targets.filter(Boolean)) {
    if (sameOrInside(stateDir, target) || sameOrInside(target, stateDir)) {
      fail('REDRAW_EPISODE_STATE_OVERLAPS_INPUT', `${stateDir} overlaps ${target}`)
    }
  }
}

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, filePath)
}

function publicPathless(value) {
  if (Array.isArray(value)) return value.map(publicPathless)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/(?:^|_)(?:path|url|key|secret|token|credential|password)(?:_|$)/i.test(key))
      .map(([key, item]) => [key, publicPathless(item)]))
  }
  return value
}

function productionPackHash(pack) {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    fail('REDRAW_EPISODE_PRODUCTION_PACK_INVALID')
  }
  const copy = clone(pack)
  delete copy.production_pack_hash
  return sha256Buffer(stableStringify(copy))
}

function requireHash(value, code) {
  const hash = String(value || '').trim().toLowerCase()
  if (!HEX_64.test(hash)) fail(code, value)
  return hash
}

function requireFileWithHash(item, code) {
  const filePath = normalizeAbsolute(item?.path, code)
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) fail(code, filePath)
  const expected = requireHash(item.sha256, code)
  const actual = sha256File(filePath)
  if (actual !== expected) fail(code, filePath)
  return { ...clone(item), path: filePath, sha256: expected }
}

function validatePack(pack, blueprintHash, localizationHash, seen) {
  if (pack?.schema_version !== 'redraw-shot-production-pack-v1') {
    fail('REDRAW_EPISODE_PRODUCTION_PACK_INVALID')
  }
  const shotId = String(pack.shot_id || '').trim()
  if (!shotId || seen.has(shotId)) fail('REDRAW_EPISODE_PRODUCTION_PACK_SHOT_INVALID', shotId)
  seen.add(shotId)
  if (requireHash(pack.blueprint_hash, 'REDRAW_EPISODE_BLUEPRINT_HASH_INVALID') !== blueprintHash) {
    fail('REDRAW_EPISODE_PRODUCTION_PACK_BLUEPRINT_HASH_MISMATCH')
  }
  if (requireHash(pack.localization_hash, 'REDRAW_EPISODE_LOCALIZATION_HASH_INVALID') !== localizationHash) {
    fail('REDRAW_EPISODE_PRODUCTION_PACK_LOCALIZATION_HASH_MISMATCH')
  }
  if (!Number.isSafeInteger(Number(pack.start_ms))
    || !Number.isSafeInteger(Number(pack.end_ms))
    || !Number.isSafeInteger(Number(pack.duration_ms))
    || Number(pack.end_ms) <= Number(pack.start_ms)
    || Number(pack.duration_ms) !== Number(pack.end_ms) - Number(pack.start_ms)) {
    fail('REDRAW_EPISODE_PRODUCTION_PACK_TIMING_INVALID', shotId)
  }
  if (!Array.isArray(pack.characters) || !Array.isArray(pack.dialogue)
    || !pack.visual_contract || typeof pack.visual_contract !== 'object'
    || !pack.audio_contract || typeof pack.audio_contract !== 'object'
    || typeof pack.prompt !== 'string' || !pack.prompt.trim()) {
    fail('REDRAW_EPISODE_PRODUCTION_PACK_INVALID', shotId)
  }
  if (productionPackHash(pack) !== String(pack.production_pack_hash || '').toLowerCase()) {
    fail('REDRAW_EPISODE_PRODUCTION_PACK_HASH_MISMATCH', shotId)
  }
  return clone(pack)
}

export function loadEpisodePackage(packagePath, stateDir) {
  const filePath = normalizeAbsolute(packagePath, 'REDRAW_EPISODE_PACKAGE_PATH_INVALID')
  const stateRoot = normalizeAbsolute(stateDir, 'REDRAW_EPISODE_STATE_PATH_INVALID')
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail('REDRAW_EPISODE_PACKAGE_MISSING', filePath)
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (parsed?.schema_version !== 'redraw-episode-production-package-v1') {
    fail('REDRAW_EPISODE_PACKAGE_SCHEMA_INVALID')
  }
  const blueprintHash = requireHash(parsed.blueprint_hash, 'REDRAW_EPISODE_BLUEPRINT_HASH_INVALID')
  const localizationHash = requireHash(parsed.localization_hash, 'REDRAW_EPISODE_LOCALIZATION_HASH_INVALID')
  const source = requireFileWithHash(parsed.source_media, 'REDRAW_EPISODE_SOURCE_MEDIA_INVALID')
  const identities = (Array.isArray(parsed.identity_references) ? parsed.identity_references : [])
    .map((item) => requireFileWithHash(item, 'REDRAW_EPISODE_IDENTITY_REFERENCE_INVALID'))
  const motion = (Array.isArray(parsed.motion_references) ? parsed.motion_references : [])
    .map((item) => requireFileWithHash(item, 'REDRAW_EPISODE_MOTION_REFERENCE_INVALID'))
  if (!Array.isArray(parsed.production_packs) || parsed.production_packs.length < 1) {
    fail('REDRAW_EPISODE_PRODUCTION_PACK_REQUIRED')
  }
  assertNoOverlap(stateRoot, [
    filePath,
    source.path,
    ...identities.map((item) => item.path),
    ...motion.map((item) => item.path),
    parsed.output_dir,
  ])
  const seen = new Set()
  const productionPacks = parsed.production_packs.map((pack) => (
    validatePack(pack, blueprintHash, localizationHash, seen)
  ))
  return {
    package_path: filePath,
    schema_version: parsed.schema_version,
    blueprint_hash: blueprintHash,
    localization_hash: localizationHash,
    target: clone(parsed.target || {}),
    source_media: source,
    identity_references: identities,
    motion_references: motion,
    production_packs: productionPacks,
  }
}

function readManifest(stateDir) {
  const filePath = path.join(stateDir, MANIFEST_NAME)
  if (!fs.existsSync(filePath)) fail('REDRAW_EPISODE_STATE_MISSING')
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeManifest(stateDir, manifest) {
  atomicJson(path.join(stateDir, MANIFEST_NAME), manifest)
}

function publicManifest(manifest) {
  return publicPathless(manifest)
}

function referencesForShot(pkg, shotId) {
  return {
    identities: pkg.identity_references.filter((item) => (
      !item.character_id || JSON.stringify(pkg.production_packs.find((pack) => pack.shot_id === shotId)?.characters || [])
        .includes(String(item.character_id))
    )).map(publicPathless),
    motion: pkg.motion_references.filter((item) => String(item.shot_id || '') === String(shotId)).map(publicPathless),
  }
}

async function runPreflight(options, adapters) {
  if (fs.existsSync(path.join(options.stateDir, MANIFEST_NAME))) {
    fail('REDRAW_EPISODE_STATE_ALREADY_EXISTS')
  }
  const pkg = loadEpisodePackage(options.episodePackage, options.stateDir)
  fs.mkdirSync(options.stateDir, { recursive: true })
  const manifest = {
    schema_version: 'redraw-episode-live-state-v1',
    status: 'preflight_passed',
    provider: adapters.provider?.name || options.provider || 'unspecified',
    created_at: adapters.now().toISOString(),
    updated_at: adapters.now().toISOString(),
    package_sha256: sha256File(pkg.package_path),
    blueprint_hash: pkg.blueprint_hash,
    localization_hash: pkg.localization_hash,
    target: pkg.target,
    source_media: publicPathless(pkg.source_media),
    references: {
      identities: pkg.identity_references.map(publicPathless),
      motion: pkg.motion_references.map(publicPathless),
    },
    production_packs: pkg.production_packs,
    tasks: [],
  }
  writeManifest(options.stateDir, manifest)
  atomicJson(path.join(options.stateDir, 'public-preflight-evidence.json'), publicManifest(manifest))
  return publicManifest(manifest)
}

async function runShot(options, adapters) {
  if (!options.shotId) fail('REDRAW_EPISODE_SHOT_ID_REQUIRED')
  const pkg = loadEpisodePackage(options.episodePackage, options.stateDir)
  const manifest = readManifest(options.stateDir)
  if (manifest.status !== 'preflight_passed' && manifest.status !== 'in_progress') {
    fail('REDRAW_EPISODE_STATE_NOT_READY')
  }
  if (manifest.blueprint_hash !== pkg.blueprint_hash || manifest.localization_hash !== pkg.localization_hash) {
    fail('REDRAW_EPISODE_PACKAGE_STALE')
  }
  const pack = pkg.production_packs.find((item) => item.shot_id === options.shotId)
  if (!pack) fail('REDRAW_EPISODE_SHOT_NOT_FOUND', options.shotId)
  const existing = manifest.tasks.find((item) => item.shot_id === options.shotId)
  if (existing) fail('REDRAW_EPISODE_SHOT_ALREADY_SUBMITTED', options.shotId)
  if (typeof adapters.provider?.submitShot !== 'function') {
    fail('REDRAW_EPISODE_PROVIDER_ADAPTER_REQUIRED')
  }
  const startedAt = adapters.now().toISOString()
  const task = {
    shot_id: pack.shot_id,
    status: 'submission_started',
    production_pack_hash: pack.production_pack_hash,
    prompt_sha256: sha256Buffer(pack.prompt),
    started_at: startedAt,
  }
  manifest.status = 'in_progress'
  manifest.tasks.push(task)
  manifest.updated_at = startedAt
  writeManifest(options.stateDir, manifest)
  let submitted
  try {
    submitted = await adapters.provider.submitShot({
      package: pkg,
      pack,
      references: referencesForShot(pkg, pack.shot_id),
      stateDir: options.stateDir,
    })
  } catch (error) {
    task.status = String(error?.code || '').includes('UNKNOWN') ? 'needs_attention' : 'failed'
    task.error_code = error?.code || 'REDRAW_EPISODE_PROVIDER_SUBMISSION_FAILED'
    manifest.updated_at = adapters.now().toISOString()
    writeManifest(options.stateDir, manifest)
    throw error
  }
  Object.assign(task, publicPathless(submitted), {
    status: submitted?.status || 'submitted',
    completed_at: adapters.now().toISOString(),
  })
  manifest.updated_at = task.completed_at
  writeManifest(options.stateDir, manifest)
  atomicJson(path.join(options.stateDir, `${pack.shot_id}-public-evidence.json`), publicPathless(task))
  return publicPathless(task)
}

function runAssemble(options) {
  const manifest = readManifest(options.stateDir)
  if (!manifest.production_packs.every((pack) => (
    manifest.tasks.some((task) => task.shot_id === pack.shot_id && ['submitted', 'completed_verified'].includes(task.status))
  ))) {
    fail('REDRAW_EPISODE_ASSEMBLE_NOT_READY')
  }
  manifest.status = 'assembled'
  writeManifest(options.stateDir, manifest)
  return publicManifest(manifest)
}

function runVerify(options) {
  const manifest = readManifest(options.stateDir)
  if (!['preflight_passed', 'in_progress', 'assembled'].includes(manifest.status)) {
    fail('REDRAW_EPISODE_VERIFY_STATE_INVALID')
  }
  return publicManifest({ ...manifest, verification: { status: 'passed' } })
}

export async function runStage(options, adapters = {}) {
  const local = {
    now: () => new Date(),
    provider: null,
    ...adapters,
  }
  if (options.stage === 'preflight') return runPreflight(options, local)
  if (options.stage === 'shot') return runShot(options, local)
  if (options.stage === 'assemble') return runAssemble(options, local)
  if (options.stage === 'verify') return runVerify(options, local)
  fail('REDRAW_EPISODE_STAGE_INVALID', options.stage)
}

export function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!String(flag).startsWith('--')) fail('REDRAW_EPISODE_RUNNER_ARGUMENT_INVALID', flag)
    const key = flag.slice(2)
    if (!ALLOWED_FLAGS.has(key)) fail('REDRAW_EPISODE_RUNNER_ARGUMENT_UNKNOWN', flag)
    const value = argv[index + 1]
    if (value == null || String(value).startsWith('--')) {
      fail('REDRAW_EPISODE_RUNNER_ARGUMENT_VALUE_MISSING', flag)
    }
    options[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
    index += 1
  }
  if (!options.episodePackage || !options.stateDir || !options.stage) {
    fail('REDRAW_EPISODE_RUNNER_ARGUMENT_MISSING')
  }
  options.episodePackage = normalizeAbsolute(options.episodePackage, 'REDRAW_EPISODE_PACKAGE_PATH_INVALID')
  options.stateDir = normalizeAbsolute(options.stateDir, 'REDRAW_EPISODE_STATE_PATH_INVALID')
  if (!ALLOWED_STAGES.has(options.stage)) fail('REDRAW_EPISODE_STAGE_INVALID', options.stage)
  if (options.stage === 'shot' && !options.shotId) fail('REDRAW_EPISODE_SHOT_ID_REQUIRED')
  assertNoOverlap(options.stateDir, [options.episodePackage])
  return options
}

export function createProviderAdapter(provider = {}) {
  const name = String(provider.name || 'fumin')
  return {
    name,
    async submitShot() {
      fail('REDRAW_EPISODE_PROVIDER_ADAPTER_REQUIRED', `${name} adapter must be injected for paid submission`)
    },
  }
}

export async function main(argv = process.argv.slice(2), adapters = {}) {
  const options = parseArgs(argv)
  const result = await runStage(options, {
    provider: createProviderAdapter({ name: adapters.providerName || 'fumin' }),
    ...adapters,
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(String(error?.code || error?.message || 'REDRAW_EPISODE_RUNNER_FAILED'))
    process.exitCode = 1
  })
}
