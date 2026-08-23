import { FaceDetection } from '@mediapipe/face_detection'
import fullGraphUrl from '@mediapipe/face_detection/face_detection_full.binarypb?url'
import fullModelUrl from '@mediapipe/face_detection/face_detection_full_range_sparse.tflite?url'
import shortGraphUrl from '@mediapipe/face_detection/face_detection_short.binarypb?url'
import shortModelUrl from '@mediapipe/face_detection/face_detection_short_range.tflite?url'
import simdLoaderUrl from '@mediapipe/face_detection/face_detection_solution_simd_wasm_bin.js?url'
import simdWasmUrl from '@mediapipe/face_detection/face_detection_solution_simd_wasm_bin.wasm?url'
import wasmLoaderUrl from '@mediapipe/face_detection/face_detection_solution_wasm_bin.js?url'
import wasmUrl from '@mediapipe/face_detection/face_detection_solution_wasm_bin.wasm?url'

const assetUrls = Object.freeze({
  'face_detection_full.binarypb': fullGraphUrl,
  'face_detection_full_range_sparse.tflite': fullModelUrl,
  'face_detection_short.binarypb': shortGraphUrl,
  'face_detection_short_range.tflite': shortModelUrl,
  'face_detection_solution_simd_wasm_bin.js': simdLoaderUrl,
  'face_detection_solution_simd_wasm_bin.wasm': simdWasmUrl,
  'face_detection_solution_wasm_bin.js': wasmLoaderUrl,
  'face_detection_solution_wasm_bin.wasm': wasmUrl,
})
const PORTRAIT_DETECTION_TIMEOUT_MS = 8000

let detectorPromise = null
let detectionQueue = Promise.resolve()
let pendingResult = null

function clearPendingResult(request) {
  if (pendingResult !== request) return false
  pendingResult = null
  clearTimeout(request.timer)
  return true
}

function retireDetector(detector) {
  detectorPromise = null
  try {
    const closing = detector.close?.()
    closing?.catch?.(() => {})
  } catch {
    // The timed-out detector is already retired; close failures are non-actionable here.
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

async function getDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const detector = new FaceDetection({
        locateFile: (file) => assetUrls[file] || file,
      })
      detector.setOptions({
        model: 'full',
        minDetectionConfidence: 0.55,
        selfieMode: false,
      })
      detector.onResults((results) => {
        const request = pendingResult
        if (!request || request.detector !== detector) return
        clearPendingResult(request)
        request.resolve(results)
      })
      await detector.initialize()
      return detector
    })().catch((error) => {
      detectorPromise = null
      throw error
    })
  }
  return detectorPromise
}

function normalizeDetections(detections) {
  return detections
    .map(({ boundingBox }) => {
      const width = clamp(Number(boundingBox?.width || 0), 0, 1)
      const height = clamp(Number(boundingBox?.height || 0), 0, 1)
      const x = clamp(Number(boundingBox?.xCenter || 0) - (width / 2), 0, 1)
      const y = clamp(Number(boundingBox?.yCenter || 0) - (height / 2), 0, 1)
      return {
        x,
        y,
        width: Math.min(width, 1 - x),
        height: Math.min(height, 1 - y),
      }
    })
    .filter(({ width, height }) => width >= 0.01 && height >= 0.01)
    .sort((left, right) => (
      Math.abs(left.y - right.y) > 0.08
        ? left.y - right.y
        : left.x - right.x
    ))
}

function imageSize(image) {
  return {
    width: Number(image.naturalWidth || image.videoWidth || image.width || 0),
    height: Number(image.naturalHeight || image.videoHeight || image.height || 0),
  }
}

function intersectionOverUnion(left, right) {
  const intersectionWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  )
  const intersectionHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  )
  const intersection = intersectionWidth * intersectionHeight
  return intersection / ((left.width * left.height) + (right.width * right.height) - intersection)
}

