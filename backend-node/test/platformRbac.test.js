const test = require('node:test')
const assert = require('node:assert/strict')
const Database = require('better-sqlite3')

const auth = require('../src/services/userAuthService')
const createAuthRoutes = require('../src/routes/auth')
const admin = require('../src/services/platform-admin-service')
const { createUserAuthMiddleware } = require('../src/middleware/userAuth')
const { createAdminAuthMiddleware } = require('../src/middleware/adminAuth')
const {
  PERMISSIONS,
  createPlatformPermissionMiddleware,
} = require('../src/middleware/platformRbac')

const SECRET = 's'.repeat(32)

function createDb() {
  const db = new Database(':memory:')
  auth.ensureSchema(db)
  const users = {}
  for (const [name, role] of [
    ['admin', 'admin'],
    ['secondAdmin', 'admin'],
    ['ops', 'ops'],
    ['support', 'support'],
    ['reader', 'read_only'],
    ['redeemAdmin', 'redeem_admin'],
    ['user', 'user'],
  ]) {
    const created = auth.register(db, {
      email: `${name.toLowerCase()}@example.com`,
      password: 'correct horse battery staple',
    })
    db.prepare('UPDATE platform_users SET platform_role = ? WHERE id = ?').run(role, created.id)
    users[name] = created.id
  }
  return { db, users }
}

function runPermission(role, permission) {
  const req = { user: { id: 'actor', role } }
  const result = { status: null, body: null, next: false }
  const res = {
    status(code) { result.status = code; return this },
    json(body) { result.body = body; return this },
  }
  createPlatformPermissionMiddleware(permission)(req, res, () => { result.next = true })
  return result
}

function runUserAuth(db, token) {
  const req = { get: (name) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : '' }
  const result = { status: null, body: null, next: false }
  const res = {
    status(code) { result.status = code; return this },
    json(body) { result.body = body; return this },
  }
  createUserAuthMiddleware({ enabled: true, secret: SECRET, db })(req, res, () => { result.next = true })
  return { req, result }
}

function captureResponse() {
  const result = { status: null, body: null, cookie: null }
  return {
    result,
    res: {
      status(code) { result.status = code; return this },
      json(body) { result.body = body; return this },
      cookie(name, value, options) {
        result.cookie = { name, value, options }
        return this
      },
    },
  }
}

test('admin/ops/support/read-only 严格符合账号管理权限矩阵', () => {
  const allowed = {
    admin: Object.values(PERMISSIONS),
    ops: [PERMISSIONS.USERS_READ, PERMISSIONS.USERS_STATUS, PERMISSIONS.USERS_FORCE_LOGOUT],
    support: [PERMISSIONS.USERS_READ, PERMISSIONS.USERS_FORCE_LOGOUT],
    read_only: [PERMISSIONS.USERS_READ],
    redeem_admin: [PERMISSIONS.REDEEM_CODES_MANAGE],
    user: [],
  }
  for (const role of Object.keys(allowed)) {
    for (const permission of Object.values(PERMISSIONS)) {
      const result = runPermission(role, permission)
      assert.equal(result.next, allowed[role].includes(permission), `${role} -> ${permission}`)
      if (!allowed[role].includes(permission)) {
        assert.equal(result.status, 403)
        assert.equal(result.body.error.code, 'PLATFORM_PERMISSION_DENIED')
      }
    }
  }
})

test('兑换码管理员只能管理兑换码，不能读取财务、模型或账号数据', () => {
  assert.equal(runPermission('redeem_admin', PERMISSIONS.REDEEM_CODES_MANAGE).next, true)
  for (const permission of [
    PERMISSIONS.BILLING_MANAGE,
    PERMISSIONS.USERS_READ,
    PERMISSIONS.USERS_ROLE,
    PERMISSIONS.USERS_STATUS,
    PERMISSIONS.USERS_FORCE_LOGOUT,
  ]) {
    const denied = runPermission('redeem_admin', permission)
    assert.equal(denied.status, 403)
    assert.equal(denied.body.error.code, 'PLATFORM_PERMISSION_DENIED')
  }
})

