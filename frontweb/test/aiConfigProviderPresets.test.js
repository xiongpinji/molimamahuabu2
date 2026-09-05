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
})

test('管理员飞拓预设同步协议、Base URL、端点和模型时长能力', () => {
  assert.match(source, /feituo:\s*'feituo_open'/)
  assert.match(source, /p === 'feituo'[\s\S]*?https:\/\/feituokuajing\.com/)
  assert.match(source, /providerId === 'feituo'[\s\S]*?\/api\/open\/v1\/video\/generate/)
  assert.match(source, /providerId === 'feituo'[\s\S]*?\/api\/open\/v1\/video\/status\?jobId=\{taskId\}/)
  assert.match(source, /xuan-video-v1-6e7b4763634e6206'[\s\S]*?durations:\s*Object\.freeze\(\[15\]\)/)
  assert.match(source, /xuan-seedance-2\.5'[\s\S]*?length:\s*27[\s\S]*?index \+ 4/)
})

test('管理员 ToAPIs Wan3 预设独立于 Seedance FAST/MINI 且开放批准的 2 至 30 秒', () => {
  assert.match(source, /id:\s*'toapis_wan3'[\s\S]*?models:\s*\[\s*'wan3\.0-video'\s*\]/)
  assert.match(source, /toapis_wan3:\s*'toapis_wan3_video'/)
  assert.match(source, /p === 'toapis_wan3'[\s\S]*?https:\/\/toapis\.cn/)
  assert.match(source, /providerId === 'toapis_wan3'[\s\S]*?\/v1\/videos\/generations/)
  assert.match(source, /providerId === 'toapis_wan3'[\s\S]*?\/v1\/videos\/generations\/\{taskId\}/)
  assert.match(source, /'wan3\.0-video':\s*Object\.freeze\(\{\s*durations:\s*Object\.freeze\(Array\.from\(\{ length: 29 \}, \(_, index\) => index \+ 2\)\)/)
})

test('管理员 NewAPI 预设只展示六个已实测模型及各自已验证组合', () => {
  assert.match(
    source,
    /id:\s*'newapi'[\s\S]*?models:\s*\[\s*'seedance-2\.0-fast',\s*'seedance-2\.0',\s*'seedance-2\.0-mini',\s*'seedance-2\.5',\s*'minimax_h3_image_audio_to_video_v2',\s*'alibaba\/wan-3\.0'\s*\]/,
  )
  assert.match(source, /'seedance-2\.0-fast':[\s\S]{0,220}duration:\s*'5 秒'[\s\S]{0,220}resolutions:\s*'480p'/)
  assert.match(source, /'seedance-2\.0-mini':[\s\S]{0,220}duration:\s*'4 秒'[\s\S]{0,220}resolutions:\s*'480p'/)
  assert.match(source, /minimax_h3_image_audio_to_video_v2:[\s\S]{0,260}duration:\s*'5 秒'[\s\S]{0,260}resolutions:\s*'768p（必须 1 张参考图）'/)
  assert.match(source, /'alibaba\/wan-3\.0':[\s\S]{0,220}duration:\s*'4 秒'[\s\S]{0,220}resolutions:\s*'480p'/)
  assert.doesNotMatch(source, /alibaba\/wan-3\.0[^\n]{0,100}(?:model_not_found|未开放|未通过验证)/)
})
