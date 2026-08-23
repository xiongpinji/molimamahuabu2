import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DIRECTOR_VALIDATION_ASSET_URL,
  createDirectorResourceState,
  isDirectorAnimationCompatible,
  loadDirectorGltf,
  resolveDirectorAssetUrl,
  updateDirectorResourceState,
} from '../src/utils/director-assets.js'

test('导演台资源地址优先使用公开 URL，并兼容项目相对路径', () => {
  assert.equal(DIRECTOR_VALIDATION_ASSET_URL, '/director-fixtures/khronos-simple-skin.gltf')
  assert.equal(resolveDirectorAssetUrl({ url: 'https://cdn.example/hero.glb', local_path: 'models/hero.glb' }), 'https://cdn.example/hero.glb')
  assert.equal(resolveDirectorAssetUrl({ local_path: 'projects/1/models/hero.glb' }), '/static/projects/1/models/hero.glb')
  assert.equal(resolveDirectorAssetUrl('  /static/models/hero.glb  '), '/static/models/hero.glb')
  assert.equal(resolveDirectorAssetUrl({ path: 'models/hero.glb' }), '/static/models/hero.glb')
  assert.equal(resolveDirectorAssetUrl(null), '')
})

test('DR-002 三维资源加载区分 404、权限、MIME 和损坏文件', async () => {
  const response = (status, contentType, bytes = new Uint8Array()) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: () => contentType },
    arrayBuffer: async () => bytes.buffer,
  })
  const loader = { parseAsync: async () => ({ scene: {} }) }
  await assert.rejects(loadDirectorGltf(loader, '/missing.glb', async () => response(404, 'model/gltf-binary')), /不存在（404）/)
  await assert.rejects(loadDirectorGltf(loader, '/private.glb', async () => response(403, 'model/gltf-binary')), /无权限.*（403）/)
  await assert.rejects(loadDirectorGltf(loader, '/wrong.glb', async () => response(200, 'text/plain')), /MIME 类型错误：text\/plain/)
  await assert.rejects(loadDirectorGltf(loader, '/broken.glb', async () => response(200, 'model/gltf-binary', new Uint8Array([1, 2, 3]))), /文件损坏或格式无效/)
  const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0])
  assert.deepEqual(await loadDirectorGltf(loader, '/valid.vrm', async () => response(200, 'application/octet-stream', glb)), { scene: {} })
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

test('未命名骨骼动作可通过 GLTFLoader 生成的 UUID 目标匹配角色', () => {
  const root = {
    name: '',
    uuid: 'root-uuid',
    traverse(callback) {
      callback({ name: '', uuid: 'root-uuid' })
      callback({ name: '', uuid: 'joint-uuid' })
    },
  }
  assert.equal(isDirectorAnimationCompatible(root, [{ tracks: [{ name: 'joint-uuid.quaternion' }] }]), true)
})
