import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  getSupportedVideoDurationsForModel,
  normalizeVideoDurationForModel,
} from '../src/utils/videoModelDurationCapabilities.js'

const source = fs.readFileSync(new URL('../src/views/FilmCreate.vue', import.meta.url), 'utf8')

test('短剧工厂按当前分镜模型归一化视频请求时长', () => {
  assert.match(source, /normalizeVideoDurationForModel\(\s*getStoryboardVideoModel\(sb\)/)
  assert.match(source, /duration:\s*getSbVideoDurationForApi\(sb\)/)
})

test('分镜参数只展示当前模型支持的视频时长', () => {
  assert.match(source, /getStoryboardVideoDurationOptions\(videoParamsTarget\)/)
  assert.match(source, /getProjectVideoDurationOptions\(\)/)
  assert.doesNotMatch(source, /v-model="sbDuration\[videoParamsTarget\.id\]"\s*:min="1"\s*:max="60"/)
  assert.doesNotMatch(source, /label="12秒\/段"/)
})

test('灵境视频时长向上匹配供应商可用值', () => {
  assert.deepEqual(getSupportedVideoDurationsForModel('lingjing-video-v1'), [4, 5, 6, 8, 10, 11, 15])
  assert.equal(normalizeVideoDurationForModel('lingjing-video-v1', 9), 10)
  assert.equal(normalizeVideoDurationForModel('lingjing-video-v1', 12), 15)
})

test('其他视频模型保留原有 5 到 15 秒整数能力', () => {
  assert.deepEqual(getSupportedVideoDurationsForModel('seedance 2.0'), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
  assert.equal(normalizeVideoDurationForModel('seedance 2.0', 9), 9)
})
