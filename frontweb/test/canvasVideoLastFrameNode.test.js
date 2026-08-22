import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const nodeSource = fs.readFileSync(new URL('../src/components/dramaCanvas/HomeCanvasNode.vue', import.meta.url), 'utf8')
const canvasSource = fs.readFileSync(new URL('../src/views/DramaCanvas.vue', import.meta.url), 'utf8')

test('视频节点提供一键提取尾帧入口并交给画布创建图片节点', () => {
  assert.match(nodeSource, /一键提取尾帧/)
  assert.match(nodeSource, /@click\.stop="extractLastFrame"/)
  assert.match(nodeSource, /createImageNodeFromVideoLastFrame\?\.\(props\.id\)/)
})

test('尾帧存在时直接创建已填充结果的图片节点', () => {
  assert.match(canvasSource, /async function createImageNodeFromVideoLastFrame\(nodeOrId\)/)
  assert.match(canvasSource, /outputLastFrameUrl\s*\|\|\s*videoNode\.data\?\.output_last_frame_url/)
  assert.match(canvasSource, /createFreeCanvasNode\('image',[\s\S]*sourceVideoNodeId:/)
  assert.match(canvasSource, /Object\.assign\(data, initialData\)/)
  assert.match(canvasSource, /createImageNodeFromVideoLastFrame,/)

  const validationIndex = canvasSource.indexOf('if (!lastFrameUrl)')
  const creationIndex = canvasSource.indexOf("createFreeCanvasNode('image'", validationIndex)
  assert.ok(validationIndex >= 0 && creationIndex > validationIndex, '应先校验尾帧，再创建图片节点')
})

test('尾帧字段缺失时按视频生成记录或视频地址请求后端补抽', () => {
  assert.match(canvasSource, /videosAPI\.extractBoundaryFrames/)
  assert.match(canvasSource, /videoGenerationId/)
  assert.match(canvasSource, /video_url:\s*videoNode\.data\?\.url/)
  assert.match(canvasSource, /output_last_frame_url/)
})
