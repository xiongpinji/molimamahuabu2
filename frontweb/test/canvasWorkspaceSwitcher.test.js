import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const switcherSource = fs.readFileSync(
  new URL('../src/components/CanvasWorkspaceSwitcher.vue', import.meta.url),
  'utf8',
)
const primaryNavSource = fs.readFileSync(
  new URL('../src/components/PlatformPrimaryNav.vue', import.meta.url),
  'utf8',
)

test('左上品牌区域只展示品牌且不再提供工作区下拉导航', () => {
  assert.match(switcherSource, /aria-label="茉莉妈妈短剧制作平台"/)
  assert.match(switcherSource, /canvas-workspace-switcher__name">茉莉妈妈</)
  assert.match(switcherSource, /canvas-workspace-switcher__subtitle">短剧制作平台</)
  assert.doesNotMatch(switcherSource, /<el-dropdown/)
  assert.doesNotMatch(switcherSource, /canvas-workspace-menu/)
  assert.doesNotMatch(switcherSource, /打开工作区菜单|ArrowDown/)
  assert.doesNotMatch(switcherSource, /短剧工厂|画布项目|本地临时画布|自由创作|媒体素材库|开始创作/)
})

test('顶部主导航继续提供核心页面入口', () => {
  assert.match(primaryNavSource, /to="\/"[\s\S]*首页/)
  assert.match(primaryNavSource, /to="\/canvas"[\s\S]*画布/)
  assert.match(primaryNavSource, /to="\/script-analysis"[\s\S]*剧本分析/)
  assert.match(primaryNavSource, /to="\/factory"[\s\S]*短剧工厂/)
})
