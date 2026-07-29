import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTaskResult, resolveTaskMediaUrl } from '../src/utils/taskResult.js'

test('异步任务结果兼容后端 JSON 字符串', () => {
  assert.deepEqual(
    parseTaskResult('{"image_url":"/static/library/images/result.jpg","image_generation_id":8}'),
    {
      image_url: '/static/library/images/result.jpg',
      image_generation_id: 8,
    },
  )
})

test('异步任务结果保留已经解析的对象', () => {
  const result = { video_generation_id: 12 }
  assert.equal(parseTaskResult(result), result)
})

test('无效任务结果不会被当成可用对象', () => {
  assert.equal(parseTaskResult('not-json'), null)
})

test('优先使用任务结果中的本地媒体地址', () => {
  assert.equal(
    resolveTaskMediaUrl({
      local_path: 'library/videos/vg_13.mp4',
      video_url: 'https://provider.example/video.mp4',
    }),
    '/static/library/videos/vg_13.mp4',
  )
})

test('没有本地媒体时使用远程结果地址', () => {
  assert.equal(
    resolveTaskMediaUrl({ video_url: 'https://provider.example/video.mp4' }),
    'https://provider.example/video.mp4',
  )
})
