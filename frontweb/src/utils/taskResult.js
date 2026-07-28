export function parseTaskResult(result) {
  if (typeof result !== 'string') return result
  try {
    return JSON.parse(result)
  } catch (_) {
    return null
  }
}
