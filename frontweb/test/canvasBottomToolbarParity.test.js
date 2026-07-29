import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const toolbarSource = fs.readFileSync(
  new URL('../src/components/dramaCanvas/CanvasFloatingToolbar.vue', import.meta.url),
  'utf8',
)
const canvasSource = fs.readFileSync(
  new URL('../src/views/DramaCanvas.vue', import.meta.url),
  'utf8',
)

test('standalone canvas toolbar exposes the reference workflow controls', () => {
  for (const label of ['添加元素', '我的资产', '生成历史', '节点定位', '画布设置', '自动吸附']) {
    assert.match(toolbarSource, new RegExp(label))
  }
})

test('canvas settings bind to real VueFlow behavior', () => {
  assert.match(canvasSource, /:snap-to-grid="canvasSnapEnabled"/)
  assert.match(canvasSource, /<Background v-if="canvasGridVisible"/)
  assert.match(canvasSource, /<MiniMap v-if="canvasMiniMapVisible"/)
  assert.match(canvasSource, /canvasNodeLocatorItems/)
  assert.match(canvasSource, /runQueueItems/)
})
