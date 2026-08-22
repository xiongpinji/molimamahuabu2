const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.resolve(__dirname, '../src/routes/index.js'), 'utf8')

test('平台账号控制接口逐项挂载服务端权限中间件', () => {
  assert.match(source, /r\.get\('\/platform-admin\/users', requirePlatformPermission\(PERMISSIONS\.USERS_READ\), platformAccounts\.listUsers\)/)
  assert.match(source, /r\.patch\('\/platform-admin\/users\/:userId\/role', requirePlatformPermission\(PERMISSIONS\.USERS_ROLE\), platformAccounts\.changeRole\)/)
  assert.match(source, /r\.patch\('\/platform-admin\/users\/:userId\/status', requirePlatformPermission\(PERMISSIONS\.USERS_STATUS\), platformAccounts\.changeStatus\)/)
  assert.match(source, /r\.post\('\/platform-admin\/users\/:userId\/force-logout', requirePlatformPermission\(PERMISSIONS\.USERS_FORCE_LOGOUT\), platformAccounts\.forceLogout\)/)
})
