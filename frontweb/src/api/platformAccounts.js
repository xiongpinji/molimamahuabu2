import request from '@/utils/request'

export function listPlatformAccounts() {
  return request.get('/platform-admin/users')
}

export function changePlatformAccountRole(userId, role) {
  return request.patch(`/platform-admin/users/${encodeURIComponent(userId)}/role`, { role })
}

export function changePlatformAccountStatus(userId, status) {
  return request.patch(`/platform-admin/users/${encodeURIComponent(userId)}/status`, { status })
}

export function forcePlatformAccountLogout(userId) {
  return request.post(`/platform-admin/users/${encodeURIComponent(userId)}/force-logout`)
}
