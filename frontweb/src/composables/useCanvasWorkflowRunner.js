import { taskAPI } from '@/api/task'
import { imagesAPI } from '@/api/images'
import { storyboardsAPI } from '@/api/storyboards'
import { videosAPI } from '@/api/videos'
import request from '@/utils/request'
import { storyboardImageUrl } from '@/utils/mediaUrl'
import {
  DEFAULT_PIPELINE,
  collectStoryboardReferenceAssets,
  getAdjacentStoryboards,
  findStoryboardInDrama,
  getDramaGenerationOptions,
  getStoryboardImageFrameType,
  getStoryboardGridFrameType,
  getStoryboardImageModel,
  getStoryboardVideoModel,
  toAbsoluteMediaUrl,
  buildCanvasPhotographyPrompt,
} from '@/utils/canvasWorkflow'
import { dramaUsesFirstLastFrame, sbVideoFirstLastUrls } from '@/utils/storyboardMedia'
import { buildStoryboardContinuityPrompt } from '@/utils/videoContinuity'

async function pollTaskSimple(taskId, options = {}) {
  if (!taskId) return { status: 'failed', error: '缺少 task_id' }
  const maxAttempts = options.maxAttempts ?? 450
  const interval = options.interval ?? 2000
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, interval))
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

async function resolveCanvasFramePrompt(sb, frameKind) {
  const frameType = frameKind === 'last' ? 'last' : 'first'
  const fallback = frameKind === 'last'
    ? (sb.video_prompt || sb.result || sb.action || sb.description || '')
    : (sb.polished_prompt || sb.image_prompt || sb.description || sb.action || '')
  if (!sb?.id || !frameKind) return fallback

  try {
    const cached = await storyboardsAPI.getFramePrompts(sb.id)
    const prompt = (cached?.frame_prompts || []).find((item) => item.frame_type === frameType)?.prompt
    if (prompt?.trim()) return prompt.trim()

    const generated = await storyboardsAPI.generateFramePrompt(sb.id, { frame_type: frameType })
    if (generated?.task_id) {
      const task = await pollTaskSimple(generated.task_id)
      const fromTask = task.result?.response?.single_frame?.prompt
      if (task.status === 'completed' && fromTask?.trim()) return fromTask.trim()
    }
    const refreshed = await storyboardsAPI.getFramePrompts(sb.id)
    const refreshedPrompt = (refreshed?.frame_prompts || []).find((item) => item.frame_type === frameType)?.prompt
    return refreshedPrompt?.trim() || fallback
  } catch (_) {
    return fallback
  }
}

async function hydrateStoryboardSettings(storyboard) {
  if (!storyboard?.id) return storyboard
  const hasImageSettings = Object.prototype.hasOwnProperty.call(storyboard, 'image_model')
    && Object.prototype.hasOwnProperty.call(storyboard, 'grid_frame_type')
  const hasVideoModel = Object.prototype.hasOwnProperty.call(storyboard, 'video_model')
  if (hasImageSettings && hasVideoModel) return storyboard
  try {
    const detail = await storyboardsAPI.get(storyboard.id)
    if (Number(detail?.id) === Number(storyboard.id)) return { ...storyboard, ...detail }
  } catch (_) {
    // 兼容尚未部署新分镜字段的服务，继续使用当前对象和项目默认配置。
  }
  return storyboard
}

export async function runImageStep(drama, sb, genOpts, frameKind = '', options = {}) {
  const effectiveStoryboard = await hydrateStoryboardSettings(sb)
  const basePrompt = await resolveCanvasFramePrompt(effectiveStoryboard, frameKind)
  const prompt = buildCanvasPhotographyPrompt(basePrompt, effectiveStoryboard)
  if (!prompt.trim()) throw new Error(`分镜 #${effectiveStoryboard.storyboard_number ?? effectiveStoryboard.id} 缺少图片提示词`)
  const frameType = options.frameType
    || getStoryboardImageFrameType(frameKind)
    || (!frameKind ? getStoryboardGridFrameType(effectiveStoryboard) : undefined)
  const referenceImages = frameType
    ? collectStoryboardReferenceAssets(drama, effectiveStoryboard).map((ref) => ref.absoluteUrl).filter(Boolean)
    : []
  const isLastFrame = frameKind === 'last'
  const res = await imagesAPI.create({
    storyboard_id: effectiveStoryboard.id,
    drama_id: drama.id,
    prompt,
    model: getStoryboardImageModel(effectiveStoryboard, genOpts) || undefined,
    style: genOpts.style || undefined,
    aspect_ratio: genOpts.aspectRatio,
    frame_type: frameType,
    reference_images: referenceImages.length ? referenceImages : undefined,
    use_first_frame_layout_lock: isLastFrame ? true : undefined,
  })
  if (res?.task_id) {
    const polled = await pollTaskSimple(res.task_id)
    if (polled.status !== 'completed') throw new Error(polled.error || '分镜图生成失败')
  }
}

