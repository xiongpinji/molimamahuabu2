const MODEL_SERVICE_TYPES = {
  text: 'text',
  image: 'storyboard_image',
  video: 'video',
  audio: 'tts',
}

const CONNECTION_CONTRACTS = {
  text: {
    text: { output: 'text', input: 'context', label: '文本 → 文本上下文', slots: ['context'] },
    image: { output: 'text', input: 'prompt', label: '文本 → 图片提示词', slots: ['prompt', 'style-prompt'] },
    video: { output: 'text', input: 'prompt', label: '文本 → 视频提示词', slots: ['prompt', 'style-prompt'] },
    audio: { output: 'text', input: 'speech', label: '文本 → 语音内容', slots: ['speech'] },
  },
  image: {
    image: { output: 'image', input: 'reference-image', label: '图片 → 图片参考图', slots: ['reference-image', 'character-reference', 'style-reference'] },
    video: { output: 'image', input: 'reference-image', label: '图片 → 视频参考图', slots: ['reference-image', 'first-frame', 'last-frame', 'character-reference', 'style-reference'] },
  },
  video: {
    video: { output: 'video', input: 'reference-video', label: '视频 → 视频参考', slots: ['reference-video'] },
  },
  audio: {
    video: { output: 'audio', input: 'reference-audio', label: '音频 → 视频参考', slots: ['reference-audio'] },
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
  return contract ? { allowed: true, ...contract, slots: [...contract.slots] } : { allowed: false }
}

export function toLibTvCanvasEdge(edge, sourceKind = '', targetKind = '') {
  const contract = resolveCanvasNodeConnection(sourceKind, targetKind)
  const previous = edge?.data?.contract || {}
  const input = contract.allowed && contract.slots.includes(previous.input) ? previous.input : contract.input
  const edgeContract = contract.allowed
    ? {
        output: contract.output,
        input,
        label: contract.label,
        slots: contract.slots,
        enabled: previous.enabled !== false,
        order: Number.isFinite(Number(previous.order)) ? Number(previous.order) : 0,
        weight: Number.isFinite(Number(previous.weight)) ? Number(previous.weight) : 1,
      }
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
