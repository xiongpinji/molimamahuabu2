import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const backendRoot = fileURLToPath(new URL('../../../backend-node/', import.meta.url))

const express = require(path.join(backendRoot, 'node_modules', 'express'))
const Database = require(path.join(backendRoot, 'node_modules', 'better-sqlite3'))
const { runMigrationsAndEnsure } = require(path.join(backendRoot, 'src', 'db', 'migrate'))
const { setupRouter } = require(path.join(backendRoot, 'src', 'routes'))
const creditLedger = require(path.join(backendRoot, 'src', 'services', 'creditLedgerService'))
const modelPrices = require(path.join(backendRoot, 'src', 'services', 'modelPriceService'))
const { buildLocalizationInput } = require(path.join(backendRoot, 'src', 'services', 'localizationService'))
const { createStaticOwnershipMiddleware } = require(path.join(backendRoot, 'src', 'middleware', 'resourceOwnership'))

const TENANT_ID = 'redraw-live-dry-run-tenant'
const USER_ID = 'redraw-live-dry-run-user'

export async function createRedrawLiveProductHarness({ fixture }) {
  if (!fixture?.shots?.length) throw new Error('redraw live fixture is required')
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-live-product-'))
  const storageRoot = path.join(tempRoot, 'storage')
  fs.mkdirSync(storageRoot, { recursive: true })
  const db = new Database(path.join(tempRoot, 'redraw-live.sqlite'))
  runMigrationsAndEnsure(db)
  seedDryRunProductConfig(db, storageRoot)

  const counts = {
    generationSubmits: 0,
    externalFetches: 0,
    fakeProviderCalls: 0,
  }
  const routeErrors = []
  const authToken = `dry-run-${crypto.randomUUID()}`
  const analysisFacts = sourceFactsFromFixture(fixture)
  let baseUrl = ''
  let closed = false

  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use(express.urlencoded({ extended: true }))
  app.use('/static', createStaticOwnershipMiddleware({ db, enabled: true, log: harnessLog(routeErrors) }), express.static(storageRoot))
  app.use((req, _res, next) => {
    if (isGeneratePath(req.path) || isProviderConnectionPath(req.path)) {
      counts.generationSubmits += 1
      next(new Error('generate route blocked'))
      return
    }
    req.tenant = { id: TENANT_ID }
    req.user = { id: USER_ID, email: 'redraw-live-dry-run@example.test' }
    next()
  })
  app.use('/api/v1', setupRouter({
    app: { name: 'redraw live product dry run', version: 'test' },
    server: { cors_origins: [] },
    storage: { local_path: storageRoot, base_url: '' },
  }, db, harnessLog(routeErrors), {
    localizationProvider: async (input) => ({
      provider_task_id: `dry-run-localization-${input.locale || fixture.locale}`,
      result: localizedFactsFromFixture(fixture, input, input.input.source_facts),
    }),
    assetGenerationProvider: async () => {
      counts.fakeProviderCalls += 1
      throw new Error('asset provider is disabled for dry-run launcher')
    },
    dialogueProvider: async () => {
      counts.fakeProviderCalls += 1
      throw new Error('dialogue provider is disabled for dry-run launcher')
    },
    redrawOptions: {
      uploadLimits: { minDurationMs: 1_000, maxDurationMs: 60_000 },
      uploadService: {
        async expandSourceUpload(file) {
          return expandFixtureSourceUpload(file, fixture, storageRoot)
        },
      },
      referenceBundleService: createDryRunReferenceBundleService(db),
      referencePreparationProvider: async () => {
        counts.fakeProviderCalls += 1
        throw new Error('reference preparation provider is disabled for dry-run launcher')
      },
      canReadArtifact: (assetId) => canReadAsset(db, storageRoot, assetId),
      capabilityService: {
        listPublicStylePresets: () => [{
          id: 1,
          stable_key: 'dry-run-product-live',
          name: 'Dry Run Product Live',
          category: 'live_action',
          verification_evidence_json: JSON.stringify({ source: 'local-dry-run' }),
        }],
        listLocaleCapabilities: () => [{
          locale: fixture.locale,
          market: fixture.market,
          status: 'full_output',
          blocking: [],
        }],
      },
      analysisOptions: {
        provider: {
          startAnalysis: async () => ({
            status: 'completed',
            provider_task_id: 'dry-run-analysis-local',
            result_asset_id: 1,
            facts: analysisFacts,
          }),
        },
      },
      generationService: disabledGenerationService(counts),
    },
  }))
  app.use((error, _req, res, _next) => {
    res.status(500).json({ success: false, error: { code: 'DRY_RUN_BLOCKED', message: error.message } })
  })

  const server = http.createServer(app)
  await listen(server)
  baseUrl = `http://127.0.0.1:${server.address().port}`

  async function guardedFetch(target, init = {}) {
    const url = new URL(target, baseUrl)
    if (!isLocalhost(url)) {
      throw new Error('external fetch blocked')
    }
    if (isGeneratePath(url.pathname) || isProviderConnectionPath(url.pathname)) {
      throw new Error('generate route blocked')
    }
    return fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${authToken}`,
        'X-Tenant-Id': TENANT_ID,
        ...(init.headers || {}),
      },
    })
  }

  async function prepareDryRun() {
    const project = await postJson('/api/v1/redraw/projects', fixture.project, { expectedStatus: 201 })
    const projectId = Number(project.id)
    const work = await uploadSource(projectId)
    const workId = Number(work.id)
    await postJson(`/api/v1/redraw/works/${workId}/analyze`, {
      style_preset_id: 1,
      locale: fixture.locale,
      market: fixture.market,
      aspect_ratio: '16:9',
    }, { expectedStatus: [201, 202] })
    const quote = await postJson(`/api/v1/redraw/works/${workId}/localization-quote`, {
      locale: fixture.locale,
      market: fixture.market,
      localization_level: 'faithful',
    })
    const versionStart = await postJson(`/api/v1/redraw/works/${workId}/versions`, {
      locale: fixture.locale,
      market: fixture.market,
      localization_level: 'faithful',
      quote_hash: quote.quote_hash,
      idempotency_key: `dry-run-localization-${workId}`,
    }, { expectedStatus: 202 })
    const versionId = Number(versionStart.version_id)
    if (!Number.isSafeInteger(versionId) || versionId <= 0) throw new Error('dry-run localization did not create a version')
    await waitForTask(versionStart.task_id, 'redraw_localization')

    const shots = await loadVersionShots(workId, versionId)
    if (shots.length !== fixture.shots.length) throw new Error(`dry-run expected ${fixture.shots.length} shots, got ${shots.length}`)
    for (const shot of shots) {
      await markReferenceReady(shot)
    }
    await getJson(`/api/v1/redraw/versions/${versionId}/preparation-gate`)
    await getJson(`/api/v1/redraw/versions/${versionId}/generation-gate`)
    const readyShots = await loadVersionShots(workId, versionId)
    const referenceReady = readyShots.filter((shot) => shot.preparation_state === 'reference_ready')
    if (referenceReady.length !== fixture.shots.length) {
      throw new Error(`dry-run reference_ready mismatch: ${referenceReady.length}/${fixture.shots.length}`)
    }

    const summary = {
      dry_run: true,
      project_id: projectId,
      work_id: workId,
      version_id: versionId,
      shot_count: readyShots.length,
      reference_ready: referenceReady.length,
      generation_submits: counts.generationSubmits,
      external_fetches: counts.externalFetches,
      fake_provider_calls: counts.fakeProviderCalls,
      skipped_live_post: true,
    }
    return {
      counts: { ...counts },
      shots: readyShots.map(publicShot),
      context: {
        authToken,
        tenantId: TENANT_ID,
        workId,
        versionId,
        shotIds: readyShots.map((shot) => Number(shot.id)),
        locale: fixture.locale,
        market: fixture.market,
      },
      summary,
    }
  }

  async function postJson(pathname, body, { expectedStatus = 200 } = {}) {
    return jsonResponse(await guardedFetch(pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), expectedStatus, routeErrors)
  }

  async function getJson(pathname) {
    return jsonResponse(await guardedFetch(pathname), 200, routeErrors)
  }

  async function waitForTask(taskId, label) {
    if (!taskId) throw new Error(`dry-run ${label} task id missing`)
    const deadline = Date.now() + 10_000
    let lastStatus = 'unknown'
    while (Date.now() < deadline) {
      const task = await getJson(`/api/v1/tasks/${encodeURIComponent(taskId)}`)
      lastStatus = String(task?.status || 'unknown')
      if (lastStatus === 'completed') return task
      if (['failed', 'needs_attention', 'cancelled'].includes(lastStatus)) {
        const reason = sanitizeRouteError(task?.error || task?.message || '')
        throw new Error(`dry-run ${label} task ended ${lastStatus}${reason ? ` reason ${reason}` : ''}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`dry-run ${label} task timeout status ${lastStatus}`)
  }

  async function uploadSource(projectId) {
    const form = new FormData()
    form.set('file', new Blob([Buffer.from('redraw live dry run source placeholder')], { type: fixture.source.mime_type }), fixture.source.filename)
    const payload = await jsonResponse(await guardedFetch(`/api/v1/redraw/projects/${projectId}/works`, {
      method: 'POST',
      body: form,
    }), 201, routeErrors)
    const work = Array.isArray(payload.items) ? payload.items[0] : payload
    if (!work?.id) throw new Error('dry-run upload did not return a work id')
    return work
  }

  async function loadVersionShots(workId, versionId) {
    const work = await getJson(`/api/v1/redraw/works/${workId}`)
    if (Number(work.version_id) !== Number(versionId)) {
      throw new Error('dry-run work projection did not promote localized version')
    }
    const sourceAssetId = Number(work.source_asset_id)
    return Array.isArray(work.shots)
      ? work.shots.map((shot) => ({ ...shot, source_asset_id: sourceAssetId }))
      : []
  }

  async function markReferenceReady(shot) {
    const fixtureShot = fixture.shots[Number(shot.shot_index) - 1]
    await guardedFetch(`/api/v1/redraw/shots/${Number(shot.id)}/reference-bundle`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_updated_at: shot.updated_at,
        motion_reference_asset_id: Number(shot.source_asset_id),
        face_tracks: [{ character_id: fixtureShot.character_id, stable: true, frame_coverage: 0.95 }],
        text_regions: [{ content: 'no original text retained', status: 'absent' }],
        coverage_review: { status: 'approved', reviewer: 'dry-run-local-product-route' },
      }),
    }).then((response) => jsonResponse(response, 200, routeErrors))
  }

  async function close() {
    if (closed) return
    closed = true
    await closeServer(server)
    db.close()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }

  return { prepareDryRun, guardedFetch, close }
}

