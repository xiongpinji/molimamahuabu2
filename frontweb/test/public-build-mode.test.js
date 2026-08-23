import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const packageJson = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)

test('默认生产构建启用公开平台租户与兑换功能', () => {
  assert.equal(packageJson.scripts.build, 'node scripts/build-public.mjs')
})
