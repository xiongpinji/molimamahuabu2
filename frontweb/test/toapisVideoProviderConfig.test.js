import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/components/AIConfigContent.vue', import.meta.url), 'utf8')

test('ToAPIs 视频协议和预设只包含指定的 Seedance 2 模型', () => {
  assert.match(source, /<el-option label="ToAPIs 视频（Seedance 2 异步生成）" value="toapis_video" \/>/)
  assert.match(
    source,
    /\{\s*id:\s*'toapis',\s*name:\s*'ToAPIs Seedance 2',\s*models:\s*\['seedance-2-fast',\s*'seedance-2-mini'\]\s*\}/,
  )
  assert.match(source, /toapis:\s*'toapis_video'/)
})

test('选择 ToAPIs 预设会写入异步创建和查询合同', () => {
  assert.match(source, /p === 'toapis'[\s\S]*return 'https:\/\/toapis\.xyz'/)
  assert.match(source, /proto === 'toapis_video' \|\| p === 'toapis'[\s\S]*submitPath = endpoint \|\| '\/v1\/videos\/generations'/)
  assert.match(source, /proto === 'toapis_video' \|\| p === 'toapis'[\s\S]*queryPath = '\/v1\/videos\/generations\/\{taskId\}'/)
  assert.match(source, /providerId === 'toapis'[\s\S]*form\.value\.api_protocol = 'toapis_video'/)
  assert.match(source, /providerId === 'toapis'[\s\S]*form\.value\.endpoint = '\/v1\/videos\/generations'/)
  assert.match(source, /providerId === 'toapis'[\s\S]*form\.value\.query_endpoint = '\/v1\/videos\/generations\/\{taskId\}'/)
})

test('ToAPIs 帮助明确分辨率、验证门禁和参考模式互斥', () => {
  const help = source.match(/<el-collapse-item name="toapis-video">[\s\S]*?<\/el-collapse-item>/)?.[0] || ''
  assert.match(help, /https:\/\/toapis\.xyz/)

  assert.match(help, /仅支持 <code>480P<\/code>、<code>720P<\/code>/)
  assert.match(help, /真实生成验证成功后才可在前端可见/)
  assert.match(help, /支持参考图、参考视频和参考音频/)
  assert.match(help, /首尾帧模式与全能参考模式互斥/)
  assert.match(help, /POST \/v1\/videos\/generations/)
  assert.match(help, /GET \/v1\/videos\/generations\/\{taskId\}/)
})

test('ToAPIs 前端预设保持声明式，不读取凭证也不发起网络请求', () => {
  const toapisLines = source.split('\n').filter((line) => /toapis/i.test(line)).join('\n')

  assert.notEqual(toapisLines, '')
  assert.doesNotMatch(toapisLines, /api[_-]?key|authorization|localStorage|sessionStorage|import\.meta\.env|process\.env/i)
  assert.doesNotMatch(toapisLines, /fetch\s*\(|axios|request\.|aiAPI\./)
})
