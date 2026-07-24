const test = require('node:test')
const assert = require('node:assert/strict')
const Database = require('better-sqlite3')

const billingRoutes = require('../src/routes/billing')
const auth = require('../src/services/userAuthService')
const credits = require('../src/services/creditLedgerService')
const tenants = require('../src/services/tenantService')

test('管理员调账忽略 body 伪造操作者并把当前登录用户写入 adjustment', () => {
  const db = new Database(':memory:')
  auth.ensureSchema(db)
  tenants.ensureSchema(db)
  credits.ensureSchema(db)
  const actor = auth.register(db, {
    email: 'admin@example.com',
    password: 'correct horse battery staple',
  })
  const tenant = tenants.createTenant(db, actor.id, { name: '审计团队', slug: 'audit-team' })
  credits.setTenantAccountBalance(db, tenant.id, 0)

  const handler = billingRoutes(db, { error() {} }).adjustAdminTenantCredits
  const req = {
    user: { id: actor.id, role: 'admin' },
    params: { tenantId: tenant.id },
    body: { amount: 25, reason: '安全审计', actorUserId: 'forged-user' },
  }
  const res = {
    status() { return this },
    json(payload) { this.payload = payload; return this },
  }
  handler(req, res)

  assert.equal(res.payload.success, true)
  assert.equal(
    db.prepare('SELECT actor_user_id FROM tenant_credit_adjustments').get().actor_user_id,
    actor.id,
  )
  db.close()
})
