import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildUniversalPromptFieldOverrides,
  buildCanvasPhotographyPrompt,
  getAdjacentStoryboards,
  getDramaGenerationOptions,
  getStoryboardImageFrameType,
  getStoryboardGridFrameType,
  getStoryboardImageModel,
  getStoryboardVideoModel,
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

test('分镜视频模型覆盖项目默认模型', () => {
  assert.equal(
    getStoryboardVideoModel({ video_model: 'storyboard-video' }, { videoModel: 'project-video' }),
    'storyboard-video',
  )
  assert.equal(
    getStoryboardVideoModel({ video_model: '  ' }, { videoModel: 'project-video' }),
    'project-video',
  )
})

test('分镜图模型与宫格版式覆盖项目默认设置', () => {
  assert.equal(
    getStoryboardImageModel({ image_model: 'storyboard-image' }, { imageModel: 'project-image' }),
    'storyboard-image',
  )
  assert.equal(
    getStoryboardImageModel({ image_model: '  ' }, { imageModel: 'project-image' }),
    'project-image',
  )
  assert.equal(getStoryboardGridFrameType({ grid_frame_type: 'nine_grid' }), 'nine_grid')
  assert.equal(getStoryboardGridFrameType({ grid_frame_type: 'single' }), undefined)
  assert.equal(getStoryboardGridFrameType({}), undefined)
})

test('画布工作流按分镜编号提供相邻镜头', () => {
  const episode = {
    storyboards: [
      { id: 3, storyboard_number: 3, title: '第三镜' },
      { id: 1, storyboard_number: 1, title: '第一镜' },
      { id: 2, storyboard_number: 2, title: '第二镜' },
    ],
  }

  assert.deepEqual(getAdjacentStoryboards(episode, 2), {
    previous: { id: 1, storyboard_number: 1, title: '第一镜' },
    next: { id: 3, storyboard_number: 3, title: '第三镜' },
  })
  assert.deepEqual(getAdjacentStoryboards(episode, 1), {
    previous: null,
    next: { id: 2, storyboard_number: 2, title: '第二镜' },
  })
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

test('画布摄影参数会追加到生图提示词且不重复追加', () => {
  const storyboard = {
    angle_h: 'front_left',
    angle_v: 'high',
    angle_s: 'medium',
    lighting_style: 'golden_hour',
  }
  const prompt = buildCanvasPhotographyPrompt('林中人物回头', storyboard)
  assert.match(prompt, /水平机位前左45度/)
  assert.match(prompt, /垂直机位高角度俯拍/)
  assert.match(prompt, /景别中景/)
  assert.match(prompt, /灯光黄金时段光/)
  assert.equal(buildCanvasPhotographyPrompt(prompt, storyboard), prompt)
})
