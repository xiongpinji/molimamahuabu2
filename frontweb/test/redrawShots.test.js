import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

function source(path) {
  const url = new URL(path, import.meta.url)
  return existsSync(url) ? readFileSync(url, 'utf8') : ''
}

const apiSource = source('../src/api/redraw.js')
const workspaceSource = source('../src/views/RedrawWorkspace.vue')
const stepSource = source('../src/components/redraw/RedrawShotStep.vue')
const editorSource = source('../src/components/redraw/RedrawShotEditor.vue')
const referenceBundleSource = source('../src/components/redraw/RedrawReferenceBundlePanel.vue')
const batchSource = source('../src/components/redraw/RedrawBatchPanel.vue')
const previewSource = source('../src/components/redraw/RedrawShotPreview.vue')

function evaluateReferenceBundleEvidence(response, shotId) {
  const functionSource = stepSource.slice(
    stepSource.indexOf('function referenceBundleEvidence'),
    stepSource.indexOf('function setReferenceBundleState'),
  )
  const factory = new Function('HEX_SHA256', `${functionSource}; return referenceBundleEvidence`)
  return factory(/^[a-f0-9]{64}$/i)(response, shotId)
}

function readyReferenceBundle(locale, market, dialogue = {}) {
  return {
    shot_id: 7,
    reference_bundle_hash: 'a'.repeat(64),
    reference_bundle_updated_at: '2026-08-23T08:00:00.000Z',
    bundle: {
      schema_version: 'redraw-reference-bundle-v2',
      locale,
      market,
      coverage_review: {
        recognizable_face_count: 0,
        mapped_face_count: 0,
        unresolved_face_count: 0,
        recognizable_text_region_count: 0,
        mapped_text_region_count: 0,
        unresolved_text_region_count: 0,
      },
      face_tracks: [],
      text_regions: [],
      motion_reference: { asset_id: 1, sha256: 'b'.repeat(64), audio_stream_count: 0 },
      dialogue: { target_locale: locale, target_market: market, turns: [], ...dialogue },
    },
  }
}

async function shotState() {
  try {
    return await import('../src/utils/redrawShotState.js')
  } catch (error) {
    assert.fail(`分镜状态工具尚未实现: ${error.code || error.message}`)
  }
}

test('分镜状态归一化保留后端批次并在刷新后恢复选中镜头', async () => {
  const { normalizeShotWorkspace, restoreSelectedShotId } = await shotState()
  const work = {
    shots: [
      { id: 11, batch_index: 1, shot_index: 1, status: 'draft' },
      { id: 12, batch_index: 1, shot_index: 2, status: 'processing' },
      { id: 13, batch_index: 2, shot_index: 3, status: 'completed' },
    ],
    batches: [
      { batch_index: 1, duration_ms: 12000, shots: [{ id: 11 }, { id: 12 }] },
      { batch_index: 2, duration_ms: 10000, shots: [{ id: 13 }] },
    ],
  }
  const normalized = normalizeShotWorkspace(work)
  assert.deepEqual(normalized.batches.map((batch) => batch.batch_index), [1, 2])
  assert.deepEqual(normalized.batches[0].shots.map((shot) => shot.id), [11, 12])
  assert.equal(restoreSelectedShotId(normalized.shots, 12), 12)
  assert.equal(restoreSelectedShotId(normalized.shots, 99), 11)
})

test('结构化目标对白读取 localized_text 且换镜头时不沿用旧文本', async () => {
  const { localizedDialogueText } = await shotState()
  assert.equal(localizedDialogueText([{
    speaker_id: 'c1',
    source_text: '就是这里。',
    localized_text: 'Fue aquí.',
    start_ms: 900,
    end_ms: 2300,
  }]), 'Fue aquí.')
  assert.equal(localizedDialogueText([{
    speaker_id: 'c2',
    localized_text: 'No fue aquí.',
    start_ms: 3100,
    end_ms: 4200,
  }]), 'No fue aquí.')
})

