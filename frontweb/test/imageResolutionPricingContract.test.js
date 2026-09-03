import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/views/BillingAdmin.vue', import.meta.url), 'utf8')

test('USMercari 图片模型按 1K 2K 4K 分档编辑积分与人民币每张成本', () => {
  assert.match(source, /1K 用户收费（积分\/张）/)
  assert.match(source, /1K API 成本（人民币元\/张）/)
  assert.match(source, /2K 用户收费（积分\/张）/)
  assert.match(source, /2K API 成本（人民币元\/张）/)
  assert.match(source, /4K 用户收费（积分\/张）/)
  assert.match(source, /4K API 成本（人民币元\/张）/)
  assert.match(source, /cost_micros_per_unit/)
})

test('GPT 图片模型不暴露 4K 档但 Nano 保留 4K', () => {
  assert.match(source, /GPT_IMAGE_MODEL_ID\s*=\s*'gpt-image-2-2-4k'/)
  assert.match(source, /if \(!usesImageResolutionPricing\(itemOrCategory\)\) return \[\][\s\S]*model === GPT_IMAGE_MODEL_ID[\s\S]*\['1k', '2k'\][\s\S]*\['1k', '2k', '4k'\]/)
})

test('只有两个 USMercari 图片模型启用分档且其他图片保留单一价格', () => {
  assert.match(source, /function usesImageResolutionPricing\(item\)[\s\S]*item\?\.category === 'image'[\s\S]*USMERCARI_IMAGE_MODELS\.has/)
  assert.match(source, /v-if="usesImageResolutionPricing\(item\)"/)
  assert.match(source, /v-if="!usesVideoResolutionPricing\(item\) && !usesImageResolutionPricing\(item\)"/)
  assert.match(source, /v-if="usesImageResolutionPricing\(newModel\)"/)
  assert.match(source, /v-if="!usesVideoResolutionPricing\(newModel\) && !usesImageResolutionPricing\(newModel\)"/)
})

test('公开备注会显示并跟随价格配置保存', () => {
  assert.match(source, /用户公开备注/)
  assert.match(source, /v-model="item\.public_note"/)
  assert.match(source, /v-model\.trim="newModel\.public_note"/)
  assert.match(source, /public_note:\s*item\.public_note/)
  assert.match(source, /public_note:\s*newModel\.public_note/)
})

test('视频模型保留分档且 Wan3 增加 1080P 每秒分档', () => {
  assert.match(source, /const videoResolutionLabels\s*=\s*\{[\s\S]*'480p': '480P'[\s\S]*'720p': '720P'[\s\S]*'1080p': '1080P'/)
  assert.match(source, /videoResolutionLabels\[resolution\][\s\S]*用户收费（积分\/秒）/)
  assert.match(source, /videoResolutionLabels\[resolution\][\s\S]*API 成本（元\/秒）/)
  assert.match(source, /providerVideoResolutionKeys\(itemOrCategory\)/)
})
