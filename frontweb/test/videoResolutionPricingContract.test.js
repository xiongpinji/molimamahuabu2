import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const adminSource = fs.readFileSync(new URL('../src/views/BillingAdmin.vue', import.meta.url), 'utf8')
const nodeSource = fs.readFileSync(new URL('../src/components/dramaCanvas/HomeCanvasNode.vue', import.meta.url), 'utf8')
const canvasSource = fs.readFileSync(new URL('../src/views/DramaCanvas.vue', import.meta.url), 'utf8')
const freeCreateSource = fs.readFileSync(new URL('../src/views/FreeCreate.vue', import.meta.url), 'utf8')
const filmListSource = fs.readFileSync(new URL('../src/views/FilmList.vue', import.meta.url), 'utf8')

test('管理端提供 480P 和 720P 的积分及每秒成本配置', () => {
  assert.match(adminSource, /480P 用户收费/)
  assert.match(adminSource, /480P API 成本/)
  assert.match(adminSource, /720P 用户收费/)
  assert.match(adminSource, /720P API 成本/)
  assert.match(adminSource, /resolution_prices/)
})

test('画布积分提示保留受保护合同并传递节点分辨率', () => {
  assert.match(nodeSource, /class="billing-cost canvas-credit-callout-v1"\s+aria-live="polite"/)
  assert.match(nodeSource, /本次预计扣除/)
  assert.match(nodeSource, /积分待管理员配置/)
  assert.doesNotMatch(nodeSource, /class="billing-note"/)
  assert.match(nodeSource, /\.billing-cost\s*\{/)
  assert.match(nodeSource, /\.billing-cost strong\s*\{/)
  assert.match(nodeSource, /draft\.resolution/)
  assert.match(canvasSource, /estimateCanvasCredits\([^)]*resolution/s)
})

test('首页和自由创作的预计积分都传递当前视频分辨率', () => {
  assert.match(filmListSource, /duration:\s*homeDuration\.value,\s*resolution:\s*homeResolution\.value/s)
  assert.match(freeCreateSource, /duration:\s*duration\.value,\s*resolution:\s*resolution\.value/s)
})
