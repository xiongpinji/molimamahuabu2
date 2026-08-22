import { assertVideoDurationAllowed } from './videoDuration.js'

const FEITUO_SHORT_DRAMA_IMAGE_LIMITS = Object.freeze({
  'sdas-lm-hailuo-h3-2k': 9,
  'sdas-my-seedance-2.0-fast-upscaled-1080p': 4,
})

function feituoShortDramaImageLimit(model) {
  return FEITUO_SHORT_DRAMA_IMAGE_LIMITS[String(model || '').trim().toLowerCase()] || null
}

function supportsFeituoShortDramaOmni(model) {
  return feituoShortDramaImageLimit(model) != null
}

function limitFeituoShortDramaReferenceImages(model, value) {
  if (!Array.isArray(value)) return value
  const limit = feituoShortDramaImageLimit(model)
  return limit ? value.filter((_, index) => index < limit) : value
}

function normalizeReferenceUrls(value) {
  if (!Array.isArray(value)) return undefined
  const urls = [...new Set(value.map((url) => String(url || '').trim()).filter(Boolean))]
  return urls.length ? urls : undefined
}

// 与后端 usmercariVideoClient.USMERCARI_MODELS 保持一致的供应商确认上限
const USMERCARI_SHORT_DRAMA_LIMITS = Object.freeze({
  'MiniMax H3': Object.freeze({ maxImages: 5, maxVideos: 0, maxAudio: 3 }),
  'seedance-2.0-fast': Object.freeze({ maxImages: 9, maxVideos: 3, maxAudio: 3 }),
  'seedance-2.0-mini': Object.freeze({ maxImages: 9, maxVideos: 3, maxAudio: 3 }),
})

const SHORT_DRAMA_VIDEO_MODES = Object.freeze(['classic', 'first_last_frame', 'omni_reference'])

function isUsmercariShortDramaModel(model) {
  return Boolean(USMERCARI_SHORT_DRAMA_LIMITS[String(model || '').trim()])
}

function removeEmptyFields(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== '')
  )
}

/**
 * 统一构建分镜视频创建请求，供真实提交和无扣费审计共用。
 * 这里不加入 voice_reference_url：后端会依据 storyboard_id 的 voice_snapshot 选择音频。
 */
