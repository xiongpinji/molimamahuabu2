import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IMAGE_TOOL_REFERENCE_CAPABILITY_KEYS,
  applyImageToolReferenceCapabilities,
  isAuditedSeedream45ReferenceConfig,
} from '../src/utils/imageToolProviderCapabilities.js'

const auditedConfig = {
  serviceType: 'storyboard_image',
  provider: 'volcengine',
  protocol: 'volcengine',
  model: 'doubao-seedream-4-5-251128',
}

test('火山 Seedream 4.5 版本化模型匹配已审计图片节点适配器', () => {
  assert.equal(isAuditedSeedream45ReferenceConfig(auditedConfig), true)
  assert.equal(
    isAuditedSeedream45ReferenceConfig({ ...auditedConfig, model: 'doubao-seedream-4-0' }),
    false,
  )
  assert.equal(
    isAuditedSeedream45ReferenceConfig({ ...auditedConfig, provider: 'proxy' }),
    false,
  )
  assert.equal(
    isAuditedSeedream45ReferenceConfig({ ...auditedConfig, serviceType: 'image' }),
    false,
  )
})

test('保存已审计配置时一次性声明全部非对口型参考图能力', () => {
  const settings = applyImageToolReferenceCapabilities({ retained: true }, auditedConfig)
  assert.equal(settings.retained, true)
  for (const key of IMAGE_TOOL_REFERENCE_CAPABILITY_KEYS) {
    assert.equal(settings[key], true, key)
  }
  assert.equal(Object.hasOwn(settings, 'supports_lip_sync'), false)
})

test('配置离开已审计适配器时清理过期图片节点能力声明', () => {
  const previous = Object.fromEntries(
    IMAGE_TOOL_REFERENCE_CAPABILITY_KEYS.map((key) => [key, true]),
  )
  const settings = applyImageToolReferenceCapabilities(
    { ...previous, retained: true },
    { ...auditedConfig, model: 'doubao-seedream-4-0' },
  )
  assert.equal(settings.retained, true)
  for (const key of IMAGE_TOOL_REFERENCE_CAPABILITY_KEYS) {
    assert.equal(Object.hasOwn(settings, key), false, key)
  }
})
