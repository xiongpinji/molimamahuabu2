const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '../src/routes/index.js'), 'utf8')

test('兑换码管理路由仅要求兑换码权限，不要求总管理员令牌', () => {
  for (const route of [
    "r.get('/billing/admin/redeem-codes'",
    "r.post('/billing/admin/redeem-codes'",
    "r.post('/billing/admin/redeem-codes/batch'",
    "r.get('/billing/admin/redeem-codes/:codeId/usages'",
    "r.put('/billing/admin/redeem-codes/:codeId'",
  ]) {
    const line = source.split(/\r?\n/).find((item) => item.includes(route))
    assert.ok(line, `缺少路由 ${route}`)
    assert.match(line, /requireRedeemCodeManager/)
    assert.doesNotMatch(line, /requireAdmin/)
  }
})

test('模型、台账、积分和对账路由要求总管理员及财务管理权限', () => {
  for (const route of [
    '/billing/admin/tenants',
    '/billing/admin/credit-transactions',
    '/billing/admin/ledger/settings',
    '/billing/admin/ledger/report',
    '/billing/admin/reconciliation/anomalies',
    '/billing/admin/plans',
    '/billing/prices',
  ]) {
    const line = source.split(/\r?\n/).find((item) => item.includes(`'${route}'`))
    assert.ok(line, `缺少路由 ${route}`)
    assert.match(line, /requireAdmin/)
    assert.match(line, /requireBillingManager/)
  }
})
