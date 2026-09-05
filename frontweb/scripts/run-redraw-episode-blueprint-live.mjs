import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MANIFEST_NAME = 'private-manifest.json'
const HEX_64 = /^[a-f0-9]{64}$/i
const ALLOWED_FLAGS = new Set(['episode-package', 'state-dir', 'stage', 'shot-id', 'unit-id'])
const ALLOWED_STAGES = new Set(['preflight', 'shot', 'sequence', 'assemble', 'verify'])
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
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return undefined
  if (Array.isArray(value)) return value.map(publicPathless)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/(?:^|_)(?:bytes|path|url|key|secret|token|credential|password|asset[_-]?id)(?:_|$)/i.test(key))
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

function productionPackBinding(packs) {
  return packs.map((pack) => ({
    shot_id: String(pack.shot_id),
    production_pack_hash: String(pack.production_pack_hash).toLowerCase(),
  }))
}

function canonicalHash(value, omittedKey) {
  const copy = clone(value)
  if (omittedKey) delete copy[omittedKey]
  return sha256Buffer(stableStringify(copy))
}

function defaultExecutionPlan(pkg, providerName) {
  const units = pkg.production_packs.map((pack) => {
    const characterIds = new Set(pack.characters.map((character) => String(character.id)))
    return {
      schema_version: 'redraw-default-execution-unit-v1',
      unit_id: pack.shot_id,
      parent_shot_id: pack.shot_id,
      part_index: 1,
      part_count: 1,
      source_start_ms: pack.start_ms,
      source_end_ms: pack.end_ms,
      keep_duration_ms: pack.duration_ms,
      provider_duration_seconds: pack.duration_ms / 1000,
      parent_production_pack_hash: pack.production_pack_hash,
      dialogue: clone(pack.dialogue),
      identity_reference_ids: pkg.identity_references
        .filter((reference) => !reference.character_id || characterIds.has(String(reference.character_id)))
        .map((reference) => String(reference.id)),
      motion_reference_id: pkg.motion_references.find((reference) => String(reference.shot_id || '') === pack.shot_id)?.id || null,
      prompt: pack.prompt,
    }
  })
  const plan = {
    schema_version: 'redraw-provider-execution-plan-v1',
    provider: String(providerName || 'unspecified'),
    units,
  }
  plan.execution_plan_hash = canonicalHash(plan)
  return plan
}

function unitPathKey(unitId) {
  return String(unitId).replace(/[^a-zA-Z0-9._-]/g, '_')
}

function assertExecutionPathsUnique(units, planned) {
  const relativePaths = units.flatMap((unit) => {
    const key = unitPathKey(unit.unit_id)
    return planned
      ? [`outputs/raw/${key}.mp4`, `outputs/units/${key}.mp4`, `${key}-public-evidence.json`]
      : [`outputs/shots/${key}.mp4`, `${key}-public-evidence.json`]
  })
  if (new Set(relativePaths).size !== relativePaths.length) fail('REDRAW_EPISODE_EXECUTION_PATH_COLLISION')
}

