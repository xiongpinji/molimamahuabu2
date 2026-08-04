import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(
  new URL('../src/components/AIConfigContent.vue', import.meta.url),
  'utf8',
)

test('AI 配置提供 DJPSD 开放 API 的图片和视频模型及正确端点', () => {
  const providerChange = source.slice(
    source.indexOf('function onProviderChange'),
    source.indexOf('/** 通义一键配置用 */'),
  )
  assert.match(source, /value="djpsd_openapi"/)
  assert.match(source, /id: 'djpsd_openapi'.*models: \['image-v1', 'image-v1-2k', 'image-v1-4k'\]/)
  assert.match(source, /id: 'djpsd_openapi'.*models: \['video-v1'\]/)
  assert.match(source, /djpsd_openapi: 'djpsd_openapi'/)
  assert.match(providerChange, /\(st === 'image' \|\| st === 'storyboard_image'\).*providerId === 'djpsd_openapi'/)
  assert.match(source, /\/v1\/media\/generate/)
  assert.match(source, /\/v1\/media\/status\?task_id=\{taskId\}/)
})
