import test from 'node:test'
import assert from 'node:assert/strict'
import {
  commitCanvasInteractionHistory,
  createCanvasInteractionHistory,
  createCanvasInteractionState,
  redoCanvasInteractionHistory,
  serializeCanvasInteractionState,
  undoCanvasInteractionHistory,
} from '../src/utils/canvasInteractionHistory.js'

test('画布布局历史支持提交、撤销、重做并保留视口', () => {
  const first = createCanvasInteractionState([{ id: 'a', position: { x: 10, y: 20 } }], { x: 1, y: 2, zoom: 0.8 })
  const second = createCanvasInteractionState([{ id: 'a', position: { x: 40, y: 50 } }], { x: 11, y: 12, zoom: 1 })
  let history = createCanvasInteractionHistory(first)

  history = commitCanvasInteractionHistory(history, first, second)
  assert.equal(history.past.length, 1)
  history = undoCanvasInteractionHistory(history)
  assert.deepEqual(history.present, first)
  history = redoCanvasInteractionHistory(history)
  assert.deepEqual(history.present, second)
  assert.equal(serializeCanvasInteractionState(history.present), serializeCanvasInteractionState(second))
})

test('无效节点位置不会进入历史快照，历史分支提交会清空重做栈', () => {
  const first = createCanvasInteractionState([
    { id: 'ok', position: { x: 1, y: 2 } },
    { id: 'bad', position: { x: 'NaN', y: 4 } },
  ])
  const second = createCanvasInteractionState([{ id: 'ok', position: { x: 8, y: 9 } }])
  const branch = createCanvasInteractionState([{ id: 'ok', position: { x: 20, y: 21 } }])
  let history = createCanvasInteractionHistory(first)
  history = commitCanvasInteractionHistory(history, first, second)
  history = undoCanvasInteractionHistory(history)
  history = commitCanvasInteractionHistory(history, first, branch)

  assert.deepEqual(Object.keys(history.present.nodes), ['ok'])
  assert.equal(history.future.length, 0)
})
