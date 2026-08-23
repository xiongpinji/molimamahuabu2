const IMAGE_FILE_EXTENSION = /\.(?:avif|gif|jpe?g|png|webp)$/i
const IMAGE_FILE_TYPES = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'])

export function hasDraggedFilePayload(dataTransfer) {
  if (!dataTransfer) return false
  if ([...(dataTransfer.files || [])].length) return true
  if ([...(dataTransfer.items || [])].some((item) => item?.kind === 'file')) return true
  return [...(dataTransfer.types || [])].includes('Files')
}

export function collectDroppedImageFiles(dataTransfer) {
  return [...(dataTransfer?.files || [])].filter((file) => {
    const type = String(file?.type || '').toLowerCase()
    const name = String(file?.name || '')
    return IMAGE_FILE_TYPES.has(type) || (!type && IMAGE_FILE_EXTENSION.test(name))
  })
}

export function stripLocalImagePreviewsForPersistence(nodes) {
  return [...(nodes || [])].map((node) => {
    const data = node?.data
    if (!data || (!String(data.url || '').startsWith('blob:') && data.localPreview !== true)) return node
    return {
      ...node,
      data: {
        ...data,
        url: '',
        localPreview: false,
      },
    }
  })
}

export function createDroppedImageNodeSpecs(files, origin, createObjectUrl) {
  const base = {
    x: Number(origin?.x || 0),
    y: Number(origin?.y || 0),
  }
  return files.map((file, index) => {
    const previewUrl = createObjectUrl(file)
    return {
      file,
      previewUrl,
      position: {
        x: base.x + index * 40,
        y: base.y + index * 40,
      },
      data: {
        kind: 'image',
        title: String(file?.name || '本地图片'),
        content: '',
        url: previewUrl,
        status: 'running',
        error: '',
        localPreview: true,
      },
    }
  })
}
