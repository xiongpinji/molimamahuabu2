const DEFAULT_COLUMNS = 3
const DEFAULT_COLUMN_GAP = 680
const DEFAULT_ROW_GAP = 460

export function computeStandaloneNodePosition(nodes = [], center = { x: 80, y: 80 }) {
  const freeNodes = nodes.filter((node) => node?.type === 'homeCanvasNode')
  const origin = { x: Number(center.x || 0), y: Number(center.y || 0) }
  const collides = (candidate) => freeNodes.some((node) => {
    const position = node?.position
    if (!position) return false
    return Math.abs(Number(position.x || 0) - candidate.x) < DEFAULT_COLUMN_GAP
      && Math.abs(Number(position.y || 0) - candidate.y) < DEFAULT_ROW_GAP
  })

  for (let index = 0; index <= freeNodes.length; index += 1) {
    const candidate = {
      x: origin.x + (index % DEFAULT_COLUMNS) * DEFAULT_COLUMN_GAP,
      y: origin.y + Math.floor(index / DEFAULT_COLUMNS) * DEFAULT_ROW_GAP,
    }
    if (!collides(candidate)) return candidate
  }

  return origin
}

export function canAlignCanvasNodes({ standalone = false, hasDrama = false, nodeCount = 0, aligning = false } = {}) {
  return !aligning && nodeCount > 0 && (standalone || hasDrama)
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