function buildVideoGenerationRequest({
  dramaId,
  storyboardId,
  prompt,
  model,
  imageUrl,
  firstFrameUrl,
  lastFrameUrl,
  referenceImageUrls,
  referenceVideoUrls,
  referenceAudioUrls,
  referenceMode,
  generateAudio,
  style,
  aspectRatio,
  resolution,
  duration,
  capability,
} = {}) {
  const referenceImageUrlList = normalizeReferenceUrls(referenceImageUrls)
  const referenceVideoUrlList = normalizeReferenceUrls(referenceVideoUrls)
  const referenceAudioUrlList = normalizeReferenceUrls(referenceAudioUrls)
  const normalizedReferenceMode = String(referenceMode || '').trim()
  const capabilityDeclared = capability?.declared === true
  const hasDeclaredResolutionContract = capabilityDeclared && Array.isArray(capability.resolutions)
  const hasFrameSlots = Boolean(firstFrameUrl || lastFrameUrl)
  const hasOmniReferences = Boolean(
    referenceImageUrlList?.length
    || referenceVideoUrlList?.length
    || referenceAudioUrlList?.length
  )
  if ((capabilityDeclared || normalizedReferenceMode)
      && ((hasFrameSlots && hasOmniReferences)
        || (normalizedReferenceMode === 'first_last' && hasOmniReferences)
        || (normalizedReferenceMode === 'omni' && hasFrameSlots))) {
    throw new Error('首尾帧模式与全能参考模式互斥')
  }
  if (capabilityDeclared) {
    const normalizedResolution = String(resolution || '').trim().toLowerCase()
    const allowedResolutions = Array.isArray(capability.resolutions)
      ? capability.resolutions.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
      : []
    if (allowedResolutions.length && !allowedResolutions.includes(normalizedResolution)) {
      throw new Error(`当前模型不支持 ${normalizedResolution || '未选择'} 清晰度；可用档位：${allowedResolutions.join('、')}`)
    }
    assertVideoDurationAllowed(duration, capability)
    if (firstFrameUrl && capability.supportsFirstFrame !== true) {
      throw new Error('当前模型不支持首帧参考')
    }
    if (lastFrameUrl && capability.supportsLastFrame !== true) {
      throw new Error('当前模型不支持尾帧参考')
    }
    for (const [urls, supportKey, limitKey, unit, label] of [
      [referenceImageUrlList, 'supportsImageReference', 'maxReferences', '张', '参考图'],
      [referenceVideoUrlList, 'supportsVideoReference', 'maxVideoReferences', '个', '参考视频'],
      [referenceAudioUrlList, 'supportsAudioReference', 'maxAudioReferences', '个', '参考音频'],
    ]) {
      if (!urls?.length) continue
      if (capability[supportKey] !== true) throw new Error(`当前模型未开放${label}`)
      const max = Number(capability[limitKey])
      if (Number.isSafeInteger(max) && max >= 0 && urls.length > max) {
        throw new Error(`当前模型最多支持 ${max} ${unit}${label}`)
      }
    }
    if (generateAudio === true && capability.supportsAudio !== true) {
      throw new Error('当前模型不支持同步音频')
    }
  }
  return removeEmptyFields({
    drama_id: dramaId,
    storyboard_id: storyboardId,
    prompt: String(prompt || ''),
    model: model || undefined,
    image_url: imageUrl || undefined,
    first_frame_url: firstFrameUrl || undefined,
    last_frame_url: lastFrameUrl || undefined,
    reference_image_urls: referenceImageUrlList,
    reference_video_urls: referenceVideoUrlList,
    reference_audio_urls: referenceAudioUrlList,
    reference_mode: normalizedReferenceMode || undefined,
    generate_audio: capabilityDeclared && capability.supportsAudio !== true
      ? undefined
      : generateAudio ?? undefined,
    style: style || undefined,
    aspect_ratio: aspectRatio || undefined,
    resolution: hasDeclaredResolutionContract && capability.resolutions.length === 0
      ? undefined
      : resolution || undefined,
    duration: duration ?? undefined,
  })
}

/**
 * 短剧工厂三模式视频请求构造器。
 * - classic：提交已匹配人物/道具/场景/素材作为基础参考图
 * - first_last_frame：只提交首帧 + 尾帧，禁止混入普通参考图
 * - omni_reference：提交分镜图 + 基础参考图/视频/音频
 */
function buildShortDramaVideoRequest({
  mode,
  baseReferenceImageUrls,
  firstFrameUrl,
  lastFrameUrl,
  storyboardImageUrl,
  referenceVideoUrls,
  referenceAudioUrls,
  referenceMode,
  strictToapis,
  model,
  ...rest
} = {}) {
  if (!SHORT_DRAMA_VIDEO_MODES.includes(mode)) {
    throw new Error(`短剧工厂视频模式无效：${mode || '(空)'}，仅支持 classic / first_last_frame / omni_reference`)
  }

  const baseRefs = normalizeReferenceUrls(baseReferenceImageUrls) || []
  const first = String(firstFrameUrl || '').trim()
  const last = String(lastFrameUrl || '').trim()
  const storyboardImage = String(storyboardImageUrl || '').trim()
  const videos = normalizeReferenceUrls(referenceVideoUrls) || []
  const audios = normalizeReferenceUrls(referenceAudioUrls) || []
  const limits = USMERCARI_SHORT_DRAMA_LIMITS[String(model || '').trim()]

  if (storyboardImage && (first || last)) {
    throw new Error('短剧工厂首尾帧模式与全能参考模式互斥，不能同时提交分镜图和首尾帧')
  }
  if (mode === 'first_last_frame') {
    if (!first) throw new Error('短剧工厂首尾帧模式必须提供首帧')
    if (!last) throw new Error('短剧工厂首尾帧模式必须提供尾帧')
    if (baseRefs.length) throw new Error('短剧工厂首尾帧模式不能混用参考图')
  }
  if (mode === 'classic' && (first || last)) {
    throw new Error('短剧工厂经典模式不支持首尾帧，请切换首尾帧模式')
  }
  if (mode === 'omni_reference' && !storyboardImage) {
    throw new Error('短剧工厂全能参考模式必须提供分镜图')
  }

  const extraImages = (mode === 'first_last_frame' ? 2 : 0) + (mode === 'omni_reference' ? 1 : 0)
  if (limits) {
    const totalImages = baseRefs.length + extraImages
    if (totalImages > limits.maxImages) {
      throw new Error(`USMercari 模型 ${model} 最多支持 ${limits.maxImages} 张参考图，本次完整请求需要 ${totalImages} 张（基础 ${baseRefs.length}、附加 ${extraImages}）`)
    }
    if (videos.length > limits.maxVideos) {
      throw new Error(`USMercari 模型 ${model} 最多支持 ${limits.maxVideos} 个参考视频`)
    }
    if (audios.length > limits.maxAudio) {
      throw new Error(`USMercari 模型 ${model} 最多支持 ${limits.maxAudio} 个参考音频`)
    }
  }

  const normalizedReferenceMode = mode === 'first_last_frame'
    ? 'first_last'
    : (mode === 'omni_reference' ? 'omni' : referenceMode)
  const referenceImageUrls = mode === 'omni_reference'
    ? [storyboardImage, ...baseRefs]
    : baseRefs

  return buildVideoGenerationRequest({
    ...rest,
    model,
    imageUrl: mode === 'omni_reference' && strictToapis !== true ? storyboardImage : undefined,
    firstFrameUrl: mode === 'first_last_frame' ? first : undefined,
    lastFrameUrl: mode === 'first_last_frame' ? last : undefined,
    referenceImageUrls,
    referenceVideoUrls: videos.length ? videos : undefined,
    referenceAudioUrls: audios.length ? audios : undefined,
    referenceMode: normalizedReferenceMode,
  })
}

