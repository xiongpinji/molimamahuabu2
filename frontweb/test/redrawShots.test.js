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
const batchSource = source('../src/components/redraw/RedrawBatchPanel.vue')
const previewSource = source('../src/components/redraw/RedrawShotPreview.vue')

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
  assert.match(batchSource, /批量总预计扣除/)
  assert.match(previewSource, /原片/)
  assert.match(previewSource, /新片/)
  assert.match(previewSource, /source_video_ref/)
  assert.match(previewSource, /new_video_ref/)
})

test('受保护积分文案和安全生成 payload 不接受客户端价格与产物字段', () => {
  assert.match(editorSource, /本次预计扣除/)
  assert.match(editorSource, /积分待管理员配置/)
  assert.match(batchSource, /积分待管理员配置/)
  assert.match(stepSource, /retry:\s*true/)
  assert.doesNotMatch(stepSource, /credit_amount|price|owner_id|task_id|new_video_ref\s*:/)
})
