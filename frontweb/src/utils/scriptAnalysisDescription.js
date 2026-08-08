const DESCRIPTION_FIELDS = Object.freeze({
  character: ['appearance', 'visual', 'visual_design', 'profile', 'personality', 'performance_direction', 'background', 'known_facts', 'key_facts', 'relationship'],
  scene: ['visual', 'environment', 'atmosphere', 'story_function', 'dramatic_function', 'source_basis'],
  prop: ['required_visual_features', 'appearance', 'function', 'story_function', 'purpose', 'source_basis'],
  shot: ['action', 'visual', 'shot_description', 'image_prompt', 'video_prompt', 'source_basis'],
})

export function readableText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return value.map(readableText).filter(Boolean).join('；')
  if (typeof value === 'object') {
    return Object.values(value).map(readableText).filter(Boolean).join('；')
  }
  return String(value).trim()
}

export function descriptionTextFor(type, item) {
  const direct = readableText(item?.description)
  if (direct) return direct
  return (DESCRIPTION_FIELDS[type] || [])
    .map((field) => readableText(item?.[field]))
    .filter(Boolean)
    .join('；')
}
