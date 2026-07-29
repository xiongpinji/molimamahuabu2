import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IMAGE_TOOL_REFERENCE_CAPABILITY_KEYS,
  applyImageToolReferenceCapabilities,
  isAuditedImageToolReferenceConfig,
} from '../src/utils/imageToolProviderCapabilities.js'

const auditedConfig = {
  serviceType: 'storyboard_image',
  provider: 'aihubcc',
  protocol: 'aihubcc',
  model: 'gpt-image-2-3.5k',
}

test('仅 AIHubCC gpt-image-2-3.5k 匹配已审计图片节点适配器', () => {
  assert.equal(isAuditedImageToolReferenceConfig(auditedConfig), true)
  assert.equal(
    isAuditedImageToolReferenceConfig({ ...auditedConfig, model: 'gpt-image-2-2k' }),
    false,
  )
  assert.equal(
    isAuditedImageToolReferenceConfig({ ...auditedConfig, provider: 'volcengine' }),
    false,
  )
  assert.equal(
    isAuditedImageToolReferenceConfig({ ...auditedConfig, serviceType: 'image' }),
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
    { ...auditedConfig, protocol: 'openai' },
  )
  assert.equal(settings.retained, true)
  for (const key of IMAGE_TOOL_REFERENCE_CAPABILITY_KEYS) {
    assert.equal(Object.hasOwn(settings, key), false, key)
  }
})
