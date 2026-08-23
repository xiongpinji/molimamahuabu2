export const GRID_LAYOUTS = Object.freeze([
  { value: 'quad_grid', label: '四宫格', panels: 4, rows: 2, columns: 2 },
  { value: 'nine_grid', label: '九宫格', panels: 9, rows: 3, columns: 3 },
  { value: 'fourteen_grid', label: '十四宫格', panels: 14, rows: 4, columns: 4, note: '4×4 网格，末尾保留 2 个空槽' },
  { value: 'sixteen_grid', label: '十六宫格', panels: 16, rows: 4, columns: 4 },
  { value: 'twentyfive_grid', label: '二十五宫格', panels: 25, rows: 5, columns: 5 },
])

export const GRID_FRAME_TYPES = new Set(GRID_LAYOUTS.map((item) => item.value))

export function isGridFrameType(frameType) {
  return GRID_FRAME_TYPES.has(String(frameType || '').trim().toLowerCase())
}
