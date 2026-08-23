import request from '@/utils/request'

export function listReconciliationAnomalies(params) {
  return request.get('/billing/admin/reconciliation/anomalies', { params })
}

export function listReconciliationHistory(params) {
  return request.get('/billing/admin/reconciliation/history', { params })
}

export function refundReconciliationReservation(reservationId, data) {
  return request.post(
    `/billing/admin/reconciliation/${encodeURIComponent(reservationId)}/refund`,
    data,
  )
}
