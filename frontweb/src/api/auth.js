import request from '@/utils/request'

export function login(data, config = {}) {
  return request.post('/auth/login', data, config)
}

export function logout() {
  return request.post('/auth/logout')
}

export function requestRegistrationCode(data) {
  return request.post('/auth/register/code', data)
}

export function register(data, config = {}) {
  return request.post('/auth/register', data, config)
}

export function requestPasswordResetCode(data) {
  return request.post('/auth/password/code', data)
}

export function resetPassword(data, config = {}) {
  return request.post('/auth/password/reset', data, config)
}

export function changePassword(data) {
  return request.post('/auth/password/change', data)
}

export function getCurrentUser() {
  return request.get('/auth/me')
}

export function getCreditAccount() {
  return request.get('/billing/account')
}
