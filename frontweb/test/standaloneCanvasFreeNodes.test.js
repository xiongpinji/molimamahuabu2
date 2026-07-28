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

test('图片工具状态、历史、标记色和多结果随自由节点持久化', () => {
  const node = {
    id: 'free:image:tool-state',
    type: 'homeCanvasNode',
    position: { x: 12, y: 34 },
    data: {
      kind: 'image',
      title: '图片工具状态',
      content: '',
      url: '/static/derived/result.webp',
      imageMarkerColor: '#34d399',
      imageToolTaskId: 'task-1',
      imageToolStatus: 'success',
      imageToolError: '',
      imageToolRetryOperation: 'adjust',
      imageToolRetryParameters: {
        brightness: 1.2,
        saturation: 0.8,
        contrast: 1.1,
        temperature: 0.4,
      },
      imageToolHistory: [{
        taskId: 'task-1',
        operation: 'grid_crop',
        status: 'success',
        resultAssetId: 42,
        resultUrl: '/static/derived/result.webp',
        createdAt: '2026-07-28T12:00:00.000Z',
      }],
      imageToolResultAssets: [
        { id: 42, url: '/static/derived/result.webp' },
        { id: 43, url: '/static/derived/result-2.webp' },
      ],
    },
  }

  const layout = buildCanvasLayoutPayload(
    [node],
    { x: 0, y: 0, zoom: 1 },
    null,
    [],
    { persistFreeNodes: true },
  )
  const restored = resolveFreeCanvasNodes(layout)[0]

  assert.equal(restored.data.imageMarkerColor, '#34d399')
  assert.equal(restored.data.imageToolTaskId, 'task-1')
  assert.equal(restored.data.imageToolStatus, 'success')
  assert.equal(restored.data.imageToolRetryOperation, 'adjust')
  assert.deepEqual(restored.data.imageToolRetryParameters, node.data.imageToolRetryParameters)
  assert.deepEqual(restored.data.imageToolHistory, node.data.imageToolHistory)
  assert.deepEqual(restored.data.imageToolResultAssets, node.data.imageToolResultAssets)
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
