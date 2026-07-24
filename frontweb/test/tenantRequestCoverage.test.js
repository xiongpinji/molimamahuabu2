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

test('套餐管理允许配置币种而不是固定为人民币', () => {
  assert.match(billingAdminSource, /v-model(?:\.trim)?="plan\.currency"/)
  assert.match(billingAdminSource, /v-model(?:\.trim)?="newPlan\.currency"/)
  assert.match(billingAdminSource, /currency:\s*String\(newPlan\.currency/)
})

test('账户余额加载失败会显示明确状态', () => {
  assert.match(accountBadgeSource, /v-if="accountError"/)
  assert.match(accountBadgeSource, /accountError\.value\s*=/)
})
