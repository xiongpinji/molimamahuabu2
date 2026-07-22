import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const requestSource = readFileSync(fileURLToPath(new URL('../src/utils/request.js', import.meta.url)), 'utf8')
const assetsApiSource = readFileSync(fileURLToPath(new URL('../src/api/assets.js', import.meta.url)), 'utf8')
const charactersApiSource = readFileSync(fileURLToPath(new URL('../src/api/characters.js', import.meta.url)), 'utf8')

test('请求层支持静默错误，供素材库多来源探测避免全局错误弹窗', () => {
  assert.match(requestSource, /if \(!error\.config\?\.silentError\) ElMessage\.error\(msg\)/)
})

test('素材和音色 API 列表方法可透传请求配置', () => {
  assert.match(assetsApiSource, /list\(params, config = \{\}\)/)
  assert.match(assetsApiSource, /request\.get\('\/assets', \{ \.\.\.config, params: params \|\| \{\} \}\)/)
  assert.match(charactersApiSource, /listVoiceCatalog\(params, config = \{\}\)/)
  assert.match(charactersApiSource, /request\.get\('\/voice-catalog', \{ \.\.\.config, params: params \|\| \{\} \}\)/)
})
