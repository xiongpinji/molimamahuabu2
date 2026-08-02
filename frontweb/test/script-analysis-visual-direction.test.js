import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL('../src/views/ScriptAnalysis.vue', import.meta.url),
  'utf8',
)

test('剧本分析只在生产包存在视觉导演数据时展示增强区', () => {
  assert.match(source, /v-if="visualDirection"/)
  assert.match(source, /电影化视觉方案/)
  assert.match(source, /visualDirection\.recommendations/)
})

test('视觉导演增强不替换现有审核和导入画布流程', () => {
  assert.match(source, /人工审核备注/)
  assert.match(source, /importApprovedPackageToCanvas/)
  assert.match(source, /canImportToCanvas/)
})
