import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const adminSource = fs.readFileSync(new URL('../src/views/BillingAdmin.vue', import.meta.url), 'utf8')
const nodeSource = fs.readFileSync(new URL('../src/components/dramaCanvas/HomeCanvasNode.vue', import.meta.url), 'utf8')
const canvasSource = fs.readFileSync(new URL('../src/views/DramaCanvas.vue', import.meta.url), 'utf8')
const freeCreateSource = fs.readFileSync(new URL('../src/views/FreeCreate.vue', import.meta.url), 'utf8')
const filmListSource = fs.readFileSync(new URL('../src/views/FilmList.vue', import.meta.url), 'utf8')

test('管理端提供 480P、720P 和 1080P 的积分及每秒成本配置', () => {
  assert.match(adminSource, /const videoResolutionLabels\s*=\s*\{[\s\S]*'480p': '480P'[\s\S]*'720p': '720P'[\s\S]*'1080p': '1080P'/)
  assert.match(adminSource, /v-for="resolution in resolutionKeys\(item\)"/)
  assert.match(adminSource, /videoResolutionLabels\[resolution\][\s\S]*用户收费/)
  assert.match(adminSource, /videoResolutionLabels\[resolution\][\s\S]*API 成本/)
  assert.match(adminSource, /resolution_prices/)
})

test('管理端 Wan3 价格编辑器展示和提交批准的 480P、720P、1080P', () => {
  assert.match(adminSource, /function isWan3VideoPricing\(item\)/)
  assert.match(adminSource, /const videoResolutionLabels/)
  assert.match(adminSource, /function providerVideoResolutionKeys\(item\)[\s\S]*provider_costs[\s\S]*resolution_prices/)
  assert.match(adminSource, /return usesVideoResolutionPricing\(itemOrCategory\)\s*\?\s*providerVideoResolutionKeys\(itemOrCategory\)\s*:\s*\[\]/s)
  assert.match(adminSource, /v-for="resolution in resolutionKeys\(item\)"[\s\S]*?item\.resolution_prices\[resolution\]\.cost_yuan_per_second/)
  assert.match(adminSource, /v-for="resolution in resolutionKeys\(newModel\)"[\s\S]*?newModel\.resolution_prices\[resolution\]\.cost_yuan_per_second/)
  assert.doesNotMatch(adminSource, /resolution_prices\['720p'\]/)
  assert.match(adminSource, /resolutionPricePayload\(item\)/)
  assert.match(adminSource, /Object\.fromEntries\(resolutionKeys\(item\)\.map/)
})

test('画布积分提示保留受保护合同并传递节点分辨率', () => {
  assert.match(nodeSource, /class="billing-cost canvas-credit-callout-v1"\s+aria-live="polite"/)
  assert.match(nodeSource, /本次预计扣除/)
  assert.match(nodeSource, /积分待管理员配置/)
  assert.doesNotMatch(nodeSource, /class="billing-note"/)
  assert.match(nodeSource, /\.billing-cost\s*\{/)
  assert.match(nodeSource, /\.billing-cost strong\s*\{/)
  assert.match(nodeSource, /draft\.resolution/)
  assert.match(canvasSource, /estimateCanvasCredits\([^)]*resolution/s)
})

test('首页和自由创作的预计积分都传递当前视频分辨率', () => {
  assert.match(filmListSource, /duration:\s*homeDuration\.value,\s*resolution:\s*homeResolution\.value/s)
  assert.match(freeCreateSource, /duration:\s*duration\.value,\s*resolution:\s*resolution\.value/s)
})
