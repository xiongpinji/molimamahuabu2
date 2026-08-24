import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

function source(path) {
  const url = new URL(path, import.meta.url)
  return existsSync(url) ? readFileSync(url, 'utf8') : ''
}

const apiSource = source('../src/api/redraw.js')
const workspaceSource = source('../src/views/RedrawWorkspace.vue')
const stepSource = source('../src/components/redraw/RedrawEditStep.vue')
const timelineSource = source('../src/components/redraw/RedrawTimeline.vue')
const compareSource = source('../src/components/redraw/RedrawPlayerCompare.vue')
const exportSource = source('../src/components/redraw/RedrawExportPanel.vue')
const releaseSource = source('../src/components/redraw/RedrawEpisodeReleasePanel.vue')

async function editState() {
  try {
    return await import('../src/utils/redrawTimelineState.js')
  } catch (error) {
    assert.fail(`第四步状态工具尚未实现: ${error.code || error.message}`)
  }
}

test('第四步状态纯函数固定源片顺序并只在配音完成后允许合成', async () => {
  const {
    normalizeTimelineShots,
    canStartDialogue,
    dialogueQuoteCredits,
    canStartComposition,
    exportByKind,
    expandExportArtifacts,
    sourcePreviewUrl,
  } = await editState()
  const shots = [
    { id: 3, shot_index: 3, start_ms: 2000, end_ms: 3000, status: 'completed' },
    { id: 1, shot_index: 1, start_ms: 0, end_ms: 1000, status: 'completed' },
    { id: 2, shot_index: 2, start_ms: 1000, end_ms: 2000, status: 'failed' },
  ]
  assert.deepEqual(normalizeTimelineShots(shots).map((shot) => shot.id), [1, 2, 3])
  const readyQuote = { status: 'ready', priced: true, total_credits: 6, quote_hash: 'a'.repeat(64) }
  assert.equal(dialogueQuoteCredits(readyQuote), 6)
  assert.equal(canStartDialogue(readyQuote, null), true)
  for (const field of ['status', 'priced', 'total_credits', 'quote_hash']) {
    const incomplete = { ...readyQuote }
    delete incomplete[field]
    assert.equal(canStartDialogue(incomplete, null), false, `缺少 ${field} 必须禁用提交`)
  }
  assert.equal(canStartDialogue({ ...readyQuote, status: 'blocked' }, null), false)
  assert.equal(canStartDialogue({ ...readyQuote, priced: false }, null), false)
  assert.equal(canStartDialogue({ ...readyQuote, total_credits: '6' }, null), false)
  assert.equal(canStartDialogue({ ...readyQuote, total_credits: 1.5 }, null), false)
  assert.equal(canStartDialogue({ ...readyQuote, total_credits: Number.MAX_SAFE_INTEGER + 1 }, null), false)
  assert.equal(canStartDialogue({ ...readyQuote, quote_hash: 'a'.repeat(63) }, null), false)
  assert.equal(canStartDialogue({ ...readyQuote, quote_hash: 'A'.repeat(64) }, null), false)
  assert.equal(canStartDialogue(readyQuote, { status: 'processing' }), false)
  assert.equal(dialogueQuoteCredits({ ...readyQuote, priced: false }), null)
  assert.equal(canStartComposition(shots, { status: 'completed' }, null), false)
  assert.equal(canStartComposition(shots.filter((shot) => shot.status === 'completed'), { status: 'completed' }, null), true)
  assert.equal(canStartComposition(shots.filter((shot) => shot.status === 'completed'), { status: 'failed' }, null), false)
  assert.equal(canStartComposition(shots.filter((shot) => shot.status === 'completed'), { status: 'completed' }, { status: 'processing' }), false)
  assert.equal(exportByKind([{ kind: 'mp4', id: 9 }], 'mp4')?.id, 9)
  assert.deepEqual(expandExportArtifacts({
    id: 88,
    status: 'completed',
    hashes: { mp4: '1'.repeat(64), srt: '2'.repeat(64), vtt: null },
  }), [
    { exportId: 88, kind: 'mp4', sha256: '1'.repeat(64), status: 'completed' },
    { exportId: 88, kind: 'srt', sha256: '2'.repeat(64), status: 'completed' },
  ])
  assert.equal(sourcePreviewUrl(shots, 3), '')
  assert.equal(sourcePreviewUrl([
    { id: 1, source_video_ref: { url: 'https://fixtures.example/first.mp4' } },
    { id: 2, source_video_ref: { url: 'https://fixtures.example/second.mp4', local_path: 'C:/secret.mp4' } },
  ], 2), 'https://fixtures.example/second.mp4')
})

