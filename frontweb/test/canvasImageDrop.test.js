import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collectDroppedImageFiles,
  createDroppedImageNodeSpecs,
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
