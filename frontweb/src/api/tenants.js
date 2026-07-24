import request from '@/utils/request'

export function listTenants() {
  return request.get('/tenants')
}

export function createTenant(data) {
  return request.post('/tenants', data)
}

export function listTenantMembers(tenantId) {
  return request.get(`/tenants/${encodeURIComponent(tenantId)}/members`)
}

export function addTenantMember(tenantId, data) {
  return request.post(`/tenants/${encodeURIComponent(tenantId)}/members`, data)
}

export function removeTenantMember(tenantId, userId) {
  return request.delete(`/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(userId)}`)
}
