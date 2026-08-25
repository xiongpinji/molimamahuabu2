import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const runnerSource = readFileSync(
  fileURLToPath(new URL('../src/composables/useCanvasWorkflowRunner.js', import.meta.url)),
  'utf8'
)
const episodeSource = readFileSync(
  fileURLToPath(new URL('../src/composables/useCanvasEpisodeGenerate.js', import.meta.url)),
  'utf8'
)
const filmSource = readFileSync(
  fileURLToPath(new URL('../src/views/FilmCreate.vue', import.meta.url)),
  'utf8'
)

test('画布任务轮询把 needs_attention 作为带稳定代码的终态', () => {
  assert.match(runnerSource, /t\.status === 'needs_attention' \|\| t\.status === 'indeterminate'/)
  assert.match(runnerSource, /code:\s*RESULT_UNKNOWN_NEEDS_REVIEW/)
  assert.match(runnerSource, /error\.code = polled\.code/)
  assert.match(episodeSource, /t\.status === 'needs_attention' \|\| t\.status === 'indeterminate'/)
})

test('画布顺序批量生图遇结构化未知后停止后续分镜', () => {
  assert.match(episodeSource, /isIndeterminateGenerationError\(e\)/)
  assert.match(episodeSource, /供应商状态未知，已提交管理员核对；请勿重复提交，冻结积分暂不释放。/)
  assert.match(episodeSource, /if \(isIndeterminateGenerationError\(e\)\) \{[\s\S]{0,500}break/)
})

test('短剧工厂一键流程保留结构化错误对象再决定是否重试', () => {
  assert.match(filmSource, /decidePipelineRetry\(e,\s*r,\s*maxRetries\)/)
  assert.match(filmSource, /throw createImageGenerationTerminalError\(result/)
})
