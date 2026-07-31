import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const filmCreateSource = readFileSync(new URL('../src/views/FilmCreate.vue', import.meta.url), 'utf8')

function asyncFunctionSource(name) {
  const marker = `async function ${name}(`
  const start = filmCreateSource.indexOf(marker)
  assert.notEqual(start, -1, `缺少函数 ${name}`)
  const next = filmCreateSource.indexOf('\nasync function ', start + marker.length)
  return filmCreateSource.slice(start, next === -1 ? filmCreateSource.length : next)
}

test('短剧工厂全部分镜视频入口统一使用能力感知请求构建器', () => {
  for (const name of [
    'onGenerateSbVideo',
    'startBatchVideoGeneration',
    'runOneClickPipeline',
    'runRepairPipeline',
  ]) {
    const source = asyncFunctionSource(name)
    assert.match(source, /buildSbVideoRequestContext\(/, name)
    assert.doesNotMatch(source, /reference_image_urls\s*:/, name)
  }
})
