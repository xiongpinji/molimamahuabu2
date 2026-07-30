<template>
  <section
    class="canvas-settings-dialog"
    :class="{ 'is-centered': !docked }"
    role="dialog"
    aria-modal="false"
    aria-label="自定义画布"
    @mousedown.stop
  >
    <header class="settings-header">
      <strong>自定义画布</strong>
      <div class="settings-header-actions">
        <button type="button" class="restore-button" @click="resetPreferences">恢复默认</button>
        <button type="button" class="icon-button" :title="docked ? '浮动到画布中央' : '停靠回底部'" @click="docked = !docked">
          <span aria-hidden="true">▣</span>
        </button>
        <button type="button" class="icon-button close-button" title="关闭" aria-label="关闭画布设置" @click="emit('close')">×</button>
      </div>
    </header>

    <div class="settings-body">
      <nav class="settings-nav" aria-label="画布设置分类">
        <button
          v-for="section in sections"
          :key="section.id"
          type="button"
          :class="{ active: activeSection === section.id }"
          @click="scrollToSection(section.id)"
        >
          {{ section.label }}
        </button>
      </nav>

      <div ref="scrollerRef" class="settings-content" @scroll.passive="syncActiveSection">
        <section :ref="setSectionRef('interaction')" class="settings-section" data-section="interaction">
          <h3>交互操作</h3>
          <div class="settings-card">
            <label class="setting-row">
              <span>画布平移灵敏度</span>
              <input type="range" min="0.2" max="5" step="0.1" :value="preferences.pan_sensitivity" @input="setNumber('pan_sensitivity', $event)" />
              <output>{{ formatNumber(preferences.pan_sensitivity) }}x</output>
            </label>
            <div class="setting-row">
              <span>空白区域操作</span>
              <div class="segments">
                <button type="button" :class="{ active: preferences.blank_action === 'contextmenu' }" @click="setPreference('blank_action', 'contextmenu')">右键菜单</button>
                <button type="button" :class="{ active: preferences.blank_action === 'doubleclick' }" @click="setPreference('blank_action', 'doubleclick')">双击菜单</button>
              </div>
            </div>
            <label class="setting-row">
              <span>图/视 延迟提交</span>
              <input type="range" min="0" max="10" step="1" :value="preferences.media_submit_delay_seconds" @input="setNumber('media_submit_delay_seconds', $event)" />
              <output>{{ preferences.media_submit_delay_seconds ? `${preferences.media_submit_delay_seconds}s` : '关闭' }}</output>
            </label>
            <div class="setting-row">
              <span>滚轮默认操作</span>
              <div class="segments">
                <button type="button" :class="{ active: preferences.wheel_action === 'pan' }" @click="setPreference('wheel_action', 'pan')">平移</button>
                <button type="button" :class="{ active: preferences.wheel_action === 'zoom' }" @click="setPreference('wheel_action', 'zoom')">缩放</button>
              </div>
            </div>
            <label class="setting-row">
              <span>触摸点吸附范围</span>
              <input type="range" min="50" max="300" step="10" :value="preferences.touch_connection_radius" @input="setNumber('touch_connection_radius', $event)" />
              <output>{{ preferences.touch_connection_radius }}px</output>
            </label>
            <div v-for="item in interactionToggles" :key="item.key" class="setting-row">
              <span>{{ item.label }}</span>
              <button type="button" class="switch" role="switch" :aria-checked="preferences[item.key]" :class="{ active: preferences[item.key] }" @click="toggle(item.key)">
                <i />
              </button>
            </div>
          </div>
        </section>

        <section :ref="setSectionRef('connections')" class="settings-section" data-section="connections">
          <h3>连线设置</h3>
          <div class="settings-card">
            <label class="setting-row">
              <span>连线显示粗细</span>
              <input type="range" min="1" max="6" step="0.2" :value="preferences.edge_width" @input="setNumber('edge_width', $event)" />
              <output>{{ formatNumber(preferences.edge_width) }}px</output>
            </label>
            <label class="setting-row">
              <span>连线焦点范围</span>
              <input type="range" min="6" max="40" step="2" :value="preferences.edge_focus_radius" @input="setNumber('edge_focus_radius', $event)" />
              <output>{{ preferences.edge_focus_radius }}px</output>
            </label>
            <div v-for="item in connectionToggles" :key="item.key" class="setting-row">
              <span>{{ item.label }}</span>
              <button type="button" class="switch" role="switch" :aria-checked="preferences[item.key]" :class="{ active: preferences[item.key] }" @click="toggle(item.key)">
                <i />
              </button>
            </div>
          </div>
        </section>

        <section :ref="setSectionRef('grid')" class="settings-section" data-section="grid">
          <h3>网格与显示</h3>
          <div class="settings-card">
            <label class="setting-row">
              <span>网格线间距</span>
              <input type="range" min="6" max="60" step="2" :value="preferences.grid_gap" @input="setNumber('grid_gap', $event)" />
              <output>{{ preferences.grid_gap }}px</output>
            </label>
            <label class="setting-row">
              <span>网格点大小</span>
              <input type="range" min="1" max="6" step="0.5" :value="preferences.grid_dot_size" @input="setNumber('grid_dot_size', $event)" />
              <output>{{ formatNumber(preferences.grid_dot_size) }}px</output>
            </label>
            <div v-for="item in gridToggles" :key="item.key" class="setting-row">
              <span>{{ item.label }}</span>
              <button type="button" class="switch" role="switch" :aria-checked="preferences[item.key]" :class="{ active: preferences[item.key] }" @click="toggle(item.key)">
                <i />
              </button>
            </div>
          </div>
        </section>

        <section :ref="setSectionRef('layout')" class="settings-section" data-section="layout">
          <h3>节点与布局</h3>
          <div class="settings-card">
            <label v-for="item in layoutRanges" :key="item.key" class="setting-row">
              <span>{{ item.label }}</span>
              <input type="range" :min="item.min" :max="item.max" :step="item.step" :value="preferences[item.key]" @input="setNumber(item.key, $event)" />
              <output>{{ formatNumber(preferences[item.key]) }}{{ item.unit }}</output>
            </label>
          </div>
        </section>

        <section :ref="setSectionRef('background')" class="settings-section" data-section="background">
          <h3>自定义背景</h3>
          <div class="settings-card">
            <div class="setting-row">
              <span>启用背景图</span>
              <button type="button" class="switch" role="switch" :aria-checked="preferences.background_enabled" :class="{ active: preferences.background_enabled }" @click="toggle('background_enabled')"><i /></button>
            </div>
            <div class="setting-row background-source-row">
              <span>背景图片</span>
              <button type="button" class="source-button" @click="backgroundPickerOpen = !backgroundPickerOpen">从画布选择</button>
            </div>
            <div v-if="backgroundPickerOpen" class="background-picker">
              <button
                v-for="item in backgroundCandidates"
                :key="item.url"
                type="button"
                :class="{ active: preferences.background_url === item.url }"
                :title="item.label"
                @click="pickBackground(item.url)"
              >
                <img :src="item.url" :alt="item.label" />
              </button>
              <p v-if="!backgroundCandidates.length">画布内暂无可用图片素材</p>
            </div>
            <label class="setting-row">
              <span>不透明度</span>
              <input type="range" min="0.05" max="1" step="0.05" :value="preferences.background_opacity" @input="setNumber('background_opacity', $event)" />
              <output>{{ Math.round(preferences.background_opacity * 100) }}%</output>
            </label>
            <label class="setting-row">
              <span>模糊度</span>
              <input type="range" min="0" max="40" step="1" :value="preferences.background_blur" @input="setNumber('background_blur', $event)" />
              <output>{{ preferences.background_blur }}px</output>
            </label>
            <div class="setting-row">
              <span>显示方式</span>
              <div class="segments">
                <button v-for="mode in backgroundModes" :key="mode.key" type="button" :class="{ active: preferences.background_mode === mode.key }" @click="setPreference('background_mode', mode.key)">{{ mode.label }}</button>
              </div>
            </div>
            <label class="setting-row">
              <span>平铺大小</span>
              <input type="range" min="10" max="300" step="5" :value="preferences.background_tile_size" @input="setNumber('background_tile_size', $event)" />
              <output>{{ preferences.background_tile_size }}%</output>
            </label>
          </div>
        </section>

        <section :ref="setSectionRef('theme')" class="settings-section" data-section="theme">
          <h3>画布主题</h3>
          <div class="palette-card theme-palette">
            <button v-for="item in CANVAS_THEME_PALETTES" :key="item.key" type="button" :class="{ active: preferences.theme_key === item.key }" @click="setPreference('theme_key', item.key)">
              <i :style="{ background: item.bg, borderColor: item.panel }" />
              <span>{{ item.label }}</span>
            </button>
          </div>
          <div v-if="preferences.theme_key === 'custom'" class="custom-color-row">
            <label>画布 <input type="color" :value="preferences.custom_theme_canvas" @input="setPreference('custom_theme_canvas', $event.target.value)" /></label>
            <label>面板 <input type="color" :value="preferences.custom_theme_panel" @input="setPreference('custom_theme_panel', $event.target.value)" /></label>
          </div>
        </section>

        <section :ref="setSectionRef('edge-colors')" class="settings-section" data-section="edge-colors">
          <h3>连线色彩</h3>
          <div class="palette-card edge-palette">
            <button v-for="item in CANVAS_EDGE_PALETTES" :key="item.key" type="button" :class="{ active: preferences.edge_palette_key === item.key }" @click="setPreference('edge_palette_key', item.key)">
              <i><b :style="{ background: item.base }" /><b :style="{ background: item.focus }" /></i>
              <span>{{ item.label }}</span>
            </button>
          </div>
          <div v-if="preferences.edge_palette_key === 'custom'" class="custom-color-row">
            <label>常态 <input type="color" :value="preferences.custom_edge_base" @input="setPreference('custom_edge_base', $event.target.value)" /></label>
            <label>焦点 <input type="color" :value="preferences.custom_edge_focus" @input="setPreference('custom_edge_focus', $event.target.value)" /></label>
          </div>
        </section>

        <section :ref="setSectionRef('simple-colors')" class="settings-section" data-section="simple-colors">
          <h3>简化配色</h3>
          <div class="palette-card simple-palette">
            <button v-for="item in CANVAS_SIMPLE_PALETTES" :key="item.key" type="button" :class="{ active: preferences.simple_palette_key === item.key }" @click="setPreference('simple_palette_key', item.key)">
              <i><b v-for="color in item.colors" :key="color" :style="{ background: color }" /></i>
              <span>{{ item.label }}</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, ref } from 'vue'