function validateExecutionPlan(value, pkg, providerName, planned = false) {
  const plan = clone(value)
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
    || plan.schema_version !== 'redraw-provider-execution-plan-v1'
    || typeof plan.provider !== 'string' || !plan.provider.trim()
    || (providerName && plan.provider !== providerName)
    || !Array.isArray(plan.units) || plan.units.length < 1) {
    fail('REDRAW_EPISODE_EXECUTION_PLAN_INVALID')
  }
  const expectedPlanHash = canonicalHash(plan, 'execution_plan_hash')
  if (requireHash(plan.execution_plan_hash, 'REDRAW_EPISODE_EXECUTION_PLAN_HASH_INVALID') !== expectedPlanHash) {
    fail('REDRAW_EPISODE_EXECUTION_PLAN_HASH_MISMATCH')
  }
  const packs = new Map(pkg.production_packs.map((pack) => [pack.shot_id, pack]))
  const identities = new Map(pkg.identity_references.map((reference) => [String(reference.id), reference]))
  const motions = new Map(pkg.motion_references.map((reference) => [String(reference.id), reference]))
  const seen = new Set()
  const executionUnits = plan.units.map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('REDRAW_EPISODE_EXECUTION_UNIT_INVALID')
    const unit = clone(input)
    const unitId = String(unit.unit_id || '').trim()
    const parentShotId = String(unit.parent_shot_id || '').trim()
    const pack = packs.get(parentShotId)
    if (typeof unit.schema_version !== 'string' || !unit.schema_version.trim()
      || !unitId || seen.has(unitId)) fail('REDRAW_EPISODE_EXECUTION_UNIT_ID_INVALID', unitId)
    if (planned && (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(unitId)
      || unitId.endsWith('.') || unitId.includes('..'))) {
      fail('REDRAW_EPISODE_EXECUTION_UNIT_ID_INVALID', unitId)
    }
    seen.add(unitId)
    if (!pack || String(unit.parent_production_pack_hash || '').toLowerCase() !== pack.production_pack_hash) {
      fail('REDRAW_EPISODE_EXECUTION_UNIT_PARENT_INVALID', unitId)
    }
    const start = Number(unit.source_start_ms)
    const end = Number(unit.source_end_ms)
    const keep = Number(unit.keep_duration_ms)
    const providerDuration = Number(unit.provider_duration_seconds)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(keep)
      || start < Number(pack.start_ms) || end > Number(pack.end_ms) || end <= start || keep !== end - start
      || !Number.isFinite(providerDuration) || providerDuration <= 0
      || !Number.isSafeInteger(Number(unit.part_index)) || Number(unit.part_index) < 1
      || !Number.isSafeInteger(Number(unit.part_count)) || Number(unit.part_count) < Number(unit.part_index)) {
      fail('REDRAW_EPISODE_EXECUTION_UNIT_TIMING_INVALID', unitId)
    }
    const parentCharacters = new Set(pack.characters.map((character) => String(character.id)))
    const invalidIdentity = (unit.identity_reference_ids || []).some((id) => {
      const reference = identities.get(id)
      return typeof id !== 'string' || !reference
        || (reference.character_id && !parentCharacters.has(String(reference.character_id)))
    })
    const motion = unit.motion_reference_id == null ? null : motions.get(unit.motion_reference_id)
    if (!Array.isArray(unit.dialogue) || typeof unit.prompt !== 'string' || !unit.prompt.trim()
      || !Array.isArray(unit.identity_reference_ids)
      || invalidIdentity
      || (unit.motion_reference_id != null && (typeof unit.motion_reference_id !== 'string' || !motion || String(motion.shot_id || '') !== parentShotId))) {
      fail('REDRAW_EPISODE_EXECUTION_UNIT_REFERENCE_INVALID', unitId)
    }
    const computedUnitHash = canonicalHash(unit, 'unit_hash')
    if (unit.unit_hash != null && requireHash(unit.unit_hash, 'REDRAW_EPISODE_EXECUTION_UNIT_HASH_INVALID') !== computedUnitHash) {
      fail('REDRAW_EPISODE_EXECUTION_UNIT_HASH_MISMATCH', unitId)
    }
    return { ...unit, unit_hash: computedUnitHash }
  })
  assertExecutionPathsUnique(executionUnits, planned)
  return { plan, executionUnits, executionPlanHash: expectedPlanHash }
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
  const actual = sha256File(filePath)
  if (actual !== expected) fail(code, filePath)
  const metadata = { ...clone(item), path: fs.realpathSync(filePath), sha256: expected, size: stat.size }
  delete metadata.bytes
  return metadata
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

function outputPathForUnit(stateDir, unitId, kind) {
  const safeId = unitPathKey(unitId)
  return path.join(stateDir, 'outputs', kind === 'raw' ? 'raw' : 'units', `${safeId}.mp4`)
}

function episodeOutputPath(stateDir) {
  return path.join(stateDir, 'outputs', 'episode', 'episode.mp4')
}

