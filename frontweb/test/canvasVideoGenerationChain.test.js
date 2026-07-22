import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const runnerSource = readFileSync(
  resolve(__dirname, '../src/composables/useCanvasWorkflowRunner.js'),
  'utf8'
)
const canvasSource = readFileSync(
  resolve(__dirname, '../src/views/DramaCanvas.vue'),
  'utf8'
)
const storyboardPanelSource = readFileSync(
  resolve(__dirname, '../src/components/dramaCanvas/CanvasStoryboardPanel.vue'),
  'utf8'
)

test('画布视频节点把模型、首尾帧和素材引用传给视频创建接口', () => {
  assert.match(runnerSource, /export\s+async\s+function\s+runVideoStep\(drama, sb, genOpts, options = \{\}\)/)
  assert.match(runnerSource, /hydrateStoryboardSettings\(sb\)/)
  assert.match(runnerSource, /sbVideoFirstLastUrls\(sb,\s*imagesBySbId,\s*useFirstLast\)/)
  assert.match(runnerSource, /collectStoryboardReferenceAssets\(drama,\s*sb\)/)
  assert.match(runnerSource, /appendVoicePromptToVideoPrompt\(\{/)
  assert.match(runnerSource, /classifyVideoVoicePolicy\(\{ model \}\)/)
  assert.match(runnerSource, /const voicePolicy = genOpts\.voicePolicy \|\| classifyVideoVoicePolicy\(\{ model \}\)/)
  assert.match(runnerSource, /buildVoicePromptPreview\(\{[\s\S]*policy: voicePolicy,[\s\S]*characters: voiceCharacters/)
  assert.match(runnerSource, /storyboardVoiceCharacters\(drama,\s*sb\)/)
  assert.match(runnerSource, /buildStoryboardContinuityPrompt\(\{/)
  assert.match(runnerSource, /fetchAssignedAssetUrls\(sb\.id\)/)
  assert.match(runnerSource, /function upstreamReferenceUrls\(genOpts = \{\}\)/)
  assert.match(runnerSource, /\.\.\.upstreamReferenceUrls\(genOpts\),[\s\S]*absoluteLast/)
  assert.match(runnerSource, /getStoryboardVideoModel\(sb,\s*genOpts\)/)
  assert.match(runnerSource, /buildVideoGenerationRequest\(\{[\s\S]*model,[\s\S]*firstFrameUrl:\s*absoluteFirst/)
  assert.match(runnerSource, /buildVideoGenerationRequest\(\{[\s\S]*lastFrameUrl:\s*absoluteLast/)
  assert.match(runnerSource, /buildVideoGenerationRequest\(\{[\s\S]*referenceImageUrls:\s*referenceUrls/)
  assert.match(runnerSource, /buildVideoGenerationRequest\(\{[\s\S]*resolution:\s*genOpts\.videoResolution/)
  assert.match(runnerSource, /const requestAudit = buildVideoGenerationAudit\(\{[\s\S]*payload,[\s\S]*voicePolicy,[\s\S]*voicePrompt: voicePromptPreview/)
  assert.match(runnerSource, /videosAPI\.create\(payload\)/)
})

test('画布真实模型链路把 task_id 和轮询状态暴露给节点队列', () => {
  assert.match(runnerSource, /options\.onPoll\?\.\(t\)/)
  assert.match(runnerSource, /options\.onTask\?\.\(\{ taskId: res\.task_id, step: 'image', response: res \}\)/)
  assert.match(runnerSource, /pollTaskSimple\(res\.task_id, options\)/)
  assert.match(runnerSource, /options\.onTask\?\.\(\{ taskId: res\.task_id, step: 'video', response: res \}\)/)
  assert.match(runnerSource, /return \{[\s\S]*taskId: res\.task_id,[\s\S]*requestPayload: payload,[\s\S]*requestAudit,[\s\S]*task: polled/)
  assert.match(canvasSource, /else if \(step === 'video'\) operationResult = await runVideoStep/)
})

test('画布音频节点把同步提取结果写入节点成功结果', () => {
  assert.match(runnerSource, /const res = await request\.post\('\/audio\/extract', \{[\s\S]*tts_kind: 'dialogue'/)
  assert.match(runnerSource, /resultUrl: res\?\.url \|\| ''/)
  assert.match(runnerSource, /resultLocalPath: res\?\.local_path \|\| ''/)
  assert.match(runnerSource, /resultType: 'audio'/)
  assert.match(canvasSource, /const res = await runAudioStep\(latestSb\)[\s\S]*operationResult = res/)
})

test('分镜面板直接生视频补传画布媒体映射给首尾帧链路', () => {
  assert.match(storyboardPanelSource, /imagesBySbId:\s*ctx\?\.imagesBySbId\?\.value \|\| \{\}/)
  assert.match(storyboardPanelSource, /videosBySbId:\s*ctx\?\.videosBySbId\?\.value \|\| \{\}/)
  assert.match(storyboardPanelSource, /else if \(step === 'video'\) \{[\s\S]*runVideoStep\(drama, sb, \{[\s\S]*\.\.\.genOpts,[\s\S]*videoModel: videoModel\.value \|\| genOpts\.videoModel/)
})

test('画布节点重试支持真实尾帧衔接且未知步骤不误报成功', () => {
  assert.match(canvasSource, /import \{ storyboardsAPI \} from '@\/api\/storyboards'/)
  assert.match(canvasSource, /import \{ canChainStoryboardFrames \} from '@\/utils\/videoContinuity'/)
  assert.match(canvasSource, /function nodeStepStatusLabel\(step, node\)[\s\S]*if \(step === 'link_tail_frame'\) return '尾帧衔接中…'/)
  assert.match(canvasSource, /async function linkStoryboardTailFrameFromNode\(storyboard\)/)
  assert.match(canvasSource, /getAdjacentStoryboards\(found\?\.episode, current\.id\)/)
  assert.match(canvasSource, /canChainStoryboardFrames\(next, current\)/)
  assert.match(canvasSource, /storyboardsAPI\.linkTailFrame\(current\.id, \{ drama_id: drama\.value\.id \}\)/)
  assert.match(canvasSource, /else if \(step === 'link_tail_frame'\) operationResult = await linkStoryboardTailFrameFromNode\(latestSb\)/)
  assert.match(canvasSource, /else throw new Error\(`暂不支持该节点步骤：\$\{step\}`\)/)
})
