import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeCanvasModelCatalog } from '../src/utils/canvasModelCapabilities.js'

const source = fs.readFileSync(new URL('../src/views/FilmCreate.vue', import.meta.url), 'utf8')
const aiApiSource = fs.readFileSync(new URL('../src/api/ai.js', import.meta.url), 'utf8')

test('FilmCreate 依赖的统一目录以能力与价格取交集：GPT 去掉 4K，Nano 保留 4K', () => {
  const catalog = normalizeCanvasModelCatalog([
    {
      kind: 'image', model: 'gpt-image-2-2-4k', protocol: 'usmercari_image', verification_status: 'verified',
      resolution_prices: { '1k': { credits: 70 }, '2k': { credits: 87 }, '4k': { credits: 105 } },
      capabilities: { resolutions: ['1k', '2k'] },
    },
    {
      kind: 'image', model: 'nano-banana-2', protocol: 'usmercari_image', verification_status: 'verified',
      resolution_prices: { '1k': { credits: 70 }, '2k': { credits: 87 }, '4k': { credits: 105 } },
      capabilities: { resolutions: ['1k', '2k', '4k'] },
    },
  ])
  const gpt = catalog.find((item) => item.model === 'gpt-image-2-2-4k')
  const nano = catalog.find((item) => item.model === 'nano-banana-2')
  assert.deepEqual(gpt.capabilities.resolutions, ['1k', '2k'])
  assert.deepEqual(Object.keys(gpt.resolutionPrices), ['1k', '2k'])
  assert.deepEqual(nano.capabilities.resolutions, ['1k', '2k', '4k'])
  assert.deepEqual(Object.keys(nano.resolutionPrices), ['1k', '2k', '4k'])
})

test('短剧工厂从统一目录读取图片模型的名称、备注、能力与分档价格', () => {
  assert.match(source, /aiAPI\.listCanvasModels\(\)/)
  assert.match(aiApiSource, /listCanvasModels\(\)\s*\{[\s\S]*request\.get\('\/canvas\/model-catalog'\)/)
  assert.match(source, /normalizeCanvasModelCatalog/)
  assert.match(source, /imageModelCatalog\.value\.filter\(\(item\) => item\.kind === 'image'\)/)
  assert.match(source, /selectedImageModelMetadata\.value\?\.publicNote/)
  assert.match(source, /selectedImageModelMetadata\.value\?\.capabilities\?\.resolutions/)
  assert.match(source, /selectedImageModelMetadata\.value\?\.resolutionPrices/)
  assert.doesNotMatch(source, /\.filter\([^\n]*verification_status/)
})

test('短剧工厂显示图片模型和可用档位，并用档位价格显示受保护的积分提示', () => {
  assert.match(source, /v-model="selectedImageModel"/)
  assert.match(source, /v-model="imageResolution"/)
  assert.match(source, /v-for="resolution in selectedImageResolutionOptions"/)
  assert.match(source, /selectedImageModelPublicNote/)
  assert.match(source, /canvas-credit-callout-v1/)
  assert.match(source, /本次预计扣除/)
  assert.match(source, /（单张）/)
  assert.match(source, /积分待管理员配置/)
  assert.match(source, /estimateCanvasCredits\([\s\S]*imageResolution\.value/)
})

test('短剧工厂阻止没有有效单张积分价格的图片模型提交', () => {
  assert.match(source, /const estimatedCredits = usesTiers[\s\S]*\? estimateCanvasCredits\(/)
  assert.match(source, /: Number\(entry\.credits\)/)
  assert.match(source, /if \(!Number\.isSafeInteger\(estimatedCredits\) \|\| estimatedCredits <= 0\)/)
  assert.match(source, /当前图片模型尚未配置有效积分价格/)
})

test('USMercari 的生图请求统一传送同一 model 与小写 resolution，旧模型不强制分档', () => {
  assert.match(source, /function requireImageGenerationOptions\(/)
  assert.match(source, /const resolution = usesTiers[\s\S]*\.toLowerCase\(\)/)
  assert.match(source, /return usesTiers \? \{ model: entry\.model, resolution \} : \{ model: entry\.model \}/)

  assert.match(source, /request\.post\(`\/characters\/\$\{char\.id\}\/generate-image`,\s*\{[\s\S]*\.\.\.imageOptions/)
  assert.match(source, /request\.post\(`\/props\/\$\{prop\.id\}\/generate`,\s*\{[\s\S]*\.\.\.imageOptions/)
  assert.match(source, /sceneAPI\.generateImage\(\{[\s\S]*\.\.\.imageOptions/)

  const imageCreateOffsets = [...source.matchAll(/imagesAPI\.create\(\{/g)].map((match) => match.index)
  assert.equal(imageCreateOffsets.length, 6)
  for (const offset of imageCreateOffsets) {
    assert.match(source.slice(offset, offset + 1200), /\.\.\.imageOptions/)
  }

  assert.doesNotMatch(source, /characterAPI\.generateImage\([^\n]*undefined/)
  assert.doesNotMatch(source, /propAPI\.generateImage\([\s\S]{0,180}?undefined/)
  assert.doesNotMatch(source, /sceneAPI\.generateImage\(\{[\s\S]{0,180}?model:\s*undefined/)
  assert.doesNotMatch(source, /imagesAPI\.create\(\{[\s\S]{0,500}?model:\s*undefined/)
})

test('单次、批量、一键全流程与修复重试在提交前都执行同一图片模型门禁', () => {
  for (const functionName of [
    'onGenerateCharacterImage',
    'onGeneratePropImage',
    'onGenerateSceneImage',
    'onGenerateSbFrameImage',
    'onGenerateSbImage',
    'onRegenAffectedSbImages',
    'startBatchImageGeneration',
    'runOneClickPipeline',
    'runRepairPipeline',
  ]) {
    const start = source.indexOf(`function ${functionName}(`)
    assert.notEqual(start, -1, `missing ${functionName}`)
    assert.match(source.slice(start, start + 1600), /requireImageGenerationOptions\(\)/, `${functionName} must preflight image model`)
  }
})

test('分镜单图和首尾帧轮询进入 needs_attention 时不得走生成完成成功分支', () => {
  assert.match(source, /function handleImageGenerationTerminal\(/)
  assert.match(source, /shouldStopBatchOnGenerationResult\(pollRes\)/)
  for (const functionName of ['onGenerateSbFrameImage', 'onGenerateSbImage']) {
    const start = source.indexOf(`async function ${functionName}(`)
    assert.notEqual(start, -1, `missing ${functionName}`)
    const body = source.slice(start, start + 5200)
    assert.match(body, /handleImageGenerationTerminal\(sb,\s*pollRes/)
  }
})
