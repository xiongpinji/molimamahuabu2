import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/views/FilmCreate.vue', import.meta.url), 'utf8')

test('每个已生成的分镜视频下方提供一键提取尾帧入口', () => {
  const videoResult = source.indexOf('<div v-if="getSbVideo(sb.id)" class="sb-video-area">')
  const action = source.indexOf('class="sb-tail-frame-action"', videoResult)
  const historyStrip = source.indexOf('class="sb-videos-strip"', videoResult)

  assert.ok(videoResult >= 0, '应存在分镜视频结果区域')
  assert.ok(action > videoResult, '尾帧按钮应位于视频结果之后')
  assert.ok(action < historyStrip, '尾帧按钮应紧邻视频结果并位于历史视频之前')
  assert.match(source, /class="sb-tail-frame-action"[\s\S]*@click="onLinkTailFrameToNext\(sb\)"[\s\S]*一键提取尾帧/)
  assert.doesNotMatch(source, /v-if="getNextStoryboard\(sb\.id\)" content="提取本视频尾帧/)
})

test('一键提取成功后立即同步并刷新下一分镜首帧', () => {
  const start = source.indexOf('async function onLinkTailFrameToNext')
  const end = source.indexOf('/** 上镜尾帧', start)
  const handler = source.slice(start, end)

  assert.match(handler, /storyboardsAPI\.linkTailFrame\(sb\.id, \{ drama_id: dramaId\.value, video_id: video\.id \}\)/)
  assert.doesNotMatch(handler, /ElMessageBox\.confirm/)
  assert.match(handler, /nextSb\.first_frame_image_id = data\.new_first_frame_image_id/)
  assert.match(handler, /nextSb\.image_url = data\.image_url \|\| null/)
  assert.match(handler, /nextSb\.local_path = data\.local_path \|\| null/)
  assert.match(handler, /sbSelectedImgId\.value = \{ \.\.\.sbSelectedImgId\.value, \[nextSb\.id\]: data\.new_first_frame_image_id \}/)
  assert.match(handler, /await loadSingleStoryboardMedia\(nextSb\.id\)/)
  assert.match(handler, /已是最后一个分镜，没有下一个分镜可衔接/)
})

test('媒体列表刷新失败时仍使用分镜本地路径展示已提取的首帧', () => {
  const start = source.indexOf('function getSbFirstImage')
  const end = source.indexOf('/** 尾帧图', start)
  const getter = source.slice(start, end)

  assert.match(getter, /if \(sb\?\.image_url \|\| sb\?\.local_path\)/)
  assert.match(getter, /local_path: sb\.local_path/)
})