function manifestArtifactPath(stateDir, artifactId, allowedDir) {
  if (typeof artifactId !== 'string' || !artifactId.trim()
    || path.isAbsolute(artifactId)
    || path.win32.isAbsolute(artifactId)
    || path.posix.isAbsolute(artifactId)
    || artifactId.includes(':')
    || artifactId.includes('\\')
    || artifactId.endsWith('/')
    || path.posix.normalize(artifactId) !== artifactId
    || artifactId.split(/[\\/]+/).includes('..')) {
    fail('REDRAW_EPISODE_ARTIFACT_PATH_INVALID', artifactId)
  }
  const stateRoot = path.resolve(stateDir)
  const allowedRoot = path.resolve(allowedDir)
  const artifactPath = path.resolve(stateRoot, artifactId)
  if (!sameOrInside(allowedRoot, artifactPath)) fail('REDRAW_EPISODE_ARTIFACT_PATH_INVALID', artifactId)

  let current = stateRoot
  for (const segment of path.relative(stateRoot, artifactPath).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (!fs.existsSync(current)) break
    if (fs.lstatSync(current).isSymbolicLink()) fail('REDRAW_EPISODE_ARTIFACT_PATH_INVALID', artifactId)
  }
  if (fs.existsSync(artifactPath)) {
    if (!fs.lstatSync(artifactPath).isFile()
      || !sameOrInside(realTargetPath(allowedRoot), fs.realpathSync(artifactPath))) {
      fail('REDRAW_EPISODE_ARTIFACT_PATH_INVALID', artifactId)
    }
  }
  return artifactPath
}

function referencesForShot(pkg, shotId) {
  const pack = pkg.production_packs.find((item) => item.shot_id === shotId)
  const characterIds = new Set((pack?.characters || []).map((character) => String(character.id)))
  return [
    ...pkg.identity_references.filter((item) => !item.character_id || characterIds.has(String(item.character_id))),
    ...pkg.motion_references.filter((item) => String(item.shot_id || '') === String(shotId)),
  ].map((item) => {
    const bytes = fs.readFileSync(item.path)
    if (sha256Buffer(bytes) !== item.sha256) fail('REDRAW_EPISODE_REFERENCE_HASH_CHANGED', item.id || item.path)
    return { ...item, bytes }
  })
}

function referencesForUnit(pkg, unit, legacy) {
  if (legacy) return referencesForShot(pkg, unit.parent_shot_id)
  const identityIds = new Set(unit.identity_reference_ids || [])
  const selected = [
    ...pkg.identity_references.filter((item) => identityIds.has(String(item.id))),
    ...pkg.motion_references.filter((item) => String(item.id) === String(unit.motion_reference_id || '')),
  ]
  return selected.map((item) => {
    const bytes = fs.readFileSync(item.path)
    if (sha256Buffer(bytes) !== item.sha256) fail('REDRAW_EPISODE_REFERENCE_HASH_CHANGED', item.id || item.path)
    return { ...item, bytes }
  })
}

function artifactMetadata(stateDir, result, expectedPath, code = 'REDRAW_EPISODE_ARTIFACT_HASH_MISMATCH') {
  if (!result?.path || path.resolve(result.path) !== path.resolve(expectedPath) || !fs.existsSync(expectedPath)) fail(code)
  const declared = requireHash(result.sha256, code)
  const actual = sha256File(expectedPath)
  if (actual !== declared) fail(code)
  return {
    artifact_id: path.relative(stateDir, expectedPath).replace(/\\/g, '/'),
    sha256: actual,
    size: fs.statSync(expectedPath).size,
  }
}

function assertProvider(provider, methods) {
  for (const method of methods) {
    if (typeof provider?.[method] !== 'function') fail('REDRAW_EPISODE_PROVIDER_ADAPTER_REQUIRED', method)
  }
}

