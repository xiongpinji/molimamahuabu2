import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  buildCanvasLayoutPayload,
  resizeCanvasGroupsAroundMember,
  resolveCanvasGroups,
  translateCanvasGroupChildren,
} from '../src/utils/canvasLayout.js'

const canvasSource = fs.readFileSync(new URL('../src/views/DramaCanvas.vue', import.meta.url), 'utf8')
const toolbarSource = fs.readFileSync(new URL('../src/components/dramaCanvas/CanvasFloatingToolbar.vue', import.meta.url), 'utf8')
const selectionToolbarSource = fs.readFileSync(
  new URL('../src/components/dramaCanvas/CanvasSelectionToolbar.vue', import.meta.url),
  'utf8',
)
const groupNodeSource = fs.readFileSync(
  new URL('../src/components/dramaCanvas/CanvasGroupNode.vue', import.meta.url),
  'utf8',
)
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
  assert.match(canvasSource, /await runFreeCanvasSubgraph\(group\.data\?\.childNodeIds \|\| \[\], false\)/)
  assert.match(selectionToolbarSource, /<span>整组执行<\/span>/)
  assert.match(selectionToolbarSource, /@click="runGroup"/)
})

test('group toolbar exposes grouping and ungrouping actions', () => {
  assert.match(selectionToolbarSource, /<span>打组<\/span>/)
  assert.match(selectionToolbarSource, /@click="createGroup"/)
  assert.match(selectionToolbarSource, /<span>解组<\/span>/)
  assert.match(selectionToolbarSource, /@click="ungroup"/)
  assert.match(toolbarSource, /'panel-open': panelOpen && selectedFreeCount < 2 && selectedGroupCount === 0/)
})

test('new groups stay selected and group lifecycle actions enter canvas history', () => {
  assert.match(canvasSource, /function createStandaloneGroup\(\)[\s\S]*const previousState = currentInteractionState\(\)/)
  assert.match(canvasSource, /type: 'canvasGroup',[\s\S]*selected: true/)
  assert.match(canvasSource, /function createStandaloneGroup\(\)[\s\S]*commitInteractionHistory\(previousState\)/)
  assert.match(canvasSource, /function ungroupStandaloneSelection\(\)[\s\S]*const previousState = currentInteractionState\(\)/)
  assert.match(canvasSource, /function ungroupStandaloneSelection\(\)[\s\S]*commitInteractionHistory\(previousState\)/)
  assert.match(canvasSource, /function applyInteractionState\(state\)[\s\S]*state\?\.groups/)
})

test('multi-selected free nodes keep batch mode without opening a single-node editor', () => {
  assert.match(homeCanvasNodeSource, /const hasMultiSelection = computed\(\(\) => \(ctx\?\.selectedFreeNodeIds\?\.value\?\.length \|\| 0\) > 1\)/)
  assert.match(homeCanvasNodeSource, /v-if="isSelected && !hasMultiSelection && !editorHidden"/)
})

test('selected nodes and groups use a contextual toolbar above their bounds', () => {
  assert.match(canvasSource, /<CanvasSelectionToolbar\s+v-if="isStandaloneCanvas"/)
  assert.match(canvasSource, /@selection-start="onCanvasSelectionStart"/)
  assert.match(canvasSource, /@selection-end="onCanvasSelectionEnd"/)
  assert.match(canvasSource, /function onCanvasSelectionEnd\(\)[\s\S]*node\.type === 'homeCanvasNode' && node\.selected/)
  assert.match(canvasSource, /!selectionModifierActive\.value && !marqueeSelectionActive\.value/)
  assert.match(selectionToolbarSource, /\{\{ selectedFreeCount \}\} 个节点/)
  assert.match(selectionToolbarSource, /@click="createGroup"/)
  assert.match(selectionToolbarSource, /<span>整组执行<\/span>/)
  assert.match(selectionToolbarSource, /@click="ungroup"/)
  assert.match(selectionToolbarSource, /selectionToolbarStyle/)
  assert.match(groupNodeSource, /:class="\{ selected \}"/)
  assert.match(groupNodeSource, /selected: \{ type: Boolean/)
})

test('dragging a group translates only its member nodes by the live group delta', () => {
  const nodes = [
    { id: 'a', position: { x: 100, y: 120 } },
    { id: 'b', position: { x: 500, y: 120 } },
    { id: 'outside', position: { x: 900, y: 900 } },
  ]
  const snapshot = {
    position: { x: 60, y: 70 },
    children: {
      a: { x: 100, y: 120 },
      b: { x: 500, y: 120 },
    },
  }

  assert.deepEqual(
    translateCanvasGroupChildren(nodes, snapshot, { x: 85, y: 110 }),
    [
      { id: 'a', position: { x: 125, y: 160 } },
      { id: 'b', position: { x: 525, y: 160 } },
      { id: 'outside', position: { x: 900, y: 900 } },
    ],
  )
  assert.match(canvasSource, /function onNodeDrag\(payload\)[\s\S]*translateCanvasGroupChildren\([\s\S]*node\.position/)
})

test('moving one group member refits the group around every member without moving nodes', () => {
  const nodes = [
    {
      id: 'group',
      type: 'canvasGroup',
      position: { x: 60, y: 70 },
      data: { childNodeIds: ['a', 'b'], width: 900, height: 480 },
    },
    { id: 'a', type: 'homeCanvasNode', position: { x: 100, y: 120 }, dimensions: { width: 460, height: 300 } },
    { id: 'b', type: 'homeCanvasNode', position: { x: 900, y: 520 }, dimensions: { width: 480, height: 320 } },
    {
      id: 'other-group',
      type: 'canvasGroup',
      position: { x: 1500, y: 100 },
      data: { childNodeIds: ['outside', 'elsewhere'], width: 800, height: 500 },
    },
    { id: 'outside', type: 'homeCanvasNode', position: { x: 1600, y: 200 } },
  ]

  assert.deepEqual(
    resizeCanvasGroupsAroundMember(nodes, 'b', 40),
    [
      {
        id: 'group',
        type: 'canvasGroup',
        position: { x: 60, y: 80 },
        data: { childNodeIds: ['a', 'b'], width: 1360, height: 800 },
      },
      nodes[1],
      nodes[2],
      nodes[3],
      nodes[4],
    ],
  )
})
