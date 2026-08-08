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
  return limit ? value.slice(0, limit) : value
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
  style,
  aspectRatio,
  resolution,
  duration,
} = {}) {
  return removeEmptyFields({
    drama_id: dramaId,
    storyboard_id: storyboardId,
    prompt: String(prompt || ''),
    model: model || undefined,
    image_url: imageUrl || undefined,
    first_frame_url: firstFrameUrl || undefined,
    last_frame_url: lastFrameUrl || undefined,
    reference_image_urls: normalizeReferenceUrls(referenceImageUrls),
    reference_video_urls: normalizeReferenceUrls(referenceVideoUrls),
    reference_audio_urls: normalizeReferenceUrls(referenceAudioUrls),
    style: style || undefined,
    aspect_ratio: aspectRatio || undefined,
    resolution: resolution || undefined,
    duration: duration ?? undefined,
  })
}

/**
 * 短剧工厂三模式视频请求构造器。
 * - 经典模式 classic：提交全部已匹配人物/道具/场景/素材作为基础参考图
 * - 首尾帧模式 first_last_frame：基础参考 + 首帧 + 尾帧
 * - 全能参考模式 omni_reference：基础参考 + 1 张分镜图
 * 首尾帧与全能参考互斥；USMercari 模型超限时在提交前抛错，绝不静默裁剪素材。
 */
function buildShortDramaVideoRequest({
  mode,
  baseReferenceImageUrls,
  firstFrameUrl,
  lastFrameUrl,
  storyboardImageUrl,
  referenceVideoUrls,
  referenceAudioUrls,
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
  }
  if (mode === 'classic' && (first || last)) {
    throw new Error('短剧工厂经典模式不支持首尾帧，请切换首尾帧模式')
  }
  if (mode === 'omni_reference' && !storyboardImage) {
    throw new Error('短剧工厂全能参考模式必须提供分镜图')
  }
  if (limits && mode === 'first_last_frame' && baseRefs.length) {
    throw new Error('短剧工厂首尾帧模式与多参考图模式互斥，不能同时提交首尾帧和参考图')
  }

  const extraImages = (mode === 'first_last_frame' ? 2 : 0) + (mode === 'omni_reference' ? 1 : 0)
  if (limits) {
    const totalImages = baseRefs.length + extraImages
    if (totalImages > limits.maxImages) {
      throw new Error(`USMercari 模型 ${model} 最多支持 ${limits.maxImages} 张参考图，本次完整请求需要 ${totalImages} 张（基础 ${baseRefs.length}、附加 ${extraImages}）`)
    }
    if (videos.length > limits.maxVideos) {
      throw new Error(limits.maxVideos === 0
        ? `USMercari 模型 ${model} 不支持参考视频`
        : `USMercari 模型 ${model} 最多支持 ${limits.maxVideos} 个参考视频`)
    }
    if (audios.length > limits.maxAudio) {
      throw new Error(limits.maxAudio === 0
        ? `USMercari 模型 ${model} 不支持参考音频`
        : `USMercari 模型 ${model} 最多支持 ${limits.maxAudio} 个参考音频`)
    }
  }

  const referenceImageUrls = mode === 'omni_reference'
    ? [storyboardImage, ...baseRefs]
    : (mode === 'first_last_frame' && limits ? undefined : baseRefs)
  return buildVideoGenerationRequest({
    ...rest,
    model,
    referenceImageUrls,
    imageUrl: mode === 'omni_reference' ? storyboardImage : undefined,
    firstFrameUrl: mode === 'first_last_frame' ? first : undefined,
    lastFrameUrl: mode === 'first_last_frame' ? last : undefined,
    referenceVideoUrls: videos.length ? videos : undefined,
    referenceAudioUrls: audios.length ? audios : undefined,
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
  buildVideoGenerationRequest,
  buildShortDramaVideoRequest,
  feituoShortDramaImageLimit,
  isUsmercariShortDramaModel,
  limitFeituoShortDramaReferenceImages,
  supportsFeituoShortDramaOmni,
}
