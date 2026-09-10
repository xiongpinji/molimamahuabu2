import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as coverageHelpers from '../e2e/helpers/motionProcessingCoverage.js'

const path = new URL('../src/utils/redrawMotionProcessing.js', import.meta.url)
const parser = existsSync(path) ? await import(path) : {}
const mime = 'application/vnd.moli.redraw-motion-processing.v1'
const MAX_JSON = 8 * 1024 * 1024, MAX_VIDEO = 200 * 1024 * 1024
// Full original 48-frame renderer report captured by the local browser r5, not a partial schema mock.
const originalReport = JSON.parse(readFileSync(new URL('./fixtures/redraw-motion-processing-report-v1.json', import.meta.url), 'utf8'))
const scope = { owner: originalReport.owner, work_id: originalReport.work_id, version_id: originalReport.version_id,
  shot_id: originalReport.shot_id, expected_updated_at: originalReport.shot.expected_updated_at,
  expected_source_sha256: originalReport.source_fingerprint }
const report = () => { const value = structuredClone(originalReport); value.output.size = 3; return value }
function envelope(value = report(), { json, magic = 'RDMO0001', length, video = new Uint8Array([1, 2, 3]), type = mime } = {}) {
  const encoded = json ?? new TextEncoder().encode(JSON.stringify(value)), header = new Uint8Array(12)
  header.set(new TextEncoder().encode(magic)); new DataView(header.buffer).setUint32(8, length ?? encoded.length)
  return new Blob([header, encoded, video], { type })
}
async function parse(blob, options) {
  assert.equal(typeof parser.parseMotionProcessingEnvelope, 'function', '缺少有界待审动作响应 parser')
  return parser.parseMotionProcessingEnvelope(blob, scope, options)
}
test('完整原始48帧报告原样通过，客户端不重算视频哈希或签发来源证明', async () => {
  const result = await parse(envelope(originalReport, { video: new Uint8Array(originalReport.output.size) }))
  assert.deepEqual(JSON.parse(result.processingReport), originalReport)
  assert.equal(result.file.size, originalReport.output.size)
})
test('报告允许明确无区域的帧，仍保留待人工审核与服务端绑定核验', async () => {
  const value = report(); value.frames[0].masks = []; value.frames[0].union_white_pixels = 0
  assert.equal(JSON.parse((await parse(envelope(value))).processingReport).approval_status, 'pending')
})
test('校验覆盖到最后一帧和最后一个mask，不能只检查首个样本', async () => {
  const value = report(); value.frames.at(-1).masks.at(-1).sha256 = 'invalid'
  await assert.rejects(() => parse(envelope(value)), /动作处理/)
})
const valueAt = (value, path) => path.split('.').filter(Boolean).reduce((item, key) => item[key], value)
const objectPaths = ['', 'owner', 'shot', 'coverage', 'processing', 'source_probe', 'source_probe.time_base',
  'timing', 'timing.frames.0', 'frames.0', 'frames.0.clip_interval', 'frames.0.clip_interval.start',
  'frames.0.clip_interval.start.time_base', 'frames.0.clip_interval.end', 'frames.0.clip_interval.end.time_base',
  'frames.0.masks.0', 'output_probe', 'output_probe.frames.0', 'output_probe.packets.0', 'output']
