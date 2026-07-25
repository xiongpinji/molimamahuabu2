export const PROJECT_MODE_CANVAS = 'canvas'
export const PROJECT_MODE_FACTORY = 'factory'

export function normalizeProjectMode(mode) {
  return mode === PROJECT_MODE_CANVAS ? PROJECT_MODE_CANVAS : PROJECT_MODE_FACTORY
}

export function projectMetadata(aspectRatio, mode) {
  return {
    aspect_ratio: aspectRatio || '16:9',
    project_type: normalizeProjectMode(mode),
  }
}

export function projectOpenPath(id, mode) {
  return normalizeProjectMode(mode) === PROJECT_MODE_CANVAS
    ? `/canvas/${id}`
    : `/drama/${id}`
}

export function projectCanvasPath(id, mode) {
  return normalizeProjectMode(mode) === PROJECT_MODE_CANVAS
    ? `/canvas/${id}`
    : `/film/${id}/canvas`
}
