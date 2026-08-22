import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assetCategory,
  groupMediaItems,
  normalizeCanvasAssets,
  normalizeGenerationHistory,
} from '../src/utils/canvasAssetHistory.js'

test('生成历史把真实图片和视频记录关联到对应画布节点', () => {
  const nodes = [
    { id: 'sbimg:7', type: 'canvasMedia', data: { kind: 'image', storyboard: { id: 7 } } },
    { id: 'sbvid:8', type: 'canvasMedia', data: { kind: 'video', storyboard: { id: 8 } } },
  ]
  const items = normalizeGenerationHistory({
    images: [{
      id: 11,
      storyboard_id: 7,
      image_url: 'https://cdn.example/frame.png',
      prompt: '雨夜街道',
      model: 'gpt-image-2',
      task_id: 'img-task',
      status: 'completed',
      created_at: '2026-07-30T08:00:00.000Z',
    }],
    videos: [{
      id: 12,
      storyboard_id: 8,
      video_url: 'https://cdn.example/shot.mp4',
      prompt: '镜头缓慢推进',
      model: 'seedance 2.0',
      task_id: 'video-task',
      status: 'completed',
      created_at: '2026-07-30T09:00:00.000Z',
    }],
    nodes,
  })

  assert.deepEqual(items.map((item) => [item.key, item.type, item.nodeId]), [
    ['video:12', 'video', 'sbvid:8'],
    ['image:11', 'image', 'sbimg:7'],
  ])
  assert.equal(items[1].prompt, '雨夜街道')
  assert.equal(items[0].model, 'seedance 2.0')
})

test('画布资产保留图片、视频、音频、文本和 3D World 的真实节点类型', () => {
  const items = normalizeCanvasAssets([
    { id: 'char:1', type: 'canvasAsset', data: { kind: 'character', entity: { id: 1, name: '茉莉', image_url: '/static/hero.png' } } },
    { id: 'sbvid:2', type: 'canvasMedia', data: { kind: 'video', url: '/static/shot.mp4', storyboard: { id: 2 } } },
    { id: 'sbaud:2:dialogue', type: 'canvasMedia', data: { kind: 'audio', url: '/static/voice.mp3', storyboard: { id: 2 } } },
    { id: 'sbtxt:2', type: 'canvasMedia', data: { kind: 'text', summary: '她推开门。', storyboard: { id: 2 } } },
    { id: 'project-asset:9', type: 'canvasProjectAsset', data: { asset: { id: 9, name: '古宅', type: 'model', url: '/static/house.glb' } } },
  ])

  assert.deepEqual(items.map((item) => item.type), ['image', 'video', 'audio', 'text', 'model'])
  assert.deepEqual(items.map((item) => item.nodeId), [
    'char:1',
    'sbvid:2',
    'sbaud:2:dialogue',
    'sbtxt:2',
    'project-asset:9',
  ])
})

test('资产分类映射到人物、场景、物品、风格、音效、提示词和其它', () => {
  assert.equal(assetCategory({ category: 'character' }), 'person')
  assert.equal(assetCategory({ category: 'scene' }), 'scene')
  assert.equal(assetCategory({ category: 'prop' }), 'item')
  assert.equal(assetCategory({ category: 'style-reference' }), 'style')
  assert.equal(assetCategory({ type: 'audio' }), 'sound')
  assert.equal(assetCategory({ type: 'text' }), 'prompt')
  assert.equal(assetCategory({ category: 'canvas-upload' }), 'other')
})

test('生成历史支持平铺、日、周、月四种分组标签', () => {
  const items = [
    { key: 'today', createdAt: '2026-07-30T08:00:00+08:00' },
    { key: 'week', createdAt: '2026-07-27T08:00:00+08:00' },
    { key: 'month', createdAt: '2026-07-02T08:00:00+08:00' },
  ]
  const now = new Date('2026-07-30T12:00:00+08:00')

  assert.equal(groupMediaItems(items, 'flat', now)[0].label, '')
  assert.equal(groupMediaItems(items, 'day', now)[0].label, '7月30日 周四')
  assert.equal(groupMediaItems(items, 'week', now)[0].label, '本周')
  assert.equal(groupMediaItems(items, 'month', now)[0].label, '本月')
})

test('空资产列表不生成空分组，面板可以展示空状态', () => {
  assert.deepEqual(groupMediaItems([], 'flat'), [])
})
