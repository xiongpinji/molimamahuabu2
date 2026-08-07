import { assertVideoDurationAllowed } from './videoDuration.js'

function normalizeReferenceUrls(value) {
  if (!Array.isArray(value)) return undefined
  const urls = [...new Set(value.map((url) => String(url || '').trim()).filter(Boolean))]
  return urls.length ? urls : undefined
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
    generate_audio: generateAudio ?? undefined,
    style: style || undefined,
    aspect_ratio: aspectRatio || undefined,
    resolution: resolution || undefined,
    duration: duration ?? undefined,
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

export { buildVideoGenerationAudit, buildVideoGenerationRequest }
