import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as videoDuration from '../src/utils/videoDuration.js'
import {
  buildQuickGenerationRequest,
  estimateGenerationCredits,
  normalizeQuickGenerationCatalog,
  normalizeQuickGenerationDraft,
} from '../src/utils/homeQuickGeneration.js'
import {
  canvasModelCapability,
  estimateCanvasCredits,
  normalizeCanvasModelCatalog,
} from '../src/utils/canvasModelCapabilities.js'
import { buildFreeCanvasGenerationRequest } from '../src/utils/freeCanvasGeneration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')

const fastCapability = Object.freeze({
  resolutions: ['480p', '720p'],
  durations: Array.from({ length: 12 }, (_, index) => index + 4),
  quantities: [1],
  maxReferences: 9,
  maxVideoReferences: 3,
  maxAudioReferences: 3,
  supportsFirstFrame: true,
  supportsLastFrame: true,
  supportsImageReference: true,
  supportsVideoReference: true,
  supportsAudioReference: true,
  supportsAudio: true,
})

const miniCapability = Object.freeze({
  ...fastCapability,
  durations: [4, 8, 10, 12, 15],
})

const wan3Capability = Object.freeze({
  resolutions: ['480p', '720p', '1080p'],
  durations: Array.from({ length: 29 }, (_, index) => index + 2),
  quantities: [1],
  maxReferences: 10,
  maxImageReferences: 10,
  maxVideoReferences: 5,
  maxAudioReferences: 5,
  supportsFirstFrame: true,
  supportsLastFrame: true,
  supportsImageReference: true,
  supportsVideoReference: true,
  supportsAudioReference: true,
  supportsAudio: true,
})

function videoCatalogItem(model, capability, overrides = {}) {
  return {
    kind: 'video',
    model,
    label: model === 'seedance-2-mini' ? 'Seedance 2 Mini（经济）' : 'Seedance 2 Fast（快速）',
    public_note: '管理员公开备注',
    verification_status: 'verified',
    protocol: 'toapis_video',
    billing_unit: 'second',
    resolution_prices: {
      '480p': { credits: 294 },
      '720p': { credits: 595 },
    },
    capabilities: capability,
    ...overrides,
  }
}

test('ToAPIs 目录保留真实模型 ID 与管理员展示信息并排除未验证条目', () => {
  const catalog = normalizeQuickGenerationCatalog([
    videoCatalogItem('seedance-2-fast', fastCapability),
    videoCatalogItem('seedance-2-mini', miniCapability),
    videoCatalogItem('seedance-2-mini-pending', miniCapability, { verification_status: 'pending' }),
  ])

  assert.deepEqual(catalog.map((item) => item.model), ['seedance-2-fast', 'seedance-2-mini'])
  assert.equal(catalog[0].label, 'Seedance 2 Fast（快速）')
  assert.equal(catalog[0].publicNote, '管理员公开备注')
  assert.deepEqual(catalog[0].capabilities.resolutions, ['480p', '720p'])
  assert.deepEqual(catalog[1].capabilities.durations, [4, 8, 10, 12, 15])
})

test('首页快速生成把 Wan3 绑定到独立协议并开放批准的完整分辨率和时长', () => {
  const catalog = normalizeQuickGenerationCatalog([
    videoCatalogItem('wan3.0-video', wan3Capability, {
      label: 'ToAPIs Wan 3.0',
      provider: 'toapis_wan3',
      protocol: '',
      resolution_prices: {
        '480p': { credits: 400 },
        '720p': { credits: 999 },
        '1080p': { credits: 1200 },
      },
    }),
    videoCatalogItem('wan3.0-video', wan3Capability, {
      label: 'ToAPIs Wan 3.0 未验证',
      provider: 'toapis_wan3',
      protocol: '',
      verification_status: 'pending',
      resolution_prices: {
        '480p': { credits: 400 },
      },
    }),
  ])

  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].protocol, 'toapis_wan3_video')
  assert.deepEqual(catalog[0].capabilities.resolutions, ['480p', '720p', '1080p'])
  assert.deepEqual(catalog[0].capabilities.durations, Array.from({ length: 29 }, (_, index) => index + 2))
  assert.deepEqual(Object.keys(catalog[0].resolution_prices), ['480p', '720p', '1080p'])
})

