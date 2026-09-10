const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const service = require('../src/services/redrawSourceAudioEvidenceService');

const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const DURATION = 2_100_000;
const PLAN = [
  { window_id: 'aw000001', index: 0, analysis_range_ms: { start_ms: 0, end_ms: 1_530_000 },
    commit_range_ms: { start_ms: 0, end_ms: 1_500_000 } },
  { window_id: 'aw000002', index: 1, analysis_range_ms: { start_ms: 1_470_000, end_ms: DURATION },
    commit_range_ms: { start_ms: 1_500_000, end_ms: DURATION } },
];

function windowEvidence(plan, text, start, end) {
  const raw = {
    audio_sha256: String(plan.index + 1).repeat(64),
    transcript_sha256: sha256(`${plan.window_id}:${text}`),
    source_language: 'en',
    language_probability: 0.91,
    segments: [{ start, end, text, speaker_cluster_id: 'speaker-cluster-1' }],
  };
  return {
    ...structuredClone(plan), request_id: `request-${plan.window_id}`,
    audio_sha256: raw.audio_sha256, transcript_sha256: raw.transcript_sha256,
    worker_status: 'completed', segment_count: 1, raw_source_evidence: raw,
  };
}

function candidate(reason = 'seam_conflict') {
  return {
    schema_version: 'redraw-source-audio-seam-candidate-v1', status: 'needs_review',
    audio_duration_ms: DURATION, audio_sha256: 'a'.repeat(64), reason,
    windows: [
      windowEvidence(PLAN[0], 'Keep the complete left sentence.', 1499.0004, 1502.0006),
      windowEvidence(PLAN[1], 'Keep the complete right alternative.', 29.0004, 32.0006),
    ],
  };
}

test('manual seam decision selects one complete source side and retains both immutable raw receipts', () => {
  assert.equal(typeof service.resolveSourceAudioSeamDecision, 'function');
  const input = candidate();
  const before = structuredClone(input);
  const result = service.resolveSourceAudioSeamDecision(input, {
    candidate_sha256: 'b'.repeat(64),
    decisions: [{ seam_ms: 1_500_000, left_window_id: 'aw000001', right_window_id: 'aw000002',
      selected_window_id: 'aw000001' }],
  });

  assert.equal(result.schema_version, 'redraw-source-audio-evidence-v2');
  assert.equal(result.dialogue_mode, 'spoken');
  assert.equal(result.source_language, 'en');
  assert.deepEqual(result.segments.map(segment => segment.source_text), ['Keep the complete left sentence.']);
  assert.deepEqual(result.segments.map(segment => [segment.start_ms, segment.end_ms]), [[1499000.4, 1502000.6]]);
  assert.equal(result.segments[0].source_bindings[0].window_id, 'aw000001', 'physical source is the chosen side');
  assert.equal(result.segments[0].commit_window_id, 'aw000002', 'logical owner follows the complete utterance midpoint');
  assert.deepEqual(result.windows, input.windows, 'both original signed Worker receipts remain available for audit');
  assert.deepEqual(result.manual_seam_review, {
    schema_version: 'redraw-source-audio-seam-decision-v1',
    candidate_sha256: 'b'.repeat(64),
    candidate_reason: 'seam_conflict',
    decisions: [{ seam_ms: 1_500_000, left_window_id: 'aw000001', right_window_id: 'aw000002',
      selected_window_id: 'aw000001' }],
    rejected_source_bindings: [{ window_id: 'aw000002', worker_request_id: 'request-aw000002',
      worker_segment_index: 0 }],
  });
  result.windows[0].raw_source_evidence.segments[0].text = 'mutated output';
  assert.deepEqual(input, before, 'resolver never mutates or shares the review candidate');
});

