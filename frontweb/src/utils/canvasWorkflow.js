import { parseDramaMetadata } from './canvasLayout.js'
import {
  parseStoryboardCharacterIds,
  parseStoryboardPropIds,
  parseStoryboardSceneId,
} from './canvasEntityIds.js'
import { assetImageUrl } from './mediaUrl.js'

export const DEFAULT_PIPELINE = ['image', 'video', 'audio']

export function parseWorkflowGroups(metadata) {
  const meta = parseDramaMetadata(metadata)
  const groups = meta.workflow_groups
  return Array.isArray(groups) ? groups : []
}

export function storyboardIdFromNodeId(nodeId) {
  if (!nodeId || typeof nodeId !== 'string') return null
  if (!nodeId.startsWith('sb:')) return null
  const id = Number(nodeId.slice(3))
  return Number.isFinite(id) ? id : null
}

export function nodeIdFromStoryboardId(storyboardId) {
  return `sb:${storyboardId}`
}

export function getStoryboardGroupMap(workflowGroups) {
  const map = new Map()
  for (const group of workflowGroups || []) {
    for (const sbId of group.storyboard_ids || []) {
      map.set(Number(sbId), group)
    }
  }
  return map
}

export function createWorkflowGroup(existingGroups, { title, storyboardIds, pipeline = DEFAULT_PIPELINE }) {
  const ids = [...new Set((storyboardIds || []).map(Number).filter(Number.isFinite))]
  if (!ids.length) throw new Error('请至少选择一个分镜')
  const group = {
    id: `wg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: title || `工作流 ${(existingGroups?.length || 0) + 1}`,
    storyboard_ids: ids,
    pipeline: normalizePipeline(pipeline),
    created_at: new Date().toISOString(),
  }
  return [...(existingGroups || []), group]
}

export function deleteWorkflowGroup(existingGroups, groupId) {
  return (existingGroups || []).filter((g) => g.id !== groupId)
}

export function reorderWorkflowGroup(existingGroups, groupId, storyboardIds) {
  const ids = [...new Set((storyboardIds || []).map(Number).filter(Number.isFinite))]
  return (existingGroups || []).map((group) => (
    group.id === groupId
      ? { ...group, storyboard_ids: ids }
      : group
  ))
}

export function normalizePipeline(pipeline) {
  const allowed = ['image', 'video', 'audio']
  const list = Array.isArray(pipeline) ? pipeline.filter((s) => allowed.includes(s)) : []
  return list.length ? list : [...DEFAULT_PIPELINE]
}

export function findStoryboardInDrama(drama, storyboardId) {
  for (const ep of drama?.episodes || []) {
    const sb = (ep.storyboards || []).find((s) => s.id === storyboardId)
    if (sb) return { storyboard: sb, episode: ep }
  }
  return null
}

/** 分镜级模型优先，未设置时回退到项目画布默认模型。 */
export function getStoryboardVideoModel(storyboard, generationOptions = {}) {
  const override = String(storyboard?.video_model || '').trim()
  return override || String(generationOptions?.videoModel || '').trim()
}

/** 分镜级图像模型优先，未设置时回退到项目画布默认模型。 */
export function getStoryboardImageModel(storyboard, generationOptions = {}) {
  const override = String(storyboard?.image_model || '').trim()
  return override || String(generationOptions?.imageModel || '').trim()
}

/** 分镜图版式为单张时不传 frame_type，保持后端默认行为。 */
export function getStoryboardGridFrameType(storyboard) {
  const value = String(storyboard?.grid_frame_type || '').trim()
  return value && value !== 'single' ? value : undefined
}

/** 返回同一剧集中的前后分镜，按分镜编号保持稳定顺序。 */
export function getAdjacentStoryboards(episode, storyboardId) {
  const storyboards = Array.isArray(episode?.storyboards) ? [...episode.storyboards] : []
  storyboards.sort((a, b) => (
    Number(a?.storyboard_number || 0) - Number(b?.storyboard_number || 0)
    || Number(a?.id || 0) - Number(b?.id || 0)
  ))
  const index = storyboards.findIndex((item) => Number(item?.id) === Number(storyboardId))
  if (index < 0) return { previous: null, next: null }
  return {
    previous: storyboards[index - 1] || null,
    next: storyboards[index + 1] || null,
  }
}

export function getDramaGenerationOptions(drama) {
  const meta = parseDramaMetadata(drama?.metadata)
  return {
    aspectRatio: meta.aspect_ratio || '16:9',
    style: meta.style_prompt_en || meta.style_prompt_zh || drama?.style || '',
    videoResolution: meta.video_resolution || '480p',
    imageModel: meta.image_model || '',
    videoModel: meta.video_model || '',
  }
}

export function getStoryboardImageFrameType(frameKind) {
  if (frameKind === 'first') return 'storyboard_first'
  if (frameKind === 'last') return 'storyboard_last'
  return undefined
}

export function universalPromptDuration(storyboard) {
  const duration = Number(storyboard?.duration)
  return Number.isFinite(duration) && duration > 0 ? duration : 5
}

export function buildUniversalPromptFieldOverrides(storyboard) {
  const fields = [
    'title', 'description', 'location', 'time', 'action', 'dialogue',
    'narration', 'result', 'atmosphere', 'shot_type', 'movement',
    'layout_description',
  ]
  return Object.fromEntries(fields.map((field) => [field, storyboard?.[field] || '']))
}

const PHOTOGRAPHY_LABELS = Object.freeze({
  angle_h: Object.freeze({
    front: '正面', front_left: '前左45度', left: '左侧', back_left: '后左135度',
    back: '背面', back_right: '后右135度', right: '右侧', front_right: '前右45度',
  }),
  angle_v: Object.freeze({ worm: '虫眼仰拍', low: '低角度仰拍', eye_level: '平视', high: '高角度俯拍' }),
  angle_s: Object.freeze({ close_up: '近景特写', medium: '中景', wide: '远景全景' }),
  lighting_style: Object.freeze({
    natural: '自然光', front: '顺光', side: '侧光', backlit: '逆光', soft: '柔光',
    dramatic: '戏剧光', golden_hour: '黄金时段光', blue_hour: '蓝调时刻光', night: '夜景低调光', neon: '霓虹光',
  }),
})

/** 把画布摄影控件转成一次生图可读的指令，避免参数只保存不生效。 */
export function buildCanvasPhotographyPrompt(prompt, storyboard) {
  const base = String(prompt || '').trim()
  const labels = [
    ['angle_h', '水平机位'],
    ['angle_v', '垂直机位'],
    ['angle_s', '景别'],
    ['lighting_style', '灯光'],
  ].flatMap(([field, name]) => {
    const value = String(storyboard?.[field] || '').trim()
    const label = PHOTOGRAPHY_LABELS[field]?.[value]
    return label ? [`${name}${label}`] : []
  })
  if (!labels.length || base.includes('画布摄影控制：')) return base
  return `${base}${base.endsWith('。') ? '' : '。'}画布摄影控制：${labels.join('，')}。`
}

/** 返回当前分镜已关联且有图片的参考资产，顺序与列表模式一致：场景、角色、道具。 */
export function collectStoryboardReferenceAssets(drama, sb, options = {}) {
  const max = Number.isFinite(Number(options.max)) ? Math.max(1, Number(options.max)) : 10
  const refs = []
  const seen = new Set()
  const add = (kind, item) => {
    const url = assetImageUrl(item)
    if (!url) return
    const absoluteUrl = toAbsoluteMediaUrl(url)
    const key = absoluteUrl || url
    if (seen.has(key) || refs.length >= max) return
    seen.add(key)
    refs.push({
      key: `${kind}:${item.id ?? refs.length}`,
      kind,
      id: item.id ?? null,
      name: (item.name || item.location || (kind === 'character' ? '角色' : kind === 'scene' ? '场景' : '道具')).toString(),
      url,
      absoluteUrl,
    })
  }

  const sceneId = parseStoryboardSceneId(sb)
  const scene = (drama?.scenes || []).find((item) => Number(item?.id) === sceneId)
  if (scene) add('scene', scene)

  const characterIds = new Set(parseStoryboardCharacterIds(sb))
  for (const character of drama?.characters || []) {
    if (characterIds.has(Number(character?.id))) add('character', character)
  }

  const propIds = new Set(parseStoryboardPropIds(sb))
  for (const prop of drama?.props || []) {
    if (propIds.has(Number(prop?.id))) add('prop', prop)
  }
  return refs
}

export function toAbsoluteMediaUrl(url) {
  if (!url) return ''
  if (/^https?:\/\//i.test(url)) return url
  if (typeof window !== 'undefined') {
    const path = url.startsWith('/') ? url : `/static/${url.replace(/^\//, '')}`
    return `${window.location.origin}${path}`
  }
  return url
}
