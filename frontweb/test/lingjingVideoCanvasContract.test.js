import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildQuickGenerationRequest,
  estimateGenerationCredits,
  normalizeQuickGenerationCatalog,
  normalizeQuickGenerationDraft,
  quickGenerationResolutions,
} from '../src/utils/homeQuickGeneration.js'
import {
  canvasModelCapability,
  estimateCanvasCredits,
  filterCanvasCatalogFallbackModels,
  normalizeCanvasModelCatalog,
} from '../src/utils/canvasModelCapabilities.js'
import {
  buildFreeCanvasGenerationRequest,
  planFreeCanvasVideoReferences,
} from '../src/utils/freeCanvasGeneration.js'
import { buildVideoGenerationRequest } from '../src/utils/videoGenerationRequest.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')

const capability = Object.freeze({
  declared: true,
  aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  resolutions: [],
  durations: [4, 5, 6, 8, 10, 11, 15],
  quantities: [1],
  referenceTypes: ['image'],
  maxReferences: 9,
  maxImageReferences: 9,
  maxVideoReferences: 0,
  maxAudioReferences: 0,
  supportsImageReference: true,
  supportsFirstFrame: false,
  supportsLastFrame: false,
  supportsVideoReference: false,
  supportsAudioReference: false,
  supportsAudio: false,
})

function lingjingCatalogItem(overrides = {}) {
  return {
    kind: 'video',
    model: 'lingjing-video-v1',
    label: '灵境 Seedance 2.0 Fast（9 图参考）',
    public_note: '仅开放 4/5/6/8/10/11/15 秒与最多 9 张参考图',
    verification_status: 'verified',
    provider: 'lingjing',
    protocol: 'lingjing_open',
    credits: 69,
    billing_unit: 'second',
    resolution_prices: {},
    capabilities: capability,
    ...overrides,
  }
}

test('灵境严格目录保留空分辨率、时长、展示名和九图能力且禁止旧目录回填', () => {
  const quickCatalog = normalizeQuickGenerationCatalog([
    lingjingCatalogItem(),
    lingjingCatalogItem({ verification_status: 'pending', label: '不应出现' }),
  ])
  assert.equal(quickCatalog.length, 1)
  assert.equal(quickCatalog[0].label, '灵境 Seedance 2.0 Fast（9 图参考）')
  assert.equal(quickCatalog[0].publicNote, '仅开放 4/5/6/8/10/11/15 秒与最多 9 张参考图')
  assert.deepEqual(quickGenerationResolutions(quickCatalog[0], 'video'), [])
  assert.deepEqual(quickCatalog[0].capabilities.durations, [4, 5, 6, 8, 10, 11, 15])

  const canvasCatalog = normalizeCanvasModelCatalog(quickCatalog)
  assert.deepEqual(canvasModelCapability(canvasCatalog, 'video', 'lingjing-video-v1').resolutions, [])
  assert.deepEqual(filterCanvasCatalogFallbackModels([
    'legacy-video', 'lingjing-video-v1', 'seedance-2-fast',
  ], 'video'), ['legacy-video'])
})

test('灵境首页草稿不伪造清晰度且一图请求使用图片参考数组', () => {
  const item = lingjingCatalogItem()
  const draft = normalizeQuickGenerationDraft({
    mode: 'video',
    model: item.model,
    resolution: '720p',
    duration: 7,
    quantity: 2,
    generateAudio: true,
  }, item)
  assert.equal(draft.resolution, '')
  assert.equal(draft.duration, 4)
  assert.equal(draft.quantity, 1)
  assert.equal(draft.generateAudio, false)

  const request = buildQuickGenerationRequest({
    mode: 'video',
    model: item.model,
    prompt: '纸船顺流而下',
    aspectRatio: '21:9',
    duration: 4,
    resolution: '720p',
    referenceImageUrl: '/static/reference.png',
    capability,
  })
  assert.equal(request.body.reference_mode, 'omni')
  assert.deepEqual(request.body.reference_image_urls, ['reference.png'])
  for (const key of ['resolution', 'image_url', 'first_frame_url', 'last_frame_url', 'reference_video_urls', 'reference_audio_urls', 'generate_audio']) {
    assert.equal(key in request.body, false, key)
  }
  assert.equal(estimateGenerationCredits(item, { duration: 4, quantity: 1 }), 276)
  assert.equal(estimateCanvasCredits([item], 'video', item.model, 1, 4, ''), 276)
})

