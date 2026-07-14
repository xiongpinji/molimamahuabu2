import test from 'node:test'
import assert from 'node:assert/strict'

import { collectStoryboardReferenceAssets } from '../src/utils/canvasWorkflow.js'

test('分镜参考资产按场景、角色、道具顺序收集并去重', () => {
  const refs = collectStoryboardReferenceAssets({
    scenes: [{ id: 2, location: '客厅', image_url: '/scene.png' }],
    characters: [
      { id: 1, name: '小梅', image_url: '/梅.png' },
      { id: 3, name: '小兰', image_url: '/兰.png' },
    ],
    props: [{ id: 5, name: '茶杯', image_url: '/scene.png' }, { id: 6, name: '手机' }],
  }, {
    scene_id: 2,
    characters: [1, 3],
    prop_ids: [5, 6],
  })

  assert.deepEqual(refs.map((ref) => ref.name), ['客厅', '小梅', '小兰'])
  assert.deepEqual(refs.map((ref) => ref.kind), ['scene', 'character', 'character'])
})

test('参考资产最多返回十张并支持 local_path', () => {
  const drama = { characters: Array.from({ length: 12 }, (_, id) => ({ id, name: `角色${id}`, local_path: `characters/${id}.png` })) }
  const refs = collectStoryboardReferenceAssets(drama, { characters: drama.characters.map(({ id }) => id) })
  assert.equal(refs.length, 10)
  assert.equal(refs[0].url, '/static/characters/0.png')
})
