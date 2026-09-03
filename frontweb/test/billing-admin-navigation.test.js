import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const billingView = fs.readFileSync(new URL('../src/views/BillingAdmin.vue', import.meta.url), 'utf8')
const aiConfig = fs.readFileSync(new URL('../src/components/AIConfigContent.vue', import.meta.url), 'utf8')

test('模型配置的设置定价入口携带当前中转站配置 ID', () => {
  const openPricing = aiConfig.slice(
    aiConfig.indexOf('function openPricing'),
    aiConfig.indexOf('// ---- 生成设置 ----'),
  )
  assert.match(openPricing, /config_id:\s*row\.id/)
})

test('运营计费直达时模型列表独立加载且辅助接口失败不阻断模型定价', () => {
  const loadAll = billingView.slice(
    billingView.indexOf('async function loadAll'),
    billingView.indexOf('async function syncProviderPricingNow'),
  )
  assert.match(loadAll, /await listModelPrices\(\)/)
  assert.match(loadAll, /Promise\.allSettled/)
  assert.match(loadAll, /prices\.value\s*=/)
})

test('运营计费读取配置 ID 并按该中转站过滤模型', () => {
  assert.match(billingView, /route\.query\.config_id/)
  assert.match(billingView, /filterModelPricesByProviderConfig/)
})
