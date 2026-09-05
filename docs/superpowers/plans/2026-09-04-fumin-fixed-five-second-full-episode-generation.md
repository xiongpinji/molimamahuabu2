# Fumin 固定 5 秒整集转绘实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 24 镜、68,733ms 的锁定整集生产包确定性派生为 28 个固定 5 秒 Fumin 生成单元，并在本地完成防重复状态、逐单元有声验收、精确裁剪和整集统一合成。

**架构：** 保留现有父镜头生产包为业务真相，新增 Fumin 专用纯规划器生成不可变执行单元。通用运行器增加可选的 provider execution-plan 钩子并按 `unit_id` 持久化供应商生命周期；Fumin 媒体管线负责 5 秒动作参考、原始结果验收、裁剪规范化和按父镜头/整集合成。模型、Key 和线上配置均不进入包或计划。

**技术栈：** Node.js ESM、Node test runner、ffmpeg/ffprobe、SHA-256、现有 Fumin v3 adapter、JSON 原子状态文件。

---

## 文件结构

- 创建 `frontweb/scripts/fuminEpisodeExecutionPlan.mjs`：纯函数生成、校验和哈希 28 个固定 5 秒执行单元。
- 创建 `frontweb/scripts/fuminEpisodeExecutionPlan.test.mjs`：锁定拆分点、对白重定位、引用绑定和 fail-closed 行为。
- 创建 `frontweb/scripts/fuminExecutionMotion.mjs`：为每个执行单元构造 5 秒去身份、无音轨动作参考。
- 创建 `frontweb/scripts/fuminExecutionMotion.test.mjs`：锁定 ffmpeg 参数和 probe 验收。
- 创建 `frontweb/scripts/fuminEpisodeMediaPipeline.mjs`：原始 5 秒结果验收、裁剪规范化、父镜头及整集合成。
- 创建 `frontweb/scripts/fuminEpisodeMediaPipeline.test.mjs`：使用本地媒体夹具验证时长、音轨和合成顺序。
- 修改 `frontweb/scripts/run-redraw-episode-blueprint-live.mjs`：支持可选 execution plan、`unit-id` 和顺序执行，保持旧 provider 的 shot 行为兼容。
- 修改 `frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs`：覆盖 28 单元状态、零重复提交和失败即停。
- 修改 `frontweb/scripts/fuminEpisodeProviderAdapter.mjs`：固定 5 秒、所有单元有音轨、调用媒体管线。
- 修改 `frontweb/scripts/fuminEpisodeProviderAdapter.test.mjs`：验证请求合同、静默单元和本地 finalize/assemble 委托。
- 修改 `frontweb/scripts/run-redraw-fumin-full-episode-live.mjs`：装配 Fumin 规划、动作和媒体实现。
- 修改 `frontweb/scripts/run-redraw-fumin-full-episode-live.test.mjs`：锁定 CLI 委托且不导入固定九镜 fixture。
- 修改 `docs/verification/platform-stability/feature-lock-manifest.json` 与 `backend-node/test/featureLockManifest.test.js`：登记新路径、测试、证据和新鲜批准。
- 修改 `deploy/release-scopes/redraw-episode-blueprint-first-redraw-20260903.json` 与 `backend-node/test/incrementalReleaseScope.test.js`：将精确发布范围由 57 个路径扩展为 66 个路径。
- 创建 `docs/verification/redraw/fumin-fixed-five-second-full-episode-verification.md`：记录红绿测试、零提交 r5 预检和哈希。

### 任务 1：实现固定 5 秒执行单元规划器

**文件：**
- 创建：`frontweb/scripts/fuminEpisodeExecutionPlan.mjs`
- 创建：`frontweb/scripts/fuminEpisodeExecutionPlan.test.mjs`

- [ ] **步骤 1：编写 24 镜派生 28 单元的失败测试**

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFuminEpisodeExecutionPlan } from './fuminEpisodeExecutionPlan.mjs'

