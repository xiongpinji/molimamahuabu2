import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createDirectorResourceState,
  isDirectorAnimationCompatible,
  resolveDirectorAssetUrl,
  updateDirectorResourceState,
} from '../src/utils/director-assets.js'

test('导演台资源地址优先使用公开 URL，并兼容项目相对路径', () => {
  assert.equal(resolveDirectorAssetUrl({ url: 'https://cdn.example/hero.glb', local_path: 'models/hero.glb' }), 'https://cdn.example/hero.glb')
  assert.equal(resolveDirectorAssetUrl({ local_path: 'projects/1/models/hero.glb' }), '/static/projects/1/models/hero.glb')
  assert.equal(resolveDirectorAssetUrl('  /static/models/hero.glb  '), '/static/models/hero.glb')
  assert.equal(resolveDirectorAssetUrl({ path: 'models/hero.glb' }), '/static/models/hero.glb')
  assert.equal(resolveDirectorAssetUrl(null), '')
})

test('导演台资源状态只允许可回归的状态迁移并保留资源地址', () => {
  const initial = createDirectorResourceState('model', 'models/hero.glb')
  assert.deepEqual(initial, { kind: 'model', status: 'idle', url: '/static/models/hero.glb', message: '' })

  const loading = updateDirectorResourceState(initial, { status: 'loading' })
  assert.deepEqual(loading, { kind: 'model', status: 'loading', url: '/static/models/hero.glb', message: '' })

  const ready = updateDirectorResourceState(loading, { status: 'ready', message: '已加载' })
  assert.deepEqual(ready, { kind: 'model', status: 'ready', url: '/static/models/hero.glb', message: '已加载' })

  const failed = updateDirectorResourceState(ready, { status: 'error', message: '网络错误' })
  assert.deepEqual(failed, { kind: 'model', status: 'error', url: '/static/models/hero.glb', message: '网络错误' })
  assert.throws(() => updateDirectorResourceState(failed, { status: 'unknown' }), /资源状态无效/)
})

test('动作资源必须至少命中当前角色对象树中的一个动画轨道', () => {
  const root = {
    name: 'Armature',
    traverse(callback) {
      callback({ name: 'Armature' })
      callback({ name: 'mixamorigHips' })
    },
  }
  assert.equal(isDirectorAnimationCompatible(root, [{ tracks: [{ name: 'mixamorigHips.quaternion' }] }]), true)
  assert.equal(isDirectorAnimationCompatible(root, [{ tracks: [{ name: 'Armature|mixamorigHips.position' }] }]), true)
  assert.equal(isDirectorAnimationCompatible(root, [{ tracks: [{ name: 'OtherRoot.position' }] }]), false)
  assert.equal(isDirectorAnimationCompatible(root, []), false)
})
