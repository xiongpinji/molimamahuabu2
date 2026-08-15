import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildQuickGenerationRequest,
  estimateGenerationCredits,
  normalizeQuickGenerationDraft,
} from '../src/utils/homeQuickGeneration.js'

test('首页三种生成模式共享同一计费估算规则', () => {
  assert.equal(estimateGenerationCredits({ credits: 6, billing_unit: 'request' }, { duration: 15 }), 6)
  assert.equal(estimateGenerationCredits({ credits: 12, billing_unit: 'second' }, { duration: 5 }), 60)
  assert.equal(estimateGenerationCredits({ credits: null, billing_unit: 'request' }), null)
})

test('首页视频预计积分随 480P 和 720P 分辨率切换', () => {
  const model = {
    credits: 3,
    billing_unit: 'second',
    resolution_prices: {
      '480p': { credits: 3, cost_micros_per_second: 50000 },
      '720p': { credits: 5, cost_micros_per_second: 120000 },
    },
  }
  assert.equal(estimateGenerationCredits(model, { duration: 8, resolution: '480P' }), 24)
  assert.equal(estimateGenerationCredits(model, { duration: 8, resolution: '720p' }), 40)
})

test('首页草稿只接受文字、图片和视频并携带一次性自动生成标记', () => {
  assert.deepEqual(normalizeQuickGenerationDraft({
    mode: 'text',
    prompt: '写一段雨夜旁白',
    model: 'text-model',
    autoStart: true,
    referenceImageUrl: '/static/uploads/reference.png',
  }), {
    mode: 'text',
    prompt: '写一段雨夜旁白',
    model: 'text-model',
    aspectRatio: '16:9',
    duration: 5,
    resolution: '720p',
    quantity: 1,
    autoStart: true,
    referenceImageUrl: '/static/uploads/reference.png',
    generateAudio: false,
  })
  assert.equal(normalizeQuickGenerationDraft({ mode: 'script' }).mode, 'image')
})

test('文字、图片和视频请求均保留所选模型及对应生成参数', () => {
  assert.deepEqual(buildQuickGenerationRequest({
    mode: 'text', prompt: '写一句广告语', model: 'text-model', requestId: 'request-1',
  }), {
    endpoint: '/canvas/text/generate',
    body: { prompt: '写一句广告语', model: 'text-model', request_id: 'request-1' },
  })

  assert.deepEqual(buildQuickGenerationRequest({
    mode: 'image', prompt: '生成雨夜车站', model: 'image-model', style: 'cinematic',
    aspectRatio: '9:16', referenceImageUrl: '/static/uploads/reference.png',
  }), {
    endpoint: '/images',
    body: {
      prompt: '生成雨夜车站', model: 'image-model', style: 'cinematic',
      aspect_ratio: '9:16', resolution: '1k', size: '576x1024', n: 1,
      reference_images: ['/static/uploads/reference.png'],
    },
  })

  assert.deepEqual(buildQuickGenerationRequest({
    mode: 'video', prompt: '人物走入雨幕', model: 'video-model', style: 'cinematic',
    aspectRatio: '16:9', duration: 10, resolution: '1080p',
    referenceImageUrl: '/static/uploads/reference.png',
  }), {
    endpoint: '/videos',
    body: {
      prompt: '人物走入雨幕', model: 'video-model', style: 'cinematic',
      aspect_ratio: '16:9', duration: 10, resolution: '1080p',
      reference_mode: 'first_last',
      first_frame_url: 'uploads/reference.png', image_url: '/static/uploads/reference.png',
    },
  })
})
