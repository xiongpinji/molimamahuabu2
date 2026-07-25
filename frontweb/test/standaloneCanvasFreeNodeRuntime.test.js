import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const canvasSource = readFileSync(resolve(__dirname, '../src/views/DramaCanvas.vue'), 'utf8')
const nodeSource = readFileSync(resolve(__dirname, '../src/components/dramaCanvas/HomeCanvasNode.vue'), 'utf8')
const imagesSource = readFileSync(resolve(__dirname, '../src/api/images.js'), 'utf8')
const videosSource = readFileSync(resolve(__dirname, '../src/api/videos.js'), 'utf8')

test('自由节点配置面板保存并回填模型、比例和时长字段', () => {
  assert.match(canvasSource, /freeNodeForm = ref\(\{ title: '', content: '', url: '', model: '', aspectRatio: '16:9', duration: 5 \}\)/)
  assert.match(canvasSource, /v-if="freeNodeKind !== 'text'" label="模型"/)
  assert.match(canvasSource, /v-model="freeNodeForm\.model"/)
  assert.match(canvasSource, /v-if="\['image', 'video'\]\.includes\(freeNodeKind\)" label="画面比例"/)
  assert.match(canvasSource, /v-if="freeNodeKind === 'video'" label="视频时长/)
  assert.match(canvasSource, /model: node\?\.data\?\.model \|\| ''/)
  assert.match(canvasSource, /aspectRatio: node\?\.data\?\.aspectRatio \|\| '16:9'/)
  assert.match(canvasSource, /duration: node\?\.data\?\.duration \|\| 5/)
})

test('HomeCanvasNode 提供状态显示和配置生成入口，并通过画布上下文调用父级', () => {
  assert.match(nodeSource, /useCanvasContext/)
  assert.match(nodeSource, /ctx\?\.openFreeNodeConfig\?\.\(props\.id\)/)
  assert.match(nodeSource, /ctx\?\.runFreeCanvasNode\?\.\(props\.id\)/)
  assert.match(nodeSource, /node-status/)
  assert.match(nodeSource, /data\.status === 'running'/)
  assert.match(nodeSource, /data\.status === 'failed'/)
  assert.match(nodeSource, /@click\.stop="openConfig"/)
  assert.match(nodeSource, /@click\.stop="runNode"/)
})

test('独立画布自由节点走真实生成分支，禁止污染剧集 runCanvasNodeStep', () => {
  assert.match(canvasSource, /collectDirectUpstreamResultUrls/)
  assert.match(canvasSource, /buildFreeCanvasGenerationRequest/)
  assert.match(canvasSource, /buildFreeCanvasProjectAssetPayload/)
  assert.match(canvasSource, /resolveFreeCanvasResultUrl/)
  assert.match(canvasSource, /async function runFreeCanvasNode\(nodeOrId\)/)
  assert.match(canvasSource, /if \(!isStandaloneCanvas\.value \|\| node\?\.type !== 'homeCanvasNode'\)/)
  assert.match(canvasSource, /requestPayload = buildFreeCanvasGenerationRequest\(node\.data, \{[\s\S]*dramaId: dramaId\.value,[\s\S]*upstreamUrls/)
  assert.match(canvasSource, /if \(kind === 'image'\) submitResult = await imagesAPI\.create\(requestPayload\)/)
  assert.match(canvasSource, /else if \(kind === 'video'\) submitResult = await videosAPI\.create\(requestPayload\)/)
  assert.match(canvasSource, /else if \(kind === 'audio'\) submitResult = await request\.post\('\/audio\/extract', requestPayload\)/)
  assert.match(canvasSource, /buildFreeCanvasGenerationRequest\(node\.data/)
  assert.match(canvasSource, /async function runCanvasNodeStep\(node, step\) \{[\s\S]*if \(isStandaloneCanvas\.value && node\?\.type === 'homeCanvasNode'\)/)
})

test('自由节点运行结果可轮询、失败写回、成功自动入库并保留旧 url', () => {
  assert.match(canvasSource, /async function pollFreeCanvasTask\(taskId/)
  assert.match(canvasSource, /if \(task\?\.status === 'completed'\) return task/)
  assert.match(canvasSource, /if \(task\?\.status === 'failed'\) throw new Error/)
  assert.match(canvasSource, /throw new Error\('自由节点生成超时'\)/)
  assert.match(canvasSource, /patchFreeCanvasNodeData\(node\.id, \{[\s\S]*status: 'running'[\s\S]*error: ''/)
  assert.match(canvasSource, /patchFreeCanvasNodeData\(node\.id, \{[\s\S]*status: 'success'[\s\S]*url: resultUrl/)
  assert.match(canvasSource, /patchFreeCanvasNodeData\(node\.id, \{[\s\S]*status: 'failed'[\s\S]*error: errorMessage/)
  assert.match(canvasSource, /buildFreeCanvasProjectAssetPayload\(\{[\s\S]*storyboard_id: null/)
  assert.match(canvasSource, /await assetsAPI\.create\(assetPayload\)/)
  assert.match(canvasSource, /savedAssetId: String\(savedAsset\?\.id \|\| ''\)/)
})

test('图片和视频 API 提供 get 回读包装', () => {
  assert.match(imagesSource, /get\(id\) \{[\s\S]*return request\.get\(`\/images\/\$\{id\}`\)/)
  assert.match(videosSource, /get\(id\) \{[\s\S]*return request\.get\(`\/videos\/\$\{id\}`\)/)
})
