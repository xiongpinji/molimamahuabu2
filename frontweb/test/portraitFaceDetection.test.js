import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sourcePath = fileURLToPath(
  new URL('../src/utils/portraitFaceDetection.js', import.meta.url),
)
const originalSource = readFileSync(sourcePath, 'utf8')
let moduleSequence = 0

function fakeDetectorHarness() {
  const handlers = []
  class FakeFaceDetection {
    static instances = []

    constructor() {
      this.closed = false
      this.resultsCallback = null
      FakeFaceDetection.instances.push(this)
    }

    setOptions() {}

    onResults(callback) {
      this.resultsCallback = callback
    }

    async initialize() {}

    send({ image }) {
      const handler = handlers.shift()
      if (!handler) throw new Error('缺少测试检测器响应')
      return handler(this, image)
    }

    emit(detections) {
      this.resultsCallback?.({ detections })
    }

    async close() {
      this.closed = true
    }
  }
  return { FaceDetection: FakeFaceDetection, handlers }
}

async function loadFaceDetectionModule(FaceDetection) {
  globalThis.__portraitFaceDetectionTestDouble = FaceDetection
  let source = originalSource
    .replace(
      "import { FaceDetection } from '@mediapipe/face_detection'",
      'const FaceDetection = globalThis.__portraitFaceDetectionTestDouble',
    )
    .replace(
      /^import (\w+) from '@mediapipe\/face_detection\/[^']+\?url'$/gm,
      "const $1 = 'test://$1'",
    )
  if (/const PORTRAIT_DETECTION_TIMEOUT_MS = \d+/.test(source)) {
    source = source.replace(
      /const PORTRAIT_DETECTION_TIMEOUT_MS = \d+/,
      'const PORTRAIT_DETECTION_TIMEOUT_MS = 15',
    )
  } else {
    source = `const PORTRAIT_DETECTION_TIMEOUT_MS = 15\n${source}`
  }
  source += `\nconst __portraitFaceDetectionTestModule = ${moduleSequence += 1}\n`
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  } finally {
    delete globalThis.__portraitFaceDetectionTestDouble
  }
}

function prominentDetection(xCenter) {
  return {
    boundingBox: {
      xCenter,
      yCenter: 0.5,
      width: 0.4,
      height: 0.4,
    },
  }
}

async function withTestDeadline(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('测试等待检测结果超时')), 100)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('检测器无回调时在有限时间内拒绝并释放检测器', async () => {
  const harness = fakeDetectorHarness()
  harness.handlers.push(() => Promise.resolve())
  const module = await loadFaceDetectionModule(harness.FaceDetection)

  await assert.rejects(
    withTestDeadline(module.detectPortraitFacesInImage({ naturalWidth: 800, naturalHeight: 800 })),
    /人脸识别响应超时/,
  )
  assert.equal(harness.FaceDetection.instances[0].closed, true)
})

test('检测器正常回调时返回归一化人脸区域', async () => {
  const harness = fakeDetectorHarness()
  harness.handlers.push((detector) => {
    queueMicrotask(() => detector.emit([prominentDetection(0.5)]))
    return Promise.resolve()
  })
  const module = await loadFaceDetectionModule(harness.FaceDetection)

  const faces = await withTestDeadline(
    module.detectPortraitFacesInImage({ naturalWidth: 800, naturalHeight: 800 }),
  )

  assert.deepEqual(faces, [{ x: 0.3, y: 0.3, width: 0.4, height: 0.4 }])
})

test('超时后的晚到回调不会串到下一次检测', async () => {
  const harness = fakeDetectorHarness()
  harness.handlers.push(() => Promise.resolve())
  const module = await loadFaceDetectionModule(harness.FaceDetection)

  await assert.rejects(
    withTestDeadline(module.detectPortraitFacesInImage({ naturalWidth: 800, naturalHeight: 800 })),
    /人脸识别响应超时/,
  )
  const retiredDetector = harness.FaceDetection.instances[0]
  harness.handlers.push((detector) => {
    queueMicrotask(() => {
      retiredDetector.emit([prominentDetection(0.2)])
      queueMicrotask(() => detector.emit([prominentDetection(0.8)]))
    })
    return Promise.resolve()
  })

  const faces = await withTestDeadline(
    module.detectPortraitFacesInImage({ naturalWidth: 800, naturalHeight: 800 }),
  )

  assert.equal(harness.FaceDetection.instances.length, 2)
  assert.equal(faces.length, 1)
  assert.ok(Math.abs(faces[0].x - 0.6) < Number.EPSILON * 2)
  assert.ok(Math.abs(faces[0].width - 0.4) < Number.EPSILON * 2)
})
