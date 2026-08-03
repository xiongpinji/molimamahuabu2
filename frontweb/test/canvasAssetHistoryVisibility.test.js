import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const toolbarSource = readFileSync(
  new URL('../src/components/dramaCanvas/CanvasFloatingToolbar.vue', import.meta.url),
  'utf8',
)
const panelTemplateSource = readFileSync(
  new URL('../src/components/dramaCanvas/CanvasAssetHistoryPanel.vue', import.meta.url),
  'utf8',
)
const panelStyleSource = readFileSync(
  new URL('../src/components/dramaCanvas/CanvasAssetHistoryPanel.css', import.meta.url),
  'utf8',
)
const dramaCanvasSource = readFileSync(
  new URL('../src/views/DramaCanvas.vue', import.meta.url),
  'utf8',
)
const panelSource = `${panelTemplateSource}\n${panelStyleSource}`

test('项目画布与独立画布共用新版我的资产和生成历史入口', () => {
  assert.match(toolbarSource, /@click="toggleAssetPanel\('assets'\)"/)
  assert.match(toolbarSource, /@click="toggleAssetPanel\('history'\)"/)
  assert.doesNotMatch(
    toolbarSource,
    /v-if="!props\.standalone"[^>]+@click="toggleAssetPanel\('(assets|history)'\)"/,
  )
  assert.doesNotMatch(toolbarSource, /props\.standalone && activePanel === 'history'/)
  assert.doesNotMatch(toolbarSource, /props\.standalone \? '我的资产' : '素材库'/)
  assert.match(dramaCanvasSource, /import CanvasAssetHistoryPanel from/)
  assert.match(dramaCanvasSource, /<CanvasAssetHistoryPanel[\s\S]*v-if="assetHistoryPanel && drama"/)
  assert.match(dramaCanvasSource, /assetHistoryPanel,\s*[\r\n]+\s*canvasGridVisible/)
  assert.match(dramaCanvasSource, /toggleAssetHistoryPanel,\s*[\r\n]+\s*focusScript/)
})

test('资产库按目标截图使用全屏双行工作区和三步空状态', () => {
  assert.match(panelSource, /class="asset-primary-row"/)
  assert.match(panelSource, /class="asset-filter-row"/)
  assert.match(panelSource, />资产库</)
  assert.match(panelSource, /在工作流画布中右键点击节点，即可保存到素材库/)
  assert.match(panelSource, /在画布中找到图片、视频、音频或文本节点/)
  assert.match(panelSource, /右键点击节点 → 选择/)
  assert.match(panelSource, /设置名称和分类后即可在此查看和使用/)
  assert.match(panelSource, /\.mode-assets\s*\{[^}]*inset:\s*0/s)
})

test('生成历史按目标截图使用无标题单行工具栏、时间覆盖层和固定页脚', () => {
  assert.match(panelSource, /class="history-primary-row"/)
  assert.match(panelSource, /class="card-time"/)
  assert.match(panelSource, /class="history-footer"/)
  assert.match(panelSource, /共 \{\{ filteredItems\.length \}\} 项/)
  assert.match(panelSource, /每页/)
  assert.doesNotMatch(panelSource, /<h2>\{\{ mode === 'assets' \? '资产库' : '生成历史' \}\}<\/h2>/)
  assert.match(panelSource, /\.mode-history\s*\{[^}]*border-radius:\s*28px/s)
})

test('资产与历史浮层使用目标中性灰层级而非紫色主题', () => {
  assert.doesNotMatch(panelSource, /#6f7dff|111 125 255|98 112 255/i)
})
