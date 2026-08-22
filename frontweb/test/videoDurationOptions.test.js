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

test('ToAPIs 管理员默认时长按当前模型能力读写并保留 4 秒', () => {
  const fastCapability = { durations: Array.from({ length: 12 }, (_, index) => index + 4) }
  const miniCapability = { durations: [4, 8, 10, 12, 15] }

  assert.equal(mergeVideoDurationSetting('{}', 4, fastCapability).video_duration, 4)
  assert.equal(readVideoDurationSetting('{"video_duration":4}', fastCapability), 4)
  assert.equal(mergeVideoDurationSetting('{}', 5, miniCapability).video_duration, 4)
  assert.equal(readVideoDurationSetting('{"video_duration":5}', miniCapability), 4)
})

test('AI 视频模型表单按当前模型能力提供默认时长并写入设置', () => {
  assert.match(aiConfigSource, /v-model="form\.video_duration"/)
  assert.match(aiConfigSource, /v-for="duration in adminVideoDurationOptions"/)
  assert.match(aiConfigSource, /const effectiveDefaultModel = defaultInList \? normalizedDefaultModel : \(modelList\[0\] \|\| ''\)/)
  assert.match(aiConfigSource, /video_duration:\s*readVideoDurationSetting\(row\.settings,\s*adminVideoCapabilityFor\(\{\s*\.\.\.row,\s*model:\s*modelList,\s*default_model:\s*effectiveDefaultModel,\s*\}\)\)/)
  assert.match(aiConfigSource, /mergeVideoDurationSetting\(prev\?\.settings,\s*form\.value\.video_duration,\s*adminVideoCapability\.value\)/)
})
