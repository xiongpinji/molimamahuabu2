import test from 'node:test'
import assert from 'node:assert/strict'

import {
  filterCanvasAssets,
  getCanvasEpisodeContext,
  isCanvasAssetVisible,
} from '../src/utils/canvasEpisodeContext.js'

const drama = {
  characters: [{ id: 1, name: '甲' }, { id: 2, name: '乙' }],
  scenes: [{ id: 3, location: '客厅' }, { id: 4, location: '街道' }],
  props: [{ id: 5, name: '杯子' }, { id: 6, name: '钥匙' }],
  episodes: [
    { id: 10, storyboards: [{ characters: [1], scene_id: 3, prop_ids: [5] }] },
    { id: 20, storyboards: [{ characters: [2], scene_id: 4, prop_ids: [6] }] },
  ],
}

test('当前集上下文只保留该集分镜引用的素材', () => {
  const context = getCanvasEpisodeContext(drama, 10)

  assert.equal(context.isFiltered, true)
  assert.deepEqual(filterCanvasAssets(drama.characters, 'character', context).map((item) => item.id), [1])
  assert.deepEqual(filterCanvasAssets(drama.scenes, 'scene', context).map((item) => item.id), [3])
  assert.deepEqual(filterCanvasAssets(drama.props, 'prop', context).map((item) => item.id), [5])
  assert.equal(isCanvasAssetVisible('char:1', context), true)
  assert.equal(isCanvasAssetVisible('char:2', context), false)
})

test('全部集上下文保留项目级素材并包含所有分镜', () => {
  const context = getCanvasEpisodeContext(drama)

  assert.equal(context.isFiltered, false)
  assert.equal(context.storyboards.length, 2)
  assert.equal(filterCanvasAssets(drama.characters, 'character', context).length, 2)
  assert.equal(isCanvasAssetVisible('prop:6', context), true)
})
