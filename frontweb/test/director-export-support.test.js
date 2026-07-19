import test from 'node:test'
import assert from 'node:assert/strict'

import {
  directorExportDownloadUrl,
  directorExportFilename,
  parseDirectorExportResult,
  pickDirectorRecordingMimeType,
  waitForDirectorExportTask,
} from '../src/utils/director-export-support.js'

test('导演台录制优先选择浏览器支持的 WebM 编码器', () => {
  assert.equal(pickDirectorRecordingMimeType((type) => type === 'video/webm;codecs=vp8'), 'video/webm;codecs=vp8')
  assert.equal(pickDirectorRecordingMimeType(() => false), '')
})

test('DR-012 服务端导出轮询支持完成、取消和超时', async () => {
  const completed = await waitForDirectorExportTask({ getTask: async () => ({ status: 'completed', result: '{}' }), taskId: 'task-1', delay: async () => {}, maxAttempts: 1 })
  assert.equal(completed.status, 'completed')
  await assert.rejects(waitForDirectorExportTask({ getTask: async () => ({ status: 'running' }), taskId: 'task-2', delay: async () => {}, maxAttempts: 1 }), /服务端转码超时/)
  await assert.rejects(waitForDirectorExportTask({ getTask: async () => ({ status: 'running' }), taskId: 'task-3', delay: async () => {}, isCancelled: () => true }), /已取消视频导出/)
  let defaultAttempts = 0
  await assert.rejects(waitForDirectorExportTask({ getTask: async () => { defaultAttempts += 1; return { status: 'running' } }, taskId: 'task-default', delay: async () => {} }), /服务端转码超时/)
  assert.equal(defaultAttempts, 180)
})

test('导演台导出文件名和服务端任务结果可安全恢复', () => {
  assert.equal(directorExportFilename('春/夏:短剧', 'mp4'), '春_夏_短剧.mp4')
  assert.equal(directorExportFilename('', 'webm'), '导演台镜头序列.webm')
  assert.deepEqual(parseDirectorExportResult('{"url":"/static/director.mp4"}'), { url: '/static/director.mp4' })
  assert.deepEqual(parseDirectorExportResult({ url: '/static/director.mp4' }), { url: '/static/director.mp4' })
  assert.deepEqual(parseDirectorExportResult('{bad'), {})
})

test('MP4 优先使用同源静态路径避免跨域导航', () => {
  assert.equal(
    directorExportDownloadUrl({ local_path: 'projects/项目 一/videos/a.mp4', url: 'http://localhost:5679/a.mp4' }),
    '/static/projects/%E9%A1%B9%E7%9B%AE%20%E4%B8%80/videos/a.mp4',
  )
  assert.equal(directorExportDownloadUrl({ url: 'https://cdn.example/a.mp4' }), 'https://cdn.example/a.mp4')
})
