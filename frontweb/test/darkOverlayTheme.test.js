import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const themeSource = readFileSync(
  fileURLToPath(new URL('../src/styles/theme.css', import.meta.url)),
  'utf8',
)

test('默认深色主题为 Element Plus 弹层提供完整表面变量', () => {
  assert.match(
    themeSource,
    /:root,\s*html\.dark\s*\{[\s\S]*--el-bg-color:\s*var\(--bg-card\);[\s\S]*--el-bg-color-overlay:\s*var\(--bg-card\);/,
  )
  assert.match(themeSource, /--el-text-color-primary:\s*var\(--text-primary\);/)
  assert.match(themeSource, /--el-border-color:\s*var\(--border-color\);/)
})

test('深色模式的 Teleport 弹层不使用默认白色面板', () => {
  for (const selector of [
    '.el-message',
    '.el-notification',
    '.el-message-box',
    '.el-select__popper',
    '.el-dropdown__popper',
    '.el-popover.el-popper',
    '.el-dialog',
  ]) {
    assert.ok(
      themeSource.includes(`html:not(.light) ${selector}`),
      `缺少 ${selector} 的深色弹层规则`,
    )
  }
  assert.match(
    themeSource,
    /html:not\(\.light\) \.el-message[\s\S]*background(?:-color)?:\s*var\(--bg-card\)\s*!important;/,
  )
})