import { useCanvasContext } from '@/composables/useCanvasContext'
import {
  CANVAS_EDGE_PALETTES,
  CANVAS_SIMPLE_PALETTES,
  CANVAS_THEME_PALETTES,
  DEFAULT_CANVAS_PREFERENCES,
} from '@/utils/canvasSettings'

const emit = defineEmits(['close'])
const ctx = useCanvasContext()
const docked = ref(true)
const activeSection = ref('interaction')
const scrollerRef = ref(null)
const sectionRefs = new Map()
const backgroundPickerOpen = ref(false)

const sections = [
  { id: 'interaction', label: '交互操作' },
  { id: 'connections', label: '连线设置' },
  { id: 'grid', label: '网格与显示' },
  { id: 'layout', label: '节点与布局' },
  { id: 'background', label: '自定义背景' },
  { id: 'theme', label: '画布主题' },
  { id: 'edge-colors', label: '连线色彩' },
  { id: 'simple-colors', label: '简化配色' },
]
const interactionToggles = [
  { key: 'snap_enabled', label: '拖拽吸附网格' },
  { key: 'alignment_guides_enabled', label: '对齐辅助线' },
  { key: 'blur_after_submit', label: '节点提交后取消焦点' },
  { key: 'minimal_zoom_enabled', label: '极简模式缩放' },
  { key: 'linked_preview_enabled', label: '联动预览画布素材' },
]
const connectionToggles = [
  { key: 'edge_animation_enabled', label: '开启连线动画' },
  { key: 'edge_focus_only', label: '仅显示焦点连线' },
]
const gridToggles = [
  { key: 'grid_visible', label: '显示网格底纹' },
  { key: 'canvas_glow_enabled', label: '背景氛围光晕' },
  { key: 'minimap_visible', label: '显示导航小地图' },
]
const layoutRanges = [
  { key: 'layout_horizontal_gap', label: '整理节点水平间距', min: 50, max: 200, step: 10, unit: 'px' },
  { key: 'layout_vertical_gap', label: '整理节点垂直间距', min: 80, max: 300, step: 10, unit: 'px' },
  { key: 'group_padding', label: '打组包含边距', min: 50, max: 120, step: 5, unit: 'px' },
  { key: 'top_toolbar_scale', label: '上方工具栏缩放', min: 0.8, max: 2, step: 0.05, unit: 'x' },
  { key: 'bottom_toolbar_scale', label: '下方工具栏缩放', min: 0.8, max: 2, step: 0.05, unit: 'x' },
]
const backgroundModes = [
  { key: 'cover', label: '铺满' },
  { key: 'contain', label: '适应' },
  { key: 'repeat', label: '平铺' },
]