function assertPackageBinding(options, manifest, pkg) {
  const packBinding = productionPackBinding(pkg.production_packs)
  let manifestPackBinding
  try {
    const seen = new Set()
    manifestPackBinding = (manifest.production_packs || [])
      .map((pack) => validatePack(pack, manifest.blueprint_hash, manifest.localization_hash, seen))
    manifestPackBinding = productionPackBinding(manifestPackBinding)
  } catch {
    fail('REDRAW_EPISODE_PACKAGE_STALE', options.episodePackage)
  }
  if (manifest.package_sha256 !== sha256File(pkg.package_path)
    || manifest.blueprint_hash !== pkg.blueprint_hash
    || manifest.localization_hash !== pkg.localization_hash
    || stableStringify(manifest.production_pack_hashes || []) !== stableStringify(packBinding)
    || stableStringify(manifestPackBinding) !== stableStringify(packBinding)) {
    fail('REDRAW_EPISODE_PACKAGE_STALE', options.episodePackage)
  }
}

function assertExecutionBinding(manifest, pkg) {
  if (!manifest.execution_plan || !Array.isArray(manifest.execution_units)) {
    fail('REDRAW_EPISODE_EXECUTION_PLAN_MISSING')
  }
  const validated = validateExecutionPlan(manifest.execution_plan, pkg, manifest.provider, manifest.execution_mode === 'provider-units')
  const expectedMode = validated.plan.units.every((unit) => unit.schema_version === 'redraw-default-execution-unit-v1')
    ? 'legacy-shot'
    : 'provider-units'
  if (manifest.execution_mode !== expectedMode) fail('REDRAW_EPISODE_EXECUTION_PLAN_INVALID')
  if (manifest.execution_plan_hash !== validated.executionPlanHash) {
    fail('REDRAW_EPISODE_EXECUTION_PLAN_HASH_MISMATCH')
  }
  if (stableStringify(manifest.execution_units) !== stableStringify(validated.executionUnits)) {
    fail('REDRAW_EPISODE_EXECUTION_UNIT_HASH_MISMATCH')
  }
  return validated
}

async function prepareExecution(provider, pkg, stateDir) {
  const planned = typeof provider?.prepareEpisode === 'function'
  const plan = planned
    ? await provider.prepareEpisode({ package: clone(pkg), state_dir: stateDir, mode: 'materialize' })
    : defaultExecutionPlan(pkg, provider?.name)
  return { ...validateExecutionPlan(plan, pkg, provider?.name, planned), mode: planned ? 'provider-units' : 'legacy-shot' }
}

async function runPreflight(options, adapters) {
  if (fs.existsSync(path.join(options.stateDir, MANIFEST_NAME))) fail('REDRAW_EPISODE_STATE_ALREADY_EXISTS')
  const pkg = loadEpisodePackage(options.episodePackage, options.stateDir)
  fs.mkdirSync(options.stateDir, { recursive: true })
  const execution = await prepareExecution(adapters.provider, pkg, options.stateDir)
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
    production_pack_hashes: productionPackBinding(pkg.production_packs),
    target: pkg.target,
    source_media: publicPathless(pkg.source_media),
    references: {
      identities: pkg.identity_references.map(publicPathless),
      motion: pkg.motion_references.map(publicPathless),
    },
    production_packs: pkg.production_packs,
    execution_mode: execution.mode,
    execution_plan: execution.plan,
    execution_units: execution.executionUnits,
    execution_plan_hash: execution.executionPlanHash,
    tasks: [],
  }
  writeManifest(options.stateDir, manifest)
  atomicJson(path.join(options.stateDir, 'public-preflight-evidence.json'), publicPathless(manifest))
  return publicPathless(manifest)
}

function classifyProviderError(error) {
  const code = String(error?.code || error?.message || '')
  return /UNKNOWN|TIMEOUT|RESULT_UNKNOWN|STATUS_UNKNOWN|REFERENCE_UPLOAD_UNKNOWN|SUBMISSION_UNKNOWN|DOWNLOAD_UNKNOWN|结果未知/i.test(code) ? 'needs_attention' : 'failed'
}

function classifyFailure(error) {
  if (classifyProviderError(error) === 'needs_attention' || error?.indeterminate === true) return 'indeterminate'
  if (error?.provider_terminal_failure === true) return 'explicit_provider_failure'
  return 'local_or_verification_failure'
}

