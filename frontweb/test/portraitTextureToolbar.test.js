import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalizeFreeCanvasNodeData } from '../src/utils/freeCanvasGeneration.js'

const toolbarSource = readFileSync(
  fileURLToPath(new URL('../src/components/dramaCanvas/ImageNodeToolbar.vue', import.meta.url)),
  'utf8',
)
const capabilitySource = readFileSync(
  fileURLToPath(new URL('../src/utils/imageToolProviderCapabilities.js', import.meta.url)),
  'utf8',
)
const persistenceSource = readFileSync(
  fileURLToPath(new URL('../src/utils/freeCanvasGeneration.js', import.meta.url)),
  'utf8',
)

test('图片工具栏复刻人像质感一级入口和两个子入口', () => {
  assert.match(toolbarSource, /人像质感调节/)
  assert.match(toolbarSource, /class="new-badge">NEW/)
  assert.match(toolbarSource, /\{ label: '人像调节', operation: 'portrait_texture'/)
  assert.match(toolbarSource, /\{ label: '情绪调节', operation: 'portrait_emotion'/)
  assert.match(toolbarSource, /openToolbarMenu\('portrait'\)/)
})

test('情绪调节提供 5x5 情绪定位、自动识别和手动框选回退', () => {
  assert.match(toolbarSource, /class="emotion-grid"/)
  assert.match(toolbarSource, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/)
  assert.match(toolbarSource, /强忍悲戚/)
  assert.match(toolbarSource, /疲惫失神/)
  assert.match(toolbarSource, /激动/)
  assert.match(toolbarSource, /平静/)
  assert.match(toolbarSource, /亲近/)
  assert.match(toolbarSource, /疏离/)
  assert.match(toolbarSource, /window\.FaceDetector/)
  assert.match(toolbarSource, /自动识别不可用/)
  assert.match(toolbarSource, /手动框选/)
  assert.match(toolbarSource, /faceRegion/)
})

test('人像操作只提交受控参数并可安全持久化重试', () => {
  assert.match(toolbarSource, /portraitTextureForm = ref/)
  assert.match(toolbarSource, /portraitEmotionForm = ref/)
  assert.match(toolbarSource, /editorOperation\.value === 'portrait_texture'/)
  assert.match(toolbarSource, /editorOperation\.value === 'portrait_emotion'/)
  assert.match(capabilitySource, /supports_portrait_texture/)
  assert.match(capabilitySource, /supports_portrait_emotion/)
  assert.match(persistenceSource, /portrait_texture: \['preset', 'intensity', 'description'\]/)
  assert.match(persistenceSource, /portrait_emotion: \['emotion', 'intensity', 'faceRegion'\]/)
  assert.equal(
    toolbarSource.match(/typeof ctx\?\.runImageNodeTool !== 'function'/g)?.length,
    2,
    '首次提交和历史重试都必须要求真实画布执行器',
  )
})

test('情绪调节重试参数仅持久化有效的归一化人脸区域', () => {
  const valid = normalizeFreeCanvasNodeData({
    kind: 'image',
    imageToolRetryOperation: 'portrait_emotion',
    imageToolRetryParameters: {
      emotion: '欣然愉悦',
      intensity: 4,
      faceRegion: { x: 0.2, y: 0.1, width: 0.5, height: 0.7 },
    },
  })
  assert.deepEqual(valid.imageToolRetryParameters, {
    emotion: '欣然愉悦',
    intensity: 4,
    faceRegion: { x: 0.2, y: 0.1, width: 0.5, height: 0.7 },
  })

  const invalid = normalizeFreeCanvasNodeData({
    kind: 'image',
    imageToolRetryOperation: 'portrait_emotion',
    imageToolRetryParameters: {
      emotion: '欣然愉悦',
      intensity: 4,
      faceRegion: { x: 0.8, y: 0.1, width: 0.5, height: 0.7 },
    },
  })
  assert.equal(invalid.imageToolRetryOperation, undefined)
  assert.equal(invalid.imageToolRetryParameters, undefined)
})
