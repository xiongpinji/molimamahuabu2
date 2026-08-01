const IMAGE_FILE_EXTENSION = /\.(?:avif|gif|jpe?g|png|webp)$/i

export function collectDroppedImageFiles(dataTransfer) {
  return [...(dataTransfer?.files || [])].filter((file) => (
    String(file?.type || '').startsWith('image/')
    || IMAGE_FILE_EXTENSION.test(String(file?.name || ''))
  ))
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
