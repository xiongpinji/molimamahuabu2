import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { shouldProjectCanvasAsset } from '../src/utils/canvasAssetProjection.js'

const adapterSource = readFileSync(
  fileURLToPath(new URL('../src/utils/dramaCanvasAdapter.js', import.meta.url)),
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
  ]

  for (const asset of automaticAssets) {
    assert.equal(shouldProjectCanvasAsset(asset), false, `asset ${asset.id} should stay out of the canvas`)
  }
})

test('手动上传或从素材库显式加入的素材仍可投影到画布', () => {
  const manualAssets = [
    {
      id: 11,
      type: 'image',
      category: 'library',
      metadata: JSON.stringify({ source: 'media_library_upload' }),
    },
    {
      id: 12,
      type: 'video',
      category: 'canvas-library-pick',
      metadata: { source: 'canvas_asset_picker' },
    },
    {
      id: 13,
      type: 'audio',
      category: 'library',
      metadata: { source: 'media_library_upload' },
    },
  ]

  for (const asset of manualAssets) {
    assert.equal(shouldProjectCanvasAsset(asset), true, `asset ${asset.id} should remain available on the canvas`)
  }
})

test('两类画布构图统一经过自动资产投影过滤器', () => {
  assert.match(adapterSource, /import \{ shouldProjectCanvasAsset \} from '\.\/canvasAssetProjection'/)
  assert.equal((adapterSource.match(/\.filter\(shouldProjectCanvasAsset\)/g) || []).length, 2)
})
