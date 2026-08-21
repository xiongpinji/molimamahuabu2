import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const viewSource = readFileSync(
  new URL('../src/views/ScriptAnalysis.vue', import.meta.url),
  'utf8',
)
const apiSource = readFileSync(
  new URL('../src/api/scriptAnalysis.js', import.meta.url),
  'utf8',
)

test('剧本分析提供四策略选择并随 V2 分析请求提交', () => {
  assert.match(apiSource, /production-presets/)
  assert.match(viewSource, /创作策略/)
  assert.match(viewSource, /selectedStrategyPreset/)
  assert.match(viewSource, /strategy_preset/)
  assert.match(viewSource, /usesProductionStrategy/)
})

test('导演故事板展示表演轨、Prompt IR 和 Seedance 编译检查', () => {
  assert.match(viewSource, /导演故事板/)
  assert.match(viewSource, /角色表演轨/)
  assert.match(viewSource, /模型无关 Prompt IR/)
  assert.match(viewSource, /Seedance 2 编译结果/)
  assert.match(viewSource, /generationReady/)
})

test('审核通过后的主动作进入画布且短剧工厂收进兼容入口', () => {
  assert.match(viewSource, /进入画布生产/)
  assert.match(viewSource, /importApprovedPackageToCanvas/)
  assert.match(viewSource, /兼容入口/)
  assert.match(viewSource, /导入短剧工厂（非主流程）/)
})