test('模型能力决定视频时长选项并在模型切换时规范化草稿', () => {
  assert.deepEqual(videoDuration.videoDurationOptionsForCapability?.(fastCapability), fastCapability.durations)
  assert.deepEqual(videoDuration.videoDurationOptionsForCapability?.(miniCapability), [4, 8, 10, 12, 15])
  assert.equal(videoDuration.assertVideoDurationAllowed?.(8, miniCapability), 8)
  assert.throws(
    () => videoDuration.assertVideoDurationAllowed?.(5, miniCapability),
    /当前模型.*4.*8.*10.*12.*15.*秒/,
  )

  const mini = videoCatalogItem('seedance-2-mini', miniCapability)
  assert.deepEqual(normalizeQuickGenerationDraft({
    mode: 'video', model: mini.model, resolution: '1080p', duration: 5, quantity: 2,
  }, mini), {
    mode: 'video',
    prompt: '',
    model: 'seedance-2-mini',
    aspectRatio: '16:9',
    duration: 4,
    resolution: '480p',
    quantity: 1,
    autoStart: false,
    referenceImageUrl: '',
    generateAudio: false,
  })

  const staleDraft = normalizeQuickGenerationDraft({
    mode: 'video', model: mini.model, resolution: '1080p', duration: 5, quantity: 1,
  })
  assert.equal(staleDraft.resolution, '1080p')
  assert.equal(staleDraft.duration, 5)
})

test('首页视频提交拒绝旧 1080P 与 Mini 5 秒并保留 generate_audio=false', () => {
  assert.throws(() => buildQuickGenerationRequest({
    mode: 'video', model: 'seedance-2-fast', prompt: '雨夜追车',
    resolution: '480p', duration: 4,
  }), /当前视频模型目录尚未就绪/)
  assert.throws(() => buildQuickGenerationRequest({
    mode: 'video', model: 'seedance-2-fast', prompt: '雨夜追车',
    resolution: '1080p', duration: 8, capability: fastCapability,
  }), /当前模型.*480p.*720p/)
  assert.throws(() => buildQuickGenerationRequest({
    mode: 'video', model: 'seedance-2-mini', prompt: '雨夜追车',
    resolution: '720p', duration: 5, capability: miniCapability,
  }), /当前模型.*4.*8.*10.*12.*15.*秒/)

  const request = buildQuickGenerationRequest({
    mode: 'video', model: 'seedance-2-mini', prompt: '雨夜追车',
    resolution: '720p', duration: 8, capability: miniCapability, generateAudio: false,
  })
  assert.equal(request.body.model, 'seedance-2-mini')
  assert.equal(request.body.resolution, '720p')
  assert.equal(request.body.duration, 8)
  assert.equal(request.body.generate_audio, false)
  assert.equal(estimateGenerationCredits(videoCatalogItem('seedance-2-mini', miniCapability), {
    resolution: '720p', duration: 5, quantity: 1,
  }), null)
})

test('ToAPIs 缺少当前分辨率价格时不回退总价并保持禁用', () => {
  const withoutTierPrice = videoCatalogItem('seedance-2-fast', fastCapability, {
    credits: 999,
    resolution_prices: {},
  })
  assert.equal(estimateGenerationCredits(withoutTierPrice, {
    resolution: '480p', duration: 4, quantity: 1,
  }), null)
  assert.equal(estimateCanvasCredits([withoutTierPrice], 'video', 'seedance-2-fast', 1, 4, '480p'), null)
})

test('画布能力目录同步 ToAPIs 分辨率、时长、展示名和公开备注', () => {
  const catalog = normalizeCanvasModelCatalog([
    videoCatalogItem('seedance-2-fast', fastCapability),
    videoCatalogItem('seedance-2-mini', miniCapability),
  ])
  const mini = catalog.find((item) => item.model === 'seedance-2-mini')
  assert.equal(mini.label, 'Seedance 2 Mini（经济）')
  assert.equal(mini.publicNote, '管理员公开备注')
  assert.deepEqual(canvasModelCapability(catalog, 'video', 'seedance-2-mini').resolutions, ['480p', '720p'])
  assert.deepEqual(canvasModelCapability(catalog, 'video', 'seedance-2-mini').durations, [4, 8, 10, 12, 15])
})

