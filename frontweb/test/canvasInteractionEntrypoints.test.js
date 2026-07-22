import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const canvasSource = readFileSync(fileURLToPath(new URL('../src/views/DramaCanvas.vue', import.meta.url)), 'utf8')
const toolbarSource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/CanvasFloatingToolbar.vue', import.meta.url)), 'utf8')
const contextMenuSource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/CanvasContextMenu.vue', import.meta.url)), 'utf8')

test('画布保留 LibTV 式导航、框选和拖拽历史入口', () => {
  assert.match(canvasSource, /pan-activation-key-code="Space"/)
  assert.match(canvasSource, /zoom-activation-key-code="Control"/)
  assert.match(canvasSource, /:zoom-on-scroll="false"/)
  assert.match(canvasSource, /:pan-on-drag="spacePanning"/)
  assert.match(canvasSource, /function onCanvasKeyup\(event\)/)
  assert.match(canvasSource, /window\.addEventListener\('keyup', onCanvasKeyup\)/)
  assert.match(canvasSource, /window\.removeEventListener\('keyup', onCanvasKeyup\)/)
  assert.match(canvasSource, /:select-nodes-on-drag="true"/)
  assert.match(canvasSource, /selection-mode="partial"/)
  assert.match(canvasSource, /@node-drag-start="onNodeDragStart"/)
  assert.match(canvasSource, /function onCanvasWheel\(event\)/)
  assert.match(canvasSource, /function onCanvasKeydown\(event\)/)
  assert.match(canvasSource, /'Ctrl\/⌘ \+ G：将已选分镜创建为工作流'/)
  assert.match(canvasSource, /'Esc：清空选择、焦点和右键菜单'/)
})

test('悬浮工具栏暴露撤销和重做操作', () => {
  assert.match(toolbarSource, /aria-label="撤销"/)
  assert.match(toolbarSource, /aria-label="重做"/)
  assert.match(toolbarSource, /:disabled="!canUndo"/)
  assert.match(toolbarSource, /:disabled="!canRedo"/)
  assert.match(toolbarSource, /function undo\(\) \{ ctx\?\.undoCanvas\?\.\(\) \}/)
  assert.match(toolbarSource, /function redo\(\) \{ ctx\?\.redoCanvas\?\.\(\) \}/)
})

test('画布工作流支持直接运行所选分镜', () => {
  assert.match(canvasSource, />\s*运行所选\s*</)
  assert.match(canvasSource, /@click="onRunSelectedStoryboards"/)
  assert.match(canvasSource, /async function onRunSelectedStoryboards\(\)/)
  assert.match(canvasSource, /title: '所选分镜'/)
  assert.match(canvasSource, /async function runWorkflowWithConfirm\(runGroup, confirmTitle\)/)
  assert.match(canvasSource, /await runWorkflowWithConfirm\(\{\s*\.\.\.group,/)
})

test('画布支持 LibTV 式键盘完成选择清理和工作流分组', () => {
  assert.match(canvasSource, /function clearCanvasInteractionState\(\)/)
  assert.match(canvasSource, /closeContextMenu\(\)\s*\n\s*focusedNodeId\.value = null\s*\n\s*activeGroupId\.value = null\s*\n\s*applySelectedStoryboardIds\(\[\]\)/)
  assert.match(canvasSource, /if \(key === 'escape' \|\| key === 'esc'\) \{\s*\n\s*event\.preventDefault\(\)\s*\n\s*clearCanvasInteractionState\(\)/)
  assert.match(canvasSource, /if \(key === 'g'\) \{\s*\n\s*event\.preventDefault\(\)\s*\n\s*void onCreateWorkflowGroup\(\)/)
  assert.match(canvasSource, /if \(workflowRunning\.value \|\| layoutSaveState\.value === 'saving'\)/)
})

test('右键空白画布提供 LibTV 式添加节点入口并使用点击位置', () => {
  assert.match(contextMenuSource, /'添加画布节点'/)
  assert.match(contextMenuSource, /<div class="ctx-title">添加节点<\/div>/)
  assert.match(contextMenuSource, /label: '故事脚本'/)
  assert.match(contextMenuSource, /label: '分镜'/)
  assert.match(contextMenuSource, /label: '角色'/)
  assert.match(contextMenuSource, /label: '场景'/)
  assert.match(contextMenuSource, /label: '道具'/)
  assert.match(contextMenuSource, /label: '素材库'/)
  assert.match(canvasSource, /contextMenuFlowPos\.value = flowPos/)
  assert.match(canvasSource, /pendingFlowPosition\.value = flowPosition/)
  assert.match(canvasSource, /openCreateDialog\(type, flowPosition\)/)
})
