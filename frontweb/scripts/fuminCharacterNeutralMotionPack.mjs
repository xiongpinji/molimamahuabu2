import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const HEX_64 = /^[a-f0-9]{64}$/

function fail(code, message = code) {
  throw Object.assign(new Error(`${code}: ${message}`), { code })
}
function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function resolveArtifact(root, artifactId) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(root, String(artifactId || ''))
  const relative = path.relative(resolvedRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('FUMIN_CHARACTER_NEUTRAL_MOTION_ARTIFACT_INVALID')
  }
  return resolved
}

function readJson(filePath, missingCode) {
  if (!fs.existsSync(filePath)) fail(missingCode)
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

export function loadCharacterNeutralMotionPack(root, testCase) {
  const manifest = readJson(
    path.join(root, 'character-neutral-motion-manifest.json'),
    'FUMIN_CHARACTER_NEUTRAL_MOTION_MANIFEST_MISSING',
  )
  const review = readJson(
    path.join(root, 'human-review.json'),
    'FUMIN_CHARACTER_NEUTRAL_MOTION_REVIEW_MISSING',
  )
  if (manifest.schema_version !== 'fumin-character-neutral-motion-pack-v1'
    || manifest.case_id !== testCase?.id
    || manifest.source_sha256 !== testCase?.source?.sha256
    || manifest.supplier_call_performed !== false
    || manifest.paid_submit_count !== 0
    || !Array.isArray(manifest.shots)
    || manifest.shots.length !== testCase?.sourceFacts?.shots?.length) {
    fail('FUMIN_CHARACTER_NEUTRAL_MOTION_MANIFEST_INVALID')
  }
  if (review.schema_version !== 'redraw-motion-visual-sanitization-review-v1'
    || review.case_id !== testCase.id
    || review.decision !== 'approved'
    || !review.reviewer
    || !Number.isFinite(Date.parse(review.reviewed_at))
    || review.criteria?.privacy_transform_scope !== 'full_frame'
    || review.criteria?.source_identity_obscured !== true
    || review.criteria?.source_text_obscured !== true
    || !Array.isArray(review.shots)
    || review.shots.length !== manifest.shots.length) {
    fail('FUMIN_CHARACTER_NEUTRAL_MOTION_REVIEW_NOT_APPROVED')
  }
  return manifest.shots.map((item, index) => {
    const expected = testCase.sourceFacts.shots[index]
    const motion = item?.motion
    const contact = item?.contact_sheet
    const approval = review.shots[index]
    if (item?.shot_number !== index + 1
      || item.shot_id !== expected.id
      || item.source_start_ms !== expected.start_ms
      || item.source_end_ms !== expected.end_ms
      || item.conditioning_mode !== 'character_neutral_motion'
      || motion?.width !== 496
      || motion?.height !== 864
      || motion?.frame_rate !== 24
      || motion?.video_codec !== 'h264'
      || motion?.has_audio !== false
      || motion?.privacy_transform_scope !== 'full_frame'
      || motion?.source_identity_obscured !== true
      || motion?.source_text_obscured !== true
      || motion?.review_status !== 'pending'
      || !HEX_64.test(String(motion?.sha256 || ''))
      || !HEX_64.test(String(contact?.sha256 || ''))
      || approval?.shot_number !== index + 1
      || approval.motion_sha256 !== motion.sha256
      || approval.evidence_sha256 !== contact.sha256
      || approval.decision !== 'approved') {
      fail('FUMIN_CHARACTER_NEUTRAL_MOTION_REVIEW_NOT_APPROVED', expected.id)
    }
    const motionPath = resolveArtifact(root, motion.artifact_id)
    const contactPath = resolveArtifact(root, contact.artifact_id)
    if (!fs.existsSync(motionPath) || !fs.existsSync(contactPath)
      || sha256File(motionPath) !== motion.sha256
      || sha256File(contactPath) !== contact.sha256) {
      fail('FUMIN_CHARACTER_NEUTRAL_MOTION_ARTIFACT_DRIFT', expected.id)
    }
    return {
      shot_number: index + 1,
      shot_id: expected.id,
      path: motionPath,
      sha256: motion.sha256,
      bytes: fs.statSync(motionPath).size,
      source_duration_seconds: (expected.end_ms - expected.start_ms) / 1_000,
      duration_seconds: motion.duration_seconds,
      has_audio: false,
      conditioning_mode: 'character_neutral_motion',
      visual_sanitization: {
        schema_version: 'redraw-motion-visual-sanitization-v1',
        privacy_transform_scope: 'full_frame',
        source_identity_obscured: true,
        source_text_obscured: true,
        review_status: 'approved',
        reviewer: review.reviewer,
        reviewed_at: review.reviewed_at,
        evidence_sha256: contact.sha256,
      },
    }
  })
}