export async function runVideoStep(drama, sb, genOpts) {
  sb = await hydrateStoryboardSettings(sb)
  const useFirstLast = dramaUsesFirstLastFrame(drama)
  const imagesBySbId = genOpts?.imagesBySbId || {}
  const { first, last } = sbVideoFirstLastUrls(sb, imagesBySbId, useFirstLast)
  const imgPath = first || storyboardImageUrl(sb)
  if (!imgPath && !sb.video_prompt && !last) {
    throw new Error(`分镜 #${sb.storyboard_number ?? sb.id} 缺少分镜图，无法生成视频`)
  }
  const absoluteFirst = toAbsoluteMediaUrl(imgPath)
  const absoluteLast = last ? toAbsoluteMediaUrl(last) : undefined
  const selectedReferenceUrls = collectStoryboardReferenceAssets(drama, sb)
    .map((ref) => ref.absoluteUrl)
    .filter(Boolean)
  const referenceUrls = [...new Set([
    absoluteFirst,
    ...selectedReferenceUrls,
    absoluteLast,
  ].filter(Boolean))].slice(0, 10)
  const basePrompt = sb.video_prompt || sb.polished_prompt || sb.image_prompt || sb.description || ''
  const found = findStoryboardInDrama(drama, sb.id)
  const { previous, next } = getAdjacentStoryboards(found?.episode, sb.id)
  const prompt = buildStoryboardContinuityPrompt({
    prompt: basePrompt,
    current: sb,
    previous,
    next,
  })
  const model = getStoryboardVideoModel(sb, genOpts)
  const res = await videosAPI.create({
    drama_id: drama.id,
    storyboard_id: sb.id,
    prompt,
    model: model || undefined,
    image_url: absoluteFirst || undefined,
    first_frame_url: absoluteFirst || undefined,
    last_frame_url: absoluteLast,
    reference_image_urls: referenceUrls.length ? referenceUrls : undefined,
    style: genOpts.style || undefined,
    aspect_ratio: genOpts.aspectRatio,
    resolution: genOpts.videoResolution || undefined,
    duration: sb.duration || undefined,
  })
  if (res?.task_id) {
    const polled = await pollTaskSimple(res.task_id)
    if (polled.status !== 'completed') throw new Error(polled.error || '视频生成失败')
  }
}

export async function runAudioStep(sb) {
  const text = (sb.dialogue || '').trim()
  if (!text) return { skipped: true, reason: '无对白' }
  await request.post('/audio/extract', {
    storyboard_id: sb.id,
    text,
    tts_kind: 'dialogue',
  })
  return { skipped: false }
}

/**
 * 对单个分镜按 pipeline 顺序执行生成
 * @param {'image'|'video'|'audio'}[] pipeline
 */
export async function runStoryboardPipeline(drama, storyboardId, pipeline, hooks = {}) {
  const found = findStoryboardInDrama(drama, storyboardId)
  if (!found) throw new Error(`找不到分镜 ${storyboardId}`)
  let { storyboard: sb } = found
  const genOpts = {
    ...getDramaGenerationOptions(drama),
    ...(hooks.generationOptions || {}),
  }
  const steps = pipeline?.length ? pipeline : DEFAULT_PIPELINE
  const results = []

  for (const step of steps) {
    hooks.onStepStart?.({ storyboardId, step, sb })
    try {
      if (step === 'image') {
        await runImageStep(drama, sb, genOpts, '', {
          frameType: getStoryboardGridFrameType(sb),
        })
        if (hooks.reloadStoryboard) {
          sb = (await hooks.reloadStoryboard(storyboardId)) || sb
        }
      } else if (step === 'video') {
        await runVideoStep(drama, sb, genOpts)
        if (hooks.reloadStoryboard) {
          sb = (await hooks.reloadStoryboard(storyboardId)) || sb
        }
      } else if (step === 'audio') {
        const audioRes = await runAudioStep(sb)
        results.push({ step, ...audioRes })
      }
      hooks.onStepComplete?.({ storyboardId, step, sb })
    } catch (err) {
      hooks.onStepError?.({ storyboardId, step, error: err })
      throw err
    }
  }
  return results
}

/** 按工作流组顺序执行（组内分镜按 storyboard_ids 顺序） */
export async function runWorkflowGroup(drama, group, hooks = {}) {
  const pipeline = group.pipeline || DEFAULT_PIPELINE
  const ids = group.storyboard_ids || []
  const summary = { groupId: group.id, ok: [], failed: [] }

  for (const sbId of ids) {
    hooks.onStoryboardStart?.({ group, storyboardId: sbId })
    try {
      await runStoryboardPipeline(drama, sbId, pipeline, hooks)
      summary.ok.push(sbId)
      hooks.onStoryboardComplete?.({ group, storyboardId: sbId })
    } catch (err) {
      summary.failed.push({ storyboardId: sbId, error: err.message || String(err) })
      hooks.onStoryboardError?.({ group, storyboardId: sbId, error: err })
      if (hooks.stopOnError) break
    }
  }
  return summary
}
