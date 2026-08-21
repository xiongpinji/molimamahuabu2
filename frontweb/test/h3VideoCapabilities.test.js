import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { videoResolutionOptionsForModel } from '../src/utils/videoResolution.js'

const adminSource = fs.readFileSync(new URL('../src/views/BillingAdmin.vue', import.meta.url), 'utf8')

test('MiniMax H3 前端只开放 1440P，Seedance 2.0 档位不变', () => {
  assert.deepEqual(videoResolutionOptionsForModel('MiniMax H3'), ['1440p'])
  assert.deepEqual(videoResolutionOptionsForModel('seedance-2.0-fast'), ['480p', '720p'])
  assert.deepEqual(videoResolutionOptionsForModel('seedance-2.0-mini'), ['480p', '720p'])
})

test('管理员保存两套 H3 时锁定固定按次价格并清除分辨率价格档', () => {
  assert.match(adminSource, /FIXED_REQUEST_VIDEO_MODELS/)
  assert.match(adminSource, /minimax h3/)
  assert.match(adminSource, /xuan-video-v1-6e7b4763634e6206/)
  assert.match(adminSource, /usesFixedRequestVideoPricing/)
  assert.match(adminSource, /usesFixedRequestVideoPricing\([^)]*\)[\s\S]*?\{\s*resolution_prices:\s*\{\}\s*\}/)
  assert.match(adminSource, /cost_unit:\s*usesFixedRequestVideoPricing\([^)]*\)\s*\?\s*'request'/)
  assert.match(adminSource, /billing_unit:\s*usesFixedRequestVideoPricing\([^)]*\)\s*\?\s*'request'/)
})