export function redactLiveProductSummary(result) {
  const summary = result?.summary || {}
  return {
    dry_run: summary.dry_run === true,
    project_id: summary.project_id,
    work_id: summary.work_id,
    version_id: summary.version_id,
    shot_count: summary.shot_count,
    reference_ready: summary.reference_ready,
    generation_submits: summary.generation_submits,
    external_fetches: summary.external_fetches,
    fake_provider_calls: summary.fake_provider_calls,
    skipped_live_post: summary.skipped_live_post === true,
    context: {
      tenant_id: result?.context?.tenantId,
      shot_ids: result?.context?.shotIds || [],
      locale: result?.context?.locale,
      market: result?.context?.market,
    },
  }
}

function sourceFactsFromFixture(fixture) {
  return {
    schema_version: '2.0',
    duration_ms: fixture.source.duration_ms,
    story: ['A retail team prepares a concise nine-shot product review for acceptance.'],
    characters: fixture.characters.map((character) => ({
      id: character.id,
      source_name: character.name,
      display_name: character.name,
      relationship: character.role,
    })),
    scenes: [{
      id: 'studio',
      location: 'bright retail studio',
      time: 'day',
      source_ranges: [{ start_ms: 0, end_ms: fixture.source.duration_ms }],
    }],
    props: [{
      id: 'product-box',
      name: 'product sample box',
      evidence_ranges: [{ start_ms: 0, end_ms: fixture.source.duration_ms }],
    }],
    shots: fixture.shots.map((shot) => ({
      id: `shot-${shot.shot_index}`,
      index: shot.shot_index,
      start_ms: shot.start_ms,
      end_ms: shot.end_ms,
      composition: 'product foreground with speaker visible',
      camera_movement: 'locked',
      opening_state: shot.opening_state,
      continuous_action: shot.continuous_action,
      ending_state: shot.ending_state,
      visible_character_ids: [shot.character_id],
      dialogue: [{
        id: `shot-${shot.shot_index}-line-1`,
        speaker_id: shot.character_id,
        start_ms: shot.start_ms + 500,
        end_ms: shot.end_ms - 500,
        source_text: `source dialogue ${shot.shot_index}`,
      }],
      text_regions: [],
      audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
      confidence: { character_mapping: 0.98, speaker_mapping: 0.98, text_regions: 0.98, shot_boundary: 0.98 },
    })),
    causal_chain: ['The team prepares the sample', 'The customer confirms the presentation', 'The review becomes ready for live acceptance'],
    locked_facts: ['The product remains the focus', 'The locale is English'],
    reversals: ['Packaging clarity improves before approval'],
    episode_hook: 'The final shot confirms the product review is ready.',
  }
}

