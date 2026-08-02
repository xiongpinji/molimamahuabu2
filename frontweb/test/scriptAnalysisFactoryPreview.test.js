import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL('../src/views/ScriptAnalysis.vue', import.meta.url),
  'utf8',
)

test('剧本分析为审核通过的生产包提供短剧工厂只读预览', () => {
  assert.match(source, /预览导入短剧工厂/)
  assert.match(source, /buildFactorySkillImportPreview/)
  assert.match(source, /factoryPreviewVisible/)
  assert.match(source, /本阶段只预览，不创建项目、不调用模型、不扣积分/)
})

test('短剧工厂预览只导航到现有入口且不创建项目', () => {
  assert.match(source, /router\.push\('\/factory'\)/)
  assert.doesNotMatch(source, /dramaAPI\.create/)
  assert.doesNotMatch(source, /generateEpisode|generateVideo|deductCredits/)
})
