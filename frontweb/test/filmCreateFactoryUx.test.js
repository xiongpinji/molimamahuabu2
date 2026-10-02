import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// 工厂体验改进（R85）：连贯帧按项目记住选择；KM 全能参考缺素材时不提交并说明；单镜遇 KM 429 自动重提；
// 合成按分镜时长裁剪的项目换视频模型不改写分镜时长。
// Windows 检出可能是 CRLF，统一成 LF 再按行截取函数。
const source = fs.readFileSync(new URL('../src/views/FilmCreate.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function extractFunction(name) {
  const marker = source.includes(`async function ${name}(`) ? `async function ${name}(` : `function ${name}(`
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `${name} exists`)
  const end = source.indexOf('\n}\n', start)
  return source.slice(start, end + 2)
}

test('连贯帧：勾选即保存到项目；没存过时普通项目默认开启、样片转绘导入的项目默认关闭', () => {
  assert.match(source, /<el-checkbox v-model="videoFrameContiguity" size="small" @change="saveProjectSettings\(\)">/)
  assert.match(source, /video_frame_contiguity: !!videoFrameContiguity\.value,/)
  assert.match(source, /const videoFrameContiguity = ref\(true\)/)
  const found = source.match(/const savedFrameContiguity = (.+)\n\s+videoFrameContiguity\.value = (.+)\n/)
  assert.ok(found, 'loadDrama restores the saved choice')
  const decide = new Function('d', `const savedFrameContiguity = ${found[1]}\nreturn ${found[2]}`)
  assert.equal(decide({ metadata: {} }), true, 'ordinary project keeps the old default')
  assert.equal(decide({}), true)
  assert.equal(decide({ metadata: { redraw_import: { work_id: 6 } } }), false, 'redraw import defaults off')
  assert.equal(decide({ metadata: { redraw_import: { work_id: 6 }, video_frame_contiguity: true } }), true, 'saved choice wins')
  assert.equal(decide({ metadata: { video_frame_contiguity: false } }), false)
})

function loadModelChange({ metadata, storyboards }) {
  const calls = { updates: [], saves: 0, warnings: 0 }
  const store = { drama: { metadata }, storyboards }
  const sbDuration = { value: {} }
  const factory = new Function('syncVideoSelectionForModel', 'selectedVideoModel', 'store', 'videoDurationOptionsForModel',
    'sbDuration', 'sbVideoModel', 'storyboardsAPI', 'saveProjectSettings', 'ElMessage',
    `${extractFunction('onVideoModelChange')}\nreturn onVideoModelChange`)
  const run = factory(() => {}, { value: 'km-mini' }, store, () => [4, 5, 6, 8, 10, 15], sbDuration, { value: {} },
    { update: async (id, body) => { calls.updates.push([id, body.duration]) } },
    async () => { calls.saves += 1 }, { warning: () => { calls.warnings += 1 } })
  return { run, calls, sbDuration, storyboards }
}

test('换视频模型：合成按分镜时长裁剪的项目保留原片节奏的分镜时长；其它项目照旧校正到模型档位', async () => {
  const kept = loadModelChange({
    metadata: { merge_trim_to_storyboard_duration: true },
    storyboards: [{ id: 1, duration: 2 }, { id: 2, duration: 3 }],
  })
  await kept.run()
  assert.deepEqual(kept.calls.updates, [], 'storyboard durations are not rewritten')
  assert.deepEqual(kept.storyboards.map((sb) => sb.duration), [2, 3])
  assert.equal(kept.calls.saves, 1, 'the chosen model is still saved')

  const ordinary = loadModelChange({ metadata: {}, storyboards: [{ id: 1, duration: 2 }, { id: 2, duration: 5 }] })
  await ordinary.run()
  assert.deepEqual(ordinary.calls.updates, [[1, 4]], 'original factory behaviour for other projects')
  assert.deepEqual(ordinary.sbDuration.value, { 1: 4 })
  assert.equal(ordinary.calls.saves, 1)
})

test('KM 全能参考：一个参考素材都没有时不提交并说明原因；有分镜参考原片或参考音频也算素材', () => {
  const count = new Function(`${extractFunction('omniReferenceMaterialCount')}\nreturn omniReferenceMaterialCount`)()
  assert.equal(count({}), 0)
  assert.equal(count({ reference_image_urls: [] }), 0)
  assert.equal(count({ reference_audio_urls: ['https://x/a.mp3'] }), 1)
  assert.equal(count({ reference_image_urls: ['a', 'b'], reference_video_urls: ['v'] }), 3)
  const handler = extractFunction('onGenerateSbVideo')
  // 只有非 KM 模型才弹"按纯文案提交"的确认；KM 要等组好请求后看素材。
  assert.match(handler, /if \(!isKmVideoModel\(getStoryboardVideoModel\(sb\)\)\) \{\s+try \{\s+await ElMessageBox\.confirm\(\s+'当前没有可用的参考图/)
  const check = handler.indexOf('omniReferenceMaterialCount(requestContext.payload) === 0')
  assert.ok(check > 0, 'checks the built request')
  assert.match(handler, /isKmVideoModel\(requestContext\.model\) && requestContext\.universalOmniApi\s+&& omniReferenceMaterialCount\(requestContext\.payload\) === 0/)
  assert.ok(check < handler.indexOf('createSbVideoWithKmRetry('), 'before anything is submitted')
  assert.ok(check < handler.indexOf('generatingSbVideoIds.add(sb.id)'))
  assert.match(handler, /'KM 全能参考缺少参考素材'/)
})

test('单镜生成：KM 明确拒绝（429）时和批量一样等 60 秒重提，最多 2 次', () => {
  const handler = extractFunction('onGenerateSbVideo')
  assert.match(handler, /const \{ res, pollRes \} = await createSbVideoWithKmRetry\(sb, requestContext\.payload, meta, \{\s+retries: KM_REJECTED_RETRIES,\s+\}\)/)
  assert.doesNotMatch(handler, /await videosAPI\.create\(requestContext\.payload\)/, 'no direct submit without the retry helper')
  // 重提用完仍被拒绝时的提示不变。
  assert.match(handler, /'KM 同时生成已满，已被拒绝，未扣费，请稍后再点'/)
})
