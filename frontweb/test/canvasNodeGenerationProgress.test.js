import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  calculateBatchGenerationProgress,
  normalizeGenerationProgress,
} from '../src/utils/canvasGenerationProgress.js'

const homeNodeSource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/HomeCanvasNode.vue', import.meta.url)), 'utf8')
const statusOverlaySource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/CanvasNodeStatusOverlay.vue', import.meta.url)), 'utf8')
const canvasSource = readFileSync(fileURLToPath(new URL('../src/views/DramaCanvas.vue', import.meta.url)), 'utf8')

test('只把接口提供的有限数值识别为真实生成进度', () => {
  for (const value of [null, undefined, '', 'unknown', Number.NaN]) {
    assert.equal(normalizeGenerationProgress(value), null)
  }
  assert.equal(normalizeGenerationProgress(0), 0)
  assert.equal(normalizeGenerationProgress('42.4'), 42)
  assert.equal(normalizeGenerationProgress(145), 100)
  assert.equal(normalizeGenerationProgress(-8), 0)
})

test('批量任务把单个任务真实进度换算为整体真实进度', () => {
  assert.equal(calculateBatchGenerationProgress(0, 1, 42), 42)
  assert.equal(calculateBatchGenerationProgress(1, 4, 50), 38)
  assert.equal(calculateBatchGenerationProgress(2, 4, null), null)
})

test('自由画布所有节点生成时叠加旋转动画和真实或不定进度', () => {
  assert.match(homeNodeSource, /v-if="isGenerationRunning"[\s\S]*class="node-generation-state"/)
  assert.match(homeNodeSource, /class="node-generation-spinner"/)
  assert.match(homeNodeSource, /hasActualGenerationProgress/)
  assert.match(homeNodeSource, /'is-indeterminate': !hasActualGenerationProgress/)
  assert.match(homeNodeSource, /class="run-spinner"/)
  assert.match(homeNodeSource, /props\.data\.generationActive === true/)
  assert.doesNotMatch(homeNodeSource, /data\.status === 'running' \? '生成中/)
})

test('任务轮询只回写供应商真实进度并标记来源已知', () => {
  assert.match(canvasSource, /pollFreeCanvasTask\(taskId, \{[\s\S]*onProgress/)
  assert.match(canvasSource, /calculateBatchGenerationProgress/)
  assert.match(canvasSource, /progressKnown: true/)
  assert.match(canvasSource, /generationBatchSize: quantity/)
  assert.match(canvasSource, /generationTaskBaseCount: completedResults\.length/)
  assert.match(canvasSource, /completedCount === null \? \{ progressKnown: false \}/)
  assert.match(canvasSource, /progress: recoveredProgress/)
  assert.match(canvasSource, /progressKnown: completedCount !== null/)
  assert.doesNotMatch(canvasSource, /runFreeCanvasGenerationItem/)
})

test('项目画布节点有真实进度显示确定进度，无进度显示循环动画', () => {
  assert.match(statusOverlaySource, /class="status-progress-track"/)
  assert.match(statusOverlaySource, /'is-indeterminate': actualProgress === null/)
  assert.match(statusOverlaySource, /normalizeGenerationProgress/)
  assert.match(statusOverlaySource, /class="spinner"/)
  assert.match(statusOverlaySource, /'image', 'video', 'audio', 'prompt'/)
  assert.match(statusOverlaySource, /generationSteps\.has\(status\.value\?\.step\)/)
})
