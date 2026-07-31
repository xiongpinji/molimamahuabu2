import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(
  new URL('../src/components/AIConfigContent.vue', import.meta.url),
  'utf8',
)

test('AI 配置提供独立 DJPSD 开放 API video-v1 模型和正确端点', () => {
  assert.match(source, /value="djpsd_openapi"/)
  assert.match(source, /id: 'djpsd_openapi'.*models: \['video-v1'\]/)
  assert.match(source, /djpsd_openapi: 'djpsd_openapi'/)
  assert.match(source, /providerId === 'djpsd_openapi'/)
  assert.match(source, /\/v1\/media\/generate/)
  assert.match(source, /\/v1\/media\/status\?task_id=\{taskId\}/)
})
