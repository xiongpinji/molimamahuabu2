const test = require('node:test');
const assert = require('node:assert/strict');

const { GRID_LAYOUTS, getGridLayout, isGridFrameType, getGridCells } = require('../src/services/gridLayout');

test('supported grid layouts keep the requested panel counts', () => {
  assert.deepEqual(
    Object.values(GRID_LAYOUTS).map((layout) => [layout.key, layout.panelCount]),
    [
      ['quad_grid', 4],
      ['nine_grid', 9],
      ['fourteen_grid', 14],
      ['sixteen_grid', 16],
      ['twentyfive_grid', 25],
    ],
  );
  assert.equal(getGridLayout('SIXTEEN_GRID').panelCount, 16);
  assert.equal(isGridFrameType('twentyfive_grid'), true);
  assert.equal(isGridFrameType('single'), false);
});

test('fourteen grid crops 14 cells from a 4 by 4 canvas and leaves two slots empty', () => {
  const cells = getGridCells(1000, 800, 'fourteen_grid');
  assert.equal(cells.length, 14);
  assert.deepEqual(cells[0], { index: 0, row: 0, column: 0, left: 0, top: 0, width: 250, height: 200 });
  assert.deepEqual(cells.at(-1), { index: 13, row: 3, column: 1, left: 250, top: 600, width: 250, height: 200 });
  assert.equal(cells.some((cell) => cell.index === 14), false);
  assert.equal(cells.some((cell) => cell.index === 15), false);
});

test('expanded grid cells cover the full final row and column', () => {
  const cells = getGridCells(101, 101, 'twentyfive_grid');
  assert.equal(cells.length, 25);
  assert.equal(cells.at(-1).left + cells.at(-1).width, 101);
  assert.equal(cells.at(-1).top + cells.at(-1).height, 101);
});
