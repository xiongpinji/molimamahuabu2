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