test('24 locked shots become 28 fixed-five-second units without timeline loss', () => {
  const durations = [1200, 2433, 7134, 866, 2200, 1567, 967, 1066, 1800, 7367, 7700, 933,
    734, 733, 933, 4134, 4966, 7967, 3633, 2234, 1266, 1734, 1400, 3766]
  let cursor = 0
  const production_packs = durations.map((duration, index) => {
    const start = cursor
    cursor += duration
    return {
      shot_id: `shot-${String(index + 1).padStart(2, '0')}`,
      start_ms: start,
      end_ms: cursor,
      duration_ms: duration,
      production_pack_hash: String(index + 1).padStart(64, '0'),
      characters: [], dialogue: [], prompt: `Shot ${index + 1}`,
    }
  })
  const plan = buildFuminEpisodeExecutionPlan({ production_packs, identity_references: [], motion_references: [] })
  assert.equal(plan.units.length, 28)
  assert.ok(plan.units.every((unit) => unit.provider_duration_seconds === 5))
  assert.equal(plan.units.reduce((sum, unit) => sum + unit.keep_duration_ms, 0), 68_733)
})
```

- [ ] **步骤 2：运行测试确认红灯**

运行：`cd frontweb && node --test scripts/fuminEpisodeExecutionPlan.test.mjs`

预期：FAIL，`ERR_MODULE_NOT_FOUND`。

- [ ] **步骤 3：补充安全拆分和对白重定位测试**

```js
test('moves a split away from dialogue and rebases complete turns', () => {
  const pack = makePack({
    shot_id: 'shot-03', start_ms: 3633, end_ms: 10767,
    dialogue: [
      { id: 'a', start_ms: 6330, end_ms: 7670, text: 'That is Lucas.' },
      { id: 'b', start_ms: 7670, end_ms: 9390, text: 'It is just rejection.' },
    ],
  })
  const plan = buildFuminEpisodeExecutionPlan(makePackage([pack]))
  assert.deepEqual(plan.units.map((unit) => unit.keep_duration_ms), [4037, 3097])
  assert.equal(plan.units[1].dialogue[0].start_ms, 0)
})

test('fails before provider work when no non-splitting boundary exists', () => {
  const pack = makePack({
    shot_id: 'shot-long', start_ms: 0, end_ms: 8000,
    dialogue: [{ id: 'a', start_ms: 1000, end_ms: 7000, text: 'One continuous line.' }],
  })
  assert.throws(
    () => buildFuminEpisodeExecutionPlan(makePackage([pack])),
    /FUMIN_EXECUTION_DIALOGUE_SPLIT_UNSAFE/,
  )
})
```

同一测试文件先定义以下完整辅助函数，避免依赖仓库外 fixture：

```js
function makePack({ shot_id, start_ms, end_ms, dialogue = [] }) {
  return {
    shot_id, start_ms, end_ms, duration_ms: end_ms - start_ms,
    production_pack_hash: 'a'.repeat(64), characters: [], dialogue,
    visual_contract: {}, audio_contract: { locale: 'en-US' }, prompt: `Shot ${shot_id}`,
  }
}

function makePackage(production_packs) {
  return { production_packs, identity_references: [], motion_references: [] }
}
```

- [ ] **步骤 4：实现最小纯规划器**

```js
export const FUMIN_PROVIDER_DURATION_SECONDS = 5

