import request from '@/utils/request'

export function listModelPrices() {
  return request.get('/billing/prices')
}

export function updateModelPrice(model, credits) {
  return request.put(`/billing/prices/${encodeURIComponent(model)}`, { credits })
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
