import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const dramaCanvas = readFileSync(new URL('../src/views/DramaCanvas.vue', import.meta.url), 'utf8')
const homeCanvas = readFileSync(new URL('../src/views/HomeCanvas.vue', import.meta.url), 'utf8')
const login = readFileSync(new URL('../src/views/Login.vue', import.meta.url), 'utf8')

test('项目画布和独立画布都提供充值积分入口并跳转充值中心', () => {
  for (const source of [dramaCanvas, homeCanvas]) {
    assert.match(source, /class="canvas-recharge"/)
    assert.match(source, /充值积分/)
    assert.match(source, /name:\s*['"]recharge-center['"]/)
  }
})

test('登录提交在请求进行中拒绝重复提交', () => {
  const submit = login.match(/async function submit\(\) \{[\s\S]*?\n\}/)?.[0] || ''
  assert.match(submit, /if\s*\(loading\.value\)\s*return/)
  assert.ok(
    submit.indexOf('if (loading.value) return') < submit.indexOf('if (!email.value || !password.value)'),
    '并发守卫必须在校验和请求之前执行',
  )
})