test('只改非对白字段时完整保留服务端结构化目标对白', async () => {
  const { localizedDialogueText, mergeLocalizedDialogueText } = await shotState()
  const dialogue = [{
    speaker_id: 'c1',
    source_text: '就是这里。',
    localized_text: 'Fue aquí.',
    start_ms: 900,
    end_ms: 2300,
    emotion: null,
    overlap_group: null,
    estimated_duration_ms: 600,
    binding: { character_id: 17 },
  }]
  const baseline = structuredClone(dialogue)
  const result = mergeLocalizedDialogueText(dialogue, localizedDialogueText(dialogue))
  assert.equal(result.ok, true)
  assert.deepEqual(result.dialogue, baseline)
  assert.deepEqual(dialogue, baseline)
})

test('编辑目标对白时仅按索引更新 localized_text 并保留稳定身份时序字段', async () => {
  const { mergeLocalizedDialogueText } = await shotState()
  const dialogue = [
    {
      speaker_id: 'c1', source_text: '就是这里。', localized_text: 'Fue aquí.',
      start_ms: 900, end_ms: 2300, emotion: null, overlap_group: null,
      estimated_duration_ms: 600,
    },
    {
      speaker_id: 'c2', source_text: '不是这里。', localized_text: 'No aquí.',
      start_ms: 2400, end_ms: 3600, emotion: 'angry', overlap_group: 'g1',
      estimated_duration_ms: 700,
    },
  ]
  const baseline = structuredClone(dialogue)
  const result = mergeLocalizedDialogueText(dialogue, 'Fue aquí.\nNo fue aquí.')
  assert.equal(result.ok, true)
  assert.deepEqual(result.dialogue, [
    baseline[0],
    { ...baseline[1], localized_text: 'No fue aquí.' },
  ])
  assert.deepEqual(dialogue, baseline)
})

test('无法安全映射目标对白行时关闭保存且静默镜头保持空数组', async () => {
  const { mergeLocalizedDialogueText } = await shotState()
  const dialogue = [
    { speaker_id: 'c1', localized_text: 'Uno.', start_ms: 0, end_ms: 1000 },
    { speaker_id: 'c2', localized_text: 'Dos.', start_ms: 1000, end_ms: 2000 },
  ]
  assert.equal(mergeLocalizedDialogueText(dialogue, 'Uno.').ok, false)
  assert.equal(mergeLocalizedDialogueText(dialogue, 'Uno.\nDos.\nTres.').ok, false)
  assert.equal(mergeLocalizedDialogueText(['旧字符串结构'], '旧字符串结构').ok, false)
  assert.deepEqual(mergeLocalizedDialogueText([], ''), { ok: true, dialogue: [], reason: '' })
  assert.equal(mergeLocalizedDialogueText([], '不得新增').ok, false)
  assert.match(editorSource, /localizedDialogueEdit/)
  assert.match(editorSource, /dialogueEditError/)
  assert.match(editorSource, /if \(!localizedDialogueEdit\.value\.ok\) return/)
})

test('筛选、报价汇总和轮询严格使用后端状态且区分零价与未定价', async () => {
  const { filterShots, quoteCredits, sumShotQuotes, shouldPollWork } = await shotState()
  const shots = [
    { id: 1, status: 'draft', quote_snapshot: { amount: 0 } },
    { id: 2, status: 'failed', billing: { quote: { amount: 6 } } },
    { id: 3, status: 'completed', billing: { quote: { credits: 8 } } },
    { id: 4, status: 'needs_attention', billing: { quote: null } },
  ]
  assert.deepEqual(filterShots(shots, 'incomplete').map((shot) => shot.id), [1, 2, 4])
  assert.deepEqual(filterShots(shots, 'failed').map((shot) => shot.id), [2, 4])
  assert.deepEqual(filterShots(shots, 'completed').map((shot) => shot.id), [3])
  assert.equal(quoteCredits(shots[0]), 0)
  assert.equal(quoteCredits(shots[3]), null)
  assert.deepEqual(sumShotQuotes(shots.slice(0, 3)), { priced: true, total: 14 })
  assert.deepEqual(sumShotQuotes(shots), { priced: false, total: null })
  assert.equal(shouldPollWork([{ generation: { status: 'processing' } }]), true)
  assert.equal(shouldPollWork([{ status: 'completed', generation: { status: 'completed' } }]), false)
})

