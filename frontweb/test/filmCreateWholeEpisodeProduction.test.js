import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// 整集出片（R76）：全能参考镜头不再被连贯帧的首帧卡住；KM 同时生成过多时单镜节流、批量遇 429 等待后重提。
// Windows 检出可能是 CRLF，统一成 LF 再按行截取函数。
const source = fs.readFileSync(new URL('../src/views/FilmCreate.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function extractFunction(name) {
  const marker = source.includes(`async function ${name}(`) ? `async function ${name}(` : `function ${name}(`
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `${name} exists`)
  const end = source.indexOf('\n}\n', start)
  return source.slice(start, end + 2)
}

function loadRetryHelper({ creates, polls }) {
  const code = [extractFunction('isKmConcurrencyRejection'), extractFunction('createSbVideoWithKmRetry')].join('\n')
  const calls = { creates: 0, polls: 0, waits: [], infos: [] }
  const videosAPI = { create: async () => { calls.creates += 1; return creates.shift() } }
  const pollTask = async () => { calls.polls += 1; return polls.shift() }
  const setTimeoutStub = (resolve, ms) => { calls.waits.push(ms); resolve() }
  const ElMessage = { info: (text) => calls.infos.push(text) }
  const factory = new Function('videosAPI', 'pollTask', 'loadSingleStoryboardMedia', 'KM_REJECTED_RETRY_DELAY_MS', 'setTimeout', 'ElMessage',
    `${code}\nreturn createSbVideoWithKmRetry`)
  return { run: factory(videosAPI, pollTask, async () => {}, 60_000, setTimeoutStub, ElMessage), calls }
}

const REJECTED = { status: 'failed', error: 'KM 请求被拒绝（HTTP 429），未自动重试' }
const sb = { id: 7, storyboard_number: 3 }

test('全能参考镜头不带首尾帧，连贯帧只让非全能参考镜头串行', () => {
  assert.match(source, /const continuityFirstFrameUrl = useOmni\s+\? ''/)
  assert.match(source, /const \{ first: firstFrameUrl, last: lastFrameUrl \} = useOmni\s+\? \{ first: undefined, last: undefined \}/)
  assert.match(source, /const contiguity = videoFrameContiguity\.value && todo\.some\(\(item\) => !sbUsesOmniReference\(item\)\)/)
  // 连贯帧默认值与经典/首尾帧模式的衔接逻辑不变。
  assert.match(source, /const videoFrameContiguity = ref\(true\)/)
  assert.match(source, /\{ first: continuityFirstFrameUrl \|\| firstLast\.first, last: firstLast\.last \}/)
})

test('KM：单镜本页最多同时 8 个；批量遇 429 重提，最多 2 次、每次等 60 秒', () => {
  assert.match(source, /const KM_MAX_INFLIGHT_VIDEOS = 8/)
  assert.match(source, /const KM_REJECTED_RETRY_DELAY_MS = 60_000/)
  assert.match(source, /const KM_REJECTED_RETRIES = 2/)
  assert.match(source, /isKmVideoModel\(requestContext\.model\) && kmGeneratingVideoCount\(\) >= KM_MAX_INFLIGHT_VIDEOS/)
  assert.match(source, /retries: KM_REJECTED_RETRIES,\s+shouldStop: \(\) => batchVideoStopping\.value/)
  assert.match(source, /'KM 同时生成已满，已被拒绝，未扣费，请稍后再点'/)
  // 批量最终仍被拒绝时不显示后端的"未自动重试"原文，免得和自动重提矛盾。
  assert.match(source, /\? 'KM 同时生成已满，被拒绝（未扣费），请稍后重试'/)
})

test('KM 429 明确拒绝：等待后重提同一镜头，成功即停', async () => {
  const { run, calls } = loadRetryHelper({
    creates: [{ task_id: 't1' }, { task_id: 't2' }],
    polls: [REJECTED, { status: 'completed' }],
  })
  const { res, pollRes } = await run(sb, { prompt: 'x' }, {}, { retries: 2 })
  assert.equal(res.task_id, 't2')
  assert.equal(pollRes.status, 'completed')
  assert.deepEqual([calls.creates, calls.polls, calls.waits], [2, 2, [60_000]])
  assert.deepEqual(calls.infos, ['#3 KM 同时生成已满（未扣费），60 秒后自动重提（第 1/2 次）'])
})

test('KM 429 最多重提 2 次；不重提的情况：retries 为 0、其它失败、已停止', async () => {
  const three = loadRetryHelper({
    creates: [{ task_id: 'a' }, { task_id: 'b' }, { task_id: 'c' }, { task_id: 'd' }],
    polls: [REJECTED, REJECTED, REJECTED, { status: 'completed' }],
  })
  const final = await three.run(sb, {}, {}, { retries: 2 })
  assert.equal(final.pollRes.status, 'failed')
  assert.equal(three.calls.creates, 3, 'one submit plus two retries')
  assert.equal(three.calls.infos.length, 2)

  const fixed = loadRetryHelper({ creates: [{ task_id: 'a' }], polls: [REJECTED] })
  await fixed.run(sb, {}, {}, { retries: 0 })
  assert.equal(fixed.calls.creates, 1)

  const other = loadRetryHelper({ creates: [{ task_id: 'a' }], polls: [{ status: 'failed', error: '内容审核未通过' }] })
  await other.run(sb, {}, {}, { retries: 2 })
  assert.equal(other.calls.creates, 1)

  const stopped = loadRetryHelper({ creates: [{ task_id: 'a' }], polls: [REJECTED] })
  await stopped.run(sb, {}, {}, { retries: 2, shouldStop: () => true })
  assert.deepEqual([stopped.calls.creates, stopped.calls.waits.length, stopped.calls.infos.length], [1, 0, 0])
})
