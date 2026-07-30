import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  CANVAS_EDGE_PALETTES,
  CANVAS_SIMPLE_PALETTES,
  CANVAS_THEME_PALETTES,
  DEFAULT_CANVAS_PREFERENCES,
  normalizeCanvasPreferences,
} from '../src/utils/canvasSettings.js'

const settingsSource = fs.readFileSync(
  new URL('../src/components/dramaCanvas/CanvasSettingsPanel.vue', import.meta.url),
  'utf8',
)
const canvasSource = fs.readFileSync(
  new URL('../src/views/DramaCanvas.vue', import.meta.url),
  'utf8',
)
const toolbarSource = fs.readFileSync(
  new URL('../src/components/dramaCanvas/CanvasFloatingToolbar.vue', import.meta.url),
  'utf8',
)

test('canvas settings preserve the NeoDomain defaults', () => {
  assert.deepEqual(normalizeCanvasPreferences(), DEFAULT_CANVAS_PREFERENCES)
  assert.equal(DEFAULT_CANVAS_PREFERENCES.pan_sensitivity, 1.5)
  assert.equal(DEFAULT_CANVAS_PREFERENCES.blank_action, 'contextmenu')
  assert.equal(DEFAULT_CANVAS_PREFERENCES.wheel_action, 'pan')
  assert.equal(DEFAULT_CANVAS_PREFERENCES.touch_connection_radius, 150)
  assert.equal(DEFAULT_CANVAS_PREFERENCES.snap_enabled, true)
  assert.equal(DEFAULT_CANVAS_PREFERENCES.grid_gap, 20)
  assert.equal(DEFAULT_CANVAS_PREFERENCES.minimap_visible, false)
  assert.equal(DEFAULT_CANVAS_PREFERENCES.theme_key, 'xuanhei')
  assert.equal(DEFAULT_CANVAS_PREFERENCES.edge_palette_key, 'default')
  assert.equal(DEFAULT_CANVAS_PREFERENCES.simple_palette_key, 'follow')
})

test('canvas settings normalize ranges, switches and enum values', () => {
  const normalized = normalizeCanvasPreferences({
    pan_sensitivity: 99,
    blank_action: 'invalid',
    media_submit_delay_seconds: -5,
    wheel_action: 'zoom',
    touch_connection_radius: 301,
    edge_width: 0,
    edge_focus_radius: 41,
    grid_gap: 5,
    grid_dot_size: 7,
    layout_horizontal_gap: 201,
    layout_vertical_gap: 79,
    group_padding: 121,
    top_toolbar_scale: 0.7,
    bottom_toolbar_scale: 3,
    background_opacity: 0,
    background_blur: 80,
    background_mode: 'repeat',
    background_tile_size: 9,
    theme_key: 'missing',
    edge_palette_key: 'missing',
    simple_palette_key: 'missing',
    alignment_guides_enabled: false,
  })

  assert.equal(normalized.pan_sensitivity, 5)
  assert.equal(normalized.blank_action, 'contextmenu')
  assert.equal(normalized.media_submit_delay_seconds, 0)
  assert.equal(normalized.wheel_action, 'zoom')
  assert.equal(normalized.touch_connection_radius, 300)
  assert.equal(normalized.edge_width, 1)
  assert.equal(normalized.edge_focus_radius, 40)
  assert.equal(normalized.grid_gap, 6)
  assert.equal(normalized.grid_dot_size, 6)
  assert.equal(normalized.layout_horizontal_gap, 200)
  assert.equal(normalized.layout_vertical_gap, 80)
  assert.equal(normalized.group_padding, 120)
  assert.equal(normalized.top_toolbar_scale, 0.8)
  assert.equal(normalized.bottom_toolbar_scale, 2)
  assert.equal(normalized.background_opacity, 0.05)
  assert.equal(normalized.background_blur, 40)
  assert.equal(normalized.background_mode, 'repeat')
  assert.equal(normalized.background_tile_size, 10)
  assert.equal(normalized.theme_key, 'xuanhei')
  assert.equal(normalized.edge_palette_key, 'default')
  assert.equal(normalized.simple_palette_key, 'follow')
  assert.equal(normalized.alignment_guides_enabled, false)
})

test('the visible palette inventory keeps reference defaults and custom entries', () => {
  assert.ok(CANVAS_THEME_PALETTES.length >= 70)
  assert.ok(CANVAS_EDGE_PALETTES.length >= 60)
  assert.ok(CANVAS_SIMPLE_PALETTES.length >= 25)
  assert.equal(CANVAS_THEME_PALETTES.find((item) => item.key === 'xuanhei')?.label, '玄黑')
  assert.equal(CANVAS_EDGE_PALETTES.find((item) => item.key === 'default')?.label, '默认')
  assert.equal(CANVAS_SIMPLE_PALETTES.find((item) => item.key === 'follow')?.label, '跟随主题')
  assert.ok(CANVAS_THEME_PALETTES.some((item) => item.key === 'custom'))
  assert.ok(CANVAS_EDGE_PALETTES.some((item) => item.key === 'custom'))
})

test('settings panel exposes all eight continuous-scroll sections', () => {
  for (const section of [
    '交互操作',
    '连线设置',
    '网格与显示',
    '节点与布局',
    '自定义背景',
    '画布主题',
    '连线色彩',
    '简化配色',
  ]) {
    assert.match(settingsSource, new RegExp(section))
  }
  assert.match(settingsSource, /data-section=/)
  assert.match(settingsSource, /恢复默认/)
  assert.match(settingsSource, /从画布选择/)
})

test('settings are wired to real canvas behavior', () => {
  for (const binding of [
    'canvasPreferences.snap_enabled',
    'canvasPreferences.grid_gap',
    'canvasPreferences.grid_dot_size',
    'canvasPreferences.minimap_visible',
    'canvasPreferences.touch_connection_radius',
    'canvasPreferences.wheel_action',
    'canvasPreferences.background_enabled',
    'canvasPreferences.value.layout_horizontal_gap',
    'canvasPreferences.value.layout_vertical_gap',
    'canvasPreferences.value.group_padding',
  ]) {
    assert.match(canvasSource, new RegExp(binding.replaceAll('.', '\\.')))
  }
  assert.match(toolbarSource, /CanvasSettingsPanel/)
  assert.match(canvasSource, /@node-drag="onNodeDrag"/)
  assert.match(canvasSource, /@pane-double-click="onPaneDoubleClick"/)
})
