import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const nodeSource = readFileSync(
  fileURLToPath(new URL('../src/components/dramaCanvas/HomeCanvasNode.vue', import.meta.url)),
  'utf8'
)
const localCanvasSource = readFileSync(
  fileURLToPath(new URL('../src/views/HomeCanvas.vue', import.meta.url)),
  'utf8'
)
const imageToolbarSource = readFileSync(
  fileURLToPath(new URL('../src/components/dramaCanvas/ImageNodeToolbar.vue', import.meta.url)),
  'utf8'
)
const edgeSource = readFileSync(
  fileURLToPath(new URL('../src/components/dramaCanvas/LibTvCanvasEdge.vue', import.meta.url)),
  'utf8'
)
const dramaCanvasSource = readFileSync(
  fileURLToPath(new URL('../src/views/DramaCanvas.vue', import.meta.url)),
  'utf8'
)

test('独立画布节点编辑器挂载到视口并持续锚定节点', () => {
  assert.match(nodeSource, /<Teleport to="body">/)
  assert.doesNotMatch(nodeSource, /:disabled="!editorFullscreen"/)
  assert.match(nodeSource, /class="node-expanded-editor/)
  assert.match(nodeSource, /\.node-expanded-editor\s*\{[\s\S]*position:\s*fixed/)
  assert.match(nodeSource, /\.node-expanded-editor\s*\{[\s\S]*z-index:\s*3100/)
  assert.match(nodeSource, /:style="editorFullscreen \? undefined : editorPanelStyle"/)
  assert.match(nodeSource, /:data-editor-dock="editorDock"/)
  assert.match(nodeSource, /requestAnimationFrame\(track\)/)
  assert.match(nodeSource, /\.node-expanded-editor\.is-fullscreen\s*\{[\s\S]*position:\s*fixed/)
  assert.match(nodeSource, /\.node-expanded-editor\.is-fullscreen \.prompt-input,[\s\S]*min-height:\s*min\(54vh,\s*640px\)/)
  assert.match(nodeSource, /aria-label="全屏编辑"/)
  assert.match(nodeSource, /aria-label="关闭编辑器"/)
  assert.match(nodeSource, /window\.addEventListener\('keydown', onEditorKeydown\)/)
  assert.match(nodeSource, /event\.key !== 'Escape'/)
})

test('已生成图片单击后重新聚焦节点并展开编辑器', () => {
  assert.match(nodeSource, /v-if="data\.kind === 'image' && primaryResultUrl"[\s\S]*@click\.stop="scheduleMediaOpen"/)
  assert.match(nodeSource, /function scheduleMediaOpen\(\)[\s\S]*openEditor\(\)/)
  assert.match(nodeSource, /function openEditor\(\) \{[\s\S]*editorHidden\.value = false[\s\S]*ctx\?\.setFocusedNode\?\.\(props\.id\)/)
  assert.match(localCanvasSource, /setFocusedNode:\s*selectNodeById/)
})

test('/canvas/local 单击节点即可展开同一套节点编辑器', () => {
  assert.match(localCanvasSource, /@node-click="onNodeClick"/)
  assert.match(localCanvasSource, /function onNodeClick\(\{ node \}\)/)
  assert.match(localCanvasSource, /selected: String\(item\.id\) === String\(nodeId\)/)
  assert.match(localCanvasSource, /isFreeCanvasNodeSelected:\s*\(nodeId\) =>/)
  assert.match(nodeSource, /class="text-preview"/)
  assert.match(nodeSource, /class="media-stage"/)
  assert.doesNotMatch(nodeSource, /class="text-preview nodrag nopan"/)
  assert.doesNotMatch(nodeSource, /class="media-stage nodrag nopan"/)
  assert.match(nodeSource, /const isSelected = computed/)
})

test('四类节点编辑器暴露 LibTV 核心参数且不隐藏在假配置按钮后', () => {
  assert.match(nodeSource, /aria-label="风格"/)
  assert.match(nodeSource, /aria-label="清晰度"/)
  assert.match(nodeSource, /aria-label="生成数量"/)
  assert.match(nodeSource, /aria-label="负面提示词"/)
  assert.match(nodeSource, /aria-label="视频运镜"/)
  assert.match(nodeSource, /aria-label="视觉特效"/)
  assert.match(nodeSource, /aria-label="生成音频"/)
  assert.match(nodeSource, /aria-label="音色"/)
  assert.match(nodeSource, /aria-label="语速"/)
  assert.match(nodeSource, /aria-label="插入停顿"/)
  assert.match(nodeSource, /aria-label="插入语气词"/)
  assert.match(nodeSource, /'AI 生成文本'/)
  assert.match(nodeSource, /aria-label="中英互译"/)
})

test('节点不展示小结果缩略条并保留下载、复制引用和重试闭环', () => {
  assert.doesNotMatch(nodeSource, /class="result-strip"/)
  assert.match(nodeSource, /aria-label="下载结果"/)
  assert.match(nodeSource, /aria-label="复制结果引用"/)
  assert.match(nodeSource, /data\.status === 'failed' \? '重试' : '生成'/)
})

test('LibTV 连线使用细贝塞尔底线和循环蓝色流光', () => {
  assert.match(edgeSource, /getBezierPath/)
  assert.match(edgeSource, /class="libtv-edge-glow"/)
  assert.match(edgeSource, /class="libtv-edge-hover-path"/)
  assert.match(edgeSource, /aria-label="剪断连线"/)
  assert.match(edgeSource, /detachFreeCanvasReference/)
  assert.match(edgeSource, /stroke-dasharray/)
  assert.match(edgeSource, /@keyframes libtv-edge-flow/)
})

test('参考图卡片不再显示用途、排序、权重和启用选项', () => {
  assert.doesNotMatch(nodeSource, /aria-label="参考图用途"/)
  assert.doesNotMatch(nodeSource, /class="reference-controls"/)
})

test('视频参考素材支持右键在描述光标处插入对应媒体引用', () => {
  assert.match(nodeSource, /normalizeFreeCanvasSubmissionReferences\(inputReferences\.value\)/)
  assert.match(nodeSource, /@contextmenu\.prevent\.stop="canInsertReferenceToken\(reference\) && insertReferenceToken\(reference\)"/)
  assert.match(nodeSource, /function referenceTypeLabel\(kind\)/)
  assert.match(nodeSource, /function referenceSubmissionOrdinal\(reference\)/)
  assert.match(nodeSource, /function canInsertReferenceToken\(reference\)/)
  assert.match(nodeSource, /function insertReferenceToken\(reference\)/)
  assert.match(nodeSource, /const ordinal = referenceSubmissionOrdinal\(reference\)[\s\S]*if \(ordinal < 1\) return/)
  assert.match(nodeSource, /const token = `@\$\{referenceTypeLabel\(reference\?\.kind\)\}\$\{ordinal\}`/)
  assert.match(nodeSource, /@select="rememberContentSelection"/)
})

test('节点配置弹窗显示在节点编辑器之上', () => {
  assert.match(dramaCanvasSource, /class="canvas-free-node-dialog"[\s\S]*:z-index="3400"/)
})

test('图片工具条和下拉菜单计入编辑器下边界且关闭操作取消延迟重开', () => {
  assert.match(nodeSource, /querySelectorAll\('\.image-node-toolbar, \.toolbar-menu, \.toolbar-history'\)/)
  assert.match(nodeSource, /anchorBounds\.left = Math\.min\(anchorBounds\.left, bounds\.left\)/)
  assert.match(nodeSource, /anchorBounds\.right = Math\.max\(anchorBounds\.right, bounds\.right\)/)
  assert.match(nodeSource, /anchorBounds\.top = Math\.min\(anchorBounds\.top, bounds\.top\)/)
  assert.match(nodeSource, /anchorBounds\.bottom = Math\.max\(anchorBounds\.bottom, bounds\.bottom\)/)
  assert.match(nodeSource, /const desiredTop = anchorBounds\.bottom \+ nodeGap/)
  assert.match(nodeSource, /const maximumViewportScale = Math\.max\(0\.01, Math\.min\(/)
  assert.match(nodeSource, /const anchorIntersectsViewport = anchorBounds\.right > viewportPadding/)
  assert.match(nodeSource, /const minimumUsableScale = 0\.3/)
  assert.match(nodeSource, /const canDockBelow = anchorIntersectsViewport[\s\S]*fitBelowScale >= minimumUsableScale/)
  assert.match(nodeSource, /const canDockBeside = anchorIntersectsViewport[\s\S]*sideScale >= minimumUsableScale/)
  assert.match(nodeSource, /const canDockAbove = anchorIntersectsViewport[\s\S]*fitAboveScale >= minimumUsableScale/)
  assert.match(nodeSource, /const preferredSide = availableRightWidth >= availableLeftWidth \? 'right' : 'left'/)
  assert.match(nodeSource, /const maximumTop = Math\.max\(viewportPadding, viewportHeight - scaledHeight - viewportPadding\)/)
  assert.match(nodeSource, /const hasUsableDock = canDockBelow \|\| canDockBeside \|\| canDockAbove/)
  assert.match(nodeSource, /visibility: hasUsableDock \? 'visible' : 'hidden'/)
  assert.doesNotMatch(nodeSource, /panCanvasForNodeEditor/)
  assert.doesNotMatch(localCanvasSource, /panCanvasForNodeEditor/)
  assert.doesNotMatch(dramaCanvasSource, /panCanvasForNodeEditor/)
  assert.match(nodeSource, /function closeEditor\(\) \{[\s\S]*window\.clearTimeout\(mediaOpenTimer\)/)
  assert.match(nodeSource, /@suspend-editor="closeEditor"/)
  assert.match(imageToolbarSource, /function openToolbarMenu\(menu\) \{[\s\S]*emit\('suspend-editor'\)/)
  assert.match(imageToolbarSource, /function selectOperation\(item\) \{[\s\S]*emit\('suspend-editor'\)/)
  assert.match(nodeSource, /function onEditorKeydown\(event\) \{[\s\S]*window\.clearTimeout\(mediaOpenTimer\)[\s\S]*if \(!isSelected\.value \|\| editorHidden\.value\) return/)
})

test('选中节点可从主体按住左键拖动且编辑器按视口等比适配', () => {
  assert.doesNotMatch(nodeSource, /class="node-drag-grip"/)
  assert.match(nodeSource, /\.home-canvas-node\.is-selected \.(text-preview|media-stage)/)
  assert.match(nodeSource, /const panelWidth = 860/)
  assert.match(nodeSource, /const maximumViewportScale = Math\.max\(0\.01, Math\.min\(/)
  assert.match(nodeSource, /transform: `scale\(\$\{editorScale\}\)`/)
  assert.match(nodeSource, /visibility: hasUsableDock \? 'visible' : 'hidden'/)
})

test('图片视频节点使用大画幅预览，运行中明确显示生成状态且画布支持高倍缩放', () => {
  assert.match(nodeSource, /\.home-canvas-node\.kind-image,[\s\S]*\.home-canvas-node\.kind-video[\s\S]*width:\s*640px/)
  assert.match(nodeSource, /\.kind-image \.node-media,[\s\S]*\.kind-video \.node-media[\s\S]*height:\s*360px/)
  assert.match(nodeSource, /props\.data\.status === 'running'[\s\S]*生成中/)
  assert.match(dramaCanvasSource, /:max-zoom="8"/)
  assert.match(dramaCanvasSource, /:zoom-on-scroll="canvasPreferences\.wheel_action === 'zoom'"/)
  assert.match(dramaCanvasSource, /zoom-activation-key-code="Control"/)
})

test('独立画布只读取用户可访问的模型目录，不请求管理员模型配置接口', () => {
  assert.match(dramaCanvasSource, /request\.get\('\/canvas\/model-catalog'\)/)
  assert.doesNotMatch(dramaCanvasSource, /aiAPI\.list\(/)
})
