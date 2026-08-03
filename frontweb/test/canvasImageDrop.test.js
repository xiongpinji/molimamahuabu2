import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collectDroppedImageFiles,
  createDroppedImageNodeSpecs,
  hasDraggedFilePayload,
  stripLocalImagePreviewsForPersistence,
} from '../src/utils/canvasImageDrop.js'

test('拖放只接收图片并兼容缺少 MIME 的常见图片扩展名', () => {
  const png = { name: '人物.png', type: 'image/png' }
  const jpeg = { name: '背景.jpeg', type: '' }
  const webp = { name: '角色.WEBP', type: '' }
  const gif = { name: '动图.gif', type: '' }
  const avif = { name: '质感.avif', type: '' }
  const text = { name: '说明.txt', type: 'text/plain' }
  const disguised = { name: '脚本.jpg.exe', type: '' }

  assert.deepEqual(
    collectDroppedImageFiles({ files: [png, jpeg, webp, gif, avif, text, disguised] }),
    [png, jpeg, webp, gif, avif],
  )
})

test('protected dragover 可通过 files/items/types 判断文件拖入', () => {
  assert.equal(hasDraggedFilePayload({ files: [{ name: 'a.png' }] }), true)
  assert.equal(hasDraggedFilePayload({ files: [], items: [{ kind: 'file' }] }), true)
  assert.equal(hasDraggedFilePayload({ files: [], items: [], types: ['Files'] }), true)
  assert.equal(hasDraggedFilePayload({ files: [], items: [{ kind: 'string' }], types: ['text/plain'] }), false)
  assert.equal(hasDraggedFilePayload(null), false)
})

test('多张拖入图片立即生成带本地预览且错位排布的节点规格', () => {
  const files = [
    { name: '人物 A.png', type: 'image/png' },
    { name: '人物 B.jpeg', type: 'image/jpeg' },
  ]
  const previews = []
  const specs = createDroppedImageNodeSpecs(files, { x: 120, y: 240 }, (file) => {
    const url = `blob:preview/${file.name}`
    previews.push(url)
    return url
  })

  assert.equal(specs.length, 2)
  assert.deepEqual(previews, ['blob:preview/人物 A.png', 'blob:preview/人物 B.jpeg'])
  assert.deepEqual(specs.map((item) => item.position), [
    { x: 120, y: 240 },
    { x: 160, y: 280 },
  ])
  assert.deepEqual(specs.map((item) => item.data), [
    {
      kind: 'image',
      title: '人物 A.png',
      content: '',
      url: 'blob:preview/人物 A.png',
      status: 'running',
      error: '',
      localPreview: true,
    },
    {
      kind: 'image',
      title: '人物 B.jpeg',
      content: '',
      url: 'blob:preview/人物 B.jpeg',
      status: 'running',
      error: '',
      localPreview: true,
    },
  ])
})

test('持久化清洗会剥离本地 blob 预览且不改动运行时节点', () => {
  const nodes = [
    {
      id: 'a',
      type: 'homeCanvasNode',
      data: {
        kind: 'image',
        url: 'blob:preview/a',
        localPreview: true,
        status: 'failed',
        error: '上传失败',
      },
    },
    {
      id: 'b',
      type: 'homeCanvasNode',
      data: {
        kind: 'image',
        url: '/uploads/b.png',
        localPreview: false,
      },
    },
  ]

  const persisted = stripLocalImagePreviewsForPersistence(nodes)

  assert.equal(nodes[0].data.url, 'blob:preview/a')
  assert.equal(nodes[0].data.localPreview, true)
  assert.equal(persisted[0].data.url, '')
  assert.equal(persisted[0].data.localPreview, false)
  assert.equal(persisted[0].data.status, 'failed')
  assert.equal(persisted[0].data.error, '上传失败')
  assert.equal(persisted[1], nodes[1])
})
