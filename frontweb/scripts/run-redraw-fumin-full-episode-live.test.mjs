import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { redrawLatinAmericanCase } from '../e2e/fixtures/redraw-latin-american-case.js'
import {
  assertPaidReferenceGate,
  assertFinalizeReady,
  beginSubmissionAttempt,
  buildConcatList,
  buildShotPrompt,
  createInitialManifest,
  parseSuccessfulSubmission,
  publicEvidence,
  validateRuntimeIdentityReference,
} from './run-redraw-fumin-full-episode-live.mjs'

const contract = {
  expectedShots: 9,
  maxPaidSubmits: 9,
  spendCapUsd: 25,
  estimatedPerShotUsd: 2.384848,
  estimatedTotalUsd: 21.463632,
  initialBalanceUsd: 79.29,
  accountId: 'xiongpinji',
}

const approvedIdentityPacks = redrawLatinAmericanCase.cast.map((actor, index) => ({
  schema_version: 'target-actor-identity-v1',
  source_character_key: actor.id,
  target_actor_label: actor.target_name,
  artifact: {
    artifact_id: `${actor.id}-v1.png`,
    sha256: String(index + 1).padStart(64, '0'),
    width: 1536,
    height: 1024,
    mime_type: 'image/png',
  },
  confirmed_views: ['front', 'profile', 'full_body'],
  live_action_human_confirmed: true,
  adult_status: 'verified_18_plus',
  identity_consistency_confirmed: true,
  persona_origin: 'fictional_ai_generated',
  target_country: 'US',
  ready: true,
  pack_sha256: String(index + 6).padStart(64, '0'),
  review_status: 'approved',
}))

function motionSegments({ sanitized = true } = {}) {
  return redrawLatinAmericanCase.sourceFacts.shots.map((shot, index) => ({
    shot_number: index + 1,
    shot_id: shot.id,
    sha256: String(index + 1).padStart(64, '0'),
    duration_seconds: 8,
    has_audio: false,
    conditioning_mode: sanitized ? 'character_neutral_motion' : 'raw_source_clip',
    visual_sanitization: sanitized ? {
      schema_version: 'redraw-motion-visual-sanitization-v1',
      privacy_transform_scope: 'full_frame',
      source_identity_obscured: true,
      source_text_obscured: true,
      review_status: 'approved',
      evidence_sha256: 'f'.repeat(64),
    } : null,
  }))
}

