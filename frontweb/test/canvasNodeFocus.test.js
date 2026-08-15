import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const canvasSource = readFileSync(
  fileURLToPath(new URL('../src/views/DramaCanvas.vue', import.meta.url)),
  'utf8',
)

test('节点定位在视图移动后刷新 Vue Flow 节点内部尺寸', () => {
  assert.match(canvasSource, /async function focusCanvasNode\(nodeId, options = \{\}\) \{[\s\S]*const node = findGraphNode\(nodeId\)/)
  assert.match(canvasSource, /api\.setCenter[\s\S]*api\.updateNodeInternals\?\.\(\[String\(node\.id\)\]\)/)
  assert.match(canvasSource, /else await api\.fitView\(\{ nodes: \[String\(node\.id\)\]/)
})

test('展开项目节点编辑框后重新测量并限制适配缩放', () => {
  assert.match(canvasSource, /if \(focusChanged && PANEL_NODE_TYPES\.has\(node\.type\)\) void fitFocusedNodePanel\(node\.id\)/)
  assert.match(canvasSource, /async function fitFocusedNodePanel\(nodeId\) \{[\s\S]*api\.updateNodeInternals\?\.\(\[String\(nodeId\)\]\)[\s\S]*api\.fitView\(\{[\s\S]*nodes: \[String\(nodeId\)\],[\s\S]*maxZoom: 1/)
})
