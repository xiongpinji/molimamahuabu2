import request from '@/utils/request'

export const videosAPI = {
  list(params) {
    return request.get('/videos', { params: params || {} })
  },
  /** 创建单条分镜视频生成任务，body: { drama_id, storyboard_id, prompt, image_url?, model?, ... } */
  create(body) {
    return request.post('/videos', body)
  },
  /** 素材库视频复用：把已有视频直接挂到分镜作为成片（不生成、不计费） */
  attach(body) {
    return request.post('/videos/attach', body)
  },
}
