const STORAGE_KEY = 'moli_mama_session'
const ADMIN_TOKEN_KEY = 'moli_mama_admin_token'

function defaultStorage() {
  return typeof localStorage === 'undefined' ? null : localStorage
}

export function saveSession(session, store = defaultStorage()) {
  if (!store || !session?.token || !session?.user) return
  const user = {
    id: session.user.id,
    email: session.user.email,
    role: session.user.role,
  }
  store.setItem(STORAGE_KEY, JSON.stringify({ token: session.token, user }))
}

export function readSession(store = defaultStorage()) {
  if (!store) return null
  try {
    const session = JSON.parse(store.getItem(STORAGE_KEY) || 'null')
    return session?.token && session?.user ? session : null
  } catch (_) {
    return null
  }
}

export function clearSession(store = defaultStorage()) {
  store?.removeItem(STORAGE_KEY)
}

export function applyAuthHeader(config, store = defaultStorage()) {
  const session = readSession(store)
  config.headers = config.headers || {}
  if (session?.token) config.headers.Authorization = `Bearer ${session.token}`
  return config
}

function defaultSessionStorage() {
  return typeof sessionStorage === 'undefined' ? null : sessionStorage
}

export function saveAdminToken(token, store = defaultSessionStorage()) {
  if (store && token) store.setItem(ADMIN_TOKEN_KEY, String(token))
}

export function applyAdminHeader(config, store = defaultSessionStorage()) {
  const url = String(config.url || '')
  const isAdminRoute = url.startsWith('/ai-configs') || url.startsWith('/billing/prices')
  const token = isAdminRoute ? store?.getItem(ADMIN_TOKEN_KEY) : null
  config.headers = config.headers || {}
  if (token) config.headers['X-Platform-Admin-Token'] = token
  return config
}
