const indeterminateGenerationMarkers = ['结果未知', '状态未知', '供应商任务仍可能处理中']
const providerBalanceMarkers = ['insufficient balance', '余额不足', '余额不够']

export function isIndeterminateGenerationError(errorMessage) {
  const message = String(errorMessage || '')
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
