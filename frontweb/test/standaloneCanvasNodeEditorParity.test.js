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
const edgeSource = readFileSync(
  fileURLToPath(new URL('../src/components/dramaCanvas/LibTvCanvasEdge.vue', import.meta.url)),
  'utf8'
)
const dramaCanvasSource = readFileSync(
  fileURLToPath(new URL('../src/views/DramaCanvas.vue', import.meta.url)),
  'utf8'
)

test('独立画布节点编辑器默认跟随节点并仅在全屏时挂载到视口', () => {
  assert.match(nodeSource, /<Teleport to="body" :disabled="!editorFullscreen">/)
  assert.match(nodeSource, /class="node-expanded-editor/)
  assert.match(nodeSource, /\.node-expanded-editor\s*\{[\s\S]*position:\s*absolute/)
  assert.match(nodeSource, /\.node-expanded-editor\s*\{[\s\S]*top:\s*calc\(100%\s*\+\s*18px\)/)
  assert.match(nodeSource, /\.node-expanded-editor\.is-fullscreen\s*\{[\s\S]*position:\s*fixed/)
  assert.match(nodeSource, /\.node-expanded-editor\.is-fullscreen \.prompt-input,[\s\S]*min-height:\s*min\(54vh,\s*640px\)/)
  assert.match(nodeSource, /aria-label="全屏编辑"/)
  assert.match(nodeSource, /aria-label="关闭编辑器"/)
  assert.match(nodeSource, /window\.addEventListener\('keydown', onEditorKeydown\)/)
  assert.match(nodeSource, /event\.key !== 'Escape'/)
})

test('已生成图片单击后重新聚焦节点并展开编辑器', () => {
  assert.match(nodeSource, /v-if="data\.kind === 'image' && primaryResultUrl"[\s\S]*@click="openEditor"/)
  assert.match(nodeSource, /function openEditor\(\) \{[\s\S]*editorHidden\.value = false[\s\S]*ctx\?\.setFocusedNode\?\.\(props\.id\)/)
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
  assert.match(nodeSource, /aria-label="镜头运动"/)
  assert.match(nodeSource, /aria-label="视觉特效"/)
  assert.match(nodeSource, /aria-label="生成音频"/)
  assert.match(nodeSource, /aria-label="音色"/)
  assert.match(nodeSource, /aria-label="语速"/)
  assert.match(nodeSource, /aria-label="插入停顿"/)
  assert.match(nodeSource, /aria-label="插入语气词"/)
  assert.match(nodeSource, /'AI 生成文本'/)
  assert.match(nodeSource, /aria-label="中英互译"/)
})

test('多结果可切换主结果并提供下载、复制引用和重试闭环', () => {
  assert.match(nodeSource, /class="result-strip"/)
  assert.match(nodeSource, /aria-label="设为当前结果"/)
  assert.match(nodeSource, /aria-label="下载结果"/)
  assert.match(nodeSource, /aria-label="复制结果引用"/)
  assert.match(nodeSource, /data\.status === 'failed' \? '重试' : '生成'/)
})

test('LibTV 连线使用细贝塞尔底线和循环蓝色流光', () => {
  assert.match(edgeSource, /getBezierPath/)
  assert.match(edgeSource, /class="libtv-edge-glow"/)
  assert.match(edgeSource, /stroke-dasharray/)
  assert.match(edgeSource, /@keyframes libtv-edge-flow/)
})

test('选中节点可从主体按住左键拖动且编辑器尺寸收紧', () => {
  assert.doesNotMatch(nodeSource, /class="node-drag-grip"/)
  assert.match(nodeSource, /\.home-canvas-node\.is-selected \.(text-preview|media-stage)/)
  assert.match(nodeSource, /width:\s*min\(860px/)
  assert.match(nodeSource, /max-height:\s*min\(58vh,\s*560px\)/)
})

test('图片视频节点使用大画幅预览，运行中明确显示生成状态且画布支持高倍缩放', () => {
  assert.match(nodeSource, /\.home-canvas-node\.kind-image,[\s\S]*\.home-canvas-node\.kind-video[\s\S]*width:\s*640px/)
  assert.match(nodeSource, /\.kind-image \.node-media,[\s\S]*\.kind-video \.node-media[\s\S]*height:\s*360px/)
  assert.match(nodeSource, /props\.data\.status === 'running'[\s\S]*生成中/)
  assert.match(dramaCanvasSource, /:max-zoom="8"/)
  assert.match(dramaCanvasSource, /:zoom-on-scroll="false"/)
  assert.match(dramaCanvasSource, /zoom-activation-key-code="Control"/)
})

test('独立画布只读取用户可访问的模型目录，不请求管理员模型配置接口', () => {
  assert.match(dramaCanvasSource, /request\.get\('\/canvas\/model-catalog'\)/)
  assert.doesNotMatch(dramaCanvasSource, /aiAPI\.list\(/)
})