/**
 * 只暴露供应商无关的请求审计信息，避免把 AI 配置中的 api_key 等敏感字段带到 UI。
 */
function buildVideoGenerationAudit({
  payload = {},
  config = null,
  voicePolicy = null,
  voicePrompt = '',
  voiceReferences = [],
  voiceSnapshot = null,
} = {}) {
  const candidates = (Array.isArray(voiceReferences) ? voiceReferences : [])
    .filter((item) => item && item.url)
    .map((item) => ({
      id: item.id ?? null,
      name: item.name || '',
      url: String(item.url),
      source: item.source || 'character_voice',
    }))
  const policyKey = voicePolicy?.key || null
  return {
    model: payload.model || null,
    provider: config?.provider || null,
    protocol: config?.api_protocol || null,
    voice_policy: voicePolicy
      ? { key: voicePolicy.key || null, label: voicePolicy.label || '' }
      : null,
    voice_prompt_preview: String(voicePrompt || ''),
    voice_snapshot: voiceSnapshot
      ? {
          version: voiceSnapshot.version || 1,
          storyboard_id: voiceSnapshot.storyboard_id ?? payload.storyboard_id ?? null,
          characters: (Array.isArray(voiceSnapshot.characters) ? voiceSnapshot.characters : [])
            .map((item) => ({
              id: item.id ?? null,
              name: item.name || '',
              voice_card: item.voice_card || '',
              voice_style: item.voice_style || '',
              source: item.source || 'unknown',
            }))
            .filter((item) => item.name && item.voice_card && item.voice_style),
        }
      : null,
    reference_audio: {
      mode: policyKey === 'reference_audio' ? 'backend_auto_injection' : 'not_in_request',
      candidates,
      note: policyKey === 'reference_audio'
        ? '后端按 storyboard_id 与对白顺序选择当前分镜的角色音色参考。'
        : '当前请求体不直接携带参考音频；非克隆模型使用文字声线提示。',
    },
    frame_inputs: {
      first_frame_url: payload.first_frame_url || null,
      last_frame_url: payload.last_frame_url || null,
      reference_image_urls: Array.isArray(payload.reference_image_urls)
        ? payload.reference_image_urls
        : [],
    },
    payload,
  }
}

export {
  buildVideoGenerationAudit,
  buildShortDramaVideoRequest,
  buildVideoGenerationRequest,
  feituoShortDramaImageLimit,
  isUsmercariShortDramaModel,
  limitFeituoShortDramaReferenceImages,
  supportsFeituoShortDramaOmni,
}
