function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function asText(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value))
}

export function formatVisualDirectionSummary(value) {
  const visualDirection = asObject(value)
  if (!visualDirection) return ''
  const emotionalTone = asObject(visualDirection.emotional_tone) || {}
  const rhythm = asObject(visualDirection.rhythm) || {}
  const sceneProfile = asArray(visualDirection.scene_profile)
    .map((item) => {
      const label = asText(item?.type)
      const ratio = Number(item?.ratio_percent)
      return label ? `${label}${Number.isFinite(ratio) ? ` ${ratio}%` : ''}` : ''
    })
    .filter(Boolean)
  const motifs = asArray(visualDirection.visual_motifs)
    .map((item) => asText(item?.motif))
    .filter(Boolean)
  const recommendations = asArray(visualDirection.recommendations)
    .map((item) => [
      asText(item?.name),
      asText(item?.objective_style),
      asText(item?.composition) ? `构图：${asText(item.composition)}` : '',
      asText(item?.camera_movement) ? `运镜：${asText(item.camera_movement)}` : '',
      asText(item?.lighting) ? `灯光：${asText(item.lighting)}` : '',
      asText(item?.color) ? `色彩：${asText(item.color)}` : '',
    ].filter(Boolean).join('\n'))
    .filter(Boolean)

  return [
    asText(emotionalTone.primary) ? `主情绪：${asText(emotionalTone.primary)}` : '',
    asText(emotionalTone.secondary) ? `辅情绪：${asText(emotionalTone.secondary)}` : '',
    asArray(rhythm.labels).map(asText).filter(Boolean).length
      ? `节奏：${asArray(rhythm.labels).map(asText).filter(Boolean).join('、')}`
      : '',
    sceneProfile.length ? `场景分布：${sceneProfile.join('、')}` : '',
    motifs.length ? `视觉母题：${motifs.join('、')}` : '',
    recommendations.length ? `执行建议：\n${recommendations.join('\n\n')}` : '',
  ].filter(Boolean).join('\n')
}

function entryFromNode(node) {
  const data = asObject(node?.data)
  const provenance = asObject(data?.scriptAnalysis)
  const visualDirection = asObject(data?.visualDirection)
  if (provenance?.sourceType !== 'visual_direction' || !visualDirection) return null
  return {
    mode: 'visual_direction',
    sourceNodeId: asText(node.id),
    sourceTitle: asText(data.title) || '视觉导演方案',
    provenance: cloneValue(provenance),
    visualDirection: cloneValue(visualDirection),
    skillSnapshot: asObject(data.skillSnapshot) ? cloneValue(data.skillSnapshot) : null,
  }
}

export function findVisualDirectionDirectorEntry(nodes) {
  const entries = asArray(nodes)
    .map((node) => ({ entry: entryFromNode(node), selected: node?.selected === true }))
    .filter((item) => item.entry)
  return entries.filter((item) => item.selected).at(-1)?.entry || entries.at(-1)?.entry || null
}

export function applyVisualDirectionGuidance(timeline, entry, appliedAt = new Date().toISOString()) {
  const current = asObject(timeline)
  const visualDirection = asObject(entry?.visualDirection)
  if (!current || entry?.mode !== 'visual_direction' || !visualDirection) {
    throw new Error('视觉导演方案格式无效')
  }
  return {
    ...current,
    extensions: {
      ...(asObject(current.extensions) || {}),
      visualDirectionGuidance: {
        schemaVersion: '1.0',
        sourceNodeId: asText(entry.sourceNodeId),
        sourceTitle: asText(entry.sourceTitle) || '视觉导演方案',
        provenance: asObject(entry.provenance) ? cloneValue(entry.provenance) : null,
        skillSnapshot: asObject(entry.skillSnapshot) ? cloneValue(entry.skillSnapshot) : null,
        visualDirection: cloneValue(visualDirection),
        appliedAt: asText(appliedAt),
      },
    },
  }
}
