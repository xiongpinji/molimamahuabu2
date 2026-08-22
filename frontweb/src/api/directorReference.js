import request from '@/utils/request'

export const directorReferenceAPI = {
  analyze(dramaId, payload) {
    return request.post(`/dramas/${dramaId}/director/reference-analysis`, payload)
  },
}
