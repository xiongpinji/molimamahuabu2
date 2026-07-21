import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const canvasSource = readFileSync(fileURLToPath(new URL('../src/views/DramaCanvas.vue', import.meta.url)), 'utf8')
const contextMenuSource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/CanvasContextMenu.vue', import.meta.url)), 'utf8')
const storyboardPanelSource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/CanvasStoryboardPanel.vue', import.meta.url)), 'utf8')
const assetPanelSource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/CanvasAssetPanel.vue', import.meta.url)), 'utf8')
const mediaPanelSource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/CanvasMediaPanel.vue', import.meta.url)), 'utf8')

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

test('媒体配置面板支持从素材库复用视频和音频', () => {
  assert.match(mediaPanelSource, /从素材库选用成片/)
  assert.match(mediaPanelSource, /from '@\/components\/AssetPickerDialog\.vue'/)
  assert.match(mediaPanelSource, /asset\.asset_url \|\| asset\.display_url \|\| asset\.url/)
  assert.match(mediaPanelSource, /async function onLibraryAudioPick\(asset\)/)
  assert.match(mediaPanelSource, /从素材库选用音频/)
  assert.match(mediaPanelSource, /type="audio"/)
  assert.match(mediaPanelSource, /素材库音频挂载中/)
  assert.match(mediaPanelSource, /storyboardsAPI\.update\(sbId, \{/)
  assert.match(mediaPanelSource, /audio_local_path: localPath \|\| undefined/)
  assert.match(mediaPanelSource, /audio_url: localPath \? undefined : audioUrl/)
  assert.match(mediaPanelSource, /已将素材库音频设为该分镜音频/)
})

test('媒体配置面板失败后保留原因和重试入口', () => {
  assert.match(mediaPanelSource, /v-if="failedStatus"/)
  assert.match(mediaPanelSource, /failedStatus\.errorDetail \|\| failedStatus\.message/)
  assert.match(mediaPanelSource, /@click\.stop="retryFailedStep"/)
  assert.match(mediaPanelSource, /const activeNodeStatus = computed/)
  assert.match(mediaPanelSource, /activeNodeStatus\.value\?\.step === 'failed'/)
  assert.match(mediaPanelSource, /retryStep: step/)
  assert.match(mediaPanelSource, /retryLabel/)
  assert.match(mediaPanelSource, /recoverable: true/)
  assert.match(mediaPanelSource, /async function retryFailedStep\(\)/)
  assert.match(mediaPanelSource, /await runStep\(step\)/)
})
