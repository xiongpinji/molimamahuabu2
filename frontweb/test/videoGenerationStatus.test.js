import test from 'node:test'
import assert from 'node:assert/strict'

import {
  latestVideoGenerationError,
  latestVideoGenerationRecord,
  latestVideoGenerationWarning,
} from '../src/utils/videoGenerationStatus.js'

test('较新的结果未知失败不会被旧成功视频掩盖', () => {
  const error = latestVideoGenerationError([
    { id: 2, status: 'failed', error_msg: '结果未知，请勿连续重试' },
    { id: 1, status: 'completed', video_url: 'https://cdn.example/old.mp4' },
  ])
  assert.equal(error, '结果未知，请勿连续重试')
})

test('最新一次生成成功时不显示旧失败', () => {
  const error = latestVideoGenerationError([
    { id: 2, status: 'completed', video_url: 'https://cdn.example/new.mp4' },
    { id: 1, status: 'failed', error_msg: '旧错误' },
  ])
  assert.equal(error, '')
})

test('处理中记录显示供应商任务编号', () => {
  const latest = latestVideoGenerationRecord([
    { id: 1, status: 'completed', created_at: '2026-07-13T00:00:00Z' },
    { id: 2, status: 'processing', provider_task_id: '83047', created_at: '2026-07-13T00:01:00Z' },
  ])
  assert.equal(latest.provider_task_id, '83047')
})

test('已完成远程视频可显示本地保存失败警告', () => {
  const warning = latestVideoGenerationWarning([
    { id: 3, status: 'completed', video_url: 'https://cdn.example/video.mp4', error_msg: '视频已生成并可在线播放，但保存到本地失败' },
  ])
  assert.match(warning, /可在线播放/)
})
