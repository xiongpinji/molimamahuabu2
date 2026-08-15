import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const canvasSource = readFileSync(resolve(__dirname, '../src/views/DramaCanvas.vue'), 'utf8')

test('画布持续按键只启动一个动画循环并在停止后保存', () => {
  assert.match(canvasSource, /const keyboardPanKeys = new Set\(\)/)
  assert.match(canvasSource, /if \(!keyboardPanKeys\.has\(normalizedKey\)\) \{[\s\S]*keyboardPanKeys\.add\(normalizedKey\)/)
  assert.match(canvasSource, /window\.requestAnimationFrame\(runKeyboardPanFrame\)/)
  assert.match(canvasSource, /function stopKeyboardPan\(key\)[\s\S]*scheduleLayoutSave\(\)/)
})

test('持续平移交给浏览器合成线程，松键后再同步 Vue Flow 状态', () => {
  assert.match(canvasSource, /pane\.style\.transform = `translate3d\(/)
  assert.match(canvasSource, /keyboardPanPane\.style\.willChange = 'transform'/)
  assert.match(canvasSource, /const animation = pane\.animate\(\[/)
  assert.match(canvasSource, /duration: KEYBOARD_PAN_ANIMATION_MS,[\s\S]*easing: 'linear'/)
  const framePath = canvasSource.slice(
    canvasSource.indexOf('function runKeyboardPanFrame'),
    canvasSource.indexOf('function startKeyboardPan'),
  )
  assert.doesNotMatch(framePath, /setViewport/)
  assert.match(canvasSource, /function finishKeyboardPan\(\)[\s\S]*setViewport\?\.\(finalViewport/)
})

test('方向键不会接管可编辑控件，且小画布平移跳过虚拟化重算', () => {
  assert.match(canvasSource, /if \(isEditableTarget\(event\.target\)\) return/)
  assert.match(canvasSource, /isCanvasKeyboardPanKey\(key\)/)
  assert.match(
    canvasSource,
    /if \(allGraphNodes\.value\.length >= CANVAS_VIRTUALIZATION_MIN_NODES\) scheduleVirtualization\(\)/,
  )
})
