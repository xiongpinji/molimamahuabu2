import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const canvasSource = readFileSync(fileURLToPath(new URL('../src/views/DramaCanvas.vue', import.meta.url)), 'utf8')
const alignerSource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/CanvasFlowAligner.vue', import.meta.url)), 'utf8')

test('节点定位通过 setCenter 居中远距离节点并保留 fitView 回退', () => {
  assert.match(alignerSource, /const \{[^}]*setCenter[^}]*updateNodeInternals[^}]*\} = useVueFlow\(\)/)
  assert.match(alignerSource, /registerCanvasFlowApi\?\.\(\{[^}]*setCenter[^}]*updateNodeInternals[^}]*\}\)/)
  assert.match(canvasSource, /async function focusCanvasNode\(nodeId, options = \{\}\) \{[\s\S]*const node = findGraphNode\(nodeId\)[\s\S]*api\.setCenter\(centerX, centerY, \{ zoom, duration: 320 \}\)/)
  assert.match(canvasSource, /api\.setCenter[\s\S]*api\.updateNodeInternals\?\.\(\[String\(node\.id\)\]\)/)
  assert.match(canvasSource, /else await api\.fitView\(\{ nodes: \[String\(node\.id\)\]/)
})