const preferences = computed(() => ctx?.canvasPreferences?.value || DEFAULT_CANVAS_PREFERENCES)
const backgroundCandidates = computed(() => ctx?.canvasBackgroundCandidates?.value || [])

function setSectionRef(id) {
  return (element) => {
    if (element) sectionRefs.set(id, element)
  }
}

function setPreference(key, value) {
  ctx?.updateCanvasPreference?.(key, value)
}

function setNumber(key, event) {
  setPreference(key, Number(event.target.value))
}

function toggle(key) {
  setPreference(key, !preferences.value[key])
}

function resetPreferences() {
  backgroundPickerOpen.value = false
  ctx?.resetCanvasPreferences?.()
}

function pickBackground(url) {
  setPreference('background_url', url)
  setPreference('background_enabled', true)
  backgroundPickerOpen.value = false
}

function formatNumber(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, '')
}

async function scrollToSection(id) {
  activeSection.value = id
  await nextTick()
  sectionRefs.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function syncActiveSection() {
  const scrollerTop = scrollerRef.value?.getBoundingClientRect().top || 0
  let closest = sections[0].id
  let distance = Number.POSITIVE_INFINITY
  for (const section of sections) {
    const element = sectionRefs.get(section.id)
    if (!element) continue
    const nextDistance = Math.abs(element.getBoundingClientRect().top - scrollerTop - 8)
    if (nextDistance < distance) {
      distance = nextDistance
      closest = section.id
    }
  }
  activeSection.value = closest
}
</script>

<style scoped>
.canvas-settings-dialog {
  position: absolute;
  left: 50%;
  bottom: 80px;
  z-index: 40;
  width: min(420px, calc(100vw - 24px));
  height: min(400px, calc(100vh - 130px));
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  background: color-mix(in srgb, var(--canvas-panel-background, #18181b) 98%, transparent);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  color: #f4f4f5;
  transform: translateX(-50%);
  backdrop-filter: blur(20px);
}
.canvas-settings-dialog.is-centered {
  position: fixed;
  top: 50%;
  bottom: auto;
  transform: translate(-50%, -50%);
}
.settings-header {
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.settings-header strong { font-size: 13px; }
.settings-header-actions { display: flex; align-items: center; gap: 5px; }
.settings-header button { border: 0; color: rgba(255, 255, 255, 0.5); cursor: pointer; }
.restore-button { height: 28px; padding: 0 12px; border-radius: 15px; background: rgba(255, 255, 255, 0.06); font-size: 11px; }
.restore-button:hover { color: #fff; background: rgba(255, 255, 255, 0.1); }
.icon-button { width: 27px; height: 27px; padding: 0; border-radius: 7px; background: transparent; font-size: 15px; }
.icon-button:hover { color: #fff; background: rgba(255, 255, 255, 0.07); }
.close-button { font-size: 19px; }
.settings-body { height: calc(100% - 44px); display: grid; grid-template-columns: 80px 1fr; }
.settings-nav {
  padding: 8px 6px;
  overflow-y: auto;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
}
.settings-nav button {
  position: relative;
  width: 100%;
  height: 29px;
  padding: 0 5px 0 11px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: rgba(255, 255, 255, 0.45);
  font-size: 11px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.settings-nav button:hover { color: rgba(255, 255, 255, 0.75); }
.settings-nav button.active { color: #f4f4f5; background: rgba(255, 255, 255, 0.06); }
.settings-nav button.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 7px;
  width: 2px;
  height: 15px;
  border-radius: 2px;
  background: #7c5cff;
}
.settings-content { overflow-y: auto; scroll-behavior: smooth; scrollbar-gutter: stable; }
.settings-section { padding: 10px 10px 4px; scroll-margin-top: 8px; }
.settings-section h3 {
  position: relative;
  margin: 0 0 10px;
  padding-left: 10px;
  color: #f4f4f5;
  font-size: 13px;
  font-weight: 600;
}
.settings-section h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 2px;
  width: 3px;
  height: 13px;
  border-radius: 2px;
  background: #7c5cff;
}
.settings-card,
.palette-card {
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
}
.setting-row {
  min-height: 30px;
  display: grid;
  grid-template-columns: minmax(112px, 1fr) 100px 45px;
  align-items: center;
  gap: 7px;
  padding: 5px 0;
  color: rgba(255, 255, 255, 0.58);
  font-size: 12px;
}
.setting-row > span { white-space: nowrap; }
.setting-row output { color: rgba(255, 255, 255, 0.45); font-size: 11px; text-align: right; font-variant-numeric: tabular-nums; }
.setting-row input[type='range'] {
  width: 100px;
  height: 3px;
  margin: 0;
  accent-color: #fff;
  cursor: pointer;
}
.segments {
  grid-column: 2 / 4;
  justify-self: end;
  display: flex;
  padding: 3px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.04);
}
.segments button {
  min-width: 53px;
  height: 25px;
  padding: 0 9px;
  border: 0;
  border-radius: 14px;
  background: transparent;
  color: rgba(255, 255, 255, 0.45);
  font-size: 11px;
  cursor: pointer;
}
.segments button.active { color: #fff; background: rgba(255, 255, 255, 0.12); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
.switch {
  grid-column: 3;
  justify-self: end;
  position: relative;
  width: 36px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.12);
  cursor: pointer;
}
.switch i {
  position: absolute;
  left: 3px;
  top: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.65);
  transition: transform 0.16s ease;
}
.switch.active { background: #6b7280; }
.switch.active i { background: #fff; transform: translateX(16px); }
.background-source-row { grid-template-columns: 1fr auto; }
.source-button {
  grid-column: 2 / 4;
  height: 26px;
  padding: 0 11px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.75);
  font-size: 11px;
  cursor: pointer;
}
.background-picker {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  padding: 6px 0 9px;
}
.background-picker button { height: 42px; overflow: hidden; padding: 0; border: 2px solid transparent; border-radius: 6px; background: #111; cursor: pointer; }
.background-picker button.active { border-color: #7c5cff; }
.background-picker img { width: 100%; height: 100%; object-fit: cover; }
.background-picker p { grid-column: 1 / -1; margin: 4px 0; color: rgba(255, 255, 255, 0.35); font-size: 11px; text-align: center; }
.palette-card { display: grid; gap: 5px; padding: 7px; }
.palette-card button {
  min-width: 0;
  min-height: 39px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 2px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: rgba(255, 255, 255, 0.46);
  font-size: 9px;
  cursor: pointer;
}
.palette-card button:hover { background: rgba(255, 255, 255, 0.04); }
.palette-card button.active { border-color: rgba(124, 92, 255, 0.72); color: #fff; background: rgba(124, 92, 255, 0.12); }
.theme-palette { grid-template-columns: repeat(4, 1fr); }
.theme-palette button > i { width: 24px; height: 15px; border: 3px solid; border-radius: 4px; }
.edge-palette { grid-template-columns: repeat(4, 1fr); }
.edge-palette button > i { width: 28px; height: 13px; display: flex; overflow: hidden; border-radius: 4px; }
.edge-palette button b { width: 50%; }
.simple-palette { grid-template-columns: repeat(2, 1fr); }
.simple-palette button { min-height: 43px; }
.simple-palette button > i { display: flex; gap: 2px; }
.simple-palette button b { width: 8px; height: 8px; border-radius: 50%; }
.custom-color-row { display: flex; gap: 12px; padding: 8px 4px 0; color: rgba(255, 255, 255, 0.55); font-size: 11px; }
.custom-color-row label { display: flex; align-items: center; gap: 5px; }
.custom-color-row input { width: 28px; height: 22px; padding: 0; border: 0; background: transparent; }
@media (max-width: 520px) {
  .canvas-settings-dialog { left: 12px; transform: none; }
  .canvas-settings-dialog.is-centered { left: 50%; transform: translate(-50%, -50%); }
  .settings-body { grid-template-columns: 74px 1fr; }
  .setting-row { grid-template-columns: minmax(96px, 1fr) 82px 40px; }
  .setting-row input[type='range'] { width: 82px; }
}
@media (prefers-reduced-motion: reduce) {
  .settings-content { scroll-behavior: auto; }
  .switch i { transition: none; }
}
</style>
