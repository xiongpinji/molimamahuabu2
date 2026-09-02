import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
  redrawLocalEnglishVoiceFixture,
  redrawLocalEnglishVoiceProfiles,
  redrawLocalEnglishVoiceSupplementalDialogue,
  writeRedrawLocalEnglishVoiceFixture,
} from '../fixtures/redraw-local-english-voice-fixtures.js'

const require = createRequire(import.meta.url)
const backendRoot = fileURLToPath(new URL('../../../backend-node/', import.meta.url))
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '::1'])
const DANGEROUS_ROUTES = [
  /^\/api\/v1\/redraw\/(?:shots\/[^/]+\/generate|works\/[^/]+\/generate-batch|assets\/[^/]+\/generate)\/?$/,
  /^\/api\/v1\/redraw\/versions\/[^/]+\/(?:assets\/batches|dialogue\/start)\/?$/,
  /^\/api\/v1\/ai-configs\/[^/]+\/connection\/?$/,
]
const REDRAW_LIVE_AUTHORITATIVE_VISIBLE_CHARACTER_IDS = Object.freeze({
  'shot-6': Object.freeze(['mateo', 'elena', 'rafael']),
})

export function normalizeLocalVerifierLocale(request, packLocale = 'en-US') {
  const raw = typeof request === 'string' ? request : request?.language
  const requested = String(raw || '').trim()
  const expected = String(packLocale || '').trim()
  if (!requested || !expected) return requested
  if (requested.toLowerCase() === expected.toLowerCase()
    || requested.toLowerCase() === expected.split('-')[0].toLowerCase()) {
    return expected
  }
  return requested
}

export function assertPaidAcceptanceLocaleVerifierReady({ localeVerifier, locale = 'en-US' } = {}) {
  if (!localeVerifier || typeof localeVerifier.assertReady !== 'function') {
    const error = new Error('REDRAW_LOCALE_VERIFIER_NOT_READY')
    error.code = 'REDRAW_LOCALE_VERIFIER_NOT_READY'
    throw error
  }
  const normalizedLocale = normalizeLocalVerifierLocale(locale, locale)
  const language = normalizedLocale.split('-')[0].toLowerCase()
  try {
    const pack = localeVerifier.assertReady({ language, scope: 'language' })
    if (!pack || typeof pack.id !== 'string' || !pack.id.trim()) {
      throw new Error('REDRAW_LOCALE_VERIFIER_NOT_READY')
    }
    return pack
  } catch (cause) {
    const error = new Error('REDRAW_LOCALE_VERIFIER_NOT_READY')
    error.code = 'REDRAW_LOCALE_VERIFIER_NOT_READY'
    error.cause = cause
    throw error
  }
}

export function buildRedrawLiveProductFixture(testCase, requiredInputs, options = {}) {
  if (!testCase?.source || !Array.isArray(testCase.cast) || !Array.isArray(testCase.sourceFacts?.shots)) {
    throw new Error('approved redraw case is required')
  }
  const localizationByShot = new Map((testCase.localization?.dialogue || []).map((entry) => [entry.shot_id, entry]))
  return {
    contract: 'redraw-live-product-launcher-v2',
    locale: testCase.target.locale,
    market: testCase.target.market,
    project: {
      title: 'Nine Shot Local Product Acceptance',
      default_locale: testCase.target.locale,
      default_market: testCase.target.market,
      execution_mode: 'auto',
      budget_limit_credits: 1,
      max_auto_attempts_per_shot: 1,
    },
    required_inputs: {
      ...requiredInputs,
      identity_images: requiredInputs.identity_images.map((entry, index) => ({
        ...entry,
        character_id: testCase.cast[index].id,
      })),
    },
    source: {
      filename: `${testCase.id}.mp4`,
      mime_type: 'video/mp4',
      sha256: testCase.source.sha256,
      duration_ms: testCase.source.duration_ms,
      duration_tolerance_ms: testCase.source.duration_tolerance_ms,
      width: testCase.source.video.width,
      height: testCase.source.video.height,
      video_codec: testCase.source.video.codec,
      frame_rate: testCase.source.video.frame_rate,
      audio_codec: testCase.source.audio.codec,
      audio_channels: testCase.source.audio.channels,
      audio_sample_rate: testCase.source.audio.sample_rate,
    },
    characters: testCase.cast.map((actor) => ({
      id: actor.id,
      source_name: actor.source_name,
      name: actor.target_name,
      role: actor.role,
    })),
    shots: testCase.sourceFacts.shots.map((shot, index) => {
      const localized = localizationByShot.get(shot.id) || { turns: [], speech_required: false }
      const characterId = localized.turns?.[0]?.speaker_id
        || shot.speaking_character_ids?.[0]
        || testCase.cast[index % testCase.cast.length].id
      const authoritativeVisibleCharacterIds = (options.authoritativeVisibleCharacterIdsByShot
        || REDRAW_LIVE_AUTHORITATIVE_VISIBLE_CHARACTER_IDS)[shot.id] || []
      return {
        shot_index: index + 1,
        shot_id: shot.id,
        start_ms: shot.start_ms,
        end_ms: shot.end_ms,
        duration_ms: shot.end_ms - shot.start_ms,
        motion_duration_ms: Math.min(
          Number(testCase.generationDurations?.[index] || 0) * 1000,
          shot.end_ms - shot.start_ms,
        ),
        character_id: characterId,
        character_ids: [...new Set([
          characterId,
          ...(shot.speaking_character_ids || []),
          ...authoritativeVisibleCharacterIds,
        ])],
        source_dialogue: shot.dialogue || [],
        localized_dialogue: localized.turns || [],
        speech_required: localized.speech_required === true,
        text_regions: shot.text_regions || [],
        opening_state: shot.opening_state,
        continuous_action: shot.continuous_action,
        ending_state: shot.ending_state,
        prompt: testCase.shotPrompts?.[shot.id] || '',
      }
    }),
    source_facts: testCase.sourceFacts,
    localization: testCase.localization,
  }
}

export async function loadRedrawLiveProductInputs({ fixture, env = process.env }) {
  const required = fixture?.required_inputs
  if (!required?.source_video?.env || required.identity_images?.length !== 5
    || required.motion_references?.length !== 9) {
    throw new Error('required local media layout is invalid')
  }
  const sourcePath = requiredPath(env, required.source_video.env)
  const identityPaths = required.identity_images.map((entry) => requiredPath(env, entry.env))
  const motionPaths = required.motion_references.map((entry) => requiredPath(env, entry.env))
  if ([sourcePath, ...identityPaths, ...motionPaths].some((filePath) => !isReadableRegularFile(filePath))) {
    throw new Error('required local media is missing')
  }

  const source = inspectMedia(sourcePath)
  if (source.sha256 !== fixture.source.sha256) throw new Error('source fingerprint mismatch')
  const sourceVideo = source.probe.streams.find((stream) => stream.codec_type === 'video')
  const sourceAudio = source.probe.streams.find((stream) => stream.codec_type === 'audio')
  const sourceDuration = Math.round(Number(source.probe.format?.duration) * 1000)
  if (!sourceVideo || !sourceAudio
    || Math.abs(sourceDuration - fixture.source.duration_ms) > fixture.source.duration_tolerance_ms
    || Number(sourceVideo.width) !== fixture.source.width
    || Number(sourceVideo.height) !== fixture.source.height
    || String(sourceVideo.codec_name).toLowerCase() !== fixture.source.video_codec
    || String(sourceAudio.codec_name).toLowerCase() !== fixture.source.audio_codec
    || Number(sourceAudio.channels) !== fixture.source.audio_channels
    || Number(sourceAudio.sample_rate) !== fixture.source.audio_sample_rate) {
    throw new Error('local media is invalid')
  }

  const identities = identityPaths.map((filePath, index) => {
    const media = inspectMedia(filePath)
    const image = media.probe.streams.find((stream) => stream.codec_type === 'video')
    if (!image || image.codec_name !== 'png' || Number(image.width) <= 0 || Number(image.height) <= 0) {
      throw new Error('local media is invalid')
    }
    return { ...media, character_id: required.identity_images[index].character_id }
  })
  const motions = motionPaths.map((filePath, index) => {
    const media = inspectMedia(filePath)
    const videos = media.probe.streams.filter((stream) => stream.codec_type === 'video')
    const audios = media.probe.streams.filter((stream) => stream.codec_type === 'audio')
    const durationMs = Math.round(Number(media.probe.format?.duration) * 1000)
    const expectedDuration = fixture.shots[index].motion_duration_ms || fixture.shots[index].duration_ms
    if (videos.length !== 1 || audios.length !== 0 || videos[0].codec_name !== 'h264'
      || Number(videos[0].width) <= 0 || Number(videos[0].height) <= 0
      || !Number.isSafeInteger(durationMs) || Math.abs(durationMs - expectedDuration) > 100) {
      throw new Error('local media is invalid')
    }
    return { ...media, shot_index: index + 1, duration_ms: durationMs }
  })
  return {
    source: { ...source, duration_ms: sourceDuration },
    identities,
    motions,
    media: {
      source: publicMedia(source),
      identities: identities.map(publicMedia),
      motions: motions.map(publicMedia),
    },
  }
}

