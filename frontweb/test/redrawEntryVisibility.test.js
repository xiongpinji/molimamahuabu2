import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { shouldShowRedrawEntry } from '../src/utils/redrawEntryVisibility.js'

const navSource = readFileSync(
  new URL('../src/components/PlatformPrimaryNav.vue', import.meta.url),
  'utf8',
)

test('生产环境隐藏一键转绘导航入口', () => {
  assert.equal(shouldShowRedrawEntry({ isProduction: true }), false)
})

test('开发和测试环境保留一键转绘导航入口', () => {
  assert.equal(shouldShowRedrawEntry({ isProduction: false }), true)
})

test('主导航仅对一键转绘链接应用生产可见性判断', () => {
  assert.match(navSource, /import \{ shouldShowRedrawEntry \} from '@\/utils\/redrawEntryVisibility'/)
  assert.match(navSource, /const redrawEntryVisible = shouldShowRedrawEntry\(\{\s*isProduction: import\.meta\.env\.PROD,?\s*\}\)/)

  const routerLinkTags = navSource.match(/<RouterLink\b[^>]*>/g) ?? []
  const redrawLinkTag = routerLinkTags.find((tag) => /\bto="\/redraw"/.test(tag))

  assert.ok(redrawLinkTag)
  assert.match(redrawLinkTag, /\bv-if="redrawEntryVisible"/)
  for (const tag of routerLinkTags.filter((tag) => !/\bto="\/redraw"/.test(tag))) {
    assert.doesNotMatch(tag, /\bv-if=/)
  }
  assert.match(navSource, /<RouterLink\s+to="\/factory"/)
})
