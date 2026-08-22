import test from 'node:test'
import assert from 'node:assert/strict'

import { buildFreeCanvasGenerationRequest } from '../src/utils/freeCanvasGeneration.js'

test('image request accepts the declared reference limit without a runtime ReferenceError', () => {
  const request = buildFreeCanvasGenerationRequest({
    kind: 'image',
    content: '生成分镜图',
    model: 'gpt-image-2-2k',
    aspectRatio: '16:9',
    resolution: '2K',
    quantity: 1,
  }, {
    dramaId: 1,
    upstreamReferences: [
      { url: 'https://example.com/a.png', ready: true, enabled: true, order: 1 },
      { url: 'https://example.com/b.png', ready: true, enabled: true, order: 2 },
    ],
    capability: { maxReferences: 6 },
    maxReferences: 6,
  })

  assert.deepEqual(request.reference_images, [
    'https://example.com/a.png',
    'https://example.com/b.png',
  ])
})