test('第四步 API 只暴露报价、启动、状态、合成、导出列表和 blob 下载入口', () => {
  for (const name of [
    'quoteDialogue',
    'startDialogue',
    'getDialogueTask',
    'composeVersion',
    'listExports',
    'getExport',
    'downloadExport',
  ]) {
    assert.match(apiSource, new RegExp(`${name}\\(`), name)
  }
  assert.match(apiSource, /dialogue\/quote/)
  assert.match(apiSource, /dialogue\/start/)
  assert.match(apiSource, /dialogue\/tasks/)
  assert.match(apiSource, /compose/)
  assert.match(apiSource, /listExports\(versionId\)[\s\S]*\/redraw\/versions\/\$\{versionId\}\/exports/)
  assert.match(apiSource, /getExport\(exportId\)[\s\S]*\/redraw\/exports\/\$\{exportId\}/)
  assert.match(apiSource, /downloadExport\(exportId,\s*kind\)[\s\S]*\/redraw\/exports\/\$\{exportId\}\/download\/\$\{encodeURIComponent\(kind\)\}/)
  assert.doesNotMatch(apiSource, /versions\/\$\{versionId\}\/exports\/\$\{exportId\}/)
  assert.match(apiSource, /responseType:\s*['"]blob['"]/)
})

test('第四步工作台由后端 current_step 门禁开放且不伪装完整 NLE', () => {
  assert.match(workspaceSource, /RedrawEditStep/)
  assert.match(workspaceSource, /allowedStep === 4/)
  assert.match(workspaceSource, /item\.step > backendStep/)
  assert.match(stepSource, /RedrawTimeline/)
  assert.match(stepSource, /RedrawPlayerCompare/)
  assert.match(stepSource, /RedrawExportPanel/)
  assert.match(timelineSource, /固定源片顺序/)
  assert.doesNotMatch(timelineSource, /draggable|dragstart|drop|sortable|moveShot|reorder/i)
  assert.doesNotMatch(stepSource, /完整NLE|专业剪辑台/)
})

test('第四步提交 payload 不接受客户端模型、价格、路径或产物字段', () => {
  assert.match(stepSource, /quoteDialogue\(versionId,\s*\{\s*\}\s*\)/)
  assert.match(stepSource, /startDialogue\(versionId,\s*\{\s*quote_hash:\s*dialogueQuote\.value\.quote_hash,\s*idempotency_key/)
  assert.match(stepSource, /dialogueStarting\.value\s*\|\|\s*!versionId/)
  assert.match(stepSource, /dialogueCredits\s*!==\s*null/)
  assert.match(stepSource, /本次预计扣除\s*\{\{\s*dialogueCredits\s*\}\}\s*积分/)
  assert.match(stepSource, /composeVersion\(versionId,\s*\{\s*idempotency_key:\s*compositionIdempotencyKey\.value,\s*audio_mode:\s*['"]replace['"]/)
  for (const sourceText of [stepSource, exportSource]) {
    assert.doesNotMatch(sourceText, /model\s*:/)
    assert.doesNotMatch(sourceText, /credits?\s*:/)
    assert.doesNotMatch(sourceText, /credit_amount\s*:/)
    assert.doesNotMatch(sourceText, /local_path|absolute_path|file_path|path\s*:/)
    assert.doesNotMatch(sourceText, /asset_id\s*:/)
  }
})

test('第四步 blob 预览和下载必须走鉴权接口并在卸载时 revoke object URL', () => {
  assert.match(compareSource, /downloadExport/)
  assert.match(compareSource, /mp4Export\.value\.exportId/)
  assert.match(compareSource, /mp4Export\.value\.kind/)
  assert.match(compareSource, /URL\.createObjectURL/)
  assert.match(compareSource, /URL\.revokeObjectURL/)
  assert.match(compareSource, /onBeforeUnmount/)
  assert.match(exportSource, /downloadExport/)
  assert.match(exportSource, /item\.exportId/)
  assert.match(exportSource, /item\.kind/)
  assert.match(exportSource, /URL\.createObjectURL/)
  assert.match(exportSource, /a\.download/)
  assert.doesNotMatch(compareSource, /export\.local|local_path|absolute_path|file_path/)
  assert.doesNotMatch(exportSource, /local_path|absolute_path|file_path/)
})

test('第四步显示可读失败状态、禁用未验证剪映工厂入口并覆盖响应式', () => {
  assert.match(stepSource, /needs_attention/)
  assert.match(stepSource, /failed/)
  assert.match(exportSource, /服务端暂未开放已验证导入端点/)
  assert.match(exportSource, /disabled/)
  assert.match(stepSource, /@media \(max-width:\s*1024px\)/)
  assert.match(stepSource, /@media \(max-width:\s*480px\)/)
  assert.match(timelineSource, /overflow-wrap:\s*anywhere/)
  assert.match(compareSource, /object-fit:\s*contain/)
})

test('第四步配音文案使用当前项目 locale 而非硬编码英文', () => {
  assert.match(workspaceSource, /:target-locale="project\?\.default_locale"/)
  assert.match(stepSource, /targetLocale/)
  assert.match(stepSource, /dialogueLanguageLabel/)
  assert.match(stepSource, /\{\{ dialogueLanguageLabel \}\}/)
  assert.doesNotMatch(stepSource, /英文配音|生成英文配音|启动英文配音/)
})

test('第四步刷新后仅持久化任务 id 并从 owner scoped 后端接口恢复配音任务', () => {
  assert.match(stepSource, /dialogueTaskStorageKey/)
  assert.match(stepSource, /localStorage\?\.getItem/)
  assert.match(stepSource, /getDialogueTask\(versionId, taskId\)/)
  assert.match(stepSource, /localStorage\?\.setItem\([^,]+,\s*String\(taskId\)\)/)
  assert.doesNotMatch(stepSource, /localStorage\?\.setItem\([^,]+,\s*JSON\.stringify/)
})

test('配音完成后触发整集 readiness 回读，无需整页刷新', () => {
  assert.match(stepSource, /:refresh-token="releaseRefreshToken"/)
  assert.match(stepSource, /dialogueTask\.value\?\.status === 'completed'[\s\S]*releaseRefreshToken\.value \+= 1/)
  assert.match(releaseSource, /refreshToken/)
  assert.match(releaseSource, /watch\(\(\) => \[props\.versionId, props\.refreshToken\]/)
})
