import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { redrawLatinAmericanCase } from '../e2e/fixtures/redraw-latin-american-case.js'
import { loadCharacterNeutralMotionPack } from './fuminCharacterNeutralMotionPack.mjs'

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-neutral-pack-'))
  fs.mkdirSync(path.join(root, 'motion'))
  fs.mkdirSync(path.join(root, 'contact-sheets'))
  const shots = redrawLatinAmericanCase.sourceFacts.shots.map((shot, index) => {
    const number = String(index + 1).padStart(2, '0')
    const motionName = `shot-${number}.mp4`
    const contactName = `shot-${number}.jpg`
    const motionBytes = Buffer.from(`motion-${number}`)
    const contactBytes = Buffer.from(`contact-${number}`)
    fs.writeFileSync(path.join(root, 'motion', motionName), motionBytes)
    fs.writeFileSync(path.join(root, 'contact-sheets', contactName), contactBytes)
    return {
      shot_number: index + 1,
      shot_id: shot.id,
      source_start_ms: shot.start_ms,
      source_end_ms: shot.end_ms,
      conditioning_mode: 'character_neutral_motion',
      motion: {
        artifact_id: `motion/${motionName}`,
        sha256: sha256(motionBytes),
        bytes: motionBytes.length,
        duration_seconds: (shot.end_ms - shot.start_ms) / 1_000,
        width: 496,
        height: 864,
        frame_rate: 24,
        video_codec: 'h264',
        has_audio: false,
        privacy_transform_scope: 'full_frame',
        source_identity_obscured: true,
        source_text_obscured: true,
        review_status: 'pending',
      },
      contact_sheet: {
        artifact_id: `contact-sheets/${contactName}`,
        sha256: sha256(contactBytes),
        bytes: contactBytes.length,
      },
    }
  })
  const manifest = {
    schema_version: 'fumin-character-neutral-motion-pack-v1',
    case_id: redrawLatinAmericanCase.id,
    source_sha256: redrawLatinAmericanCase.source.sha256,
    supplier_call_performed: false,
    paid_submit_count: 0,
    review_status: 'pending',
    shots,
  }
  const review = {
    schema_version: 'redraw-motion-visual-sanitization-review-v1',
    case_id: redrawLatinAmericanCase.id,
    decision: 'approved',
    reviewer: 'codex-visual-review',
    reviewed_at: '2026-08-25T02:28:00.000Z',
    criteria: {
      privacy_transform_scope: 'full_frame',
      source_identity_obscured: true,
      source_text_obscured: true,
    },
    shots: shots.map((item) => ({
      shot_number: item.shot_number,
      motion_sha256: item.motion.sha256,
      evidence_sha256: item.contact_sheet.sha256,
      decision: 'approved',
    })),
  }
  fs.writeFileSync(path.join(root, 'character-neutral-motion-manifest.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(root, 'human-review.json'), JSON.stringify(review))
  return root
}

test('九镜净化包只有在逐镜人工批准且文件哈希一致时可投影', () => {
  const root = fixture()
  try {
    const segments = loadCharacterNeutralMotionPack(root, redrawLatinAmericanCase)
    assert.equal(segments.length, 9)
    assert.ok(segments.every((segment) => (
      segment.conditioning_mode === 'character_neutral_motion'
        && segment.visual_sanitization.privacy_transform_scope === 'full_frame'
        && segment.visual_sanitization.source_identity_obscured === true
        && segment.visual_sanitization.source_text_obscured === true
        && segment.visual_sanitization.review_status === 'approved'
    )))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('缺少人工批准时净化包保持付费阻断', () => {
  const root = fixture()
  try {
    const reviewPath = path.join(root, 'human-review.json')
    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'))
    review.shots[0].decision = 'pending'
    fs.writeFileSync(reviewPath, JSON.stringify(review))
    assert.throws(
      () => loadCharacterNeutralMotionPack(root, redrawLatinAmericanCase),
      /FUMIN_CHARACTER_NEUTRAL_MOTION_REVIEW_NOT_APPROVED/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('净化视频或接触表发生哈希漂移时拒绝投影', () => {
  const root = fixture()
  try {
    fs.appendFileSync(path.join(root, 'motion', 'shot-01.mp4'), 'drift')
    assert.throws(
      () => loadCharacterNeutralMotionPack(root, redrawLatinAmericanCase),
      /FUMIN_CHARACTER_NEUTRAL_MOTION_ARTIFACT_DRIFT/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

