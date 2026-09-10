const CONTENT_TYPE = 'application/vnd.moli.redraw-motion-processing.v1'
const MAX_REPORT_BYTES = 8 * 1024 * 1024
const MAX_VIDEO_BYTES = 200 * 1024 * 1024
const invalid = () => new Error('动作处理结果无效或绑定已变化，请重新制作待审动作参考')
const check = condition => { if (!condition) throw invalid() }
const checkAbort = signal => { if (signal?.aborted) throw new DOMException('已取消动作处理', 'AbortError') }
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const text = value => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value)
const ratio = value => typeof value === 'string' && /^[1-9]\d*:[1-9]\d*$/.test(value)
const processing = { method: 'conservative_mask_union_gaussian_detail_reduction', sigma_px: 12,
  mask_scope: 'all_story_role_background_extra_and_text', empty_region_behavior: 'unchanged_rgb',
  codec: 'h264', pixel_format: 'yuv420p', preset: 'ultrafast', crf: 18, b_frames: 0, audio: false }

function keys(value, names) {
  check(value && Object.getPrototypeOf(value) === Object.prototype)
  const expected = names.split(' ')
  check(Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)))
}
function timeBase(value) {
  keys(value, 'numerator denominator')
  check(integer(value.numerator, 1) && integer(value.denominator, 1))
}

// Mirror the original v1 report shape. Hash syntax and reported probe fields are not attestation.
function validateReport(report) {
  keys(report, 'schema_version approval_status owner work_id version_id shot_id source_shot_id shot facts_hash source_asset_id source_fingerprint source_size coverage input_binding_sha256 input_frame_mask_set_sha256 processing source_probe timing frames output_probe output quality_review')
  check(report.schema_version === 'redraw-motion-obscuration-report-v1' && report.approval_status === 'pending'
    && report.quality_review === 'pending_human_review; lossy_encoding_is_not_pixel_identity_or_background_approval')
  keys(report.owner, 'tenant_id user_id')
  check(text(report.owner.tenant_id) && text(report.owner.user_id) && text(report.source_shot_id))
  check(['work_id', 'version_id', 'shot_id', 'source_asset_id', 'source_size'].every(key => integer(report[key], 1)))
  check(['facts_hash', 'source_fingerprint', 'input_binding_sha256', 'input_frame_mask_set_sha256'].every(key => hash(report[key])))
  keys(report.shot, 'expected_updated_at start_ms end_ms')
  check(text(report.shot.expected_updated_at) && integer(report.shot.start_ms) && integer(report.shot.end_ms, report.shot.start_ms + 1))
  keys(report.coverage, 'analysis_sha256 file_sha256 approved_by approved_at')
  check(hash(report.coverage.analysis_sha256) && hash(report.coverage.file_sha256)
    && text(report.coverage.approved_by) && text(report.coverage.approved_at))
  keys(report.processing, Object.keys(processing).join(' '))
  check(Object.entries(processing).every(([key, value]) => report.processing[key] === value))
  const source = report.source_probe
  keys(source, 'origin width height sample_aspect_ratio display_aspect_ratio rotation time_base duration_ticks duration_ms duration_tolerance_ms')
  check(source.origin === 'sha256_bound_private_source_snapshot' && integer(source.width, 1) && integer(source.height, 1)
    && source.width % 2 === 0 && source.height % 2 === 0 && source.rotation === 0
    && ratio(source.sample_aspect_ratio) && ratio(source.display_aspect_ratio) && integer(source.duration_ticks, 1)
    && Number.isFinite(source.duration_ms) && source.duration_ms > 0 && source.duration_tolerance_ms === 1)
  timeBase(source.time_base)
  const timing = report.timing
  keys(timing, 'timescale frames duration tolerance_ticks rounding')
  check(integer(timing.timescale, 1) && timing.timescale <= 2147483647 && integer(timing.duration, 1)
    && timing.tolerance_ticks === Math.max(1, Math.ceil(timing.timescale / 1000000))
    && timing.rounding === 'absolute source boundaries rounded to nearest microsecond before differencing; at most one microsecond or one output tick')
  check(Array.isArray(report.frames) && report.frames.length > 0 && Array.isArray(timing.frames)
    && timing.frames.length === report.frames.length)
  for (const frame of report.frames) {
    keys(frame, 'frame_index timestamp_ticks clip_interval source_frame_sha256 masks union_mask_sha256 union_white_pixels processed_png_sha256 unmasked_rgb_changed_samples')
    check(integer(frame.frame_index) && integer(frame.timestamp_ticks) && hash(frame.source_frame_sha256)
      && hash(frame.union_mask_sha256) && hash(frame.processed_png_sha256) && integer(frame.union_white_pixels)
      && frame.union_white_pixels <= source.width * source.height && frame.unmasked_rgb_changed_samples === 0 && Array.isArray(frame.masks))
    keys(frame.clip_interval, 'start end')
    for (const point of [frame.clip_interval.start, frame.clip_interval.end]) {
      keys(point, 'ticks time_base'); check(integer(point.ticks)); timeBase(point.time_base)
    }
    for (const mask of frame.masks) {
      keys(mask, 'region_id kind sha256')
      check(text(mask.region_id) && text(mask.kind) && hash(mask.sha256))
    }
  }
  for (const frame of timing.frames) {
    keys(frame, 'frame_index pts duration concat_start_us concat_duration_us')
    check(integer(frame.frame_index) && integer(frame.pts) && integer(frame.duration, 1)
      && integer(frame.concat_start_us) && integer(frame.concat_duration_us, 1))
  }
  const output = report.output_probe
  keys(output, 'codec pixel_format time_base frame_count packet_count start_pts duration_ticks frames packets')
  check(output.codec === 'h264' && output.pixel_format === 'yuv420p' && output.time_base === `1/${timing.timescale}`
    && output.frame_count === report.frames.length && output.packet_count === report.frames.length
    && output.start_pts === 0 && integer(output.duration_ticks, 1))
  for (const section of [output.frames, output.packets]) {
    check(Array.isArray(section) && section.length === report.frames.length)
    for (const frame of section) { keys(frame, 'pts duration'); check(integer(frame.pts) && integer(frame.duration, 1)) }
  }
  keys(report.output, 'mime size sha256')
  check(report.output.mime === 'video/mp4' && integer(report.output.size, 1) && report.output.size <= MAX_VIDEO_BYTES && hash(report.output.sha256))
}