export function installRedrawLiveNetworkGuard({ counts = {} } = {}) {
  counts.externalFetches ??= 0
  counts.blockedExternalAttempts ??= 0
  counts.blockedDangerousRoutes ??= 0
  const undici = require(path.join(backendRoot, 'node_modules', 'undici'))
  const originals = {
    globalFetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    undiciFetch: undici.fetch,
    undiciRequest: undici.request,
    undiciClient: undici.Client,
    undiciPool: undici.Pool,
    undiciAgent: undici.Agent,
  }
  let restored = false

  function assertAllowed(raw, method = 'GET') {
    const url = networkUrl(raw)
    if (!url || !LOOPBACK_HOSTS.has(url.hostname)) {
      counts.blockedExternalAttempts += 1
      throw new Error('network guard blocked non-loopback request')
    }
    if (String(method).toUpperCase() !== 'GET'
      && DANGEROUS_ROUTES.some((pattern) => pattern.test(url.pathname))) {
      counts.blockedDangerousRoutes += 1
      throw new Error('dangerous product route blocked by network guard')
    }
    return url
  }

  async function guardedFetch(input, init = {}) {
    const method = init.method
      || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
    const originalUrl = assertAllowed(input, method)
    const response = await originals.globalFetch(input, { ...init, redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (location) assertAllowed(new URL(location, originalUrl), method)
      throw new Error('network guard blocked redirect')
    }
    return response
  }

  function wrapNodeRequest(original) {
    return function guardedNodeRequest(...args) {
      const target = nodeRequestTarget(args)
      assertAllowed(target.url, target.method)
      return original.apply(this, args)
    }
  }

  function wrapUndiciConstructor(Original, requireOrigin) {
    return new Proxy(Original, {
      construct(Target, args, newTarget) {
        if (requireOrigin) assertAllowed(args[0], 'GET')
        const instance = Reflect.construct(Target, args, newTarget)
        const dispatch = typeof instance.dispatch === 'function' ? instance.dispatch.bind(instance) : null
        if (dispatch) {
          instance.dispatch = (options, handler) => {
            assertAllowed(options?.origin || options?.url || args[0], options?.method || 'GET')
            return dispatch(options, handler)
          }
        }
        return instance
      },
    })
  }

  globalThis.fetch = guardedFetch
  http.request = wrapNodeRequest(originals.httpRequest)
  http.get = wrapNodeRequest(originals.httpGet)
  https.request = wrapNodeRequest(originals.httpsRequest)
  https.get = wrapNodeRequest(originals.httpsGet)
  undici.fetch = guardedFetch
  undici.request = (url, options = {}) => {
    assertAllowed(url, options.method || 'GET')
    return originals.undiciRequest(url, { ...options, maxRedirections: 0 })
  }
  undici.Client = wrapUndiciConstructor(originals.undiciClient, true)
  undici.Pool = wrapUndiciConstructor(originals.undiciPool, true)
  undici.Agent = wrapUndiciConstructor(originals.undiciAgent, false)

  return {
    restore() {
      if (restored) return
      restored = true
      globalThis.fetch = originals.globalFetch
      http.request = originals.httpRequest
      http.get = originals.httpGet
      https.request = originals.httpsRequest
      https.get = originals.httpsGet
      undici.fetch = originals.undiciFetch
      undici.request = originals.undiciRequest
      undici.Client = originals.undiciClient
      undici.Pool = originals.undiciPool
      undici.Agent = originals.undiciAgent
    },
  }
}

export async function createRedrawLiveProductHarness({ fixture, env = process.env }) {
  const inputs = await loadRedrawLiveProductInputs({ fixture, env })
  return createProductServerHarness({ fixture, inputs })
}

export async function verifySupplementalDialogueAuthorityViaHttp({ fixture }) {
  const shot = fixture?.shots?.find(
    (entry) => entry.shot_id === redrawLocalEnglishVoiceSupplementalDialogue.shot_id,
  )
  if (!shot) throw new Error('supplemental dialogue authority shot missing')

  const counts = {
    externalFetches: 0,
    providerPaidSubmits: 0,
    generationSubmits: 0,
    voiceProviderCalls: 0,
  }
  const guard = installRedrawLiveNetworkGuard({ counts })
  const previousEnv = setHarnessEnvironment()
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-supplemental-authority-'))
  let db
  let server
  try {
    const express = require(path.join(backendRoot, 'node_modules', 'express'))
    const Database = require(path.join(backendRoot, 'node_modules', 'better-sqlite3'))
    const { runMigrationsAndEnsure } = require(path.join(backendRoot, 'src', 'db', 'migrate'))
    const { setupRouter } = require(path.join(backendRoot, 'src', 'routes'))
    db = new Database(path.join(tempRoot, 'authority.sqlite'))
    const originalLog = console.log
    const originalWarn = console.warn
    try {
      console.log = () => {}
      console.warn = () => {}
      runMigrationsAndEnsure(db)
    } finally {
      console.log = originalLog
      console.warn = originalWarn
    }

    const app = express()
    app.use(express.json())
    app.use('/api/v1', setupRouter({ storage: { local_path: path.join(tempRoot, 'storage') } }, db,
      harnessLog([]), {
        localizationProvider: async () => ({ status: 'failed' }),
        assetGenerationProvider: async () => ({ status: 'failed' }),
        dialogueProvider: async () => ({ status: 'failed' }),
      }))
    server = http.createServer(app)
    await listen(server)
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`
    const email = `redraw-authority-${crypto.randomUUID()}@example.test`
    const password = 'redraw-authority-password-123'
    await expectHttpStatus(fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }), 201)
    const login = await expectHttpStatus(fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }), 200)
    const token = String(login.access_token || login.token || '')
    const userId = String(login.user?.id || login.user_id || '')
    const tenantId = String(login.tenant_id || `personal:${userId}`)
    if (!token || !userId) throw new Error('supplemental authority login failed')

    const scope = seedSupplementalDialogueAuthorityScope({ db, fixture, shot, tenantId, userId })
    const response = await fetch(
      `${baseUrl}/redraw/versions/${scope.versionId}/shots/${scope.shotRowId}`
        + `/voices/${scope.voiceAssetId}/supplemental-dialogue-approvals`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Tenant-Id': tenantId,
        },
        body: JSON.stringify({
          idempotency_key: `authority-${scope.versionId}`,
          target_text: redrawLocalEnglishVoiceSupplementalDialogue.target_text,
          source_translation: redrawLocalEnglishVoiceSupplementalDialogue.source_translation,
          expected_shot_updated_at: scope.now,
          expected_voice_updated_at: scope.now,
        }),
      },
    )
    const payload = await response.json()
    const registrationAttempts = response.ok ? 1 : 0
    return {
      approval_status: response.status,
      approval_error_code: payload?.error?.code,
      supplemental_dialogue_approvals: Number(db.prepare(
        'SELECT COUNT(*) AS count FROM redraw_supplemental_dialogue_approvals',
      ).get().count),
      local_voice_registrations: Number(db.prepare(
        'SELECT COUNT(*) AS count FROM redraw_local_voice_registrations',
      ).get().count),
      registration_attempts: registrationAttempts,
      voice_provider_calls: counts.voiceProviderCalls,
      provider_paid_submits: counts.providerPaidSubmits,
      generation_submits: counts.generationSubmits,
      external_fetches: counts.externalFetches,
    }
  } finally {
    if (server) await closeServer(server)
    db?.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
    restoreHarnessEnvironment(previousEnv)
    guard.restore()
  }
}

export function redactLiveProductSummary(result) {
  const summary = result?.summary || {}
  return JSON.parse(JSON.stringify({
    dry_run: summary.dry_run === true,
    project_id: summary.project_id,
    work_id: summary.work_id,
    version_id: summary.version_id,
    shot_count: summary.shot_count,
    reference_ready: summary.reference_ready,
    generation_submits: summary.generation_submits,
    external_fetches: summary.external_fetches,
    provider_paid_submits: summary.provider_paid_submits,
    voice_provider_calls: summary.voice_provider_calls,
    voice_registered: summary.voice_registered,
    supplemental_dialogue_approvals: summary.supplemental_dialogue_approvals,
    local_voice_registrations: summary.local_voice_registrations,
    character_plan_ready: summary.character_plan_ready,
    local_tts_syntheses: summary.local_tts_syntheses,
    locale_verification_calls: summary.locale_verification_calls,
    reservation_rows: summary.reservation_rows,
    reservation_delta: summary.reservation_delta,
    reserved_credits: summary.reserved_credits,
    held_credits: summary.held_credits,
    charged_credits: summary.charged_credits,
    media: summary.media,
  }))
}

async function expectHttpStatus(responsePromise, expectedStatus) {
  const response = await responsePromise
  const payload = await response.json()
  if (response.status !== expectedStatus) {
    throw new Error(`local HTTP ${response.status}: ${payload?.error?.code || 'unexpected response'}`)
  }
  return payload.data ?? payload
}

function seedSupplementalDialogueAuthorityScope({ db, fixture, shot, tenantId, userId }) {
  const now = '2026-08-28T00:00:00.000Z'
  const factsHash = sha256(Buffer.from(JSON.stringify({
    shot_id: shot.shot_id,
    visible_character_ids: shot.character_ids,
  })))
  const sourceFacts = {
    schema_version: '2.0',
    facts_hash: factsHash,
    characters: fixture.characters.map((character) => ({
      id: character.id,
      source_name: character.source_name,
    })),
    shots: [{
      id: shot.shot_id,
      visible_character_ids: shot.character_ids,
      dialogue: shot.source_dialogue,
    }],
  }
  const projectId = Number(db.prepare(`INSERT INTO redraw_projects
    (tenant_id, user_id, title, default_locale, default_market, localization_level,
     status, policy_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'faithful', 'active', 7, ?, ?)`).run(
    tenantId, userId, 'Supplemental authority probe', fixture.locale, fixture.market, now, now,
  ).lastInsertRowid)
  const workId = Number(db.prepare(`INSERT INTO redraw_works
    (project_id, tenant_id, user_id, title, source_asset_id, source_fingerprint,
     duration_ms, current_version, current_step, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, 1, 2, 'asset_review', ?, ?)`).run(
    projectId, tenantId, userId, 'Supplemental authority probe', factsHash,
    fixture.source.duration_ms, now, now,
  ).lastInsertRowid)
  const taskId = `supplemental-authority-${crypto.randomUUID()}`
  const versionId = Number(db.prepare(`INSERT INTO redraw_versions
    (work_id, tenant_id, user_id, version, locale, market, localization_level,
     source_facts_json, facts_hash, localization_task_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, 'faithful', ?, ?, ?, 'asset_review', ?, ?)`).run(
    workId, tenantId, userId, fixture.locale, fixture.market, JSON.stringify(sourceFacts),
    factsHash, taskId, now, now,
  ).lastInsertRowid)
  const shotRowId = Number(db.prepare(`INSERT INTO redraw_shots
    (work_id, shot_id, version_id, tenant_id, user_id, batch_index, shot_index,
     start_ms, end_ms, duration_ms, source_dialogue_json, localized_dialogue_json,
     references_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, '[]', 'draft', ?, ?)`).run(
    workId, shot.shot_id, versionId, tenantId, userId, shot.shot_index,
    shot.start_ms, shot.end_ms, shot.duration_ms, JSON.stringify(shot.source_dialogue),
    JSON.stringify(shot.localized_dialogue), now, now,
  ).lastInsertRowid)
  const voiceAssetId = Number(db.prepare(`INSERT INTO redraw_assets
    (version_id, tenant_id, user_id, kind, source_ref_json, localized_name,
     version_number, approval_status, status, created_at, updated_at)
    VALUES (?, ?, ?, 'voice', ?, 'Rafael voice', 1, 'pending', 'draft', ?, ?)`).run(
    versionId, tenantId, userId, JSON.stringify({
      source_ref: {
        kind: 'voice',
        source_character_key: redrawLocalEnglishVoiceSupplementalDialogue.source_character_key,
      },
    }), now, now,
  ).lastInsertRowid)
  db.prepare(`INSERT INTO async_tasks
    (id, type, status, progress, result, resource_id, tenant_id, user_id,
     created_at, updated_at, completed_at)
    VALUES (?, 'redraw_localization', 'completed', 100, ?, ?, ?, ?, ?, ?, ?)`).run(
    taskId,
    JSON.stringify({
      status: 'completed',
      work_id: workId,
      version_id: versionId,
      facts_hash: factsHash,
      localization_decision: {
        action: 'advance', policy_version: 7, evidence_hash: factsHash, version_id: versionId,
      },
    }),
    String(workId), tenantId, userId, now, now, now,
  )
  return { now, versionId, shotRowId, voiceAssetId }
}

function requiredPath(env, name) {
  const value = String(env?.[name] || '').trim()
  return value ? path.resolve(value) : ''
}

function isReadableRegularFile(filePath) {
  if (!filePath) return false
  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) return false
    fs.accessSync(filePath, fs.constants.R_OK)
    return fs.realpathSync(filePath) === path.resolve(filePath)
  } catch (_) {
    return false
  }
}

function inspectMedia(filePath) {
  let probe
  try {
    probe = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
  } catch (_) {
    throw new Error('local media is invalid')
  }
  if (!Array.isArray(probe.streams)) throw new Error('local media is invalid')
  return {
    path: filePath,
    basename: path.basename(filePath),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    probe,
  }
}

function publicMedia(media) {
  return { basename: media.basename, sha256: media.sha256 }
}

function networkUrl(raw) {
  try {
    if (typeof Request !== 'undefined' && raw instanceof Request) return new URL(raw.url)
    if (raw instanceof URL) return new URL(raw.href)
    if (typeof raw === 'string') return new URL(raw)
    if (raw?.href) return new URL(raw.href)
    if (raw?.origin) return new URL(raw.origin)
    return null
  } catch (_) {
    return null
  }
}

function nodeRequestTarget(args) {
  const first = args[0]
  const second = args[1]
  if (typeof first === 'string' || first instanceof URL) {
    const options = second && typeof second === 'object' ? second : {}
    const url = new URL(first)
    if (options.protocol) url.protocol = options.protocol
    if (options.hostname) url.hostname = options.hostname
    else if (options.host) {
      const host = new URL(`${url.protocol}//${options.host}`)
      url.hostname = host.hostname
      url.port = host.port
    }
    if (options.port) url.port = String(options.port)
    if (options.path !== undefined) {
      const pathUrl = new URL(String(options.path), url)
      url.pathname = pathUrl.pathname
      url.search = pathUrl.search
    } else {
      if (options.pathname !== undefined) url.pathname = String(options.pathname)
      if (options.search !== undefined) url.search = String(options.search)
    }
    return { url, method: options.method || 'GET' }
  }
  const options = first || {}
  const protocol = options.protocol || 'http:'
  const hostname = options.hostname || options.host
  const port = options.port ? `:${options.port}` : ''
  return {
    url: `${protocol}//${hostname}${port}${options.path || '/'}`,
    method: options.method || 'GET',
  }
}