test('总管理员可以授予兑换码管理员角色', () => {
  const { db, users } = createDb()
  const changed = admin.changeUserRole(db, {
    actorUserId: users.admin,
    targetUserId: users.user,
    role: 'redeem_admin',
  })
  assert.equal(changed.role, 'redeem_admin')
  assert.equal(changed.token_version, 1)
  db.close()
})

test('强制退出递增账号版本并使旧 JWT 立即失效', () => {
  const { db, users } = createDb()
  const current = auth.getUserById(db, users.user)
  const token = auth.issueToken(current, SECRET, auth.getTokenVersion(db, current.id))
  assert.equal(runUserAuth(db, token).result.next, true)

  const changed = admin.forceLogout(db, {
    actorUserId: users.support,
    targetUserId: users.user,
  })
  assert.equal(changed.token_version, 1)
  const rejected = runUserAuth(db, token)
  assert.equal(rejected.result.status, 401)
  assert.equal(rejected.result.body.error.code, 'UNAUTHORIZED')
  db.close()
})

test('暂停再恢复后旧 JWT 仍失效，且当前数据库角色覆盖令牌快照', () => {
  const { db, users } = createDb()
  const current = auth.getUserById(db, users.user)
  const token = auth.issueToken(current, SECRET, auth.getTokenVersion(db, current.id))

  admin.changeUserStatus(db, {
    actorUserId: users.ops,
    targetUserId: users.user,
    status: 'disabled',
  })
  assert.equal(runUserAuth(db, token).result.status, 401)
  admin.changeUserStatus(db, {
    actorUserId: users.ops,
    targetUserId: users.user,
    status: 'active',
  })
  assert.equal(runUserAuth(db, token).result.status, 401)

  const freshUser = auth.getUserById(db, users.user)
  const fresh = auth.issueToken(freshUser, SECRET, auth.getTokenVersion(db, freshUser.id))
  db.prepare("UPDATE platform_users SET platform_role = 'support' WHERE id = ?").run(users.user)
  const accepted = runUserAuth(db, fresh)
  assert.equal(accepted.result.next, true)
  assert.equal(accepted.req.user.role, 'support')
  db.close()
})

test('管理员降级后旧 JWT 即使携带正确静态管理员令牌仍被拒绝', () => {
  const { db, users } = createDb()
  const current = auth.getUserById(db, users.admin)
  const token = auth.issueToken(current, SECRET, auth.getTokenVersion(db, current.id))
  db.prepare("UPDATE platform_users SET platform_role = 'support' WHERE id = ?").run(users.admin)
  const authenticated = runUserAuth(db, token)
  assert.equal(authenticated.result.next, true)
  assert.equal(authenticated.req.user.role, 'support')

  const result = { status: null, body: null, next: false }
  const res = {
    status(code) { result.status = code; return this },
    json(body) { result.body = body; return this },
  }
  authenticated.req.get = (name) => name.toLowerCase() === 'x-platform-admin-token' ? 'a'.repeat(32) : ''
  createAdminAuthMiddleware({ enabled: true, token: 'a'.repeat(32) })(
    authenticated.req,
    res,
    () => { result.next = true },
  )
  assert.equal(result.status, 403)
  assert.equal(result.body.error.code, 'ADMIN_ROLE_REQUIRED')
  db.close()
})

