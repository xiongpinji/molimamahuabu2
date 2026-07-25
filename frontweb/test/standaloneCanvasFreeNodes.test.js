import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildCanvasLayoutPayload,
  resolveFreeCanvasNodes,
} from '../src/utils/canvasLayout.js'

const dramaCanvasSource = readFileSync(
  fileURLToPath(new URL('../src/views/DramaCanvas.vue', import.meta.url)),
  'utf8'
)
const contextMenuSource = readFileSync(
  fileURLToPath(new URL('../src/components/dramaCanvas/CanvasContextMenu.vue', import.meta.url)),
  'utf8'
)
const toolbarSource = readFileSync(
  fileURLToPath(new URL('../src/components/dramaCanvas/CanvasFloatingToolbar.vue', import.meta.url)),
  'utf8'
)
const filmListSource = readFileSync(
  fileURLToPath(new URL('../src/views/FilmList.vue', import.meta.url)),
  'utf8'
)
const adapterSource = readFileSync(
  fileURLToPath(new URL('../src/utils/dramaCanvasAdapter.js', import.meta.url)),
  'utf8'
)

test('自由节点写入 canvas_layout 并可恢复', () => {
  const node = {
    id: 'free:image:1',
    type: 'homeCanvasNode',
    position: { x: 120, y: 240 },
    data: {
      kind: 'image',
      title: '雨夜街道',
      content: '生成一张电影感雨夜街道',
      url: '',
    },
  }
  const layout = buildCanvasLayoutPayload(
    [node],
    { x: 4, y: 8, zoom: 1 },
    null,
    [],
    { persistFreeNodes: true }
  )

  assert.deepEqual(resolveFreeCanvasNodes(layout), [node])
})

test('独立画布图谱不生成剧集骨架且保留自由节点和连线', () => {
  assert.match(adapterSource, /function buildStandaloneCanvasGraph\(savedLayout, projectAssets = \[\]\)/)
  assert.match(adapterSource, /resolveFreeCanvasNodes\(savedLayout\)/)
  assert.match(adapterSource, /appendManualEdges\(edges, savedLayout, nodes\)/)
  assert.match(adapterSource, /if \(options\.standalone\) \{[\s\S]*return buildStandaloneCanvasGraph\(savedLayout, options\.projectAssets\)/)
})

test('独立画布菜单用配置节点替代图片视频直接上传', () => {
  assert.match(contextMenuSource, /standalone/)
  assert.match(contextMenuSource, /type: 'text'[\s\S]*label: '文本'/)
  assert.match(contextMenuSource, /type: 'image'[\s\S]*label: '图片'/)
  assert.match(contextMenuSource, /type: 'video'[\s\S]*label: '视频'/)
  assert.match(contextMenuSource, /type: 'audio'[\s\S]*label: '音频'/)
  assert.match(toolbarSource, /standalone/)
  assert.match(toolbarSource, /type: 'text'/)
  assert.match(dramaCanvasSource, /openFreeNodeDialog/)
  assert.match(dramaCanvasSource, /freeNodeDialogVisible/)
  assert.match(dramaCanvasSource, /if \(isStandaloneCanvas\.value && FREE_NODE_KINDS\.has\(type\)\)/)
  assert.match(dramaCanvasSource, /const saved = await persistCanvasState\(\{ layoutOnly: true \}\)[\s\S]*if \(saved\) ElMessage\.success/)
})

test('画布项目创建界面在独立模式只要求项目名称', () => {
  assert.match(filmListSource, /v-if="!isCanvasMode" label="描述"/)
  assert.match(filmListSource, /v-if="!isCanvasMode" label="画面比例"/)
  assert.match(filmListSource, /description: isCanvasMode\.value/)
  assert.match(filmListSource, /<el-option label="未分类" value="" \/>/)
  assert.match(filmListSource, /folder_id: newForm\.value\.folder_id === '' \? null : newForm\.value\.folder_id/)
})
