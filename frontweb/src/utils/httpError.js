const HTML_ERROR_PATTERN = /^\s*(?:<!doctype\s+html|<html\b)|<\s*(?:head|body|title|center|h1)\b/i

function isHtmlErrorText(value) {
  return HTML_ERROR_PATTERN.test(String(value || ''))
}

export function apiErrorMessage(payload, fallback = '') {
  if (!payload) return fallback
  if (typeof payload === 'string') {
    const text = payload.trim()
    return text && !isHtmlErrorText(text) ? text : fallback
  }
  const direct = payload.message || payload.detail || payload.reason || payload.provider_message
  if (typeof direct === 'string' && direct.trim() && !isHtmlErrorText(direct)) return direct.trim()
  if (payload.error && payload.error !== payload) {
    const nested = apiErrorMessage(payload.error)
    if (nested) return nested
  }
  if (Array.isArray(payload.errors) && payload.errors.length) {
    return payload.errors.map((item) => apiErrorMessage(item)).filter(Boolean).join('；') || fallback
  }
  return fallback
}

export function isTransientHttpError(error) {
  if (!error?.response) return true
  return [502, 503, 504].includes(Number(error.response.status))
}

export function userHttpErrorMessage(error, fallback = '网络错误') {
  const backendMessage = apiErrorMessage(error?.response?.data)
  if (backendMessage) return backendMessage
  const status = Number(error?.response?.status || 0)
  if ([502, 503, 504].includes(status)) return '服务暂时不可用，请稍后重试'
  if (!error?.response) return '网络连接中断，请稍后重试'
  const message = String(error?.message || '').trim()
  return message && !isHtmlErrorText(message) ? message : fallback
}
