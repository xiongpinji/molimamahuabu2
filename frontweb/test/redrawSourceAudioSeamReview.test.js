import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSourceAudioSeamDecisionPayload, sourceAudioSeamDecisionPoints } from '../src/utils/redrawSourceAudioSeamReview.js'

const review = {
  status: 'needs_review', reason: 'seam_conflict', analysis_task_id: 'task-1', candidate_sha256: 'a'.repeat(64),
  expected_work_updated_at: 'work-time', expected_task_updated_at: 'task-time',
  windows: [
    { window_id: 'aw000001', analysis_range_ms: { start_ms: 0, end_ms: 1530000 }, commit_range_ms: { start_ms: 0, end_ms: 1500000 },
      raw_source_evidence: { segments: [{ start: 1499, end: 1502, text: 'Keep the complete sentence.' }] } },
    { window_id: 'aw000002', analysis_range_ms: { start_ms: 1470000, end_ms: 2100000 }, commit_range_ms: { start_ms: 1500000, end_ms: 2100000 },
      raw_source_evidence: { segments: [{ start: 29, end: 32, text: '保留另一份完整原文。' }] } },
  ],
}

test('builds only actual seam conflicts and never sends crop boundaries', () => {
  const points = sourceAudioSeamDecisionPoints(review)
  assert.deepEqual(points, [{ seam_ms: 1500000, left_window_id: 'aw000001', right_window_id: 'aw000002',
    left_text: 'Keep the complete sentence.', right_text: '保留另一份完整原文。' }])
  const payload = buildSourceAudioSeamDecisionPayload(review, { 1500000: 'aw000001' })
  assert.deepEqual(Object.keys(payload.decisions[0]).sort(), ['left_window_id', 'right_window_id', 'seam_ms', 'selected_window_id'])
  assert.equal(JSON.stringify(payload).includes('start_ms'), false)
  assert.equal(JSON.stringify(payload).includes('end_ms'), false)
})

test('requires every conflict and blocks language conflicts', () => {
  assert.throws(() => buildSourceAudioSeamDecisionPayload(review, {}), /每个冲突接缝/)
  assert.deepEqual(sourceAudioSeamDecisionPoints({ ...review, reason: 'language_conflict' }), [])
})
