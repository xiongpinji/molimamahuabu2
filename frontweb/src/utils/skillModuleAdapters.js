function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function countEpisodeShots(episodes) {
  return episodes.reduce((total, episode) => (
    total + asArray(episode?.scenes).reduce(
      (sceneTotal, scene) => sceneTotal + asArray(scene?.shots).length,
      0,
    )
  ), 0)
}

export function buildFactorySkillImportPreview({
  project,
  productionPackage,
  skillSnapshot,
  approvalStatus,
  activeVersion,
}) {
  if (approvalStatus !== 'approved') {
    throw new Error('仅审核通过的当前版本可以预览导入短剧工厂')
  }

  const pkg = productionPackage && typeof productionPackage === 'object'
    ? productionPackage
    : {}
  const overview = pkg.normalized_script || pkg.story_overview || {}
  const characters = asArray(pkg.characters || pkg.character_bible)
  const scenes = asArray(pkg.scenes || pkg.scene_bible)
  const props = asArray(pkg.props || pkg.prop_bible)
  const episodes = asArray(pkg.episodes)
  const shots = asArray(pkg.shots)
  const projectLockedFacts = asArray(project?.locked_facts)
  const packageLockedFacts = asArray(pkg?.source?.locked_facts)

  return {
    schema_version: 'factory-skill-import-preview@1.0',
    mode: 'preview',
    source: {
      module: 'script_analysis',
      project_id: project?.id ?? null,
      project_title: project?.title || '',
      version: Number(activeVersion || 0),
      approval_status: approvalStatus,
    },
    skill_snapshot: clone(skillSnapshot) || null,
    story: {
      title: overview.title || project?.title || '',
      logline: overview.logline || overview.summary || '',
      genre: overview.genre || '',
    },
    counts: {
      characters: characters.length,
      scenes: scenes.length,
      props: props.length,
      episodes: episodes.length,
      shots: shots.length || countEpisodeShots(episodes),
    },
    locked_facts: clone(projectLockedFacts.length ? projectLockedFacts : packageLockedFacts),
    visual_direction: clone(pkg.visual_direction) || null,
    production_context: {
      characters: clone(characters),
      scenes: clone(scenes),
      props: clone(props),
      episodes: clone(episodes),
      shots: clone(shots),
    },
  }
}
