import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  VIDEO_DURATION_OPTIONS,
  mergeVideoDurationSetting,
  readVideoDurationSetting,
} from '../src/utils/videoDuration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const aiConfigSource = fs.readFileSync(
  path.join(__dirname, '../src/components/AIConfigContent.vue'),
  'utf8',
)

test('视频时长选项完整覆盖 5 到 15 秒整数', () => {
  assert.deepEqual(VIDEO_DURATION_OPTIONS, [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
})

test('视频模型默认时长可写入和读取设置且保留其他字段', () => {
  const settings = mergeVideoDurationSetting('{"icreat_group":"default"}', 11)
  assert.deepEqual(settings, { icreat_group: 'default', video_duration: 11 })
  assert.equal(readVideoDurationSetting(JSON.stringify(settings)), 11)
  assert.equal(readVideoDurationSetting('{"video_duration":19}'), 5)
})

test('AI 视频模型表单提供 5 到 15 秒默认时长并写入设置', () => {
  assert.match(aiConfigSource, /v-model="form\.video_duration"/)
  assert.match(aiConfigSource, /v-for="duration in VIDEO_DURATION_OPTIONS"/)
  assert.match(aiConfigSource, /video_duration:\s*readVideoDurationSetting\(row\.settings\)/)
  assert.match(aiConfigSource, /mergeVideoDurationSetting\(prev\?\.settings,\s*form\.value\.video_duration\)/)
})
