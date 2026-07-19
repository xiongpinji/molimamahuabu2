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
