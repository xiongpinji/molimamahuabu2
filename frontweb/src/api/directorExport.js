import request from '@/utils/request'

export const directorExportAPI = {
  create(dramaId, file, timeline) {
    const form = new FormData()
    form.append('file', file, 'director-timeline.webm')
    if (timeline) form.append('timeline', JSON.stringify(timeline))
    return request.post(`/dramas/${dramaId}/director/export`, form, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
  }
}