test('英文镜头提示词锁定演员姓名、目标语言和逐句对白', () => {
  const prompt = buildShotPrompt(redrawLatinAmericanCase, 1)
  assert.match(prompt, /Mateo/)
  assert.match(prompt, /Diego/)
  assert.match(prompt, /Lucas/)
  assert.match(prompt, /American English only/)
  for (const line of redrawLatinAmericanCase.localization.dialogue[0].turns) {
    assert.match(prompt, new RegExp(line.localized_text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.doesNotMatch(prompt, /不是哥们/)
})

test('对白提及 Mateo 时锁定三音节英文发音且不污染其他镜头', () => {
  const prompt = buildShotPrompt(redrawLatinAmericanCase, 1)
  assert.match(prompt, /Mateo must be spoken as three distinct syllables: mah-TEH-oh/i)
  assert.match(prompt, /final "oh" fully audible/i)

  const unrelatedPrompt = buildShotPrompt(redrawLatinAmericanCase, 5)
  assert.doesNotMatch(unrelatedPrompt, /mah-TEH-oh/i)
})

test('英文对白提示词传递逐句时间窗并禁止为赶时长截断词尾', () => {
  const prompt = buildShotPrompt(redrawLatinAmericanCase, 1)
  assert.match(prompt, /Generate synchronized en-US speech audio for the approved dialogue timing only\./i)
  assert.match(prompt, /2\. Diego: "Mateo, you think acting crazy is funny\?" \(1250-3500ms\)/i)
  assert.match(prompt, /3\. Lucas: "Mateo, are you okay\?" \(5500-6750ms\)/i)
  assert.match(prompt, /Do not compress, clip, or drop any word or final vowel to fit the timing\./i)
})

test('第 5 镜锁定句首 I 并约束体育电视画面为无品牌不可读内容', () => {
  const prompt = buildShotPrompt(redrawLatinAmericanCase, 5)
  assert.match(prompt, /first audible word must be "I"/i)
  assert.match(prompt, /television must show only generic, unbranded, unreadable sports imagery/i)
  assert.match(prompt, /no scoreboard, broadcast graphics, readable text, brand, or logo/i)

  const adjacentPrompt = buildShotPrompt(redrawLatinAmericanCase, 4)
  assert.doesNotMatch(adjacentPrompt, /television must show only generic/i)
})

test('英文所有格撇号与 ASR 连写结果应视为同一句对白', async () => {
  const runner = await import('./run-redraw-fumin-full-episode-live.mjs')
  assert.equal(typeof runner.verifyTranscript, 'function')
  const result = runner.verifyTranscript(redrawLatinAmericanCase, 6, {
    language: 'en',
    probability: 1,
    text: 'College kids home wash your hands and eat in this life',
  })

  assert.equal(result.exact_dialogue_present, true)
})

function asr(modelId, text, { language = 'en', probability = 1 } = {}) {
  return { model_id: modelId, language, probability, text }
}

const smallAsr = 'Systran/faster-whisper-small'
const baseAsr = 'Systran/faster-whisper-base'

test('双 ASR 在一个精确匹配且另一个仅有 capital/capitol 拼写差异时通过', async () => {
  const runner = await import('./run-redraw-fumin-full-episode-live.mjs')
  assert.equal(typeof runner.verifyTranscriptConsensus, 'function')
  const result = runner.verifyTranscriptConsensus(redrawLatinAmericanCase, 4, [
    asr(smallAsr, 'This place will be demolished in two months but he has no capitol right now'),
    asr(baseAsr, 'This place will be demolished in two months but he has no capital right now'),
  ])

  assert.equal(result.consensus_passed, true)
  assert.equal(result.exact_model_id, baseAsr)
  assert.ok(result.models[0].word_error_rate <= 0.1)
  assert.ok(result.models[0].character_error_rate <= 0.03)
  assert.deepEqual(result.critical_tokens, ['two', 'no'])
})

test('即使包含目标句，双 ASR 识别到大量额外对白时仍拒绝', async () => {
  const runner = await import('./run-redraw-fumin-full-episode-live.mjs')
  assert.throws(() => runner.verifyTranscriptConsensus(redrawLatinAmericanCase, 5, [
    asr(smallAsr, 'I think seed this box I have my first seed money'),
    asr(baseAsr, 'I have been seeded this month I have my first seed money'),
  ]), /FUMIN_FULL_EPISODE_ASR_CONSENSUS_DISTANCE_FAILED/)
})

test('双 ASR 不允许次级结果截断 Mateo 角色名', async () => {
  const runner = await import('./run-redraw-fumin-full-episode-live.mjs')
  assert.equal(typeof runner.verifyTranscriptConsensus, 'function')
  assert.throws(() => runner.verifyTranscriptConsensus(redrawLatinAmericanCase, 1, [
    asr(smallAsr, 'Who are you Mateo you think acting crazy is funny Mate are you okay Thats Diego'),
    asr(baseAsr, 'Who are you Mateo you think acting crazy is funny Mateo are you okay Thats Diego'),
  ]), /FUMIN_FULL_EPISODE_CRITICAL_TOKEN_FAILED/)
})

test('双 ASR 不允许次级结果遗漏数字或否定词', async () => {
  const runner = await import('./run-redraw-fumin-full-episode-live.mjs')
  assert.equal(typeof runner.verifyTranscriptConsensus, 'function')
  const exact = asr(baseAsr, 'This place will be demolished in two months but he has no capital right now')
  assert.throws(() => runner.verifyTranscriptConsensus(redrawLatinAmericanCase, 4, [
    asr(smallAsr, 'This place will be demolished in months but he has no capital right now'),
    exact,
  ]), /FUMIN_FULL_EPISODE_CRITICAL_TOKEN_FAILED/)
  assert.throws(() => runner.verifyTranscriptConsensus(redrawLatinAmericanCase, 4, [
    asr(smallAsr, 'This place will be demolished in two months but he has capital right now'),
    exact,
  ]), /FUMIN_FULL_EPISODE_CRITICAL_TOKEN_FAILED/)
})

test('双 ASR 任一模型缺失、错误语言或双方均不精确时关闭门禁', async () => {
  const runner = await import('./run-redraw-fumin-full-episode-live.mjs')
  assert.equal(typeof runner.verifyTranscriptConsensus, 'function')
  const exact = 'This place will be demolished in two months but he has no capital right now'
  assert.throws(() => runner.verifyTranscriptConsensus(redrawLatinAmericanCase, 4, [
    asr(smallAsr, exact),
  ]), /FUMIN_FULL_EPISODE_ASR_CONSENSUS_UNAVAILABLE/)
  assert.throws(() => runner.verifyTranscriptConsensus(redrawLatinAmericanCase, 4, [
    asr(smallAsr, exact, { language: 'zh' }),
    asr(baseAsr, exact),
  ]), /FUMIN_FULL_EPISODE_TARGET_LANGUAGE_FAILED/)
  assert.throws(() => runner.verifyTranscriptConsensus(redrawLatinAmericanCase, 4, [
    asr(smallAsr, exact.replace('capital', 'capitol')),
    asr(baseAsr, exact.replace('capital', 'capitol')),
  ]), /FUMIN_FULL_EPISODE_EXACT_DIALOGUE_FAILED/)
})

test('ASR 必须自动检测语言而不是强制按英语解码', () => {
  const source = fs.readFileSync(new URL('./run-redraw-fumin-full-episode-live.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\.transcribe\(sys\.argv\[1\],language="en"/)
})

test('静默镜头任一固定 ASR 识别出对白都失败', async () => {
  const runner = await import('./run-redraw-fumin-full-episode-live.mjs')
  assert.equal(typeof runner.verifyTranscriptConsensus, 'function')
  assert.throws(() => runner.verifyTranscriptConsensus(redrawLatinAmericanCase, 3, [
    asr(smallAsr, ''),
    asr(baseAsr, 'hello'),
  ]), /FUMIN_FULL_EPISODE_SILENT_SHOT_HAS_SPEECH/)
})

test('静默镜明确要求有环境声但禁止任何可理解语音', () => {
  for (const shotNumber of [3, 8]) {
    const prompt = buildShotPrompt(redrawLatinAmericanCase, shotNumber)
    assert.match(prompt, /natural synchronized ambience and sound effects/i)
    assert.match(prompt, /no spoken dialogue, voiceover, narration, singing, or intelligible vocalization/i)
  }
})

test('初始 manifest 固化九镜、9:16、480p、有声与素材哈希', () => {
  const manifest = createInitialManifest({
    contract,
    sourcePath: 'C:/private/source.mp4',
    sourceSha256: redrawLatinAmericanCase.source.sha256,
    identityPacks: approvedIdentityPacks,
    motionSegments: motionSegments(),
  })
  assert.equal(manifest.contract.spendCapUsd, 25)
  assert.equal(manifest.generation.aspect_ratio, '9:16')
  assert.equal(manifest.generation.resolution, '480p')
  assert.equal(manifest.generation.generate_audio, true)
  assert.equal(manifest.motion_segments.length, 9)
  assert.ok(manifest.motion_segments.every((item) => item.has_audio === false))
  assert.equal(manifest.reference_gate.status, 'approved')
  assert.deepEqual(manifest.reference_gate.identities.map((item) => item.source_character_key), [
    'mateo', 'diego', 'lucas', 'elena', 'rafael',
  ])
  assert.ok(manifest.motion_segments.every((item) => (
    item.conditioning_mode === 'character_neutral_motion'
      && item.visual_sanitization.privacy_transform_scope === 'full_frame'
      && item.visual_sanitization.source_identity_obscured === true
      && item.visual_sanitization.source_text_obscured === true
  )))
  assert.equal(manifest.tasks.length, 0)
  assert.doesNotMatch(JSON.stringify(manifest), /source_path|identity_path|"path"|"url"/)
})

test('选角示意图不能冒充正式角色身份包', () => {
  assert.throws(() => createInitialManifest({
    contract,
    sourcePath: 'C:/private/source.mp4',
    sourceSha256: redrawLatinAmericanCase.source.sha256,
    identityPacks: [redrawLatinAmericanCase.castingReference],
    motionSegments: motionSegments(),
  }), /FUMIN_FULL_EPISODE_PRODUCTION_IDENTITY_PACK_REQUIRED/)
})

test('含原人物或原文字的原片裁剪不能作为付费动作参考', () => {
  assert.throws(() => createInitialManifest({
    contract,
    sourcePath: 'C:/private/source.mp4',
    sourceSha256: redrawLatinAmericanCase.source.sha256,
    identityPacks: approvedIdentityPacks,
    motionSegments: motionSegments({ sanitized: false }),
  }), /FUMIN_FULL_EPISODE_MOTION_VISUAL_SANITIZATION_REQUIRED/)
})

test('机器生成的净化标记必须经人工批准后才能进入付费门禁', () => {
  const segments = motionSegments()
  segments[0].visual_sanitization.review_status = 'pending'
  assert.throws(() => createInitialManifest({
    contract,
    sourcePath: 'C:/private/source.mp4',
    sourceSha256: redrawLatinAmericanCase.source.sha256,
    identityPacks: approvedIdentityPacks,
    motionSegments: segments,
  }), /FUMIN_FULL_EPISODE_MOTION_VISUAL_SANITIZATION_REQUIRED/)
})

test('shot 阶段再次校验参考包门禁，旧 manifest 不得上传或付费', () => {
  assert.throws(() => assertPaidReferenceGate({
    schema_version: 'redraw-fumin-full-episode-paid-private-v1',
    reference_gate: null,
  }), /FUMIN_FULL_EPISODE_REFERENCE_GATE_NOT_APPROVED/)
  const ready = createInitialManifest({
    contract,
    sourcePath: 'C:/private/source.mp4',
    sourceSha256: redrawLatinAmericanCase.source.sha256,
    identityPacks: approvedIdentityPacks,
    motionSegments: motionSegments(),
  })
  assert.equal(assertPaidReferenceGate(ready), true)
})

test('提交锁只能创建一次且不会允许同镜重提', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-paid-lock-'))
  try {
    const first = beginSubmissionAttempt(root, 1)
    assert.equal(first.shot_number, 1)
    assert.equal(first.scope, 'reference_upload_and_paid_submission')
    assert.equal(first.external_actions_locked_before_network, true)
    assert.throws(() => beginSubmissionAttempt(root, 1), /FUMIN_FULL_EPISODE_SHOT_LOCK_EXISTS/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('公开证据移除 Key、授权头、路径和签名 URL', () => {
  const safe = publicEvidence({
    api_key: 'secret',
    authorization: 'Bearer secret',
    source_path: 'C:/private/source.mp4',
    identity_url: 'https://signed.example/x?token=secret',
    nested: { output_url: 'https://signed.example/y?sig=secret', sha256: 'abc' },
  })
  assert.deepEqual(safe, { nested: { sha256: 'abc' } })
})

test('复用身份 URL 前必须绑定当前 asset、图片哈希和身份包哈希', () => {
  const pack = approvedIdentityPacks[0]
  const manifestReference = {
    asset_id: 'asset-mateo',
    sha256: pack.artifact.sha256,
    bytes: 123,
  }
  const runtimeReference = {
    url: 'https://example.test/mateo.png',
    asset_id: 'asset-mateo',
    sha256: pack.artifact.sha256,
    pack_sha256: pack.pack_sha256,
  }
  assert.equal(
    validateRuntimeIdentityReference(runtimeReference, manifestReference, pack),
    runtimeReference.url,
  )
  assert.throws(
    () => validateRuntimeIdentityReference(
      { ...runtimeReference, pack_sha256: 'f'.repeat(64) },
      manifestReference,
      pack,
    ),
    /FUMIN_FULL_EPISODE_IDENTITY_RUNTIME_BINDING_MISMATCH/,
  )
})

test('finalize 只接受九镜全部 completed_verified', () => {
  const manifest = {
    contract,
    tasks: Array.from({ length: 9 }, (_, index) => ({
      shot_number: index + 1,
      status: 'completed_verified',
    })),
  }
  assert.equal(assertFinalizeReady(manifest), true)
  manifest.tasks[4].status = 'awaiting_human_review'
  assert.throws(() => assertFinalizeReady(manifest), /FUMIN_FULL_EPISODE_NOT_READY/)
})

test('2xx 非 JSON 或缺少任务身份统一视为提交结果未知', () => {
  for (const payload of [null, {}, { data: {} }]) {
    assert.throws(
      () => parseSuccessfulSubmission(payload),
      /FUMIN_FULL_EPISODE_SUBMISSION_UNKNOWN/,
    )
  }
  assert.deepEqual(parseSuccessfulSubmission({ id: 'task-1', status: 'queued' }), {
    task_id: 'task-1',
    status: 'queued',
  })
})

test('已知任务的一次瞬时 GET 失败只重查同一任务且不会重新提交', async () => {
  const runner = await import('./run-redraw-fumin-full-episode-live.mjs')
  assert.equal(typeof runner.pollGeneration, 'function')
  const calls = []
  const videoUrl = await runner.pollGeneration('test-key', 'task-known', {
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET' })
      if (calls.length === 1) throw new Error('transient socket reset')
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          status: 'succeeded',
          content: { video_url: 'https://assets.example.test/result.mp4' },
        }),
      }
    },
    sleep: async () => {},
    now: () => 0,
  })

  assert.equal(videoUrl, 'https://assets.example.test/result.mp4')
  assert.deepEqual(calls, [
    {
      url: 'https://fumin.ai/api/v3/contents/generations/tasks/task-known',
      method: 'GET',
    },
    {
      url: 'https://fumin.ai/api/v3/contents/generations/tasks/task-known',
      method: 'GET',
    },
  ])
})

test('已知任务连续两次 GET 失败仍按结果未知关闭', async () => {
  const runner = await import('./run-redraw-fumin-full-episode-live.mjs')
  assert.equal(typeof runner.pollGeneration, 'function')
  let calls = 0
  await assert.rejects(
    runner.pollGeneration('test-key', 'task-known', {
      fetchImpl: async () => {
        calls += 1
        throw new Error(`network failure ${calls}`)
      },
      sleep: async () => {},
      now: () => 0,
    }),
    /FUMIN_FULL_EPISODE_STATUS_UNKNOWN/,
  )
  assert.equal(calls, 2)
})

test('Windows 合并清单使用绝对正斜杠路径并安全转义单引号', () => {
  const list = buildConcatList(["C:\\episode files\\shot-01.mp4", "C:\\episode files\\shot'02.mp4"])
  assert.match(list, /file 'C:\/episode files\/shot-01\.mp4'/)
  assert.match(list, /shot'\\''02\.mp4/)
  assert.doesNotMatch(list, /\\episode files\\/)
})

test('derive 参数解析固定源、目标、验证器绝对路径和小写 manifest SHA', async () => {
  const runner = await import('./run-redraw-fumin-full-episode-live.mjs')
  assert.equal(typeof runner.parseArgs, 'function')
  const options = runner.parseArgs([
    '--stage', 'derive',
    '--source-state', './source-r4',
    '--state-root', './target-r5',
    '--expected-source-manifest-sha256', 'A'.repeat(64),
    '--verifier-python', './offline-python.exe',
  ])

  assert.equal(options.stage, 'derive')
  assert.equal(options.sourceState, path.resolve('./source-r4'))
  assert.equal(options.stateRoot, path.resolve('./target-r5'))
  assert.equal(options.verifierPython, path.resolve('./offline-python.exe'))
  assert.equal(options.expectedSourceManifestSha256, 'a'.repeat(64))
})
