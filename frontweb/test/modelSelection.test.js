import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getModelsFromAiConfig,
  getSelectableModels,
  isConfigForServiceType,
} from '../src/utils/modelSelection.js'

const configs = [
  {
    id: 1,
    service_type: 'text',
    is_active: true,
    is_default: true,
    model: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    default_model: 'deepseek-v4-flash',
  },
  {
    id: 2,
    service_type: 'text',
    is_active: true,
    is_default: false,
    model: ['qwen-plus'],
    default_model: 'qwen-plus',
  },
]

test('uses default active config models when no config is selected', () => {
  assert.deepEqual(getSelectableModels(configs, 'text', null), [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
  ])
})

test('uses selected config models when config is selected', () => {
  assert.deepEqual(getSelectableModels(configs, 'text', 2), ['qwen-plus'])
})

test('falls back to an active image config for storyboard image selection', () => {
  assert.deepEqual(getSelectableModels([{
    id: 3,
    service_type: 'image',
    is_active: true,
    is_default: true,
    model: ['gpt-image-2'],
  }], 'storyboard_image', null), ['gpt-image-2'])
})

test('prefers an exact storyboard image config over the image fallback', () => {
  const exactConfig = {
    id: 4,
    service_type: 'storyboard_image',
    is_active: true,
    is_default: true,
    model: ['storyboard-pro'],
  }
  const fallbackConfig = {
    id: 5,
    service_type: 'image',
    is_active: true,
    is_default: true,
    model: ['gpt-image-2'],
  }
  assert.equal(isConfigForServiceType(exactConfig, 'storyboard_image'), true)
  assert.deepEqual(getSelectableModels([fallbackConfig, exactConfig], 'storyboard_image', null), [
    'storyboard-pro',
  ])
})

test('normalizes a video AI config for option loading', () => {
  assert.deepEqual(getModelsFromAiConfig({
    model: ['grok-video-3', 'grok-video-3-fast'],
    default_model: 'grok-video-3',
  }), ['grok-video-3', 'grok-video-3-fast'])
  assert.deepEqual(getModelsFromAiConfig({ model: 'grok-video-3\ngrok-video-3-fast' }), [
    'grok-video-3',
    'grok-video-3-fast',
  ])
})