test('画布首尾帧与全能参考互斥且全能模式完整透传图片视频音频数组', () => {
  const references = [
    { kind: 'image', url: 'https://cdn.example/first.png', slot: 'first-frame', order: 0 },
    { kind: 'image', url: 'https://cdn.example/second.png', slot: 'reference-image', order: 1 },
    { kind: 'video', url: 'https://cdn.example/motion-a.mp4', slot: 'reference-video', order: 2 },
    { kind: 'video', url: 'https://cdn.example/motion-b.mp4', slot: 'reference-video', order: 3 },
    { kind: 'audio', url: 'https://cdn.example/voice-a.mp3', slot: 'reference-audio', order: 4 },
    { kind: 'audio', url: 'https://cdn.example/voice-b.mp3', slot: 'reference-audio', order: 5 },
  ]
  assert.throws(() => buildFreeCanvasGenerationRequest({
    kind: 'video', content: '跟随参考素材', model: 'seedance-2-fast', aspectRatio: '16:9',
    duration: 8, resolution: '480p', videoReferenceMode: 'first-last', includeAudio: false,
  }, { dramaId: 7, upstreamReferences: references, capability: fastCapability }), /首尾帧模式与全能参考模式互斥/)

  const request = buildFreeCanvasGenerationRequest({
    kind: 'video', content: '跟随参考素材', model: 'seedance-2-fast', aspectRatio: '16:9',
    duration: 8, resolution: '480p', videoReferenceMode: 'omni', includeAudio: false,
  }, { dramaId: 7, upstreamReferences: references, capability: fastCapability })
  assert.equal(request.reference_mode, 'omni')
  assert.deepEqual(request.reference_image_urls, [
    'https://cdn.example/first.png',
    'https://cdn.example/second.png',
  ])
  assert.deepEqual(request.reference_video_urls, [
    'https://cdn.example/motion-a.mp4',
    'https://cdn.example/motion-b.mp4',
  ])
  assert.deepEqual(request.reference_audio_urls, [
    'https://cdn.example/voice-a.mp3',
    'https://cdn.example/voice-b.mp3',
  ])
  assert.equal(request.generate_audio, false)
  assert.equal('first_frame_url' in request, false)
  assert.equal('last_frame_url' in request, false)
})

