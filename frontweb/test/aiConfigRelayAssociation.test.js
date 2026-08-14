import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAiConfigRelayAssociations } from '../src/utils/aiConfigRelayAssociation.js'

test('按模型去重生成管理员可见的配置名称、域名和配置 ID', () => {
  const result = buildAiConfigRelayAssociations({
    id: 42,
    name: 'Token6688 图片',
    base_url: 'https://user:secret@relay.example.com:8443/v1/images?token=hidden#private',
    api_key: 'must-not-leak',
    model: [' gpt-image-2 ', 'gpt-image-2', '', 'gpt-image-2-4K'],
  })

  assert.deepEqual(result, [
    { model: 'gpt-image-2', detail: 'Token6688 图片 · relay.example.com · #42' },
    { model: 'gpt-image-2-4K', detail: 'Token6688 图片 · relay.example.com · #42' },
  ])
  const serialized = JSON.stringify(result)
  for (const secret of ['token=hidden', 'private', 'user', 'secret', '8443', '/v1/images', 'must-not-leak']) {
    assert.doesNotMatch(serialized, new RegExp(secret))
  }
})

test('兼容 JSON 数组字符串和逗号分隔模型字符串', () => {
  assert.deepEqual(
    buildAiConfigRelayAssociations({
      id: 7,
      name: 'JSON 配置',
      base_url: 'http://json.example.cn/v1',
      model: '["model-a", " model-b ", "model-a"]',
    }).map(({ model }) => model),
    ['model-a', 'model-b'],
  )

  assert.deepEqual(
    buildAiConfigRelayAssociations({
      id: 8,
      name: '逗号配置',
      base_url: 'https://comma.example.cn',
      model: 'model-c, model-d，model-c',
    }).map(({ model }) => model),
    ['model-c', 'model-d'],
  )
})

test('拒绝非 HTTP(S) 和非法 URL，仅显示安全占位域名', () => {
  for (const baseUrl of ['javascript:alert(1)', 'ftp://relay.example.com/key', 'not a url']) {
    const result = buildAiConfigRelayAssociations({
      id: 9,
      name: '<img src=x onerror=alert(1)>',
      base_url: baseUrl,
      api_key: 'never-return-this',
      model: ['safe-model'],
    })

    assert.deepEqual(result, [{
      model: 'safe-model',
      detail: '<img src=x onerror=alert(1)> · 未识别域名 · #9',
    }])
    assert.doesNotMatch(JSON.stringify(result), /never-return-this|relay\.example\.com\/key/)
  }
})

test('无模型时不生成关联项', () => {
  assert.deepEqual(buildAiConfigRelayAssociations({ model: [] }), [])
  assert.deepEqual(buildAiConfigRelayAssociations({ model: ' , ， ' }), [])
})
