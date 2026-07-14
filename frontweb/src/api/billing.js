import request from '@/utils/request'

export function listModelPrices() {
  return request.get('/billing/prices')
}

export function updateModelPrice(model, credits) {
  return request.put(`/billing/prices/${encodeURIComponent(model)}`, { credits })
}
