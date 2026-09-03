import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/views/ScriptAnalysis.vue', import.meta.url), 'utf8')

test('剧本分析输入与文件导入不再包含固定字数上限', () => {
  assert.doesNotMatch(source, /SCRIPT_CHAR_LIMIT/)
  assert.doesNotMatch(source, /:maxlength="SCRIPT_CHAR_LIMIT"/)
  assert.doesNotMatch(source, /剧本内容超过[^\n]+字符限制/)
  assert.match(
    source,
    /原剧本（\{\{\s*project\.source_script\.length\.toLocaleString\(\)\s*\}\}\s*字符）/,
  )
})

test('剧本分析在预扣建立和任务终态时刷新积分账户', () => {
  assert.match(source, /moli:credit-account-refresh/)
  assert.match(source, /function notifyCreditAccountRefresh\(\)/)
  assert.ok(
    (source.match(/notifyCreditAccountRefresh\(\)/g) || []).length >= 5,
    '应覆盖函数定义、任务创建、提交失败、完成和失败终态',
  )
})
