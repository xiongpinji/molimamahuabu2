import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  const filePath = path.join(root, relativePath)
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
}

test('已生成视频节点挂载真实视频工具栏', () => {
  const nodeSource = read('src/components/dramaCanvas/HomeCanvasNode.vue')
  const toolbarPath = path.join(root, 'src/components/dramaCanvas/VideoNodeToolbar.vue')

  assert.equal(fs.existsSync(toolbarPath), true, '应实现独立视频工具栏组件')
  assert.match(nodeSource, /<VideoNodeToolbar/)
  assert.match(nodeSource, /data\.kind === 'video'/)
  assert.match(nodeSource, /primaryResultUrl/)
  assert.match(nodeSource, /data\.savedAssetId/)
  assert.match(nodeSource, /isLocalVideoSource/)
})

test('工具栏完整提供实测入口、下拉工具、下载和全屏', () => {
  const source = read('src/components/dramaCanvas/VideoNodeToolbar.vue')

  for (const label of ['裁剪', '高清', '解析', '框选去字幕', '音频分离', '画面编辑']) {
    assert.match(source, new RegExp(label))
  }
  assert.match(source, /仅处理选区画面，不做文字识别/)
  assert.doesNotMatch(source, /\u004f\u0043\u0052/)
  assert.doesNotMatch(source, /智能去字幕/)
  assert.match(source, /aria-label="下载视频"/)
  assert.match(source, /aria-label="全屏预览"/)
  assert.match(source, /runVideoNodeTool/)
  assert.match(source, /videoToolsAPI\.getCapabilities/)
  assert.match(source, /operationAvailable/)
  assert.match(source, /capabilitiesError/)
  assert.match(source, /视频处理能力检查失败/)
  assert.match(source, /region-handle/)
  assert.match(source, /startRegionResize/)
  assert.match(source, /\.home-canvas-node\.is-selected \.video-node-toolbar/)
  assert.doesNotMatch(source, /功能开发中|敬请期待|模拟处理|placeholder/i)
})

test('前端接入异步视频任务、结果节点和刷新恢复', () => {
  const canvasSource = read('src/views/DramaCanvas.vue')
  const apiSource = read('src/api/videoTools.js')

  assert.match(apiSource, /\/video-tools\/capabilities/)
  assert.match(apiSource, /\/video-tools\/operations/)
  assert.match(canvasSource, /async function runVideoNodeTool/)
  assert.match(canvasSource, /dramaId:\s*dramaId\.value/)
  assert.match(canvasSource, /async function completeVideoToolOperation/)
  assert.match(canvasSource, /function resumePendingVideoToolOperations/)
  assert.match(canvasSource, /createFreeCanvasNode\((?:'|\")video(?:'|\")/)
  assert.match(canvasSource, /videoToolHistory/)
  assert.match(canvasSource, /videoToolStatus: 'failed'/)
})

test('视频任务在画布生命周期变化后停止轮询且禁止陈旧回写', () => {
  const canvasSource = read('src/views/DramaCanvas.vue')
  const completionStart = canvasSource.indexOf('async function completeVideoToolOperation')
  const completionEnd = canvasSource.indexOf('async function runVideoNodeTool', completionStart)
  const completionSource = canvasSource.slice(completionStart, completionEnd)

  assert.match(canvasSource, /let videoToolPollSession = 0/)
  assert.match(canvasSource, /function invalidateVideoToolPolling\(\)/)
  assert.match(canvasSource, /watch\(\(\) => route\.params\.id, \(\) => \{\s*invalidateVideoToolPolling\(\)/)
  assert.match(canvasSource, /onBeforeUnmount\(\(\) => \{\s*invalidateVideoToolPolling\(\)/)
  assert.match(canvasSource, /String\(dramaId\.value \|\| ''\) !== pollToken\.dramaId/)
  assert.match(canvasSource, /freeCanvasNodeById\(pollToken\.nodeId\)/)
  assert.match(canvasSource, /String\(node\.data\?\.videoToolTaskId \|\| ''\) !== pollToken\.taskId/)
  assert.match(canvasSource, /async function waitForVideoToolOperation\(taskId, pollToken\)/)
  assert.match(canvasSource, /completeVideoToolOperation\(node\.id, operation, result, previousHistory, pollToken\)/)
  assert.equal(
    (completionSource.match(/requireCurrentVideoToolSourceNode\(pollToken\)/g) || []).length,
    5,
    '解析、视频、音频结果节点及源节点状态回写前都必须复核任务归属',
  )
})

test('视频解析结果使用可持久化表格而非纯文本占位', () => {
  const nodeSource = read('src/components/dramaCanvas/HomeCanvasNode.vue')
  const normalizerSource = read('src/utils/freeCanvasGeneration.js')

  assert.match(nodeSource, /video-story-table/)
  assert.match(nodeSource, /data\.videoStory\.shots/)
  assert.match(normalizerSource, /normalizeVideoStory/)
  assert.match(normalizerSource, /normalized\.videoStory/)
})
test('视频节点全能参考可实际接收并提交图片、视频和音频', () => {
  const nodeSource = read('src/components/dramaCanvas/HomeCanvasNode.vue')
  const canvasSource = read('src/views/DramaCanvas.vue')
  const requestSource = read('src/utils/freeCanvasGeneration.js')

  assert.match(nodeSource, /@click="setVideoReferenceMode\('omni'\)"/)
  assert.doesNotMatch(nodeSource, /当前生成链路尚未开放全能参考/)
  assert.match(nodeSource, /:accept="referenceMediaAccept"/)
  assert.match(nodeSource, /capabilityAllows\('supportsImageReference'\)[\s\S]*accepted\.push\('image\/\*'\)/)
  assert.match(nodeSource, /capabilityAllows\('supportsVideoReference'\)[\s\S]*accepted\.push\('video\/\*'\)/)
  assert.match(nodeSource, /capabilityAllows\('supportsAudioReference'\)[\s\S]*accepted\.push\('audio\/\*'\)/)
  assert.match(canvasSource, /collectDirectUpstreamMediaReferences/)
  assert.match(canvasSource, /uploadFreeCanvasReferenceMedia/)
  assert.match(requestSource, /reference_video_urls/)
  assert.match(requestSource, /reference_audio_urls/)
})
