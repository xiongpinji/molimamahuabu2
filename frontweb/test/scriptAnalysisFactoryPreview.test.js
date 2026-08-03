import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL('../src/views/ScriptAnalysis.vue', import.meta.url),
  'utf8',
)
const apiSource = readFileSync(
  new URL('../src/api/scriptAnalysis.js', import.meta.url),
  'utf8',
)

test('短剧工厂仅作为剧本分析审核后的兼容导入入口', () => {
  assert.match(source, /<summary>兼容入口<\/summary>/)
  assert.match(source, /导入短剧工厂（非主流程）/)
  assert.match(source, /进入画布生产/)
  assert.match(source, /buildFactorySkillImportPreview/)
  assert.match(source, /factoryPreviewVisible/)
  assert.match(source, /确认后只新增一个短剧项目，不调用模型、不扣积分/)
})

test('短剧工厂导入必须二次确认并调用受控幂等接口', () => {
  assert.match(source, /ElMessageBox\.confirm/)
  assert.match(source, /确认导入并打开项目/)
  assert.match(source, /相同版本重复确认不会重复创建/)
  assert.match(source, /scriptAnalysisAPI\.importToFactory/)
  assert.match(apiSource, /importToFactory\(id, body\)/)
  assert.match(apiSource, /import-to-factory/)
  assert.doesNotMatch(source, /dramaAPI\.create/)
  assert.doesNotMatch(source, /generateEpisode|generateVideo|deductCredits/)
})

test('短剧工厂导入成功后打开新项目而不是停留在项目列表', () => {
  assert.match(source, /router\.push\(`\/film\/\$\{result\.drama_id\}`\)/)
  assert.match(source, /该版本已导入，已打开原项目/)
})
