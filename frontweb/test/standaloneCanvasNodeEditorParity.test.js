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

test('独立画布节点编辑器固定在视口并支持全屏和关闭', () => {
  assert.match(nodeSource, /<Teleport to="body">/)
  assert.match(nodeSource, /class="node-expanded-editor/)
  assert.match(nodeSource, /position:\s*fixed/)
  assert.match(nodeSource, /aria-label="全屏编辑"/)
  assert.match(nodeSource, /aria-label="关闭编辑器"/)
  assert.match(nodeSource, /window\.addEventListener\('keydown', onEditorKeydown\)/)
  assert.match(nodeSource, /event\.key !== 'Escape'/)
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
