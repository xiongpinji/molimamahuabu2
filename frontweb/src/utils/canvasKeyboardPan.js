export const CANVAS_KEYBOARD_PAN_SPEED = 2200
export const CANVAS_KEYBOARD_PAN_INITIAL_STEP = 56
export const CANVAS_KEYBOARD_PAN_MAX_FRAME_MS = 32

const KEY_DIRECTIONS = {
  w: { x: 0, y: 1 },
  arrowup: { x: 0, y: 1 },
  a: { x: 1, y: 0 },
  arrowleft: { x: 1, y: 0 },
  s: { x: 0, y: -1 },
  arrowdown: { x: 0, y: -1 },
  d: { x: -1, y: 0 },
  arrowright: { x: -1, y: 0 },
}

function normalizeKey(key) {
  return String(key || '').toLowerCase()
}

export function isCanvasKeyboardPanKey(key) {
  return Boolean(KEY_DIRECTIONS[normalizeKey(key)])
}

export function canvasKeyboardPanVector(keys = []) {
  const vector = [...keys].reduce((result, key) => {
    const direction = KEY_DIRECTIONS[normalizeKey(key)]
    if (!direction) return result
    return { x: result.x + direction.x, y: result.y + direction.y }
  }, { x: 0, y: 0 })
  const magnitude = Math.hypot(vector.x, vector.y)
  if (!magnitude) return { x: 0, y: 0 }
  return { x: vector.x / magnitude, y: vector.y / magnitude }
}

export function canvasKeyboardPanDelta(keys, elapsedMs, speed = CANVAS_KEYBOARD_PAN_SPEED) {
  const elapsed = Math.min(CANVAS_KEYBOARD_PAN_MAX_FRAME_MS, Math.max(0, Number(elapsedMs) || 0))
  const distance = elapsed * Math.max(0, Number(speed) || 0) / 1000
  const vector = canvasKeyboardPanVector(keys)
  return { x: vector.x * distance, y: vector.y * distance }
}
