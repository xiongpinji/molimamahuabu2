import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL('../src/views/ScriptAnalysis.vue', import.meta.url),
  'utf8',
)

test('退回修改接收异步任务并立即开始轮询', () => {
  assert.match(source, /body\?\.task_id/)
  assert.match(source, /type:\s*'script_analysis_revision'/)
  assert.match(source, /模型正在根据审核意见修改/)
  assert.match(source, /startPolling\(\)/)
})

test('自动修订完成和失败均刷新项目真实状态', () => {
  assert.match(source, /const isRevisionTask = task\.value\.type === 'script_analysis_revision'/)
  assert.match(source, /已按审核意见生成新版本，请继续审核/)
  assert.match(source, /if \(isRevisionTask\) await loadProject\(project\.value\.id\)/)
})

test('自动修订运行时禁用重复审核操作', () => {
  assert.match(source, /:disabled="Boolean\(selectedVersion\) \|\| running"/)
})
