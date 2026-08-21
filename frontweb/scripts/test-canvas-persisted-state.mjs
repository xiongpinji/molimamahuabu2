import assert from 'node:assert/strict'
import {
  mergeGenerationHistory,
  normalizeGenerationHistory,
} from '../src/utils/canvasPersistedState.js'
import {
  DEFAULT_CANVAS_PREFERENCES,
  normalizeCanvasPreferences,
} from '../src/utils/canvasSettings.js'

assert.deepEqual(normalizeCanvasPreferences(), DEFAULT_CANVAS_PREFERENCES)
assert.deepEqual(normalizeCanvasPreferences({
  grid_visible: false,
  minimap_visible: false,
  snap_enabled: true,
}), {
  ...DEFAULT_CANVAS_PREFERENCES,
  grid_visible: false,
  minimap_visible: false,
  snap_enabled: true,
})

const running = { key: 'running', tone: 'running', at: 3 }
const success = { key: 'success', nodeId: 'image:1', tone: 'success', at: 2, resultUrl: '/image.png' }
const failed = { key: 'failed', nodeId: 'video:1', tone: 'failed', at: 1, errorDetail: 'provider failed' }
assert.deepEqual(normalizeGenerationHistory([running, success, failed]).map((item) => item.key), ['success', 'failed'])

const merged = mergeGenerationHistory(
  [{ ...success, persisted: true }],
  [{ ...success }, { key: 'new', nodeId: 'audio:1', tone: 'success', at: 4 }],
)
assert.deepEqual(merged.map((item) => item.key), ['new', 'success'])
assert.equal(merged[0].persisted, true)

const bounded = normalizeGenerationHistory(
  Array.from({ length: 105 }, (_, index) => ({
    key: `item-${index}`,
    tone: 'success',
    at: index,
  })),
)
assert.equal(bounded.length, 100)
assert.equal(bounded[0].key, 'item-104')
assert.equal(bounded.at(-1).key, 'item-5')

console.log('canvas persisted state tests passed')
