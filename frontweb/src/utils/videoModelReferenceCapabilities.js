export function supportsMultiImageVideoReferences(model) {
  const name = String(model || '').trim().toLowerCase()
  if (!name) return false
  return name === 'lingjing-video-v1'
    || /^omni-fast(?:-|$)/.test(name)
    || (name.includes('seedance') && (/2[-_.]?0/.test(name) || /seedance[-_]?2|seedance2/.test(name)))
    || (/grok/.test(name) && /video/.test(name))
    || /kling.*omni|omni.*kling/.test(name)
    || /agnes[-_]?video/.test(name)
}