test('第三步生成门禁消费后端 availability、顶层 quote 和新片 video_url', async () => {
  const { generationAvailability, quoteCredits, sumShotQuotes } = await shotState()
  const priced = {
    id: 21,
    status: 'draft',
    generation_availability: { ok: true },
    quote: { amount: 9 },
  }
  const blocked = {
    id: 22,
    status: 'draft',
    generation_availability: { ok: false, reason: '当前语言市场没有已验证可读的视频生成能力' },
    quote: { amount: 9 },
  }
  assert.equal(quoteCredits(priced), 9)
  assert.deepEqual(sumShotQuotes([priced]), { priced: true, total: 9 })
  assert.deepEqual(generationAvailability(priced, { ok: true, missing: [] }), { ok: true, reason: '' })
  assert.deepEqual(generationAvailability(blocked, { ok: true, missing: [] }), {
    ok: false,
    reason: '当前语言市场没有已验证可读的视频生成能力',
  })
})

test('引用提示只使用当前版本已批准资产并保存结构化版本', async () => {
  const { approvedReferenceOptions, structuredReferences } = await shotState()
  const assets = [
    { id: 71, asset_id: 901, kind: 'character', localized_name: 'Maya', version_number: 3, approval_status: 'approved' },
    { id: 72, kind: 'scene', localized_name: '旧仓库', version_number: 2, approval_status: 'approved' },
    { id: 73, kind: 'prop', localized_name: '铜钥匙', version_number: 2, approval_status: 'pending' },
  ]
  assert.deepEqual(approvedReferenceOptions(assets, '@Ma').map((item) => item.id), [71])
  assert.deepEqual(structuredReferences([assets[0], assets[1]]), [
    { redraw_asset_id: 71, kind: 'character', version_number: 3 },
    { redraw_asset_id: 72, kind: 'scene', version_number: 2 },
  ])
})

test('第三步 API 只提交后端允许的更新、单镜和批量入口', () => {
  for (const name of ['updateShot', 'generateShot', 'generateBatch']) {
    assert.match(apiSource, new RegExp(`${name}\\(`), name)
  }
  assert.match(apiSource, /\/redraw\/shots\/\$\{shotId\}/)
  assert.match(apiSource, /generate-batch/)
})

