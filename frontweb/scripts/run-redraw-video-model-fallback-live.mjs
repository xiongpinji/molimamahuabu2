import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createEpisodeVideoProviderAdapter } from './episodeVideoProviderAdapter.mjs'
import { EPISODE_VIDEO_ROUTES } from './episodeVideoRouteRegistry.mjs'
import {
  loadEpisodePackage,
  runStage,
} from './run-redraw-episode-blueprint-live.mjs'

const MANIFEST_NAME = 'fallback-manifest.json'
const PUBLIC_EVIDENCE_NAME = 'public-fallback-evidence.json'
const MAX_GENERATION_SUBMISSIONS = 31
const EXPECTED_UNIT_COUNT = 28
const GATE_UNIT_ID = 'shot-01.part-01'
const HEX_40 = /^[a-f0-9]{40}$/iu
const EXECUTION_LOCK_NAME = '.fallback-execution.lock'
const ALLOWED_FLAGS = new Set([
  'episode-package',
  'state-dir',
  'source-head',
  'fumin-key-file',
  'toapis-key-file',
  'feituo-key-file',
])

function codedError(code, detail = code) {
  const error = new Error(`${code}: ${detail}`)
  error.code = code
  return error
}

function fail(code, detail) {
  throw codedError(code, detail)
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  fs.renameSync(temporary, filePath)
}