function mergeFaces(faces) {
  return faces
    .filter((face) => face.width >= 0.035 && face.height >= 0.035)
    .sort((left, right) => (right.width * right.height) - (left.width * left.height))
    .filter((face, index, all) => (
      all.slice(0, index).every((candidate) => intersectionOverUnion(face, candidate) < 0.35)
    ))
    .sort((left, right) => (
      Math.abs(left.y - right.y) > 0.08
        ? left.y - right.y
        : left.x - right.x
    ))
    .slice(0, 10)
}

function portraitTiles(width, height) {
  const side = Math.min(width, height)
  if (Math.max(width, height) / side > 1.3) {
    const columns = width > height ? Math.ceil(width / height) : 2
    const rows = height > width ? Math.ceil(height / width) : 2
    const tileWidth = Math.ceil(width / columns)
    const tileHeight = Math.ceil(height / rows)
    return Array.from({ length: rows * columns }, (_, index) => ({
      left: (index % columns) * tileWidth,
      top: Math.floor(index / columns) * tileHeight,
      width: Math.min(tileWidth, width - ((index % columns) * tileWidth)),
      height: Math.min(tileHeight, height - (Math.floor(index / columns) * tileHeight)),
    }))
  }
  const tileWidth = Math.round(width * 0.65)
  const tileHeight = Math.round(height * 0.65)
  return [
    { left: 0, top: 0 },
    { left: width - tileWidth, top: 0 },
    { left: 0, top: height - tileHeight },
    { left: width - tileWidth, top: height - tileHeight },
  ].map(({ left, top }) => ({ left, top, width: tileWidth, height: tileHeight }))
}

async function detectTiledFaces(image, width, height) {
  const canvas = document.createElement('canvas')
  const faces = []
  for (const tile of portraitTiles(width, height)) {
    const scale = Math.min(512 / tile.width, 512 / tile.height)
    canvas.width = Math.max(1, Math.round(tile.width * scale))
    canvas.height = Math.max(1, Math.round(tile.height * scale))
    const context = canvas.getContext('2d')
    context.drawImage(
      image,
      tile.left,
      tile.top,
      tile.width,
      tile.height,
      0,
      0,
      canvas.width,
      canvas.height,
    )
    const detections = await detectOnce(canvas)
    faces.push(...detections.map((face) => ({
      x: (tile.left + (face.x * tile.width)) / width,
      y: (tile.top + (face.y * tile.height)) / height,
      width: (face.width * tile.width) / width,
      height: (face.height * tile.height) / height,
    })))
  }
  return faces
}

async function detectOnce(image) {
  const detector = await getDetector()
  let request
  const result = new Promise((resolve, reject) => {
    request = { detector, resolve, reject, timer: null }
    request.timer = setTimeout(() => {
      if (!clearPendingResult(request)) return
      retireDetector(detector)
      reject(new Error('人脸识别响应超时，请手动框选'))
    }, PORTRAIT_DETECTION_TIMEOUT_MS)
    pendingResult = request
  })
  try {
    const send = Promise.resolve().then(() => detector.send({ image }))
    const { detections = [] } = await Promise.race([
      result,
      send.then(() => result),
    ])
    return normalizeDetections(detections)
  } catch (error) {
    if (clearPendingResult(request)) {
      request.reject(error)
      retireDetector(detector)
    }
    throw error
  }
}

export function detectPortraitFacesInImage(image) {
  const operation = detectionQueue.then(async () => {
    const fullImageFaces = await detectOnce(image)
    const { width, height } = imageSize(image)
    const hasProminentFace = fullImageFaces.some((face) => face.width * face.height >= 0.04)
    if (!width || !height || hasProminentFace) return fullImageFaces
    const tiledFaces = await detectTiledFaces(image, width, height)
    return mergeFaces([...fullImageFaces, ...tiledFaces])
  })
  detectionQueue = operation.catch(() => {})
  return operation
}
