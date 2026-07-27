const DEFAULT_COLUMNS = 3
const DEFAULT_COLUMN_GAP = 680
const DEFAULT_ROW_GAP = 460

export function computeStandaloneNodePosition(nodes = [], center = { x: 80, y: 80 }) {
  const index = nodes.filter((node) => node?.type === 'homeCanvasNode').length
  return {
    x: Number(center.x || 0) + (index % DEFAULT_COLUMNS) * 560,
    y: Number(center.y || 0) + Math.floor(index / DEFAULT_COLUMNS) * 380,
  }
}

export function computeStandaloneAutoLayoutPositions(nodes = [], options = {}) {
  const columns = Math.max(1, Number(options.columns) || DEFAULT_COLUMNS)
  const startX = Number(options.startX ?? 80)
  const startY = Number(options.startY ?? 80)
  const columnGap = Number(options.columnGap ?? DEFAULT_COLUMN_GAP)
  const rowGap = Number(options.rowGap ?? DEFAULT_ROW_GAP)
  const freeNodes = nodes.filter((node) => node?.type === 'homeCanvasNode')
  const groups = nodes.filter((node) => node?.type === 'canvasGroup')
  const groupedIds = new Set(groups.flatMap((group) => group.data?.childNodeIds || []).map(String))
  const units = [
    ...groups,
    ...freeNodes.filter((node) => !groupedIds.has(String(node.id))),
  ]
  const positions = {}

  units.forEach((unit, index) => {
    const target = {
      x: startX + (index % columns) * columnGap,
      y: startY + Math.floor(index / columns) * rowGap,
    }
    positions[unit.id] = target
    if (unit.type !== 'canvasGroup') return
    const origin = unit.position || { x: 0, y: 0 }
    const deltaX = target.x - Number(origin.x || 0)
    const deltaY = target.y - Number(origin.y || 0)
    const childIds = new Set((unit.data?.childNodeIds || []).map(String))
    freeNodes.forEach((node) => {
      if (!childIds.has(String(node.id))) return
      positions[node.id] = {
        x: Number(node.position?.x || 0) + deltaX,
        y: Number(node.position?.y || 0) + deltaY,
      }
    })
  })

  return positions
}