test('persisted manual v2 evidence is independently recomputed and rejects decision or binding tampering', () => {
  const resolved = service.resolveSourceAudioSeamDecision(candidate(), {
    candidate_sha256: 'b'.repeat(64),
    decisions: [{ seam_ms: 1_500_000, left_window_id: 'aw000001', right_window_id: 'aw000002',
      selected_window_id: 'aw000001' }],
  });
  const persisted = { ...resolved, task_id: 'source-audio-task-1', work_id: 1, tenant_id: 'tenant-1',
    user_id: 'user-1', source_asset_id: 2, source_video_sha256: 'c'.repeat(64),
    created_at: '2026-09-10T00:00:00.000Z' };
  assert.deepEqual(service.validatePersistedSourceAudioV2(persisted), persisted);
  for (const mutate of [
    value => { value.manual_seam_review.decisions[0].selected_window_id = 'aw000002'; },
    value => { value.manual_seam_review.rejected_source_bindings[0].worker_segment_index = 9; },
    value => { value.segments[0].source_text = 'forged'; },
  ]) {
    const forged = structuredClone(persisted); mutate(forged);
    assert.throws(() => service.validatePersistedSourceAudioV2(forged), { code: 'SOURCE_AUDIO_EVIDENCE_INVALID' });
  }
});

test('manual seam decision rejects missing candidate CAS, cropping, partial decisions, forged windows and language conflicts', () => {
  const valid = { candidate_sha256: 'b'.repeat(64), decisions: [{ seam_ms: 1_500_000, left_window_id: 'aw000001',
    right_window_id: 'aw000002', selected_window_id: 'aw000001' }] };
  for (const decisions of [
    { decisions: valid.decisions },
    { ...valid, candidate_sha256: 'c' },
    { ...valid, decisions: [] },
    { ...valid, decisions: [{ ...valid.decisions[0], start_ms: 1_499_500 }] },
    { ...valid, decisions: [{ ...valid.decisions[0], selected_window_id: 'aw999999' }] },
    { ...valid, decisions: [{ ...valid.decisions[0], seam_ms: 1_500_001 }] },
  ]) assert.throws(() => service.resolveSourceAudioSeamDecision(candidate(), decisions),
    { code: 'SOURCE_AUDIO_SEAM_DECISION_INVALID' });
  assert.throws(() => service.resolveSourceAudioSeamDecision(candidate('language_conflict'), valid),
    { code: 'SOURCE_AUDIO_SEAM_LANGUAGE_CONFLICT' });
});

test('production route exposes exactly one authenticated owner-scoped seam decision POST', () => {
  const routeSource = fs.readFileSync(path.resolve(__dirname, '../src/routes/index.js'), 'utf8');
  const handlerSource = fs.readFileSync(path.resolve(__dirname, '../src/routes/redraw.js'), 'utf8');
  const post = /r\.post\(\s*['"]\/redraw\/works\/:id\/source-audio-seam-review['"]\s*,\s*redraw\.recordSourceAudioSeamDecision\s*\)/g;
  assert.equal([...routeSource.matchAll(post)].length, 1);
  assert.match(handlerSource, /async function recordSourceAudioSeamDecision\(req, res\)/);
  assert.match(handlerSource, /redrawSourceAudioEvidenceService\.recordSourceAudioSeamDecision\(\{[\s\S]*?\.\.\.owner\(req\)[\s\S]*?\},\s*\{[\s\S]*?workId:\s*req\.params\.id[\s\S]*?analysisTaskId:\s*req\.body\?\.analysis_task_id/);
  assert.match(handlerSource, /SOURCE_AUDIO_SEAM_DECISION_INPUT_INVALID[\s\S]*?400/);
  assert.match(handlerSource, /SOURCE_AUDIO_SEAM_DECISION_STALE[\s\S]*?409/);
  const resume = /r\.post\(\s*['"]\/redraw\/works\/:id\/source-audio-seam-resume['"]\s*,\s*redraw\.resumeSourceAudioSeamAnalysis\s*\)/g;
  assert.equal([...routeSource.matchAll(resume)].length, 1);
  assert.match(handlerSource, /async function resumeSourceAudioSeamAnalysis\(req, res\)/);
  assert.match(handlerSource, /orchestrator\.resumeSourceAudioSeamAnalysis\(db, log,[\s\S]*?tenantId:\s*currentOwner\.tenantId[\s\S]*?userId:\s*currentOwner\.userId[\s\S]*?analysisOptions/);
  assert.match(handlerSource, /REDRAW_SOURCE_AUDIO_RESUME_STALE[\s\S]*?409/);
});
