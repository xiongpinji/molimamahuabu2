import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MANIFEST_NAME = 'private-manifest.json'
const HEX_64 = /^[a-f0-9]{64}$/i
const ALLOWED_FLAGS = new Set(['episode-package', 'state-dir', 'stage', 'shot-id'])
const ALLOWED_STAGES = new Set(['preflight', 'shot', 'assemble', 'verify'])
const FORBIDDEN_FIELD = /(?:^|_)(?:provider|model|api[_-]?key|base[_-]?url|url|key|token|secret|credential|password)(?:_|$)/i
const PACKAGE_KEYS = new Set(['schema_version', 'blueprint_hash', 'localization_hash', 'target', 'source_media', 'identity_references', 'motion_references', 'production_packs'])
const SOURCE_KEYS = new Set(['path', 'sha256', 'mime_type', 'bytes', 'duration_ms'])
const REFERENCE_KEYS = new Set(['id', 'kind', 'character_id', 'source_character_key', 'shot_id', 'path', 'sha256', 'mime_type', 'bytes', 'width', 'height', 'duration_ms'])
const PACK_KEYS = new Set(['schema_version', 'shot_id', 'start_ms', 'end_ms', 'duration_ms', 'blueprint_hash', 'localization_hash', 'characters', 'dialogue', 'visual_contract', 'audio_contract', 'prompt', 'production_pack_hash'])

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

function normalizeAbsolute(value, code) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(code, value)
  return path.resolve(value)
}

function sameOrInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function realTargetPath(targetPath) {
  if (fs.existsSync(targetPath)) {
    const stat = fs.lstatSync(targetPath)
    if (stat.isSymbolicLink()) fail('REDRAW_EPISODE_STATE_SYMLINK_REJECTED', targetPath)
    return fs.realpathSync(targetPath)
  }
  let parent = path.dirname(targetPath)
  while (!fs.existsSync(parent)) parent = path.dirname(parent)
  if (fs.lstatSync(parent).isSymbolicLink()) fail('REDRAW_EPISODE_STATE_SYMLINK_REJECTED', parent)
  return path.join(fs.realpathSync(parent), path.relative(parent, targetPath))
}

function realExistingPath(filePath, code) {
  if (!fs.existsSync(filePath)) fail(code, filePath)
  const stat = fs.lstatSync(filePath)
  if (stat.isSymbolicLink()) fail(code, filePath)
  return fs.realpathSync(filePath)
}

function assertNoOverlap(stateDir, targets) {
  const stateReal = realTargetPath(stateDir)
  for (const target of targets.filter(Boolean)) {
    const targetReal = fs.existsSync(target) ? realExistingPath(target, 'REDRAW_EPISODE_INPUT_SYMLINK_REJECTED') : path.resolve(target)
    if (sameOrInside(stateReal, targetReal) || sameOrInside(targetReal, stateReal)) {
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
      .filter(([key]) => !/(?:^|_)(?:path|url|key|secret|token|credential|password|asset[_-]?id)(?:_|$)/i.test(key))
      .map(([key, item]) => [key, publicPathless(item)]))
  }
  return value
}

function assertKeys(value, allowed, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code, key)
  }
}

function assertNoForbiddenKeys(value, code, allowTopPath = false) {
  if (Array.isArray(value)) return value.forEach((item) => assertNoForbiddenKeys(item, code, allowTopPath))
  if (!value || typeof value !== 'object') return undefined
  for (const [key, item] of Object.entries(value)) {
    if ((!allowTopPath || key !== 'path') && FORBIDDEN_FIELD.test(key)) fail(code, key)
    assertNoForbiddenKeys(item, code, false)
  }
  return undefined
}

function productionPackHash(pack) {
  const copy = clone(pack)
  delete copy.production_pack_hash
  return sha256Buffer(stableStringify(copy))
}

function requireHash(value, code) {
  const hash = String(value || '').trim().toLowerCase()
  if (!HEX_64.test(hash)) fail(code, value)
  return hash
}

