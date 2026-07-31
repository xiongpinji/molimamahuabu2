import { createHomeCanvasState, normalizeHomeCanvasState } from './homeCanvasState.js'

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asText(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireArray(productionPackage, key) {
  if (!Array.isArray(productionPackage[key])) {
    throw new Error(`制作包的 ${key} 必须是数组`)
  }
}

function buildProvenance(project, sourceType, sourceId) {
  return {
    projectId: project?.id ?? null,
    version: project?.active_version ?? null,
    sourceType,
    sourceId: asText(sourceId),
  }
}

function flattenShots(productionPackage) {
  return asArray(productionPackage?.episodes).flatMap((episode, episodeIndex) => (
    asArray(episode?.scenes).flatMap((scene, sceneIndex) => (
      asArray(scene?.shots).map((shot, shotIndex) => ({
        episode,
        episodeIndex,
        scene,
        sceneIndex,
        shot,
        shotIndex,
      }))
    ))
  ))
}

function getImportStartX(nodes) {
  if (!nodes.length) return 120
  return Math.max(...nodes.map((node) => Number(node.position?.x) || 0)) + 560
}

function createNode({ id, kind, title, content, x, y, provenance }) {
  return {
    id,
    type: 'homeCanvasNode',
    position: { x, y },
    data: {
      kind,
      title,
      content,
      url: '',
      scriptAnalysis: provenance,
    },
  }
}

function createEdge(id, source, target) {
  return {
    id,
    source,
    target,
    type: 'smoothstep',
  }
}

function formatShotContext(item) {
  const episodeNumber = item.episode?.episode_number ?? item.episodeIndex + 1
  const sceneNumber = item.scene?.scene_number ?? item.sceneIndex + 1
  const shotNumber = item.shot?.shot_number ?? item.shotIndex + 1
  const sourceBasis = asArray(item.shot?.source_basis).map(asText).filter(Boolean)
  const dialogue = asArray(item.shot?.dialogue)
    .map((line) => `${asText(line?.character) || '角色'}：${asText(line?.text)}`)
    .filter(Boolean)
  const startState = asText(item.shot?.continuity?.start_state)
  const endState = asText(item.shot?.continuity?.end_state)
  return [
    `第 ${episodeNumber} 集 · 场景 ${sceneNumber} · 镜头 ${shotNumber}`,
    sourceBasis.length ? `引用：${sourceBasis.join('、')}` : '',
    startState ? `起始状态：${startState}` : '',
    endState ? `结束状态：${endState}` : '',
    dialogue.length ? `对白：\n${dialogue.join('\n')}` : '',
  ].filter(Boolean).join('\n')
}

function validatePackage(productionPackage, approvalStatus) {
  if (approvalStatus !== 'approved') {
    throw new Error('仅审核通过的当前版本可导入画布')
  }

  if (!isPlainObject(productionPackage)) {
    throw new Error('制作包格式无效')
  }
  if (productionPackage.schema_version !== '1.0') {
    throw new Error('制作包 schema_version 必须是 1.0')
  }
  if (!isPlainObject(productionPackage.source)) {
    throw new Error('制作包缺少 source')
  }
  if (!Array.isArray(productionPackage.source.locked_facts)) {
    throw new Error('制作包的 source.locked_facts 必须是数组')
  }
  if (!isPlainObject(productionPackage.normalized_script)) {
    throw new Error('制作包缺少 normalized_script')
  }
  if (!Array.isArray(productionPackage.normalized_script.story_structure)) {
    throw new Error('制作包的 normalized_script.story_structure 必须是数组')
  }

  ;[
    'character_bible',
    'scene_bible',
    'prop_bible',
    'episodes',
    'continuity_rules',
    'ai_changes',
  ].forEach((key) => requireArray(productionPackage, key))

  if (!isPlainObject(productionPackage.review)) {
    throw new Error('制作包缺少 review')
  }
  if (!Array.isArray(productionPackage.review.issues)) {
    throw new Error('制作包的 review.issues 必须是数组')
  }
  if (!productionPackage.episodes.length) {
    throw new Error('制作包没有可导入的分集')
  }

  productionPackage.episodes.forEach((episode, episodeIndex) => {
    const episodeLabel = episode?.episode_number ?? episodeIndex + 1
    if (!episode?.episode_number) {
      throw new Error(`第 ${episodeLabel} 集缺少 episode_number`)
    }
    if (!Array.isArray(episode.scenes) || !episode.scenes.length) {
      throw new Error(`第 ${episodeLabel} 集没有可导入的场景`)
    }

    episode.scenes.forEach((scene, sceneIndex) => {
      const sceneLabel = scene?.scene_number ?? sceneIndex + 1
      if (!scene?.scene_number) {
        throw new Error(`第 ${episodeLabel} 集场景 ${sceneLabel} 缺少 scene_number`)
      }
      if (!Array.isArray(scene.shots) || !scene.shots.length) {
        throw new Error(`第 ${episodeLabel} 集场景 ${sceneLabel} 没有可导入的分镜`)
      }

      scene.shots.forEach((shot, shotIndex) => {
        const shotLabel = shot?.shot_number ?? shotIndex + 1
        if (!shot?.shot_number) {
          throw new Error(`镜头 ${shotLabel} 缺少 shot_number`)
        }
        if (!Array.isArray(shot.source_basis) || !shot.source_basis.length) {
          throw new Error(`镜头 ${shotLabel} 缺少 source_basis`)
        }
        if (!asText(shot.image_prompt) || !asText(shot.video_prompt)) {
          throw new Error(`镜头 ${shotLabel} 缺少图片或视频提示词`)
        }
        if (!isPlainObject(shot.continuity)) {
          throw new Error(`镜头 ${shotLabel} 缺少 continuity`)
        }
        if (!Array.isArray(shot.dialogue)) {
          throw new Error(`镜头 ${shotLabel} 的 dialogue 必须是数组`)
        }
      })
    })
  })

  return flattenShots(productionPackage)
}

export function buildScriptAnalysisCanvasState({
  existingState,
  project,
  productionPackage,
  approvalStatus,
  importId,
}) {
  const safeImportId = asText(importId)
  if (!safeImportId) throw new Error('缺少本次导入标识')

  const shots = validatePackage(productionPackage, approvalStatus)
  const normalized = normalizeHomeCanvasState(existingState || createHomeCanvasState())
  const prefix = `script-analysis:${safeImportId}`
  if (normalized.nodes.some((node) => String(node.id).startsWith(`${prefix}:`))) {
    throw new Error('该剧本分析版本已经导入画布')
  }

  const baseX = getImportStartX(normalized.nodes)
  const nodes = []
  const edges = []
  const overviewId = `${prefix}:overview`
  const projectTitle = asText(project?.title) || '未命名剧本'
  const overviewContent = [
    asText(productionPackage?.normalized_script?.logline),
    asText(productionPackage?.normalized_script?.genre)
      ? `类型：${asText(productionPackage.normalized_script.genre)}`
      : '',
  ].filter(Boolean).join('\n')

  nodes.push(createNode({
    id: overviewId,
    kind: 'text',
    title: `${projectTitle} · 导演分析`,
    content: overviewContent,
    x: baseX,
    y: 40,
    provenance: buildProvenance(project, 'overview', project?.id),
  }))

  const bibleCollections = [
    ['character', asArray(productionPackage?.character_bible), '角色'],
    ['scene', asArray(productionPackage?.scene_bible), '场景'],
    ['prop', asArray(productionPackage?.prop_bible), '道具'],
  ]
  let bibleIndex = 0
  bibleCollections.forEach(([sourceType, items, label]) => {
    items.forEach((item, itemIndex) => {
      const sourceId = asText(item?.id) || `${sourceType}-${itemIndex + 1}`
      const nodeId = `${prefix}:${sourceType}:${itemIndex + 1}`
      nodes.push(createNode({
        id: nodeId,
        kind: 'image',
        title: `${label} · ${asText(item?.name) || itemIndex + 1}`,
        content: asText(item?.visual_prompt),
        x: baseX,
        y: 260 + bibleIndex * 300,
        provenance: buildProvenance(project, sourceType, sourceId),
      }))
      edges.push(createEdge(`${prefix}:${sourceType}:${itemIndex + 1}:overview`, overviewId, nodeId))
      bibleIndex += 1
    })
  })

  const shotStartY = 260 + Math.max(bibleIndex, 1) * 300
  shots.forEach((item, index) => {
    const shotKey = `${item.episodeIndex + 1}-${item.sceneIndex + 1}-${item.shotIndex + 1}`
    const sourceId = asText(item.shot?.id) || shotKey
    const textId = `${prefix}:shot:${shotKey}:text`
    const imageId = `${prefix}:shot:${shotKey}:image`
    const videoId = `${prefix}:shot:${shotKey}:video`
    const y = shotStartY + index * 340
    const shotTitle = `分镜 ${item.shot?.shot_number ?? item.shotIndex + 1}`

    nodes.push(
      createNode({
        id: textId,
        kind: 'text',
        title: `${shotTitle} · 脚本`,
        content: formatShotContext(item),
        x: baseX,
        y,
        provenance: buildProvenance(project, 'shot', sourceId),
      }),
      createNode({
        id: imageId,
        kind: 'image',
        title: `${shotTitle} · 分镜图`,
        content: asText(item.shot.image_prompt),
        x: baseX + 460,
        y,
        provenance: buildProvenance(project, 'shot', sourceId),
      }),
      createNode({
        id: videoId,
        kind: 'video',
        title: `${shotTitle} · 视频`,
        content: asText(item.shot.video_prompt),
        x: baseX + 920,
        y,
        provenance: buildProvenance(project, 'shot', sourceId),
      }),
    )
    edges.push(
      createEdge(`${prefix}:shot:${shotKey}:text-to-image`, textId, imageId),
      createEdge(`${prefix}:shot:${shotKey}:image-to-video`, imageId, videoId),
    )
  })

  return normalizeHomeCanvasState({
    ...normalized,
    nodes: [...normalized.nodes, ...nodes],
    edges: [...normalized.edges, ...edges],
    viewport: normalized.viewport,
  })
}