test('参考包 API 使用精确 GET PUT 且保存参数由客户端白名单重建', async () => {
  assert.match(apiSource, /getReferenceBundle\(shotId\)/)
  assert.match(apiSource, /saveReferenceBundle\(shotId, body\)/)
  assert.match(apiSource, /request\.get\(`\/redraw\/shots\/\$\{shotId\}\/reference-bundle`\)/)
  assert.match(apiSource, /request\.put\(`\/redraw\/shots\/\$\{shotId\}\/reference-bundle`,\s*buildReferenceBundlePayload\(body\)\)/)
  for (const field of [
    'expected_updated_at', 'motion_reference_asset_id', 'face_tracks', 'text_regions',
    'coverage_review', 'track_key', 'source_character_key', 'time_ranges',
    'identity_redraw_asset_id', 'region_key', 'kind', 'text_clean_redraw_asset_id',
    'recognizable_face_count', 'mapped_face_count', 'unresolved_face_count',
    'recognizable_text_region_count', 'mapped_text_region_count',
    'unresolved_text_region_count', 'status',
  ]) assert.match(apiSource, new RegExp(field), field)
  assert.doesNotMatch(apiSource, /saveReferenceBundle[\s\S]{0,260}\.\.\.body/)

  const executableSource = apiSource.replace("import request from '@/utils/request'", 'const request = {}')
  const apiModule = await import(`data:text/javascript;base64,${Buffer.from(executableSource).toString('base64')}`)
  const payload = apiModule.buildReferenceBundlePayload({
    expected_updated_at: 'server-shot-version',
    motion_reference_asset_id: 11,
    face_tracks: [{
      track_key: 'face-1',
      source_character_key: 'mateo',
      time_ranges: [[0, 5000]],
      identity_redraw_asset_id: 21,
      identity_pack_sha256: 'client-must-not-send',
    }],
    text_regions: [{
      region_key: 'subtitle-1',
      kind: 'text_subtitle',
      time_ranges: [[0, 5000]],
      text_clean_redraw_asset_id: 31,
      url: 'https://client-must-not-send.example',
    }],
    coverage_review: {
      recognizable_face_count: 1,
      mapped_face_count: 1,
      unresolved_face_count: 0,
      recognizable_text_region_count: 1,
      mapped_text_region_count: 1,
      unresolved_text_region_count: 0,
      status: 'approved',
      reviewed_by: 'client-must-not-send',
    },
    ready: true,
    reference_bundle_hash: 'client-must-not-send',
  })
  assert.deepEqual(payload, {
    expected_updated_at: 'server-shot-version',
    motion_reference_asset_id: 11,
    face_tracks: [{
      track_key: 'face-1',
      source_character_key: 'mateo',
      time_ranges: [[0, 5000]],
      identity_redraw_asset_id: 21,
    }],
    text_regions: [{
      region_key: 'subtitle-1',
      kind: 'text_subtitle',
      time_ranges: [[0, 5000]],
      text_clean_redraw_asset_id: 31,
    }],
    coverage_review: {
      recognizable_face_count: 1,
      mapped_face_count: 1,
      unresolved_face_count: 0,
      recognizable_text_region_count: 1,
      mapped_text_region_count: 1,
      unresolved_text_region_count: 0,
      status: 'approved',
    },
  })
  assert.throws(() => apiModule.buildReferenceBundlePayload({ face_tracks: '[]' }), /格式错误/)
})

test('逐镜参考包面板显示五段服务端证据且不提供客户端 ready 或敏感字段输入', () => {
  for (const label of ['人物轨迹', '身份包', '文字净景', '无原音运动参考', '英文对白']) {
    assert.match(referenceBundleSource, new RegExp(label), label)
  }
  assert.match(referenceBundleSource, /JSON\.parse/)
  assert.match(referenceBundleSource, /参考包编辑内容格式错误/)
  assert.match(referenceBundleSource, /coverage_review/)
  assert.doesNotMatch(referenceBundleSource, /v-model[^>]*(?:hash|path|url|reviewer|ready)/i)
})

test('强制参考包版本仅以 GET 完整证据放行保存后单镜与批量生成', () => {
  assert.match(stepSource, /reference_bundle_required\s*===\s*true/)
  assert.match(stepSource, /bundle\?\.schema_version\s*===\s*'redraw-reference-bundle-v2'/)
  assert.doesNotMatch(stepSource, /redraw-reference-bundle-v1/)
  assert.match(stepSource, /getReferenceBundle/)
  assert.match(stepSource, /loadAllReferenceBundles/)
  assert.match(stepSource, /referenceBundleEvidence/)
  assert.match(stepSource, /saveReferenceBundle/)
  assert.match(stepSource, /expected_updated_at:\s*currentShot\.updated_at/)
  assert.match(stepSource, /responseStatus\(error\)\s*===\s*409/)
  assert.match(stepSource, /await refreshWork\(\{ quiet: true \}\)/)
  const saveFunction = stepSource.slice(
    stepSource.indexOf('async function saveReferenceBundleDraft'),
    stepSource.indexOf('async function saveShot'),
  )
  assert.equal((saveFunction.match(/redrawAPI\.saveReferenceBundle/g) || []).length, 1)
  assert.match(stepSource, /verifiedShotIds/)
  assert.match(stepSource, /if \(!verifiedShotIds\.length\) return/)
  assert.match(editorSource, /RedrawReferenceBundlePanel/)
  assert.match(editorSource, /props\.referenceBundleRequired/)
  assert.match(editorSource, /props\.referenceBundleSaving \|\| !props\.referenceBundleState\.ready/)
  assert.match(editorSource, /canvas-credit-callout-v1/)
})

