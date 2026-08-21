import test from 'node:test'
import assert from 'node:assert/strict'

import {
  projectMetadata,
  projectCanvasPath,
  projectOpenPath,
} from '../src/utils/projectMode.js'

test('独立画布项目写入分类但保留画面比例', () => {
  assert.deepEqual(projectMetadata('9:16', 'canvas'), {
    aspect_ratio: '9:16',
    project_type: 'canvas',
  })
})

test('画布项目入口和项目内画布使用同一项目 ID 的不同路由外壳', () => {
  assert.equal(projectOpenPath(12, 'canvas'), '/canvas/12')
  assert.equal(projectCanvasPath(12, 'canvas'), '/canvas/12')
  assert.equal(projectOpenPath(12, 'factory'), '/drama/12')
  assert.equal(projectCanvasPath(12, 'factory'), '/film/12/canvas')
})
