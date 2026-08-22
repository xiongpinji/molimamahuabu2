import { taskAPI } from '@/api/task'
import { imagesAPI } from '@/api/images'
import { storyboardsAPI } from '@/api/storyboards'
import { videosAPI } from '@/api/videos'
import { assetsAPI } from '@/api/assets'
import request from '@/utils/request'
import { assetMediaUrl, storyboardImageUrl } from '@/utils/mediaUrl'
import {
  DEFAULT_PIPELINE,
  collectStoryboardReferenceAssets,
  getAdjacentStoryboards,
  findStoryboardInDrama,
  getDramaGenerationOptions,
  getStoryboardImageFrameType,
  getStoryboardGridFrameType,
  getStoryboardImageModel,
  getStoryboardAudioModel,
  getStoryboardVideoModel,
  toAbsoluteMediaUrl,
  buildCanvasPhotographyPrompt,
} from '@/utils/canvasWorkflow'
import { dramaUsesFirstLastFrame, sbVideoFirstLastUrls } from '@/utils/storyboardMedia'
import { buildStoryboardContinuityPrompt, canChainStoryboardFrames } from '@/utils/videoContinuity'
import {
  appendVoicePromptToVideoPrompt,
  buildStoryboardVoiceSnapshot,
  buildVoicePromptPreview,
  classifyVideoVoicePolicy,
} from '@/utils/videoVoicePolicy'
import { buildVideoGenerationAudit, buildVideoGenerationRequest } from '@/utils/videoGenerationRequest'
import {
  canvasModelCapability,
  canvasModelEntry,
  filterCanvasCatalogFallbackModels,
} from '@/utils/canvasModelCapabilities'

/** 拉取用户指派给该分镜的素材，并保留图片、视频、音频类型。 */
async function fetchAssignedAssetReferences(storyboardId) {
  if (!storyboardId) return []
  try {
    const res = await assetsAPI.list({ storyboard_id: storyboardId, page: 1, page_size: 20 })
    return (res?.items || [])
      .flatMap((a) => {
        const url = toAbsoluteMediaUrl(assetMediaUrl(a))
        return url ? [{ kind: referenceKind(a?.type || a?.mime_type, url), url }] : []
      })
  } catch (_) {
    return []
  }
}

