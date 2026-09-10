import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

// Decodable, local-only 320x240 H.264 / 5 second / silent test patterns.
export const motionBytes = readFileSync(new URL('../fixtures/redraw-motion-reference.mp4', import.meta.url))
export const nextMotionBytes = readFileSync(new URL('../fixtures/redraw-motion-reference-next.mp4', import.meta.url))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

export function motionCandidate(importId = 3901, assetId = 2901, bytes = motionBytes) {
  return { import_id: importId, asset: { id: assetId, type: 'video', mime_type: 'video/mp4', sha256: sha(bytes),
    duration_ms: 5000, width: 320, height: 240, file_size: bytes.length } }
}

export function motionFixtureState(base) {
  const state = { ...base, strictApi: true, userRole: 'user', motionOnly: true, motionTraffic: [],
    motionCandidates: { 1301: motionCandidate(), 1302: motionCandidate(3902, 2902) },
    motionBundles: { 1301: motionCandidate(), 1302: motionCandidate(3902, 2902) }, motionBytesBySha: {
      [sha(motionBytes)]: motionBytes, [sha(nextMotionBytes)]: nextMotionBytes,
    } }
  state.work.reference_bundle_required = true
  state.work.shots = state.work.shots.slice(0, 2).map((shot, index) => ({ ...shot, start_ms: index * 5000,
    end_ms: (index + 1) * 5000, duration_ms: 5000, duration: 5,
    source_video_ref: { ...shot.source_video_ref, start_ms: index * 5000, end_ms: (index + 1) * 5000 } }))
  state.work.batches = [{ batch_index: 1, duration_ms: 10000, shots: state.work.shots }]
  return state
}

function bundleDocument(shot, candidate) {
  return { shot_id: shot.id, reference_bundle_hash: 'b'.repeat(64), reference_bundle_updated_at: shot.updated_at,
    bundle: { schema_version: 'redraw-reference-bundle-v2', shot_id: shot.id, version_id: 812, locale: 'en-US', market: 'US',
      face_tracks: [], text_regions: [], coverage_review: { recognizable_face_count: 0, mapped_face_count: 0,
        unresolved_face_count: 0, recognizable_text_region_count: 0, mapped_text_region_count: 0,
        unresolved_text_region_count: 0, status: 'approved' },
      motion_reference: candidate ? { asset_id: candidate.asset.id, sha256: candidate.asset.sha256, audio_stream_count: 0 } : null,
      dialogue: { target_locale: 'en-US', target_market: 'US', turns: [] } } }
}

