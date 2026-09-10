import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function apiFor(request) {
  const source = readFileSync(new URL('../src/api/redraw.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]*\n/gm, '').replace(/export /g, '').replace('const redrawAPI =', 'return')
  return new Function('request', source)(request)
}

const identity = {
  expected_updated_at: '2026-09-06 12:00:00', expected_source_sha256: 'a'.repeat(64),
  expected_import_id: 61, expected_file_sha256: 'b'.repeat(64),
  asset_id: 999, version_id: 999, url: 'forbidden', path: 'forbidden', model: 'forbidden', key: 'forbidden',
}
const cas = { expected_updated_at: identity.expected_updated_at, expected_source_sha256: identity.expected_source_sha256 }

for (const [method, endpoint, blob] of [
  ['getMotionDraft', 'motion-draft', true],
  ['getMotionProcessing', 'motion-processing', true],
  ['getMotionReference', 'motion-reference', false],
  ['getMotionReferenceMedia', 'motion-reference/media', true],
]) test(`${method} 只发当前镜头绑定参数，复用受控鉴权请求和 AbortSignal`, async () => {
  const calls = [], response = blob ? new Blob(['video'], { type: 'video/mp4' }) : { status: 'missing', candidate: null }
  const api = apiFor({ get: (...args) => { calls.push(args); return Promise.resolve(response) } })
  assert.equal(typeof api[method], 'function', '普通动作素材 API 尚未接线')
  const controller = new AbortController()
  assert.equal(await api[method](42, identity, { signal: controller.signal }), response)
  const options = { params: method === 'getMotionReferenceMedia'
    ? { ...cas, expected_import_id: 61, expected_file_sha256: 'b'.repeat(64) } : cas,
    silentError: true, signal: controller.signal }
  if (blob) options.responseType = 'blob'
  assert.deepEqual(calls, [[`/redraw/shots/42/${endpoint}`, options]])
})

test('动作上传只发 file/CAS/四项人工声明和幂等头，不透传模型或客户端资产 ID', async () => {
  const calls = [], api = apiFor({ post: (...args) => { calls.push(args); return Promise.resolve('uploaded') } })
  assert.equal(typeof api.uploadMotionReference, 'function', '动作 multipart 上传尚未接线')
  const file = new File(['mp4'], 'motion.mp4', { type: 'video/mp4' })
  assert.equal(await api.uploadMotionReference(42, file, { ...identity, idempotencyKey: 'stable-motion-operation-key',
    full_frame_reviewed: true, source_identity_obscured: true, source_text_obscured: false, motion_preserved: true }), 'uploaded')
  assert.equal(calls.length, 1)
  const [url, body, options] = calls[0]
  assert.equal(url, '/redraw/shots/42/motion-reference')
  assert.ok(body instanceof FormData)
  assert.deepEqual([...body.keys()].sort(), ['expected_updated_at', 'file', 'full_frame_reviewed', 'motion_preserved',
    'source_identity_obscured', 'source_text_obscured'].sort())
  assert.equal(body.get('file'), file)
  assert.equal(body.get('expected_updated_at'), identity.expected_updated_at)
  for (const field of ['full_frame_reviewed', 'source_identity_obscured', 'motion_preserved']) assert.equal(body.get(field), 'true')
  assert.equal(body.get('source_text_obscured'), 'false', '不得自动确认尚未人工确认的审核项')
  assert.deepEqual(options, { headers: { 'Content-Type': 'multipart/form-data', 'Idempotency-Key': 'stable-motion-operation-key' }, silentError: true })
})

test('动作上传失败或未知原样拒绝且只请求一次，不自动调用其它线路或准备接口', async () => {
  const calls = [], failure = new Error('result unknown')
  const api = apiFor({ post: (...args) => { calls.push(args); return Promise.reject(failure) } })
  assert.equal(typeof api.uploadMotionReference, 'function')
  await assert.rejects(api.uploadMotionReference(42, new File(['mp4'], 'motion.mp4', { type: 'video/mp4' }), {
    expected_updated_at: identity.expected_updated_at, idempotencyKey: 'same-operation', full_frame_reviewed: true,
    source_identity_obscured: true, source_text_obscured: true, motion_preserved: true,
  }), error => error === failure)
  assert.equal(calls.length, 1)
})

test('仅处理结果上传携带原 processing_report 字符串；手工路径不添加字段', async () => {
  const calls = [], api = apiFor({ post: (...args) => { calls.push(args); return Promise.resolve('uploaded') } })
  const processing_report = '{"schema_version":"redraw-motion-obscuration-report-v1"}'
  await api.uploadMotionReference(42, new File(['mp4'], 'processed.mp4', { type: 'video/mp4' }), { ...cas, processing_report })
  assert.equal(calls[0][1].get('processing_report'), processing_report)
})

test('既有工作区只读 API 在显式传入时支持上传屏障取消且不透传额外参数', async () => {
  const calls = [], api = apiFor({ get: (...args) => calls.push(args) }), controller = new AbortController()
  for (const method of ['getWork', 'getReferenceBundle', 'getGenerationGate']) {
    api[method](42, { signal: controller.signal, silentError: true, path: 'forbidden' })
  }
  for (const [, options] of calls) assert.deepEqual(options, { signal: controller.signal, silentError: true })
})
