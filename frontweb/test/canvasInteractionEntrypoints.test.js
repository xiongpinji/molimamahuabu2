import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const canvasSource = readFileSync(fileURLToPath(new URL('../src/views/DramaCanvas.vue', import.meta.url)), 'utf8')
const toolbarSource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/CanvasFloatingToolbar.vue', import.meta.url)), 'utf8')

test('画布保留 LibTV 式导航、框选和拖拽历史入口', () => {
  assert.match(canvasSource, /pan-activation-key-code="Space"/)
  assert.match(canvasSource, /zoom-activation-key-code="Control"/)
  assert.match(canvasSource, /:zoom-on-scroll="false"/)
  assert.match(canvasSource, /:select-nodes-on-drag="true"/)
  assert.match(canvasSource, /selection-mode="partial"/)
  assert.match(canvasSource, /@node-drag-start="onNodeDragStart"/)
  assert.match(canvasSource, /function onCanvasWheel\(event\)/)
  assert.match(canvasSource, /function onCanvasKeydown\(event\)/)
})

test('悬浮工具栏暴露撤销和重做操作', () => {
  assert.match(toolbarSource, /aria-label="撤销"/)
  assert.match(toolbarSource, /aria-label="重做"/)
  assert.match(toolbarSource, /:disabled="!canUndo"/)
  assert.match(toolbarSource, /:disabled="!canRedo"/)
  assert.match(toolbarSource, /function undo\(\) \{ ctx\?\.undoCanvas\?\.\(\) \}/)
  assert.match(toolbarSource, /function redo\(\) \{ ctx\?\.redoCanvas\?\.\(\) \}/)
})
