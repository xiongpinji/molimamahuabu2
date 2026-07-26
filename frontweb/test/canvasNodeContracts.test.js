import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canvasModelServiceType,
  resolveCanvasNodeConnection,
  toLibTvCanvasEdge,
} from '../src/utils/canvasNodeContracts.js'

test('自由节点连接只允许真实模型能够消费的输入契约', () => {
  assert.deepEqual(resolveCanvasNodeConnection('text', 'image'), {
    allowed: true,
    output: 'text',
    input: 'prompt',
    label: '文本 → 图片提示词',
  })
  assert.deepEqual(resolveCanvasNodeConnection('image', 'video'), {
    allowed: true,
    output: 'image',
    input: 'reference-image',
    label: '图片 → 视频参考图',
  })
  assert.equal(resolveCanvasNodeConnection('image', 'audio').allowed, false)
  assert.equal(resolveCanvasNodeConnection('video', 'image').allowed, false)
  assert.equal(resolveCanvasNodeConnection('audio', 'video').allowed, false)
})

test('四类节点只匹配各自真实服务类型', () => {
  assert.equal(canvasModelServiceType('text'), 'text')
  assert.equal(canvasModelServiceType('image'), 'storyboard_image')
  assert.equal(canvasModelServiceType('video'), 'video')
  assert.equal(canvasModelServiceType('audio'), 'tts')
  assert.equal(canvasModelServiceType('unknown'), '')
})

test('合法连接统一转换为 LibTV 贝塞尔高光边并写入契约', () => {
  const edge = toLibTvCanvasEdge(
    { id: 'manual:text:image', source: 'text', target: 'image', data: { manual: true } },
    'text',
    'image',
  )
  assert.equal(edge.type, 'libtv')
  assert.deepEqual(edge.pathOptions, { curvature: 0.42 })
  assert.deepEqual(edge.data.contract, {
    output: 'text',
    input: 'prompt',
    label: '文本 → 图片提示词',
  })
})