test('参考包对白就绪绑定当前 locale 和 market 且不硬编码美国英语', () => {
  assert.doesNotMatch(stepSource, /target_locale\s*===\s*'en-US'/)
  assert.equal(evaluateReferenceBundleEvidence(readyReferenceBundle('en-US', 'US'), 7).ready, true)
  assert.equal(evaluateReferenceBundleEvidence(readyReferenceBundle('es-ES', 'ES'), 7).ready, true)
  assert.equal(evaluateReferenceBundleEvidence(readyReferenceBundle('es-ES', 'ES', { target_locale: 'en-US' }), 7).ready, false)
  assert.equal(evaluateReferenceBundleEvidence(readyReferenceBundle('es-ES', 'ES', { target_market: 'US' }), 7).ready, false)
  assert.equal(evaluateReferenceBundleEvidence(readyReferenceBundle('es-ES', 'ES', { target_locale: '' }), 7).ready, false)
  assert.equal(evaluateReferenceBundleEvidence(readyReferenceBundle('es-ES', 'ES', { target_market: '' }), 7).ready, false)
})

test('单镜生成时长与后端合同统一为 5 到 15 秒且五秒源镜头可生成', () => {
  assert.match(editorSource, /建议保持 5–15 秒/)
  assert.match(editorSource, /v-model="form\.duration" :min="5" :max="15"/)
  assert.match(editorSource, /durationSeconds\.value >= 5 && durationSeconds\.value <= 15/)
  assert.match(editorSource, /Math\.max\(5, Math\.min\(15,/)
  assert.doesNotMatch(editorSource, /建议保持 10–15 秒/)
})

test('单镜编辑器使用通用目标语台词文案且不硬编码英文', () => {
  assert.match(editorSource, /label="目标语台词"/)
  assert.doesNotMatch(editorSource, /label="英文台词"/)
})

test('第三步工作台覆盖批次、编辑、计费、重试、对照预览和后端轮询', () => {
  assert.match(workspaceSource, /RedrawShotStep/)
  assert.match(stepSource, /RedrawShotEditor/)
  assert.match(stepSource, /RedrawBatchPanel/)
  assert.match(stepSource, /RedrawShotPreview/)
  assert.match(stepSource, /getWork/)
  assert.match(stepSource, /clearInterval/)
  assert.match(editorSource, /@角色\/@场景\/@物品/)
  assert.match(editorSource, /开场状态/)
  assert.match(editorSource, /连续动作/)
  assert.match(editorSource, /镜尾状态/)
  assert.match(editorSource, /count/)
  assert.match(batchSource, /未完成/)
  assert.match(batchSource, /失败/)
  assert.match(batchSource, /已完成/)
  assert.match(batchSource, /本次预计扣除/)
  assert.match(batchSource, /批量总价/)
  assert.match(batchSource, /分镜价格明细/)
  assert.match(batchSource, /v-for="shot in visibleShots"/)
  assert.match(batchSource, /冻结/)
  assert.match(batchSource, /已扣/)
  assert.match(batchSource, /已退/)
  assert.match(previewSource, /原片/)
  assert.match(previewSource, /新片/)
  assert.match(previewSource, /source_video_ref/)
  assert.match(previewSource, /new_video_ref/)
  assert.match(previewSource, /video_url/)
})

test('受保护积分文案和安全生成 payload 不接受客户端价格与产物字段', () => {
  assert.match(editorSource, /本次预计扣除/)
  assert.match(editorSource, /积分待管理员配置/)
  assert.match(batchSource, /积分待管理员配置/)
  assert.match(stepSource, /retry:\s*true/)
  assert.doesNotMatch(stepSource, /credit_amount|price|owner_id|task_id|new_video_ref\s*:/)
})
