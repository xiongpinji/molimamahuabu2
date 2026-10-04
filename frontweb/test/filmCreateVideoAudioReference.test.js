import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/views/FilmCreate.vue', import.meta.url), 'utf8')

test('短剧工厂视频请求：原生音频默认开启，仅在模型声明 supportsAudio 时提交', () => {
  assert.match(source, /const videoNativeAudio = ref\(true\)/)
  assert.match(source, /videoNativeAudio\.value = d\.metadata\?\.video_native_audio !== false/)
  assert.match(source, /generateAudio: capability\.supportsAudio === true \? videoNativeAudio\.value === true : undefined/)
  assert.match(source, /video_native_audio: !!videoNativeAudio\.value/)
  assert.match(source, /模型原生音频/)
})

test('短剧工厂视频请求：分镜参考原片需项目开关 + 全能参考 + 模型支持参考视频', () => {
  assert.match(source, /const videoUseStoryboardReferenceVideo = ref\(false\)/)
  assert.match(source, /videoUseStoryboardReferenceVideo\.value && useOmni\s+&& capability\.supportsVideoReference === true/)
  assert.match(source, /collectStoryboardReferenceUrls\(sb\?\.reference_video_urls\)/)
  assert.match(source, /video_use_storyboard_reference_video: !!videoUseStoryboardReferenceVideo\.value/)
})

test('短剧工厂视频请求：短分镜按模型最短档位提交', () => {
  assert.match(source, /const duration = submittableVideoDuration\(getSbVideoDurationForApi\(sb\), entry\.capabilities\)/)
})
