import test from 'node:test'
import assert from 'node:assert/strict'

import {
  directorExportFilename,
  parseDirectorExportResult,
  pickDirectorRecordingMimeType,
} from '../src/utils/director-export-support.js'

test('导演台录制优先选择浏览器支持的 WebM 编码器', () => {
  assert.equal(pickDirectorRecordingMimeType((type) => type === 'video/webm;codecs=vp8'), 'video/webm;codecs=vp8')
  assert.equal(pickDirectorRecordingMimeType(() => false), '')
})

test('导演台导出文件名和服务端任务结果可安全恢复', () => {
  assert.equal(directorExportFilename('春/夏:短剧', 'mp4'), '春_夏_短剧.mp4')
  assert.equal(directorExportFilename('', 'webm'), '导演台镜头序列.webm')
  assert.deepEqual(parseDirectorExportResult('{"url":"/static/director.mp4"}'), { url: '/static/director.mp4' })
  assert.deepEqual(parseDirectorExportResult({ url: '/static/director.mp4' }), { url: '/static/director.mp4' })
  assert.deepEqual(parseDirectorExportResult('{bad'), {})
})
