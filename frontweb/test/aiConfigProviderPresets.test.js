import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'src/components/AIConfigContent.vue'), 'utf8')

test('管理员飞拓预设只包含批准的 H3-2K 与 xuan Seedance 2.5', () => {
  assert.match(
    source,
    /id:\s*'feituo'[\s\S]*?models:\s*\[\s*'xuan-video-v1-6e7b4763634e6206',\s*'xuan-seedance-2\.5'\s*\]/,
  )
  assert.doesNotMatch(source, /models:\s*\[[^\]]*'seedance-2\.5'/)
})

test('管理员飞拓预设同步协议、Base URL、端点和模型时长能力', () => {
  assert.match(source, /feituo:\s*'feituo_open'/)
  assert.match(source, /p === 'feituo'[\s\S]*?https:\/\/feituokuajing\.com/)
  assert.match(source, /providerId === 'feituo'[\s\S]*?\/api\/open\/v1\/video\/generate/)
  assert.match(source, /providerId === 'feituo'[\s\S]*?\/api\/open\/v1\/video\/status\?jobId=\{taskId\}/)
  assert.match(source, /xuan-video-v1-6e7b4763634e6206'[\s\S]*?durations:\s*Object\.freeze\(\[15\]\)/)
  assert.match(source, /xuan-seedance-2\.5'[\s\S]*?length:\s*27[\s\S]*?index \+ 4/)
})
