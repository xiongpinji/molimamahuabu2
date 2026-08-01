import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function source(path) {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const canvasSource = source('../src/views/DramaCanvas.vue')
const nodeSource = source('../src/components/dramaCanvas/HomeCanvasNode.vue')
const edgeSource = source('../src/components/dramaCanvas/CanvasCuttableEdge.vue')
const requestSource = source('../src/utils/request.js')
const tenantSource = source('../src/views/TenantConsole.vue')

test('图片和视频预览都可通过关闭操作及 Escape 退出', () => {
  assert.match(nodeSource, /mediaPreviewKind === 'image'/)
  assert.match(nodeSource, /<video v-else :src="mediaPreviewUrl" controls autoplay playsinline/)
  assert.match(nodeSource, /@click\.self="closeMediaPreview"/)
  assert.match(nodeSource, /@click="closeMediaPreview"/)
  assert.match(nodeSource, /if \(mediaPreviewUrl\.value\) \{[\s\S]*closeMediaPreview\(\)/)
})

test('独立画布支持将本地图片直接拖入并在落点创建图片节点', () => {
  assert.match(canvasSource, /@dragover="onCanvasImageDragOver"/)
  assert.match(canvasSource, /@drop="onCanvasImageDrop"/)
  assert.match(canvasSource, /collectDroppedImageFiles/)
  assert.match(canvasSource, /createDroppedImageNodeSpecs/)
  assert.match(canvasSource, /screenToFlowPosition\(event\.clientX, event\.clientY\)/)
  assert.match(canvasSource, /createFreeCanvasNode\('image', spec\.position, spec\.data\)/)
  assert.match(canvasSource, /uploadAPI\.uploadMedia\(spec\.file, \{ dramaId: drama\.value\.id \}\)/)
})

test('连线悬停时可直接运行下游图片节点', () => {
  assert.match(edgeSource, /inject\('can-run-canvas-edge-target'/)
  assert.match(edgeSource, /inject\('run-canvas-edge-target'/)
  assert.match(edgeSource, /aria-label="运行下游图片节点"/)
  assert.match(edgeSource, /runCanvasEdgeTarget\?\.\(props\.id\)/)
  assert.match(canvasSource, /provide\('can-run-canvas-edge-target', canRunCanvasEdgeTarget\)/)
  assert.match(canvasSource, /provide\('run-canvas-edge-target', runCanvasEdgeTarget\)/)
})

test('请求失败优先展示服务端的具体失败原因', () => {
  assert.match(requestSource, /function apiErrorMessage\(payload, fallback = ''\)/)
  assert.match(requestSource, /payload\.provider_message/)
  assert.match(requestSource, /apiErrorMessage\(error\.response\?\.data\)/)
})

test('积分消耗和兑换记录都展示交易后的剩余积分', () => {
  assert.equal((tenantSource.match(/label="剩余积分"/g) || []).length, 2)
  assert.match(tenantSource, /const transactionsWithBalance = computed/)
  assert.match(tenantSource, /balance_after/)
  assert.match(tenantSource, /remaining_balance/)
})
