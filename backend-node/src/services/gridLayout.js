const GRID_LAYOUTS = Object.freeze({
  quad_grid: Object.freeze({ key: 'quad_grid', label: '四宫格', panelCount: 4, rows: 2, columns: 2 }),
  nine_grid: Object.freeze({ key: 'nine_grid', label: '九宫格', panelCount: 9, rows: 3, columns: 3 }),
  fourteen_grid: Object.freeze({ key: 'fourteen_grid', label: '十四宫格', panelCount: 14, rows: 4, columns: 4 }),
  sixteen_grid: Object.freeze({ key: 'sixteen_grid', label: '十六宫格', panelCount: 16, rows: 4, columns: 4 }),
  twentyfive_grid: Object.freeze({ key: 'twentyfive_grid', label: '二十五宫格', panelCount: 25, rows: 5, columns: 5 }),
});

function getGridLayout(frameType) {
  return GRID_LAYOUTS[String(frameType || '').trim().toLowerCase()] || null;
}

function isGridFrameType(frameType) {
  return Boolean(getGridLayout(frameType));
}

function getGridCells(width, height, frameType) {
  const layout = typeof frameType === 'object' ? frameType : getGridLayout(frameType);
  if (!layout || !Number.isFinite(width) || !Number.isFinite(height)) return [];
  const cellWidth = Math.floor(width / layout.columns);
  const cellHeight = Math.floor(height / layout.rows);
  const cells = [];
  for (let row = 0; row < layout.rows; row += 1) {
    for (let column = 0; column < layout.columns; column += 1) {
      const index = row * layout.columns + column;
      if (index >= layout.panelCount) continue;
      const left = column * cellWidth;
      const top = row * cellHeight;
      cells.push({
        index,
        row,
        column,
        left,
        top,
        width: column === layout.columns - 1 ? width - left : cellWidth,
        height: row === layout.rows - 1 ? height - top : cellHeight,
      });
    }
  }
  return cells;
}

module.exports = { GRID_LAYOUTS, getGridLayout, isGridFrameType, getGridCells };
