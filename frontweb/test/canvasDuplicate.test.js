import test from 'node:test'
import assert from 'node:assert/strict'

import { cloneSingleCanvasNodeWithIncidentEdges } from '../src/utils/canvasDuplicate.js'

test('cloneSingleCanvasNodeWithIncidentEdges duplicates incoming and outgoing edges only', () => {
  const source = {
    id: 'source',
    position: { x: 10, y: 20 },
    data: { content: 'prompt' },
  }
  const edges = [
    { id: 'in', source: 'upstream', target: 'source', targetHandle: 'image-1', data: { manual: true, contract: { order: 1 } } },
    { id: 'out', source: 'source', target: 'downstream', sourceHandle: 'result', data: { manual: true, contract: { order: 2 } } },
    { id: 'other', source: 'a', target: 'b', data: { manual: true } },
  ]
  const result = cloneSingleCanvasNodeWithIncidentEdges({
    sourceNode: source,
    edges,
    nextNodeId: 'copy',
    nextEdgeId: (edge) => `copy:${edge.id}`,
    createNode: (node) => ({ ...node, id: 'copy', position: { x: 50, y: 60 } }),
  })

  assert.equal(result.node.id, 'copy')
  assert.deepEqual(result.node.data, { content: 'prompt' })
  assert.deepEqual(result.edges.map((edge) => [edge.id, edge.source, edge.target]), [
    ['copy:in', 'upstream', 'copy'],
    ['copy:out', 'copy', 'downstream'],
  ])
  assert.equal(result.edges[0].targetHandle, 'image-1')
  assert.equal(result.edges[1].sourceHandle, 'result')
  assert.deepEqual(result.edges[0].data, { manual: true, contract: { order: 1 } })
  assert.deepEqual(edges.map((edge) => edge.id), ['in', 'out', 'other'])
  assert.deepEqual(source, {
    id: 'source',
    position: { x: 10, y: 20 },
    data: { content: 'prompt' },
  })
})

test('cloneSingleCanvasNodeWithIncidentEdges maps self loops to the copy once', () => {
  const result = cloneSingleCanvasNodeWithIncidentEdges({
    sourceNode: { id: 'source' },
    edges: [
      { id: 'self', source: 'source', target: 'source', sourceHandle: 'out', targetHandle: 'in' },
    ],
    nextNodeId: 'copy',
    nextEdgeId: (edge, index) => `copy:${edge.id}:${index}`,
  })

  assert.deepEqual(result.edges, [{
    id: 'copy:self:0',
    source: 'copy',
    target: 'copy',
    sourceHandle: 'out',
    targetHandle: 'in',
    selected: false,
  }])
})

test('cloneSingleCanvasNodeWithIncidentEdges keeps generated edge ids unique against existing edges', () => {
  const result = cloneSingleCanvasNodeWithIncidentEdges({
    sourceNode: { id: 'source' },
    edges: [
      { id: 'copy:in', source: 'existing', target: 'copy' },
      { id: 'in', source: 'upstream', target: 'source' },
      { id: 'out', source: 'source', target: 'downstream' },
    ],
    nextNodeId: 'copy',
    nextEdgeId: (edge) => `copy:${edge.id}`,
  })

  assert.deepEqual(result.edges.map((edge) => edge.id), ['copy:in:1', 'copy:out'])
})
