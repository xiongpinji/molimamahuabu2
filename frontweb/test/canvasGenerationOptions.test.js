import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildUniversalPromptFieldOverrides,
  getDramaGenerationOptions,
  getStoryboardImageFrameType,
  universalPromptDuration,
} from '../src/utils/canvasWorkflow.js'

test('画布生成参数从项目元数据读取模型、画幅和清晰度', () => {
  const options = getDramaGenerationOptions({
    style: '默认风格',
    metadata: JSON.stringify({
      aspect_ratio: '9:16',
      video_resolution: '720p',
      image_model: 'image-model-a',
      video_model: 'video-model-b',
    }),
  })

  assert.deepEqual(options, {
    aspectRatio: '9:16',
    style: '默认风格',
    videoResolution: '720p',
    imageModel: 'image-model-a',
    videoModel: 'video-model-b',
  })
})

test('画布首尾帧节点映射到独立图片生成类型', () => {
  assert.equal(getStoryboardImageFrameType('first'), 'storyboard_first')
  assert.equal(getStoryboardImageFrameType('last'), 'storyboard_last')
  assert.equal(getStoryboardImageFrameType(''), undefined)
})

test('全能词流式请求使用分镜时长和结构化字段覆盖', () => {
  const payload = {
    duration: universalPromptDuration({ duration: '8' }),
    field_overrides: buildUniversalPromptFieldOverrides({
      title: '雨夜追车',
      action: '角色冲向车门',
      dialogue: '快上车',
    }),
  }

  assert.equal(payload.duration, 8)
  assert.deepEqual(payload.field_overrides, {
    title: '雨夜追车',
    description: '',
    location: '',
    time: '',
    action: '角色冲向车门',
    dialogue: '快上车',
    narration: '',
    result: '',
    atmosphere: '',
    shot_type: '',
    movement: '',
    layout_description: '',
  })
  assert.equal(universalPromptDuration({ duration: 0 }), 5)
})
