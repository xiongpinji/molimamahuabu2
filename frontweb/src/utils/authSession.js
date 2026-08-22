const STORAGE_KEY = 'moli_mama_session'
const ADMIN_TOKEN_KEY = 'moli_mama_admin_token'
const TENANT_KEY = 'moli_mama_tenant_id'

function defaultStorage() {
  return typeof localStorage === 'undefined' ? null : localStorage
}

export function saveSession(session, store = defaultStorage()) {
  if (!store || !session?.token || !session?.user) return
  const previousUserId = readSession(store)?.user?.id
  if (previousUserId && previousUserId !== session.user.id) {
    store.removeItem(TENANT_KEY)
  }
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
  store?.removeItem(TENANT_KEY)
}

export function clearSessionOnUnauthorized(
  status,
  publicMode,
  store = defaultStorage(),
  requestToken = '',
  errorCode = 'UNAUTHORIZED',
) {
  if (!publicMode || Number(status) !== 401) return false
  if (errorCode !== 'UNAUTHORIZED') return false
  if (requestToken && readSession(store)?.token !== requestToken) return false
  clearSession(store)
  return true
}

export function applyAuthHeader(config, store = defaultStorage()) {
  const session = readSession(store)
  config.headers = config.headers || {}
  if (session?.token) config.headers.Authorization = `Bearer ${session.token}`
  return config
}

export function saveCurrentTenantId(tenantId, store = defaultStorage()) {
  if (!store) return
  const value = String(tenantId || '').trim()
  if (value) store.setItem(TENANT_KEY, value)
  else store.removeItem(TENANT_KEY)
}

export function readCurrentTenantId(store = defaultStorage()) {
  const value = store?.getItem(TENANT_KEY)
  return value ? String(value) : null
}

export function applyTenantHeader(config, store = defaultStorage()) {
  const tenantId = readCurrentTenantId(store)
  config.headers = config.headers || {}
  if (tenantId) config.headers['X-Tenant-Id'] = tenantId
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
  const method = String(config.method || 'get').toLowerCase()
  const isAdminRoute = url.startsWith('/ai-configs')
    || url.startsWith('/billing/prices')
    || url.startsWith('/billing/admin')
    || (method !== 'get' && url.startsWith('/billing/plans'))
  const token = isAdminRoute ? store?.getItem(ADMIN_TOKEN_KEY) : null
  config.headers = config.headers || {}
  if (token) config.headers['X-Platform-Admin-Token'] = token
  return config
}
