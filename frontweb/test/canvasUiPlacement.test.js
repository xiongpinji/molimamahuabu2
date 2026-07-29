import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const accountBadgeSource = readFileSync(
  new URL('../src/components/AccountBadge.vue', import.meta.url),
  'utf8',
)
const canvasNodeSource = readFileSync(
  new URL('../src/components/dramaCanvas/HomeCanvasNode.vue', import.meta.url),
  'utf8',
)
const cuttableEdgeSource = readFileSync(
  new URL('../src/components/dramaCanvas/CanvasCuttableEdge.vue', import.meta.url),
  'utf8',
)

test('canvas account controls move to the header without changing other routes', () => {
  assert.match(accountBadgeSource, /account-badge--canvas/)
  assert.match(accountBadgeSource, /'standalone-canvas'/)
  assert.match(accountBadgeSource, /top:\s*12px/)
  assert.match(accountBadgeSource, /bottom:\s*auto/)
})

test('media asset actions live in the node title bar and image preview remains draggable', () => {
  const headingEnd = canvasNodeSource.indexOf('</header>')
  const actionPosition = canvasNodeSource.indexOf('class="node-media-actions')
  assert.ok(actionPosition > 0 && actionPosition < headingEnd)
  assert.equal(canvasNodeSource.includes('class="media-actions"'), false)
  assert.match(canvasNodeSource, /class="node-media"\s+draggable="false"/)
  assert.doesNotMatch(canvasNodeSource, /class="node-media nodrag nopan"/)
})

test('cuttable edges expose a wide explicit hover target for the scissor control', () => {
  assert.match(cuttableEdgeSource, /canvas-edge-hover-path/)
  assert.match(cuttableEdgeSource, /stroke-width:\s*40/)
  assert.match(cuttableEdgeSource, /'is-hovering': hovering/)
})
