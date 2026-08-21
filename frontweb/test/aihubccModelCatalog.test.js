import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AIHUBCC_IMAGE_MODELS,
  AIHUBCC_VIDEO_MODELS,
  AIHUBCC_VIDEO_POSTPROCESS_MODELS,
  isAihubccFlowImageModel,
} from '../src/utils/aihubccModelCatalog.js'

test('AIHubCC image catalog follows the 2026-07-24 protocol document', () => {
  assert.equal(AIHUBCC_IMAGE_MODELS.includes('gpt-image-2-4k'), false)
  assert.equal(AIHUBCC_IMAGE_MODELS.includes('gpt-image-2-3.5k'), true)
  assert.equal(AIHUBCC_IMAGE_MODELS.includes('gemini-3.1-flash-image-landscape'), true)
  assert.equal(AIHUBCC_IMAGE_MODELS.includes('gemini-3.0-pro-image-portrait-2k'), true)
  assert.equal(AIHUBCC_IMAGE_MODELS.includes('imagen-4.0-generate-preview-landscape'), true)
  assert.equal(isAihubccFlowImageModel('gemini-3.1-flash-image-square'), true)
  assert.equal(isAihubccFlowImageModel('gpt-image-2'), false)
})

test('AIHubCC generation and post-process video models stay separated', () => {
  assert.equal(AIHUBCC_VIDEO_MODELS.includes('omni-fast'), true)
  assert.equal(AIHUBCC_VIDEO_MODELS.includes('grok-imagine-video-1.5-preview'), true)
  assert.equal(AIHUBCC_VIDEO_MODELS.includes('veo_3_1_t2v_fast_portrait_6s'), true)
  assert.equal(AIHUBCC_VIDEO_MODELS.includes('veo_3_1_i2v_s_fast_landscape_6s_fl'), true)
  assert.equal(AIHUBCC_VIDEO_MODELS.includes('veo_3_1_r2v_fast_portrait'), true)
  assert.equal(AIHUBCC_VIDEO_MODELS.includes('veo-clean'), false)
  assert.deepEqual(AIHUBCC_VIDEO_POSTPROCESS_MODELS, ['veo-clean'])
})