function sanitizeErrorReason(value) {
  return String(value || '')
    .replace(/\bBearer\s+[^\s"'<>]+/giu, '[redacted]')
    .replace(/(\b(?:api[_-]?key|access[_-]?token|token|secret|credential|password)\b\s*[:=]\s*)[^\s"'<>]+/giu, '$1[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[url-redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 300)
}

function visualReviewStatus(inspection) {
  const status = inspection?.role?.review_status
  return status === 'pending_external_review' || status === 'not_applicable'
    ? status
    : 'not_recorded'
}

function expectedEpisodeDurationSeconds(productionPacks) {
  return productionPacks.reduce((sum, pack) => sum + (Number(pack.duration_ms) / 1000), 0)
}

function assertEpisodeInspection(productionPacks, inspection) {
  const duration = Number(inspection?.media?.duration_seconds ?? inspection?.media?.duration)
  if (Number.isFinite(duration)) {
    const expected = expectedEpisodeDurationSeconds(productionPacks)
    if (Math.abs(duration - expected) > Math.max(1, productionPacks.length * 0.25)) {
      fail('REDRAW_EPISODE_DURATION_MISMATCH', `${duration} !== ${expected}`)
    }
  }
  if (inspection?.media && inspection.media.has_audio === false) {
    fail('REDRAW_EPISODE_AUDIO_MISSING')
  }
}

async function runShot(options, adapters) {
  if (!options.shotId && !options.unitId) fail('REDRAW_EPISODE_SHOT_ID_REQUIRED')
  assertProvider(adapters.provider, ['uploadReference', 'submitGeneration', 'pollGeneration', 'downloadResult', 'inspectArtifact'])
  const pkg = loadEpisodePackage(options.episodePackage, options.stateDir)
  const manifest = readManifest(options.stateDir)
  if (manifest.status !== 'preflight_passed' && manifest.status !== 'in_progress') fail('REDRAW_EPISODE_STATE_NOT_READY')
  assertPackageBinding(options, manifest, pkg)
  assertExecutionBinding(manifest, pkg)
  const legacy = manifest.execution_mode === 'legacy-shot'
  let unit
  if (options.unitId) {
    unit = manifest.execution_units.find((item) => item.unit_id === options.unitId)
    if (!unit) fail('REDRAW_EPISODE_UNIT_NOT_FOUND', options.unitId)
  } else {
    const candidates = manifest.execution_units.filter((item) => item.parent_shot_id === options.shotId)
    if (candidates.length === 0) fail('REDRAW_EPISODE_SHOT_NOT_FOUND', options.shotId)
    if (candidates.length !== 1) fail('REDRAW_EPISODE_UNIT_ID_REQUIRED', options.shotId)
    unit = candidates[0]
  }
  const pack = pkg.production_packs.find((item) => item.shot_id === unit.parent_shot_id)
  const existingTasks = manifest.tasks.filter((item) => item.unit_id === unit.unit_id || (legacy && item.shot_id === pack.shot_id))
  if (existingTasks.length > 0) {
    if (!legacy && existingTasks.some((item) => item.unit_hash !== unit.unit_hash)) fail('REDRAW_EPISODE_TASK_UNIT_HASH_MISMATCH', unit.unit_id)
    if (!legacy && existingTasks.length === 1 && existingTasks[0].status === 'completed_verified') return publicPathless(existingTasks[0])
    fail(legacy ? 'REDRAW_EPISODE_SHOT_ALREADY_SUBMITTED' : 'REDRAW_EPISODE_UNIT_ALREADY_SUBMITTED', unit.unit_id)
  }
  const now = () => adapters.now().toISOString()
  const task = {
    shot_id: pack.shot_id,
    unit_id: unit.unit_id,
    unit_hash: unit.unit_hash,
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
    for (const reference of referencesForUnit(pkg, unit, legacy)) {
      const uploaded = await adapters.provider.uploadReference({ ...reference, unit: clone(unit) })
      const uploadedMetadata = clone(uploaded)
      if (uploadedMetadata && typeof uploadedMetadata === 'object' && !Array.isArray(uploadedMetadata)) {
        if (Number.isSafeInteger(uploadedMetadata.bytes) && uploadedMetadata.bytes >= 0 && uploadedMetadata.size == null) {
          uploadedMetadata.size = uploadedMetadata.bytes
        }
        delete uploadedMetadata.bytes
      }
      task.uploaded_references.push(uploadedMetadata)
      manifest.updated_at = now()
      writeManifest(options.stateDir, manifest)
    }
    task.status = 'submission_started'
    task.submission_started_at = now()
    writeManifest(options.stateDir, manifest)
    const providerPack = legacy ? clone(pack) : clone(unit)
    const submitted = await adapters.provider.submitGeneration({
      pack: providerPack,
      unit: clone(unit),
      parent_pack: clone(pack),
      uploaded_references: task.uploaded_references.map(clone),
    })
    if (!submitted?.task_id) fail('REDRAW_EPISODE_SUBMISSION_UNKNOWN')
    task.status = 'provider_processing'
    task.task_id = String(submitted.task_id)
    task.submitted_at = now()
    writeManifest(options.stateDir, manifest)
    const polled = await adapters.provider.pollGeneration({ task_id: task.task_id, pack: providerPack, unit: clone(unit), parent_pack: clone(pack) })
    task.status = 'result_downloading'
    task.polled_at = now()
    writeManifest(options.stateDir, manifest)
    const rawPath = legacy ? outputPathForShot(options.stateDir, pack.shot_id) : outputPathForUnit(options.stateDir, unit.unit_id, 'raw')
    const downloaded = await adapters.provider.downloadResult({ video_url: polled.video_url, output_path: rawPath, pack: providerPack, unit: clone(unit), parent_pack: clone(pack) })
    task.status = 'artifact_downloaded'
    task.raw_artifact = artifactMetadata(options.stateDir, downloaded, rawPath)
    task.artifact = clone(task.raw_artifact)
    task.downloaded_at = now()
    writeManifest(options.stateDir, manifest)
    const inspection = await adapters.provider.inspectArtifact({ output_path: rawPath, pack: providerPack, unit: clone(unit), parent_pack: clone(pack) })
    if (sha256File(rawPath) !== task.raw_artifact.sha256) fail('REDRAW_EPISODE_ARTIFACT_HASH_MISMATCH')
    task.raw_verification = publicPathless(inspection)
    let finalInspection = inspection
    if (typeof adapters.provider.finalizeArtifact === 'function') {
      task.status = 'artifact_finalization_started'
      task.finalization_started_at = now()
      writeManifest(options.stateDir, manifest)
      const finalPath = outputPathForUnit(options.stateDir, unit.unit_id, 'final')
      const finalized = await adapters.provider.finalizeArtifact({
        raw_path: rawPath,
        output_path: finalPath,
        pack: providerPack,
        unit: clone(unit),
        parent_pack: clone(pack),
        raw_verification: clone(task.raw_verification),
      })
      task.artifact = artifactMetadata(options.stateDir, finalized, finalPath)
      task.status = 'final_artifact_inspection_started'
      task.finalized_at = now()
      writeManifest(options.stateDir, manifest)
      finalInspection = await adapters.provider.inspectArtifact({
        output_path: finalPath,
        pack: providerPack,
        unit: clone(unit),
        parent_pack: clone(pack),
      })
      if (sha256File(finalPath) !== task.artifact.sha256) fail('REDRAW_EPISODE_ARTIFACT_HASH_MISMATCH')
    }
    task.status = 'completed_verified'
    task.completed_at = now()
    task.verification = publicPathless(finalInspection)
    task.visual_review_status = visualReviewStatus(finalInspection)
    manifest.updated_at = task.completed_at
    writeManifest(options.stateDir, manifest)
  } catch (error) {
    task.status = classifyProviderError(error)
    task.error_code = error?.code || 'REDRAW_EPISODE_PROVIDER_FAILED'
    task.failure_class = classifyFailure(error)
    task.error_reason = sanitizeErrorReason(error?.provider_reason || error?.message || task.error_code)
    task.failed_at = now()
    manifest.updated_at = task.failed_at
    writeManifest(options.stateDir, manifest)
    throw error
  }
  const evidenceId = legacy ? pack.shot_id : unit.unit_id
  try {
    atomicJson(path.join(options.stateDir, `${unitPathKey(evidenceId)}-public-evidence.json`), publicPathless(task))
  } catch (error) {
    const at = now()
    task.public_evidence_error = {
      code: String(error?.code || 'REDRAW_EPISODE_PUBLIC_EVIDENCE_WRITE_FAILED'),
      message: String(error?.message || error),
      at,
    }
    manifest.updated_at = at
    writeManifest(options.stateDir, manifest)
    throw codedError('REDRAW_EPISODE_PUBLIC_EVIDENCE_WRITE_FAILED', task.public_evidence_error.message)
  }
  return publicPathless(task)
}

async function runSequence(options, adapters) {
  const pkg = loadEpisodePackage(options.episodePackage, options.stateDir)
  const manifest = readManifest(options.stateDir)
  if (manifest.status !== 'preflight_passed' && manifest.status !== 'in_progress') fail('REDRAW_EPISODE_STATE_NOT_READY')
  assertPackageBinding(options, manifest, pkg)
  assertExecutionBinding(manifest, pkg)
  for (const unit of manifest.execution_units) {
    const existing = manifest.tasks.filter((task) => task.unit_id === unit.unit_id)
    if (existing.some((task) => task.unit_hash !== unit.unit_hash)) {
      fail('REDRAW_EPISODE_TASK_UNIT_HASH_MISMATCH', unit.unit_id)
    }
    if (existing.length === 1 && existing[0].status === 'completed_verified') continue
    if (existing.length > 0) fail('REDRAW_EPISODE_UNIT_ALREADY_SUBMITTED', unit.unit_id)
    await runShot({ ...options, shotId: undefined, unitId: unit.unit_id }, adapters)
  }
  return publicPathless(readManifest(options.stateDir))
}

async function runAssemble(options, adapters) {
  assertProvider(adapters.provider, ['assembleEpisode', 'inspectEpisode'])
  const pkg = loadEpisodePackage(options.episodePackage, options.stateDir)
  const manifest = readManifest(options.stateDir)
  assertPackageBinding(options, manifest, pkg)
  assertExecutionBinding(manifest, pkg)
  const planned = manifest.execution_mode === 'provider-units'
  const ordered = planned ? manifest.execution_units : pkg.production_packs
  const artifactPaths = []
  for (const item of ordered) {
    const task = planned
      ? manifest.tasks.find((entry) => entry.unit_id === item.unit_id && entry.status === 'completed_verified')
      : manifest.tasks.find((entry) => entry.shot_id === item.shot_id && entry.status === 'completed_verified')
    if (!task?.artifact?.artifact_id) fail('REDRAW_EPISODE_ASSEMBLE_NOT_READY')
    if (planned && task.unit_hash !== item.unit_hash) fail('REDRAW_EPISODE_TASK_UNIT_HASH_MISMATCH', item.unit_id)
    const artifactPath = manifestArtifactPath(options.stateDir, task.artifact.artifact_id, path.join(options.stateDir, 'outputs'))
    if (!fs.existsSync(artifactPath) || sha256File(artifactPath) !== task.artifact.sha256) fail('REDRAW_EPISODE_ARTIFACT_HASH_MISMATCH', item.unit_id || item.shot_id)
    artifactPaths.push(artifactPath)
  }
  const outputPath = episodeOutputPath(options.stateDir)
  manifest.status = 'assembly_started'
  manifest.updated_at = adapters.now().toISOString()
  writeManifest(options.stateDir, manifest)
  const assembleInput = planned
    ? { unit_paths: artifactPaths, output_path: outputPath, execution_plan: clone(manifest.execution_plan) }
    : { shot_paths: artifactPaths, output_path: outputPath }
  const assembled = await adapters.provider.assembleEpisode(assembleInput)
  const trustedManifest = { ...clone(manifest), production_packs: clone(pkg.production_packs) }
  const inspection = await adapters.provider.inspectEpisode({ output_path: outputPath, manifest: trustedManifest })
  if (sha256File(outputPath) !== assembled.sha256) fail('REDRAW_EPISODE_ARTIFACT_HASH_MISMATCH', 'episode')
  assertEpisodeInspection(pkg.production_packs, inspection)
  manifest.status = 'assembled_verified'
  manifest.episode_artifact = {
    artifact_id: path.relative(options.stateDir, assembled.path).replace(/\\/g, '/'),
    sha256: assembled.sha256,
    size: fs.statSync(outputPath).size,
  }
  manifest.episode_verification = publicPathless(inspection)
  manifest.updated_at = adapters.now().toISOString()
  writeManifest(options.stateDir, manifest)
  return publicPathless(manifest)
}

async function runVerify(options, adapters) {
  assertProvider(adapters.provider, ['inspectArtifact'])
  const pkg = loadEpisodePackage(options.episodePackage, options.stateDir)
  const manifest = readManifest(options.stateDir)
  assertPackageBinding(options, manifest, pkg)
  assertExecutionBinding(manifest, pkg)
  const planned = manifest.execution_mode === 'provider-units'
  const ordered = planned ? manifest.execution_units : pkg.production_packs
  for (const item of ordered) {
    const task = planned
      ? manifest.tasks.find((entry) => entry.unit_id === item.unit_id && entry.status === 'completed_verified')
      : manifest.tasks.find((entry) => entry.shot_id === item.shot_id && entry.status === 'completed_verified')
    if (!task?.artifact?.artifact_id) fail('REDRAW_EPISODE_VERIFY_NOT_READY', item.unit_id || item.shot_id)
    if (planned && task.unit_hash !== item.unit_hash) fail('REDRAW_EPISODE_TASK_UNIT_HASH_MISMATCH', item.unit_id)
    const artifactPath = manifestArtifactPath(options.stateDir, task.artifact.artifact_id, path.join(options.stateDir, 'outputs'))
    if (!fs.existsSync(artifactPath) || sha256File(artifactPath) !== task.artifact.sha256) fail('REDRAW_EPISODE_ARTIFACT_HASH_MISMATCH', item.unit_id || item.shot_id)
    task.verify_reread = publicPathless(await adapters.provider.inspectArtifact({
      output_path: artifactPath,
      pack: clone(item),
      unit: planned ? clone(item) : undefined,
      parent_pack: planned ? clone(pkg.production_packs.find((pack) => pack.shot_id === item.parent_shot_id)) : undefined,
    }))
    task.visual_review_status = visualReviewStatus(task.verify_reread)
  }
  if (manifest.episode_artifact?.artifact_id) {
    const episodePath = manifestArtifactPath(options.stateDir, manifest.episode_artifact.artifact_id, path.dirname(episodeOutputPath(options.stateDir)))
    if (!fs.existsSync(episodePath) || sha256File(episodePath) !== manifest.episode_artifact.sha256) fail('REDRAW_EPISODE_ARTIFACT_HASH_MISMATCH', 'episode')
    if (typeof adapters.provider.inspectEpisode === 'function') {
      const trustedManifest = { ...clone(manifest), production_packs: clone(pkg.production_packs) }
      manifest.episode_verify_reread = publicPathless(await adapters.provider.inspectEpisode({ output_path: episodePath, manifest: trustedManifest }))
      assertEpisodeInspection(pkg.production_packs, manifest.episode_verify_reread)
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
  if (options.stage === 'sequence') return runSequence(options, local)
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
  if (options.stage === 'shot' && !options.shotId && !options.unitId) fail('REDRAW_EPISODE_SHOT_ID_REQUIRED')
  if (options.stage === 'shot' && options.shotId && options.unitId) fail('REDRAW_EPISODE_SHOT_UNIT_AMBIGUOUS')
  if (options.stage !== 'shot' && (options.shotId || options.unitId)) fail('REDRAW_EPISODE_RUNNER_ARGUMENT_INVALID')
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