async function createProductServerHarness({ fixture, inputs }) {
  const counts = {
    generationSubmits: 0,
    externalFetches: 0,
    providerPaidSubmits: 0,
    blockedExternalAttempts: 0,
    blockedDangerousRoutes: 0,
    coverageProviderCalls: 0,
    cleanProviderCalls: 0,
    voiceProviderCalls: 0,
    localTtsSyntheses: 0,
    localeVerificationCalls: 0,
    voiceReviews: 0,
    characterVoiceAssignments: 0,
    characterReviews: 0,
    supplementalDialogueApprovals: 0,
  }
  const guard = installRedrawLiveNetworkGuard({ counts })
  const previousEnv = setHarnessEnvironment()
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-live-product-'))
  const storageRoot = path.join(tempRoot, 'storage')
  fs.mkdirSync(storageRoot, { recursive: true })
  let db
  let server
  let closed = false
  try {
    const express = require(path.join(backendRoot, 'node_modules', 'express'))
    const Database = require(path.join(backendRoot, 'node_modules', 'better-sqlite3'))
    const { runMigrationsAndEnsure } = require(path.join(backendRoot, 'src', 'db', 'migrate'))
    const { setupRouter } = require(path.join(backendRoot, 'src', 'routes'))
    const modelPrices = require(path.join(backendRoot, 'src', 'services', 'modelPriceService'))
    db = new Database(path.join(tempRoot, 'redraw-live.sqlite'))
    const originalLog = console.log
    const originalWarn = console.warn
    try {
      console.log = () => {}
      console.warn = () => {}
      runMigrationsAndEnsure(db)
    } finally {
      console.log = originalLog
      console.warn = originalWarn
    }
    const derived = prepareLocalDerivedMedia({ fixture, inputs, tempRoot })
    seedLocalProductConfig({ db, modelPrices })
    const routeErrors = []
    const app = express()
    app.use(express.json({ limit: '5mb' }))
    app.use(express.urlencoded({ extended: true }))
    app.use('/api/v1', setupRouter({
      app: { name: 'redraw local product acceptance', version: 'test' },
      server: { cors_origins: [] },
      storage: { local_path: storageRoot, base_url: '' },
    }, db, harnessLog(routeErrors), createRouteOptions({
      fixture,
      derived,
      counts,
      tempRoot,
      storageRoot,
    })))
    app.use((error, _req, res, _next) => {
      res.status(500).json({
        success: false,
        error: { code: 'LOCAL_PRODUCT_BLOCKED', message: sanitizeRouteError(error?.message) },
      })
    })
    server = http.createServer(app)
    await listen(server)
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    let authToken = ''
    let tenantId = ''
    let userId = ''

    async function guardedFetch(target, init = {}, authenticated = true) {
      const url = new URL(target, baseUrl)
      const headers = { ...(init.headers || {}) }
      if (authenticated && authToken) {
        headers.Authorization = `Bearer ${authToken}`
        headers['X-Tenant-Id'] = tenantId
      }
      return globalThis.fetch(url, { ...init, headers })
    }

    async function postJson(pathname, body, options = {}) {
      return jsonResponse(await guardedFetch(pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, options.authenticated !== false), options.expectedStatus || 200, routeErrors)
    }

    async function putJson(pathname, body) {
      return jsonResponse(await guardedFetch(pathname, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }), 200, routeErrors)
    }

    async function getJson(pathname) {
      return jsonResponse(await guardedFetch(pathname), 200, routeErrors)
    }

    async function uploadFile(pathname, filePath, options = {}) {
      const multipart = multipartBody({
        filePath,
        mimeType: options.mimeType,
        fields: options.fields,
      })
      return jsonResponse(await guardedFetch(pathname, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
          'Content-Length': String(multipart.body.length),
          ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        },
        body: multipart.body,
      }), options.expectedStatus || 200, routeErrors)
    }

    async function waitForTask(taskId, expectedStatuses) {
      if (!taskId) throw new Error('product task id missing')
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        const task = await getJson(`/api/v1/tasks/${encodeURIComponent(taskId)}`)
        if (expectedStatuses.includes(task.status)) return task
        if (['failed', 'cancelled'].includes(task.status)) {
          throw new Error(`product task ended ${task.status}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('product task timeout')
    }

    async function reviewAsset(assetId, expectedUpdatedAt) {
      const current = expectedUpdatedAt || db.prepare(
        'SELECT updated_at FROM redraw_assets WHERE id = ?',
      ).get(assetId)?.updated_at
      return postJson(`/api/v1/redraw/assets/${assetId}/review`, {
        action: 'approved',
        expected_updated_at: current,
      })
    }

    async function versionAssets(versionId) {
      const payload = await getJson(`/api/v1/redraw/versions/${versionId}/assets`)
      return Array.isArray(payload.items) ? payload.items : payload
    }

    async function versionShots(workId, versionId) {
      const work = await getJson(`/api/v1/redraw/works/${workId}`)
      if (Number(work.version_id) !== Number(versionId)) throw new Error('localized version not promoted')
      return Array.isArray(work.shots) ? work.shots : []
    }

    async function prepareDryRun() {
      const password = `Local-${crypto.randomUUID()}-A9!`
      const email = `redraw-local-${crypto.randomUUID()}@example.test`
      await postJson('/api/v1/auth/register', { email, password }, {
        expectedStatus: 201,
        authenticated: false,
      })
      const login = await postJson('/api/v1/auth/login', { email, password }, {
        authenticated: false,
      })
      authToken = String(login.access_token || login.token || '')
      userId = String(login.user?.id || login.user_id || '')
      tenantId = String(login.tenant_id || `personal:${userId}`)
      if (!authToken || !userId) throw new Error('real local login failed')

      const beforeBilling = billingSnapshot(db)
      const project = await postJson('/api/v1/redraw/projects', fixture.project, { expectedStatus: 201 })
      const uploaded = await uploadFile(`/api/v1/redraw/projects/${project.id}/works`, inputs.source.path, {
        mimeType: fixture.source.mime_type,
        expectedStatus: 201,
      })
      const work = Array.isArray(uploaded.items) ? uploaded.items[0] : uploaded
      const workId = Number(work.id)
      const analysis = await postJson(`/api/v1/redraw/works/${workId}/analyze`, {
        style_preset_id: 1,
        locale: fixture.locale,
        market: fixture.market,
        aspect_ratio: '9:16',
      }, { expectedStatus: [201, 202] })
      if (analysis.task_id) await waitForTask(analysis.task_id, ['completed'])
      const localizationQuote = await postJson(`/api/v1/redraw/works/${workId}/localization-quote`, {
        locale: fixture.locale,
        market: fixture.market,
        localization_level: 'faithful',
      })
      const localization = await postJson(`/api/v1/redraw/works/${workId}/versions`, {
        locale: fixture.locale,
        market: fixture.market,
        localization_level: 'faithful',
        quote_hash: localizationQuote.quote_hash,
        idempotency_key: `local-localization-${workId}`,
      }, { expectedStatus: 202 })
      const versionId = Number(localization.version_id)
      await waitForTask(localization.task_id, ['completed'])

      const versionBeforeCoverage = db.prepare(
        'SELECT updated_at FROM redraw_versions WHERE id = ?',
      ).get(versionId)
      let coverage
      try {
        coverage = await postJson(`/api/v1/redraw/versions/${versionId}/full-frame-coverages`, {
          expected_version_updated_at: versionBeforeCoverage.updated_at,
          idempotency_key: `local-coverage-${versionId}`,
        })
      } catch (error) {
        const registration = db.prepare(`SELECT error_code, error_message
          FROM redraw_coverage_registrations WHERE version_id = ? ORDER BY id DESC LIMIT 1`).get(versionId)
        throw new Error(
          `${sanitizeRouteError(error?.message)} registration_error `
          + `${sanitizeRouteError(registration?.error_code)}:${sanitizeRouteError(registration?.error_message)}`,
        )
      }
      await reviewAsset(Number(coverage.redraw_asset_id))

      let assets = await versionAssets(versionId)
      const characterAssets = assets.filter((asset) => asset.kind === 'character')
      const voiceAssets = assets.filter((asset) => asset.kind === 'voice')
      if (characterAssets.length !== 5 || voiceAssets.length !== 5) {
        throw new Error('localized character and voice asset count mismatch')
      }
      const identityByCharacter = new Map(inputs.identities.map((media) => [media.character_id, media]))
      for (const character of fixture.characters) {
        let redrawAsset = (await versionAssets(versionId)).find((asset) => (
          asset.kind === 'character' && sourceCharacterKey(asset) === character.id
        ))
        const identity = identityByCharacter.get(character.id)
        if (!redrawAsset || !identity) throw new Error('character media mapping incomplete')
        const imported = await uploadFile(`/api/v1/redraw/assets/${redrawAsset.id}/reference-artifact`, identity.path, {
          mimeType: 'image/png',
          fields: { purpose: 'identity', expected_updated_at: redrawAsset.updated_at },
          idempotencyKey: `local-identity-${versionId}-${character.id}`,
        })
        const packed = await putJson(`/api/v1/redraw/assets/${redrawAsset.id}/identity-pack`, {
          target_actor_label: character.name,
          confirmed_views: ['front', 'profile', 'full_body'],
          live_action_human_confirmed: true,
          adult_status: 'verified_18_plus',
          identity_consistency_confirmed: true,
          wardrobe_reference_asset_id: Number(imported.asset.id),
          wardrobe_consistency_confirmed: true,
          expected_updated_at: imported.redraw_asset.updated_at,
        })
        redrawAsset = packed.asset
        await reviewAsset(Number(redrawAsset.id), redrawAsset.updated_at)
      }

      const supplementalInput = redrawLocalEnglishVoiceSupplementalDialogue
      const approvalShot = (await versionShots(workId, versionId)).find((shot) => (
        Number(shot.shot_index) === Number(
          fixture.shots.find((entry) => entry.shot_id === supplementalInput.shot_id)?.shot_index,
        )
      ))
      assets = await versionAssets(versionId)
      const approvalVoice = assets.find((asset) => (
        asset.kind === 'voice' && sourceCharacterKey(asset) === supplementalInput.source_character_key
      ))
      if (!approvalShot || !approvalVoice) throw new Error('supplemental dialogue approval scope missing')
      if ((approvalShot.source_dialogue || []).some((turn) => (
        turn.speaker_id === supplementalInput.source_character_key
      )) || (approvalShot.localized_dialogue || []).some((turn) => (
        turn.speaker_id === supplementalInput.source_character_key
      ))) {
        throw new Error('supplemental dialogue leaked into source or localized turns')
      }
      const supplementalApproval = await postJson(
        `/api/v1/redraw/versions/${versionId}/shots/${approvalShot.id}/voices/${approvalVoice.id}`
          + '/supplemental-dialogue-approvals',
        {
          idempotency_key: `local-supplemental-dialogue-${versionId}`,
          target_text: supplementalInput.target_text,
          source_translation: supplementalInput.source_translation,
          expected_shot_updated_at: approvalShot.updated_at,
          expected_voice_updated_at: approvalVoice.updated_at,
        },
      )
      const approvalResponseKeys = [
        'approval_evidence_sha256', 'approval_id', 'approved_at', 'contract_version',
        'idempotent_replay', 'redraw_shot_id', 'source_translation', 'status',
        'target_text_sha256', 'updated_at', 'version_id', 'voice_redraw_asset_id',
      ]
      if (Object.keys(supplementalApproval).sort().join(',') !== approvalResponseKeys.sort().join(',')
        || supplementalApproval.contract_version !== 'redraw-supplemental-dialogue-approval-v1'
        || supplementalApproval.status !== 'active'
        || supplementalApproval.source_translation !== false
        || supplementalApproval.idempotent_replay !== false
        || Number(supplementalApproval.redraw_shot_id) !== Number(approvalShot.id)
        || Number(supplementalApproval.voice_redraw_asset_id) !== Number(approvalVoice.id)
        || supplementalApproval.target_text_sha256 !== sha256(Buffer.from(supplementalInput.target_text, 'utf8'))
        || !/^[a-f0-9]{64}$/.test(supplementalApproval.approval_evidence_sha256)
        || Object.values(supplementalApproval).includes(supplementalInput.target_text)) {
        throw new Error('supplemental dialogue approval response contract mismatch')
      }
      counts.supplementalDialogueApprovals += 1

      let voiceRegistered = 0
      let rafaelVoiceEvidenceObserved = false
      for (const character of fixture.characters) {
        assets = await versionAssets(versionId)
        const voiceAsset = assets.find((asset) => (
          asset.kind === 'voice' && sourceCharacterKey(asset) === character.id
        ))
        const characterAsset = assets.find((asset) => (
          asset.kind === 'character' && sourceCharacterKey(asset) === character.id
        ))
        if (!voiceAsset || !characterAsset) throw new Error('local voice character mapping incomplete')
        const registered = await postJson(
          `/api/v1/redraw/versions/${versionId}/voices/${voiceAsset.id}/local-production-registrations`,
          {
            idempotency_key: `local-voice-${versionId}-${character.id}`,
            expected_updated_at: voiceAsset.updated_at,
          },
        )
        if (registered.status !== 'completed' || registered.billing?.charged !== 0) {
          throw new Error('local voice registration did not complete at zero cost')
        }
        voiceRegistered += 1
        await reviewAsset(Number(voiceAsset.id), registered.voice.updated_at)
        counts.voiceReviews += 1
        const currentCharacter = (await versionAssets(versionId)).find((asset) => (
          Number(asset.id) === Number(characterAsset.id)
        ))
        const assigned = await postJson(`/api/v1/redraw/assets/${characterAsset.id}/voice`, {
          voice_asset_id: Number(voiceAsset.id),
          expected_updated_at: currentCharacter.updated_at,
        })
        counts.characterVoiceAssignments += 1
        if (character.id === supplementalInput.source_character_key) {
          const evidence = assigned.voice_snapshot
          const approvalEvidence = evidence?.supplemental_dialogue_approvals?.[0]
          if (!evidence
            || evidence.source_translation !== false
            || evidence.supplemental_dialogue_approval_ids?.length !== 1
            || Number(evidence.supplemental_dialogue_approval_ids[0])
              !== Number(supplementalApproval.approval_id)
            || Number(approvalEvidence?.approval_id) !== Number(supplementalApproval.approval_id)
            || approvalEvidence?.approval_evidence_sha256
              !== supplementalApproval.approval_evidence_sha256
            || approvalEvidence?.target_text_sha256 !== supplementalApproval.target_text_sha256) {
            throw new Error('Rafael voice evidence is not bound to the HTTP approval')
          }
          rafaelVoiceEvidenceObserved = true
        }
        await reviewAsset(Number(characterAsset.id), assigned.asset.updated_at)
        counts.characterReviews += 1
      }
      const characterPlan = await getJson(`/api/v1/redraw/versions/${versionId}/character-plan`)
      const characterPlanReady = (characterPlan.characters || [])
        .filter((character) => character.voice?.ready === true).length
      if (characterPlan.ready !== true
        || characterPlan.characters?.length !== 5
        || characterPlanReady !== 5) {
        throw new Error('local voice character plan is not 5/5 ready')
      }
      const completedProfiles = db.prepare(`SELECT source_character_key, profile_key,
          approved_dialogue_evidence_sha256, supplemental_approval_ids_json
        FROM redraw_local_voice_registrations
        WHERE tenant_id = ? AND user_id = ? AND version_id = ?
          AND status = 'completed' AND deleted_at IS NULL
        ORDER BY profile_key`).all(tenantId, userId, versionId)
      if (completedProfiles.length !== 5
        || new Set(completedProfiles.map((row) => row.profile_key)).size !== 5
        || counts.localTtsSyntheses !== 5
        || counts.localeVerificationCalls !== 5
        || counts.voiceReviews !== 5
        || counts.characterVoiceAssignments !== 5
        || counts.characterReviews !== 5
        || !rafaelVoiceEvidenceObserved) {
        throw new Error('local voice evidence count mismatch')
      }
      const approvalAudit = db.prepare(`SELECT id, contract_version, status, approval_source,
          source_translation, target_text_sha256, approval_evidence_sha256
        FROM redraw_supplemental_dialogue_approvals
        WHERE tenant_id = ? AND user_id = ? AND version_id = ? AND deleted_at IS NULL`)
        .all(tenantId, userId, versionId)
      const rafaelRegistration = completedProfiles.find((row) => (
        row.source_character_key === supplementalInput.source_character_key
      ))
      if (approvalAudit.length !== 1
        || Number(approvalAudit[0].id) !== Number(supplementalApproval.approval_id)
        || approvalAudit[0].contract_version !== supplementalApproval.contract_version
        || approvalAudit[0].status !== 'active'
        || approvalAudit[0].approval_source !== 'owner_http'
        || Number(approvalAudit[0].source_translation) !== 0
        || approvalAudit[0].target_text_sha256 !== supplementalApproval.target_text_sha256
        || approvalAudit[0].approval_evidence_sha256 !== supplementalApproval.approval_evidence_sha256
        || !rafaelRegistration
        || rafaelRegistration.approved_dialogue_evidence_sha256 == null
        || JSON.stringify([Number(supplementalApproval.approval_id)])
          !== rafaelRegistration.supplemental_approval_ids_json) {
        throw new Error('supplemental dialogue read-only audit mismatch')
      }

      let shots = await versionShots(workId, versionId)
      if (shots.length !== fixture.shots.length) throw new Error('localized shot count mismatch')
      for (const shot of shots) {
        const motion = derived.motions[Number(shot.shot_index) - 1]
        const imported = await uploadFile(`/api/v1/redraw/shots/${shot.id}/motion-reference`, motion.path, {
          mimeType: 'video/mp4',
          fields: {
            expected_updated_at: shot.updated_at,
            full_frame_reviewed: 'true',
            source_identity_obscured: 'true',
            source_text_obscured: 'true',
            motion_preserved: 'true',
          },
          idempotencyKey: `local-motion-${versionId}-${shot.shot_index}`,
        })
        if (!imported.asset?.id) throw new Error('motion import did not persist an asset')
      }
      shots = await versionShots(workId, versionId)
      const shotIds = shots.map((shot) => Number(shot.id))
      const expectedCleanRequirements = fixture.shots.reduce(
        (total, shot) => total + shot.character_ids.length + shot.text_regions.length,
        0,
      )
      let referencePreparationCompleted = false
      const reviewedCleanAssetIds = new Set()
      for (let round = 1; round <= expectedCleanRequirements + 1; round += 1) {
        const quote = await postJson(`/api/v1/redraw/versions/${versionId}/reference-preparation-quote`, {
          shot_ids: shotIds,
        })
        const started = await postJson(`/api/v1/redraw/versions/${versionId}/reference-preparations`, {
          shot_ids: shotIds,
          quote_hash: quote.quote_hash,
          idempotency_key: `local-reference-${versionId}-${round}`,
        }, { expectedStatus: 202 })
        const task = await waitForTask(started.task_id, ['completed', 'needs_attention'])
        if (task.status === 'completed') {
          referencePreparationCompleted = true
          break
        }
        assets = await versionAssets(versionId)
        const cleanCandidates = assets.filter((asset) => (
          asset.approval_status === 'pending' && Number(asset.clean_plate_asset_id) > 0
        ))
        if (cleanCandidates.length === 0) throw new Error('clean candidate review made no progress')
        for (const clean of cleanCandidates) {
          const cleanId = Number(clean.id)
          if (reviewedCleanAssetIds.has(cleanId)) throw new Error('clean candidate review repeated')
          await reviewAsset(cleanId, clean.updated_at)
          reviewedCleanAssetIds.add(cleanId)
        }
      }
      if (!referencePreparationCompleted) throw new Error('reference preparation did not complete')
      if (counts.cleanProviderCalls !== expectedCleanRequirements) {
        throw new Error('clean provider requirement count mismatch')
      }
      await getJson(`/api/v1/redraw/versions/${versionId}/preparation-gate`)
      await getJson(`/api/v1/redraw/versions/${versionId}/generation-gate`)
      const readyShots = await versionShots(workId, versionId)
      const referenceReady = readyShots.filter((shot) => shot.preparation_state === 'reference_ready').length
      if (referenceReady !== fixture.shots.length) throw new Error('reference ready count mismatch')
      const afterBilling = billingSnapshot(db)
      const summary = {
        dry_run: true,
        project_id: Number(project.id),
        work_id: workId,
        version_id: versionId,
        shot_count: readyShots.length,
        reference_ready: referenceReady,
        generation_submits: counts.generationSubmits,
        external_fetches: counts.externalFetches,
        provider_paid_submits: counts.providerPaidSubmits,
        voice_provider_calls: counts.voiceProviderCalls,
        voice_registered: voiceRegistered,
        supplemental_dialogue_approvals: approvalAudit.length,
        local_voice_registrations: completedProfiles.length,
        character_plan_ready: characterPlanReady,
        local_tts_syntheses: counts.localTtsSyntheses,
        locale_verification_calls: counts.localeVerificationCalls,
        reservation_rows: afterBilling.rows,
        reservation_delta: afterBilling.rows - beforeBilling.rows,
        reserved_credits: afterBilling.reserved,
        held_credits: afterBilling.held,
        charged_credits: afterBilling.charged,
        media: inputs.media,
      }
      assertZeroCostSummary(summary)
      return {
        counts: { ...counts },
        shots: readyShots.map(publicShot),
        characterPlan,
        context: { authToken, tenantId, userId, workId, versionId },
        summary,
      }
    }

    async function close() {
      if (closed) return
      closed = true
      if (server) await closeServer(server)
      db?.close()
      fs.rmSync(tempRoot, { recursive: true, force: true })
      restoreHarnessEnvironment(previousEnv)
      guard.restore()
    }
    return { prepareDryRun, guardedFetch, close }
  } catch (error) {
    if (server) await closeServer(server).catch(() => {})
    db?.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
    restoreHarnessEnvironment(previousEnv)
    guard.restore()
    throw error
  }
}

function setHarnessEnvironment() {
  const names = [
    'PUBLIC_PLATFORM_MODE',
    'PLATFORM_REGISTRATION_ENABLED',
    'PLATFORM_EMAIL_VERIFICATION_ENABLED',
    'PLATFORM_SECURE_COOKIES',
    'PLATFORM_JWT_SECRET',
  ]
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  process.env.PUBLIC_PLATFORM_MODE = 'true'
  process.env.PLATFORM_REGISTRATION_ENABLED = 'true'
  process.env.PLATFORM_EMAIL_VERIFICATION_ENABLED = 'false'
  process.env.PLATFORM_SECURE_COOKIES = 'false'
  process.env.PLATFORM_JWT_SECRET = `redraw-local-${crypto.randomUUID()}-secret-at-least-32-bytes`
  return previous
}

function restoreHarnessEnvironment(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

function prepareLocalDerivedMedia({ fixture, inputs, tempRoot }) {
  const root = path.join(tempRoot, 'derived-media')
  fs.mkdirSync(root, { recursive: true })
  const sourceFrames = fixture.shots.map((shot, index) => {
    const target = path.join(root, `source-frame-${index + 1}.png`)
    runFfmpeg([
      '-ss', String(((shot.start_ms + shot.end_ms) / 2) / 1000),
      '-i', inputs.source.path,
      '-frames:v', '1',
      '-y', target,
    ])
    return { path: target, bytes: fs.readFileSync(target) }
  })
  const motions = inputs.motions.map((motion, index) => {
    const shot = fixture.shots[index]
    const target = path.join(root, `motion-${index + 1}.mp4`)
    const filter = [
      `scale=${fixture.source.width}:${fixture.source.height}:force_original_aspect_ratio=decrease`,
      `pad=${fixture.source.width}:${fixture.source.height}:(ow-iw)/2:(oh-ih)/2:black`,
    ].join(',')
    runFfmpeg([
      '-i', motion.path,
      '-vf', filter,
      '-t', String(shot.duration_ms / 1000),
      '-an',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y', target,
    ])
    const frameTarget = path.join(root, `motion-frame-${index + 1}.png`)
    runFfmpeg(['-ss', '0.25', '-i', target, '-frames:v', '1', '-y', frameTarget])
    return {
      path: target,
      frame: { path: frameTarget, bytes: fs.readFileSync(frameTarget) },
    }
  })
  return { sourceFrames, motions }
}

function runFfmpeg(args) {
  try {
    execFileSync('ffmpeg', ['-v', 'error', ...args], {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (_) {
    throw new Error('local media derivation failed')
  }
}

function seedLocalProductConfig({ db, modelPrices }) {
  const now = new Date().toISOString()
  const analysisModel = 'local-product-analysis-v1'
  const localizationModel = 'local-product-localization-v1'
  const cleanModel = 'local-product-clean-v1'
  insertServiceConfig(db, {
    serviceType: 'video_understanding',
    provider: 'local-product',
    name: 'Local analysis',
    model: analysisModel,
    priority: 100,
    settings: {
      real_generation_verified: true,
      evidence: {
        provider_task_id: 'local-analysis-evidence',
        result_asset_id: 1,
        result_asset_readable: true,
        completed_at: now,
      },
    },
    now,
  })
  insertServiceConfig(db, {
    serviceType: 'text',
    provider: 'local-product',
    name: 'Local localization',
    model: localizationModel,
    priority: 100,
    settings: localeCapability('text', {
      provider: 'local-product', model: localizationModel,
      task_id: 'local-localization-evidence', terminal_status: 'completed', artifact_id: 1,
    }),
    now,
  })
  insertServiceConfig(db, {
    serviceType: 'image',
    provider: 'local-product',
    name: 'Local clean',
    model: cleanModel,
    priority: 100,
    settings: localeCapability('clean_plate_image', {
      provider: 'local-product', model: cleanModel,
      task_id: 'local-clean-evidence', terminal_status: 'completed', artifact_id: 1,
    }),
    now,
  })
  for (const [model, category] of [
    [analysisModel, 'text'],
    [localizationModel, 'text'],
    [cleanModel, 'image'],
  ]) {
    modelPrices.set(db, model, 0, {
      pricingMode: 'free',
      category,
      billingUnit: 'request',
      costUnit: category === 'image' ? 'image' : 'request',
    })
  }
}

function insertServiceConfig(db, input) {
  return db.prepare(`INSERT INTO ai_service_configs
    (service_type, provider, name, base_url, api_key, model, default_model, priority,
     is_default, is_active, settings, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, '', '', ?, ?, ?, 1, 1, ?, ?, ?, NULL)`)
    .run(
      input.serviceType,
      input.provider,
      input.name,
      input.modelAsList ? JSON.stringify([input.model]) : input.model,
      input.model,
      input.priority,
      JSON.stringify(input.settings),
      input.now,
      input.now,
    ).lastInsertRowid
}

function localeCapability(capability, evidence) {
  return {
    redraw_locale_capabilities: [{
      locale: 'en-US',
      market: 'US',
      language: 'English',
      status: 'verified',
      evidence: { [capability]: evidence },
    }],
  }
}

function createRouteOptions({ fixture, derived, counts, tempRoot, storageRoot }) {
  const {
    buildGeneratedCoverageManifest,
    canonicalCoverageSha256,
  } = require(path.join(backendRoot, 'src', 'services', 'redrawFullFrameCoverageService'))
  const {
    canonicalizeModelLock,
    canonicalSha256: canonicalModelLockSha256,
  } = require(path.join(backendRoot, 'src', 'services', 'redrawFullFrameModelLockService'))
  const { validateReviewedCoverageManifest } = require(
    path.join(backendRoot, 'src', 'services', 'redrawFullFrameReviewService'),
  )
  const sharp = require(path.join(backendRoot, 'node_modules', 'sharp'))
  const modelLock = localModelLock(canonicalizeModelLock, canonicalModelLockSha256)
  const pack = {
    id: 'en-US@local-product',
    locale: 'en-US',
    model_manifest_sha256: '3'.repeat(64),
    calibration_manifest_sha256: '4'.repeat(64),
  }
  const localVoiceVerifierAllowedRoot = path.join(tempRoot, 'local-voice-verifier')
  fs.mkdirSync(localVoiceVerifierAllowedRoot, { recursive: true, mode: 0o700 })
  const localManifestBase = {
    schema_version: 'local-tts-manifest-v1',
    engine: 'eSpeak NG',
    engine_version: '1.52.0-test-contract',
    executable_path: path.join(tempRoot, 'uninstalled-espeak-ng-test-contract.exe'),
    executable_sha256: sha256('test-only-uninstalled-espeak-ng-contract'),
    profiles: redrawLocalEnglishVoiceProfiles.map((profile) => ({ ...profile })),
    test_only: true,
  }
  const localTtsManifest = {
    ...localManifestBase,
    manifest_sha256: sha256(Buffer.from(stableJson(localManifestBase), 'utf8')),
  }
  const cleanProviderSignatures = new Set()
  const localeVerifier = {
    assertReady(locale) {
      if (normalizeLocalVerifierLocale(locale, pack.locale) !== pack.locale) {
        throw new Error('local verifier locale mismatch')
      }
      return { ...pack }
    },
    async verifyLocalVoice(input) {
      counts.localeVerificationCalls += 1
      const audioSha256 = sha256(fs.readFileSync(input.audioPath))
      if (audioSha256 !== input.audioSha256) throw new Error('local voice audio hash mismatch')
      return {
        requestId: input.requestId,
        source: 'offline-worker',
        audioSha256,
        approvedTextSha256: sha256(Buffer.from(input.approvedText, 'utf8')),
        localePack: pack.id,
        languageVerified: true,
        detectedLocale: pack.locale,
        transcriptSha256: sha256(Buffer.from(`test-only-transcript:${input.approvedText}`, 'utf8')),
        modelManifestSha256: pack.model_manifest_sha256,
        calibrationManifestSha256: pack.calibration_manifest_sha256,
        metrics: { word_error_rate: 0, character_error_rate: 0, critical_tokens_match: true },
        localTtsInvocation: structuredClone(input.localTtsInvocation),
        completedAt: new Date().toISOString(),
      }
    },
  }
  assertPaidAcceptanceLocaleVerifierReady({ localeVerifier, locale: pack.locale })
  const localeRegistry = {
    assertReady(request) {
      const locale = typeof request === 'string' ? request : request?.locale
      if (locale !== pack.locale
        || (request?.packId !== undefined && request.packId !== pack.id)
        || (request?.model_manifest_sha256 !== undefined
          && request.model_manifest_sha256 !== pack.model_manifest_sha256)
        || (request?.calibration_manifest_sha256 !== undefined
          && request.calibration_manifest_sha256 !== pack.calibration_manifest_sha256)) {
        throw new Error('local registry locale mismatch')
      }
      return { ...pack }
    },
    assertEvidenceTrusted(evidence) {
      if (evidence?.source !== 'offline-worker'
        || evidence?.locale_pack !== pack.id
        || evidence?.model_manifest_sha256 !== pack.model_manifest_sha256
        || evidence?.calibration_manifest_sha256 !== pack.calibration_manifest_sha256) {
        throw new Error('local verifier evidence mismatch')
      }
      return evidence
    },
  }
  const localTtsWorker = {
    assertReady(locale) {
      if (locale !== redrawLocalEnglishVoiceFixture.locale) {
        throw new Error('test-only local TTS locale mismatch')
      }
    },
    assertEvidenceTrusted(evidence) {
      const expectedKeys = [
        'binary_sha256', 'engine', 'engine_version', 'manifest_sha256',
        'profile', 'source', 'target_locale', 'test_only',
      ]
      if (!evidence || Object.keys(evidence).sort().join(',') !== expectedKeys.sort().join(',')) {
        throw new Error('test-only local TTS evidence shape mismatch')
      }
      const profile = localTtsManifest.profiles.find((item) => item.profile_key === evidence.profile)
      if (!profile
        || evidence.source !== 'local_offline_tts'
        || evidence.engine !== localTtsManifest.engine
        || evidence.engine_version !== localTtsManifest.engine_version
        || evidence.binary_sha256 !== localTtsManifest.executable_sha256
        || evidence.manifest_sha256 !== localTtsManifest.manifest_sha256
        || evidence.target_locale !== profile.locale
        || evidence.test_only !== true) {
        throw new Error('test-only local TTS evidence mismatch')
      }
      return { profile: { ...profile } }
    },
    async synthesize(input) {
      counts.localTtsSyntheses += 1
      const profile = localTtsManifest.profiles.find((item) => item.profile_key === input.profileKey)
      if (!profile || input.locale !== profile.locale) throw new Error('test-only local TTS profile mismatch')
      const outputPath = path.join(input.outputRoot, `${profile.profile_key}.wav`)
      const fixtureAudio = writeRedrawLocalEnglishVoiceFixture(outputPath)
      return {
        source: 'local_offline_tts',
        engine: localTtsManifest.engine,
        engine_version: localTtsManifest.engine_version,
        binary_sha256: localTtsManifest.executable_sha256,
        manifest_sha256: localTtsManifest.manifest_sha256,
        target_locale: profile.locale,
        output_path: outputPath,
        output_sha256: fixtureAudio.audio_sha256,
        profile: { ...profile },
        completed_at: new Date().toISOString(),
        test_only: true,
      }
    },
  }
  const localVoiceMediaProbe = {
    async probeAudio(input) {
      const media = inspectMedia(input.audioPath)
      const audioStreams = media.probe.streams.filter((stream) => stream.codec_type === 'audio')
      const durationMs = Math.round(Number(media.probe.format?.duration) * 1000)
      if (media.sha256 !== redrawLocalEnglishVoiceFixture.audio_sha256
        || audioStreams.length !== 1
        || !Number.isSafeInteger(durationMs)) {
        throw new Error('test-only local voice media mismatch')
      }
      return {
        format: 'wav',
        audio_streams: 1,
        decodable: true,
        non_silent: true,
        duration_ms: durationMs,
        size_bytes: fs.statSync(input.audioPath).size,
      }
    },
  }

  async function coverageRegistrationProvider(request) {
    counts.coverageProviderCalls += 1
    assertRedrawLiveProviderEnvelope(request, 'coverage')
    await writeReviewedCoverage({
      outputDir: request.outputDir,
      input: request.input,
      fixture,
      sourceFrames: derived.sourceFrames,
      buildGeneratedCoverageManifest,
      canonicalCoverageSha256,
      modelLock,
      sharp,
      validateReviewedCoverageManifest,
    })
    return {
      status: 'completed',
      provider_task_id: 'local-coverage-task',
      reviewed_manifest_relative_path: 'redraw-full-frame-reviewed-manifest.json',
    }
  }

  async function assetGenerationProvider(request) {
    assertRedrawLiveProviderEnvelope(request, 'clean')
    const signature = [request.input.mode, request.input.source_asset_id, request.input.mask_asset_id].join(':')
    if (cleanProviderSignatures.has(signature)) throw new Error('clean provider requirement resubmitted')
    cleanProviderSignatures.add(signature)
    counts.cleanProviderCalls += 1
    const shotId = String(request.input?.shot_id || '')
    const fixtureIndex = requiredRedrawLiveFixtureShotIndex(fixture, shotId)
    const frame = derived.motions[fixtureIndex].frame
    fs.writeFileSync(path.join(request.outputDir, 'clean.png'), frame.bytes)
    return {
      status: 'completed',
      provider_task_id: `local-clean-${fixtureIndex + 1}`,
      output: { relative_path: 'clean.png' },
      quality: {
        width: fixture.source.width,
        height: fixture.source.height,
        mime_type: 'image/png',
        mask_area_changed: true,
        non_mask_similarity: 0.99,
      },
    }
  }

  const disabledPaidProvider = async () => {
    counts.providerPaidSubmits += 1
    throw new Error('provider paid submit blocked')
  }
  return {
    localeVerifier,
    localeRegistry,
    localTtsWorker,
    localTtsManifest,
    localVoiceMediaProbe,
    localVoiceVerifierAllowedRoot,
    localVoiceAudioStorageRoot: storageRoot,
    localVoiceRegistrationContext: 'test',
    allowTestOnlyLocalEvidence: true,
    localizationProvider: async (input) => ({
      status: 'completed',
      provider_task_id: 'local-localization-task',
      result: localizedFactsFromFixture(fixture, input),
    }),
    assetGenerationProvider,
    dialogueProvider: disabledPaidProvider,
    coverageRegistrationProvider,
    redrawOptions: {
      analysisOptions: {
        provider: {
          startAnalysis: async (request) => ({
            status: 'completed',
            provider_task_id: 'local-analysis-task',
            result_asset_id: request.sourceAssetId,
            facts: sourceFactsFromFixture(fixture),
          }),
        },
      },
      generationService: disabledGenerationService(counts),
      capabilityService: {
        listPublicStylePresets: () => [{
          id: 1,
          stable_key: 'local-product-live-action',
          name: 'Local Product Live Action',
          category: 'live_action',
          verification_evidence_json: JSON.stringify({ source: 'local-product' }),
        }],
        listLocaleCapabilities: () => [{
          locale: fixture.locale,
          market: fixture.market,
          status: 'full_output',
          blocking: [],
        }],
      },
    },
  }
}

export function assertRedrawLiveProviderEnvelope(request, label) {
  if (!request || Object.keys(request).sort().join(',') !== 'input,outputDir') {
    throw new Error(`${label} provider contract drift`)
  }
  if (Object.keys(request.input || {}).some((key) => /^(?:db|database|storage|storage[_-]?root|asset[_-]?reader)$/i.test(key))) {
    throw new Error(`${label} provider received forbidden context`)
  }
}

export function redrawLiveCoverageTextDescriptors(fixture, shotId) {
  const shot = fixture?.shots?.find((entry) => entry.shot_id === shotId)
  if (!shot) throw new Error('coverage text shot missing')
  return (shot.text_regions || []).map((region) => {
    const regionKey = String(region?.region_key || '').trim()
    if (!regionKey) throw new Error('coverage text region key missing')
    if (region.kind === 'text_subtitle') {
      return {
        region_key: regionKey,
        kind: 'subtitle',
        treatment: 'translate_subtitle',
        target_text_key: regionKey,
      }
    }
    if (region.kind === 'text_screen') {
      return {
        region_key: regionKey,
        kind: 'screen',
        treatment: 'localize_screen',
        target_text_key: regionKey,
      }
    }
    throw new Error('coverage text kind is unsupported')
  })
}

async function writeReviewedCoverage(input) {
  const frameMetadata = await Promise.all(input.sourceFrames.map(async (frame) => {
    const metadata = await input.sharp(frame.bytes).metadata()
    return { width: Number(metadata.width), height: Number(metadata.height) }
  }))
  const maskBytes = await input.sharp({
    create: {
      width: input.fixture.source.width,
      height: input.fixture.source.height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  }).toColourspace('b-w').png().toBuffer()
  const frames = []
  const personTracks = []
  const textTracks = []
  for (let index = 0; index < input.fixture.shots.length; index += 1) {
    const shot = input.fixture.shots[index]
    const dimensions = frameMetadata[index]
    if (dimensions.width !== input.fixture.source.width
      || dimensions.height !== input.fixture.source.height) {
      throw new Error('source frame dimensions drifted')
    }
    const frameRelative = `frames/frame-${index + 1}.png`
    const frameSha = writeProviderFile(input.outputDir, frameRelative, input.sourceFrames[index].bytes)
    const personRegionIds = []
    for (let personIndex = 0; personIndex < shot.character_ids.length; personIndex += 1) {
      const characterId = shot.character_ids[personIndex]
      const regionId = `person-${index + 1}-${personIndex + 1}`
      const maskRelative = `masks/${regionId}.png`
      const maskSha = writeProviderFile(input.outputDir, maskRelative, maskBytes)
      personRegionIds.push(regionId)
      personTracks.push({
        track_key: `track-${characterId}-${index + 1}`,
        kind: 'story_role',
        source_character_key: characterId,
        target_strategy: 'fixed_actor',
        frame_ranges: [{ start_frame: index, end_frame: index }],
        visibility: [{ start_frame: index, end_frame: index, state: 'visible' }],
        regions: [{
          region_id: regionId,
          frame_index: index,
          bbox: { x: 0, y: 0, width: dimensions.width, height: dimensions.height },
          mask: {
            path: maskRelative,
            sha256: maskSha,
            width: dimensions.width,
            height: dimensions.height,
            mime_type: 'image/png',
          },
          association_confidence: 0.99,
          detector_disagreement: false,
        }],
        review_status: 'pending',
        reviewer: null,
      })
    }
    const textRegionIds = []
    for (const [textIndex, descriptor] of redrawLiveCoverageTextDescriptors(input.fixture, shot.shot_id).entries()) {
      const textRegionId = `text-${index + 1}-${textIndex + 1}`
      const textMaskRelative = `masks/${textRegionId}.png`
      const textMaskSha = writeProviderFile(input.outputDir, textMaskRelative, maskBytes)
      textRegionIds.push(textRegionId)
      textTracks.push({
        ...descriptor,
        frame_ranges: [{ start_frame: index, end_frame: index }],
        regions: [{
          region_id: textRegionId,
          frame_index: index,
          polygon: [
            { x: 0, y: 0 },
            { x: dimensions.width, y: 0 },
            { x: dimensions.width, y: dimensions.height },
          ],
          mask: {
            path: textMaskRelative,
            sha256: textMaskSha,
            width: dimensions.width,
            height: dimensions.height,
            mime_type: 'image/png',
          },
        }],
        review_status: 'pending',
        reviewer: null,
      })
    }
    const timestampMs = Math.floor((shot.start_ms + shot.end_ms) / 2)
    frames.push({
      frame_index: index,
      timestamp_ticks: timestampMs,
      timestamp_ms: timestampMs,
      shot_id: shot.shot_id,
      path: frameRelative,
      sha256: frameSha,
      width: dimensions.width,
      height: dimensions.height,
      person_region_ids: personRegionIds,
      text_region_ids: textRegionIds,
      review_point_reasons: [],
      review_status: 'not_required',
    })
  }
  const manifest = await input.buildGeneratedCoverageManifest({
    evidenceRoot: input.outputDir,
    source: {
      sha256: input.input.source_fingerprint,
      duration_ms: input.input.duration_ms,
      width: input.fixture.source.width,
      height: input.fixture.source.height,
      frame_count: frames.length,
      time_base: { numerator: 1, denominator: 1000 },
    },
    shots: input.input.shots,
    frames,
    personTracks,
    textTracks,
    modelLock: input.modelLock,
  })
  manifest.status = 'reviewed'
  for (const frame of manifest.frames) {
    frame.review_status = frame.review_point_reasons.length ? 'reviewed' : 'not_required'
  }
  for (const track of [...manifest.person_tracks, ...manifest.text_tracks]) {
    track.review_status = 'reviewed'
    track.reviewer = 'codex-local-review'
  }
  manifest.review = {
    status: 'reviewed',
    reviewed: true,
    required_review_point_count: manifest.review.required_review_point_count,
    reviewed_point_count: manifest.review.required_review_point_count,
    reviewer: 'codex-local-review',
  }
  manifest.approval_status = 'pending'
  manifest.ready_for_reference = false
  manifest.analysis_sha256 = input.canonicalCoverageSha256(manifest)
  await input.validateReviewedCoverageManifest({
    evidenceRoot: input.outputDir,
    manifest,
  })
  fs.writeFileSync(
    path.join(input.outputDir, 'redraw-full-frame-reviewed-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

function localModelLock(canonicalizeModelLock, canonicalModelLockSha256) {
  const projects = {
    face_detector: ['MediaPipe face detection', 'google-ai-edge/mediapipe'],
    person_detector: ['YOLOX', 'Megvii-BaseDetection/YOLOX'],
    text_detector: ['PaddleOCR', 'PaddlePaddle/PaddleOCR'],
    tracker: ['ByteTrack', 'FoundationVision/ByteTrack'],
  }
  const lock = {
    schema_version: 'redraw-full-frame-model-lock-v2',
    runtimes: {
      main: {
        python_version: 'Python 3.11.9',
        interpreter_path: 'runtime/main/.venv/Scripts/python.exe',
        pip_freeze_path: 'runtime/main/pip-freeze.txt',
        pip_freeze_sha256: '1'.repeat(64),
      },
      text: {
        python_version: 'Python 3.11.9',
        interpreter_path: 'runtime/text/.venv/Scripts/python.exe',
        pip_freeze_path: 'runtime/text/pip-freeze.txt',
        pip_freeze_sha256: '2'.repeat(64),
      },
    },
    components: Object.entries(projects).map(([component, values]) => ({
      component,
      project: values[0],
      repository: values[1],
      revision: `local-${component}`,
      artifact_name: `${component}.bin`,
      artifact_path: `${component}/model.bin`,
      artifact_sha256: 'a'.repeat(64),
      license_name: `${component}-LICENSE`,
      license_evidence_path: `${component}/LICENSE.txt`,
      license_evidence_sha256: 'b'.repeat(64),
    })),
  }
  return {
    ...lock,
    canonical_sha256: canonicalModelLockSha256(canonicalizeModelLock(lock)),
  }
}

function writeProviderFile(root, relativePath, bytes) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, bytes)
  return sha256(bytes)
}

function sourceFactsFromFixture(fixture) {
  const sourceShots = new Map((fixture.source_facts?.shots || []).map((shot) => [shot.id, shot]))
  return {
    schema_version: '2.0',
    duration_ms: fixture.source.duration_ms,
    story: fixture.source_facts.causal_chain,
    characters: fixture.characters.map((character) => ({
      id: character.id,
      source_name: character.source_name,
      relationships: [],
    })),
    scenes: fixture.source_facts.scenes,
    props: fixture.source_facts.props,
    shots: fixture.shots.map((shot) => {
      const sourceShot = sourceShots.get(shot.shot_id) || {}
      const textRegions = (sourceShot.text_regions || []).map((region, index) => ({
        id: region.region_key,
        kind: region.kind === 'text_screen' ? 'screen_text' : 'subtitle',
        polygon: region.kind === 'text_screen'
          ? [[0.05, 0.1], [0.95, 0.1], [0.95, 0.75], [0.05, 0.75]]
          : [[0.05, 0.78], [0.95, 0.78], [0.95, 0.94], [0.05, 0.94]],
        source_text: region.kind === 'text_screen'
          ? sourceShot.screen_text
          : sourceShot.dialogue?.[index]?.text,
      }))
      return {
        id: shot.shot_id,
        index: shot.shot_index,
        start_ms: shot.start_ms,
        end_ms: shot.end_ms,
        composition: 'Vertical live action composition preserving the source framing',
        camera_movement: 'Preserve the source camera direction and movement',
        opening_state: shot.opening_state,
        continuous_action: shot.continuous_action,
        ending_state: shot.ending_state,
        visible_character_ids: shot.character_ids,
        dialogue: shot.source_dialogue.map((turn, index) => ({
          id: `${shot.shot_id}-turn-${index + 1}`,
          speaker_id: turn.speaker_id,
          start_ms: turn.start_ms,
          end_ms: turn.end_ms,
          source_text: turn.text,
        })),
        text_regions: textRegions,
        audio_contract: {
          dialogue_mode: shot.source_dialogue.length > 0 ? 'spoken' : 'silent',
          ambient_audio: 'preserve_or_rebuild',
        },
        confidence: {
          character_mapping: 0.99,
          speaker_mapping: 0.99,
          text_regions: 0.99,
          shot_boundary: 0.99,
        },
      }
    }),
    causal_chain: fixture.source_facts.causal_chain,
    locked_facts: fixture.source_facts.locked_facts,
    reversals: fixture.source_facts.reversals,
    episode_hook: fixture.source_facts.episode_hook,
  }
}

function localizedFactsFromFixture(fixture, request) {
  const providerInput = request?.input || request || {}
  const sourceFacts = providerInput.source_facts || {}
  const localizedByShot = new Map((fixture.localization.dialogue || []).map((row) => [row.shot_id, row]))
  const sourceShots = new Map((fixture.source_facts?.shots || []).map((shot) => [shot.id, shot]))
  const textMap = {}
  for (const shot of sourceFacts.shots || []) {
    const sourceShot = sourceShots.get(shot.id) || {}
    const localizedShot = localizedByShot.get(shot.id) || { turns: [] }
    for (let index = 0; index < (shot.text_regions || []).length; index += 1) {
      const region = shot.text_regions[index]
      textMap[`${shot.id}:${region.id}`] = region.kind === 'screen_text'
        ? sourceShot.screen_text_target
        : localizedShot.turns?.[index]?.localized_text
    }
  }
  return {
    facts_hash: sourceFacts.facts_hash,
    locale: request?.locale || fixture.locale,
    market: request?.market || fixture.market,
    name_map: Object.fromEntries(fixture.characters.map((character) => [
      character.id,
      character.name,
    ])),
    culture_map: fixture.localization.culture_map || {},
    glossary: fixture.localization.glossary || {},
    dialogue: (sourceFacts.shots || []).map((shot) => {
      const localized = localizedByShot.get(shot.id) || { turns: [] }
      return {
        shot_id: shot.id,
        turns: (shot.dialogue || []).map((turn, index) => ({
          id: turn.id,
          speaker_id: turn.speaker_id,
          start_ms: turn.start_ms,
          end_ms: turn.end_ms,
          localized_text: localized.turns?.[index]?.localized_text,
        })),
      }
    }),
    text_map: textMap,
    confidence: {
      names: 0.99,
      dialogue_semantics: 0.99,
      dialogue_timing: 0.99,
      culture: 0.99,
      screen_text: 0.99,
    },
  }
}

function disabledGenerationService(counts) {
  const fail = async () => {
    counts.generationSubmits += 1
    throw new Error('generation disabled for local acceptance')
  }
  return {
    resolveVerifiedGenerationModel: () => null,
    generateShot: fail,
    retryShot: fail,
    generateBatch: fail,
    reviewNativeAudio: fail,
  }
}

function sourceCharacterKey(asset) {
  let payload = asset?.source_ref || asset
  if (typeof asset?.source_ref_json === 'string') {
    try { payload = JSON.parse(asset.source_ref_json) } catch (_) { payload = {} }
  }
  return String(
    payload?.source_ref?.source_character_key
    || payload?.source_character_key
    || '',
  )
}

function multipartBody({ filePath, mimeType, fields = {} }) {
  const boundary = `----redraw-local-${crypto.randomBytes(16).toString('hex')}`
  const chunks = []
  const append = (value) => chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value))
  for (const [name, value] of Object.entries(fields || {})) {
    append(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
  }
  const filename = path.basename(filePath).replace(/["\r\n]/g, '_')
  append(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`)
  append(`Content-Type: ${mimeType}\r\n\r\n`)
  append(fs.readFileSync(filePath))
  append(`\r\n--${boundary}--\r\n`)
  return { boundary, body: Buffer.concat(chunks) }
}

function billingSnapshot(db) {
  const reservation = db.prepare(`SELECT
    COUNT(*) AS rows,
    COALESCE(SUM(amount), 0) AS reserved,
    COALESCE(SUM(CASE WHEN status = 'held' THEN amount ELSE 0 END), 0) AS held,
    COALESCE(SUM(CASE WHEN status = 'confirmed' THEN amount ELSE 0 END), 0) AS charged
    FROM tenant_usage_reservations`).get()
  return {
    rows: Number(reservation.rows),
    reserved: Number(reservation.reserved),
    held: Number(reservation.held),
    charged: Number(reservation.charged),
  }
}

function assertZeroCostSummary(summary) {
  const keys = [
    'generation_submits',
    'external_fetches',
    'provider_paid_submits',
    'voice_provider_calls',
    'reservation_rows',
    'reservation_delta',
    'reserved_credits',
    'held_credits',
    'charged_credits',
  ]
  for (const key of keys) {
    if (Number(summary[key]) !== 0) throw new Error(`zero-cost invariant failed: ${key}`)
  }
}

function publicShot(shot) {
  return {
    id: Number(shot.id),
    shot_index: Number(shot.shot_index),
    preparation_state: shot.preparation_state,
    updated_at: shot.updated_at,
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function requiredRedrawLiveFixtureShotIndex(fixture, shotId) {
  const fixtureIndex = Array.isArray(fixture?.shots)
    ? fixture.shots.findIndex((shot) => shot.shot_id === shotId)
    : -1
  if (fixtureIndex < 0) throw new Error('clean provider shot contract drift')
  return fixtureIndex
}

function stableJson(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`
}

async function jsonResponse(response, expectedStatus, routeErrors = []) {
  const text = await response.text()
  let payload = {}
  try {
    payload = text ? JSON.parse(text) : {}
  } catch (_) {
    throw new Error(`local product route returned non-json status ${response.status}`)
  }
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus]
  if (!expected.includes(response.status)) {
    const code = payload?.error?.code || payload?.code || 'unknown'
    const message = sanitizeRouteError(payload?.error?.message || payload?.message || '')
    const routeError = routeErrors.at(-1)
    throw new Error(
      `local product route status ${response.status} code ${code}`
      + `${message ? ` message ${message}` : ''}`
      + `${routeError ? ` route_error ${routeError}` : ''}`,
    )
  }
  return payload.data ?? payload
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server) {
  server.closeAllConnections?.()
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function harnessLog(routeErrors) {
  return {
    info() {},
    warn() {},
    debug() {},
    error(first) {
      const error = first?.err || first
      const code = String(error?.code || error?.name || 'error').replace(/[^A-Za-z0-9_-]/g, '_')
      routeErrors.push(`${code}:${sanitizeRouteError(error?.message)}`)
      if (routeErrors.length > 5) routeErrors.shift()
    },
  }
}

function sanitizeRouteError(value) {
  return String(value || '')
    .replace(/[A-Za-z]:[\\/][^\s"]+/g, '[path]')
    .replace(/\/(?:Users|home)\/[^\s"]+/g, '[path]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/(?:api[_-]?key|provider[_-]?secret|authorization)\s*[:=]\s*[^\s,}]+/gi, '[secret]=[redacted]')
    .slice(0, 180)
}
