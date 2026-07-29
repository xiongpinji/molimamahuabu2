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
  assert.match(toolbarSource, /:global\(\.home-canvas-node:hover \.image-node-toolbar\)/)
  assert.match(toolbarSource, /:global\(\.vue-flow__node\.selected \.image-node-toolbar\)/)
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

test('细节纹理增强只提交三档预设并声明保持原尺寸', () => {
  assert.match(toolbarSource, /detailEnhancePreset = ref\('balanced'\)/)
  assert.match(toolbarSource, /editorOperation === 'detail_enhance'/)
  assert.match(toolbarSource, /<el-option label="自然" value="natural" \/>/)
  assert.match(toolbarSource, /<el-option label="标准" value="balanced" \/>/)
  assert.match(toolbarSource, /<el-option label="强烈" value="strong" \/>/)
  assert.match(
    toolbarSource,
    /editorOperation\.value === 'detail_enhance'\) return \{ preset: detailEnhancePreset\.value \}/,
  )
  assert.match(toolbarSource, /2x 超分取样后回落到原尺寸/)
  assert.match(toolbarSource, /detail_enhance: '细节纹理增强'/)
})

test('扩图入口提交目标画幅、扩展方向和用户补充描述', () => {
  assert.match(toolbarSource, /editorOperation === 'outpaint'/)
  assert.match(toolbarSource, /outpaintForm = ref\(\{[\s\S]*aspectRatio: '16:9'/)
  assert.match(toolbarSource, /direction: 'auto'/)
  assert.match(toolbarSource, /<el-option label="横屏 16:9" value="16:9" \/>/)
  assert.match(toolbarSource, /<el-option label="向右扩展" value="right" \/>/)
  assert.match(toolbarSource, /v-model="outpaintForm\.prompt"/)
  assert.match(
    toolbarSource,
    /editorOperation\.value === 'outpaint'\) return \{ \.\.\.outpaintForm\.value \}/,
  )
  assert.match(toolbarSource, /参考图供应商生成新素材；原图保持不变/)
  assert.match(toolbarSource, /outpaint: '扩图'/)
})

test('标记修图采集受限笔迹与指令并提交真实参考图编辑操作', () => {
  assert.match(toolbarSource, /editorOperation === 'markup_retouch'/)
  assert.match(toolbarSource, /class="markup-stage"/)
  assert.match(toolbarSource, /ref="markupSurface"/)
  assert.match(toolbarSource, /@pointerdown="beginMarkupStroke"/)
  assert.match(toolbarSource, /@pointermove="extendMarkupStroke"/)
  assert.match(toolbarSource, /@pointerup="finishMarkupStroke"/)
  assert.match(toolbarSource, /v-for="\(stroke, index\) in markupStrokes"/)
  assert.match(toolbarSource, /v-model="markupInstruction"/)
  assert.match(toolbarSource, /undoMarkupStroke/)
  assert.match(toolbarSource, /clearMarkupStrokes/)
  assert.match(toolbarSource, /const MARKUP_MAX_STROKES = 16/)
  assert.match(toolbarSource, /const MARKUP_MAX_POINTS = 128/)
  assert.match(toolbarSource, /activeMarkupStroke = markupStrokes\.value\[markupStrokes\.value\.length - 1\]/)
  assert.match(toolbarSource, /editorOperation\.value === 'markup_retouch'/)
  assert.match(toolbarSource, /instruction: markupInstruction\.value\.trim\(\)/)
  assert.match(toolbarSource, /strokes: markupStrokes\.value\.map/)
  assert.match(toolbarSource, /markup_retouch: '标记修图'/)
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

test('P1 图片调整包含色温，旋转走 Sharp 派生链', () => {
  assert.match(toolbarSource, /adjustForm = ref\(\{[^}]*temperature: 0/)
  assert.match(toolbarSource, /色温/)
  assert.match(toolbarSource, /\{ label: '旋转', operation: 'rotate' \}/)
})

test('生成导演台、灯光、角度和姿势入口桥接当前图片且不冒充模型图片处理', () => {
  assert.match(toolbarSource, /\{ label: '生成导演台', operation: 'director_stage' \}/)
  assert.match(toolbarSource, /const DIRECTOR_STAGE_OPERATIONS = new Set\(\['director_stage', 'lighting', 'angle', 'pose'\]\)/)
  assert.match(toolbarSource, /ctx\?\.openDirectorStage\?\.\(\{[\s\S]*mode: item\.operation/)
  assert.match(toolbarSource, /imageUrl: props\.data\.url/)
  assert.match(toolbarSource, /sourceNodeId: props\.nodeId/)
  assert.match(canvasSource, /const directorStageEntry = ref\(null\)/)
  assert.match(canvasSource, /:entry-context="directorStageEntry"/)
  assert.match(canvasSource, /function openDirectorStage\(entryContext = null\)/)
  assert.match(canvasSource, /directorStageEntry\.value = DIRECTOR_STAGE_ENTRY_MODES\.has\(entryContext\?\.mode\)/)
  assert.doesNotMatch(toolbarSource, /DIRECTOR_STAGE_OPERATIONS = new Set\(\[[^\]]*(?:cinematic_relight|angle_ideation)/)
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