for (const objectPath of objectPaths) {
  for (const key of Object.keys(valueAt(originalReport, objectPath))) test(`原报告拒绝缺字段 ${objectPath || 'report'}.${key}`, async () => {
    const value = report(); delete valueAt(value, objectPath)[key]
    await assert.rejects(() => parse(envelope(value)), /动作处理/)
  })
  for (const mutation of ['extra', 'array', 'null']) test(`原报告拒绝对象 ${objectPath || 'report'} ${mutation}`, async () => {
    let value = report()
    if (mutation === 'extra') valueAt(value, objectPath).untrusted = true
    else {
      const parts = objectPath.split('.'), key = parts.pop(), replacement = mutation === 'array' ? [] : null
      if (objectPath) valueAt(value, parts.join('.'))[key] = replacement
      else value = replacement
    }
    await assert.rejects(() => parse(envelope(value)), /动作处理/)
  })
}
const invalidValues = {
  source_shot_id: ['', 1, 'shot\n1'], source_asset_id: [0, 1.5, '2', Number.MAX_SAFE_INTEGER + 1], source_size: [0, -1, '3'],
  'owner.tenant_id': [[], null], 'owner.user_id': [[], null], 'shot.expected_updated_at': [[], null],
  'shot.start_ms': [-1, 0.5, '0'], 'shot.end_ms': [0, -1, '4000'],
  'coverage.approved_by': ['', {}, 'bad\nuser'], 'coverage.approved_at': ['', 1],
  quality_review: ['approved', null], 'source_probe.origin': ['unbound'],
  'source_probe.width': [0, 321, '320'], 'source_probe.height': [-1, 181],
  'source_probe.sample_aspect_ratio': ['0:1', '1/1', 1], 'source_probe.display_aspect_ratio': ['16:0', '', []],
  'source_probe.rotation': [90, '0'], 'source_probe.duration_ticks': [0, 1.5], 'source_probe.duration_ms': [0, '12000', null],
  'source_probe.duration_tolerance_ms': [0, 2], 'source_probe.time_base.numerator': [0, 1.5],
  'source_probe.time_base.denominator': [0, '12288'], 'timing.timescale': [0, 2147483648, '1536000'],
  'timing.duration': [0, 1.5], 'timing.tolerance_ticks': [1, 3, '2'], 'timing.rounding': ['anything'],
  frames: [[], {}, null], 'timing.frames': [[], {}, null], 'frames.0.frame_index': [-1, 0.5],
  'frames.0.timestamp_ticks': [-1, '0'], 'frames.0.union_white_pixels': [-1, 57601, 1.5],
  'frames.0.unmasked_rgb_changed_samples': [1, '0'], 'frames.0.masks': [{}, null],
  'frames.0.masks.0.region_id': ['', 1], 'frames.0.masks.0.kind': ['', {}],
  'frames.0.clip_interval.start.ticks': [-1, '0'], 'frames.0.clip_interval.end.ticks': [-1, 1.5],
  'frames.0.clip_interval.start.time_base.numerator': [0], 'frames.0.clip_interval.end.time_base.denominator': [0],
  'timing.frames.0.frame_index': [-1], 'timing.frames.0.pts': [-1, '0'], 'timing.frames.0.duration': [0, 0.5],
  'timing.frames.0.concat_start_us': [-1], 'timing.frames.0.concat_duration_us': [0],
  'output_probe.codec': ['hevc'], 'output_probe.pixel_format': ['rgb24'], 'output_probe.time_base': ['1/12288'],
  'output_probe.frame_count': [47, '48'], 'output_probe.packet_count': [47, '48'], 'output_probe.start_pts': [1, '0'],
  'output_probe.duration_ticks': [0], 'output_probe.frames': [[], {}, null], 'output_probe.packets': [[], {}, null],
  'output_probe.frames.0.pts': [-1], 'output_probe.frames.0.duration': [0],
  'output_probe.packets.0.pts': [-1], 'output_probe.packets.0.duration': [0],
}
for (const [key, value] of Object.entries(originalReport.processing)) invalidValues[`processing.${key}`] = [typeof value === 'string' ? 'unsupported' : value === false ? true : value + 1]
for (const path of ['facts_hash', 'source_fingerprint', 'input_binding_sha256', 'input_frame_mask_set_sha256',
  'coverage.analysis_sha256', 'coverage.file_sha256', 'frames.0.source_frame_sha256', 'frames.0.union_mask_sha256',
  'frames.0.processed_png_sha256', 'frames.0.masks.0.sha256', 'output.sha256']) invalidValues[path] = ['x'.repeat(64), 'a'.repeat(63), [], null]