// Route fixtures prove browser behaviour, not provider success or full backend acceptance.
// Unknown writes never acquire a made-up status/read endpoint.
export async function handleMotionFixture(route, state, apiData) {
  if (!state.motionOnly) return false
  const request = route.request()
  const url = new URL(request.url())
  const { pathname } = url
  const method = request.method()
  state.motionTraffic.push({ method, pathname, query: Object.fromEntries(url.searchParams) })
  const fail = async (status, code) => {
    const label = { 400: 'Bad Request', 409: 'Conflict', 503: 'Service Unavailable' }[status]
    state.expectedBrowserStatuses.push(`${status} (${label})`)
    await route.fulfill({ status, contentType: 'application/json',
      body: JSON.stringify({ success: false, error: { code, message: code } }) })
    return true
  }
  if (method === 'POST' && pathname === '/api/v1/redraw/versions/812/reference-preparation-quote'
    && !state.motionActionStarted) {
    await route.fulfill(apiData({ priced: false, action: 'blocked', effective_mode: 'safe', missing_shot_ids: [], credits: null }))
    return true
  }
  const match = /^\/api\/v1\/redraw\/shots\/(\d+)\/(motion-draft|motion-reference)(\/media)?$/.exec(pathname)
  if (match) {
    const shot = state.work.shots.find(item => item.id === Number(match[1]))
    expect(shot).toBeTruthy()
    expect(request.headers().authorization).toBe('Bearer e2e-redraw-token')
    const media = Boolean(match[3])
    if (method === 'GET') {
      expect([...url.searchParams.keys()].sort()).toEqual((media
        ? ['expected_updated_at', 'expected_source_sha256', 'expected_import_id', 'expected_file_sha256']
        : ['expected_updated_at', 'expected_source_sha256']).sort())
      if (url.searchParams.get('expected_updated_at') !== shot.updated_at
        || url.searchParams.get('expected_source_sha256') !== state.work.source_fingerprint) return fail(409, 'MOTION_CAS_CONFLICT')
      if (match[2] === 'motion-draft') {
        state.motionActionStarted = true
        await route.fulfill({ status: 200, contentType: 'video/mp4', body: motionBytes,
          headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } })
        return true
      }
      const candidate = state.motionCandidates[shot.id] || null
      if (media) {
        state.motionMediaRequests ||= []
        state.motionMediaRequests.push({ shotId: shot.id, importId: url.searchParams.get('expected_import_id') })
        if (state.motionMediaWait) await state.motionMediaWait.promise
        const latest = state.motionCandidates[shot.id]
        if (state.motionMediaConflict || !latest
          || url.searchParams.get('expected_import_id') !== String(latest.import_id)
          || url.searchParams.get('expected_file_sha256') !== latest.asset.sha256) return fail(409, 'MOTION_CANDIDATE_CHANGED')
        await route.fulfill({ status: 200, contentType: 'video/mp4', body: state.motionBytesBySha[candidate.asset.sha256],
          headers: { 'cache-control': 'private, no-store', 'x-content-sha256': candidate.asset.sha256,
            'x-content-type-options': 'nosniff' } })
        return true
      }
      const document = { shot_id: shot.id, version_id: shot.version_id, shot_updated_at: shot.updated_at,
        source_sha256: state.work.source_fingerprint,
        status: state.motionUnavailable?.includes(shot.id) ? 'unavailable' : candidate ? 'available' : 'missing',
        candidate: state.motionUnavailable?.includes(shot.id) ? null : structuredClone(candidate) }
      const once = state.motionNextCandidateWait
      if (once) {
        delete state.motionNextCandidateWait
        state.motionHeldCandidates = (state.motionHeldCandidates || 0) + 1
        await once.promise
      }
      if (state.motionCandidateWait) await state.motionCandidateWait.promise
      if (state.motionReadError) return fail(503, 'MOTION_READ_FAILED')
      await route.fulfill(apiData(document))
      if (once) state.motionReleasedCandidates = (state.motionReleasedCandidates || 0) + 1
      return true
    }
    if (method === 'POST' && match[2] === 'motion-reference' && !media) {
      state.motionActionStarted = true
      const contentType = request.headers()['content-type'] || ''
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)
      expect(contentType).toMatch(/^multipart\/form-data;/)
      expect(boundary).not.toBeNull()
      const parts = request.postDataBuffer().toString('latin1').split(`--${boundary[1] || boundary[2]}`)
        .filter(part => part.includes('Content-Disposition:'))
      expect(parts.map(part => /name="([^"]+)"/.exec(part)[1]).sort()).toEqual([
        'expected_updated_at', 'file', 'full_frame_reviewed', 'source_identity_obscured', 'source_text_obscured', 'motion_preserved',
      ].sort())
      const field = name => parts.find(part => part.includes(`name="${name}"`)).split('\r\n\r\n')[1].replace(/\r\n$/, '')
      expect(field('expected_updated_at')).toBe(shot.updated_at)
      for (const name of ['full_frame_reviewed', 'source_identity_obscured', 'source_text_obscured', 'motion_preserved']) expect(field(name)).toBe('true')
      expect(Buffer.from(field('file'), 'latin1')).toEqual(nextMotionBytes)
      expect(request.headers()['idempotency-key']).toMatch(/^[\w-]{20,}$/)
      state.requests.push({ method, pathname, idempotencyKey: request.headers()['idempotency-key'] })
      if (state.motionUploadWait) await state.motionUploadWait.promise
      if (state.motionUploadError) return fail(state.motionUploadError, 'MOTION_UPLOAD_NOT_CONFIRMED')
      const uploaded = motionCandidate(4901, 5901, nextMotionBytes)
      state.motionCandidates[shot.id] = uploaded
      // A new import does not edit shot.updated_at or the old approved reference bundle.
      await route.fulfill(apiData({ purpose: 'motion', asset: uploaded.asset, billing: { credits: 0, held: 0, charged: 0 } }))
      return true
    }
  }
  if (method !== 'GET') {
    state.unexpectedApiRequests.push({ method, pathname })
    return fail(400, 'UNEXPECTED_MOTION_WRITE')
  }
  if (pathname === '/api/v1/redraw/works/710' && state.motionWorkError
    && state.requests.some(item => item.method === 'POST' && item.pathname.endsWith('/motion-reference'))) {
    return fail(503, 'MOTION_WORK_REFRESH_FAILED')
  }
  if (pathname === '/api/v1/redraw/versions/812/preparation-gate') {
    await route.fulfill(apiData({ ok: true, missing: [], ready_shot_ids: [1301, 1302], missing_shot_ids: [] }))
    return true
  }
  if (pathname === '/api/v1/redraw/versions/812/generation-summary') {
    await route.fulfill(apiData({ budget: { spent: 0, held: 0, remaining: null }, shots: [
      { shot_id: 1302, shot_index: 2, attempt: 1, next_attempt: 2, provider_status: 'failed_terminal', status: 'failed',
        can_start_next_attempt: true, result_state: 'failed' },
    ] }))
    return true
  }
  const bundleMatch = /^\/api\/v1\/redraw\/shots\/(\d+)\/reference-bundle$/.exec(pathname)
  if (bundleMatch) {
    const shot = state.work.shots.find(item => item.id === Number(bundleMatch[1]))
    expect(shot).toBeTruthy()
    if (state.motionBundleWait) await state.motionBundleWait.promise
    await route.fulfill(apiData(bundleDocument(shot, state.motionBundles[shot.id])))
    return true
  }
  const reviewMatch = /^\/api\/v1\/redraw\/shots\/(\d+)\/candidate-reviews$/.exec(pathname)
  if (reviewMatch) {
    const shot = state.work.shots.find(item => item.id === Number(reviewMatch[1]))
    expect(shot).toBeTruthy()
    await route.fulfill(apiData({ shot_id: shot.id, shot_updated_at: shot.updated_at, current: null, reviews: [] }))
    return true
  }
  return false
}
