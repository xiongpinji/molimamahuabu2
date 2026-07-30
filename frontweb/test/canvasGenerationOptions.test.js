import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildUniversalPromptFieldOverrides,
  buildCanvasPhotographyPrompt,
  getAdjacentStoryboards,
  getDramaGenerationOptions,
  getStoryboardImageFrameType,
  getStoryboardGridFrameType,
  getStoryboardAudioModel,
  getStoryboardImageModel,
  getStoryboardVideoModel,
  storyboardIdFromNodeId,
  universalPromptDuration,
} from '../src/utils/canvasWorkflow.js'
import { getSelectableModelsAcrossConfigs } from '../src/utils/modelSelection.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const generationOptionsSource = fs.readFileSync(
  path.join(__dirname, '../src/components/dramaCanvas/CanvasGenerationOptions.vue'),
  'utf8',
)

test('画布生成参数从项目元数据读取模型、画幅和清晰度', () => {
  const options = getDramaGenerationOptions({
    style: '默认风格',
    metadata: JSON.stringify({
      aspect_ratio: '9:16',
      video_resolution: '720p',
      image_model: 'image-model-a',
      video_model: 'video-model-b',
      audio_model: 'tts-model-c',
    }),
  })

  assert.deepEqual(options, {
    aspectRatio: '9:16',
    style: '默认风格',
    videoResolution: '720p',
    imageModel: 'image-model-a',
    videoModel: 'video-model-b',
    audioModel: 'tts-model-c',
  })
})

test('画布首尾帧节点映射到独立图片生成类型', () => {
  assert.equal(getStoryboardImageFrameType('first'), 'storyboard_first')
  assert.equal(getStoryboardImageFrameType('last'), 'storyboard_last')
  assert.equal(getStoryboardImageFrameType(''), undefined)
})

test('画布分镜 ID 可从分镜与媒体节点 ID 提取', () => {
  assert.equal(storyboardIdFromNodeId('sb:301'), 301)
  assert.equal(storyboardIdFromNodeId('sbimg:301'), 301)
  assert.equal(storyboardIdFromNodeId('sbimg-first:301'), 301)
  assert.equal(storyboardIdFromNodeId('sbimg-last:301'), 301)
  assert.equal(storyboardIdFromNodeId('sbvid:301'), 301)
  assert.equal(storyboardIdFromNodeId('sbaud:301:dialogue'), 301)
  assert.equal(storyboardIdFromNodeId('char:1'), null)
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

test('分镜音频模型覆盖项目默认模型', () => {
  assert.equal(
    getStoryboardAudioModel({ audio_model: 'storyboard-tts' }, { audioModel: 'project-tts' }),
    'storyboard-tts',
  )
  assert.equal(
    getStoryboardAudioModel({ audio_model: '  ' }, { audioModel: 'project-tts' }),
    'project-tts',
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

test('画布模型选择包含分镜图片专用配置并保留图片模型兜底', () => {
  assert.match(generationOptionsSource, /aiAPI\.listImageModels\(\)/)
  assert.match(generationOptionsSource, /publicModelNames\(imageConfigs\.value\)/)
  assert.doesNotMatch(generationOptionsSource, /aiAPI\.list\(/)
})

test('画布音频模式加载已配置 TTS 模型并提供模型选择', () => {
  assert.match(generationOptionsSource, /v-if="mode === 'audio' \|\| mode === 'both'"/)
  assert.match(generationOptionsSource, /:model-value="options\.audioModel \|\| ''"/)
  assert.match(generationOptionsSource, /@change="update\('audioModel', \$event\)"/)
  assert.match(generationOptionsSource, /aiAPI\.listAudioModels\(\)/)
  assert.match(generationOptionsSource, /publicModelNames\(audioConfigs\.value\)/)
})

test('画布音频模型合并所有启用 TTS 配置并去重', () => {
  assert.deepEqual(
    getSelectableModelsAcrossConfigs([
      { service_type: 'tts', is_active: true, model: ['tts-a', 'shared'] },
      { service_type: 'tts', is_active: true, model: ['tts-b', 'shared'] },
      { service_type: 'tts', is_active: false, model: ['tts-disabled'] },
      { service_type: 'video', is_active: true, model: ['video-a'] },
    ], 'tts'),
    ['tts-a', 'shared', 'tts-b'],
  )
})

test('视频生成参数组件提供 5 到 15 秒的单镜时长选择', () => {
  assert.match(generationOptionsSource, /class="duration-select"/)
  assert.match(generationOptionsSource, /Number\(options\.videoDuration \|\| 5\)/)
  assert.match(generationOptionsSource, /@change="update\('videoDuration', \$event\)"/)
  assert.match(generationOptionsSource, /v-for="duration in VIDEO_DURATION_OPTIONS"/)
  assert.match(generationOptionsSource, /:value="duration"/)
  assert.match(generationOptionsSource, /import \{ VIDEO_DURATION_OPTIONS \} from '@\/utils\/videoDuration'/)
})

test('生成参数组件显式区分音频模式，避免暴露不适用的视频配置', () => {
  assert.match(generationOptionsSource, /v-if="mode === 'image' \|\| mode === 'both'"/)
  assert.match(generationOptionsSource, /v-if="mode === 'video' \|\| mode === 'both'"/)
  assert.match(generationOptionsSource, /v-if="!modelsOnly && mode !== 'audio'"/)
  assert.match(generationOptionsSource, /v-if="!modelsOnly && \(mode === 'video' \|\| mode === 'both'\)"/)
  assert.match(generationOptionsSource, /v-else-if="!modelsOnly && mode === 'audio'"/)
})