for (const [path, values] of Object.entries(invalidValues)) for (const [index, replacement] of values.entries()) {
  test(`原报告拒绝非法值 ${path} #${index}`, async () => {
    const value = report(), parts = path.split('.'), key = parts.pop()
    valueAt(value, parts.join('.'))[key] = replacement
    await assert.rejects(() => parse(envelope(value)), /动作处理/)
  })
}
test('有界解析保持原报告文本，视频只切片且待审状态不转换为质量结论', async () => {
  const raw = JSON.stringify(report(), null, 2), blob = envelope(report(), { json: new TextEncoder().encode(raw) })
  blob.arrayBuffer = () => { throw new Error('禁止整包读取') }
  const result = await parse(blob)
  assert.equal(result.processingReport, raw); assert.ok(result.file instanceof File)
  assert.equal(result.file.type, 'video/mp4'); assert.equal(result.file.size, 3)
  assert.equal(JSON.parse(result.processingReport).approval_status, 'pending')
  assert.deepEqual([...new Uint8Array(await result.file.arrayBuffer())], [1, 2, 3])
})
for (const kind of ['magic', 'version', 'short-header', 'zero-json', 'large-json', 'truncated-json', 'invalid-utf8',
  'invalid-json', 'extra-video', 'truncated-video', 'mime', 'schema', 'approval', 'source', 'tenant', 'user', 'work', 'version-id', 'shot', 'CAS',
  'output-mime', 'output-hash', 'output-size', 'empty-video']) test(`拒绝不可信 envelope ${kind}`, async () => {
  const value = report(), options = {}
  if (kind === 'magic') options.magic = 'BAD00001'
  if (kind === 'version') options.magic = 'RDMO0002'
  if (kind === 'zero-json') options.length = 0
  if (kind === 'large-json') options.length = MAX_JSON + 1
  if (kind === 'truncated-json') options.length = 99999
  if (kind === 'invalid-utf8') options.json = new Uint8Array([0xc3, 0x28])
  if (kind === 'invalid-json') options.json = new TextEncoder().encode('{')
  if (kind === 'extra-video') options.video = new Uint8Array(4)
  if (kind === 'truncated-video') options.video = new Uint8Array(2)
  if (kind === 'mime') options.type = 'video/mp4'
  if (kind === 'schema') value.schema_version = 'unsupported'
  if (kind === 'approval') value.approval_status = 'approved'
  if (kind === 'source') value.source_fingerprint = 'c'.repeat(64)
  if (kind === 'tenant') value.owner.tenant_id = 'another'
  if (kind === 'user') value.owner.user_id = 'another'
  if (kind === 'work') value.work_id = 9
  if (kind === 'version-id') value.version_id = 9
  if (kind === 'shot') value.shot_id = 9
  if (kind === 'CAS') value.shot.expected_updated_at = 'old'
  if (kind === 'output-mime') value.output.mime = 'video/quicktime'
  if (kind === 'output-hash') value.output.sha256 = 'untrusted'
  if (kind === 'output-size') value.output.size = '3'
  if (kind === 'empty-video') { value.output.size = 0; options.video = new Uint8Array(0) }
  const blob = kind === 'short-header' ? new Blob(['RDMO'], { type: mime }) : envelope(value, options)
  await assert.rejects(() => parse(blob), /动作处理/)
})
test('超过整体资源边界在任何读取之前拒绝', async () => {
  class Oversize extends Blob {
    get size() { return 12 + MAX_JSON + MAX_VIDEO + 1 }
    slice() { assert.fail('超限不能读取') }
  }
  await assert.rejects(() => parse(new Oversize([], { type: mime })), /动作处理/)
})
test('最大合法报告与媒体仅有界切片，不为视频申请整包 ArrayBuffer', async () => {
  const value = report(); value.output.size = MAX_VIDEO
  const json = JSON.stringify(value).padEnd(MAX_JSON, ' ')
  const prefix = envelope(value, { json: new TextEncoder().encode(json), video: new Uint8Array(0) })
  const reads = []
  class VirtualVideo extends Blob {
    get size() { return prefix.size + MAX_VIDEO }
    async arrayBuffer() { assert.fail('禁止整包读取') }
    slice(start, end, type) {
      reads.push([start, end]); if (start < prefix.size) return prefix.slice(start, end, type)
      return new Blob(['video-slice'], { type })
    }
  }
  const result = await parse(new VirtualVideo([], { type: mime }))
  assert.equal(result.processingReport.length, MAX_JSON)
  assert.deepEqual(reads, [[0, 12], [12, 12 + MAX_JSON], [12 + MAX_JSON, 12 + MAX_JSON + MAX_VIDEO]])
})
test('abort 在头部读取等待后阻止继续读报告和构造 File', async () => {
  const controller = new AbortController(), blob = envelope(); let finish
  const original = blob.slice.bind(blob)
  blob.slice = (start, end, type) => start === 0 ? { arrayBuffer: () => new Promise(resolve => { finish = resolve }) } : original(start, end, type)
  const pending = parse(blob, { signal: controller.signal }); await Promise.resolve()
  controller.abort(); finish(await original(0, 12).arrayBuffer())
  await assert.rejects(pending, error => error.name === 'AbortError')
})
test('业务错误 Blob 只解析小 JSON，非 JSON 或过大错误使用本地友好信息', async () => {
  assert.equal(typeof parser.motionProcessingErrorMessage, 'function')
  assert.equal(await parser.motionProcessingErrorMessage({ response: { data: new Blob(['{"message":"覆盖尚未审核"}'], { type: 'application/json' }) } }), '覆盖尚未审核')
  const oversized = new Blob([' '.repeat(65537)], { type: 'application/json' })
  oversized.arrayBuffer = () => assert.fail('过大错误禁止读取')
  assert.match(await parser.motionProcessingErrorMessage({ response: { data: oversized } }), /动作处理/)
})
test('真实后端 success false 的 error.message Blob 返回明确业务拒绝', async () => {
  assert.equal(await parser.motionProcessingErrorMessage({ response: { data: new Blob([JSON.stringify({ success: false,
    error: { code: 'REDRAW_MOTION_PROCESSING_CONFLICT', message: '动作处理报告绑定已过期' }, timestamp: '2026-09-06T00:00:00Z' })],
  { type: 'application/json; charset=utf-8' }) } }), '动作处理报告绑定已过期')
})
for (const [timeBase, accepted, rejected] of [
  ['1/1536000', [4, 4.000001, 3.999999], [4.0000011, 3.9999989, 4.000002]],
  ['1/1000', [4.001, 3.999], [4.0010001, 3.9989999, 4.001001]],
  ['1001/30000', [4 + 1001 / 30000, 4 - 1001 / 30000], [4 + 1001 / 30000 + 1e-7]],
]) test(`实际输出时基 ${timeBase} 只允许一tick或1µs的最大值`, () => {
  assert.equal(typeof coverageHelpers.assertMotionDuration, 'function')
  const [numerator, denominator] = timeBase.split('/').map(Number)
  for (const duration of accepted) assert.equal(coverageHelpers.assertMotionDuration(duration, 4, timeBase),
    Math.max(numerator / denominator, 0.000001))
  for (const duration of rejected) assert.throws(() => coverageHelpers.assertMotionDuration(duration, 4, timeBase), /duration/)
})
test('时长核验拒绝非法时基和非有限或负时长', () => {
  assert.equal(typeof coverageHelpers.assertMotionDuration, 'function')
  for (const timeBase of ['0/1', '1/0', '-1/2', '1', '1/2/3', 'bad', '1.5/2']) {
    assert.throws(() => coverageHelpers.assertMotionDuration(4, 4, timeBase))
  }
  for (const duration of [-1, NaN, Infinity, '4']) {
    assert.throws(() => coverageHelpers.assertMotionDuration(duration, 4, '1/1536000'))
    assert.throws(() => coverageHelpers.assertMotionDuration(4, duration, '1/1536000'))
  }
})
