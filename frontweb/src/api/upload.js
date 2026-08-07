import request from '@/utils/request'

export function uploadRechargePackageImage(file) {
  const form = new FormData()
  form.append('file', file)
  return request.post('/billing/admin/recharge-packages/image', form, {
    headers: { 'Content-Type': 'multipart/form-data' }
  })
}

export const uploadAPI = {
  /**
   * 上传图片文件，返回 { url, local_path }。需传 File 对象。
   * @param {File} file
   * @param {{ dramaId?: number|string|null }} [opts] 有剧集 id 时写入 projects/…/uploads/，否则仍为根目录 uploads/
   */
  uploadImage(file, opts = {}) {
    const form = new FormData()
    form.append('file', file)
    const did = opts.dramaId
    if (did != null && did !== '' && Number(did) > 0) {
      form.append('drama_id', String(did))
    }
    return request.post('/upload/image', form, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
  },
  /** 上传 GLB/VRM 三维资源，返回 { url, local_path }。 */
  uploadModel(file, opts = {}) {
    const form = new FormData()
    form.append('file', file)
    const did = opts.dramaId
    if (did != null && did !== '' && Number(did) > 0) form.append('drama_id', String(did))
    return request.post('/upload/model', form, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
  },
  /** 上传素材库媒体文件（图片/视频/音频），并在后端登记为项目素材。 */
  uploadMedia(file, opts = {}) {
    const form = new FormData()
    form.append('file', file)
    const did = opts.dramaId
    if (did != null && did !== '' && Number(did) > 0) form.append('drama_id', String(did))
    if (opts.name) form.append('name', String(opts.name))
    return request.post('/upload/media', form, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
  },
  /**
   * 从图片（base64 data URL 或 http URL）提取实体特征描述，不依赖已有实体 ID。
   * entityType: 'character' | 'scene' | 'prop'
   * imageUrl: data:image/xxx;base64,... 或 http URL
   */
  extractDescriptionFromImage(entityType, imageUrl, entityName) {
    return request.post('/extract-description-from-image', {
      entity_type: entityType,
      image_url: imageUrl,
      entity_name: entityName || undefined,
    })
  }
}