test('账号控制写审计，并保护自己和最后一个启用管理员', () => {
  const { db, users } = createDb()
  admin.changeUserRole(db, {
    actorUserId: users.admin,
    targetUserId: users.support,
    role: 'ops',
  })
  admin.changeUserStatus(db, {
    actorUserId: users.ops,
    targetUserId: users.reader,
    status: 'disabled',
  })
  admin.forceLogout(db, {
    actorUserId: users.ops,
    targetUserId: users.user,
  })

  assert.deepEqual(
    db.prepare('SELECT event_type FROM audit_events ORDER BY rowid').all().map((row) => row.event_type),
    ['platform.user.role_changed', 'platform.user.status_changed', 'platform.user.force_logout'],
  )
  assert.throws(
    () => admin.changeUserStatus(db, {
      actorUserId: users.ops,
      targetUserId: users.ops,
      status: 'disabled',
    }),
    (error) => error.code === 'CANNOT_SUSPEND_SELF',
  )

  admin.changeUserStatus(db, {
    actorUserId: users.admin,
    targetUserId: users.secondAdmin,
    status: 'disabled',
  })
  assert.throws(
    () => admin.changeUserRole(db, {
      actorUserId: users.admin,
      targetUserId: users.admin,
      role: 'ops',
    }),
    (error) => error.code === 'LAST_ACTIVE_ADMIN',
  )
  db.close()
})

test('注册指定邮箱不会在缺少管理员令牌确认时自动提权', () => {
  const db = new Database(':memory:')
  const firstCapture = captureResponse()
  const routes = createAuthRoutes(db, {
    registrationEnabled: true,
    jwtSecret: SECRET,
    bootstrapAdminEmail: 'founder@example.com',
  })

  routes.register({
    body: {
      email: 'founder@example.com',
      password: 'correct horse battery staple',
    },
  }, firstCapture.res)
  assert.equal(firstCapture.result.status, 201)
  assert.equal(firstCapture.result.body.data.user.role, 'user')

  const secondCapture = captureResponse()
  routes.register({
    body: {
      email: 'second@example.com',
      password: 'correct horse battery staple',
    },
  }, secondCapture.res)
  assert.equal(secondCapture.result.status, 201)
  assert.equal(secondCapture.result.body.data.user.role, 'user')
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM platform_users WHERE platform_role = 'admin'").get().count,
    0,
  )
  db.close()
})

test('零管理员旧数据库启动路由时不会仅凭邮箱自动提权', () => {
  const db = new Database(':memory:')
  const existing = auth.register(db, {
    email: 'recovery@example.com',
    password: 'correct horse battery staple',
  })
  createAuthRoutes(db, {
    registrationEnabled: false,
    jwtSecret: SECRET,
    bootstrapAdminEmail: 'recovery@example.com',
  })

  const recovered = auth.getUserById(db, existing.id)
  assert.equal(recovered.role, 'user')
  assert.equal(auth.getTokenVersion(db, existing.id), 0)
  db.close()
})

test('首管理员审计失败时提权必须整体回滚', () => {
  const db = new Database(':memory:')
  const founder = auth.register(db, {
    email: 'founder@example.com',
    password: 'correct horse battery staple',
  })
  createAuthRoutes(db, {
    registrationEnabled: false,
    jwtSecret: SECRET,
    bootstrapAdminEmail: 'founder@example.com',
  })
  db.exec(`
    CREATE TRIGGER reject_bootstrap_audit
    BEFORE INSERT ON audit_events
    WHEN NEW.event_type = 'platform.admin.bootstrap'
    BEGIN
      SELECT RAISE(ABORT, 'audit unavailable');
    END
  `)

  assert.throws(
    () => auth.bootstrapFirstAdmin(db, 'founder@example.com'),
    /audit unavailable/,
  )
  assert.equal(auth.getUserById(db, founder.id).role, 'user')
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'platform.admin.bootstrap'").get().count,
    0,
  )
  db.close()
})

test('只要历史上存在管理员账号就永久关闭首管理员引导', () => {
  const db = new Database(':memory:')
  const oldAdmin = auth.register(db, {
    email: 'old-admin@example.com',
    password: 'correct horse battery staple',
  })
  db.prepare(`
    UPDATE platform_users
    SET role = 'admin', platform_role = 'admin', status = 'disabled'
    WHERE id = ?
  `).run(oldAdmin.id)
  const founder = auth.register(db, {
    email: 'founder@example.com',
    password: 'correct horse battery staple',
  })

  assert.equal(auth.bootstrapFirstAdmin(db, 'founder@example.com'), null)
  assert.equal(auth.getUserById(db, founder.id).role, 'user')
  db.close()
})
