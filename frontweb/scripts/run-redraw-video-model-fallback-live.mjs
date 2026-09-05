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
  return {
    ...manifest,
    routes: manifest.routes.map(({ child_state_dir: _path, ...route }) => route),
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
    windowsHide: true,
  }).trim()
}

function failureClass(error, childDir) {
  const manifestPath = path.join(childDir, 'private-manifest.json')
  if (fs.existsSync(manifestPath)) {
    try {
      const child = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      const recorded = child.tasks?.at(-1)?.failure_class
      if (recorded) return recorded
    } catch {}
  }
  if (error?.indeterminate === true || /UNKNOWN|TIMEOUT|NEEDS_ATTENTION/iu.test(String(error?.code || ''))) {
    return 'indeterminate'
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
    ? verified.tasks.map((task) => task?.visual_review_status
      || task?.verify_reread?.role?.review_status
      || task?.verification?.role?.review_status)
    : []
  if (statuses.includes('pending_external_review')) return 'pending_external_review'
  if (statuses.length > 0 && statuses.every((status) => status === 'not_applicable')) return 'not_required'
  return 'not_recorded'
}

export async function runFallbackEpisode(options, dependencies = {}) {
  const sourceHead = String(options?.sourceHead || '').trim().toLowerCase()
  const currentHead = String((dependencies.currentHead || actualHead)()).trim().toLowerCase()
  if (!HEX_40.test(sourceHead)) fail('REDRAW_EPISODE_SOURCE_HEAD_INVALID', sourceHead)
  if (sourceHead !== currentHead) fail('REDRAW_EPISODE_SOURCE_HEAD_MISMATCH', `${sourceHead} != ${currentHead}`)
  if (!path.isAbsolute(String(options?.episodePackage || ''))) fail('REDRAW_EPISODE_PACKAGE_PATH_INVALID')
  if (!path.isAbsolute(String(options?.stateDir || ''))) fail('REDRAW_EPISODE_FALLBACK_STATE_PATH_INVALID')
  const episodePackage = path.resolve(String(options.episodePackage))
  const stateDir = path.resolve(String(options.stateDir))
  requireNewStateDir(stateDir)
  const load = dependencies.loadEpisodePackage || loadEpisodePackage
  const pkg = load(episodePackage, stateDir)
  const now = dependencies.now || (() => new Date())
  const routes = dependencies.routes || EPISODE_VIDEO_ROUTES
  const executeStage = dependencies.runStage || runStage
  const createProvider = dependencies.createProvider || ((providerOptions) => createEpisodeVideoProviderAdapter({
    ...dependencies.providerOptions,
    ...providerOptions,
  }))
  const createdAt = now().toISOString()
  const manifest = {
    schema_version: 'redraw-isolated-video-model-fallback-state-v1',
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
    const beforeGenerationSubmit = async ({ route_id: routeId, unit_id: unitId, model }) => {
      if (routeId !== route.id || model !== route.model) {
        fail('REDRAW_EPISODE_FALLBACK_ROUTE_BINDING_MISMATCH', `${routeId}:${model}`)
      }
      if (manifest.winner_route_id == null) {
        if (unitId !== GATE_UNIT_ID || routeRecord.generation_submissions !== 0) {
          fail('REDRAW_EPISODE_FALLBACK_GATE_VIOLATION', `${routeId}:${unitId}`)
        }
      } else if (manifest.winner_route_id !== route.id) {
        fail('REDRAW_EPISODE_FALLBACK_MODEL_MIXED', `${manifest.winner_route_id}:${route.id}`)
      }
      if (manifest.generation_attempts.length >= MAX_GENERATION_SUBMISSIONS) {
        fail('REDRAW_EPISODE_FALLBACK_SUBMISSION_LIMIT', String(MAX_GENERATION_SUBMISSIONS))
      }
      if (manifest.generation_attempts.some((attempt) => attempt.route_id === route.id && attempt.unit_id === unitId)) {
        fail('REDRAW_EPISODE_FALLBACK_DUPLICATE_SUBMISSION', `${route.id}:${unitId}`)
      }
      manifest.generation_attempts.push({
        route_id: route.id,
        provider: route.provider,
        model: route.model,
        unit_id: unitId,
        started_at: now().toISOString(),
      })
      routeRecord.generation_submissions += 1
      persist()
    }
    const provider = createProvider({
      route,
      providerApiKey: String(options.keys[route.key_id] || '').trim(),
      referenceApiKey: String(options.keys.fumin || '').trim(),
      beforeGenerationSubmit,
    })
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
    manifest.status = 'winner_selected'
    routeRecord.status = 'winner_selected'
    persist()
    try {
      await executeStage(childOptions(options, childDir, 'sequence'), { provider })
      await executeStage(childOptions(options, childDir, 'assemble'), { provider })
      const verified = await executeStage(childOptions(options, childDir, 'verify'), { provider })
      if (!verified?.episode_artifact?.sha256) {
        fail('REDRAW_EPISODE_FALLBACK_EPISODE_ARTIFACT_MISSING')
      }
      manifest.episode_artifact = {
        route_id: route.id,
        artifact_id: verified.episode_artifact.artifact_id,
        sha256: verified.episode_artifact.sha256,
      }
      manifest.visual_review_status = aggregateVisualReviewStatus(verified)
      manifest.status = 'completed_verified'
      routeRecord.status = 'completed_verified'
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
  main().catch((error) => {
    console.error(String(error?.code || error?.message || 'REDRAW_EPISODE_FALLBACK_FAILED'))
    process.exitCode = 1
  })
}