function requireFileWithHash(item, allowed, code, symlinkCode) {
  assertKeys(item, allowed, code)
  assertNoForbiddenKeys(item, code, true)
  const filePath = normalizeAbsolute(item.path, code)
  if (!fs.existsSync(filePath)) fail(code, filePath)
  const stat = fs.lstatSync(filePath)
  if (stat.isSymbolicLink()) fail(symlinkCode, filePath)
  if (!stat.isFile()) fail(code, filePath)
  const expected = requireHash(item.sha256, code)
  const bytes = fs.readFileSync(filePath)
  const actual = sha256Buffer(bytes)
  if (actual !== expected) fail(code, filePath)
  return { ...clone(item), path: fs.realpathSync(filePath), sha256: expected, bytes }
}

function validatePack(pack, blueprintHash, localizationHash, seen) {
  assertKeys(pack, PACK_KEYS, 'REDRAW_EPISODE_PRODUCTION_PACK_FIELD_FORBIDDEN')
  assertNoForbiddenKeys(pack, 'REDRAW_EPISODE_PRODUCTION_PACK_FIELD_FORBIDDEN')
  if (pack.schema_version !== 'redraw-shot-production-pack-v1') fail('REDRAW_EPISODE_PRODUCTION_PACK_INVALID')
  const shotId = String(pack.shot_id || '').trim()
  if (!shotId || seen.has(shotId)) fail('REDRAW_EPISODE_PRODUCTION_PACK_SHOT_INVALID', shotId)
  seen.add(shotId)
  if (requireHash(pack.blueprint_hash, 'REDRAW_EPISODE_BLUEPRINT_HASH_INVALID') !== blueprintHash) fail('REDRAW_EPISODE_PRODUCTION_PACK_BLUEPRINT_HASH_MISMATCH')
  if (requireHash(pack.localization_hash, 'REDRAW_EPISODE_LOCALIZATION_HASH_INVALID') !== localizationHash) fail('REDRAW_EPISODE_PRODUCTION_PACK_LOCALIZATION_HASH_MISMATCH')
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
  if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) fail('REDRAW_EPISODE_PACKAGE_MISSING', filePath)
  if (fs.lstatSync(filePath).isSymbolicLink()) fail('REDRAW_EPISODE_PACKAGE_SYMLINK_REJECTED', filePath)
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assertKeys(parsed, PACKAGE_KEYS, 'REDRAW_EPISODE_PACKAGE_FIELD_FORBIDDEN')
  for (const [key, item] of Object.entries(parsed)) {
    if (FORBIDDEN_FIELD.test(key)) fail('REDRAW_EPISODE_PACKAGE_FIELD_FORBIDDEN', key)
    if (key !== 'production_packs') assertNoForbiddenKeys(item, 'REDRAW_EPISODE_PACKAGE_FIELD_FORBIDDEN', key === 'source_media' || key.endsWith('_references'))
  }
  if (parsed.schema_version !== 'redraw-episode-production-package-v1') fail('REDRAW_EPISODE_PACKAGE_SCHEMA_INVALID')
  const blueprintHash = requireHash(parsed.blueprint_hash, 'REDRAW_EPISODE_BLUEPRINT_HASH_INVALID')
  const localizationHash = requireHash(parsed.localization_hash, 'REDRAW_EPISODE_LOCALIZATION_HASH_INVALID')
  const source = requireFileWithHash(parsed.source_media, SOURCE_KEYS, 'REDRAW_EPISODE_SOURCE_MEDIA_INVALID', 'REDRAW_EPISODE_SOURCE_MEDIA_SYMLINK_REJECTED')
  const identities = (Array.isArray(parsed.identity_references) ? parsed.identity_references : [])
    .map((item) => requireFileWithHash(item, REFERENCE_KEYS, 'REDRAW_EPISODE_IDENTITY_REFERENCE_INVALID', 'REDRAW_EPISODE_REFERENCE_SYMLINK_REJECTED'))
  const motion = (Array.isArray(parsed.motion_references) ? parsed.motion_references : [])
    .map((item) => requireFileWithHash(item, REFERENCE_KEYS, 'REDRAW_EPISODE_MOTION_REFERENCE_INVALID', 'REDRAW_EPISODE_REFERENCE_SYMLINK_REJECTED'))
  if (!Array.isArray(parsed.production_packs) || parsed.production_packs.length < 1) fail('REDRAW_EPISODE_PRODUCTION_PACK_REQUIRED')
  assertNoOverlap(stateRoot, [filePath, source.path, ...identities.map((item) => item.path), ...motion.map((item) => item.path)])
  const seen = new Set()
  const productionPacks = parsed.production_packs.map((pack) => validatePack(pack, blueprintHash, localizationHash, seen))
  return {
    package_path: fs.realpathSync(filePath),
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

function outputPathForShot(stateDir, shotId) {
  return path.join(stateDir, 'outputs', 'shots', `${String(shotId).replace(/[^a-zA-Z0-9._-]/g, '_')}.mp4`)
}

function episodeOutputPath(stateDir) {
  return path.join(stateDir, 'outputs', 'episode', 'episode.mp4')
}

function referencesForShot(pkg, shotId) {
  const pack = pkg.production_packs.find((item) => item.shot_id === shotId)
  const characterJson = JSON.stringify(pack?.characters || [])
  return [
    ...pkg.identity_references.filter((item) => !item.character_id || characterJson.includes(String(item.character_id))),
    ...pkg.motion_references.filter((item) => String(item.shot_id || '') === String(shotId)),
  ].map((item) => {
    const bytes = fs.readFileSync(item.path)
    if (sha256Buffer(bytes) !== item.sha256) fail('REDRAW_EPISODE_REFERENCE_HASH_CHANGED', item.id || item.path)
    return { ...item, bytes }
  })
}

function assertProvider(provider, methods) {
  for (const method of methods) {
    if (typeof provider?.[method] !== 'function') fail('REDRAW_EPISODE_PROVIDER_ADAPTER_REQUIRED', method)
  }
}

async function runPreflight(options, adapters) {
  if (fs.existsSync(path.join(options.stateDir, MANIFEST_NAME))) fail('REDRAW_EPISODE_STATE_ALREADY_EXISTS')
  const pkg = loadEpisodePackage(options.episodePackage, options.stateDir)
  fs.mkdirSync(options.stateDir, { recursive: true })
  const now = adapters.now().toISOString()
  const manifest = {
    schema_version: 'redraw-episode-live-state-v1',
    status: 'preflight_passed',
    provider: adapters.provider?.name || options.provider || 'unspecified',
    created_at: now,
    updated_at: now,
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
  atomicJson(path.join(options.stateDir, 'public-preflight-evidence.json'), publicPathless(manifest))
  return publicPathless(manifest)
}

function classifyProviderError(error) {
  const code = String(error?.code || error?.message || '')
  return /UNKNOWN|TIMEOUT|RESULT_UNKNOWN|STATUS_UNKNOWN|REFERENCE_UPLOAD_UNKNOWN|SUBMISSION_UNKNOWN|DOWNLOAD_UNKNOWN/.test(code) ? 'needs_attention' : 'failed'
}

function expectedEpisodeDurationSeconds(manifest) {
  return manifest.production_packs.reduce((sum, pack) => sum + (Number(pack.duration_ms) / 1000), 0)
}

function assertEpisodeInspection(manifest, inspection) {
  const duration = Number(inspection?.media?.duration_seconds ?? inspection?.media?.duration)
  if (Number.isFinite(duration)) {
    const expected = expectedEpisodeDurationSeconds(manifest)
    if (Math.abs(duration - expected) > Math.max(1, manifest.production_packs.length * 0.25)) {
      fail('REDRAW_EPISODE_DURATION_MISMATCH', `${duration} !== ${expected}`)
    }
  }
  if (inspection?.media && inspection.media.has_audio === false) {
    fail('REDRAW_EPISODE_AUDIO_MISSING')
  }
}

async function runShot(options, adapters) {
  if (!options.shotId) fail('REDRAW_EPISODE_SHOT_ID_REQUIRED')
  assertProvider(adapters.provider, ['uploadReference', 'submitGeneration', 'pollGeneration', 'downloadResult', 'inspectArtifact'])
  const pkg = loadEpisodePackage(options.episodePackage, options.stateDir)
  const manifest = readManifest(options.stateDir)
  if (manifest.status !== 'preflight_passed' && manifest.status !== 'in_progress') fail('REDRAW_EPISODE_STATE_NOT_READY')
  if (manifest.blueprint_hash !== pkg.blueprint_hash || manifest.localization_hash !== pkg.localization_hash) fail('REDRAW_EPISODE_PACKAGE_STALE')
  const pack = pkg.production_packs.find((item) => item.shot_id === options.shotId)
  if (!pack) fail('REDRAW_EPISODE_SHOT_NOT_FOUND', options.shotId)
  if (manifest.tasks.find((item) => item.shot_id === options.shotId)) fail('REDRAW_EPISODE_SHOT_ALREADY_SUBMITTED', options.shotId)
  const now = () => adapters.now().toISOString()
  const task = {
    shot_id: pack.shot_id,
    status: 'reference_upload_started',
    production_pack_hash: pack.production_pack_hash,
    prompt_sha256: sha256Buffer(pack.prompt),
    started_at: now(),
    uploaded_references: [],
  }
  manifest.status = 'in_progress'
  manifest.tasks.push(task)
  manifest.updated_at = task.started_at
  writeManifest(options.stateDir, manifest)
  try {
    for (const reference of referencesForShot(pkg, pack.shot_id)) {
      const uploaded = await adapters.provider.uploadReference(reference)
      task.uploaded_references.push(clone(uploaded))
      manifest.updated_at = now()
      writeManifest(options.stateDir, manifest)
    }
    task.status = 'submission_started'
    task.submission_started_at = now()
    writeManifest(options.stateDir, manifest)
    const submitted = await adapters.provider.submitGeneration({
      pack: clone(pack),
      uploaded_references: task.uploaded_references.map(clone),
    })
    task.status = 'provider_processing'
    task.task_id = String(submitted.task_id)
    task.submitted_at = now()
    writeManifest(options.stateDir, manifest)
    const polled = await adapters.provider.pollGeneration({ task_id: task.task_id, pack: clone(pack) })
    task.status = 'result_downloading'
    task.polled_at = now()
    writeManifest(options.stateDir, manifest)
    const outputPath = outputPathForShot(options.stateDir, pack.shot_id)
    const downloaded = await adapters.provider.downloadResult({ video_url: polled.video_url, output_path: outputPath, pack: clone(pack) })
    task.status = 'artifact_downloaded'
    task.artifact = {
      artifact_id: path.relative(options.stateDir, downloaded.path).replace(/\\/g, '/'),
      sha256: downloaded.sha256,
      bytes: downloaded.bytes,
    }
    task.downloaded_at = now()
    writeManifest(options.stateDir, manifest)
    const inspection = await adapters.provider.inspectArtifact({ output_path: outputPath, pack: clone(pack) })
    if (sha256File(outputPath) !== task.artifact.sha256) fail('REDRAW_EPISODE_ARTIFACT_HASH_MISMATCH')
    task.status = 'completed_verified'
    task.completed_at = now()
    task.verification = publicPathless(inspection)
    manifest.updated_at = task.completed_at
    writeManifest(options.stateDir, manifest)
    atomicJson(path.join(options.stateDir, `${pack.shot_id}-public-evidence.json`), publicPathless(task))
    return publicPathless(task)
  } catch (error) {
    task.status = classifyProviderError(error)
    task.error_code = error?.code || 'REDRAW_EPISODE_PROVIDER_FAILED'
    task.failed_at = now()
    manifest.updated_at = task.failed_at
    writeManifest(options.stateDir, manifest)
    throw error
  }
}

async function runAssemble(options, adapters) {
  assertProvider(adapters.provider, ['assembleEpisode', 'inspectEpisode'])
  const manifest = readManifest(options.stateDir)
  const shotPaths = []
  for (const pack of manifest.production_packs) {
    const task = manifest.tasks.find((item) => item.shot_id === pack.shot_id && item.status === 'completed_verified')
    if (!task?.artifact?.artifact_id) fail('REDRAW_EPISODE_ASSEMBLE_NOT_READY')
    const artifactPath = path.join(options.stateDir, task.artifact.artifact_id)
    if (!sameOrInside(path.join(options.stateDir, 'outputs'), artifactPath)) fail('REDRAW_EPISODE_ARTIFACT_PATH_INVALID')
    if (!fs.existsSync(artifactPath) || sha256File(artifactPath) !== task.artifact.sha256) fail('REDRAW_EPISODE_ARTIFACT_HASH_MISMATCH', pack.shot_id)
    shotPaths.push(artifactPath)
  }
  const outputPath = episodeOutputPath(options.stateDir)
  const assembled = await adapters.provider.assembleEpisode({ shot_paths: shotPaths, output_path: outputPath })
  const inspection = await adapters.provider.inspectEpisode({ output_path: outputPath, manifest: clone(manifest) })
  if (sha256File(outputPath) !== assembled.sha256) fail('REDRAW_EPISODE_ARTIFACT_HASH_MISMATCH', 'episode')
  assertEpisodeInspection(manifest, inspection)
  manifest.status = 'assembled_verified'
  manifest.episode_artifact = {
    artifact_id: path.relative(options.stateDir, assembled.path).replace(/\\/g, '/'),
    sha256: assembled.sha256,
    bytes: assembled.bytes,
  }
  manifest.episode_verification = publicPathless(inspection)
  manifest.updated_at = adapters.now().toISOString()
  writeManifest(options.stateDir, manifest)
  return publicPathless(manifest)
}

async function runVerify(options, adapters) {
  assertProvider(adapters.provider, ['inspectArtifact'])
  const manifest = readManifest(options.stateDir)
  for (const pack of manifest.production_packs) {
    const task = manifest.tasks.find((item) => item.shot_id === pack.shot_id && item.status === 'completed_verified')
    if (!task?.artifact?.artifact_id) fail('REDRAW_EPISODE_VERIFY_NOT_READY', pack.shot_id)
    const artifactPath = path.join(options.stateDir, task.artifact.artifact_id)
    if (!fs.existsSync(artifactPath) || sha256File(artifactPath) !== task.artifact.sha256) fail('REDRAW_EPISODE_ARTIFACT_HASH_MISMATCH', pack.shot_id)
    task.verify_reread = publicPathless(await adapters.provider.inspectArtifact({ output_path: artifactPath, pack: clone(pack) }))
  }
  if (manifest.episode_artifact?.artifact_id) {
    const episodePath = path.join(options.stateDir, manifest.episode_artifact.artifact_id)
    if (!fs.existsSync(episodePath) || sha256File(episodePath) !== manifest.episode_artifact.sha256) fail('REDRAW_EPISODE_ARTIFACT_HASH_MISMATCH', 'episode')
    if (typeof adapters.provider.inspectEpisode === 'function') {
      manifest.episode_verify_reread = publicPathless(await adapters.provider.inspectEpisode({ output_path: episodePath, manifest: clone(manifest) }))
      assertEpisodeInspection(manifest, manifest.episode_verify_reread)
    }
  }
  manifest.verification = { status: 'passed', verified_at: adapters.now().toISOString() }
  manifest.updated_at = manifest.verification.verified_at
  writeManifest(options.stateDir, manifest)
  return publicPathless(manifest)
}

export async function runStage(options, adapters = {}) {
  const local = { now: () => new Date(), provider: null, ...adapters }
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
    if (value == null || String(value).startsWith('--')) fail('REDRAW_EPISODE_RUNNER_ARGUMENT_VALUE_MISSING', flag)
    options[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
    index += 1
  }
  if (!options.episodePackage || !options.stateDir || !options.stage) fail('REDRAW_EPISODE_RUNNER_ARGUMENT_MISSING')
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
    async uploadReference() { fail('REDRAW_EPISODE_PROVIDER_ADAPTER_REQUIRED', `${name} uploadReference`) },
    async submitGeneration() { fail('REDRAW_EPISODE_PROVIDER_ADAPTER_REQUIRED', `${name} submitGeneration`) },
    async pollGeneration() { fail('REDRAW_EPISODE_PROVIDER_ADAPTER_REQUIRED', `${name} pollGeneration`) },
    async downloadResult() { fail('REDRAW_EPISODE_PROVIDER_ADAPTER_REQUIRED', `${name} downloadResult`) },
    async inspectArtifact() { fail('REDRAW_EPISODE_PROVIDER_ADAPTER_REQUIRED', `${name} inspectArtifact`) },
    async assembleEpisode() { fail('REDRAW_EPISODE_PROVIDER_ADAPTER_REQUIRED', `${name} assembleEpisode`) },
    async inspectEpisode() { fail('REDRAW_EPISODE_PROVIDER_ADAPTER_REQUIRED', `${name} inspectEpisode`) },
  }
}

export async function main(argv = process.argv.slice(2), adapters = {}) {
  const options = parseArgs(argv)
  const provider = adapters.provider || createProviderAdapter({ name: adapters.providerName || 'fumin' })
  const result = await runStage(options, { ...adapters, provider })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(String(error?.code || error?.message || 'REDRAW_EPISODE_RUNNER_FAILED'))
    process.exitCode = 1
  })
}
