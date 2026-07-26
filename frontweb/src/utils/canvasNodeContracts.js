const MODEL_SERVICE_TYPES = {
  text: 'text',
  image: 'storyboard_image',
  video: 'video',
  audio: 'tts',
}

const CONNECTION_CONTRACTS = {
  text: {
    text: { output: 'text', input: 'context', label: '文本 → 文本上下文' },
    image: { output: 'text', input: 'prompt', label: '文本 → 图片提示词' },
    video: { output: 'text', input: 'prompt', label: '文本 → 视频提示词' },
    audio: { output: 'text', input: 'speech', label: '文本 → 语音内容' },
  },
  image: {
    image: { output: 'image', input: 'reference-image', label: '图片 → 图片参考图' },
    video: { output: 'image', input: 'reference-image', label: '图片 → 视频参考图' },
  },
}

export function canvasModelServiceType(kind) {
  return MODEL_SERVICE_TYPES[kind] || ''
}

export function canvasNodeKind(node) {
  const kind = node?.data?.kind
  if (kind === 'universal') return 'text'
  if (MODEL_SERVICE_TYPES[kind]) return kind
  const assetType = node?.data?.asset?.type
  if (MODEL_SERVICE_TYPES[assetType]) return assetType
  return ''
}

export function resolveCanvasNodeConnection(sourceKind, targetKind) {
  const contract = CONNECTION_CONTRACTS[sourceKind]?.[targetKind]
  return contract ? { allowed: true, ...contract } : { allowed: false }
}

export function toLibTvCanvasEdge(edge, sourceKind = '', targetKind = '') {
  const contract = resolveCanvasNodeConnection(sourceKind, targetKind)
  const edgeContract = contract.allowed
    ? { output: contract.output, input: contract.input, label: contract.label }
    : null
  return {
    ...edge,
    type: 'libtv',
    pathOptions: { curvature: 0.42 },
    data: {
      ...(edge.data || {}),
      ...(edgeContract ? { contract: edgeContract } : {}),
    },
  }
}
