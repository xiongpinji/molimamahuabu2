import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  canvasAssetProjectionPayload,
  shouldProjectCanvasAsset,
} from '../src/utils/canvasAssetProjection.js'

const adapterSource = readFileSync(
  fileURLToPath(new URL('../src/utils/dramaCanvasAdapter.js', import.meta.url)),
  'utf8',
)

const canvasSource = readFileSync(
  fileURLToPath(new URL('../src/views/DramaCanvas.vue', import.meta.url)),
  'utf8',
)

test('自动生成和分析产生的媒体只留在资产历史，不投影为小素材节点', () => {
  const automaticAssets = [
    {
      id: 1,
      type: 'image',
      category: 'canvas-result',
      metadata: { source: 'canvas_node_result', auto_saved: true },
    },
    {
      id: 2,
      type: 'image',
      category: 'director-ai-reference',
      metadata: JSON.stringify({ source: 'director_reference_analysis' }),
    },
    {
      id: 3,
      type: 'video',
      category: 'library',
      metadata: JSON.stringify({ sourceNodeId: 'free:video:3', operation: 'crop' }),
    },
    {
      id: 4,
      type: 'audio',
      category: 'canvas-result',
      metadata: { canvas_node_id: 'free:audio:4' },
    },
    {
      id: 5,
      type: 'video',
      category: 'library',
      metadata: { source: 'media_library_upload' },
    },
    {
      id: 6,
      type: 'image',
      category: 'director-capture',
      metadata: null,
    },
    {
      id: 7,
      type: 'image',
      category: 'library',
      metadata: { image_gen_id: 71 },
    },
    {
      id: 8,
      type: 'video',
      category: 'video-tool',
      metadata: { video_gen_id: 81 },
    },
  ]

  for (const asset of automaticAssets) {
    assert.equal(shouldProjectCanvasAsset(asset), false, `asset ${asset.id} should stay out of the canvas`)
  }
})

test('只有从画布显式加入的素材才投影到画布', () => {
  const manualAssets = [
    {
      id: 11,
      type: 'image',
      category: 'canvas-library-pick',
      metadata: JSON.stringify({ source: 'canvas_asset_picker' }),
    },
    {
      id: 12,
      type: 'video',
      category: 'canvas-paste',
      metadata: { source: 'canvas_context_paste' },
    },
    {
      id: 13,
      type: 'audio',
      category: 'library',
      metadata: {
        source: 'media_library_upload',
        canvas_added: true,
        canvas_add_source: 'canvas_context_upload',
      },
    },
    {
      id: 14,
      type: 'image',
      category: 'canvas-asset-failure',
      metadata: { source: 'canvas_asset_picker_failure' },
    },
  ]

  for (const asset of manualAssets) {
    assert.equal(shouldProjectCanvasAsset(asset), true, `asset ${asset.id} should remain available on the canvas`)
  }
})

test('画布显式加入标记保留资产原始来源', () => {
  const payload = canvasAssetProjectionPayload({
    metadata: JSON.stringify({ source: 'media_library_upload', upload_batch: 'qa-1' }),
  }, 'canvas_context_upload')

  assert.deepEqual(payload, {
    metadata: {
      source: 'media_library_upload',
      upload_batch: 'qa-1',
      canvas_added: true,
      canvas_add_source: 'canvas_context_upload',
    },
  })
})

test('两类画布构图统一经过自动资产投影过滤器', () => {
  assert.match(adapterSource, /import \{ shouldProjectCanvasAsset \} from '\.\/canvasAssetProjection'/)
  assert.equal((adapterSource.match(/\.filter\(shouldProjectCanvasAsset\)/g) || []).length, 2)
})

test('画布上传和已有项目素材选择都写入显式加入标记', () => {
  assert.match(canvasSource, /markProjectAssetForCanvas\(asset, 'canvas_asset_picker'\)/)
  assert.match(canvasSource, /markProjectAssetForCanvas\(uploadedAsset, 'canvas_context_upload'\)/)
})
