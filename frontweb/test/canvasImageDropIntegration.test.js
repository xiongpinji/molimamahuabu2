import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const homeCanvasSource = readFileSync(
  fileURLToPath(new URL('../src/views/HomeCanvas.vue', import.meta.url)),
  'utf8',
)
const dramaCanvasSource = readFileSync(
  fileURLToPath(new URL('../src/views/DramaCanvas.vue', import.meta.url)),
  'utf8',
)

function functionBody(source, name) {
  const normalizedSource = source.replace(/\r\n?/g, '\n')
  const start = normalizedSource.indexOf(`async function ${name}`)
  assert.notEqual(start, -1)
  const next = normalizedSource.indexOf('\n}\n\nfunction ', start)
  assert.notEqual(next, -1)
  return normalizedSource.slice(start, next + 3)
}

for (const [label, source] of [
  ['首页自由画布', homeCanvasSource],
  ['项目独立画布', dramaCanvasSource],
]) {
  test(`${label}支持多图片拖入、即时预览和逐张上传`, () => {
    assert.match(source, /@dragover="onCanvasImageDragOver"/)
    assert.match(source, /@drop="onCanvasImageDrop"/)
    assert.match(source, /hasDraggedFilePayload/)
    assert.match(source, /collectDroppedImageFiles/)
    assert.match(source, /createDroppedImageNodeSpecs/)
    assert.match(source, /stripLocalImagePreviewsForPersistence/)
    assert.match(source, /URL\.createObjectURL/)
    assert.match(source, /URL\.revokeObjectURL/)
    assert.match(source, /let canvasAlive = true/)
    assert.match(source, /canvasAlive = false/)
    assert.match(source, /if \(!canvasAlive\) \{[\s\S]{0,180}URL\.revokeObjectURL\(spec\.previewUrl\)/)
    assert.match(source, /const droppedNodes =/)
    assert.match(source, /for \(const \{ spec, nodeId \} of droppedNodes\)/)
    assert.ok(source.indexOf('const droppedNodes =') < source.indexOf('for (const { spec, nodeId } of droppedNodes)'))
  })

  test(`${label}非图片文件 drop 会拦截默认行为但不创建图片节点`, () => {
    const dropSource = functionBody(source, 'onCanvasImageDrop')
    const guardIndex = dropSource.indexOf('hasDraggedFilePayload(event.dataTransfer)')
    const preventIndex = dropSource.indexOf('event.preventDefault()')
    const stopIndex = dropSource.indexOf('event.stopPropagation()')
    const collectIndex = dropSource.indexOf('collectDroppedImageFiles(event.dataTransfer)')
    const emptyReturnIndex = dropSource.indexOf('if (!files.length) return')
    const nonImageBranch = dropSource.slice(0, emptyReturnIndex)

    assert.ok(guardIndex >= 0)
    assert.ok(guardIndex < preventIndex)
    assert.ok(preventIndex < stopIndex)
    assert.ok(stopIndex < collectIndex)
    assert.ok(collectIndex < emptyReturnIndex)
    assert.doesNotMatch(nonImageBranch, /createFreeCanvasNode|openNodeEditor|uploadAPI\.(?:uploadImage|uploadMedia)/)
  })
}

test('首页自由画布上传成功后保存稳定图片地址，失败时保留本地预览', () => {
  assert.match(homeCanvasSource, /uploadAPI\.uploadImage\(spec\.file\)/)
  assert.match(homeCanvasSource, /url: String\(uploaded\?\.url \|\| ''\)/)
  assert.match(homeCanvasSource, /url: spec\.previewUrl/)
  assert.match(homeCanvasSource, /localPreview: true/)
  assert.match(homeCanvasSource, /nodes: stripLocalImagePreviewsForPersistence\(nodes\.value\)/)
})

test('项目独立画布上传时携带项目 id 并保留现有素材闭环', () => {
  assert.match(dramaCanvasSource, /uploadAPI\.uploadMedia\(spec\.file, \{ dramaId: drama\.value\.id \}\)/)
  assert.match(dramaCanvasSource, /savedAssetId: String\(asset\?\.id \|\| ''\)/)
  assert.match(dramaCanvasSource, /stripLocalImagePreviewsForPersistence\(allGraphNodes\.value\)/)
  assert.match(dramaCanvasSource, /const persistedGraphNodes = stripLocalImagePreviewsForPersistence\(allGraphNodes\.value\)/)
  assert.match(dramaCanvasSource, /buildCanvasLayoutPayload\(\s*persistedGraphNodes,/)
})
