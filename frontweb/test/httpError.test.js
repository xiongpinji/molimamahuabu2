import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apiErrorMessage,
  isTransientHttpError,
  userHttpErrorMessage,
} from '../src/utils/httpError.js'

const nginx502 = `
<html><head><title>502 Bad Gateway</title></head>
<body><center><h1>502 Bad Gateway</h1></center></body></html>
`

test('nginx HTML error pages are never returned as user-facing API messages', () => {
  assert.equal(apiErrorMessage(nginx502, ''), '')
  assert.equal(
    userHttpErrorMessage({
      message: nginx502,
      response: { status: 502, data: nginx502 },
    }, '查询分析任务失败'),
    '服务暂时不可用，请稍后重试',
  )
})

test('task polling treats gateway and network failures as transient', () => {
  assert.equal(isTransientHttpError({ response: { status: 502 } }), true)
  assert.equal(isTransientHttpError({ response: { status: 503 } }), true)
  assert.equal(isTransientHttpError({ response: { status: 504 } }), true)
  assert.equal(isTransientHttpError({ request: {} }), true)
  assert.equal(isTransientHttpError({ response: { status: 400 } }), false)
})

test('structured backend errors keep their readable message', () => {
  const error = {
    message: 'Request failed with status code 500',
    response: {
      status: 500,
      data: { error: { code: 'ANALYSIS_FAILED', message: '剧本分析失败，请重新操作' } },
    },
  }
  assert.equal(apiErrorMessage(error.response.data), '剧本分析失败，请重新操作')
  assert.equal(userHttpErrorMessage(error), '剧本分析失败，请重新操作')
})