export function buildFuminEpisodeExecutionPlan(pkg) {
  const units = pkg.production_packs.flatMap((pack) => splitPack(pack).map((window, index, parts) => ({
    schema_version: 'fumin-episode-execution-unit-v1',
    unit_id: `${pack.shot_id}.part-${String(index + 1).padStart(2, '0')}`,
    parent_shot_id: pack.shot_id,
    part_index: index + 1,
    part_count: parts.length,
    source_start_ms: window.start_ms,
    source_end_ms: window.end_ms,
    keep_duration_ms: window.end_ms - window.start_ms,
    provider_duration_seconds: FUMIN_PROVIDER_DURATION_SECONDS,
    parent_production_pack_hash: pack.production_pack_hash,
    dialogue: rebaseDialogue(pack.dialogue, window.start_ms, window.end_ms),
    identity_reference_ids: identityIdsForPack(pkg.identity_references, pack),
    motion_reference_id: motionIdForPack(pkg.motion_references, pack),
    prompt: buildExecutionUnitPrompt(pack, window),
  })))
  const plan = { schema_version: 'redraw-provider-execution-plan-v1', provider: 'fumin', units }
  plan.execution_plan_hash = executionPlanHash(plan)
  return plan
}
```

拆分边界必须位于 `[shotDuration-5000, 5000]`，优先 5000，其次选择距离 5000 最近且不落在任何对白开区间内的对白起止点；找不到即抛出 `FUMIN_EXECUTION_DIALOGUE_SPLIT_UNSAFE`。执行单元提示词必须移除父提示词原 `Dialogue:` 行并只写入本单元对白。

- [ ] **步骤 5：运行测试验证通过并提交**

运行：`cd frontweb && node --test scripts/fuminEpisodeExecutionPlan.test.mjs`

预期：全部 PASS，当前固定夹具为 28 单元、总保留时长 68,733ms。

```powershell
git add -- frontweb/scripts/fuminEpisodeExecutionPlan.mjs frontweb/scripts/fuminEpisodeExecutionPlan.test.mjs
git commit -m "feat(转绘): 规划固定五秒生成单元"
```

### 任务 2：生成每单元 5 秒动作参考

**文件：**
- 创建：`frontweb/scripts/fuminExecutionMotion.mjs`
- 创建：`frontweb/scripts/fuminExecutionMotion.test.mjs`

- [ ] **步骤 1：编写 ffmpeg 参数和 probe 红灯测试**

```js
test('slices the unit window and pads only the reference to five seconds', () => {
  const args = buildFuminExecutionMotionArgs({
    sourcePath: 'shot.mp4', outputPath: 'unit.mp4', offsetMs: 4037,
    keepDurationMs: 3097, providerDurationSeconds: 5,
  })
  assert.deepEqual(args.slice(0, 6), ['-y', '-ss', '4.037', '-i', 'shot.mp4', '-an'])
  assert.ok(args.includes('tpad=stop_mode=clone:stop_duration=1.903'))
  assert.equal(args.at(-1), 'unit.mp4')
})