function sanitizedReason(value) {
  return String(value || '')
    .replace(/\bBearer\s+[^\s"'<>]+/giu, '[redacted]')
    .replace(/(\b(?:api[_-]?key|access[_-]?token|token|secret|credential|password)\b\s*[:=]\s*)[^\s"'<>]+/giu, '$1[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[url-redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 300)
}

function publicManifest(manifest) {
  const { stop_reason: _reason, gate_review: review, ...evidence } = manifest
  return {
    ...evidence,
    ...(review ? { gate_review: { status: review.status, binding: review.binding, reviewed_at: review.reviewed_at } } : {}),
    routes: manifest.routes.map(({ child_state_dir: _path, error_reason: _errorReason, error_code: _errorCode, ...route }) => route),
  }
}

function routeKeysAvailable(route, keys) {
  return Boolean(String(keys?.[route.key_id] || '').trim())
    && (!route.requires_reference_transport || Boolean(String(keys?.fumin || '').trim()))
}

function actualHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  }).trim()
}

function failureClass(error, childDir) {
  if (error?.indeterminate === true || /UNKNOWN|TIMEOUT|NEEDS_ATTENTION/iu.test(String(error?.code || ''))) {
    return 'indeterminate'
  }
  const manifestPath = path.join(childDir, 'private-manifest.json')
  if (fs.existsSync(manifestPath)) {
    try {
      const child = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      const recorded = child.tasks?.at(-1)?.failure_class
      if (['indeterminate', 'explicit_provider_failure', 'local_or_verification_failure'].includes(recorded)) return recorded
    } catch {}
  }
  if (error?.provider_terminal_failure === true) return 'explicit_provider_failure'
  return 'local_or_verification_failure'
}

function requireNewStateDir(stateDir) {
  if (!path.isAbsolute(stateDir)) fail('REDRAW_EPISODE_FALLBACK_STATE_PATH_INVALID', stateDir)
  if (!fs.existsSync(stateDir)) return
  fail('REDRAW_EPISODE_FALLBACK_STATE_EXISTS', stateDir)
}

function childOptions(options, childDir, stage, unitId) {
  return {
    episodePackage: options.episodePackage,
    stateDir: childDir,
    stage,
    ...(unitId ? { unitId } : {}),
  }
}

function aggregateVisualReviewStatus(verified) {
  const statuses = Array.isArray(verified?.tasks)
    ? verified.tasks.flatMap((task) => {
      const recorded = [task?.visual_review_status, task?.verify_reread?.role?.review_status, task?.verification?.role?.review_status].filter(Boolean)
      return recorded.length > 0 ? recorded : ['not_recorded']
    })
    : []
  if (statuses.includes('pending_external_review')) return 'pending_external_review'
  if (statuses.length > 0 && statuses.every((status) => status === 'not_applicable')) return 'not_required'
  return 'not_recorded'
}

function validateOptions(options, dependencies) {
  const sourceHead = String(options?.sourceHead || '').trim().toLowerCase()
  const currentHead = String((dependencies.currentHead || actualHead)()).trim().toLowerCase()
  if (!HEX_40.test(sourceHead)) fail('REDRAW_EPISODE_SOURCE_HEAD_INVALID', sourceHead)
  if (sourceHead !== currentHead) fail('REDRAW_EPISODE_SOURCE_HEAD_MISMATCH', `${sourceHead} != ${currentHead}`)
  if (!path.isAbsolute(String(options?.episodePackage || ''))) fail('REDRAW_EPISODE_PACKAGE_PATH_INVALID')
  if (!path.isAbsolute(String(options?.stateDir || ''))) fail('REDRAW_EPISODE_FALLBACK_STATE_PATH_INVALID')
  return sourceHead
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function canonicalHash(value, omittedKey) {
  const copy = { ...value }
  delete copy[omittedKey]
  return crypto.createHash('sha256').update(stableStringify(copy)).digest('hex')
}

function assertNoSymlink(target) {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('REDRAW_EPISODE_GATE_REVIEW_BINDING_MISMATCH')
    if (current === path.dirname(current)) break
  }
}

async function withExecutionLock(options, dependencies, create, action) {
  validateOptions(options, dependencies)
  assertNoSymlink(options.stateDir)
  if (create) {
    requireNewStateDir(options.stateDir)
    fs.mkdirSync(path.dirname(options.stateDir), { recursive: true })
    try { fs.mkdirSync(options.stateDir) } catch (error) {
      if (error.code === 'EEXIST') fail('REDRAW_EPISODE_FALLBACK_STATE_EXISTS')
      throw error
    }
  }
  const lockPath = path.join(options.stateDir, EXECUTION_LOCK_NAME)
  let lock
  try { lock = fs.openSync(lockPath, 'wx') } catch (error) {
    if (error.code === 'EEXIST') fail('REDRAW_EPISODE_FALLBACK_EXECUTION_LOCKED')
    throw error
  }
  try { return await action() } finally {
    fs.closeSync(lock)
    fs.unlinkSync(lockPath)
  }
}

function persistManifest(stateDir, manifest, dependencies) {
  manifest.updated_at = (dependencies.now || (() => new Date()))().toISOString()
  atomicJson(path.join(stateDir, MANIFEST_NAME), manifest)
  atomicJson(path.join(stateDir, PUBLIC_EVIDENCE_NAME), publicManifest(manifest))
}

function readReviewState(options) {
  const manifest = JSON.parse(fs.readFileSync(path.join(options.stateDir, MANIFEST_NAME), 'utf8'))
  if (manifest.status !== 'waiting_first_shot_review' || !manifest.run_id) fail('REDRAW_EPISODE_GATE_REVIEW_STATE_INVALID')
  return manifest
}

// Bind approval to the actual persisted task and bytes, never just the shot return value.
function gateBinding(options, manifest) {
  try {
    const route = manifest.routes.find((item) => item.id === manifest.winner_route_id)
    if (!route || !/^[a-z0-9][a-z0-9.-]*$/u.test(route.id)
      || route.child_state_dir !== path.join('routes', route.id)) throw new Error()
    const childDir = path.join(options.stateDir, route.child_state_dir)
    const childPath = path.join(childDir, 'private-manifest.json')
    assertNoSymlink(childPath)
    const child = JSON.parse(fs.readFileSync(childPath, 'utf8'))
    const unit = child.execution_units?.[0]
    const task = child.tasks?.[0]
    if (manifest.source_head !== String(options.sourceHead).toLowerCase()
      || manifest.package_sha256 !== sha256File(options.episodePackage)
      || child.package_sha256 !== manifest.package_sha256 || route.package_sha256 !== manifest.package_sha256
      || child.provider !== route.id || child.status !== 'in_progress'
      || child.execution_plan_hash !== route.execution_plan_hash
      || child.execution_plan_hash !== canonicalHash(child.execution_plan, 'execution_plan_hash')
      || child.execution_plan.execution_plan_hash !== child.execution_plan_hash
      || child.execution_units?.length !== EXPECTED_UNIT_COUNT
      || stableStringify(child.execution_units) !== stableStringify(child.execution_plan.units.map((item) => ({ ...item, unit_hash: canonicalHash(item, 'unit_hash') })))
      || unit.unit_id !== GATE_UNIT_ID || child.tasks?.length !== 1
      || task.unit_id !== GATE_UNIT_ID || task.unit_hash !== unit.unit_hash
      || task.status !== 'completed_verified' || task.verification?.role?.passed === false
      || ['rejected', 'failed'].includes(task.visual_review_status)
      || route.generation_submissions !== 1
      || manifest.generation_attempts.filter((attempt) => attempt.route_id === route.id).length !== 1
      || manifest.generation_attempts.find((attempt) => attempt.route_id === route.id)?.unit_id !== GATE_UNIT_ID) throw new Error()
    const artifactId = task.artifact?.artifact_id
    if (![`outputs/units/${GATE_UNIT_ID}.mp4`, `outputs/raw/${GATE_UNIT_ID}.mp4`].includes(artifactId)) throw new Error()
    const artifactPath = path.join(childDir, artifactId)
    assertNoSymlink(artifactPath)
    if (!fs.lstatSync(artifactPath).isFile() || sha256File(artifactPath) !== task.artifact.sha256) throw new Error()
    return {
      run_id: manifest.run_id,
      route_id: route.id,
      source_head: manifest.source_head,
      package_sha256: manifest.package_sha256,
      execution_plan_hash: child.execution_plan_hash,
      unit_id: GATE_UNIT_ID,
      unit_hash: task.unit_hash,
      artifact_id: artifactId,
      artifact_sha256: task.artifact.sha256,
    }
  } catch {
    fail('REDRAW_EPISODE_GATE_REVIEW_BINDING_MISMATCH')
  }
}

function assertReviewBinding(options, manifest) {
  const binding = gateBinding(options, manifest)
  if (stableStringify(binding) !== stableStringify(manifest.gate_review?.binding)) fail('REDRAW_EPISODE_GATE_REVIEW_BINDING_MISMATCH')
  return binding
}

function createRouteProvider(options, dependencies, manifest, route, routeRecord, persist) {
  const beforeGenerationSubmit = async ({ route_id: routeId, unit_id: unitId, model }) => {
    if (routeId !== route.id || model !== route.model) fail('REDRAW_EPISODE_FALLBACK_ROUTE_BINDING_MISMATCH')
    if (manifest.winner_route_id == null) {
      if (unitId !== GATE_UNIT_ID || routeRecord.generation_submissions !== 0) fail('REDRAW_EPISODE_FALLBACK_GATE_VIOLATION')
    } else if (manifest.winner_route_id !== route.id) {
      fail('REDRAW_EPISODE_FALLBACK_MODEL_MIXED')
    } else if (manifest.gate_review?.status !== 'approved' || manifest.status !== 'sequence_running') {
      fail('REDRAW_EPISODE_GATE_REVIEW_REQUIRED')
    }
    if (manifest.generation_attempts.length >= MAX_GENERATION_SUBMISSIONS) fail('REDRAW_EPISODE_FALLBACK_SUBMISSION_LIMIT')
    if (manifest.generation_attempts.some((attempt) => attempt.route_id === route.id && attempt.unit_id === unitId)) {
      fail('REDRAW_EPISODE_FALLBACK_DUPLICATE_SUBMISSION')
    }
    manifest.generation_attempts.push({ route_id: route.id, provider: route.provider, model: route.model, unit_id: unitId, started_at: (dependencies.now || (() => new Date()))().toISOString() })
    routeRecord.generation_submissions += 1
    persist()
  }
  const createProvider = dependencies.createProvider || ((providerOptions) => createEpisodeVideoProviderAdapter({ ...dependencies.providerOptions, ...providerOptions }))
  return createProvider({ route, providerApiKey: String(options.keys[route.key_id] || '').trim(), referenceApiKey: String(options.keys.fumin || '').trim(), beforeGenerationSubmit })
}

export async function runFallbackEpisode(options, dependencies = {}) {
  return withExecutionLock(options, dependencies, true, () => runFallbackEpisodeUnlocked(options, dependencies))
}

async function runFallbackEpisodeUnlocked(options, dependencies) {
  const sourceHead = validateOptions(options, dependencies)
  const episodePackage = path.resolve(String(options.episodePackage))
  const stateDir = path.resolve(String(options.stateDir))
  const load = dependencies.loadEpisodePackage || loadEpisodePackage
  const pkg = load(episodePackage, stateDir)
  const now = dependencies.now || (() => new Date())
  const routes = dependencies.routes || EPISODE_VIDEO_ROUTES
  const executeStage = dependencies.runStage || runStage
  const createdAt = now().toISOString()
  const manifest = {
    schema_version: 'redraw-isolated-video-model-fallback-state-v1',
    run_id: crypto.randomUUID(),
    status: 'preflight',
    source_head: sourceHead,
    created_at: createdAt,
    updated_at: createdAt,
    package_sha256: sha256File(pkg.package_path || episodePackage),
    blueprint_hash: pkg.blueprint_hash,
    localization_hash: pkg.localization_hash,
    expected_unit_count: EXPECTED_UNIT_COUNT,
    gate_unit_id: GATE_UNIT_ID,
    max_generation_submissions: MAX_GENERATION_SUBMISSIONS,
    winner_route_id: null,
    generation_attempts: [],
    routes: routes.map((route) => ({
      id: route.id,
      provider: route.provider,
      model: route.model,
      status: 'pending',
      generation_submissions: 0,
      child_state_dir: path.join('routes', route.id),
    })),
    episode_artifact: null,
  }
  fs.mkdirSync(stateDir, { recursive: true })
  const manifestPath = path.join(stateDir, MANIFEST_NAME)
  const publicPath = path.join(stateDir, PUBLIC_EVIDENCE_NAME)
  const persist = () => {
    manifest.updated_at = now().toISOString()
    atomicJson(manifestPath, manifest)
    atomicJson(publicPath, publicManifest(manifest))
  }
  persist()

  const stop = (error, status, routeRecord, reason) => {
    manifest.status = status
    manifest.stop_reason = sanitizedReason(reason || error?.provider_reason || error?.message || error?.code)
    if (routeRecord) {
      routeRecord.status = status
      routeRecord.failure_class = status === 'needs_attention' ? 'indeterminate' : 'local_or_verification_failure'
      routeRecord.error_code = String(error?.code || 'REDRAW_EPISODE_FALLBACK_FAILED')
      routeRecord.error_reason = manifest.stop_reason
    }
    persist()
    throw error
  }

  let availableRouteCount = 0
  for (const route of routes) {
    const routeRecord = manifest.routes.find((item) => item.id === route.id)
    if (!routeKeysAvailable(route, options.keys || {})) {
      routeRecord.status = 'skipped_missing_key'
      persist()
      continue
    }
    availableRouteCount += 1
    const childDir = path.join(stateDir, routeRecord.child_state_dir)
    const provider = createRouteProvider(options, dependencies, manifest, route, routeRecord, persist)
    routeRecord.status = 'preflight'
    persist()
    let preflight
    try {
      preflight = await executeStage(childOptions(options, childDir, 'preflight'), { provider })
    } catch (error) {
      stop(error, 'failed', routeRecord)
    }
    const executionUnits = preflight?.execution_units
    if (!Array.isArray(executionUnits) || executionUnits.length !== EXPECTED_UNIT_COUNT
      || executionUnits[0]?.unit_id !== GATE_UNIT_ID) {
      stop(
        codedError('REDRAW_EPISODE_FALLBACK_EXECUTION_PLAN_INVALID'),
        'failed',
        routeRecord,
        'execution plan must contain 28 units and start with shot-01.part-01',
      )
    }
    routeRecord.execution_plan_hash = preflight.execution_plan_hash
    routeRecord.package_sha256 = preflight.package_sha256
    routeRecord.status = 'gate_running'
    persist()
    try {
      await executeStage(childOptions(options, childDir, 'shot', GATE_UNIT_ID), { provider })
    } catch (error) {
      const classification = failureClass(error, childDir)
      routeRecord.failure_class = classification
      routeRecord.error_code = String(error?.code || 'REDRAW_EPISODE_FALLBACK_GATE_FAILED')
      routeRecord.error_reason = sanitizedReason(error?.provider_reason || error?.message || routeRecord.error_code)
      if (classification === 'explicit_provider_failure') {
        routeRecord.status = 'explicit_provider_failure'
        persist()
        continue
      }
      stop(error, classification === 'indeterminate' ? 'needs_attention' : 'failed', routeRecord)
    }

    manifest.winner_route_id = route.id
    try {
      manifest.gate_review = { status: 'pending_external_review', binding: gateBinding(options, manifest) }
      manifest.visual_review_status = 'pending_external_review'
      manifest.status = 'waiting_first_shot_review'
      routeRecord.status = 'waiting_first_shot_review'
      persist()
      return publicManifest(manifest)
    } catch (error) {
      const classification = failureClass(error, childDir)
      stop(error, classification === 'indeterminate' ? 'needs_attention' : 'failed', routeRecord)
    }
  }

  const error = codedError(
    availableRouteCount === 0 ? 'REDRAW_EPISODE_NO_PROVIDER_KEY' : 'REDRAW_EPISODE_NO_PROVIDER_PASSED',
  )
  manifest.status = 'failed'
  manifest.stop_reason = error.code
  persist()
  throw error
}

// Product/server callers supply an explicit human decision; no CLI flag can approve.
export async function recordFallbackGateReview(options, review, dependencies = {}) {
  return withExecutionLock(options, dependencies, false, async () => {
    const manifest = readReviewState(options)
    if (manifest.gate_review?.status !== 'pending_external_review') fail('REDRAW_EPISODE_GATE_REVIEW_STATE_INVALID')
    const binding = assertReviewBinding(options, manifest)
    if (stableStringify(review?.binding) !== stableStringify(binding)) fail('REDRAW_EPISODE_GATE_REVIEW_BINDING_MISMATCH')
    if (!['approved', 'rejected'].includes(review?.decision) || typeof review?.reviewer !== 'string' || !review.reviewer.trim()) {
      fail('REDRAW_EPISODE_GATE_REVIEW_INVALID')
    }
    manifest.gate_review = { binding, status: review.decision, reviewer: review.reviewer.trim(), reviewed_at: (dependencies.now || (() => new Date()))().toISOString() }
    if (review.decision === 'rejected') {
      manifest.status = 'first_shot_review_rejected'
      manifest.routes.find((route) => route.id === manifest.winner_route_id).status = manifest.status
    }
    persistManifest(options.stateDir, manifest, dependencies)
    return publicManifest(manifest)
  })
}

export async function resumeFallbackEpisode(options, dependencies = {}) {
  return withExecutionLock(options, dependencies, false, async () => {
    const manifest = readReviewState(options)
    if (manifest.gate_review?.status !== 'approved') fail('REDRAW_EPISODE_GATE_REVIEW_REQUIRED')
    assertReviewBinding(options, manifest)
    const route = (dependencies.routes || EPISODE_VIDEO_ROUTES).find((item) => item.id === manifest.winner_route_id)
    const routeRecord = manifest.routes.find((item) => item.id === manifest.winner_route_id)
    if (!route || route.model !== routeRecord.model || route.provider !== routeRecord.provider) fail('REDRAW_EPISODE_FALLBACK_ROUTE_BINDING_MISMATCH')
    if (!routeKeysAvailable(route, options.keys || {})) fail('REDRAW_EPISODE_NO_PROVIDER_KEY')
    const persist = () => persistManifest(options.stateDir, manifest, dependencies)
    const provider = createRouteProvider(options, dependencies, manifest, route, routeRecord, persist)
    const executeStage = dependencies.runStage || runStage
    const childDir = path.join(options.stateDir, routeRecord.child_state_dir)
    manifest.status = 'sequence_running'
    routeRecord.status = 'sequence_running'
    persist()
    try {
      await executeStage(childOptions(options, childDir, 'sequence'), { provider })
      await executeStage(childOptions(options, childDir, 'assemble'), { provider })
      const verified = await executeStage(childOptions(options, childDir, 'verify'), { provider })
      if (!verified?.episode_artifact?.sha256) fail('REDRAW_EPISODE_FALLBACK_EPISODE_ARTIFACT_MISSING')
      manifest.episode_artifact = { route_id: route.id, artifact_id: verified.episode_artifact.artifact_id, sha256: verified.episode_artifact.sha256 }
      manifest.visual_review_status = aggregateVisualReviewStatus(verified)
      manifest.status = manifest.visual_review_status === 'not_required' ? 'completed_verified' : 'technical_verified_pending_visual_review'
      routeRecord.status = manifest.status
      persist()
      return publicManifest(manifest)
    } catch (error) {
      const classification = failureClass(error, childDir)
      manifest.status = classification === 'indeterminate' ? 'needs_attention' : 'failed'
      routeRecord.status = manifest.status
      routeRecord.failure_class = classification
      persist()
      throw error
    }
  })
}

function readKeyFile(filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) return ''
  const raw = fs.readFileSync(filePath, 'utf8').trim()
  const prefixed = raw.match(/\b(?:sk|fk|tk)-[A-Za-z0-9._~-]+\b/u)?.[0]
  if (prefixed) return prefixed
  const quoted = raw.match(/["']([^"'\r\n]{8,})["']/u)?.[1]
  if (quoted) return quoted.trim()
  return /^\S{8,}$/u.test(raw) ? raw : ''
}