test('首页与两种画布组件使用目录能力且缺价时保持积分门禁', () => {
  const filmList = source('src/views/FilmList.vue')
  const freeCreate = source('src/views/FreeCreate.vue')
  const generationOptions = source('src/components/dramaCanvas/CanvasGenerationOptions.vue')
  const homeNode = source('src/components/dramaCanvas/HomeCanvasNode.vue')
  const dramaCanvas = source('src/views/DramaCanvas.vue')
  const resultVideoTag = homeNode.match(/<video\s+v-else-if="data\.kind === 'video' && primaryResultUrl"[\s\S]*?\/>/)?.[0] || ''

  assert.match(filmList, /v-for="value in homeDurationOptions"/)
  assert.match(filmList, /request\.get\('\/canvas\/model-catalog'\)/)
  assert.doesNotMatch(filmList, /listGenerationCatalog/)
  assert.match(freeCreate, /v-for="value in selectedDurationOptions"/)
  assert.match(generationOptions, /aiAPI\.listCanvasModels\(\)/)
  assert.doesNotMatch(generationOptions, /request\.get\('\/canvas\/model-catalog'\)/)
  assert.doesNotMatch(generationOptions, /value="1080p"/)
  assert.match(generationOptions, /canvasModelOptions/)
  assert.doesNotMatch(generationOptions, /if \(options\.value\.videoModel\) onVideoModelChange/)
  assert.match(freeCreate, /restoringDraft/)
  assert.doesNotMatch(freeCreate, /draft = normalizeQuickGenerationDraft\(draft, selectedModel\.value/)
  assert.match(homeNode, /canvas-credit-callout-v1/)
  assert.match(homeNode, /:disabled="data\.status === 'running' \|\| !draft\.content\.trim\(\) \|\| estimatedCredits == null"/)
  assert.match(homeNode, /capability(?:\.value)?\.supportsVideoReference/)
  assert.match(homeNode, /capability(?:\.value)?\.supportsAudioReference/)
  assert.match(homeNode, /draft\.includeAudio\s*=\s*defaultFreeCanvasVideoIncludeAudio\(capability\.value\)/)
  assert.match(homeNode, /draft\.includeAudio\s*=\s*resolveFreeCanvasVideoIncludeAudio\(props\.data,\s*capability\.value\)/)
  assert.match(dramaCanvas, /capability,\s*\n\s*\}\)/)
  assert.match(dramaCanvas, /generationData\.includeAudio\s*=\s*resolveFreeCanvasVideoIncludeAudio\(generationData, capability\)/)
  assert.match(dramaCanvas, /requiresSilentVideoConfirmation\(generationData, capability\)/)
  assert.match(dramaCanvas, /当前未开启同步音频，继续后将生成无声视频/)
  assert.ok(resultVideoTag)
  assert.doesNotMatch(resultVideoTag, /\bmuted\b/)
  assert.match(dramaCanvas, /const catalogEntry = canvasModelEntry\(freeCanvasModelCatalog\.value, kind/)
  assert.match(dramaCanvas, /if \(!catalogEntry\) throw new Error\('当前节点没有已验证且已定价的可用模型'\)/)
})

test('普通项目画布保存时长并按目录能力提交完整视频合同', () => {
  const workflow = source('src/utils/canvasWorkflow.js')
  const storyboardPanel = source('src/components/dramaCanvas/CanvasStoryboardPanel.vue')
  const runner = source('src/composables/useCanvasWorkflowRunner.js')
  const dramaCanvas = source('src/views/DramaCanvas.vue')

  assert.match(workflow, /videoDuration:[^\n]*meta\.video_duration/)
  assert.match(storyboardPanel, /videoDurationOptionsForCapability/)
  assert.match(storyboardPanel, /v-for="duration in storyboardVideoDurationOptions"/)
  assert.doesNotMatch(storyboardPanel, /v-for="duration in VIDEO_DURATION_OPTIONS"/)
  assert.match(runner, /canvasModelCapability/)
  assert.match(runner, /filterCanvasCatalogFallbackModels/)
  assert.match(runner, /capability,\s*\n\s*referenceMode,/)
  assert.match(runner, /referenceVideoUrls,/)
  assert.match(runner, /referenceAudioUrls,/)
  assert.match(runner, /generateAudio:/)
  assert.match(runner, /fetchAssignedAssetReferences\(sb\.id\)/)
  assert.doesNotMatch(storyboardPanel, /allReferenceAssets\s*=\s*computed\([^\n]*\.slice\(0,\s*10\)/)
  assert.match(dramaCanvas, /video_duration:\s*current\.videoDuration/)
  assert.match(dramaCanvas, /modelCatalog:\s*freeCanvasModelCatalog\.value/)
  assert.match(dramaCanvas, /void loadFreeCanvasModelConfigs\(\)/)
  assert.doesNotMatch(dramaCanvas, /if \(standalone\) void loadFreeCanvasModelConfigs\(\)/)
})

test('管理员 ToAPIs 默认时长按模型能力显示并在模型切换时校正', () => {
  const adminConfig = source('src/components/AIConfigContent.vue')

  assert.match(adminConfig, /videoDurationOptionsForCapability/)
  assert.match(adminConfig, /v-for="duration in adminVideoDurationOptions"/)
  assert.match(adminConfig, /seedance-2-fast/)
  assert.match(adminConfig, /seedance-2-mini/)
  assert.match(adminConfig, /\[4, 8, 10, 12, 15\]/)
  assert.doesNotMatch(adminConfig, /v-for="duration in VIDEO_DURATION_OPTIONS"/)
})