async function pollTaskSimple(taskId, options = {}) {
  if (!taskId) return { status: 'failed', error: '缺少 task_id' }
  const maxAttempts = options.maxAttempts ?? 450
  const interval = options.interval ?? 2000
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, interval))
    try {
      const t = await taskAPI.get(taskId)
      options.onPoll?.(t)
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

function upstreamReferenceUrls(genOpts = {}) {
  return (Array.isArray(genOpts.upstreamReferenceUrls) ? genOpts.upstreamReferenceUrls : [])
    .map((url) => toAbsoluteMediaUrl(url))
    .filter(Boolean)
}

function referenceKind(value, url = '') {
  const kind = String(value || '').trim().toLowerCase()
  if (kind.includes('video')) return 'video'
  if (kind.includes('audio') || kind.includes('voice')) return 'audio'
  if (/\.(?:mp4|mov|m4v|webm)(?:$|[?#])/i.test(url)) return 'video'
  if (/\.(?:mp3|wav|m4a|aac|ogg|oga|flac)(?:$|[?#])/i.test(url)) return 'audio'
  return 'image'
}

function upstreamReferenceItems(genOpts = {}) {
  const declared = Array.isArray(genOpts.upstreamReferences) ? genOpts.upstreamReferences : []
  if (declared.length) {
    return declared.flatMap((item) => {
      const url = toAbsoluteMediaUrl(item?.url || item?.absoluteUrl || '')
      return url ? [{ kind: referenceKind(item?.kind || item?.type, url), url }] : []
    })
  }
  return upstreamReferenceUrls(genOpts).map((url) => ({ kind: referenceKind('', url), url }))
}

function uniqueUrls(values) {
  return [...new Set(values.filter(Boolean))]
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

async function autoLinkTailFrameAfterVideo(drama, storyboard, found) {
  const current = found?.storyboard || storyboard
  const { next } = getAdjacentStoryboards(found?.episode, current?.id)
  if (!drama?.id || !current?.id || !next || !canChainStoryboardFrames(next, current)) return null
  try {
    const result = await storyboardsAPI.linkTailFrame(current.id, { drama_id: drama.id })
    return {
      tailFrameLinked: true,
      tailFrameNextStoryboardId: result?.next_storyboard_id || next.id,
      tailFrameLinkMessage: result?.message || '尾帧已自动衔接到下一镜首帧',
      nextStep: 'audio',
      nextLabel: '继续配音',
    }
  } catch (error) {
    return {
      tailFrameLinked: false,
      tailFrameLinkError: error?.message || '尾帧衔接失败',
      actionError: `尾帧自动衔接失败：${error?.message || '尾帧衔接失败'}`,
    }
  }
}

export async function runImageStep(drama, sb, genOpts, frameKind = '', options = {}) {
  const effectiveStoryboard = await hydrateStoryboardSettings(sb)
  const basePrompt = await resolveCanvasFramePrompt(effectiveStoryboard, frameKind)
  const prompt = buildCanvasPhotographyPrompt(basePrompt, effectiveStoryboard)
  if (!prompt.trim()) throw new Error(`分镜 #${effectiveStoryboard.storyboard_number ?? effectiveStoryboard.id} 缺少图片提示词`)
  const frameType = options.frameType
    || getStoryboardImageFrameType(frameKind)
    || (!frameKind ? getStoryboardGridFrameType(effectiveStoryboard) : undefined)
  const entityRefs = frameType
    ? collectStoryboardReferenceAssets(drama, effectiveStoryboard).map((ref) => ref.absoluteUrl).filter(Boolean)
    : []
  const assignedRefs = (await fetchAssignedAssetReferences(effectiveStoryboard.id))
    .filter((item) => item.kind === 'image')
    .map((item) => item.url)
  const referenceImages = [...new Set([...entityRefs, ...assignedRefs, ...upstreamReferenceUrls(genOpts)])].slice(0, 10)
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
    options.onTask?.({ taskId: res.task_id, step: 'image', response: res })
    const polled = await pollTaskSimple(res.task_id, options)
    if (polled.status !== 'completed') throw new Error(polled.error || '分镜图生成失败')
  }
}

export async function runVideoStep(drama, sb, genOpts, options = {}) {
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
  const assignedRefs = await fetchAssignedAssetReferences(sb.id)
  const typedUpstreamRefs = upstreamReferenceItems(genOpts)
  const referenceImageUrls = uniqueUrls([
    absoluteFirst,
    ...selectedReferenceUrls,
    ...assignedRefs.filter((item) => item.kind === 'image').map((item) => item.url),
    ...typedUpstreamRefs.filter((item) => item.kind === 'image').map((item) => item.url),
    absoluteLast,
  ])
  const referenceVideoUrls = uniqueUrls([
    ...assignedRefs.filter((item) => item.kind === 'video').map((item) => item.url),
    ...typedUpstreamRefs.filter((item) => item.kind === 'video').map((item) => item.url),
  ])
  const referenceAudioUrls = uniqueUrls([
    ...assignedRefs.filter((item) => item.kind === 'audio').map((item) => item.url),
    ...typedUpstreamRefs.filter((item) => item.kind === 'audio').map((item) => item.url),
  ])
  const model = getStoryboardVideoModel(sb, genOpts)
  const catalogEntry = canvasModelEntry(genOpts.modelCatalog || [], 'video', model)
  const suppliedCapability = genOpts.capability?.declared === true ? genOpts.capability : null
  if (model && !catalogEntry && !suppliedCapability && !filterCanvasCatalogFallbackModels([model], 'video').length) {
    throw new Error('当前视频模型目录尚未就绪，请刷新后重试')
  }
  const capability = suppliedCapability
    || catalogEntry?.capabilities
    || canvasModelCapability(genOpts.modelCatalog || [], 'video', model)
  const hasDeclaredCapability = capability?.declared === true
  const referenceMode = hasDeclaredCapability
    ? (useFirstLast ? 'first_last' : 'omni')
    : undefined
  const voiceSnapshot = buildStoryboardVoiceSnapshot(drama, sb)
  const voiceCharacters = voiceSnapshot.characters
  const voicePolicy = genOpts.voicePolicy || classifyVideoVoicePolicy({ model })
  const voicePromptPreview = buildVoicePromptPreview({
    policy: voicePolicy,
    characters: voiceCharacters,
  })
  const basePrompt = appendVoicePromptToVideoPrompt({
    prompt: sb.video_prompt || sb.polished_prompt || sb.image_prompt || sb.description || '',
    policy: voicePolicy,
    characters: voiceCharacters,
  })
  const found = findStoryboardInDrama(drama, sb.id)
  const { previous, next } = getAdjacentStoryboards(found?.episode, sb.id)
  const prompt = buildStoryboardContinuityPrompt({
    prompt: basePrompt,
    current: sb,
    previous,
    next,
  })
  const payload = buildVideoGenerationRequest({
    dramaId: drama.id,
    storyboardId: sb.id,
    prompt,
    model,
    imageUrl: referenceMode === 'omni' ? undefined : absoluteFirst,
    firstFrameUrl: referenceMode === 'omni' ? undefined : absoluteFirst,
    lastFrameUrl: referenceMode === 'omni' ? undefined : absoluteLast,
    referenceImageUrls: referenceMode === 'first_last' ? undefined : referenceImageUrls,
    referenceVideoUrls: referenceMode === 'first_last' ? undefined : referenceVideoUrls,
    referenceAudioUrls: referenceMode === 'first_last' ? undefined : referenceAudioUrls,
    capability,
    referenceMode,
    generateAudio: capability?.supportsAudio === true ? genOpts.generateAudio === true : undefined,
    style: genOpts.style,
    aspectRatio: genOpts.aspectRatio,
    resolution: genOpts.videoResolution,
    duration: sb.duration || genOpts.videoDuration || undefined,
  })
  const requestAudit = buildVideoGenerationAudit({
    payload,
    voicePolicy,
    voicePrompt: voicePromptPreview,
    voiceSnapshot,
  })
  const res = await videosAPI.create(payload)
  if (res?.task_id) {
    options.onTask?.({ taskId: res.task_id, step: 'video', response: res })
    const polled = await pollTaskSimple(res.task_id, options)
    if (polled.status !== 'completed') throw new Error(polled.error || '视频生成失败')
    const tailFrameResult = genOpts.autoLinkTailFrame === false
      ? null
      : await autoLinkTailFrameAfterVideo(drama, sb, found)
    return {
      taskId: res.task_id,
      videoGenerationId: res.id || null,
      model: payload.model || null,
      resultType: 'video',
      resultLabel: '视频已生成',
      requestPayload: payload,
      requestAudit,
      ...(tailFrameResult || {}),
      task: polled,
    }
  }
  const tailFrameResult = genOpts.autoLinkTailFrame === false
    ? null
    : await autoLinkTailFrameAfterVideo(drama, sb, found)
  return {
    taskId: res?.task_id || '',
    videoGenerationId: res?.id || null,
    model: payload.model || null,
    resultType: 'video',
    resultLabel: '视频已生成',
    requestPayload: payload,
    requestAudit,
    ...(tailFrameResult || {}),
  }
}

export async function runAudioStep(sb, genOpts = {}, options = {}) {
  const audioType = options.audioType === 'narration' ? 'narration' : 'dialogue'
  const text = String(options.text ?? sb[audioType] ?? '').trim()
  if (!text) return { skipped: true, reason: audioType === 'narration' ? '无旁白' : '无对白' }
  const model = getStoryboardAudioModel(sb, genOpts)
  const res = await request.post('/audio/extract', {
    storyboard_id: sb.id,
    text,
    tts_kind: audioType,
    tts_model: model || undefined,
  })
  return {
    skipped: false,
    resultUrl: res?.url || '',
    resultLocalPath: res?.local_path || '',
    resultType: 'audio',
    resultLabel: audioType === 'narration' ? '旁白音频已生成' : '对白音频已生成',
    audioType,
    model: res?.model || model || null,
  }
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
        const audioRes = await runAudioStep(sb, genOpts)
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
