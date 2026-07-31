import test from 'node:test'
import assert from 'node:assert/strict'

import { supportsMultiImageVideoReferences } from '../src/utils/videoModelReferenceCapabilities.js'

test('灵境与 Omni 视频模型支持多图参考', () => {
  for (const model of [
    'lingjing-video-v1',
    'omni-fast',
    'omni-fast-v2v-no-water',
    'kling-omni-video',
  ]) {
    assert.equal(supportsMultiImageVideoReferences(model), true, model)
  }
})

test('Seedance 2、Grok 视频与 Agnes Video 支持多图参考', () => {
  for (const model of [
    'Seedance-2.0-720p',
    'bytedance/seedance-2-0-fast',
    'grok-imagine-video',
    'grok-video-3',
    'agnes-video',
  ]) {
    assert.equal(supportsMultiImageVideoReferences(model), true, model)
  }
})

test('未声明多图能力的视频模型保持保守降级', () => {
  for (const model of ['', 'veo_3_1_i2v_s_fast_landscape_4s_fl', 'wan2.6-i2v-flash']) {
    assert.equal(supportsMultiImageVideoReferences(model), false, model)
  }
})