export function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = String(argv[index])
    if (!flag.startsWith('--')) fail('REDRAW_EPISODE_FALLBACK_ARGUMENT_INVALID', flag)
    const key = flag.slice(2)
    if (!ALLOWED_FLAGS.has(key)) fail('REDRAW_EPISODE_FALLBACK_ARGUMENT_UNKNOWN', flag)
    const value = argv[index + 1]
    if (value == null || String(value).startsWith('--')) fail('REDRAW_EPISODE_FALLBACK_ARGUMENT_VALUE_MISSING', flag)
    options[key.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = String(value)
    index += 1
  }
  if (!options.episodePackage || !options.stateDir || !options.sourceHead) {
    fail('REDRAW_EPISODE_FALLBACK_ARGUMENT_MISSING')
  }
  options.episodePackage = path.resolve(options.episodePackage)
  options.stateDir = path.resolve(options.stateDir)
  options.keys = {
    fumin: options.fuminKeyFile ? readKeyFile(path.resolve(options.fuminKeyFile)) : String(process.env.FUMIN_API_KEY || '').trim(),
    toapis: options.toapisKeyFile ? readKeyFile(path.resolve(options.toapisKeyFile)) : String(process.env.TOAPIS_API_KEY || '').trim(),
    feituo: options.feituoKeyFile ? readKeyFile(path.resolve(options.feituoKeyFile)) : String(process.env.FEITUO_API_KEY || '').trim(),
  }
  return options
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const result = await runFallbackEpisode(parseArgs(argv), dependencies)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('REDRAW_EPISODE_FALLBACK_FAILED')
    process.exitCode = 1
  })
}
