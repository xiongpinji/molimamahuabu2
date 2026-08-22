import test from 'node:test'
import assert from 'node:assert/strict'

import { removeStoryboardFromWorkflowGroup, reorderWorkflowGroup } from '../src/utils/canvasWorkflow.js'

test('工作流组可按画布拖拽结果重排分镜且不影响其他工作流', () => {
  const groups = [
    { id: 'one', storyboard_ids: [1, 2, 3], pipeline: ['image'] },
    { id: 'two', storyboard_ids: [4, 5], pipeline: ['video'] },
  ]

  const result = reorderWorkflowGroup(groups, 'one', [3, 1, 3, '2'])

  assert.deepEqual(result, [
    { id: 'one', storyboard_ids: [3, 1, 2], pipeline: ['image'] },
    { id: 'two', storyboard_ids: [4, 5], pipeline: ['video'] },
  ])
  assert.deepEqual(groups[0].storyboard_ids, [1, 2, 3])
})

test('工作流组可移出指定分镜，空组自动删除', () => {
  const groups = [
    { id: 'one', storyboard_ids: [1, 2], pipeline: ['image'] },
    { id: 'two', storyboard_ids: [3], pipeline: ['video'] },
  ]

  assert.deepEqual(removeStoryboardFromWorkflowGroup(groups, 'one', 2), [
    { id: 'one', storyboard_ids: [1], pipeline: ['image'] },
    { id: 'two', storyboard_ids: [3], pipeline: ['video'] },
  ])
  assert.deepEqual(removeStoryboardFromWorkflowGroup(groups, 'two', 3), [
    { id: 'one', storyboard_ids: [1, 2], pipeline: ['image'] },
  ])
  assert.deepEqual(groups[0].storyboard_ids, [1, 2])
})