test('灵境自由画布最多透传九张图片且不泄漏未支持字段', () => {
  const upstreamReferences = Array.from({ length: 9 }, (_, index) => ({
    kind: 'image',
    url: `https://cdn.example/reference-${index + 1}.jpg`,
    order: index,
  }))
  const request = buildFreeCanvasGenerationRequest({
    kind: 'video',
    content: '九张设定图保持人物与场景一致',
    model: 'lingjing-video-v1',
    aspectRatio: '16:9',
    duration: 4,
    resolution: '720p',
    videoReferenceMode: 'multi',
    includeAudio: false,
  }, { dramaId: 48, upstreamReferences, capability })
  assert.equal(request.reference_mode, 'omni')
  assert.deepEqual(request.reference_image_urls, upstreamReferences.map((item) => item.url))
  for (const key of ['resolution', 'first_frame_url', 'last_frame_url', 'reference_video_urls', 'reference_audio_urls', 'generate_audio']) {
    assert.equal(key in request, false, key)
  }
  const planned = planFreeCanvasVideoReferences(capability, 'multi', [
    ...upstreamReferences,
    { kind: 'image', url: 'https://cdn.example/reference-10.jpg', order: 9 },
  ])
  assert.equal(planned.filter((item) => item.enabled).length, 9)
  assert.equal(planned[9].enabled, false)
})

test('灵境短剧请求省略清晰度并拒绝首尾帧、视频、音频和同步音频', () => {
  const base = {
    dramaId: 48,
    storyboardId: 1,
    prompt: '镜头缓慢推进',
    model: 'lingjing-video-v1',
    aspectRatio: '9:16',
    resolution: '720p',
    duration: 4,
    capability,
  }
  const request = buildVideoGenerationRequest({
    ...base,
    referenceMode: 'omni',
    referenceImageUrls: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'],
    generateAudio: false,
  })
  assert.deepEqual(request.reference_image_urls, ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'])
  assert.equal('resolution' in request, false)
  assert.equal('generate_audio' in request, false)
  assert.throws(() => buildVideoGenerationRequest({ ...base, referenceMode: 'first_last', firstFrameUrl: 'https://cdn.example/a.jpg' }), /不支持首帧参考/)
  assert.throws(() => buildVideoGenerationRequest({ ...base, referenceMode: 'omni', referenceVideoUrls: ['https://cdn.example/a.mp4'] }), /未开放参考视频/)
  assert.throws(() => buildVideoGenerationRequest({ ...base, referenceMode: 'omni', referenceAudioUrls: ['https://cdn.example/a.mp3'] }), /未开放参考音频/)
  assert.throws(() => buildVideoGenerationRequest({ ...base, generateAudio: true }), /不支持同步音频/)
})

test('管理员、首页、画布与短剧工厂均使用灵境专用目录能力并隐藏清晰度', () => {
  const admin = source('src/components/AIConfigContent.vue')
  const filmList = source('src/views/FilmList.vue')
  const freeCreate = source('src/views/FreeCreate.vue')
  const homeNode = source('src/components/dramaCanvas/HomeCanvasNode.vue')
  const generationOptions = source('src/components/dramaCanvas/CanvasGenerationOptions.vue')
  const filmCreate = source('src/views/FilmCreate.vue')

  assert.match(admin, /lingjing-video-v1/)
  assert.match(admin, /lingjing_open/)
  assert.match(admin, /https:\/\/seed\.alimyun\.xyz\/api\/open\/v1/)
  assert.match(filmList, /homeMediaType === 'image' \|\| homeResolutions\.length/)
  assert.match(freeCreate, /mode === 'image' \|\| selectedResolutions\.length/)
  assert.match(homeNode, /data\.kind === 'image' \|\| capability\.resolutions\?\.length/)
  assert.match(generationOptions, /videoResolutionOptions\.length/)
  assert.match(filmCreate, /selectedVideoResolutionOptions\.length/)
  assert.match(filmCreate, /strictLingjing[\s\S]*lingjing_open/)
})
