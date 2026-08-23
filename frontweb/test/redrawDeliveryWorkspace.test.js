import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

function source(path) {
  const url = new URL(path, import.meta.url)
  return existsSync(url) ? readFileSync(url, 'utf8') : ''
}

const apiSource = source('../src/api/redraw.js')
const workspaceSource = source('../src/views/RedrawWorkspace.vue')
const shotStepSource = source('../src/components/redraw/RedrawShotStep.vue')
const editStepSource = source('../src/components/redraw/RedrawEditStep.vue')
const queueSource = source('../src/components/redraw/RedrawGenerationQueuePanel.vue')
const qualitySource = source('../src/components/redraw/RedrawQualityReviewPanel.vue')
const releaseSource = source('../src/components/redraw/RedrawEpisodeReleasePanel.vue')

async function shotState() {
  return import('../src/utils/redrawShotState.js')
}

async function timelineState() {
  return import('../src/utils/redrawTimelineState.js')
}

test('交付工作台 API 使用五条精确路由且重建严格审核和 release payload', async () => {
  for (const name of [
    'getGenerationSummary', 'listCandidateReviews', 'reviewCandidate',
    'getReleaseReadiness', 'createRelease',
  ]) assert.match(apiSource, new RegExp(`${name}\\(`), name)
  assert.match(apiSource, /\/redraw\/versions\/\$\{versionId\}\/generation-summary/)
  assert.match(apiSource, /\/redraw\/shots\/\$\{shotId\}\/candidate-reviews/)
  assert.match(apiSource, /\/redraw\/versions\/\$\{versionId\}\/release-readiness/)
  assert.match(apiSource, /\/redraw\/versions\/\$\{versionId\}\/releases/)
  assert.doesNotMatch(apiSource, /reviewCandidate[\s\S]{0,240}\.\.\.body/)
  assert.doesNotMatch(apiSource, /createRelease[\s\S]{0,240}\.\.\.body/)

  const executable = apiSource.replace("import request from '@/utils/request'", 'const request = {}')
  const api = await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`)
  assert.deepEqual(api.buildCandidateReviewPayload({
    decision: 'approved',
    reason_code: 'manual_visual_passed',
    candidate_sha256: 'a'.repeat(64),
    expected_updated_at: '2026-08-24T00:00:00.000Z',
    provider: 'attacker',
    metrics: { spoofed: true },
    url: 'https://attacker.invalid',
  }), {
    decision: 'approved',
    reason_code: 'manual_visual_passed',
    candidate_sha256: 'a'.repeat(64),
    expected_updated_at: '2026-08-24T00:00:00.000Z',
  })
  assert.deepEqual(api.buildReleasePayload({
    idempotency_key: 'release-1',
    readiness_hash: 'b'.repeat(64),
    model: 'attacker',
    path: 'C:/secret.mp4',
  }), { idempotency_key: 'release-1', readiness_hash: 'b'.repeat(64) })
})

test('生成队列显示预算、attempt 和规范 provider 终态且未知提交不自动重试', async () => {
  const { providerDeliveryState } = await shotState()
  assert.deepEqual(providerDeliveryState({ provider_status: 'submission_unknown' }), {
    label: '需要核对',
    canRetry: false,
    warning: '提交结果未知，需要核对；不会自动重试',
  })
  assert.equal(providerDeliveryState({
    provider_status: 'failed_terminal',
    can_start_next_attempt: true,
  }).canRetry, true)
  for (const label of ['已用预算', 'held', '剩余预算', 'attempt', 'provider 状态', '需要核对', '不会自动重试', '下一次尝试']) {
    assert.match(queueSource, new RegExp(label), label)
  }
  assert.match(shotStepSource, /RedrawGenerationQueuePanel/)
  assert.match(shotStepSource, /getGenerationSummary/)
})

test('质量面板区分 A 人工审核和 B 自动批准证据并展示 B 转 A 原因', () => {
  for (const label of ['A 模式', '人工批准', '人工驳回', 'B 自动批准证据', 'B→A 原因', '候选 QA']) {
    assert.match(qualitySource, new RegExp(label), label)
  }
  assert.match(qualitySource, /candidate_sha256/)
  assert.match(qualitySource, /expected_updated_at/)
  assert.match(qualitySource, /reason_code/)
  assert.match(qualitySource, /current\?\.decision === 'needs_review'/)
  assert.doesNotMatch(qualitySource, /model\s*:|provider\s*:|price\s*:|credits?\s*:|metrics\s*:|path\s*:|url\s*:/)
  assert.match(shotStepSource, /RedrawQualityReviewPanel/)
})

test('release readiness 列出精确镜头原因且下载仅接受服务端受控相对 URL', async () => {
  const { normalizeReleaseReadiness, controlledReleaseDownloadUrl } = await timelineState()
  assert.deepEqual(normalizeReleaseReadiness({
    ready: false,
    blockers: [{ shot_id: 7, reason_code: 'candidate_not_approved' }],
  }).blockers, [{ shot_id: 7, reason_code: 'candidate_not_approved' }])
  assert.equal(controlledReleaseDownloadUrl('/api/v1/redraw/exports/8/download/mp4'), '/api/v1/redraw/exports/8/download/mp4')
  assert.equal(controlledReleaseDownloadUrl('/api/v1/redraw/exports/8'), '/api/v1/redraw/exports/8')
  assert.equal(controlledReleaseDownloadUrl('/api/v1/redraw/exports/8?url=https://attacker.invalid'), '')
  assert.equal(controlledReleaseDownloadUrl('https://attacker.invalid/file.mp4'), '')
  assert.equal(controlledReleaseDownloadUrl('C:/secret.mp4'), '')
  for (const label of ['整集 readiness', '镜头', '原因', 'MP4', 'SRT', 'VTT', '报告下载']) {
    assert.match(releaseSource, new RegExp(label), label)
  }
  assert.match(releaseSource, /getReleaseReadiness/)
  assert.match(releaseSource, /createRelease/)
  assert.match(releaseSource, /status === 'completed'/)
  assert.match(releaseSource, /downloadReleaseArtifact\(relativeUrl, report\)/)
  assert.match(releaseSource, /JSON\.stringify\(result, null, 2\)/)
  assert.doesNotMatch(releaseSource, /window\.open|location\.href/)
  assert.match(editStepSource, /RedrawEpisodeReleasePanel/)
  assert.match(workspaceSource, /生成与 QA/)
  assert.match(workspaceSource, /合并与导出/)
})
