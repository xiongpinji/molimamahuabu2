import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertNextShotAllowed,
  validateBalanceEvidence,
  validatePaidContract,
} from './fuminFullEpisodePaidGuard.mjs'

const now = Date.parse('2026-08-25T06:00:00.000Z')
const contract = Object.freeze({
  expectedShots: 9,
  maxPaidSubmits: 9,
  spendCapUsd: 25,
  estimatedPerShotUsd: 2.384848,
  estimatedTotalUsd: 21.463632,
  initialBalanceUsd: 79.29,
  accountId: 'xiongpinji',
})

function liveEvidence(balanceUsd, observedAt = '2026-08-25T05:58:00.000Z') {
  return {
    schema_version: 'fumin-live-balance-evidence-v1',
    provider: 'fumin.ai',
    account_id: 'xiongpinji',
    source_url: 'https://fumin.ai/console',
    captured_by: 'codex-in-app-browser',
    observed_at: observedAt,
    balance_usd: balanceUsd,
    estimated_per_shot_usd: 2.384848,
    model: 'seedance-2.0-mini',
    duration_seconds: 8,
    aspect_ratio: '9:16',
    resolution: '480p',
    dom_snapshot_sha256: 'a'.repeat(64),
  }
}

test('25 美元允许九镜精确预扣合同', () => {
  assert.deepEqual(validatePaidContract(contract), contract)
})

test('10 美元不能授权九镜合同', () => {
  assert.throws(
    () => validatePaidContract({ ...contract, spendCapUsd: 10 }),
    /FUMIN_FULL_EPISODE_BUDGET_EXCEEDED/,
  )
})

test('下一镜必须严格顺序且上一镜已验收', () => {
  const manifest = {
    contract,
    tasks: [{ shot_number: 1, status: 'completed_verified', balance_evidence: liveEvidence(78, '2026-08-25T05:50:00.000Z') }],
  }
  assert.equal(assertNextShotAllowed(manifest, 2, liveEvidence(77), now), 2)
  assert.throws(() => assertNextShotAllowed(manifest, 3, liveEvidence(77), now), /FUMIN_FULL_EPISODE_SHOT_OUT_OF_ORDER/)
})

test('派生后的六镜全部验收后下一镜严格为第 7 镜', () => {
  const resumeContract = { ...contract, initialBalanceUsd: 60.16 }
  const manifest = {
    contract: resumeContract,
    tasks: Array.from({ length: 6 }, (_, index) => ({
      shot_number: index + 1,
      status: 'completed_verified',
      balance_evidence: liveEvidence(50 - index, `2026-08-25T05:${String(40 + index).padStart(2, '0')}:00.000Z`),
    })),
  }
  const nextEvidence = liveEvidence(44, '2026-08-25T05:58:00.000Z')

  assert.equal(assertNextShotAllowed(manifest, 7, nextEvidence, now), 7)
  assert.throws(
    () => assertNextShotAllowed(manifest, 8, nextEvidence, now),
    /FUMIN_FULL_EPISODE_SHOT_OUT_OF_ORDER/,
  )
})

test('失败或结果未知永久阻断后续镜头', () => {
  for (const status of ['failed', 'submission_unknown', 'needs_attention']) {
    const manifest = { contract, tasks: [{ shot_number: 1, status }] }
    assert.throws(
      () => assertNextShotAllowed(manifest, 2, liveEvidence(77), now),
      /FUMIN_FULL_EPISODE_PREVIOUS_NOT_VERIFIED/,
    )
  }
})

test('同一镜已有任务时禁止再次提交', () => {
  const manifest = { contract, tasks: [{ shot_number: 1, status: 'completed_verified' }] }
  assert.throws(() => assertNextShotAllowed(manifest, 1, liveEvidence(77), now), /FUMIN_FULL_EPISODE_SHOT_ALREADY_ATTEMPTED/)
})

test('累计余额变化加下一镜预扣超过硬上限时停止', () => {
  const tasks = Array.from({ length: 8 }, (_, index) => ({
    shot_number: index + 1,
    status: 'completed_verified',
    balance_evidence: liveEvidence(57, `2026-08-25T05:${String(40 + index).padStart(2, '0')}:00.000Z`),
  }))
  assert.throws(
    () => assertNextShotAllowed({ contract, tasks }, 9, liveEvidence(56), now),
    /FUMIN_FULL_EPISODE_NEXT_SHOT_OVER_CAP/,
  )
})

test('九镜后禁止第十次提交', () => {
  const tasks = Array.from({ length: 9 }, (_, index) => ({
    shot_number: index + 1,
    status: 'completed_verified',
  }))
  assert.throws(
    () => assertNextShotAllowed({ contract, tasks }, 10, liveEvidence(60), now),
    /FUMIN_FULL_EPISODE_SUBMIT_LIMIT_REACHED/,
  )
})

test('余额证据必须来自同账户、同配置、五分钟内的浏览器快照', () => {
  assert.equal(validateBalanceEvidence({ contract, tasks: [] }, liveEvidence(79.29), now).balance_usd, 79.29)
  for (const patch of [
    { account_id: 'other' },
    { source_url: 'https://example.test' },
    { estimated_per_shot_usd: 1 },
    { model: 'other' },
    { dom_snapshot_sha256: '' },
    { observed_at: '2026-08-25T05:40:00.000Z' },
  ]) {
    assert.throws(
      () => validateBalanceEvidence({ contract, tasks: [] }, { ...liveEvidence(79.29), ...patch }, now),
      /FUMIN_FULL_EPISODE_BALANCE_EVIDENCE_INVALID|FUMIN_FULL_EPISODE_BALANCE_EVIDENCE_STALE/,
    )
  }
})

test('下一镜余额证据必须晚于上一镜且余额不得增加', () => {
  const previous = liveEvidence(77, '2026-08-25T05:57:00.000Z')
  const manifest = { contract, tasks: [{ shot_number: 1, status: 'completed_verified', balance_evidence: previous }] }
  assert.throws(
    () => assertNextShotAllowed(manifest, 2, liveEvidence(78), now),
    /FUMIN_FULL_EPISODE_BALANCE_INCREASED/,
  )
  assert.throws(
    () => assertNextShotAllowed(manifest, 2, liveEvidence(76, '2026-08-25T05:56:00.000Z'), now),
    /FUMIN_FULL_EPISODE_BALANCE_EVIDENCE_NOT_NEW/,
  )
})