function localizedFactsFromFixture(fixture, input, facts) {
  return {
    facts_hash: facts.facts_hash,
    locale: input.locale || fixture.locale,
    market: input.market || fixture.market,
    name_map: Object.fromEntries(fixture.characters.map((character) => [character.id, character.name])),
    culture_map: { studio: 'bright retail studio' },
    glossary: { 'product-box': 'product sample box' },
    dialogue: fixture.shots.map((shot) => ({
      shot_id: `shot-${shot.shot_index}`,
      turns: [{
        id: `shot-${shot.shot_index}-line-1`,
        speaker_id: shot.character_id,
        localized_text: shot.localized_dialogue,
      }],
    })),
    text_map: {},
    confidence: {
      names: 0.99,
      dialogue_semantics: 0.99,
      dialogue_timing: 0.99,
      culture: 0.99,
      screen_text: 0.99,
    },
  }
}

function expandFixtureSourceUpload(file, fixture, storageRoot) {
  const relativePath = `redraw-live-dry-run/${crypto.randomUUID()}-${fixture.source.filename}`
  const absolutePath = path.join(storageRoot, relativePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.copyFileSync(file.path, absolutePath)
  const buffer = fs.readFileSync(absolutePath)
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
  return [{
    name: fixture.source.filename,
    type: 'video',
    category: 'redraw_source',
    url: `/static/${relativePath.replaceAll(path.sep, '/')}`,
    local_path: relativePath.replaceAll(path.sep, '/'),
    file_size: buffer.length,
    mime_type: fixture.source.mime_type,
    width: fixture.source.width,
    height: fixture.source.height,
    duration: fixture.source.duration_ms / 1000,
    duration_ms: fixture.source.duration_ms,
    sha256,
    source_fingerprint: sha256,
  }]
}

function seedDryRunProductConfig(db, storageRoot) {
  const now = new Date().toISOString()
  const relativeEvidencePath = 'redraw-live-dry-run/analysis-evidence.json'
  const evidencePath = path.join(storageRoot, relativeEvidencePath)
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true })
  fs.writeFileSync(evidencePath, JSON.stringify({ contract: 'redraw-live-dry-run-analysis-evidence-v1' }))
  const analysisEvidenceAssetId = Number(db.prepare(`
    INSERT INTO assets
      (name, type, category, url, local_path, file_size, mime_type, created_at, updated_at)
    VALUES ('Dry Run Analysis Evidence', 'text', 'redraw', '/static/redraw-live-dry-run/analysis-evidence.json',
      ?, ?, 'application/json', ?, ?)
  `).run(relativeEvidencePath, fs.statSync(evidencePath).size, now, now).lastInsertRowid)
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('video_understanding', 'local-dry-run', 'Dry Run Analysis', 'fake-analysis', 'fake-analysis',
      1, 1, 0, ?, ?, ?)
  `).run(JSON.stringify({
    real_generation_verified: true,
    evidence: {
      provider_task_id: 'dry-run-analysis-evidence',
      result_asset_id: analysisEvidenceAssetId,
      result_asset_readable: true,
      completed_at: now,
    },
  }), now, now)
  db.prepare(`
    INSERT INTO ai_service_configs
      (service_type, provider, name, model, default_model, is_active, is_default, priority, settings, created_at, updated_at)
    VALUES ('text', 'local-dry-run', 'Dry Run Localizer', 'fake-localizer', 'fake-localizer',
      1, 1, 10, ?, ?, ?)
  `).run(JSON.stringify({
    redraw_locale_capabilities: [{
      locale: 'en-US',
      market: 'US',
      status: 'verified',
      evidence: {
        text: {
          provider: 'local-dry-run',
          model: 'fake-localizer',
          task_id: 'dry-run-localization-evidence-en-US',
          terminal_status: 'completed',
          artifact_id: analysisEvidenceAssetId,
        },
      },
    }],
  }), now, now)
  modelPrices.set(db, 'fake-analysis', 1, { category: 'text' })
  modelPrices.set(db, 'fake-localizer', 1, { category: 'text' })
  creditLedger.setTenantAccountBalance(db, TENANT_ID, 1_000)
}

function createDryRunReferenceBundleService(db) {
  return {
    loadCurrentReferenceBundle(_ctx, shotId) {
      return loadBundle(db, shotId)
    },
    async saveReferenceBundle(_ctx, input) {
      const bundle = {
        motion_reference_asset_id: Number(input.motion_reference_asset_id),
        face_tracks: input.face_tracks || [],
        text_regions: input.text_regions || [],
        coverage_review: input.coverage_review || {},
      }
      const serialized = JSON.stringify(bundle)
      const hash = crypto.createHash('sha256').update(serialized).digest('hex')
      const now = new Date().toISOString()
      db.prepare(`
        UPDATE redraw_shots
        SET reference_bundle_json = ?,
            reference_bundle_hash = ?,
            reference_bundle_updated_at = ?,
            preparation_state = 'reference_ready',
            updated_at = ?
        WHERE id = ?
      `).run(serialized, hash, now, now, Number(input.shot_id))
      return loadBundle(db, input.shot_id)
    },
  }
}

function loadBundle(db, shotId) {
  const row = db.prepare('SELECT id, reference_bundle_json, reference_bundle_hash, reference_bundle_updated_at FROM redraw_shots WHERE id = ?').get(Number(shotId))
  return {
    shot_id: Number(row?.id || shotId),
    reference_bundle_hash: row?.reference_bundle_hash || null,
    reference_bundle_updated_at: row?.reference_bundle_updated_at || null,
    bundle: row?.reference_bundle_json ? JSON.parse(row.reference_bundle_json) : {},
  }
}

function disabledGenerationService(counts) {
  const fail = async () => {
    counts.generationSubmits += 1
    throw new Error('generation disabled for dry-run launcher')
  }
  return {
    resolveVerifiedGenerationModel: () => null,
    generateShot: fail,
    retryShot: fail,
    generateBatch: fail,
    reviewNativeAudio: fail,
  }
}

function canReadAsset(db, storageRoot, assetId) {
  const row = db.prepare('SELECT local_path FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(assetId))
  return Boolean(row?.local_path && fs.existsSync(path.join(storageRoot, row.local_path)))
}

function publicShot(shot) {
  return {
    id: Number(shot.id),
    shot_index: Number(shot.shot_index),
    preparation_state: shot.preparation_state,
    updated_at: shot.updated_at,
  }
}

function isGeneratePath(pathname) {
  return /\/api\/v1\/redraw\/(?:shots\/[^/]+\/generate|works\/[^/]+\/generate-batch|assets\/[^/]+\/generate)$/.test(pathname)
}

function isProviderConnectionPath(pathname) {
  return /\/api\/v1\/ai-configs\/[^/]+\/connection/.test(pathname)
}

function isLocalhost(url) {
  return ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
}

async function jsonResponse(response, expectedStatus, routeErrors = []) {
  const text = await response.text()
  let payload = {}
  try {
    payload = text ? JSON.parse(text) : {}
  } catch (error) {
    throw new Error(`dry-run route returned non-json status ${response.status}`)
  }
  const expectedStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus]
  if (!expectedStatuses.includes(response.status)) {
    const code = payload?.error?.code || payload?.code || 'unknown'
    const message = sanitizeRouteError(payload?.error?.message || payload?.message || '')
    const lastRouteError = routeErrors.at(-1)
    throw new Error(`dry-run route status ${response.status} code ${code}${message ? ` message ${message}` : ''}${lastRouteError ? ` route_error ${lastRouteError}` : ''}`)
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
      const message = sanitizeRouteError(error?.message || '')
      routeErrors.push(`${code}:${message}`)
      if (routeErrors.length > 5) routeErrors.shift()
    },
  }
}

function sanitizeRouteError(value) {
  return String(value || '')
    .replace(/[A-Za-z]:[\\/][^\s"]+/g, '[path]')
    .replace(/\/(?:Users|home)\/[^\s"]+/g, '[path]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]')
    .slice(0, 160)
}
