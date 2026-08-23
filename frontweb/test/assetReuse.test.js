import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAssetReusePayload } from '../src/utils/assetReuse.js'

test('素材复用保留原绑定，并创建指向同一文件的派生记录', () => {
  const source = {
    id: 17,
    drama_id: 3,
    storyboard_id: 9,
    name: '角色参考图',
    type: 'image',
    url: '/static/images/role.png',
    local_path: 'images/role.png',
    file_size: 1024,
    mime_type: 'image/png',
    metadata: { quality_notice: '原始素材元数据' },
  }
  const snapshot = structuredClone(source)

  const payload = buildAssetReusePayload(source, {
    purpose: 'reference',
    dramaId: 8,
    storyboardId: 21,
  })

  assert.deepEqual(source, snapshot)
  assert.equal(payload.drama_id, 8)
  assert.equal(payload.storyboard_id, 21)
  assert.equal(payload.url, source.url)
  assert.equal(payload.local_path, source.local_path)
  assert.equal(payload.metadata.reused_from_asset_id, 17)
  assert.equal(payload.metadata.reuse_purpose, 'reference')
  assert.equal(payload.metadata.reuse_source_drama_id, 3)
  assert.equal(payload.metadata.reuse_source_storyboard_id, 9)
  assert.equal(payload.metadata.attached_drama_id, 8)
  assert.equal(payload.metadata.attached_storyboard_id, 21)
  assert.equal(payload.metadata.quality_notice, '原始素材元数据')
})

test('项目画布复用不绑定分镜，并兼容类型专属文件字段', () => {
  const payload = buildAssetReusePayload({
    id: 23,
    drama_id: null,
    storyboard_id: null,
    name: '上传图片',
    type: 'image',
    image_url: '/static/uploads/image.png',
    image_local_path: 'uploads/image.png',
  }, {
    purpose: 'canvas',
    dramaId: 12,
    storyboardId: 99,
  })

  assert.equal(payload.drama_id, 12)
  assert.equal(payload.storyboard_id, null)
  assert.equal(payload.url, '/static/uploads/image.png')
  assert.equal(payload.local_path, 'uploads/image.png')
  assert.equal(payload.metadata.reuse_purpose, 'canvas')
  assert.equal(payload.metadata.attached_storyboard_id, null)
})