test('rejects reference output with audio or non-five-second duration', () => {
  assert.throws(() => validateFuminExecutionMotionProbe({ duration_seconds: 3.1, has_audio: false }),
    /FUMIN_EXECUTION_MOTION_DURATION_INVALID/)
  assert.throws(() => validateFuminExecutionMotionProbe({ duration_seconds: 5, has_audio: true }),
    /FUMIN_EXECUTION_MOTION_AUDIO_PRESENT/)
})
```

- [ ] **步骤 2：运行测试确认红灯**

运行：`cd frontweb && node --test scripts/fuminExecutionMotion.test.mjs`

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现参数构造与严格验证**

```js
export function validateFuminExecutionMotionProbe(probe) {
  if (Math.abs(Number(probe.duration_seconds) - 5) > 0.1) fail('FUMIN_EXECUTION_MOTION_DURATION_INVALID')
  if (probe.has_audio) fail('FUMIN_EXECUTION_MOTION_AUDIO_PRESENT')
  if (Number(probe.width) <= 0 || Number(probe.height) <= 0) fail('FUMIN_EXECUTION_MOTION_VIDEO_INVALID')
  return probe
}
```

ffmpeg 输出固定 H.264、`yuv420p`、24fps、无音轨；不足部分仅用 `tpad=stop_mode=clone` 补参考时长。写入前拒绝目标已存在，写入后立即 ffprobe 并记录 SHA-256。

- [ ] **步骤 4：运行测试和本地真实 ffmpeg 夹具**

运行：`cd frontweb && node --test scripts/fuminExecutionMotion.test.mjs`

预期：全部 PASS；真实夹具探测为约 5 秒、无音轨。

- [ ] **步骤 5：提交**

```powershell
git add -- frontweb/scripts/fuminExecutionMotion.mjs frontweb/scripts/fuminExecutionMotion.test.mjs
git commit -m "feat(转绘): 物化五秒动作参考"
```

### 任务 3：让运行器按执行单元持久化并顺序停止

**文件：**
- 修改：`frontweb/scripts/run-redraw-episode-blueprint-live.mjs:7-503`
- 修改：`frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs`

- [ ] **步骤 1：编写 preflight 执行计划绑定红灯测试**

```js
test('preflight persists an immutable provider execution plan with zero provider calls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-execution-plan-'))
  try {
    const { packagePath } = makeEpisodePackage(root)
    const stateDir = path.join(root, 'state')
    const calls = { upload: 0, submit: 0 }
    const provider = {
      name: 'planned-provider',
      async prepareEpisode({ package: pkg }) {
        return makeDefaultExecutionPlan(pkg.production_packs)
      },
      async uploadReference() { calls.upload += 1 },
      async submitGeneration() { calls.submit += 1 },
    }
    const options = parseArgs(['--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight'])
    const result = await runStage(options, { provider, now: () => new Date('2026-09-04T00:00:00Z') })
    assert.equal(result.execution_units.length, 1)
    assert.match(result.execution_plan_hash, /^[a-f0-9]{64}$/)
    assert.deepEqual(calls, { upload: 0, submit: 0 })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
```

- [ ] **步骤 2：编写顺序执行与未知停止红灯测试**

```js
test('sequence stops at the first unknown unit and never submits a later unit', async () => {
  const fixedNow = () => new Date('2026-09-04T00:00:00Z')
  const { options, provider, submitted, readState } = await makeThreeUnitSequenceCase({
    unknownUnitId: 'shot-03.part-02',
  })
  await assert.rejects(() => runStage(options, { provider, now: fixedNow }), /STATUS_UNKNOWN/)
  assert.deepEqual(submitted, ['shot-03.part-01', 'shot-03.part-02'])
  assert.equal(readState().tasks.at(-1).status, 'needs_attention')
})
```

`makeDefaultExecutionPlan` 与 `makeThreeUnitSequenceCase` 写在该测试文件中：前者为现有 `makeEpisodePackage` 生成单元和 canonical SHA-256；后者在临时目录完成 preflight，并提供三个单元的注入 provider，其中 `submitGeneration` 只向 `submitted` 追加当前 `unit_id`，目标单元抛出带 `code='FUMIN_EPISODE_STATUS_UNKNOWN'` 的错误。

- [ ] **步骤 3：运行测试确认红灯**

运行：`cd frontweb && node --test scripts/run-redraw-episode-blueprint-live.test.mjs`

预期：FAIL，manifest 尚无 `execution_units`，且 `sequence`/`unit-id` 尚不受支持。

- [ ] **步骤 4：实现可选 execution-plan 生命周期**

```js
async function prepareExecution(provider, pkg, stateDir, mode) {
  if (typeof provider.prepareEpisode !== 'function') return defaultShotExecution(pkg)
  const plan = await provider.prepareEpisode({ package: clone(pkg), state_dir: stateDir, mode })
  assertExecutionPlan(plan, pkg)
  return plan
}

async function runSequence(options, adapters) {
  const manifest = readManifest(options.stateDir)
  for (const unit of manifest.execution_units) {
    const existing = manifest.tasks.find((task) => task.unit_id === unit.unit_id)
    if (existing?.status === 'completed_verified') continue
    if (existing) fail('REDRAW_EPISODE_UNIT_ALREADY_SUBMITTED', unit.unit_id)
    await runExecutionUnit({ ...options, unitId: unit.unit_id }, adapters)
  }
  return readManifest(options.stateDir)
}
```

新增 CLI flag `--unit-id` 和 stage `sequence`。任务必须在第一次上传前以 `reference_upload_started` 落盘；任务键由 `unit_id + unit_hash` 组成。任何已有非完成状态均禁止再次提交。旧 provider 没有 `prepareEpisode` 时继续产生每父镜头一个默认单元，保持现有测试兼容。

`runExecutionUnit` 先把下载文件记录为 `raw_artifact` 并完成供应商原始结果验收；若 provider 实现 `finalizeArtifact`，再生成并记录带独立哈希的裁剪规范化 `artifact`。`runAssemble` 在 execution-plan 模式下按 `execution_units` 顺序读取最终 artifact，并把不可变 execution plan 传给 provider；旧 provider 仍按父镜头 artifact 合成。

- [ ] **步骤 5：运行运行器测试并提交**

运行：`cd frontweb && node --test scripts/run-redraw-episode-blueprint-live.test.mjs`

预期：原测试与新增测试全部 PASS。

```powershell
git add -- frontweb/scripts/run-redraw-episode-blueprint-live.mjs frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs
git commit -m "feat(转绘): 按生成单元持久化整集状态"
```

### 任务 4：固定 Fumin 请求合同并验收原始 5 秒结果

**文件：**
- 修改：`frontweb/scripts/fuminEpisodeProviderAdapter.mjs:219-353`
- 修改：`frontweb/scripts/fuminEpisodeProviderAdapter.test.mjs`

- [ ] **步骤 1：编写请求合同红灯测试**

```js
test('every execution unit submits exactly five seconds with audio', async () => {
  let body
  const adapter = createFuminEpisodeProviderAdapter({
    apiKey: 'test',
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body)
      return { ok: true, text: async () => JSON.stringify({ id: 'task-1' }) }
    },
  })
  await adapter.submitGeneration({
    pack: { unit_id: 'shot-21.part-01', keep_duration_ms: 1266, provider_duration_seconds: 5,
      prompt: 'Ambient room tone only.', dialogue: [], audio_contract: { locale: 'en-US', speech_required: false } },
    uploaded_references: [],
  })
  assert.deepEqual(
    { duration: body.duration, resolution: body.resolution, aspect_ratio: body.aspect_ratio, generate_audio: body.generate_audio },
    { duration: 5, resolution: '480p', aspect_ratio: '9:16', generate_audio: true },
  )
})
```

- [ ] **步骤 2：编写原始结果与静默单元红灯测试**

```js
test('raw unit output must be about five seconds and always have audio', async () => {
  const unit = { unit_id: 'shot-01.part-01', provider_duration_seconds: 5 }
  assert.throws(() => validateGeneratedMediaForUnit(unit, { duration_seconds: 3.8, has_audio: true }),
    /FUMIN_EPISODE_OUTPUT_DURATION_INVALID/)
  assert.throws(() => validateGeneratedMediaForUnit(unit, { duration_seconds: 5, has_audio: false }),
    /FUMIN_EPISODE_OUTPUT_AUDIO_MISSING/)
})

