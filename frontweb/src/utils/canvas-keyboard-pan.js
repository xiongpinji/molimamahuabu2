export const CANVAS_KEYBOARD_PAN_SPEED = 900

const MAX_FRAME_DURATION_MS = 32
const KEY_DIRECTIONS = {
  w: { x: 0, y: 1 },
  a: { x: 1, y: 0 },
  s: { x: 0, y: -1 },
  d: { x: -1, y: 0 },
}

export function isCanvasKeyboardPanKey(key) {
  return Object.hasOwn(KEY_DIRECTIONS, key)
}

export function calculateCanvasKeyboardPanDelta(pressedKeys, elapsedMs) {
  let x = 0
  let y = 0
  for (const key of pressedKeys) {
    const direction = KEY_DIRECTIONS[key]
    if (!direction) continue
    x += direction.x
    y += direction.y
  }

  const magnitude = Math.hypot(x, y)
  if (!magnitude) return { x: 0, y: 0 }

  const frameDuration = Math.min(Math.max(Number(elapsedMs) || 0, 0), MAX_FRAME_DURATION_MS)
  const distance = CANVAS_KEYBOARD_PAN_SPEED * frameDuration / 1000
  return {
    x: x / magnitude * distance,
    y: y / magnitude * distance,
  }
}
