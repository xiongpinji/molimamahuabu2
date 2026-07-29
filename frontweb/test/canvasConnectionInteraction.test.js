import assert from 'node:assert/strict'
import test from 'node:test'

import { canvasConnectionInteractionOptions } from '../src/utils/canvasConnectionInteraction.js'

test('canvas connection options enlarge VueFlow connection hit areas', () => {
  assert.deepEqual(canvasConnectionInteractionOptions, {
    connectionRadius: 60,
    edgeUpdaterRadius: 30,
    connectOnClick: true,
  })
  assert.ok(canvasConnectionInteractionOptions.connectionRadius > 20)
  assert.ok(canvasConnectionInteractionOptions.edgeUpdaterRadius > 10)
})

test('canvas connection options are immutable', () => {
  assert.equal(Object.isFrozen(canvasConnectionInteractionOptions), true)
  assert.throws(() => {
    canvasConnectionInteractionOptions.connectionRadius = 1
  }, TypeError)
})
