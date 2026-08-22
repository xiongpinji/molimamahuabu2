import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/components/AIConfigContent.vue', import.meta.url), 'utf8')

test('AI 配置管理端用标准化模型列表展示、编辑和提交默认模型', () => {
  assert.match(
    source,
    /import\s+\{\s*normalizeModelOption,\s*parseModelList\s*\}\s+from ['"]@\/utils\/modelSelection['"]/,
  )
  assert.match(
    source,
    /normalizeModelOption\(row\.default_model\)[\s\S]{0,160}normalizeModelOption\(row\.model\[0\]\)/,
  )
  assert.match(source, /const modelList = parseModelList\(row\.model\)/)
  assert.match(source, /const normalizedDefaultModel = normalizeModelOption\(row\.default_model\)/)
  assert.match(source, /default_model:\s*effectiveDefaultModel/)
  assert.match(source, /(?:const|let) modelList = parseModelList\(form\.value\.modelText\)/)
})
