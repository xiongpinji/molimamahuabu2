import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const adminSource = fs.readFileSync(new URL('../src/views/BillingAdmin.vue', import.meta.url), 'utf8')
const redeemOperationsSource = fs.readFileSync(
  new URL('../src/components/RedeemOperationsPanel.vue', import.meta.url),
  'utf8',
)
const tenantSource = fs.readFileSync(new URL('../src/views/TenantConsole.vue', import.meta.url), 'utf8')
const aiConfigSource = fs.readFileSync(new URL('../src/views/AiConfig.vue', import.meta.url), 'utf8')
const aiConfigContentSource = fs.readFileSync(
  new URL('../src/components/AIConfigContent.vue', import.meta.url),
  'utf8',
)
const platformHeaderSource = fs.readFileSync(
  new URL('../src/components/PlatformHeader.vue', import.meta.url),
  'utf8',
)
const billingApi = fs.readFileSync(new URL('../src/api/billing.js', import.meta.url), 'utf8')
const reconciliationSource = fs.readFileSync(
  new URL('../src/components/BillingReconciliationPanel.vue', import.meta.url),
  'utf8',
)
const reconciliationApi = fs.readFileSync(
  new URL('../src/api/billingReconciliation.js', import.meta.url),
  'utf8',
)
const routerSource = fs.readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8')
const dramaCanvasSource = fs.readFileSync(new URL('../src/views/DramaCanvas.vue', import.meta.url), 'utf8')
const homeCanvasNodeSource = fs.readFileSync(
  new URL('../src/components/dramaCanvas/HomeCanvasNode.vue', import.meta.url),
  'utf8',
)

test('统一管理后台提供账号、兑换码、积分、对账和模型计费入口', () => {
  for (const label of ['账号管理', '兑换码', '积分流水', '积分对账', '模型计费']) {
    assert.match(adminSource, new RegExp(label))
  }
  assert.doesNotMatch(adminSource, /订阅套餐/)
  assert.match(redeemOperationsSource, /createRedeemCodes/)
  assert.match(adminSource, /adjustTenantCredits/)
  assert.match(adminSource, /updatePlatformUser/)
})

test('模型收费、兑换码生成和用户兑换都有明确入口与字段', () => {
  assert.match(aiConfigSource, /设置模型收费/)
  assert.match(aiConfigSource, /生成兑换码/)
  assert.match(platformHeaderSource, /兑换积分/)
  assert.match(platformHeaderSource, /section:\s*'redeem'/)
  for (const label of ['用户收费（积分）', '平台成本单位', '单位成本（元）', '千输入 Token 成本（元）']) {
    assert.match(adminSource, new RegExp(label.replace(/[（）]/g, '\\$&')))
  }
  for (const label of ['生成数量', '适用工作区', '每次兑换积分', '每码可兑换次数', '到期时间']) {
    assert.match(redeemOperationsSource, new RegExp(label))
  }
  assert.match(tenantSource, /id="redeem-credits"/)
  assert.match(aiConfigContentSource, /设置定价/)
  assert.match(aiConfigContentSource, /tab:\s*'models'/)
  assert.match(aiConfigContentSource, /model:/)
})

test('租户控制台使用兑换码而不是创建支付订单', () => {
  assert.match(tenantSource, /兑换码/)
  assert.match(tenantSource, /redeemCredits/)
  assert.doesNotMatch(tenantSource, /createBillingOrder/)
  assert.doesNotMatch(tenantSource, /待支付订单/)
})

test('用户端明确分开展示积分消耗明细和积分兑换记录', () => {
  assert.match(tenantSource, /积分消耗明细/)
  assert.match(tenantSource, /积分兑换记录/)
  assert.match(tenantSource, /consumptionTransactions/)
  assert.match(tenantSource, /redemptionTransactions/)
})

