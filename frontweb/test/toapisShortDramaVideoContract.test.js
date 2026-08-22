import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/views/FilmCreate.vue', import.meta.url), 'utf8')
const requestBuilderSource = fs.readFileSync(new URL('../src/utils/videoGenerationRequest.js', import.meta.url), 'utf8')

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `missing ${name}`)
  const end = nextName ? source.indexOf(`function ${nextName}(`, start + 1) : source.length
  assert.notEqual(end, -1, `missing ${nextName}`)
  return source.slice(start, end)
}

function buttonSource(clickHandler) {
  const click = source.indexOf(`@click="${clickHandler}"`)
  assert.notEqual(click, -1, `missing ${clickHandler} button`)
  const start = source.lastIndexOf('<el-button', click)
  const end = source.indexOf('</el-button>', click)
  return source.slice(start, end)
}

test('短剧工厂视频模型仅使用统一目录的展示名、备注、能力和分档价格', () => {
  assert.match(source, /aiAPI\.listCanvasModels\(\)/)
  assert.doesNotMatch(source, /request\.get\('\/canvas\/model-catalog'\)/)
  assert.match(source, /videoModelCatalog\.value\.filter\(\(item\) => item\.kind === 'video'\)/)
  assert.match(source, /selectedVideoModelMetadata\.value\?\.publicNote/)
  assert.match(source, /entry\?\.capabilities\?\.resolutions/)
  assert.match(source, /entry\?\.resolutionPrices/)
  assert.match(source, /v-for="item in videoModelOptions"[\s\S]{0,180}:label="item\.label"[\s\S]{0,120}:value="item\.model"/)
})

