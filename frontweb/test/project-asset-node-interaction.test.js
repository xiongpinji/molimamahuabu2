import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { collectDirectUpstreamImageReferences } from '../src/utils/freeCanvasGeneration.js'

const nodeSource = readFileSync(
  fileURLToPath(new URL('../src/components/dramaCanvas/CanvasProjectAssetNode.vue', import.meta.url)),
  'utf8',
)
const adapterSource = readFileSync(
  fileURLToPath(new URL('../src/utils/dramaCanvasAdapter.js', import.meta.url)),
  'utf8',
)
const canvasSource = readFileSync(
  fileURLToPath(new URL('../src/views/DramaCanvas.vue', import.meta.url)),
  'utf8',
)

test('项目素材以正式节点进入两类画布且图片视频音频均暴露参考输出端口', () => {
  assert.match(nodeSource, /import \{ Handle, Position \} from '@vue-flow\/core'/)
  assert.match(nodeSource, /<Handle[\s\S]{0,180}?v-if="\['image', 'video', 'audio'\]\.includes\(assetType\)"[\s\S]{0,180}?type="source"[\s\S]{0,180}?:position="Position\.Right"/)
  assert.doesNotMatch(nodeSource, /<Handle[^>]*type="target"/)

  const projectAssetDefinitions = adapterSource.match(/type: 'canvasProjectAsset',[\s\S]{0,220}?data: \{ asset \},/g) || []
  assert.equal(projectAssetDefinitions.length, 2)
  for (const definition of projectAssetDefinitions) {
    assert.match(definition, /draggable: true/)
    assert.match(definition, /connectable: true/)
  }
})

test('素材预览不劫持节点拖动且连线素材会进入下游生成参考', () => {
  assert.match(nodeSource, /<video[^>]*draggable="false"/)
  assert.match(nodeSource, /<audio[^>]*draggable="false"/)
  assert.match(nodeSource, /<img[^>]*draggable="false"/)
  assert.match(nodeSource, /class="asset-actions" @pointerdown\.stop @mousedown\.stop/)
  assert.match(canvasSource, /function nodeInputReferenceUrls\(node\)[\s\S]*nodeResultUrl\(sourceNode\)/)
  assert.match(canvasSource, /upstreamReferenceUrls: upstreamReferenceUrlsForNode/)
})

test('项目素材预览在站内产生可见且可关闭的图片视频音频结果', () => {
  assert.match(nodeSource, /<Teleport to="body">/)
  assert.match(nodeSource, /v-if="previewVisible"[\s\S]*role="dialog"[\s\S]*aria-label="素材预览"/)
  assert.match(nodeSource, /<img[\s\S]*v-if="assetType === 'image'"/)
  assert.match(nodeSource, /<video v-else-if="assetType === 'video'"[^>]*controls/)
  assert.match(nodeSource, /<audio v-else[^>]*controls/)
  assert.match(nodeSource, /function openAsset\(\) \{[\s\S]*previewVisible\.value = true/)
  assert.match(nodeSource, /function closeAssetPreview\(\) \{[\s\S]*previewVisible\.value = false/)
  assert.doesNotMatch(nodeSource, /window\.open\(url\.value/)
})

test('项目图片素材连线后会成为可用的下游参考图', () => {
  const references = collectDirectUpstreamImageReferences(
    [
      {
        id: 'project-asset:77',
        type: 'canvasProjectAsset',
        data: {
          asset: {
            id: 77,
            type: 'image',
            name: '项目雨夜参考图',
            url: 'https://example.com/project-rain.png',
          },
        },
      },
      {
        id: 'free:video:target',
        type: 'homeCanvasNode',
        data: { kind: 'video', title: '下游视频节点' },
      },
    ],
    [
      {
        id: 'manual:project-asset:77:free:video:target',
        source: 'project-asset:77',
        target: 'free:video:target',
        data: { contract: { input: 'reference-image' } },
      },
    ],
    'free:video:target',
  )

  assert.deepEqual(references, [
    {
      nodeId: 'project-asset:77',
      edgeId: 'manual:project-asset:77:free:video:target',
      title: '项目雨夜参考图',
      url: 'https://example.com/project-rain.png',
      ready: true,
      slot: 'reference-image',
      enabled: true,
      order: 0,
      weight: 1,
    },
  ])
})

test('缺失或大小写不一致的图片类型仍会成为下游参考图', () => {
  for (const [assetId, type] of [['missing-type', undefined], ['uppercase-type', 'IMAGE']]) {
    const references = collectDirectUpstreamImageReferences(
      [
        {
          id: `project-asset:${assetId}`,
          type: 'canvasProjectAsset',
          data: {
            asset: {
              id: assetId,
              ...(type ? { type } : {}),
              name: '兼容图片素材',
              url: `https://example.com/${assetId}.png`,
            },
          },
        },
        {
          id: 'free:video:target',
          type: 'homeCanvasNode',
          data: { kind: 'video', title: '下游视频节点' },
        },
      ],
      [{
        id: `manual:${assetId}`,
        source: `project-asset:${assetId}`,
        target: 'free:video:target',
      }],
      'free:video:target',
    )

    assert.equal(references[0]?.url, `https://example.com/${assetId}.png`)
    assert.equal(references[0]?.ready, true)
  }
})
