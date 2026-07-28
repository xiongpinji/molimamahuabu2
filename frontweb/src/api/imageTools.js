import request from '@/utils/request'

let capabilitiesRequest = null

export const imageToolsAPI = {
  getCapabilities() {
    capabilitiesRequest ||= request.get('/image-tools/capabilities').catch((error) => {
      capabilitiesRequest = null
      throw error
    })
    return capabilitiesRequest
  },
  createOperation(payload) {
    return request.post('/image-tools/operations', payload)
  },
  getOperation(taskId) {
    return request.get(`/image-tools/operations/${taskId}`)
  },
}