test('公开平台管理员登录后无需再次输入静态管理令牌', () => {
  assert.match(adminSource, /requiresAdminToken/)
  assert.match(adminSource, /onMounted/)
  assert.match(adminSource, /modelSearch\.value\s*=\s*requestedModel/)
})

test('前端 API 覆盖兑换和管理员控制接口', () => {
  for (const endpoint of [
    '/billing/redeem',
    '/billing/credit-transactions',
    '/billing/admin/users',
    '/billing/admin/tenants',
    '/billing/admin/redeem-codes',
    '/billing/admin/credit-transactions',
    '/billing/admin/reconciliation/anomalies',
    '/billing/admin/reconciliation/history',
  ]) {
    assert.match(`${billingApi}\n${reconciliationApi}`, new RegExp(endpoint.replaceAll('/', '\\/')))
  }
  assert.match(reconciliationApi, /reconciliation\/\$\{encodeURIComponent\(reservationId\)\}\/refund/)
  assert.match(reconciliationSource, /refundReconciliationReservation/)
  assert.match(reconciliationSource, /row\.refundable/)
  assert.match(adminSource, /BillingReconciliationPanel/)
})

test('未配置的默认模型首次保存时按启用状态提交', () => {
  assert.match(
    adminSource,
    /status:\s*item\.status === 'unconfigured' \? 'enabled' : item\.status/,
  )
})

test('模型中转关联只在管理员模型配置页呈现', () => {
  assert.match(aiConfigContentSource, /模型 → 中转站/)
  assert.match(aiConfigContentSource, /buildAiConfigRelayAssociations/)
  assert.match(aiConfigContentSource, /\{\{\s*association\.model\s*\}\}[\s\S]*\{\{\s*association\.detail\s*\}\}/)
  assert.doesNotMatch(aiConfigContentSource, /v-html/)
  assert.match(
    routerSource,
    /path:\s*['"]\/ai-config['"][\s\S]*?roles:\s*\['admin'\][\s\S]*?requiresAuth:\s*true/,
  )
  for (const publicCanvasSource of [dramaCanvasSource, homeCanvasNodeSource]) {
    assert.doesNotMatch(
      publicCanvasSource,
      /模型 → 中转站|buildAiConfigRelayAssociations|未识别域名|hostname|#configId/,
    )
  }
})

test('管理端支持批量签发后一次性本地导出并清除明文', () => {
  assert.match(adminSource, /RedeemOperationsPanel/)
  assert.match(redeemOperationsSource, /批量生成并导出/)
  assert.match(redeemOperationsSource, /createRedeemCodes/)
  assert.match(redeemOperationsSource, /URL\.createObjectURL/)
  assert.match(redeemOperationsSource, /URL\.revokeObjectURL/)
  assert.match(redeemOperationsSource, /delete item\.code/)
  assert.doesNotMatch(redeemOperationsSource, /localStorage.*code/i)
  assert.match(billingApi, /\/billing\/admin\/redeem-codes\/batch/)
})

test('管理端可维护有效期并查询兑换人时间与账本', () => {
  assert.match(redeemOperationsSource, /保存有效期/)
  assert.match(redeemOperationsSource, /兑换明细/)
  assert.match(redeemOperationsSource, /兑换用户/)
  assert.match(redeemOperationsSource, /兑换时间/)
  assert.match(redeemOperationsSource, /账本记录/)
  assert.match(redeemOperationsSource, /listRedeemCodeUsages/)
  assert.match(billingApi, /\/billing\/admin\/redeem-codes\/\$\{encodeURIComponent\(codeId\)\}\/usages/)
})

test('批量签发可选择平台通用或指定租户且列表显示绑定目标', () => {
  assert.match(redeemOperationsSource, /平台通用/)
  assert.match(redeemOperationsSource, /指定租户/)
  assert.match(redeemOperationsSource, /newCode\.tenant_id/)
  assert.match(redeemOperationsSource, /row\.tenant_id/)
})
