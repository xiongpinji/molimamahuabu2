import request from '@/utils/request'

let capabilitiesRequest = null

export const videoToolsAPI = {
  getCapabilities() {
    capabilitiesRequest ||= request.get('/video-tools/capabilities').catch((error) => {
      capabilitiesRequest = null
      throw error
    })
    return capabilitiesRequest
  },
  createOperation(payload) {
    return request.post('/video-tools/operations', payload)
  },
  getOperation(taskId) {
    return request.get(`/video-tools/operations/${taskId}`)
  },
}
