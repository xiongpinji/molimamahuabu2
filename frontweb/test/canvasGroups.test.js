import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildCanvasLayoutPayload, resolveCanvasGroups } from '../src/utils/canvasLayout.js'

const canvasSource = fs.readFileSync(new URL('../src/views/DramaCanvas.vue', import.meta.url), 'utf8')
const toolbarSource = fs.readFileSync(new URL('../src/components/dramaCanvas/CanvasFloatingToolbar.vue', import.meta.url), 'utf8')
const homeCanvasNodeSource = fs.readFileSync(new URL('../src/components/dramaCanvas/HomeCanvasNode.vue', import.meta.url), 'utf8')

test('standalone canvas groups persist member ids and geometry', () => {
  const payload = buildCanvasLayoutPayload([
    { id: 'a', type: 'homeCanvasNode', position: { x: 100, y: 120 }, data: { kind: 'text', title: '', content: '', url: '' } },
    { id: 'b', type: 'homeCanvasNode', position: { x: 500, y: 120 }, data: { kind: 'image', title: '', content: '', url: '' } },
    {
      id: 'canvas-group:1',
      type: 'canvasGroup',
      position: { x: 60, y: 70 },
      data: { title: '第一组', childNodeIds: ['a', 'b'], width: 900, height: 480 },
    },
  ], { x: 0, y: 0, zoom: 0.75 }, null, [], { persistFreeNodes: true })

  assert.deepEqual(payload.groups, [{
    id: 'canvas-group:1',
    title: '第一组',
    child_node_ids: ['a', 'b'],
    x: 60,
    y: 70,
    width: 900,
    height: 480,
  }])
})

test('invalid or single-node groups are ignored during restore', () => {
  assert.deepEqual(resolveCanvasGroups({
    groups: [
      { id: 'single', child_node_ids: ['a'], x: 0, y: 0, width: 300, height: 200 },
      { id: 'valid', child_node_ids: ['a', 'b'], x: 1, y: 2, width: 100, height: 100 },
    ],
  }), [{
    id: 'valid',
    title: '节点组',
    child_node_ids: ['a', 'b'],
    x: 1,
    y: 2,
    width: 260,
    height: 180,
  }])
})

test('selected standalone group reuses the real free-canvas subgraph runner', () => {
  assert.match(canvasSource, /async function runSelectedStandaloneGroup\(\)/)
  assert.match(canvasSource, /await runFreeCanvasSubgraph\(group\.data\?\.childNodeIds \|\| \[\], true\)/)
  assert.match(toolbarSource, /<span>整组执行<\/span>/)
  assert.match(toolbarSource, /@click="runGroup"/)
})

test('group toolbar exposes grouping and ungrouping actions', () => {
  assert.match(toolbarSource, /<span>打组 \{\{ selectedFreeCount \}\}<\/span>/)
  assert.match(toolbarSource, /@click="createGroup"/)
  assert.match(toolbarSource, /<span>解组<\/span>/)
  assert.match(toolbarSource, /@click="ungroup"/)
  assert.match(toolbarSource, /'panel-open': panelOpen && selectedFreeCount < 2 && selectedGroupCount === 0/)
})

test('multi-selected free nodes keep batch mode without opening a single-node editor', () => {
  assert.match(homeCanvasNodeSource, /const hasMultiSelection = computed\(\(\) => \(ctx\?\.selectedFreeNodeIds\?\.value\?\.length \|\| 0\) > 1\)/)
  assert.match(homeCanvasNodeSource, /v-if="isSelected && !hasMultiSelection && !editorHidden"/)
})
