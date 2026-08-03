import {
  appendDirectorCamera,
  appendDirectorObject,
  normalizeDirectorTimeline,
  removeDirectorObject,
} from './directorTimeline.js'

export function applyDirectorReferenceAnalysis(state, analysis, mode = 'insert') {
  let next = normalizeDirectorTimeline(state)
  if (mode === 'override') {
    for (const object of [...next.objects]) {
      if (object.type !== 'light') next = removeDirectorObject(next, object.id)
    }
  }
  for (const person of analysis?.people || []) {
    next = appendDirectorObject(next, 'humanoid', {
      name: person.name,
      assetRef: { assetId: null, url: '', kind: person.bodyType || 'male', color: person.color || '#4f8ef7' },
      transform: { position: person.position, rotation: person.rotation, scale: person.scale },
    })
  }
  for (const prop of analysis?.props || []) {
    next = appendDirectorObject(next, prop.type || 'box', {
      name: prop.name,
      assetRef: { assetId: null, url: '', kind: `director-ai-prop:${prop.name}`, color: prop.color || '#9ca3af' },
      transform: { position: prop.position, rotation: prop.rotation, scale: prop.scale },
    })
  }
  for (const camera of analysis?.cameras || []) {
    next = appendDirectorCamera(next, {
      name: camera.name,
      transform: { position: camera.position, rotation: [0, 0, 0], scale: [1, 1, 1] },
      target: camera.target,
      fov: camera.fov,
      roll: camera.roll,
      lookAtMode: 'manual',
    })
  }
  return next
}