test('短剧视频模型、声线策略和请求审计都只依赖统一公开目录', () => {
  assert.match(source, /import \{ aiAPI \} from ['"]@\/api\/ai['"]/)
  assert.doesNotMatch(source, /aiAPI\.listVideoModels|activeVideoAiConfig/)
  assert.match(
    functionSource('loadVideoModelOptions', 'onVideoModelChange'),
    /aiAPI\.listCanvasModels\(\)/,
  )
  assert.match(
    functionSource('videoCatalogPublicConfig', 'getStoryboardVoicePolicy'),
    /videoModelMetadata[\s\S]*api_protocol: entry\.protocol/,
  )
  assert.match(
    functionSource('getStoryboardVoicePolicy', 'getStoryboardVoicePromptPreview'),
    /videoCatalogPublicConfig[\s\S]*videoVoicePolicyForConfig/,
  )
  assert.match(
    functionSource('buildSbVideoRequestContext', 'onPreviewSbVideoRequest'),
    /config: videoCatalogPublicConfig\(sbModel\)/,
  )
})

test('Mini 不显示 5 秒且 Mini/Fast 只显示目录已验证已定价的 480P/720P', () => {
  assert.match(source, /selectedVideoResolutionOptions/)
  assert.match(source, /selectedVideoDurationOptions/)
  assert.match(source, /v-for="resolution in selectedVideoResolutionOptions"/)
  assert.match(source, /v-for="duration in selectedVideoDurationOptions"/)
  assert.match(source, /assertVideoDurationAllowed\(/)
  assert.match(source, /当前视频模型不支持/)
  assert.doesNotMatch(source, /if \(!priced\.length\) return \[\.\.\.new Set\(declared\)\]/)
  assert.match(source, /video_resolution: videoResolution\.value/)
  assert.match(source, /d\.metadata\.video_resolution/)
  assert.match(
    functionSource('loadVideoModelOptions', 'onVideoModelChange'),
    /if \(!selectedVideoModel\.value && models\.length\)[\s\S]*syncVideoSelectionForModel\(selectedVideoModel\.value\)/,
  )
  assert.match(source, /if \(!value \|\| !videoModelMetadata\(value\)\)[\s\S]*已失效，请重新选择后生成/)
})

test('单条、批量、一键流水线和修复缺失全部通过 buildSbVideoRequestContext 提交', () => {
  const paths = [
    ['onGenerateSbVideo', 'onLinkTailFrameToNext'],
    ['startBatchVideoGeneration', 'getFinalizeMergeOptions'],
    ['runOneClickPipeline', 'runRepairPipeline'],
    ['runRepairPipeline', null],
  ]
  for (const [name, nextName] of paths) {
    const body = functionSource(name, nextName)
    assert.match(body, /buildSbVideoRequestContext\(sb/)
    assert.match(body, /videosAPI\.create\(requestContext\.payload\)/)
  }
  assert.doesNotMatch(source, /videosAPI\.create\(\s*\{/)
  const singleBody = functionSource('onGenerateSbVideo', 'onLinkTailFrameToNext')
  const previewBody = functionSource('onPreviewSbVideoRequest', 'onStoryboardVideoModelChange')
  assert.doesNotMatch(singleBody, /canUseUniversalOmniVideoApi|confirmUniversalNonSeedance2Video/)
  assert.doesNotMatch(previewBody, /canUseUniversalOmniVideoApi/)
  assert.match(singleBody, /const universalOmniApi = universal/)
})

test('全能模式透传真实存在的完整参考数组，首尾帧模式不混传全能参考', () => {
  const body = functionSource('buildSbVideoRequestContext', 'onPreviewSbVideoRequest')
  assert.match(body, /referenceImageUrls:/)
  assert.match(body, /referenceVideoUrls[, :]/)
  assert.match(body, /referenceAudioUrls[, :]/)
  assert.match(body, /referenceMode[, :]/)
  assert.match(body, /generateAudio:/)
  assert.match(body, /capability[, :]/)
  assert.match(body, /supportsAudioReference/)
  assert.match(body, /const referenceImageUrls = useOmni \? referenceUrls : undefined/)
  assert.doesNotMatch(source, /sb\?\.reference_video_urls/)
  assert.match(requestBuilderSource, /reference_video_urls: referenceVideoUrlList/)
})

test('受保护的画布积分提示合同未被弱化', () => {
  assert.match(source, /canvas-credit-callout-v1/)
  assert.match(source, /本次预计扣除/)
  assert.match(source, /积分待管理员配置/)
})

test('短剧视频显示按清晰度和时长计算的醒目积分，缺价时所有批量入口二次拦截', () => {
  assert.match(source, /const selectedVideoGenerationCredits = computed\(\(\) => videoGenerationCreditsFor\(/)
  assert.match(source, /selectedVideoGenerationReady/)
  assert.match(source, /canvas-credit-callout-v1: 视频生成/)
  assert.match(
    functionSource('videoGenerationCreditsFor', 'isUsmercariImageModelEntry'),
    /videoResolutionOptionsForModel\(model\)[\s\S]*return null/,
  )
  for (const [name, nextName] of [
    ['startBatchVideoGeneration', 'getFinalizeMergeOptions'],
    ['startOneClickPipeline', 'startTextFrameworkPipeline'],
    ['startRepairPipeline', 'runRepairPipeline'],
  ]) {
    assert.match(functionSource(name, nextName), /requireSelectedVideoGenerationReady\(\)/)
  }
  assert.doesNotMatch(buttonSource('startBatchImageGeneration'), /selectedVideoGenerationReady/)
  assert.match(buttonSource('startBatchVideoGeneration'), /selectedVideoGenerationReady/)
})

test('全能参考先完整收集再按目录能力显式拒绝超限，不静默截断', () => {
  const collectBody = functionSource('collectSbOmniReferenceAbsoluteUrls', 'collectSbSceneOnlyReferenceAbsoluteUrls')
  const requestBody = functionSource('buildSbVideoRequestContext', 'onPreviewSbVideoRequest')
  assert.doesNotMatch(collectBody, /\.slice\(/)
  assert.doesNotMatch(requestBody, /\.slice\(/)
  assert.doesNotMatch(requestBuilderSource, /\.slice\(/)
  assert.match(requestBody, /最多支持/)
  assert.match(requestBody, /capability\.maxReferences/)
  assert.match(requestBody, /capability\.maxVideoReferences/)
  assert.match(requestBody, /capability\.maxAudioReferences/)
})