test('silent unit accepts ambient audio but rejects recognized speech', () => {
  const unit = { dialogue: [], audio_contract: { locale: 'en-US', speech_required: false } }
  const transcripts = [
    { model_id: 'Systran/faster-whisper-base', language: 'en', probability: 0.99, text: 'hello' },
    { model_id: 'Systran/faster-whisper-small', language: 'en', probability: 0.99, text: 'hello' },
  ]
  assert.throws(() => verifyTranscriptConsensusForUnit(unit, transcripts),
    /FUMIN_EPISODE_UNAPPROVED_DIALOGUE/)
})
```

- [ ] **步骤 3：运行测试确认红灯**

运行：`cd frontweb && node --test scripts/fuminEpisodeProviderAdapter.test.mjs`

预期：FAIL，当前请求从父镜头时长四舍五入，静默镜头还会关闭音频。

- [ ] **步骤 4：实现固定合同**

```js
const body = {
  model: FUMIN_MODEL,
  prompt: buildPrompt(pack),
  duration: 5,
  resolution: '480p',
  aspect_ratio: '9:16',
  generate_audio: true,
  references: uploaded_references.map(toProviderReference),
}
```

原始文件验收以 `provider_duration_seconds` 为预期，不再以 `keep_duration_ms` 或父镜头时长为预期。双 ASR 对有对白单元验证目标英文和全部批准台词；无对白单元只允许环境声。

adapter 同时公开 `prepareEpisode({ package, state_dir, mode })`：`materialize` 模式调用任务 1 的规划器和任务 2 的动作参考生成器；`verify` 模式只重新计算计划、复核 28 个动作文件哈希且不覆盖文件。两个模式返回相同 `execution_plan_hash`。`finalizeArtifact` 和 `assembleEpisode` 在任务 5 接入媒体管线。

- [ ] **步骤 5：运行测试并提交**

运行：`cd frontweb && node --test scripts/fuminEpisodeProviderAdapter.test.mjs`

预期：全部 PASS，捕获的每次生成请求均为 5 秒、480p、9:16、有声。

```powershell
git add -- frontweb/scripts/fuminEpisodeProviderAdapter.mjs frontweb/scripts/fuminEpisodeProviderAdapter.test.mjs
git commit -m "fix(转绘): 固定 Fumin 五秒有声合同"
```

### 任务 5：裁剪规范化并完成父镜头与整集合成

**文件：**
- 创建：`frontweb/scripts/fuminEpisodeMediaPipeline.mjs`
- 创建：`frontweb/scripts/fuminEpisodeMediaPipeline.test.mjs`
- 修改：`frontweb/scripts/fuminEpisodeProviderAdapter.mjs:334-382`
- 修改：`frontweb/scripts/fuminEpisodeProviderAdapter.test.mjs`

- [ ] **步骤 1：编写裁剪和统一流参数红灯测试**

```js
test('normalizes a verified raw unit to its exact keep duration', () => {
  const args = buildNormalizeUnitArgs({
    inputPath: 'raw.mp4', outputPath: 'unit.mp4', keepDurationMs: 1266,
  })
  assert.ok(args.includes('1.266'))
  assert.ok(args.includes('scale=480:864'))
  assert.ok(args.includes('libx264'))
  assert.ok(args.includes('aac'))
})
```

- [ ] **步骤 2：编写 28 单元到 24 镜再到整集的媒体测试**

测试用 ffmpeg 生成 28 个 5 秒、有音轨的彩色夹具，调用 `finalizeEpisodeMedia` 后断言：

```js
assert.equal(result.parent_shots.length, 24)
assert.ok(Math.abs(result.episode.media.duration_seconds - 68.733) <= 0.15)
assert.equal(result.episode.media.width, 480)
assert.equal(result.episode.media.height, 864)
assert.equal(result.episode.media.has_audio, true)
assert.match(result.episode.sha256, /^[a-f0-9]{64}$/)
```

- [ ] **步骤 3：运行测试确认红灯**

运行：`cd frontweb && node --test scripts/fuminEpisodeMediaPipeline.test.mjs`

预期：FAIL，媒体管线模块不存在。

- [ ] **步骤 4：实现本地媒体管线**

```js
export async function finalizeEpisodeMedia({ units, rawArtifacts, outputRoot, ffmpegPath, ffprobePath }) {
  const normalizedUnits = units.map((unit) => normalizeUnit({ unit, raw: rawArtifacts.get(unit.unit_id), outputRoot, ffmpegPath, ffprobePath }))
  const parentShots = groupByParent(units).map((group) => concatNormalized(group, outputRoot, ffmpegPath, ffprobePath))
  const episode = concatNormalized(parentShots, outputRoot, ffmpegPath, ffprobePath)
  assertEpisodeMedia(episode.media, 68_733)
  return { normalized_units: normalizedUnits, parent_shots: parentShots, episode }
}
```

规范化固定为 H.264/yuv420p/24fps/480x864 与 AAC/48kHz/stereo。只有规范化后的文件才能使用 concat demuxer；每一步写出后立即 probe 和 SHA-256，已有目标文件时拒绝覆盖。

- [ ] **步骤 5：运行媒体与 adapter 测试并提交**

运行：`cd frontweb && node --test scripts/fuminEpisodeMediaPipeline.test.mjs scripts/fuminEpisodeProviderAdapter.test.mjs`

预期：全部 PASS，真实本地夹具最终时长偏差不超过 150ms 且全片有音轨。

```powershell
git add -- frontweb/scripts/fuminEpisodeMediaPipeline.mjs frontweb/scripts/fuminEpisodeMediaPipeline.test.mjs frontweb/scripts/fuminEpisodeProviderAdapter.mjs frontweb/scripts/fuminEpisodeProviderAdapter.test.mjs
git commit -m "feat(转绘): 精确裁剪并合成有声整集"
```

### 任务 6：装配 Fumin CLI 并完成零网络端到端测试

**文件：**
- 修改：`frontweb/scripts/run-redraw-fumin-full-episode-live.mjs:1-20`
- 修改：`frontweb/scripts/run-redraw-fumin-full-episode-live.test.mjs`

- [ ] **步骤 1：编写装配红灯测试**

```js
test('Fumin wrapper installs planner, motion materializer and media pipeline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-fumin-planned-wrapper-'))
  try {
    const packagePath = makePackage(root)
    const stateDir = path.join(root, 'state')
    const result = await main([
      '--episode-package', packagePath, '--state-dir', stateDir, '--stage', 'preflight',
    ], { now: () => new Date('2026-09-04T00:00:00Z') })
    assert.equal(result.execution_units.length, 1)
    assert.equal(result.execution_units[0].provider_duration_seconds, 5)
    assert.equal(result.tasks.length, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
```

- [ ] **步骤 2：编写 28 单元顺序执行假供应商测试**

假供应商为每个单元返回本地 5 秒有声夹具。运行 `preflight -> sequence -> assemble -> verify`，断言生成 POST 计数为 28、每个确定性键仅一次、最终时长 68.733 秒。再令第 9 单元返回 unknown，断言 POST 计数停在 9 且后续为 0。

- [ ] **步骤 3：运行测试确认红灯**

运行：`cd frontweb && node --test scripts/run-redraw-fumin-full-episode-live.test.mjs`

预期：FAIL，wrapper 尚未装配 execution plan。

- [ ] **步骤 4：实现最小装配**

```js
export async function main(argv = process.argv.slice(2), adapters = {}) {
  const runner = await import('./run-redraw-episode-blueprint-live.mjs')
  const provider = adapters.provider || createFuminEpisodeProviderAdapter({
    ...adapters,
    buildExecutionPlan: buildFuminEpisodeExecutionPlan,
    materializeMotion: materializeFuminExecutionMotion,
    finalizeEpisodeMedia,
  })
  return runner.main(argv, { providerName: 'fumin', provider, ...adapters })
}
```

- [ ] **步骤 5：运行 Fumin 脚本测试并提交**

运行：

```powershell
cd frontweb
node --test scripts/fuminEpisodeExecutionPlan.test.mjs scripts/fuminExecutionMotion.test.mjs scripts/fuminEpisodeMediaPipeline.test.mjs scripts/fuminEpisodeProviderAdapter.test.mjs scripts/run-redraw-episode-blueprint-live.test.mjs scripts/run-redraw-fumin-full-episode-live.test.mjs
```

预期：全部 PASS；测试 fetch 全为注入假实现，外网调用为 0。

```powershell
git add -- frontweb/scripts/run-redraw-fumin-full-episode-live.mjs frontweb/scripts/run-redraw-fumin-full-episode-live.test.mjs
git commit -m "feat(转绘): 装配固定五秒整集执行器"
```

### 任务 7：更新功能锁、精确发布范围和验证证据

**文件：**
- 修改：`docs/verification/platform-stability/feature-lock-manifest.json`
- 修改：`backend-node/test/featureLockManifest.test.js`
- 修改：`deploy/release-scopes/redraw-episode-blueprint-first-redraw-20260903.json`
- 修改：`backend-node/test/incrementalReleaseScope.test.js`
- 创建：`docs/verification/redraw/fumin-fixed-five-second-full-episode-verification.md`

- [ ] **步骤 1：先扩展锁与范围断言并确认红灯**

`redraw.episode-blueprint-first` 必须新增三个保护路径、三个 required tests 和三份证据路径；范围必须在原 57 条基础上精确新增以下 9 条并保持字典序：

```text
docs/superpowers/plans/2026-09-04-fumin-fixed-five-second-full-episode-generation.md
docs/superpowers/specs/2026-09-04-fumin-fixed-five-second-full-episode-generation-design.md
docs/verification/redraw/fumin-fixed-five-second-full-episode-verification.md
frontweb/scripts/fuminEpisodeExecutionPlan.mjs
frontweb/scripts/fuminEpisodeExecutionPlan.test.mjs
frontweb/scripts/fuminEpisodeMediaPipeline.mjs
frontweb/scripts/fuminEpisodeMediaPipeline.test.mjs
frontweb/scripts/fuminExecutionMotion.mjs
frontweb/scripts/fuminExecutionMotion.test.mjs
```

运行：`cd backend-node && node --test test/featureLockManifest.test.js test/incrementalReleaseScope.test.js`

预期：FAIL，清单尚缺新增路径与新鲜 unlock。

- [ ] **步骤 2：写入新鲜批准并保留历史**

当前 `unlock` 追加到 `unlockHistory`，新 `unlock` 固定为：

```json
{
  "reason": "2026-09-04 Fumin 固定五秒整集执行方案 A 书面规格获批",
  "approvedBy": "product-owner 2026-09-04 fumin-fixed-five-second-full-episode-option-a",
  "impactTests": [
    "frontweb/scripts/fuminEpisodeExecutionPlan.test.mjs",
    "frontweb/scripts/fuminExecutionMotion.test.mjs",
    "frontweb/scripts/fuminEpisodeMediaPipeline.test.mjs",
    "frontweb/scripts/run-redraw-episode-blueprint-live.test.mjs",
    "frontweb/scripts/fuminEpisodeProviderAdapter.test.mjs",
    "frontweb/scripts/run-redraw-fumin-full-episode-live.test.mjs",
    "backend-node/test/featureLockManifest.test.js",
    "backend-node/test/incrementalReleaseScope.test.js"
  ]
}
```

- [ ] **步骤 3：补写验证报告的已执行证据**

报告仅记录实际运行命令、起止时间、退出码、测试计数、HEAD、r5 包/计划/状态/媒体哈希和 provider 计数；未运行项目不得写成通过。不得写 Key、Authorization header、资产 URL 或本地 Key 文件内容。

- [ ] **步骤 4：运行锁与范围门禁**

运行：

```powershell
cd backend-node
node --test test/featureLockManifest.test.js test/incrementalReleaseScope.test.js
node scripts/verify-feature-lock-manifest.js --base origin/main
```

预期：测试全部 PASS；审计输出 `"ready":true`。

- [ ] **步骤 5：提交**

```powershell
git add -- docs/verification/platform-stability/feature-lock-manifest.json backend-node/test/featureLockManifest.test.js deploy/release-scopes/redraw-episode-blueprint-first-redraw-20260903.json backend-node/test/incrementalReleaseScope.test.js docs/verification/redraw/fumin-fixed-five-second-full-episode-verification.md
git commit -m "test(转绘): 锁定固定五秒整集验收"
```

### 任务 8：制作全新 r5 零提交候选并做最终审计

**文件：**
- 本地隔离产物：`C:/Users/canqu/Documents/茉莉妈妈2/.codex-staging/episode-blueprint-fumin-readiness-20260904-r5/`
- 更新：`docs/verification/redraw/fumin-fixed-five-second-full-episode-verification.md`

- [ ] **步骤 1：运行受影响回归**

运行：

```powershell
cd frontweb
node --test scripts/fuminEpisodeExecutionPlan.test.mjs scripts/fuminExecutionMotion.test.mjs scripts/fuminEpisodeMediaPipeline.test.mjs scripts/fuminEpisodeProviderAdapter.test.mjs scripts/run-redraw-episode-blueprint-live.test.mjs scripts/run-redraw-fumin-full-episode-live.test.mjs
cd ../backend-node
node --test test/redrawShotProductionPack.test.js test/redrawLocalization.test.js test/featureLockManifest.test.js test/incrementalReleaseScope.test.js
```

预期：0 fail、0 cancelled；不得把此前独立长测未终止的 11 个用例写入通过总数。

- [ ] **步骤 2：制作 r5 自包含零提交包**

从 r4 复制 8 张身份图和 24 段父镜头动作参考，使用当前 HEAD 重新计算本地化/生产包绑定，再生成 28 段固定 5 秒执行动作参考与 `redraw-provider-execution-plan-v1`。输出目录必须不存在；不得修改或复用 r1-r4。

- [ ] **步骤 3：运行产品 preflight**

运行：

```powershell
cd frontweb
node scripts/run-redraw-fumin-full-episode-live.mjs `
  --episode-package "C:\Users\canqu\Documents\茉莉妈妈2\.codex-staging\episode-blueprint-fumin-readiness-20260904-r5\package\episode-package.json" `
  --state-dir "C:\Users\canqu\Documents\茉莉妈妈2\.codex-staging\episode-blueprint-fumin-readiness-20260904-r5\state" `
  --stage preflight
```

预期：`status=preflight_passed`、`execution_units=28`、`tasks=0`、所有 `provider_duration_seconds=5`、总 `keep_duration_ms=68733`、provider GET/POST/upload/billed 均为 0。

- [ ] **步骤 4：执行哈希、语言与边界审计**

验证：包、计划、28 段动作、8 张身份、24 个父生产包、状态清单均与记录 SHA-256 一致；提示词 CJK 计数 0、`Chinese` 计数 0、原人物名/Mateo 计数 0；工作树中无 Key 或凭证；未修改模型信息。

- [ ] **步骤 5：完成最终本地回归**

运行：

```powershell
cd frontweb
node --test scripts/*.test.mjs test/*.test.js
cd ../backend-node
npm test
```

预期：全部可执行测试 0 fail。若任何测试失败或进程无终态，保留日志、停止并如实报告，不继续真实付费阶段。

- [ ] **步骤 6：更新报告并提交精确文件**

```powershell
git add -- docs/verification/redraw/fumin-fixed-five-second-full-episode-verification.md
git diff --cached --check
git commit -m "docs(转绘): 记录固定五秒零提交验收"
```

- [ ] **步骤 7：申请独立真实付费授权**

只有以上全部通过后，向用户申请基于最终精确 HEAD 与 r5 状态目录顺序执行最多 28 次生成 POST 的授权。授权必须允许上传所需身份和动作参考，并明确任一失败或未知立即停止且不重试；未获得该授权前保持 0 供应商调用。
