import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTaskResult } from '../src/utils/taskResult.js'

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
