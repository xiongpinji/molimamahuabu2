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
    slots: ['prompt', 'style-prompt'],
  })
  assert.deepEqual(resolveCanvasNodeConnection('image', 'video'), {
    allowed: true,
    output: 'image',
    input: 'reference-image',
    label: '图片 → 视频参考图',
    slots: ['reference-image', 'first-frame', 'last-frame', 'character-reference', 'style-reference'],
  })
  assert.equal(resolveCanvasNodeConnection('image', 'audio').allowed, false)
  assert.equal(resolveCanvasNodeConnection('video', 'image').allowed, false)
  assert.deepEqual(resolveCanvasNodeConnection('audio', 'video'), {
    allowed: true,
    output: 'audio',
    input: 'reference-audio',
    label: '音频 → 视频音色参考',
    slots: ['reference-audio'],
  })
  assert.deepEqual(resolveCanvasNodeConnection('video', 'video'), {
    allowed: true,
    output: 'video',
    input: 'reference-video',
    label: '视频 → 视频动作参考',
    slots: ['reference-video'],
  })
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
    slots: ['prompt', 'style-prompt'],
    enabled: true,
    order: 0,
    weight: 1,
  })
})
