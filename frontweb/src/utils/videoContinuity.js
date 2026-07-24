function normalizedText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function clip(value, max = 140) {
  const text = normalizedText(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function chineseCount(value) {
  return (String(value || '').match(/[\u3400-\u9fff]/g) || []).length
}

function clipChineseBudget(value, maxChinese) {
  if (maxChinese <= 0) return ''
  let count = 0
  let out = ''
  for (const char of String(value || '')) {
    if (/[\u3400-\u9fff]/.test(char)) count += 1
    if (count > maxChinese) break
    out += char
  }
  return out.trim()
}

/** 仅在同一场景内自动复用上一镜尾帧，避免跨场景转场被错误锁死。 */
export function canChainStoryboardFrames(current, previous) {
  if (!current || !previous) return false
  const currentScene = Number(current.scene_id)
  const previousScene = Number(previous.scene_id)
  if (Number.isFinite(currentScene) && Number.isFinite(previousScene)) {
    return currentScene === previousScene
  }
  const currentLocation = normalizedText(current.location)
  const previousLocation = normalizedText(previous.location)
  return !!currentLocation && !!previousLocation && currentLocation === previousLocation
}

/** 为视频模型补充相邻镜头的剧情接力约束，避免每镜被当成独立短片生成。 */
export function buildStoryboardContinuityPrompt({ prompt, current, previous, next } = {}) {
  const base = normalizedText(prompt)
  const lines = []
  if (previous) {
    const previousState = clip(previous.result || previous.action || previous.description)
    const previousTitle = clip(previous.title, 60)
    lines.push(`承接上一镜${previousTitle ? `「${previousTitle}」` : ''}${previousState ? `：${previousState}` : ''}。人物身份、服装、道具、光线和空间方位保持一致，从上一镜结束状态开始。`)
  }
  if (next) {
    const nextAction = clip(next.action || next.description, 120)
    const nextTitle = clip(next.title, 60)
    lines.push(`本镜结尾自然引向下一镜${nextTitle ? `「${nextTitle}」` : ''}${nextAction ? `：${nextAction}` : ''}，不要凭空跳过动作或改变人物关系。`)
  }
  if (!lines.length) return base
  // iCreat 对中文提示词有长度限制；连续性只占用剩余预算，不截断原始动作描述。
  const continuity = ['【分镜连续性硬约束】', ...lines].join('\n')
  const remainingChineseBudget = 480 - chineseCount(base)
  const boundedContinuity = clipChineseBudget(continuity, remainingChineseBudget)
  return boundedContinuity ? [base, boundedContinuity].join('\n') : base
}
