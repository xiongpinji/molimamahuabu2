import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const runnerSource = readFileSync(
  resolve(__dirname, '../src/composables/useCanvasWorkflowRunner.js'),
  'utf8'
)

test('画布视频节点把模型、首尾帧和素材引用传给视频创建接口', () => {
  assert.match(runnerSource, /export\s+async\s+function\s+runVideoStep\(/)
  assert.match(runnerSource, /hydrateStoryboardSettings\(sb\)/)
  assert.match(runnerSource, /sbVideoFirstLastUrls\(sb,\s*imagesBySbId,\s*useFirstLast\)/)
  assert.match(runnerSource, /collectStoryboardReferenceAssets\(drama,\s*sb\)/)
  assert.match(runnerSource, /buildStoryboardContinuityPrompt\(\{/)
  assert.match(runnerSource, /fetchAssignedAssetUrls\(sb\.id\)/)
  assert.match(runnerSource, /getStoryboardVideoModel\(sb,\s*genOpts\)/)
  assert.match(runnerSource, /videosAPI\.create\(\{[\s\S]*model:\s*model\s*\|\|\s*undefined/)
  assert.match(runnerSource, /videosAPI\.create\(\{[\s\S]*first_frame_url:\s*absoluteFirst\s*\|\|\s*undefined/)
  assert.match(runnerSource, /videosAPI\.create\(\{[\s\S]*last_frame_url:\s*absoluteLast/)
  assert.match(runnerSource, /videosAPI\.create\(\{[\s\S]*reference_image_urls:\s*referenceUrls\.length\s*\?\s*referenceUrls\s*:\s*undefined/)
  assert.match(runnerSource, /videosAPI\.create\(\{[\s\S]*resolution:\s*genOpts\.videoResolution\s*\|\|\s*undefined/)
})
