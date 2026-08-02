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

test('工具栏自动避开顶部导航且编辑器使用沉浸式工作区', () => {
  assert.match(toolbarSource, /toolbarPlacement = ref\('above'\)/)
  assert.match(toolbarSource, /updateToolbarPlacement/)
  assert.match(toolbarSource, /getBoundingClientRect\(\)/)
  assert.match(toolbarSource, /:class="\{ 'place-below': toolbarPlacement === 'below' \}"/)
  assert.match(toolbarSource, /class="image-tool-dialog immersive"/)
  assert.match(toolbarSource, /width="calc\(100vw - 32px\)"/)
  assert.match(toolbarSource, /height: calc\(100vh - 32px\)/)
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
  assert.match(toolbarSource, /轻量服务器优先使用远程模型/)
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
  assert.match(toolbarSource, /改善纹理并保持原尺寸/)
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
  assert.match(toolbarSource, /选择\/移动/)
  assert.match(toolbarSource, /马赛克/)
  assert.match(toolbarSource, /数字标记/)
  assert.match(toolbarSource, /文本/)
  assert.match(toolbarSource, /class="markup-layers"/)
  assert.match(toolbarSource, /toggleMarkupLayer/)
  assert.match(toolbarSource, /removeMarkupLayer/)
  assert.match(toolbarSource, /标记工具教程/)
  assert.match(toolbarSource, /submitOperation\('markup_only'\)/)
  assert.match(toolbarSource, /const MARKUP_MAX_STROKES = 16/)
  assert.match(toolbarSource, /const MARKUP_MAX_POINTS = 128/)
  assert.match(toolbarSource, /activeMarkupStroke = markupStrokes\.value\[markupStrokes\.value\.length - 1\]/)
  assert.match(toolbarSource, /editorOperation\.value === 'markup_retouch'/)
  assert.match(toolbarSource, /const instruction = markupInstruction\.value\.trim\(\)/)
  assert.match(toolbarSource, /instruction,\s*\n/)
  assert.match(toolbarSource, /const visibleStrokes = markupStrokes\.value\.filter/)
  assert.match(toolbarSource, /strokes: visibleStrokes\.map/)
  assert.match(toolbarSource, /markup_retouch: '标记修图'/)
})

