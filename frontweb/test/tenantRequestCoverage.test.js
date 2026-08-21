import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const filmCreateSource = fs.readFileSync(new URL('../src/views/FilmCreate.vue', import.meta.url), 'utf8')
const billingAdminSource = fs.readFileSync(new URL('../src/views/BillingAdmin.vue', import.meta.url), 'utf8')
const accountBadgeSource = fs.readFileSync(new URL('../src/components/AccountBadge.vue', import.meta.url), 'utf8')
const storyboardsApiSource = fs.readFileSync(new URL('../src/api/storyboards.js', import.meta.url), 'utf8')

test('租户业务请求统一经过会注入租户头的 request 客户端', () => {
  assert.match(filmCreateSource, /import request from '@\/utils\/request'/)
  assert.doesNotMatch(filmCreateSource, /import\('axios'\)/)
  assert.doesNotMatch(filmCreateSource, /fetch\('\/api\/v1\/audio\/extract'/)
  assert.match(storyboardsApiSource, /applyTenantHeader\(applyAuthHeader\(/)
})

test('支付搁置后管理后台不再暴露套餐和币种配置', () => {
  assert.doesNotMatch(billingAdminSource, /订阅套餐/)
  assert.doesNotMatch(billingAdminSource, /newPlan/)
  assert.doesNotMatch(billingAdminSource, /plan\.currency/)
})

test('账户余额加载失败会显示明确状态', () => {
  assert.match(accountBadgeSource, /v-if="accountError"/)
  assert.match(accountBadgeSource, /accountError\.value\s*=/)
})
