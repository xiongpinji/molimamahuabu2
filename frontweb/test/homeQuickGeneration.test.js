import test from 'node:test'
import assert from 'node:assert/strict'
import * as quickGeneration from '../src/utils/homeQuickGeneration.js'

import {
  buildQuickGenerationRequest,
  estimateGenerationCredits,
  normalizeQuickGenerationCatalog,
  normalizeQuickGenerationDraft,
  quickGenerationResolutions,
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

test('首页图片预计积分随档位和数量变化且缺少档位时不回退基础价', () => {
  const model = {
    category: 'image',
    credits: 70,
    billing_unit: 'request',
    resolution_prices: {
      '1k': { credits: 70 },
      '2k': { credits: 87 },
      '4k': { credits: 105 },
    },
  }
  assert.equal(estimateGenerationCredits(model, { resolution: '2K', quantity: 3 }), 261)
  assert.equal(estimateGenerationCredits(model, { resolution: '8k', quantity: 1 }), null)
  assert.equal(estimateGenerationCredits(model, { resolution: '1k', quantity: 1.5 }), null)
})

test('首页目录保留管理员展示信息并只开放真实验证的图片档位', () => {
  const catalog = normalizeQuickGenerationCatalog([
    {
      kind: 'image',
      model: 'gpt-image-2-2-4k',
      label: 'GPT Image 2（稳定）',
      public_note: 'GPT 当前仅开放 1K、2K',
      verification_status: 'verified',
      protocol: 'usmercari_image',
      resolution_prices: {
        '1k': { credits: 70 },
        '2k': { credits: 87 },
        '4k': { credits: 105 },
      },
      capabilities: { resolutions: ['1k', '2k', '4k'], maxReferences: 6 },
    },
    {
      kind: 'image',
      model: 'nano-banana-2',
      label: 'Nano Banana 2',
      public_note: '支持 4K',
      verification_status: 'verified',
      protocol: 'usmercari_image',
      resolution_prices: {
        '1k': { credits: 70 },
        '2k': { credits: 87 },
        '4k': { credits: 105 },
      },
      capabilities: { resolutions: ['1k', '2k', '4k'], maxReferences: 6 },
    },
    {
      kind: 'image',
      model: 'pending-usmercari',
      verification_status: 'pending',
      protocol: 'usmercari_image',
    },
    {
      kind: 'image',
      model: 'legacy-pending-image',
      verification_status: 'pending',
      protocol: 'openai',
      capabilities: { resolutions: ['1k'], quantities: [1, 2] },
    },
  ])

  assert.deepEqual(catalog.map(({ model }) => model), ['gpt-image-2-2-4k', 'nano-banana-2', 'legacy-pending-image'])
  assert.equal(catalog[0].label, 'GPT Image 2（稳定）')
  assert.equal(catalog[0].publicNote, 'GPT 当前仅开放 1K、2K')
  assert.deepEqual(quickGenerationResolutions(catalog[0], 'image'), ['1k', '2k'])
  assert.deepEqual(Object.keys(catalog[0].resolution_prices), ['1k', '2k'])
  assert.deepEqual(quickGenerationResolutions(catalog[1], 'image'), ['1k', '2k', '4k'])
  assert.deepEqual(catalog[0].capabilities.quantities, [1])
  assert.deepEqual(catalog[2].capabilities.quantities, [1, 2])
})

test('首页目录不能因缺少 protocol 而放行 provider 或受保护模型的未验证配置', () => {
  const catalog = normalizeQuickGenerationCatalog([
    {
      kind: 'video',
      model: 'seedance-2-fast',
      provider: 'toapis',
      verification_status: 'pending',
      resolution_prices: { '480p': { credits: 1 }, '720p': { credits: 2 } },
      capabilities: { resolutions: ['480p', '720p'], durations: [4, 5] },
    },
    {
      kind: 'video',
      model: 'seedance-2-mini',
      provider: 'openai',
      verification_status: 'verified',
      resolution_prices: { '480p': { credits: 1 }, '720p': { credits: 2 } },
      capabilities: {},
    },
    {
      kind: 'image',
      model: 'nano-banana-2',
      provider: 'usmercari',
      verification_status: 'pending',
      resolution_prices: { '1k': { credits: 1 } },
      capabilities: { resolutions: ['1k'] },
    },
    {
      kind: 'video',
      model: 'seedance-2-fast',
      provider: 'toapis',
      verification_status: 'verified',
      resolution_prices: { '480p': { credits: 1 }, '720p': { credits: 2 } },
      capabilities: { resolutions: ['480p', '720p'], durations: [4, 5] },
    },
  ])

  assert.deepEqual(catalog.map((item) => item.model), ['seedance-2-fast'])
  assert.equal(catalog[0].protocol, 'toapis_video')
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
  assert.equal(normalizeQuickGenerationDraft({ mode: 'image', resolution: '720p' }).resolution, '1k')
})

test('首页视频时长使用目录能力而不是固定 5/10/15 秒', () => {
  assert.deepEqual(quickGeneration.quickGenerationDurations?.({
    kind: 'video', capabilities: { durations: [4, 8, 10, 12, 15] },
  }), [4, 8, 10, 12, 15])
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
    aspectRatio: '9:16', resolution: '2K', quantity: 3,
    referenceImageUrl: '/static/uploads/reference.png',
  }), {
    endpoint: '/images',
    body: {
      prompt: '生成雨夜车站', model: 'image-model', style: 'cinematic',
      aspect_ratio: '9:16', resolution: '2k', size: '1152x2048', n: 3,
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

test('GPT 图片模型不能通过旧草稿提交 4K，未验证多张数量也会阻断', () => {
  assert.throws(() => buildQuickGenerationRequest({
    mode: 'image', prompt: '生成海报', model: 'gpt-image-2-2-4k', resolution: '4k', quantity: 1,
  }), /只开放 1k、2k/)
  assert.throws(() => buildQuickGenerationRequest({
    mode: 'image', prompt: '生成海报', model: 'nano-banana-2', resolution: '2k', quantity: 2,
  }), /只开放单张生成/)
  assert.throws(() => buildQuickGenerationRequest({
    mode: 'image', prompt: '生成海报', model: 'nano-banana-2', resolution: '8k', quantity: 1,
  }), /只开放 1k、2k、4k/)
  assert.throws(() => buildQuickGenerationRequest({
    mode: 'image', prompt: '生成海报', model: 'nano-banana-2', resolution: '2k', quantity: 1.5,
  }), /只开放单张生成/)
})
