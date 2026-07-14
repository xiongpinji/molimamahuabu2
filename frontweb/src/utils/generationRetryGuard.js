const indeterminateGenerationMarkers = ['结果未知', '状态未知', '供应商任务仍可能处理中']

export function isIndeterminateGenerationError(errorMessage) {
  const message = String(errorMessage || '')
  return indeterminateGenerationMarkers.some((marker) => message.includes(marker))
}

export async function confirmUnknownResultRetry(errorMessage, confirm) {
  if (!isIndeterminateGenerationError(errorMessage)) return true
  try {
    await confirm()
    return true
  } catch (_) {
    return false
  }
}
