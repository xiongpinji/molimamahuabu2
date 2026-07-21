import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const overlaySource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/CanvasNodeStatusOverlay.vue', import.meta.url)), 'utf8')
const canvasSource = readFileSync(fileURLToPath(new URL('../src/views/DramaCanvas.vue', import.meta.url)), 'utf8')

test('节点状态覆盖层提供结果、提示词和失败原因操作', () => {
  assert.match(overlaySource, /打开结果/)
  assert.match(overlaySource, /复制提示词/)
  assert.match(overlaySource, /复制原因/)
  assert.match(overlaySource, /class="result-preview"/)
  assert.match(overlaySource, /<img v-if="resultPreviewType === 'image'"/)
  assert.match(overlaySource, /<video v-else-if="resultPreviewType === 'video'"/)
  assert.match(overlaySource, /<audio v-else-if="resultPreviewType === 'audio'"/)
  assert.match(overlaySource, /function copyPrompt\(\)/)
  assert.match(overlaySource, /function copyError\(\)/)
})

test('画布节点运行状态会携带当前节点提示词', () => {
  assert.match(canvasSource, /function nodeStepPromptText\(step, sb, node\)/)
  assert.match(canvasSource, /nodeStatus\.set\(nodeId, \{ step, message: statusMessage, promptText/)
  assert.match(canvasSource, /const resultInfo = \{ \.\.\.nodeStepResultInfo\(node, step, sb\.id\), promptText \}/)
  assert.match(canvasSource, /errorDetail: errorMessage/)
})
