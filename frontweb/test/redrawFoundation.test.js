import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function readSource(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

const apiSource = readSource('../src/api/redraw.js')
const routerSource = readSource('../src/router/index.js')
const navSource = readSource('../src/components/PlatformPrimaryNav.vue')
const listSource = readSource('../src/views/RedrawProjectList.vue')
const workspaceSource = readSource('../src/views/RedrawWorkspace.vue')
const sourceStepSource = readSource('../src/components/redraw/RedrawSourceStep.vue')
const presetPickerSource = readSource('../src/components/redraw/StylePresetPicker.vue')
const stateSource = readSource('../src/utils/redrawWorkspaceState.js')

test('一键转绘 API 使用统一 request 并导出阶段 1 所需真实接口', () => {
  assert.match(apiSource, /import request from '@\/utils\/request'/)
  for (const name of [
    'listProjects',
    'createProject',
    'getProject',
    'createWorks',
    'getWork',
    'listStylePresets',
    'listLocales',
    'analyzeWork',
  ]) {
    assert.match(apiSource, new RegExp(`${name}\\(`), name)
  }
  assert.match(apiSource, /request\.get\('\/redraw\/projects'/)
  assert.match(apiSource, /request\.post\('\/redraw\/projects'/)
  assert.match(apiSource, /request\.post\(`\/redraw\/projects\/\$\{projectId\}\/works`/)
  assert.match(apiSource, /multipart\/form-data/)
  assert.match(apiSource, /request\.post\(`\/redraw\/works\/\$\{workId\}\/analyze`/)
  assert.match(apiSource, /reference_image/)
  assert.match(apiSource, /FormData/)
})

test('一键转绘在路由和主导航中作为真实工作台入口', () => {
  assert.match(routerSource, /path: '\/redraw'/)
  assert.match(routerSource, /name: 'redraw-projects'/)
  assert.match(routerSource, /RedrawProjectList\.vue/)
  assert.match(routerSource, /path: '\/redraw\/projects\/:projectId\/works\/:workId'/)
  assert.match(routerSource, /name: 'redraw-workspace'/)
  assert.match(routerSource, /RedrawWorkspace\.vue/)
  assert.match(navSource, /to="\/redraw"/)
  assert.match(navSource, />\s*一键转绘\s*</)
  assert.match(navSource, /redrawActive/)
})

test('工作台步骤由路由 query 和后端 current_step 取较小允许值，不能靠缓存越过门禁', () => {
  assert.match(stateSource, /normalizeStep/)
  assert.match(stateSource, /resolveAllowedStep/)
  assert.match(stateSource, /Math\.min\(routeStep,\s*backendStep\)/)
  assert.doesNotMatch(stateSource, /localStorage|sessionStorage/)
  assert.match(workspaceSource, /getWork\(workId\.value\)/)
  assert.match(workspaceSource, /resolveAllowedStep\(\s*route\.query\.step,\s*work\.value\?\.current_step/)
  assert.match(workspaceSource, /router\.replace/)
})

test('第一步接入真实项目、源片上传、语言地区、比例、报价和分析任务', () => {
  assert.match(listSource, /redrawAPI\.listProjects/)
  assert.match(listSource, /redrawAPI\.createProject/)
  assert.match(listSource, /name:\s*'redraw-workspace'/)
  assert.match(sourceStepSource, /accept="\.mp4,\.mov,\.zip,video\/mp4,video\/quicktime,application\/zip"/)
  assert.match(sourceStepSource, /redrawAPI\.listStylePresets/)
  assert.match(sourceStepSource, /redrawAPI\.listLocales/)
  assert.match(sourceStepSource, /redrawAPI\.createWorks/)
  assert.match(sourceStepSource, /redrawAPI\.analyzeWork/)
  assert.match(sourceStepSource, /redrawAPI\.getWork/)
  assert.match(sourceStepSource, /task_id/)
  assert.match(sourceStepSource, /status/)
  assert.match(sourceStepSource, /progress/)
  assert.match(sourceStepSource, /taskStateFromWork\(next\)/)
  assert.match(sourceStepSource, /setInterval/)
  assert.match(sourceStepSource, /clearInterval/)
  assert.match(sourceStepSource, /isTerminalTaskState/)
  assert.match(sourceStepSource, /本次预计扣除 \{\{ estimateCredits \}\} 积分/)
  assert.match(sourceStepSource, /积分待管理员配置/)
  assert.match(sourceStepSource, /canStartAnalysis/)
  for (const ratio of ['1:1', '9:16', '16:9', '3:4', '4:3', '21:9']) {
    assert.match(sourceStepSource, new RegExp(`'${ratio}'`), ratio)
  }
})

test('风格预设轨道满足四类分段、固定卡片尺寸、横向滚动和自由风格输入合同', () => {
  for (const label of ['二维动漫风', '三维动漫风', '真人写实风格', '自由风格']) {
    assert.match(presetPickerSource, new RegExp(label), label)
  }
  assert.match(presetPickerSource, /PRESET_CARD_WIDTH\s*=\s*156/)
  assert.match(presetPickerSource, /PRESET_IMAGE_HEIGHT\s*=\s*104/)
  assert.match(presetPickerSource, /gap:\s*12px/)
  assert.match(presetPickerSource, /grid-template-columns:\s*repeat\(auto-fill,\s*156px\)/)
  assert.match(presetPickerSource, /@wheel\.prevent="onWheel"/)
  assert.match(presetPickerSource, /@keydown\.left\.prevent="scrollActiveTrack\(-1\)"/)
  assert.match(presetPickerSource, /@keydown\.right\.prevent="scrollActiveTrack\(1\)"/)
  assert.match(presetPickerSource, /scrollLeftByCategory/)
  assert.match(presetPickerSource, /positivePrompt/)
  assert.match(presetPickerSource, /negativePrompt/)
  assert.match(presetPickerSource, /referenceImage/)
  assert.match(presetPickerSource, /selectPreset/)
  assert.match(presetPickerSource, /line-clamp:\s*2/)
})
