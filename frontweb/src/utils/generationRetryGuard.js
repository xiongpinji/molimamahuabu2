const indeterminateGenerationMarkers = ['结果未知', '状态未知', '供应商任务仍可能处理中']
const providerBalanceMarkers = ['insufficient balance', '余额不足', '余额不够']
const indeterminateGenerationCodes = new Set([
  'RESULT_UNKNOWN_NEEDS_REVIEW',
  'SUBMISSION_UNKNOWN',
  'PROVIDER_SUBMISSION_UNKNOWN',
  'PROVIDER_RESULT_UNKNOWN',
])
const indeterminateGenerationStatuses = new Set([
  'needs_attention',
  'indeterminate',
  'submission_unknown',
  'result_unknown',
  'timeout',
])

function errorPayload(input) {
  if (!input || typeof input !== 'object') return null
  return input.response?.data?.error || input.response?.data || input.error || input
}

function lowerValue(value) {
  return String(value || '').trim().toLowerCase()
}

export function isIndeterminateGenerationError(errorMessage) {
  const payload = errorPayload(errorMessage)
  if (payload?.indeterminate === true || errorMessage?.indeterminate === true) return true
  const code = String(payload?.code || errorMessage?.code || '').trim().toUpperCase()
  if (indeterminateGenerationCodes.has(code)) return true
  const status = lowerValue(payload?.details?.status || payload?.status || errorMessage?.status)
  if (indeterminateGenerationStatuses.has(status)) return true
  const category = lowerValue(payload?.details?.category || payload?.category || errorMessage?.category)
  if (indeterminateGenerationStatuses.has(category)) return true
  const message = typeof errorMessage === 'string'
    ? errorMessage
    : String(payload?.message || errorMessage?.message || '')
  return indeterminateGenerationMarkers.some((marker) => message.includes(marker))
}

export function isProviderBalanceError(errorMessage) {
  const message = String(errorMessage || '').toLowerCase()
  return providerBalanceMarkers.some((marker) => message.includes(marker))
}

export async function confirmProviderBalanceRetry(errorMessage, confirm) {
  if (!isProviderBalanceError(errorMessage)) return true
  try {
    await confirm()
    return true
  } catch (_) {
    return false
  }
}

export async function confirmUnknownResultRetry(errorMessage, confirm) {
  if (!isIndeterminateGenerationError(errorMessage)) return true
  return false
}
