import { taskAPI } from '@/api/task'
import { characterAPI } from '@/api/characters'
import { sceneAPI } from '@/api/scenes'
import { propAPI } from '@/api/props'
import { assetImageUrl } from '@/utils/mediaUrl'
import { CANVAS_NODE_STATUS_LABELS } from '@/composables/useCanvasNodeStatus'

async function pollTask(taskId, onTick, maxAttempts = 450, interval = 2000) {
  if (!taskId) return { status: 'completed' }
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, interval))
    onTick?.()
    try {
      const t = await taskAPI.get(taskId)
      if (t.status === 'completed') return { status: 'completed', result: t.result }
      if (t.status === 'failed') {
        return { status: 'failed', error: t.error?.message || t.error || '任务失败' }
      }
    } catch (e) {
      if (i === maxAttempts - 1) return { status: 'failed', error: e.message || '轮询失败' }
    }
  }
  return { status: 'timeout', error: '任务超时' }
}

async function pollUntilHasImage(findEntity, getImage = assetImageUrl, maxAttempts = 120, interval = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    const entity = findEntity()
    if (entity && getImage(entity)) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}

export async function generateScenePanoramaImage(ctx, { entity, nodeId }) {
  const nodeStatus = ctx?.nodeStatus
  nodeStatus?.set(nodeId, { step: 'panorama', message: '全景图生成中…' })
  try {
    const res = await sceneAPI.generatePanoramaImage(entity.id)
    const taskId = res?.image_generation?.task_id ?? res?.task_id
    if (taskId) {
      const polled = await pollTask(taskId, () => ctx?.refreshDrama?.(true))
      if (polled.status !== 'completed') throw new Error(polled.error || '全景图生成失败')
      await ctx?.refreshDrama?.(true)
    } else {
      await ctx?.refreshDrama?.(true)
      const ok = await pollUntilHasImage(
        () => (ctx?.drama?.value?.scenes || []).find((x) => Number(x.id) === Number(entity.id)),
        (item) => item?.panorama_image_url || item?.panorama_local_path
      )
      if (!ok) throw new Error('全景图生成超时，请稍后刷新查看')
    }
    await ctx?.refresh?.(true)
    return { ok: true }
  } finally {
    nodeStatus?.clear(nodeId)
  }
}

/**
 * 素材参考图生成（含轮询），并同步节点 busy 状态到卡片预览
 */
export async function generateAssetReferenceImage(ctx, { kind, entity, nodeId }) {
  const nodeStatus = ctx?.nodeStatus
  const drama = ctx?.drama?.value
  const step = 'ref_image'
  nodeStatus?.set(nodeId, {
    step,
    message: CANVAS_NODE_STATUS_LABELS.ref_image,
    retryStep: step,
    retryLabel: '重试参考图',
  })

  try {
    let res
    if (kind === 'character') {
      res = await characterAPI.generateImage(entity.id)
    } else if (kind === 'scene') {
      res = await sceneAPI.generateImage({ scene_id: entity.id, drama_id: drama?.id })
    } else {
      res = await propAPI.generateImage(entity.id)
    }

    const taskId = res?.image_generation?.task_id ?? res?.task_id
    if (taskId) {
      const polled = await pollTask(taskId, () => ctx?.refreshDrama?.(true))
      if (polled.status !== 'completed') throw new Error(polled.error || '生成失败')
    } else {
      await ctx?.refreshDrama?.(true)
      const ok = await pollUntilHasImage(() => {
        const list = kind === 'character'
          ? ctx?.drama?.value?.characters
          : kind === 'scene'
            ? ctx?.drama?.value?.scenes
            : ctx?.drama?.value?.props
        return (list || []).find((x) => Number(x.id) === Number(entity.id))
      })
      if (!ok) throw new Error('生成超时，请稍后刷新查看')
    }
    await ctx?.refresh?.(true)
    nodeStatus?.success(nodeId, {
      step: 'success',
      message: '参考图已生成',
      retryStep: step,
      retryLabel: '重试参考图',
    })
    return { ok: true }
  } catch (e) {
    const message = e?.message || '参考图生成失败'
    nodeStatus?.fail(nodeId, {
      message,
      errorDetail: message,
      retryStep: step,
      retryLabel: '重试参考图',
    })
    throw e
  } finally {
    if (!['failed', 'success'].includes(nodeStatus?.get?.(nodeId)?.step)) nodeStatus?.clear(nodeId)
  }
}

/** 复用角色/场景已有多视图接口，并把任务状态映射到画布节点。 */
export async function generateAssetMultiViewImage(ctx, { kind, entity, nodeId }) {
  const nodeStatus = ctx?.nodeStatus
  nodeStatus?.set(nodeId, { step: 'multi_view', message: kind === 'character' ? '角色三视图生成中…' : '场景多视图生成中…' })
  try {
    const res = kind === 'character'
      ? await characterAPI.generateFourViewImage(entity.id)
      : await sceneAPI.generateFourViewImage(entity.id)
    const taskId = res?.image_generation?.task_id ?? res?.task_id
    if (taskId) {
      const polled = await pollTask(taskId, () => ctx?.refreshDrama?.(true))
      if (polled.status !== 'completed') throw new Error(polled.error || '多视图生成失败')
    }
    await ctx?.refreshDrama?.(true)
    await ctx?.refresh?.(true)
    return { ok: true }
  } finally {
    nodeStatus?.clear(nodeId)
  }
}
