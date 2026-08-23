import test from 'node:test'
import assert from 'node:assert/strict'
import { buildFreeCanvasGenerationRequest } from '../src/utils/freeCanvasGeneration.js'

test('视频多图参考模式不再隐式混入首帧字段', () => {
  const payload = buildFreeCanvasGenerationRequest({
    kind: 'video',
    content: '跟随两张参考图生成',
    model: 'Seedance 2.0 Mini',
  }, {
    dramaId: 48,
    upstreamReferences: [
      { kind: 'image', url: '/static/ref-1.jpg', slot: 'reference-image', order: 0 },
      { kind: 'image', url: '/static/ref-2.jpg', slot: 'reference-image', order: 1 },
    ],
  })

  assert.deepEqual(payload.reference_image_urls, ['/static/ref-1.jpg', '/static/ref-2.jpg'])
  assert.equal('image_url' in payload, false)
  assert.equal('first_frame_url' in payload, false)
  assert.equal('last_frame_url' in payload, false)
})