// The attachment is a returned technical report, not proof of renderer origin or human approval.
export async function parseMotionProcessingEnvelope(blob, binding, { signal } = {}) {
  checkAbort(signal)
  check(blob instanceof Blob && blob.type === CONTENT_TYPE && blob.size > 12
    && blob.size <= 12 + MAX_REPORT_BYTES + MAX_VIDEO_BYTES)
  const header = await blob.slice(0, 12).arrayBuffer()
  checkAbort(signal)
  check(header.byteLength === 12 && new TextDecoder('ascii').decode(header.slice(0, 8)) === 'RDMO0001')
  const length = new DataView(header).getUint32(8)
  const videoSize = blob.size - 12 - length
  check(length > 0 && length <= MAX_REPORT_BYTES && videoSize > 0 && videoSize <= MAX_VIDEO_BYTES)
  const bytes = await blob.slice(12, 12 + length).arrayBuffer()
  checkAbort(signal)
  check(bytes.byteLength === length)
  let processingReport, report
  try { processingReport = new TextDecoder('utf-8', { fatal: true }).decode(bytes); report = JSON.parse(processingReport) }
  catch (_) { throw invalid() }
  validateReport(report)
  check(text(binding?.owner?.tenant_id) && text(binding.owner.user_id)
    && report.owner.tenant_id === binding.owner.tenant_id && report.owner.user_id === binding.owner.user_id
    && ['work_id', 'version_id', 'shot_id'].every(key => report[key] === Number(binding[key]))
    && report.source_fingerprint === binding.expected_source_sha256
    && report.shot.expected_updated_at === binding.expected_updated_at
    && report.output.size === videoSize)
  checkAbort(signal)
  return { file: new File([blob.slice(12 + length, blob.size, 'video/mp4')], `motion-pending-${report.shot_id}.mp4`, { type: 'video/mp4' }), processingReport }
}

export async function motionProcessingErrorMessage(error, { signal } = {}) {
  checkAbort(signal)
  const blob = error?.response?.data
  if (blob instanceof Blob && blob.type.split(';')[0] === 'application/json' && blob.size > 0 && blob.size <= 64 * 1024) {
    try {
      const bytes = await blob.slice(0, blob.size).arrayBuffer()
      checkAbort(signal)
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      const message = result?.error?.message ?? result?.message
      if (typeof message === 'string' && message.length > 0 && message.length <= 500) return message
    } catch (failure) { if (signal?.aborted) throw failure }
  }
  return error instanceof Error && error.message.includes('动作处理') ? error.message : '动作处理失败，请核对当前源、镜头和逐帧覆盖后再手工重试'
}
