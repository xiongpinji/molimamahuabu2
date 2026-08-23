import request from '@/utils/request'

export function listModelPrices() {
  return request.get('/billing/prices')
}

export function listGenerationCatalog() {
  return request.get('/billing/catalog')
}

export function updateModelPrice(model, value) {
  const data = value && typeof value === 'object' ? value : { credits: value }
  return request.put(`/billing/prices/${encodeURIComponent(model)}`, data)
}

export function redeemCredits(code) {
  return request.post('/billing/redeem', { code })
}

export function listCreditTransactions() {
  return request.get('/billing/credit-transactions')
}

export function getCreditAccount(config) {
  return request.get('/billing/account', config)
}

export function getAlipayRechargeConfig(config) {
  return request.get('/billing/recharge/alipay/config', config)
}

export function listRechargePackages(config) {
  return request.get('/billing/recharge/packages', config)
}

export function listAlipayRechargeOrders(config) {
  return request.get('/billing/recharge/alipay/orders', config)
}

export function createAlipayRechargeOrder(data) {
  return request.post('/billing/recharge/alipay/orders', data)
}

export function listAuditEvents(limit = 30) {
  return request.get('/billing/audit-events', { params: { limit } })
}

export function listPlatformUsers() {
  return request.get('/billing/admin/users')
}

export function updatePlatformUser(userId, data) {
  return request.put(`/billing/admin/users/${encodeURIComponent(userId)}`, data)
}

export function listAdminTenants() {
  return request.get('/billing/admin/tenants')
}

export function adjustTenantCredits(tenantId, data) {
  return request.post(`/billing/admin/tenants/${encodeURIComponent(tenantId)}/credits`, data)
}

export function listAdminCreditTransactions(params) {
  return request.get('/billing/admin/credit-transactions', { params })
}

export function getLedgerSettings() {
  return request.get('/billing/admin/ledger/settings')
}

export function updateLedgerSettings(data) {
  return request.put('/billing/admin/ledger/settings', data)
}

export function getLedgerReport(period = 'day') {
  return request.get('/billing/admin/ledger/report', { params: { period } })
}

export function listRedeemCodes() {
  return request.get('/billing/admin/redeem-codes')
}

export function listAdminRechargePackages() {
  return request.get('/billing/admin/recharge-packages')
}

export function createRechargePackage(data) {
  return request.post('/billing/admin/recharge-packages', data)
}

export function updateRechargePackage(packageId, data) {
  return request.put(`/billing/admin/recharge-packages/${encodeURIComponent(packageId)}`, data)
}

export function reorderRechargePackages(packageIds) {
  return request.put('/billing/admin/recharge-packages/order', { package_ids: packageIds })
}

export function createRedeemCode(data) {
  return request.post('/billing/admin/redeem-codes', data)
}

export function createRedeemCodes(data) {
  return request.post('/billing/admin/redeem-codes/batch', data)
}

export function listRedeemCodeUsages(codeId) {
  return request.get(`/billing/admin/redeem-codes/${encodeURIComponent(codeId)}/usages`)
}

export function updateRedeemCode(codeId, data) {
  return request.put(`/billing/admin/redeem-codes/${encodeURIComponent(codeId)}`, data)
}

export function listBillingPlans() {
  return request.get('/billing/plans')
}

export function listAdminBillingPlans() {
  return request.get('/billing/admin/plans')
}

export function updateBillingPlan(planId, data) {
  return request.put(`/billing/plans/${encodeURIComponent(planId)}`, data)
}

export function getCurrentSubscription() {
  return request.get('/billing/subscription')
}

export function listBillingOrders() {
  return request.get('/billing/orders')
}

export function createBillingOrder(data) {
  return request.post('/billing/orders', data)
}

export function cancelBillingOrder(orderId) {
  return request.delete(`/billing/orders/${encodeURIComponent(orderId)}`)
}
