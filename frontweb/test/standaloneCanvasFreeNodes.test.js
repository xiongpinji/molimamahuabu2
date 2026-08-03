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

test('视频工具任务状态、失败重试和派生节点血缘随自由节点持久化', () => {
  const sourceNode = {
    id: 'free:video:source',
    type: 'homeCanvasNode',
    position: { x: 20, y: 40 },
    data: {
      kind: 'video',
      title: '源视频',
      content: '',
      url: '/static/source.mp4',
      videoToolTaskId: 'video-tool-task-1',
      videoToolStatus: 'failed',
      videoToolError: '裁剪失败',
      videoToolRetryOperation: 'crop',
      videoToolRetryParameters: {
        x: 0,
        y: 0,
        width: 160,
        height: 90,
        command: 'never-persist-this',
      },
      videoToolHistory: [{
        taskId: 'video-tool-task-1',
        operation: 'crop',
        status: 'failed',
        resultAssetId: 9,
        resultUrl: '/static/derived/crop.mp4',
        createdAt: '2026-08-01T00:00:00.000Z',
      }],
    },
  }
  const derivedNode = {
    id: 'free:video:derived',
    type: 'homeCanvasNode',
    position: { x: 720, y: 40 },
    data: {
      kind: 'video',
      title: '裁剪结果',
      content: '',
      url: '/static/derived/crop.mp4',
      sourceVideoToolNodeId: sourceNode.id,
      videoToolOperation: 'crop',
      videoToolTaskId: 'video-tool-task-1',
      videoToolStatus: 'success',
    },
  }
  const storyNode = {
    id: 'free:text:video-story',
    type: 'homeCanvasNode',
    position: { x: 720, y: 420 },
    data: {
      kind: 'text',
      title: '视频故事',
      content: '结构化解析结果',
      sourceVideoToolNodeId: sourceNode.id,
      videoToolOperation: 'analyze',
      videoToolTaskId: 'video-tool-task-2',
      videoStory: {
        width: 160,
        height: 90,
        duration: 1.4,
        hasAudio: true,
        fps: 24,
        sceneThreshold: 0.35,
        shots: [{
          index: 1,
          startTime: 0,
          endTime: 0.7,
          duration: 0.7,
          keyframeAssetId: 10,
          keyframeUrl: '/static/derived/frame-1.jpg',
        }],
      },
    },
  }

  const layout = buildCanvasLayoutPayload(
    [sourceNode, derivedNode, storyNode],
    { x: 0, y: 0, zoom: 1 },
    null,
    [],
    { persistFreeNodes: true },
  )
  const [restoredSource, restoredDerived, restoredStory] = resolveFreeCanvasNodes(layout)

  assert.equal(restoredSource.data.videoToolTaskId, 'video-tool-task-1')
  assert.equal(restoredSource.data.videoToolStatus, 'failed')
  assert.equal(restoredSource.data.videoToolError, '裁剪失败')
  assert.equal(restoredSource.data.videoToolRetryOperation, 'crop')
  assert.deepEqual(restoredSource.data.videoToolRetryParameters, {
    x: 0,
    y: 0,
    width: 160,
    height: 90,
  })
  assert.deepEqual(restoredSource.data.videoToolHistory, sourceNode.data.videoToolHistory)
  assert.equal(restoredDerived.data.sourceVideoToolNodeId, sourceNode.id)
  assert.equal(restoredDerived.data.videoToolOperation, 'crop')
  assert.equal(restoredDerived.data.videoToolTaskId, 'video-tool-task-1')
  assert.deepEqual(restoredStory.data.videoStory, storyNode.data.videoStory)
})

test('智能抠图失败重试操作随自由节点持久化且不接受额外参数', () => {
  const node = {
    id: 'free:image:smart-cutout-retry',
    type: 'homeCanvasNode',
    position: { x: 12, y: 34 },
    data: {
      kind: 'image',
      title: '智能抠图失败',
      content: '',
      url: '/static/source.png',
      imageToolStatus: 'failed',
      imageToolError: '智能抠图处理失败，请检查本地引擎配置',
      imageToolRetryOperation: 'smart_cutout',
      imageToolRetryParameters: { command: 'never-persist-this' },
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

  assert.equal(restored.data.imageToolStatus, 'failed')
  assert.equal(restored.data.imageToolRetryOperation, 'smart_cutout')
  assert.deepEqual(restored.data.imageToolRetryParameters, {})
})

test('框选抠图重试只持久化矩形像素参数', () => {
  const node = {
    id: 'free:image:selection-cutout-retry',
    type: 'homeCanvasNode',
    position: { x: 12, y: 34 },
    data: {
      kind: 'image',
      title: '框选抠图失败',
      content: '',
      url: '/static/source.png',
      imageToolStatus: 'failed',
      imageToolRetryOperation: 'selection_cutout',
      imageToolRetryParameters: {
        left: 2,
        top: 3,
        width: 120,
        height: 80,
        command: 'never-persist-this',
      },
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

  assert.equal(restored.data.imageToolRetryOperation, 'selection_cutout')
  assert.deepEqual(restored.data.imageToolRetryParameters, {
    left: 2,
    top: 3,
    width: 120,
    height: 80,
  })
})

test('高清增强重试只持久化倍率参数', () => {
  const node = {
    id: 'free:image:upscale-retry',
    type: 'homeCanvasNode',
    position: { x: 12, y: 34 },
    data: {
      kind: 'image',
      title: '高清增强失败',
      content: '',
      url: '/static/source.png',
      imageToolStatus: 'failed',
      imageToolRetryOperation: 'upscale',
      imageToolRetryParameters: {
        scale: 3,
        command: 'never-persist-this',
        modelDir: 'never-persist-this',
      },
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

  assert.equal(restored.data.imageToolRetryOperation, 'upscale')
  assert.deepEqual(restored.data.imageToolRetryParameters, { scale: 3 })
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
