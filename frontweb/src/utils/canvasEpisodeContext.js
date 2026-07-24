/**
 * 画布的集数上下文。全部集显示项目级素材；选择某一集时，素材只显示该集分镜实际引用的资源。
 */
export function getCanvasEpisodeContext(drama, episodeId = null) {
  const episodes = Array.isArray(drama?.episodes) ? drama.episodes : []
  const hasFilter = episodeId !== null && episodeId !== undefined && episodeId !== ''
  const episode = hasFilter
    ? episodes.find((item) => Number(item.id) === Number(episodeId)) || null
    : null
  const scopedEpisodes = hasFilter ? (episode ? [episode] : []) : episodes
  const assetIds = {
    characters: new Set(),
    scenes: new Set(),
    props: new Set(),
  }

  for (const current of scopedEpisodes) {
    for (const storyboard of current?.storyboards || []) {
      for (const id of storyboard.characters || []) assetIds.characters.add(Number(id))
      if (storyboard.scene_id != null) assetIds.scenes.add(Number(storyboard.scene_id))
      for (const id of storyboard.prop_ids || []) assetIds.props.add(Number(id))
    }
  }

  return {
    episode,
    episodes: scopedEpisodes,
    storyboards: scopedEpisodes.flatMap((current) => current?.storyboards || []),
    assetIds,
    isFiltered: Boolean(episode),
  }
}

export function filterCanvasAssets(items, kind, context) {
  const list = Array.isArray(items) ? items : []
  if (!context?.isFiltered) return list
  const key = kind === 'character' ? 'characters' : kind === 'scene' ? 'scenes' : 'props'
  const ids = context.assetIds?.[key] || new Set()
  return list.filter((item) => ids.has(Number(item?.id)))
}

export function isCanvasAssetVisible(assetNodeId, context) {
  if (!context?.isFiltered || !assetNodeId) return true
  const [prefix, rawId] = String(assetNodeId).split(':')
  const key = prefix === 'char' ? 'characters' : prefix === 'scene' ? 'scenes' : prefix === 'prop' ? 'props' : null
  return Boolean(key && context.assetIds?.[key]?.has(Number(rawId)))
}
