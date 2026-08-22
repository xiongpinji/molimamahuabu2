import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(
  new URL('../src/components/AIConfigContent.vue', import.meta.url),
  'utf8',
)

test('AI 配置撤下失效的 DJPSD 图片模型但保留视频模型', () => {
  const providerChange = source.slice(
    source.indexOf('function onProviderChange'),
    source.indexOf('/** 通义一键配置用 */'),
  )
  assert.match(source, /value="djpsd_openapi"/)
  assert.doesNotMatch(source, /models: \['image-v1', 'image-v1-2k'\]/)
  assert.doesNotMatch(source, /已真实生成验证模型为 image-v1、image-v1-2k/)
  assert.match(source, /id: 'djpsd_openapi'.*models: \['video-v1'\]/)
  assert.match(source, /djpsd_openapi: 'djpsd_openapi'/)
  assert.doesNotMatch(providerChange, /\(st === 'image' \|\| st === 'storyboard_image'\).*providerId === 'djpsd_openapi'/)
  assert.match(source, /\/v1\/media\/generate/)
  assert.match(source, /\/v1\/media\/status\?task_id=\{taskId\}/)
})