test('电影级光影校正提交受控预设、强度和补充要求并生成同尺寸新素材', () => {
  assert.match(toolbarSource, /editorOperation === 'cinematic_relight'/)
  assert.match(toolbarSource, /relightForm = ref\(\{[\s\S]*preset: 'cinematic'/)
  assert.match(toolbarSource, /intensity: 3/)
  assert.match(toolbarSource, /description: ''/)
  assert.match(toolbarSource, /<el-option label="电影感" value="cinematic" \/>/)
  assert.match(toolbarSource, /<el-option label="黄金时刻" value="golden_hour" \/>/)
  assert.match(toolbarSource, /<el-option label="月夜" value="moonlight" \/>/)
  assert.match(toolbarSource, /<el-option label="影棚柔光" value="studio_soft" \/>/)
  assert.match(toolbarSource, /<el-option label="高反差" value="high_contrast" \/>/)
  assert.match(toolbarSource, /v-model="relightForm\.intensity"/)
  assert.match(toolbarSource, /:min="1" :max="5"/)
  assert.match(toolbarSource, /v-model="relightForm\.description"/)
  assert.match(toolbarSource, /maxlength="300"/)
  assert.match(
    toolbarSource,
    /editorOperation\.value === 'cinematic_relight'\) return \{[\s\S]*description: relightForm\.value\.description\.trim\(\)/,
  )
  assert.match(toolbarSource, /参考图供应商生成同尺寸新素材；原图保持不变/)
  assert.match(toolbarSource, /cinematic_relight: '电影级光影校正'/)
})

test('全景入口提交受限描述并明确生成固定 2:1 等距柱状新素材', () => {
  assert.match(toolbarSource, /\{ label: '720全景', operation: 'panorama', icon: \w+ \}/)
  assert.match(toolbarSource, /\{ label: '生成全景场景', operation: 'panorama_scene', icon: \w+ \}/)
  assert.match(toolbarSource, /\['panorama', 'panorama_scene'\]\.includes\(editorOperation\)/)
  assert.match(toolbarSource, /panoramaDescription = ref\(''\)/)
  assert.match(toolbarSource, /v-model="panoramaDescription"/)
  assert.match(toolbarSource, /maxlength="300"/)
  assert.match(
    toolbarSource,
    /\['panorama', 'panorama_scene'\]\.includes\(editorOperation\.value\)[\s\S]*description: panoramaDescription\.value\.trim\(\)/,
  )
  assert.match(toolbarSource, /固定输出 3840×1920 PNG/)
  assert.match(toolbarSource, /panorama: '720全景'/)
  assert.match(toolbarSource, /panorama_scene: '生成全景场景'/)
})

test('参考图生成与推演入口提交 300 字以内的补充要求并显示真实输出约束', () => {
  assert.match(toolbarSource, /\{ label: '画面联想', operation: 'image_ideation', icon: \w+ \}/)
  assert.match(toolbarSource, /REFERENCE_VARIATION_OPERATIONS\.includes\(editorOperation\)/)
  assert.match(toolbarSource, /referenceVariationDescription = ref\(''\)/)
  assert.match(toolbarSource, /v-model="referenceVariationDescription"/)
  assert.match(toolbarSource, /maxlength="300"/)
  assert.match(
    toolbarSource,
    /REFERENCE_VARIATION_OPERATIONS\.includes\(editorOperation\.value\)[\s\S]*description: referenceVariationDescription\.value\.trim\(\)/,
  )
  assert.match(toolbarSource, /三视图固定 2048×1536，九宫格固定 3072×3072/)
  for (const [operation, label] of [
    ['image_ideation', '画面联想'],
    ['angle_ideation', '角度联想'],
    ['character_views', '角色三视图'],
    ['narrative_grid', '多机位叙事九宫格'],
    ['frame_forward', '画面推演-3秒后'],
    ['frame_backward', '画面推演-5秒前'],
  ]) {
    assert.match(toolbarSource, new RegExp(`${operation}: '${label}'`))
  }
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
  assert.match(toolbarSource, /selectionMode = ref\('rectangle'\)/)
  assert.match(toolbarSource, /selectionBrushStrokes = ref\(\[\]\)/)
  assert.match(toolbarSource, /selectionMode: 'brush'/)
  assert.match(toolbarSource, /brushStrokes: selectionBrushStrokes\.value/)
})

test('执行图片工具成功后保留原图并新建结果节点，失败保留旧图并写回错误', () => {
  assert.match(canvasSource, /async function runImageNodeTool\(nodeOrId, operation, parameters = \{\}\)/)
  assert.doesNotMatch(canvasSource, /if \(!isStandaloneCanvas\.value \|\| node\?\.type !== 'homeCanvasNode' \|\| node\.data\?\.kind !== 'image'\)/)
  assert.match(canvasSource, /const previousUrl = String\(node\.data\?\.url \|\| ''\)/)
  assert.match(canvasSource, /assetId: node\.data\?\.savedAssetId/)
  assert.match(canvasSource, /sourceNodeId: String\(node\.id\)/)
  assert.match(canvasSource, /imageToolsAPI\.createOperation/)
  assert.match(canvasSource, /imageToolsAPI\.getOperation\(taskId\)/)
  assert.match(canvasSource, /accepted\?\.status === 'processing'/)
  assert.match(canvasSource, /parseImageToolTaskResult\(task\)/)
  assert.match(canvasSource, /resumePendingImageToolOperations/)
  assert.match(canvasSource, /await createFreeCanvasNode\('image'/)
  assert.match(canvasSource, /sourceImageToolNodeId: String\(sourceNode\.id\)/)
  assert.match(canvasSource, /url: asset\.url/)
  assert.match(canvasSource, /savedAssetId: String\(asset\.id\)/)
  assert.doesNotMatch(canvasSource, /patchFreeCanvasNodeData\(nodeId,\s*\{\s*url: result\.resultUrl/)
  assert.match(canvasSource, /imageToolHistory:/)
  assert.match(canvasSource, /url: previousUrl,[\s\S]*imageToolStatus: 'failed'/)
  assert.match(canvasSource, /imageToolRetryOperation: operation/)
  assert.match(canvasSource, /imageToolRetryParameters: parameters/)
  assert.match(toolbarSource, /data\.imageToolError/)
  assert.match(toolbarSource, /retryLastOperation/)
  assert.match(canvasSource, /runImageNodeTool,\s*\n/)
})

test('P1 图片调整覆盖完整参数，LUT 支持强度，旋转走 Sharp 派生链', () => {
  assert.match(toolbarSource, /const DEFAULT_ADJUST_FORM = Object\.freeze\(\{[\s\S]*temperature: 0/)
  assert.match(toolbarSource, /adjustForm = ref\(\{ \.\.\.DEFAULT_ADJUST_FORM \}\)/)
  for (const parameter of [
    'exposure',
    'brightness',
    'contrast',
    'highlights',
    'shadows',
    'whites',
    'blacks',
    'vibrance',
    'saturation',
    'temperature',
    'tint',
    'hue',
    'sharpness',
    'clarity',
    'grain',
    'blur',
    'vignette',
    'softLight',
    'glow',
  ]) {
    assert.match(toolbarSource, new RegExp(`${parameter}:`))
  }
  assert.match(toolbarSource, /色温/)
  assert.match(toolbarSource, /RGB 曲线/)
  assert.match(toolbarSource, /curveChannel = ref\('rgb'\)/)
  assert.match(toolbarSource, /function addCurvePoint\(channel\)/)
  assert.match(toolbarSource, /function removeCurvePoint\(channel, index\)/)
  assert.match(toolbarSource, /curves: adjustCurves\.value/)
  assert.match(toolbarSource, /\{ name: '青橙'/)
  assert.match(toolbarSource, /\{ name: '黑色电影'/)
  assert.match(toolbarSource, /lutIntensity = ref\(1\)/)
  assert.match(toolbarSource, /intensity: lutIntensity\.value/)
  assert.match(toolbarSource, /上传 3D LUT/)
  assert.match(toolbarSource, /async function loadCubeLut/)
  assert.match(toolbarSource, /LUT_3D_SIZE/)
  assert.match(toolbarSource, /preset: lutPreset\.value/)
  assert.match(toolbarSource, /customLut: customLut\.value/)
  assert.match(toolbarSource, /lutCategory = ref\('recommended'\)/)
  assert.match(toolbarSource, /value: 'teal_orange'/)
  assert.match(toolbarSource, /value: 'film_fade'/)
  assert.match(toolbarSource, /LUT 手动微调/)
  assert.match(toolbarSource, /manual: \{ \.\.\.lutManualForm\.value \}/)
  assert.match(toolbarSource, /全景镜头扩张/)
  assert.match(toolbarSource, /背景重构/)
  assert.match(toolbarSource, /氛围重塑/)
  assert.match(toolbarSource, /\{ label: '旋转', operation: 'rotate' \}/)
})

test('生成导演台、灯光、角度和姿势入口桥接当前图片且不冒充模型图片处理', () => {
  assert.match(toolbarSource, /\{ label: '生成导演台', operation: 'director_stage', icon: \w+ \}/)
  assert.match(toolbarSource, /const DIRECTOR_STAGE_OPERATIONS = new Set\(\['director_stage', 'lighting', 'angle', 'pose'\]\)/)
  assert.match(toolbarSource, /ctx\?\.openDirectorStage\?\.\(\{[\s\S]*mode: item\.operation/)
  assert.match(toolbarSource, /imageUrl: props\.data\.url/)
  assert.match(toolbarSource, /sourceNodeId: props\.nodeId/)
  assert.match(canvasSource, /const directorStageEntry = ref\(null\)/)
  assert.match(canvasSource, /:entry-context="directorStageEntry"/)
  assert.match(canvasSource, /function openDirectorStage\(entryContext = null\)/)
  assert.match(canvasSource, /directorStageEntry\.value = DIRECTOR_STAGE_ENTRY_MODES\.has\(resolvedEntry\?\.mode\)/)
  assert.doesNotMatch(toolbarSource, /DIRECTOR_STAGE_OPERATIONS = new Set\(\[[^\]]*(?:cinematic_relight|angle_ideation)/)
})

test('工具栏提供替换、下载、全屏、历史与标记色入口', () => {
  assert.match(toolbarSource, /replaceInput/)
  assert.match(toolbarSource, /ctx\?\.replaceFreeCanvasNodeImage/)
  assert.match(canvasSource, /async function replaceFreeCanvasNodeImage\(nodeOrId, file\)/)
  assert.doesNotMatch(canvasSource, /该节点不是可替换的独立画布图片节点/)
  assert.match(toolbarSource, /downloadImage/)
  assert.match(toolbarSource, /downloadExtension\(/)
  assert.match(toolbarSource, /requestFullscreen/)
  assert.match(toolbarSource, /imageToolHistory/)
  assert.match(toolbarSource, /ctx\?\.setFreeCanvasNodeMarker/)
  assert.match(nodeSource, /--image-node-marker/)
  assert.match(nodeSource, /var\(--image-node-marker/)
})

test('宫格裁剪只提交用户选中的格子且保留全选与取消入口', () => {
  assert.match(toolbarSource, /gridSelectedCells = ref\(\[\]\)/)
  assert.match(toolbarSource, /const gridCells = computed/)
  assert.match(toolbarSource, /toggleGridCell\(cell\.key\)/)
  assert.match(toolbarSource, /selectAllGridCells/)
  assert.match(toolbarSource, /gridSelectedCells = \[\]/)
  assert.match(toolbarSource, /selectedCells: \[\.\.\.gridSelectedCells\.value\]/)
})

test('宫格裁剪提供 2x2 至 7x7、间距、反选、复制、识别和吸附控制', () => {
  assert.match(toolbarSource, /v-for="size in gridQuickSizes"/)
  assert.match(toolbarSource, /const gridQuickSizes = Object\.freeze\(\[2, 3, 4, 5, 6, 7\]\)/)
  assert.match(toolbarSource, /gridForm = ref\(\{ rows: 3, columns: 3, spacing: 0 \}\)/)
  assert.match(toolbarSource, /v-model="gridForm\.spacing"/)
  assert.match(toolbarSource, /invertGridSelection/)
  assert.match(toolbarSource, /duplicateGridSelection/)
  assert.match(toolbarSource, /redetectGrid/)
  assert.match(toolbarSource, /gridSnapEnabled/)
  assert.match(toolbarSource, /spacing: gridForm\.value\.spacing/)
})
