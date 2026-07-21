import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const canvasSource = readFileSync(fileURLToPath(new URL('../src/views/DramaCanvas.vue', import.meta.url)), 'utf8')
const contextMenuSource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/CanvasContextMenu.vue', import.meta.url)), 'utf8')
const storyboardPanelSource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/CanvasStoryboardPanel.vue', import.meta.url)), 'utf8')
const assetPanelSource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/CanvasAssetPanel.vue', import.meta.url)), 'utf8')

test('右键节点菜单保留配置面板入口', () => {
  assert.match(contextMenuSource, /type: 'open-node-config'/)
  assert.match(contextMenuSource, /打开节点配置/)
  assert.match(canvasSource, /if \(type === 'open-node-config'\) \{/)
  assert.match(canvasSource, /onNodeDoubleClick\(\{ node \}\)/)
})

test('分镜配置面板保留保存、回显刷新和单镜模型配置', () => {
  assert.match(storyboardPanelSource, /function saveFields\(\)/)
  assert.match(storyboardPanelSource, /await persistForm\(false\)/)
  assert.match(storyboardPanelSource, /await ctx\?\.refreshDrama\?\.\(true\)/)
  assert.match(storyboardPanelSource, /actionStatus\.value = \{ type: 'success', message: '保存完成' \}/)
  assert.match(storyboardPanelSource, />恢复</)
  assert.match(storyboardPanelSource, /function resetFields\(\)/)
  assert.match(storyboardPanelSource, /syncForm\(props\.storyboard\)/)
  assert.match(storyboardPanelSource, /已恢复到上次保存/)
  assert.match(storyboardPanelSource, /CanvasGenerationOptions/)
  assert.match(storyboardPanelSource, /function saveStoryboardGenerationOptions\(patch, next\)/)
})

test('资产配置面板保留保存、素材库选图和关联分镜入口', () => {
  assert.match(assetPanelSource, /function saveAsset\(\)/)
  assert.match(assetPanelSource, /await ctx\?\.refreshDrama\?\.\(true\)/)
  assert.match(assetPanelSource, /素材库选图/)
  assert.match(assetPanelSource, /AssetPickerDialog/)
  assert.match(assetPanelSource, /关联分镜/)
  assert.match(assetPanelSource, /function highlightRelated\(\)/)
})

test('资产配置面板从项目素材库选图后写回画布资产绑定', () => {
  assert.match(assetPanelSource, /import \{ assetsAPI \} from '@\/api\/assets'/)
  assert.match(assetPanelSource, /async function bindPickedProjectAsset\(asset\)/)
  assert.match(assetPanelSource, /asset\?\.source_kind !== 'project'/)
  assert.match(assetPanelSource, /assetsAPI\.update\(asset\.raw_id/)
  assert.match(assetPanelSource, /canvas_asset_binding/)
  assert.match(assetPanelSource, /kind: props\.kind/)
  assert.match(assetPanelSource, /entity_id: props\.entity\.id/)
  assert.match(assetPanelSource, /node_id: props\.nodeId/)
  assert.match(assetPanelSource, /await bindPickedProjectAsset\(asset\)/)
})
