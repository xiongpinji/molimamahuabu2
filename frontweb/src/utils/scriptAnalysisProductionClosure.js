import { parseDramaMetadata } from './canvasLayout.js'

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function list(value) {
  return Array.isArray(value) ? value : []
}

function hasReferenceImage(item) {
  return Boolean(text(item?.image_url) || text(item?.local_path) || text(item?.thumbnail_url))
}

function storyboardCharacters(storyboard) {
  if (list(storyboard?.characters).length > 0) return storyboard.characters
  return list(storyboard?.character_ids)
}

function sourceScript(importMetadata) {
  return text(
    importMetadata?.package_snapshot?.source?.source_script
      ?? importMetadata?.package_snapshot?.source_script,
  )
}

export function buildScriptAnalysisProvenance(drama, currentEpisode) {
  const metadata = parseDramaMetadata(drama?.metadata)
  const imported = metadata?.script_analysis_import
  if (!imported || typeof imported !== 'object' || Array.isArray(imported)) return null

  const originalScript = sourceScript(imported)
  const currentScript = text(currentEpisode?.script_content)
  return {
    projectId: imported.source_project_id ?? null,
    projectTitle: text(imported.source_project_title),
    version: imported.source_version ?? null,
    approvalStatus: text(imported.approval_status),
    importedAt: text(imported.imported_at),
    lockedFacts: list(imported.locked_facts).slice(),
    sourceScript: originalScript,
    currentScript,
    changed: originalScript !== currentScript,
  }
}

function referenceAssets(currentEpisode, drama) {
  const groups = [
    ['角色', list(currentEpisode?.characters).length ? currentEpisode.characters : drama?.characters],
    ['场景', list(currentEpisode?.scenes).length ? currentEpisode.scenes : drama?.scenes],
    ['道具', list(currentEpisode?.props).length ? currentEpisode.props : drama?.props],
  ]
  return groups.flatMap(([type, items]) => list(items).map((item) => ({
    type,
    id: item?.id ?? null,
    name: text(item?.name ?? item?.location ?? item?.title) || `${type}${item?.id ?? ''}`,
    hasImage: hasReferenceImage(item),
  })))
}

export function buildFactoryGenerationPreflight({
  drama,
  currentEpisode,
  videoModel,
  aspectRatio,
  videoClipDuration,
}) {
  const storyboards = list(currentEpisode?.storyboards)
  const defaultDuration = Number(videoClipDuration)
  const checks = [
    { key: 'video-model', label: '视频模型', ok: Boolean(text(videoModel)) },
    { key: 'aspect-ratio', label: '画面比例', ok: Boolean(text(aspectRatio)) },
    { key: 'storyboards', label: '分镜内容', ok: storyboards.length > 0 },
    {
      key: 'prompts',
      label: '图片与视频提示词',
      ok: storyboards.length > 0 && storyboards.every(
        (storyboard) => text(storyboard?.image_prompt) && text(storyboard?.video_prompt),
      ),
    },
    {
      key: 'relations',
      label: '人物与场景关系',
      ok: storyboards.length > 0 && storyboards.every(
        (storyboard) => storyboard?.scene_id != null && storyboardCharacters(storyboard).length > 0,
      ),
    },
    {
      key: 'duration',
      label: '镜头时长',
      ok: storyboards.length > 0 && storyboards.every((storyboard) => {
        const duration = storyboard?.duration == null ? defaultDuration : Number(storyboard.duration)
        return Number.isFinite(duration) && duration > 0
      }),
    },
  ]
  const missingReferenceAssets = referenceAssets(currentEpisode, drama).filter((item) => !item.hasImage)

  return {
    ready: checks.every((item) => item.ok),
    checks,
    missingReferenceAssets,
    warning: missingReferenceAssets.length > 0
      ? `${missingReferenceAssets.length} 个参考素材尚无图片，可稍后补充，不阻断文本生产。`
      : '',
  }
}
