const EXPECTED_SHOTS = 9
const MAX_BALANCE_EVIDENCE_AGE_MS = 5 * 60 * 1_000
const MAX_FUTURE_SKEW_MS = 60 * 1_000

function fail(code, message) {
  throw Object.assign(new Error(`${code}: ${message}`), { code })
}

function finiteMoney(value, field) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    fail('FUMIN_FULL_EPISODE_CONTRACT_INVALID', `${field} 必须为正数`)
  }
  return number
}

export function validatePaidContract(input = {}) {
  const expectedShots = Number(input.expectedShots)
  const maxPaidSubmits = Number(input.maxPaidSubmits)
  if (expectedShots !== EXPECTED_SHOTS || maxPaidSubmits !== EXPECTED_SHOTS) {
    fail('FUMIN_FULL_EPISODE_CONTRACT_INVALID', '整集必须固定为九镜且最多九次提交')
  }
  const spendCapUsd = finiteMoney(input.spendCapUsd, 'spendCapUsd')
  const estimatedPerShotUsd = finiteMoney(input.estimatedPerShotUsd, 'estimatedPerShotUsd')
  const estimatedTotalUsd = finiteMoney(input.estimatedTotalUsd, 'estimatedTotalUsd')
  const initialBalanceUsd = finiteMoney(input.initialBalanceUsd, 'initialBalanceUsd')
  const accountId = String(input.accountId || '').trim()
  if (!accountId) {
    fail('FUMIN_FULL_EPISODE_CONTRACT_INVALID', 'accountId 不能为空')
  }
  const calculated = Number((estimatedPerShotUsd * expectedShots).toFixed(6))
  if (Math.abs(calculated - estimatedTotalUsd) > 0.000001) {
    fail('FUMIN_FULL_EPISODE_CONTRACT_INVALID', '九镜预估与单镜预估不一致')
  }
  if (estimatedTotalUsd > spendCapUsd) {
    fail('FUMIN_FULL_EPISODE_BUDGET_EXCEEDED', '九镜预估超过硬预算')
  }
  if (initialBalanceUsd < spendCapUsd) {
    fail('FUMIN_FULL_EPISODE_BALANCE_INSUFFICIENT', '初始余额低于硬预算')
  }
  return {
    expectedShots,
    maxPaidSubmits,
    spendCapUsd,
    estimatedPerShotUsd,
    estimatedTotalUsd,
    initialBalanceUsd,
    accountId,
  }
}

export function validateBalanceEvidence(manifest = {}, input = {}, nowMs = Date.now()) {
  const contract = validatePaidContract(manifest.contract)
  const observedAtMs = Date.parse(String(input.observed_at || ''))
  const observedBalanceUsd = Number(input.balance_usd)
  const estimatedPerShotUsd = Number(input.estimated_per_shot_usd)
  const exactFieldsValid = input.schema_version === 'fumin-live-balance-evidence-v1'
    && input.provider === 'fumin.ai'
    && input.account_id === contract.accountId
    && input.source_url === 'https://fumin.ai/console'
    && input.captured_by === 'codex-in-app-browser'
    && input.model === 'seedance-2.0-mini'
    && Number(input.duration_seconds) === 8
    && input.aspect_ratio === '9:16'
    && String(input.resolution).toLowerCase() === '480p'
    && /^[a-f0-9]{64}$/i.test(String(input.dom_snapshot_sha256 || ''))
    && Number.isFinite(observedBalanceUsd)
    && observedBalanceUsd >= 0
    && observedBalanceUsd <= contract.initialBalanceUsd
    && Number.isFinite(estimatedPerShotUsd)
    && Math.abs(estimatedPerShotUsd - contract.estimatedPerShotUsd) <= 0.000001
  if (!exactFieldsValid || !Number.isFinite(observedAtMs)) {
    fail('FUMIN_FULL_EPISODE_BALANCE_EVIDENCE_INVALID', '余额证据与授权账户或生成配置不匹配')
  }
  if (nowMs - observedAtMs > MAX_BALANCE_EVIDENCE_AGE_MS || observedAtMs - nowMs > MAX_FUTURE_SKEW_MS) {
    fail('FUMIN_FULL_EPISODE_BALANCE_EVIDENCE_STALE', '余额证据必须在提交前五分钟内采集')
  }
  const tasks = Array.isArray(manifest.tasks) ? manifest.tasks : []
  const previous = [...tasks].reverse().find((task) => task?.balance_evidence)?.balance_evidence
  if (tasks.length > 0 && !previous) {
    fail('FUMIN_FULL_EPISODE_BALANCE_EVIDENCE_INVALID', '上一镜缺少余额证据')
  }
  if (previous) {
    const previousAtMs = Date.parse(String(previous.observed_at || ''))
    if (!Number.isFinite(previousAtMs) || observedAtMs <= previousAtMs) {
      fail('FUMIN_FULL_EPISODE_BALANCE_EVIDENCE_NOT_NEW', '下一镜必须使用更新的余额证据')
    }
    if (observedBalanceUsd > Number(previous.balance_usd) + 0.000001) {
      fail('FUMIN_FULL_EPISODE_BALANCE_INCREASED', '余额高于上一镜证据，无法可靠计算累计消耗')
    }
  }
  return {
    schema_version: input.schema_version,
    provider: input.provider,
    account_id: input.account_id,
    source_url: input.source_url,
    captured_by: input.captured_by,
    observed_at: new Date(observedAtMs).toISOString(),
    balance_usd: observedBalanceUsd,
    estimated_per_shot_usd: estimatedPerShotUsd,
    model: input.model,
    duration_seconds: 8,
    aspect_ratio: input.aspect_ratio,
    resolution: '480p',
    dom_snapshot_sha256: String(input.dom_snapshot_sha256).toLowerCase(),
  }
}

export function assertNextShotAllowed(manifest = {}, shotNumber, balanceEvidence, nowMs = Date.now()) {
  const contract = validatePaidContract(manifest.contract)
  const tasks = Array.isArray(manifest.tasks) ? manifest.tasks : []
  const number = Number(shotNumber)
  if (tasks.length >= contract.maxPaidSubmits || number > contract.expectedShots) {
    fail('FUMIN_FULL_EPISODE_SUBMIT_LIMIT_REACHED', '整集真实提交次数已经达到上限')
  }
  if (tasks.some((task) => Number(task.shot_number) === number)) {
    fail('FUMIN_FULL_EPISODE_SHOT_ALREADY_ATTEMPTED', `镜头 ${number} 已有提交记录`)
  }
  if (tasks.some((task) => task.status !== 'completed_verified')) {
    fail('FUMIN_FULL_EPISODE_PREVIOUS_NOT_VERIFIED', '存在未通过验收的历史镜头')
  }
  const expectedNext = tasks.length + 1
  if (number !== expectedNext) {
    fail('FUMIN_FULL_EPISODE_SHOT_OUT_OF_ORDER', `下一镜必须是 ${expectedNext}`)
  }
  const verifiedEvidence = validateBalanceEvidence(manifest, balanceEvidence, nowMs)
  const observed = verifiedEvidence.balance_usd
  const spent = contract.initialBalanceUsd - observed
  if (spent + verifiedEvidence.estimated_per_shot_usd > contract.spendCapUsd + 0.000001) {
    fail('FUMIN_FULL_EPISODE_NEXT_SHOT_OVER_CAP', '累计消耗加下一镜预扣将超过硬预算')
  }
  return number
}

export { EXPECTED_SHOTS }
