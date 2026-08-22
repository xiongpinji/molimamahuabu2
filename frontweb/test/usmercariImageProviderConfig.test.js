import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/components/AIConfigContent.vue', import.meta.url), 'utf8')

test('USMercari 图片预设在文生图和分镜图中使用真实模型 ID', () => {
  const preset = /\{\s*id:\s*'usmercari_image',\s*name:\s*'USMercari 图片',\s*models:\s*\['gpt-image-2-2-4k',\s*'nano-banana-2'\]\s*\}/g
  assert.equal(source.match(preset)?.length, 2)
  assert.match(source, /usmercari_image:\s*'usmercari_image'/)
  assert.match(source, /p === 'usmercari_image'[\s\S]*return 'https:\/\/chat-ai\.mercarimx\.com'/)
  assert.match(source, /providerId === 'usmercari_image'[\s\S]*form\.value\.endpoint = '\/v1\/images\/generations'/)
})

test('USMercari 图片列表显示真实验证状态', () => {
  assert.match(source, /验证状态/)
  assert.match(source, /row\.verification_status/)
  assert.match(source, /pending[\s\S]*verified[\s\S]*failed/)
})

test('USMercari 图片测试只做连通性检查且不改变验证状态', () => {
  assert.match(source, /只读连通性测试/)
  assert.match(source, /不会把模型标记为 verified/)

  const openTest = source.match(/async function openTest\(row\) \{[\s\S]*?\n\}/)?.[0] || ''
  assert.match(openTest, /aiAPI\.testConnection/)
  assert.doesNotMatch(openTest, /aiAPI\.update|verification_status\s*=/)
})
