import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  canvasMediaKind,
  collectDroppedMediaFiles,
  createDroppedMediaNodeSpecs,
} from '../src/utils/canvasMediaDrop.js'

const dramaCanvasSource = readFileSync(new URL('../src/views/DramaCanvas.vue', import.meta.url), 'utf8')
const homeCanvasSource = readFileSync(new URL('../src/views/HomeCanvas.vue', import.meta.url), 'utf8')

test('系统拖入文件按 MIME 与常见扩展名识别图片和视频', () => {
  const files = [
    { name: 'portrait.png', type: 'image/png' },
    { name: 'shot.mp4', type: 'video/mp4' },
    { name: 'camera.MOV', type: '' },
    { name: 'notes.pdf', type: 'application/pdf' },
  ]
  assert.equal(canvasMediaKind(files[0]), 'image')
  assert.equal(canvasMediaKind(files[1]), 'video')
  assert.equal(canvasMediaKind(files[2]), 'video')
  assert.equal(canvasMediaKind(files[3]), '')
  assert.deepEqual(collectDroppedMediaFiles({ files }), files.slice(0, 3))
})

test('节点规格保留媒体类型、预览地址和拖入位置', () => {
  const files = [
    { name: 'portrait.webp', type: 'image/webp' },
    { name: 'shot.webm', type: 'video/webm' },
  ]
  const specs = createDroppedMediaNodeSpecs(files, { x: 120, y: 80 }, (file) => `blob:${file.name}`)
  assert.deepEqual(specs.map((spec) => spec.kind), ['image', 'video'])
  assert.deepEqual(specs.map((spec) => spec.position), [{ x: 120, y: 80 }, { x: 160, y: 120 }])
  assert.deepEqual(specs.map((spec) => spec.data.url), ['blob:portrait.webp', 'blob:shot.webm'])
})

test('项目画布与本地画布都接收系统图片和视频拖放', () => {
  for (const source of [dramaCanvasSource, homeCanvasSource]) {
    assert.match(source, /@dragover="onCanvasMediaDragOver"/)
    assert.match(source, /@drop="onCanvasMediaDrop"/)
    assert.match(source, /collectDroppedMediaFiles\(event\.dataTransfer\)/)
  }
})

test('拖入图片和视频后按文件类型创建对应的可预览节点', () => {
  assert.match(dramaCanvasSource, /createDroppedMediaNodeSpecs\(files, origin,/)
  assert.match(dramaCanvasSource, /createFreeCanvasNode\(spec\.kind, spec\.position, spec\.data\)/)
  assert.match(dramaCanvasSource, /createCanvasProjectAssetFromUpload\(file, origin, index\)/)
  assert.match(homeCanvasSource, /createDroppedMediaNodeSpecs\(files, origin,/)
  assert.match(homeCanvasSource, /openNodeEditor\(spec\.kind, spec\.position, spec\.data\)/)
})
