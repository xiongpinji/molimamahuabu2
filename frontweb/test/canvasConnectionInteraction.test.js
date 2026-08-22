import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canvasConnectionInteractionOptions,
  resolveCanvasConnectionDrop,
} from '../src/utils/canvasConnectionInteraction.js'

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

test('connection drop resolves any point inside a different node body', () => {
  const target = {
    closest(selector) {
      if (selector === '.vue-flow__node') return { dataset: { id: 'target-node' } }
      return null
    },
  }

  assert.deepEqual(resolveCanvasConnectionDrop({
    sourceNodeId: 'source-node',
    targets: [target],
    clientX: 120,
    clientY: 240,
  }), {
    kind: 'connect',
    targetNodeId: 'target-node',
    clientX: 120,
    clientY: 240,
  })
})

test('connection drop on canvas blank requests the existing create menu', () => {
  const pane = {
    closest(selector) {
      if (selector === '.vue-flow__node') return null
      if (selector === '.vue-flow__pane') return this
      return null
    },
  }

  assert.deepEqual(resolveCanvasConnectionDrop({
    sourceNodeId: 'source-node',
    targets: [pane],
    clientX: 360,
    clientY: 420,
  }), {
    kind: 'create',
    clientX: 360,
    clientY: 420,
  })
})

test('connection drop ignores the source node and non-canvas overlays', () => {
  const source = {
    closest(selector) {
      if (selector === '.vue-flow__node') return { dataset: { id: 'source-node' } }
      return null
    },
  }
  const overlay = { closest: () => null }

  assert.equal(resolveCanvasConnectionDrop({
    sourceNodeId: 'source-node',
    targets: [source],
    clientX: 1,
    clientY: 2,
  }), null)
  assert.equal(resolveCanvasConnectionDrop({
    sourceNodeId: 'source-node',
    targets: [overlay],
    clientX: 1,
    clientY: 2,
  }), null)
})
