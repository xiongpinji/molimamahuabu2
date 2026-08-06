import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analysisQuoteCredits,
  buildAnalyzePayload,
  canStartRedrawAnalysis,
  createRedrawStyleSelection,
  localeReady,
  taskStateFromWork,
} from '../src/utils/redrawWorkspaceState.js'

test('有效报价启用且无报价禁用，只读取 work.analysis_quote', () => {
  const work = { id: 8, analysis_quote: { credits: 6 } }
  const presetWithFakeCredits = { id: 3, credits: 99 }

  assert.equal(analysisQuoteCredits(work, presetWithFakeCredits), 6)
  assert.equal(canStartRedrawAnalysis({ work, locales: [{ locale: 'ja-JP', market: 'JP' }], selectedPreset: { id: 3 } }), true)
  assert.equal(canStartRedrawAnalysis({
    work: { id: 8, analysis_quote: null },
    locales: [{ locale: 'ja-JP', market: 'JP' }],
    selectedPreset: presetWithFakeCredits,
  }), false)
})

test('分析 payload 包含语言地区、比例、普通 preset 或自由风格参考图字段', () => {
  assert.deepEqual(buildAnalyzePayload({
    locale: 'ja-JP',
    market: 'JP',
    aspectRatio: '9:16',
    selectedPreset: { id: 7 },
  }), {
    locale: 'ja-JP',
    market: 'JP',
    aspect_ratio: '9:16',
    style_preset_id: 7,
  })

  assert.deepEqual(buildAnalyzePayload({
    locale: 'en-US',
    market: 'US',
    aspectRatio: '16:9',
    freeStyle: {
      positivePrompt: 'warm light',
      negativePrompt: 'blur',
      referenceImage: { name: 'style.png' },
    },
  }), {
    locale: 'en-US',
    market: 'US',
    aspect_ratio: '16:9',
    free_style: {
      positive: 'warm light',
      negative: 'blur',
      reference: { filename: 'style.png' },
    },
  })
})

test('自由风格真实参考图文件保留给 analyze API multipart 上传', () => {
  const referenceFile = new File(['style'], 'style.png', { type: 'image/png' })

  const payload = buildAnalyzePayload({
    locale: 'en-US',
    market: 'US',
    aspectRatio: '3:4',
    freeStyle: {
      positivePrompt: 'warm light',
      negativePrompt: 'blur',
      referenceImage: referenceFile,
    },
  })

  assert.equal(payload.aspect_ratio, '3:4')
  assert.equal(payload.free_style.reference.filename, 'style.png')
  assert.equal(payload.free_style.reference.file, referenceFile)
})

test('刷新恢复真实 task progress，不伪造 processing 进度', () => {
  assert.deepEqual(taskStateFromWork({
    task_id: 'task-1',
    task_status: 'processing',
    task_progress: 64,
    task_message: '正在读取源片',
  }), {
    task_id: 'task-1',
    status: 'processing',
    progress: 64,
    message: '正在读取源片',
  })
})

test('空 locales 不伪造默认语言并禁用提交', () => {
  assert.equal(localeReady([]), false)
  assert.equal(canStartRedrawAnalysis({
    work: { id: 8, analysis_quote: { credits: 6 } },
    locales: [],
    selectedPreset: { id: 3 },
  }), false)
})

test('普通 preset 与自由风格双向互斥并保留参考图字段', () => {
  const selection = createRedrawStyleSelection()
  selection.setFreeStyle({
    positivePrompt: 'free style',
    negativePrompt: 'noise',
    referenceImage: { name: 'style.png' },
  })
  assert.equal(selection.selectedPreset, null)
  assert.equal(selection.freeStyle.referenceImage.name, 'style.png')

  selection.selectPreset({ id: 3, name: '真人写实' })
  assert.equal(selection.selectedPreset.id, 3)
  assert.deepEqual(selection.freeStyle, { positivePrompt: '', negativePrompt: '', referenceImage: null })
})
