const IMAGE_FILE_EXTENSION = /\.(?:avif|gif|jpe?g|png|webp)$/i
const VIDEO_FILE_EXTENSION = /\.(?:m4v|mov|mp4|webm)$/i

export function canvasMediaKind(file) {
  const type = String(file?.type || '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  const name = String(file?.name || '')
  if (IMAGE_FILE_EXTENSION.test(name)) return 'image'
  if (VIDEO_FILE_EXTENSION.test(name)) return 'video'
  return ''
}

export function collectDroppedMediaFiles(dataTransfer) {
  return [...(dataTransfer?.files || [])].filter((file) => canvasMediaKind(file))
}

export function hasDroppedFilePayload(dataTransfer) {
  if ([...(dataTransfer?.files || [])].length) return true
  if ([...(dataTransfer?.items || [])].some((item) => item?.kind === 'file')) return true
  return [...(dataTransfer?.types || [])].some((type) => String(type).toLowerCase() === 'files')
}

export function createDroppedMediaNodeSpecs(files, origin, createObjectUrl) {
  const base = {
    x: Number(origin?.x || 0),
    y: Number(origin?.y || 0),
  }
  return files.map((file, index) => {
    const kind = canvasMediaKind(file)
    const previewUrl = createObjectUrl(file)
    return {
      file,
      kind,
      previewUrl,
      position: {
        x: base.x + index * 40,
        y: base.y + index * 40,
      },
      data: {
        kind,
        title: String(file?.name || (kind === 'video' ? '本地视频' : '本地图片')),
        content: '',
        url: previewUrl,
        status: 'running',
        error: '',
        localPreview: true,
      },
    }
  })
}
