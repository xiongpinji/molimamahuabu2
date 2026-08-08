function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function createGridCropBoxes(rows, columns) {
  return Array.from({ length: rows * columns }, (_, index) => {
    const row = Math.floor(index / columns)
    const column = index % columns
    return {
      id: `${row}:${column}`,
      row,
      column,
      left: column / columns,
      top: row / rows,
      width: 1 / columns,
      height: 1 / rows,
    }
  })
}

export function moveGridCropBox(box, deltaX, deltaY) {
  return {
    ...box,
    left: clamp(box.left + deltaX, 0, 1 - box.width),
    top: clamp(box.top + deltaY, 0, 1 - box.height),
  }
}

export function resizeGridCropBox(box, handle, deltaX, deltaY, minWidth, minHeight) {
  let left = box.left
  let top = box.top
  let right = box.left + box.width
  let bottom = box.top + box.height

  if (handle.includes('w')) left = clamp(left + deltaX, 0, right - minWidth)
  if (handle.includes('e')) right = clamp(right + deltaX, left + minWidth, 1)
  if (handle.includes('n')) top = clamp(top + deltaY, 0, bottom - minHeight)
  if (handle.includes('s')) bottom = clamp(bottom + deltaY, top + minHeight, 1)

  return { ...box, left, top, width: right - left, height: bottom - top }
}
