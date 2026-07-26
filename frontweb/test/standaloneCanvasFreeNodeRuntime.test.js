import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const canvasSource = readFileSync(resolve(__dirname, '../src/views/DramaCanvas.vue'), 'utf8')
const nodeSource = readFileSync(resolve(__dirname, '../src/components/dramaCanvas/HomeCanvasNode.vue'), 'utf8')
const contextMenuSource = readFileSync(resolve(__dirname, '../src/components/dramaCanvas/CanvasContextMenu.vue'), 'utf8')
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
  assert.match(canvasSource, /aiAPI\.list\('storyboard_image'\)/)
  assert.match(canvasSource, /getSelectableModelsAcrossConfigs\(freeCanvasModelConfigs\.value, serviceType\)/)
  assert.match(canvasSource, /allow-create/)
  assert.match(nodeSource, /ctx\?\.getFreeNodeModelOptions\?\.\(props\.data\.kind\)/)
  assert.match(nodeSource, /<datalist v-if="modelOptions\.length"/)
})

test('HomeCanvasNode 提供状态显示和配置生成入口，并通过画布上下文调用父级', () => {
  assert.match(nodeSource, /useCanvasContext/)
  assert.match(nodeSource, /ctx\?\.openFreeNodeConfig\?\.\(props\.id\)/)
  assert.match(nodeSource, /ctx\?\.runFreeCanvasNode\?\.\(props\.id\)/)
  assert.match(nodeSource, /ctx\?\.retryFreeCanvasAssetSave\?\.\(props\.id\)/)
  assert.match(nodeSource, /assetSaveFailed = computed\(\(\) => props\.data\.status === 'success'[\s\S]*props\.data\.assetSaveStatus === 'failed'[\s\S]*Boolean\(props\.data\.url\)/)
  assert.match(nodeSource, /v-if="assetSaveFailed"[\s\S]*重试入库/)
  assert.match(nodeSource, /node-status/)
  assert.match(nodeSource, /data\.status === 'running'/)
  assert.match(nodeSource, /data\.status === 'failed'/)
  assert.match(nodeSource, /@click\.stop="openConfig"/)
  assert.match(nodeSource, /@click\.stop="runNode"/)
})

test('选中自由节点展开专属编辑器，视频节点可见展示自动采用的图片连线', () => {
  assert.match(nodeSource, /v-if="selected"[\s\S]*class="node-expanded-editor canvas-node-panel nodrag nopan"/)
  assert.match(nodeSource, /:aria-label="editorLabel"/)
  assert.match(nodeSource, /data\.kind === 'video'[\s\S]*aria-label="自动参考图"/)
  assert.match(nodeSource, /ctx\?\.getFreeNodeInputReferences\?\.\(props\.id\)/)
  assert.match(nodeSource, /reference\.ready \? 'ready' : 'pending'/)
  assert.match(nodeSource, /把图片节点连接到视频节点，生成时会自动采用为首帧和参考图/)
  assert.match(canvasSource, /getFreeNodeInputReferences: freeCanvasNodeInputReferences/)
  assert.match(canvasSource, /视频节点已自动采用该图片作为参考图/)
})

test('自由节点可从节点内和右键挂载兼容素材，并拒绝修改不兼容节点', () => {
  assert.match(nodeSource, /ctx\?\.openFreeNodeAssetLibrary\?\.\(props\.id\)/)
  assert.match(nodeSource, /v-if="canMountAsset"[\s\S]*素材库/)
  assert.match(contextMenuSource, /type: 'mount-free-node-asset'[\s\S]*label: '挂载素材'/)
  assert.match(canvasSource, /const canvasAssetPickerTargetFreeNodeId = ref\(''\)/)
  assert.match(canvasSource, /function openFreeNodeAssetLibrary\(nodeOrId\)/)
  assert.match(canvasSource, /canvasAssetPickerTargetFreeNodeId\.value = String\(node\.id\)/)
  assert.match(canvasSource, /if \(assetType !== targetNode\.data\?\.kind\)/)
  assert.match(canvasSource, /await patchFreeCanvasNodeData\(targetFreeNodeId, \{[\s\S]*url,[\s\S]*savedAssetId: String\(projectAssetId\(projectAsset\) \|\| ''\),[\s\S]*assetSaveStatus: 'success'/)
  assert.match(canvasSource, /if \(targetFreeNodeId\) \{[\s\S]*ElMessage\.error\(e\?\.message \|\| '素材挂载失败'\)[\s\S]*return/)
})

test('自由节点右键支持复制和删除，复制节点清除运行任务并偏移落点', () => {
  assert.match(contextMenuSource, /type: 'duplicate-free-node'[\s\S]*label: '复制节点'/)
  assert.match(contextMenuSource, /type: 'delete-free-node'[\s\S]*label: '删除节点'/)
  assert.match(canvasSource, /async function duplicateFreeCanvasNode\(nodeOrId\)/)
  assert.match(canvasSource, /x: Number\(source\.position\?\.x \|\| 0\) \+ 40/)
  assert.match(canvasSource, /y: Number\(source\.position\?\.y \|\| 0\) \+ 40/)
  assert.match(canvasSource, /taskId: ''/)
  assert.match(canvasSource, /type === 'duplicate-free-node'[\s\S]*await duplicateFreeCanvasNode\(node\)/)
  assert.match(canvasSource, /type === 'delete-free-node'[\s\S]*await deleteFreeCanvasNode\(node\.id\)/)
})

test('独立画布自由节点走真实生成分支，禁止污染剧集 runCanvasNodeStep', () => {
  assert.match(canvasSource, /import request from '@\/utils\/request'/)
  assert.match(canvasSource, /collectDirectUpstreamImageReferences/)
  assert.match(canvasSource, /buildFreeCanvasGenerationRequest/)
  assert.match(canvasSource, /buildFreeCanvasProjectAssetPayload/)
  assert.match(canvasSource, /resolveFreeCanvasResultUrl/)
  assert.match(canvasSource, /async function runFreeCanvasNode\(nodeOrId\)/)
  assert.match(canvasSource, /if \(!isStandaloneCanvas\.value \|\| node\?\.type !== 'homeCanvasNode'\)/)
  assert.match(canvasSource, /const upstreamUrls = freeCanvasNodeInputReferences\(node\)[\s\S]*requestPayload = buildFreeCanvasGenerationRequest\(node\.data, \{[\s\S]*dramaId: dramaId\.value,[\s\S]*upstreamUrls/)
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
  assert.match(canvasSource, /patchFreeCanvasNodeData\(node\.id, \{[\s\S]*status: 'success'[\s\S]*url: resultUrl[\s\S]*assetSaveStatus: 'running'[\s\S]*assetSaveError: ''/)
  assert.match(canvasSource, /patchFreeCanvasNodeData\(node\.id, \{[\s\S]*status: 'failed'[\s\S]*error: errorMessage/)
  assert.match(canvasSource, /buildFreeCanvasProjectAssetPayload\(\{[\s\S]*storyboard_id: null/)
  assert.match(canvasSource, /patchFreeCanvasNodeData\(nodeId, \{ assetSaveStatus: 'running', assetSaveError: '' \}/)
  assert.match(canvasSource, /await assetsAPI\.create\(assetPayload\)/)
  assert.match(canvasSource, /assetSaveStatus: 'success'[\s\S]*assetSaveError: ''[\s\S]*savedAssetId: String\(savedAsset\?\.id \|\| ''\)/)
  assert.match(canvasSource, /assetSaveStatus: 'failed'[\s\S]*assetSaveError: error\?\.message \|\| '自动存入素材库失败'/)
  assert.match(canvasSource, /async function retryFreeCanvasAssetSave\(nodeOrId\)/)
  assert.match(canvasSource, /retryFreeCanvasAssetSave,\s*\n\}\)/)
  assert.match(canvasSource, /save-node-result-asset[\s\S]*saveFreeCanvasResultAsset\(node, node\.data\?\.kind, nodeResultUrl\(node\), null, node\.data\?\.taskId \|\| ''\)[\s\S]*ElMessage\.error\(error\?\.message \|\| '存入素材库失败'\)/)
})

test('画布保存使用串行队列并在执行时构造最新布局', () => {
  assert.match(canvasSource, /let canvasPersistQueue = Promise\.resolve\(\)/)
  assert.match(canvasSource, /function persistCanvasState\(options = \{\}\) \{[\s\S]*const runPersist = \(\) => persistCanvasStateNow\(options\)[\s\S]*canvasPersistQueue = canvasPersistQueue\.then\(runPersist, runPersist\)[\s\S]*return canvasPersistQueue[\s\S]*\}/)
  assert.match(canvasSource, /async function persistCanvasStateNow\(\{ layoutOnly = false, groupsOnly = false \} = \{\}\)/)
  assert.match(canvasSource, /async function persistCanvasStateNow[\s\S]*syncRenderedNodesToGraph\(\)[\s\S]*buildCanvasLayoutPayload\([\s\S]*allGraphNodes\.value,[\s\S]*currentViewport\.value,[\s\S]*layoutCache\.value/)
  assert.match(canvasSource, /async function persistCanvasStateNow[\s\S]*const updated = await layoutPersistence\.update/)
})

test('自由节点素材入库使用 single-flight 并在 create 前检查已入库状态', () => {
  assert.match(canvasSource, /const freeCanvasAssetSaveFlights = new Map\(\)/)
  assert.match(canvasSource, /const saveKey = `\$\{nodeId\}::\$\{url\}`/)
  assert.match(canvasSource, /const existingFlight = freeCanvasAssetSaveFlights\.get\(saveKey\)[\s\S]*if \(existingFlight\) return existingFlight/)
  assert.match(canvasSource, /const savePromise = \(async \(\) => \{[\s\S]*const latestBeforeRun = freeCanvasNodeById\(nodeId\) \|\| node[\s\S]*if \(latestBeforeRun\?\.data\?\.savedAssetId\)[\s\S]*return \{ id: latestBeforeRun\.data\.savedAssetId, skipped: true \}/)
  assert.match(canvasSource, /const latestBeforeCreate = freeCanvasNodeById\(nodeId\) \|\| latestBeforeRun[\s\S]*if \(latestBeforeCreate\?\.data\?\.savedAssetId\)[\s\S]*return \{ id: latestBeforeCreate\.data\.savedAssetId, skipped: true \}[\s\S]*await assetsAPI\.create\(assetPayload\)/)
  assert.match(canvasSource, /freeCanvasAssetSaveFlights\.set\(saveKey, savePromise\)[\s\S]*finally \{[\s\S]*freeCanvasAssetSaveFlights\.delete\(saveKey\)/)
})

test('图片和视频 API 提供 get 回读包装', () => {
  assert.match(imagesSource, /get\(id\) \{[\s\S]*return request\.get\(`\/images\/\$\{id\}`\)/)
  assert.match(videosSource, /get\(id\) \{[\s\S]*return request\.get\(`\/videos\/\$\{id\}`\)/)
})
