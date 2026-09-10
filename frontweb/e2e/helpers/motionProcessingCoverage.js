import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

export function assertMotionDuration(actual, expected, timeBase) {
  assert.equal(typeof timeBase, 'string')
  const parts = timeBase.split('/')
  assert.equal(parts.length, 2)
  const [numerator, denominator] = parts.map(Number)
  assert.ok(Number.isSafeInteger(numerator) && numerator > 0 && Number.isSafeInteger(denominator) && denominator > 0)
  assert.ok(Number.isFinite(actual) && actual >= 0 && Number.isFinite(expected) && expected >= 0)
  const tolerance = Math.max(numerator / denominator, 0.000001)
  // Compare interval endpoints so 4.000001 is accepted without adding rounding tolerance twice.
  assert.ok(actual >= expected - tolerance && actual <= expected + tolerance,
    `duration ${actual} outside ${expected} ± ${tolerance}`)
  return tolerance
}

// Test-only evidence: decode this uploaded source, never reuse another clip's representative PNGs.
export async function installMotionProcessingCoverage({ database, owner, log, storageRoot, backendRoot, versionId, modelLock }) {
  const sharp = require(path.join(backendRoot, 'node_modules/sharp'))
  const assetService = require(path.join(backendRoot, 'src/services/assetService'))
  const redrawAssetService = require(path.join(backendRoot, 'src/services/redrawAssetService'))
  const { getFfmpegPath, getFfprobePath } = require(path.join(backendRoot, 'src/utils/ffmpegPath'))
  const { buildGeneratedCoverageManifest } = require(path.join(backendRoot, 'src/services/redrawFullFrameCoverageService'))
  const { finalizeReviewedCoverage, validateReviewedCoverageManifest } = require(path.join(backendRoot, 'src/services/redrawFullFrameReviewService'))
  const version = database.prepare(`SELECT v.*, w.source_asset_id, w.source_fingerprint, w.duration_ms
    FROM redraw_versions v JOIN redraw_works w ON w.id = v.work_id WHERE v.id = ?`).get(versionId)
  const shots = database.prepare('SELECT * FROM redraw_shots WHERE version_id = ? ORDER BY shot_index').all(versionId)
  const source = database.prepare('SELECT * FROM assets WHERE id = ?').get(version.source_asset_id)
  const sourcePath = path.resolve(storageRoot, source.local_path)
  assert.ok(sourcePath.startsWith(`${path.resolve(storageRoot)}${path.sep}`))
  assert.equal(hash(sourcePath), version.source_fingerprint)
  const run = (binary, args) => execFileSync(binary, args, { windowsHide: true, shell: false, timeout: 60000, maxBuffer: 32 * 1024 * 1024 })
  const probe = JSON.parse(run(getFfprobePath(), ['-v', 'error', '-show_streams', '-show_frames', '-show_format', '-of', 'json', sourcePath]))
  const stream = probe.streams.find(item => item.codec_type === 'video')
  assert.equal(stream.width, 320); assert.equal(stream.height, 180)
  const [numerator, denominator] = stream.time_base.split('/').map(Number)
  const actualFrames = probe.frames.filter(item => item.media_type === 'video')
  const baseRelative = `g1-motion-processing/version-${versionId}/analysis`
  const analysisRoot = path.join(storageRoot, baseRelative)
  assert.equal(fs.existsSync(analysisRoot), false)
  fs.mkdirSync(path.join(analysisRoot, 'frames'), { recursive: true })
  fs.mkdirSync(path.join(analysisRoot, 'masks'))
  run(getFfmpegPath(), ['-v', 'error', '-noautorotate', '-i', sourcePath, '-map', '0:v:0',
    '-fps_mode', 'passthrough', '-start_number', '0', path.join(analysisRoot, 'frames/%06d.png')])
  assert.equal(fs.readdirSync(path.join(analysisRoot, 'frames')).length, actualFrames.length)
  assert.ok(actualFrames.length > shots.length)
  const boxes = { c1: { x: 36, y: 24, width: 84, height: 118 }, c2: { x: 164, y: 24, width: 84, height: 118 },
    text: { x: 56, y: 142, width: 208, height: 24 } }
  const masks = {}
  for (const [name, box] of Object.entries(boxes)) {
    const pixels = Buffer.alloc(stream.width * stream.height)
    for (let y = box.y; y < box.y + box.height; y += 1) for (let x = box.x; x < box.x + box.width; x += 1) pixels[y * stream.width + x] = 255
    const relative = `masks/${name}.png`, file = path.join(analysisRoot, relative)
    await sharp(pixels, { raw: { width: stream.width, height: stream.height, channels: 1 } }).toColourspace('b-w').png().toFile(file)
    masks[name] = { path: relative, sha256: hash(file), width: stream.width, height: stream.height, mime_type: 'image/png' }
  }
  const characters = [['c1'], ['c1', 'c2'], ['c2']]
  const frames = actualFrames.map((actual, index) => {
    const ticks = Number(actual.best_effort_timestamp), timestamp = Math.round(ticks * numerator * 1000 / denominator)
    const shotIndex = shots.findIndex(item => timestamp >= item.start_ms && timestamp < item.end_ms)
    assert.ok(shotIndex >= 0)
    const relative = `frames/${String(index).padStart(6, '0')}.png`
    return { frame_index: index, timestamp_ticks: ticks, timestamp_ms: timestamp, shot_id: String(shots[shotIndex].shot_id),
      path: relative, sha256: hash(path.join(analysisRoot, relative)), width: stream.width, height: stream.height,
      person_region_ids: characters[shotIndex].map(key => `person-${key}-${index}`), text_region_ids: [`text-${index}`],
      review_point_reasons: [], review_status: 'not_required' }
  })
  const range = selected => [{ start_frame: selected[0].frame_index, end_frame: selected.at(-1).frame_index }]
  const personTracks = ['c1', 'c2'].map(key => {
    const selected = frames.filter(frame => frame.person_region_ids.includes(`person-${key}-${frame.frame_index}`))
    return { track_key: `track-${key}`, kind: 'story_role', source_character_key: key, target_strategy: 'fixed_actor',
      frame_ranges: range(selected), visibility: range(selected).map(item => ({ ...item, state: 'visible' })),
      regions: selected.map(frame => ({ region_id: `person-${key}-${frame.frame_index}`, frame_index: frame.frame_index,
        bbox: boxes[key], mask: masks[key], association_confidence: 0.99, detector_disagreement: false })),
      review_status: 'pending', reviewer: null }
  })
  const textTracks = shots.map((shot, index) => {
    const selected = frames.filter(frame => frame.shot_id === shot.shot_id)
    return { region_key: `region-${shot.shot_id}`, kind: index === 0 ? 'subtitle' : 'screen',
      treatment: index === 0 ? 'translate_subtitle' : 'localize_screen', target_text_key: `region-${shot.shot_id}`,
      frame_ranges: range(selected), regions: selected.map(frame => ({ region_id: `text-${frame.frame_index}`, frame_index: frame.frame_index,
        polygon: [{ x: 56, y: 142 }, { x: 264, y: 142 }, { x: 264, y: 166 }, { x: 56, y: 166 }], mask: masks.text })),
      review_status: 'pending', reviewer: null }
  })
  const generated = await buildGeneratedCoverageManifest({ evidenceRoot: analysisRoot,
    source: { sha256: version.source_fingerprint, duration_ms: version.duration_ms, width: stream.width, height: stream.height,
      frame_count: actualFrames.length, time_base: { numerator, denominator } },
    shots: shots.map(shot => ({ shot_id: shot.shot_id, start_ms: shot.start_ms, end_ms: shot.end_ms })), frames, personTracks, textTracks, modelLock })
  fs.writeFileSync(path.join(analysisRoot, 'redraw-full-frame-coverage-manifest.json'), JSON.stringify(generated))
  const reviewedRelative = `g1-motion-processing/version-${versionId}/reviewed`, reviewedRoot = path.join(storageRoot, reviewedRelative)
  const finalized = await finalizeReviewedCoverage({ analysisRoot, outputRoot: reviewedRoot, decisions: {
    schema_version: 'redraw-full-frame-review-decisions-v1', analysis_sha256: generated.analysis_sha256, reviewer: 'codex-local-review',
    review_points: generated.frames.filter(frame => frame.review_point_reasons.length).map(frame => ({ frame_index: frame.frame_index,
      reasons: frame.review_point_reasons, decision: 'accepted', corrections: [] })),
  } })
  const reviewed = finalized.reviewed_manifest
  await validateReviewedCoverageManifest({ evidenceRoot: reviewedRoot, manifest: reviewed })
  const registered = new Set()
  const evidence = [...reviewed.frames, ...reviewed.person_tracks.flatMap(track => track.regions.map(region => region.mask)),
    ...reviewed.text_tracks.flatMap(track => track.regions.map(region => region.mask))]
  for (const file of evidence) {
    const relative = path.posix.join(reviewedRelative, file.path)
    if (registered.has(relative)) continue
    registered.add(relative)
    assetService.create(database, log, { name: `G1.3b reviewed ${file.path}`, type: 'image', category: 'redraw',
      url: `/static/${relative}`, local_path: relative, file_size: fs.statSync(path.join(storageRoot, relative)).size,
      mime_type: 'image/png', width: file.width, height: file.height, metadata: { sha256: file.sha256 } })
  }
  const relative = `${reviewedRelative}/redraw-full-frame-reviewed-manifest.json`, absolute = path.join(storageRoot, relative)
  const manifestAsset = assetService.create(database, log, { name: 'G1.3b actual full frame coverage', type: 'document', category: 'redraw',
    url: `/static/${relative}`, local_path: relative, file_size: fs.statSync(absolute).size, mime_type: 'application/json', metadata: { sha256: hash(absolute) } })
  const ctx = { db: database, tenantId: owner.tenant.id, userId: owner.user.id, versionId, allowUnmaterializedDraft: true,
    assetReader: { canRead: asset => Boolean(asset?.local_path && fs.existsSync(path.join(storageRoot, asset.local_path))) } }
  const attempt = redrawAssetService.createAssetAttempt(ctx, { kind: 'scene', sourceRef: { stable_id: 'full-frame-reviewed-coverage' },
    snapshot: { mode: 'full_frame_reviewed_coverage', version_id: versionId, facts_hash: version.facts_hash,
      source_fingerprint: version.source_fingerprint, analysis_sha256: reviewed.analysis_sha256 },
    localizedName: 'reviewed full frame coverage', model: 'local-full-frame-review',
    operationKey: `g1-full-frame:${versionId}:${reviewed.analysis_sha256}` })
  const coverageAsset = redrawAssetService.finalizeAssetAttempt(ctx, attempt.id, { status: 'completed',
    provider_task_id: `g1-full-frame-${versionId}`, asset_id: manifestAsset.id })
  assert.equal(coverageAsset.approval_status, 'pending')
  return { coverageAsset, reviewed, evidence: { source_sha256: hash(sourcePath), source_size: fs.statSync(sourcePath).size,
    width: stream.width, height: stream.height, sar: stream.sample_aspect_ratio, dar: stream.display_aspect_ratio,
    time_base: stream.time_base, frame_count: frames.length, duration: Number(probe.format.duration), manifest_sha256: hash(absolute) } }
}
