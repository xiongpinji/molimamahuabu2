import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const apiSource = readFileSync(resolve(__dirname, '../src/api/imageTools.js'), 'utf8')
const toolbarSource = readFileSync(
  resolve(__dirname, '../src/components/dramaCanvas/ImageNodeToolbar.vue'),
  'utf8',
)
const nodeSource = readFileSync(
  resolve(__dirname, '../src/components/dramaCanvas/HomeCanvasNode.vue'),
  'utf8',
)
const canvasSource = readFileSync(resolve(__dirname, '../src/views/DramaCanvas.vue'), 'utf8')

test('图片工具 API 覆盖能力、执行和任务回读', () => {
  assert.match(apiSource, /request\.get\('\/image-tools\/capabilities'\)/)
  assert.match(apiSource, /request\.post\('\/image-tools\/operations', payload\)/)
  assert.match(apiSource, /request\.get\(`\/image-tools\/operations\/\$\{taskId\}`\)/)
  assert.match(apiSource, /let capabilitiesRequest/)
  assert.match(apiSource, /capabilitiesRequest \|\|=/)
  assert.match(apiSource, /\.catch\(\(error\) => \{[\s\S]*capabilitiesRequest = null/)
})

test('图片节点挂载独立工具栏且不影响其他节点', () => {
  assert.match(nodeSource, /import ImageNodeToolbar from '.\/ImageNodeToolbar\.vue'/)
  assert.match(
    nodeSource,
    /<ImageNodeToolbar[\s\S]*v-if="data\.kind === 'image' && data\.url"/,
  )
  assert.match(nodeSource, /:node-id="id"/)
  assert.match(nodeSource, /:data="data"/)
  assert.match(toolbarSource, /\.vue-flow__node\.selected \.image-node-toolbar/)
})

test('工具栏按后端能力启用并保留不可用原因', () => {
  assert.match(toolbarSource, /imageToolsAPI\.getCapabilities\(\)/)
  assert.match(toolbarSource, /operationCapability\(item\.operation\)/)
  assert.match(toolbarSource, /capability\.reason/)
  assert.match(toolbarSource, /:disabled="nodeBusy \|\| !itemAvailable\(item\)"/)
  assert.match(toolbarSource, /:disabled="nodeBusy \|\| !operationCapability\(item\.operation\)\.available"/)
  assert.match(toolbarSource, /props\.data\.status === 'running'/)
  assert.match(toolbarSource, /图片节点正在生成或处理，请稍后/)
  assert.match(toolbarSource, /裁剪\/压缩\/镜像/)
  assert.match(toolbarSource, /宫格裁剪/)
  assert.match(toolbarSource, /smart_cutout: '智能抠图'/)
  assert.match(toolbarSource, /selection_cutout: '框选抠图'/)
  assert.match(toolbarSource, /upscale: '高清增强'/)
  assert.match(toolbarSource, /图片调整/)
  assert.match(toolbarSource, /LUT 调色/)
  assert.match(toolbarSource, /720全景/)
  assert.match(toolbarSource, /灯光/)
  assert.match(toolbarSource, /高清/)
  assert.equal(/核验|侵权检测|版权检测/.test(toolbarSource), false)
})

test('高清入口只提交 Real-ESRGAN 支持的 2x、3x、4x 倍率', () => {
  assert.match(toolbarSource, /upscaleScale = ref\(2\)/)
  assert.match(toolbarSource, /editorOperation === 'upscale'/)
  assert.match(toolbarSource, /<el-option label="2x" :value="2" \/>/)
  assert.match(toolbarSource, /<el-option label="3x" :value="3" \/>/)
  assert.match(toolbarSource, /<el-option label="4x" :value="4" \/>/)
  assert.match(
    toolbarSource,
    /editorOperation\.value === 'upscale'\) return \{ scale: upscaleScale\.value \}/,
  )
  assert.match(toolbarSource, /本地 Real-ESRGAN/)
})

test('裁剪按需加载固定版本 Cropper.js 并把像素范围提交给父画布', () => {
  assert.match(toolbarSource, /import\('cropperjs'\)/)
  assert.match(toolbarSource, /import\('cropperjs\/dist\/cropper\.css'\)/)
  assert.match(toolbarSource, /cropper\.getData\(true\)/)
  assert.match(toolbarSource, /ctx\?\.runImageNodeTool\?\.\(\s*props\.nodeId/)
  assert.match(toolbarSource, /left: data\.x/)
  assert.match(toolbarSource, /top: data\.y/)
  assert.match(toolbarSource, /width: data\.width/)
  assert.match(toolbarSource, /height: data\.height/)
  assert.match(toolbarSource, /\['crop', 'selection_cutout'\]\.includes\(editorOperation/)
})

test('执行图片工具成功才替换节点结果，失败保留旧图并写回错误', () => {
  assert.match(canvasSource, /async function runImageNodeTool\(nodeOrId, operation, parameters = \{\}\)/)
  assert.match(canvasSource, /const previousUrl = String\(node\.data\?\.url \|\| ''\)/)
  assert.match(canvasSource, /assetId: node\.data\?\.savedAssetId/)
  assert.match(canvasSource, /sourceNodeId: String\(node\.id\)/)
  assert.match(canvasSource, /imageToolsAPI\.createOperation/)
  assert.match(canvasSource, /url: result\.resultUrl/)
  assert.match(canvasSource, /savedAssetId: String\(result\.resultAssetId/)
  assert.match(canvasSource, /imageToolHistory:/)
  assert.match(canvasSource, /url: previousUrl,[\s\S]*imageToolStatus: 'failed'/)
  assert.match(canvasSource, /imageToolRetryOperation: operation/)
  assert.match(canvasSource, /imageToolRetryParameters: parameters/)
  assert.match(toolbarSource, /data\.imageToolError/)
  assert.match(toolbarSource, /retryLastOperation/)
  assert.match(canvasSource, /runImageNodeTool,\s*\n/)
})

test('P1 图片调整包含色温，旋转走 Sharp 派生链，导演台未桥接当前图片时保持禁用', () => {
  assert.match(toolbarSource, /adjustForm = ref\(\{[^}]*temperature: 0/)
  assert.match(toolbarSource, /色温/)
  assert.match(toolbarSource, /\{ label: '旋转', operation: 'rotate' \}/)
  assert.match(toolbarSource, /\{ label: '生成导演台', operation: 'director_stage' \}/)
  assert.doesNotMatch(toolbarSource, /customAction: 'director'/)
})

test('工具栏提供替换、下载、全屏、历史与标记色入口', () => {
  assert.match(toolbarSource, /replaceInput/)
  assert.match(toolbarSource, /ctx\?\.replaceFreeCanvasNodeImage/)
  assert.match(toolbarSource, /downloadImage/)
  assert.match(toolbarSource, /downloadExtension\(/)
  assert.match(toolbarSource, /requestFullscreen/)
  assert.match(toolbarSource, /imageToolHistory/)
  assert.match(toolbarSource, /ctx\?\.setFreeCanvasNodeMarker/)
  assert.match(nodeSource, /--image-node-marker/)
  assert.match(nodeSource, /var\(--image-node-marker/)
})
