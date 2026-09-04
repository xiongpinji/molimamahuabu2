import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

test('Fumin adapter lifecycle uses injected fetch and never reads provider config from package data', async () => {
  const { createFuminEpisodeProviderAdapter } = await import('./fuminEpisodeProviderAdapter.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-adapter-'))
  try {
    const referencePath = path.join(root, 'identity.png')
    fs.writeFileSync(referencePath, 'identity')
    const videoBytes = Buffer.alloc(100_001, 7)
    const calls = []
    const adapter = createFuminEpisodeProviderAdapter({
      apiKey: 'test-key',
      fetchImpl: async (url, options = {}) => {
        calls.push([String(url), options.method || 'GET'])
        if (String(url).includes('/files/uploads')) {
          return { ok: true, text: async () => JSON.stringify({ id: 'asset-1', url: 'https://fumin.test/ref.png' }) }
        }
        if (String(url).includes('/contents/generations/tasks') && options.method === 'POST') {
          assert.doesNotMatch(String(options.body), /evil-model|api_key|base_url/)
          return { ok: true, text: async () => JSON.stringify({ id: 'task-1' }) }
        }
        if (String(url).includes('/contents/generations/tasks/task-1')) {
          return { ok: true, text: async () => JSON.stringify({ status: 'succeeded', output: { video_url: 'https://fumin.test/result.mp4' } }) }
        }
        if (String(url) === 'https://fumin.test/result.mp4') {
          return { ok: true, arrayBuffer: async () => videoBytes }
        }
        throw new Error(`unexpected url ${url}`)
      },
      sleep: async () => {},
      runProcess: () => JSON.stringify({
        streams: [{ codec_type: 'video', width: 480, height: 864, codec_name: 'h264' }, { codec_type: 'audio', channels: 2, codec_name: 'aac' }],
        format: { duration: '5.04' },
      }),
      transcribeConsensus: async () => [
        { model_id: 'Systran/faster-whisper-base', language: 'en', probability: 0.96, text: 'We leave tonight.' },
        { model_id: 'Systran/faster-whisper-small', language: 'en', probability: 0.95, text: 'We leave tonight.' },
      ],
      createContactSheet: () => {},
    })
    const ref = await adapter.uploadReference({
      id: 'lead-main',
      character_id: 'lead',
      path: referencePath,
      sha256: sha256(fs.readFileSync(referencePath)),
      bytes: fs.readFileSync(referencePath),
      mime_type: 'image/png',
    })
    const pack = {
      shot_id: 'shot-1',
      duration_ms: 5000,
      provider_duration_seconds: 5,
      prompt: 'Marcus speaks English.',
      dialogue: [{ speaker_id: 'lead', speaker_name: 'Marcus', text: 'We leave tonight.' }],
      audio_contract: { locale: 'en-US', speech_required: true },
      visual_contract: {},
      provider: { model: 'evil-model', api_key: 'secret', base_url: 'https://evil.test' },
    }
    const submitted = await adapter.submitGeneration({ pack, uploaded_references: [ref] })
    const polled = await adapter.pollGeneration({ task_id: submitted.task_id })
    const outputPath = path.join(root, 'out', 'shot-1.mp4')
    const downloaded = await adapter.downloadResult({ video_url: polled.video_url, output_path: outputPath })
    const inspected = await adapter.inspectArtifact({ output_path: outputPath, pack })

    assert.equal(downloaded.sha256, sha256(videoBytes))
    assert.equal(inspected.language.passed, true)
    assert.equal(inspected.dialogue.exact_dialogue_present, true)
    assert.deepEqual(calls.map((entry) => entry[1]), ['POST', 'POST', 'GET', 'GET'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Fumin transcript consensus enforces target English dialogue and silent shots', async () => {
  const { verifyTranscriptConsensusForPack } = await import('./fuminEpisodeProviderAdapter.mjs')
  const pack = {
    shot_id: 'shot-1',
    dialogue: [{ text: 'We leave tonight.' }],
    audio_contract: { locale: 'en-US', speech_required: true },
  }
  const transcripts = [
    { model_id: 'Systran/faster-whisper-base', language: 'en', probability: 0.99, text: 'We leave tonight.' },
    { model_id: 'Systran/faster-whisper-small', language: 'en', probability: 0.99, text: 'We leave tonight.' },
  ]
  assert.equal(verifyTranscriptConsensusForPack(pack, transcripts).consensus_passed, true)
  assert.throws(
    () => verifyTranscriptConsensusForPack(pack, [{ ...transcripts[0], language: 'zh' }, transcripts[1]]),
    /FUMIN_EPISODE_TARGET_LANGUAGE_FAILED/,
  )
  assert.throws(
    () => verifyTranscriptConsensusForPack({ ...pack, dialogue: [], audio_contract: { speech_required: false } }, transcripts),
    /FUMIN_EPISODE_UNAPPROVED_DIALOGUE/,
  )
})

function plannedUnit(overrides = {}) {
  return {
    schema_version: 'fumin-episode-execution-unit-v1',
    unit_id: 'shot-1.part-01',
    parent_shot_id: 'shot-1',
    part_index: 1,
    part_count: 1,
    source_start_ms: 0,
    source_end_ms: 1200,
    keep_duration_ms: 1200,
    provider_duration_seconds: 5,
    parent_production_pack_hash: 'a'.repeat(64),
    dialogue: [{ text: 'Unit line.', start_ms: 0, end_ms: 1000 }],
    identity_reference_ids: [],
    motion_reference_id: 'motion-1',
    prompt: 'Clean unit prompt.\nDialogue: Unit line.',
    ...overrides,
  }
}

function transcriptPair(text, overrides = {}) {
  return [
    { model_id: 'Systran/faster-whisper-base', language: 'en', probability: 0.99, text, ...overrides },
    { model_id: 'Systran/faster-whisper-small', language: 'en', probability: 0.99, text, ...overrides },
  ]
}

test('planned submissions always request five-second 480p vertical audio regardless of keep duration or silence', async () => {
  const { createFuminEpisodeProviderAdapter } = await import('./fuminEpisodeProviderAdapter.mjs')
  const bodies = []
  const adapter = createFuminEpisodeProviderAdapter({
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body))
      return { ok: true, text: async () => JSON.stringify({ id: `task-${bodies.length}` }) }
    },
  })

  for (const unit of [
    plannedUnit({ keep_duration_ms: 900, source_end_ms: 900 }),
    plannedUnit({ keep_duration_ms: 5000, source_end_ms: 5000 }),
    plannedUnit({ dialogue: [], prompt: 'Clean silent unit prompt.\nDialogue: None. Ambient sound only.' }),
  ]) {
    await adapter.submitGeneration({
      unit,
      pack: { ...unit, duration_ms: 9000, audio_contract: { speech_required: false } },
      parent_pack: { prompt: 'Parent prompt. Dialogue: Forbidden parent line.' },
      uploaded_references: [],
    })
  }

  assert.equal(bodies.length, 3)
  for (const body of bodies) {
    assert.equal(body.duration, 5)
    assert.equal(body.resolution, '480p')
    assert.equal(body.aspect_ratio, '9:16')
    assert.equal(body.generate_audio, true)
    assert.doesNotMatch(body.prompt, /Forbidden parent line/)
  }
  assert.match(bodies[0].prompt, /Unit line/)
  assert.match(bodies[2].prompt, /Ambient sound only/)
})

test('non-five-second planned unit is rejected before provider HTTP', async () => {
  const { createFuminEpisodeProviderAdapter } = await import('./fuminEpisodeProviderAdapter.mjs')
  let fetchCalls = 0
  const adapter = createFuminEpisodeProviderAdapter({
    apiKey: 'test-key',
    fetchImpl: async () => { fetchCalls += 1 },
  })
  await assert.rejects(
    () => adapter.submitGeneration({
      unit: plannedUnit({ provider_duration_seconds: 4 }),
      pack: plannedUnit(),
      uploaded_references: [],
    }),
    { code: 'FUMIN_EPISODE_PROVIDER_DURATION_INVALID' },
  )
  assert.equal(fetchCalls, 0)
})

test('raw unit media validation requires readable five-second 480x864 video with audio', async () => {
  const { validateGeneratedMediaForUnit } = await import('./fuminEpisodeProviderAdapter.mjs')
  const unit = plannedUnit({ keep_duration_ms: 700, source_end_ms: 700 })
  const valid = { duration_seconds: 5.04, width: 480, height: 864, rotation: 0, video_codec: 'h264', has_audio: true }
  assert.equal(validateGeneratedMediaForUnit(unit, valid).media_passed, true)
  assert.equal(validateGeneratedMediaForUnit(unit, { ...valid, width: 496 }).media_passed, true)
  assert.equal(validateGeneratedMediaForUnit(unit, { ...valid, width: 864, height: 480, rotation: 90 }).media_passed, true)
  assert.equal(validateGeneratedMediaForUnit(unit, { ...valid, width: 864, height: 496, rotation: 90 }).media_passed, true)
  assert.throws(() => validateGeneratedMediaForUnit(unit, { ...valid, duration_seconds: 4.89 }), { code: 'FUMIN_EPISODE_OUTPUT_DURATION_INVALID' })
  assert.throws(() => validateGeneratedMediaForUnit(unit, { ...valid, has_audio: false }), { code: 'FUMIN_EPISODE_OUTPUT_AUDIO_MISSING' })
  assert.throws(() => validateGeneratedMediaForUnit(unit, { ...valid, width: 500 }), { code: 'FUMIN_EPISODE_OUTPUT_DIMENSIONS_INVALID' })
  assert.throws(() => validateGeneratedMediaForUnit(unit, { ...valid, video_codec: '' }), { code: 'FUMIN_EPISODE_OUTPUT_VIDEO_MISSING' })
})

test('unit transcript consensus accepts ambient silence and rejects any recognized speech', async () => {
  const { verifyTranscriptConsensusForUnit } = await import('./fuminEpisodeProviderAdapter.mjs')
  const silent = plannedUnit({ dialogue: [], prompt: 'Ambient only.' })
  assert.equal(verifyTranscriptConsensusForUnit(silent, transcriptPair('   ')).consensus_passed, true)
  assert.throws(
    () => verifyTranscriptConsensusForUnit(silent, transcriptPair('Someone speaks.')),
    { code: 'FUMIN_EPISODE_UNAPPROVED_DIALOGUE' },
  )
})

test('unit transcript consensus requires both ASRs to confirm English en-US and only the full approved dialogue', async () => {
  const { verifyTranscriptConsensusForUnit } = await import('./fuminEpisodeProviderAdapter.mjs')
  const unit = plannedUnit({
    locale: 'en-US',
    dialogue: [{ text: 'First line.' }, { text: 'Second line.' }],
  })
  assert.equal(verifyTranscriptConsensusForUnit(unit, transcriptPair('First line. Second line.')).exact_dialogue_present, true)
  assert.throws(
    () => verifyTranscriptConsensusForUnit(unit, transcriptPair('First line. Second line. Extra words.')),
    { code: 'FUMIN_EPISODE_UNAPPROVED_DIALOGUE' },
  )
  assert.throws(
    () => verifyTranscriptConsensusForUnit(unit, [transcriptPair('First line. Second line.')[0], { ...transcriptPair('First line.')[1] }]),
    { code: 'FUMIN_EPISODE_ASR_CONSENSUS_FAILED' },
  )
  assert.throws(
    () => verifyTranscriptConsensusForUnit({ ...unit, locale: 'fr-FR' }, transcriptPair('First line. Second line.')),
    { code: 'FUMIN_EPISODE_TARGET_LOCALE_FAILED' },
  )
  assert.throws(
    () => verifyTranscriptConsensusForUnit(unit, transcriptPair('First line. Second line.', { probability: undefined })),
    { code: 'FUMIN_EPISODE_TARGET_LANGUAGE_FAILED' },
  )
})

test('unit transcript consensus treats ASCII, curly, and omitted apostrophes as equivalent without allowing extra dialogue', async () => {
  const { verifyTranscriptConsensusForUnit } = await import('./fuminEpisodeProviderAdapter.mjs')
  const unit = plannedUnit({ locale: 'en-US', dialogue: [{ text: "Don't stop." }] })
  assert.equal(verifyTranscriptConsensusForUnit(unit, transcriptPair('Dont stop.')).consensus_passed, true)
  assert.equal(verifyTranscriptConsensusForUnit(unit, transcriptPair('Don’t stop.')).consensus_passed, true)
  assert.throws(
    () => verifyTranscriptConsensusForUnit(unit, transcriptPair('Dont stop. Extra words.')),
    { code: 'FUMIN_EPISODE_UNAPPROVED_DIALOGUE' },
  )
})

function rawMotionProbe() {
  return {
    streams: [{
      codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p',
      width: 480, height: 864, avg_frame_rate: '24/1',
    }],
    format: { duration: '5.000000' },
  }
}

function prepareFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-adapter-prepare-'))
  const inputs = path.join(root, 'inputs')
  const stateDir = path.join(root, 'state')
  fs.mkdirSync(inputs)
  const motionPath = path.join(inputs, 'motion.mp4')
  fs.writeFileSync(motionPath, 'source-motion')
  const motionHash = sha256(fs.readFileSync(motionPath))
  const pkg = {
    package_path: path.join(inputs, 'package.json'),
    production_packs: [{
      shot_id: 'shot-1', start_ms: 1000, end_ms: 2200, duration_ms: 1200,
      production_pack_hash: 'a'.repeat(64), characters: [], dialogue: [],
      visual_contract: { references: [{ kind: 'motion', sha256: motionHash }] },
      audio_contract: { locale: 'en-US', speech_required: false },
      prompt: 'One silent shot.',
    }],
    identity_references: [],
    motion_references: [{ id: 'motion-1', shot_id: 'shot-1', path: motionPath, sha256: motionHash }],
  }
  fs.writeFileSync(pkg.package_path, JSON.stringify({ fixture: true }))
  return { root, stateDir, pkg }
}

function prepareAdapter(calls) {
  return createPrepareAdapter(calls)
}

async function createPrepareAdapter(calls) {
  const { createFuminEpisodeProviderAdapter } = await import('./fuminEpisodeProviderAdapter.mjs')
  return createFuminEpisodeProviderAdapter({
    apiKey: 'test-key',
    fetchImpl: async () => { calls.http += 1; throw new Error('provider HTTP forbidden') },
    ffmpegPath: 'ffmpeg-test',
    ffprobePath: 'ffprobe-test',
    runProcess: (command, args, code) => {
      calls.process.push({ command, code })
      if (code === 'FUMIN_EXECUTION_MOTION_FFMPEG_FAILED') {
        calls.writes += 1
        fs.writeFileSync(args.at(-1), 'materialized-motion')
        return ''
      }
      return JSON.stringify(rawMotionProbe())
    },
  })
}

test('prepareEpisode materializes and verifies the same hash-bound relative motion evidence without HTTP or verify writes', async () => {
  const item = prepareFixture()
  const calls = { http: 0, writes: 0, process: [] }
  try {
    const adapter = await prepareAdapter(calls)
    const materialized = await adapter.prepareEpisode({ package: item.pkg, state_dir: item.stateDir, mode: 'materialize' })
    assert.equal(materialized.units.length, 1)
    assert.match(materialized.units[0].unit_hash, /^[a-f0-9]{64}$/)
    assert.deepEqual(Object.keys(materialized.units[0].materialized_motion).sort(), ['artifact_id', 'duration_seconds', 'probe', 'sha256'])
    assert.equal(materialized.units[0].materialized_motion.artifact_id, 'provider/fumin/motion/shot-1.part-01.mp4')
    assert.doesNotMatch(JSON.stringify(materialized), new RegExp(item.root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')))
    assert.equal(calls.http, 0)
    assert.equal(calls.writes, 1)

    const beforeWrites = calls.writes
    const verified = await adapter.prepareEpisode({ package: item.pkg, state_dir: item.stateDir, mode: 'verify' })
    assert.equal(verified.execution_plan_hash, materialized.execution_plan_hash)
    assert.deepEqual(verified, materialized)
    assert.equal(calls.writes, beforeWrites)
    assert.equal(calls.http, 0)
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('prepareEpisode verify rejects missing or drifted materialized and source motion', async () => {
  for (const change of ['missing', 'drift', 'source-drift']) {
    const item = prepareFixture()
    const calls = { http: 0, writes: 0, process: [] }
    try {
      const adapter = await prepareAdapter(calls)
      const plan = await adapter.prepareEpisode({ package: item.pkg, state_dir: item.stateDir, mode: 'materialize' })
      const motionPath = path.join(item.stateDir, ...plan.units[0].materialized_motion.artifact_id.split('/'))
      if (change === 'missing') fs.rmSync(motionPath)
      else if (change === 'drift') fs.writeFileSync(motionPath, 'drifted-motion')
      else fs.writeFileSync(item.pkg.motion_references[0].path, 'drifted-source-motion')
      await assert.rejects(
        () => adapter.prepareEpisode({ package: item.pkg, state_dir: item.stateDir, mode: 'verify' }),
        {
          code: change === 'missing'
            ? 'FUMIN_EPISODE_MOTION_MISSING'
            : change === 'source-drift'
              ? 'FUMIN_EPISODE_MOTION_REFERENCE_HASH_MISMATCH'
              : 'FUMIN_EPISODE_MOTION_HASH_MISMATCH',
        },
      )
      assert.equal(calls.http, 0)
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true })
    }
  }
})

test('prepareEpisode rejects unsafe state paths and invalid modes before materialization', async () => {
  const item = prepareFixture()
  const calls = { http: 0, writes: 0, process: [] }
  try {
    const adapter = await prepareAdapter(calls)
    await assert.rejects(
      () => adapter.prepareEpisode({ package: item.pkg, state_dir: 'relative/state', mode: 'materialize' }),
      { code: 'FUMIN_EPISODE_STATE_PATH_INVALID' },
    )
    await assert.rejects(
      () => adapter.prepareEpisode({ package: item.pkg, state_dir: path.dirname(item.pkg.package_path), mode: 'materialize' }),
      { code: 'FUMIN_EPISODE_STATE_OVERLAPS_INPUT' },
    )
    await assert.rejects(
      () => adapter.prepareEpisode({ package: item.pkg, state_dir: item.stateDir, mode: 'write' }),
      { code: 'FUMIN_EPISODE_PREPARE_MODE_INVALID' },
    )
    assert.equal(calls.process.length, 0)
    assert.equal(calls.http, 0)
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('prepareEpisode rejects a linked provider directory before materialize or verify can escape state', async (t) => {
  let linkSupported = true
  for (const mode of ['materialize', 'verify']) {
    const item = prepareFixture()
    const outside = path.join(item.root, 'outside')
    const provider = path.join(item.stateDir, 'provider')
    const calls = { http: 0, writes: 0, process: [] }
    try {
      fs.mkdirSync(item.stateDir)
      fs.mkdirSync(outside)
      try {
        fs.symlinkSync(outside, provider, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
          linkSupported = false
          break
        }
        throw error
      }
      const adapter = await prepareAdapter(calls)
      await assert.rejects(
        () => adapter.prepareEpisode({ package: item.pkg, state_dir: item.stateDir, mode }),
        { code: 'FUMIN_EPISODE_STATE_PATH_UNSAFE' },
      )
      assert.deepEqual(fs.readdirSync(outside), [])
      assert.equal(calls.process.length, 0)
      assert.equal(calls.writes, 0)
      assert.equal(calls.http, 0)
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true })
    }
  }
  if (!linkSupported) t.skip('directory symlink/junction creation is not permitted on this host')
})

test('prepareEpisode stages motion before rejecting a final-directory junction swapped in during materialization', async (t) => {
  const item = prepareFixture()
  const outside = path.join(item.root, 'outside')
  const finalMotionDir = path.join(item.stateDir, 'provider', 'fumin', 'motion')
  const receipt = path.join(item.stateDir, 'provider', 'fumin', 'execution-plan.json')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  let materializerCalls = 0
  let httpCalls = 0
  try {
    fs.mkdirSync(outside)
    const linkProbe = path.join(item.root, 'link-probe')
    try {
      fs.symlinkSync(outside, linkProbe, linkType)
      fs.rmSync(linkProbe)
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
        t.skip('directory symlink/junction creation is not permitted on this host')
        return
      }
      throw error
    }
    const { createFuminEpisodeProviderAdapter } = await import('./fuminEpisodeProviderAdapter.mjs')
    const adapter = createFuminEpisodeProviderAdapter({
      apiKey: 'test-key',
      fetchImpl: async () => { httpCalls += 1; throw new Error('provider HTTP forbidden') },
      ffmpegPath: 'ffmpeg-test',
      ffprobePath: 'ffprobe-test',
      runProcess: (_command, args, code) => {
        if (code === 'FUMIN_EXECUTION_MOTION_FFMPEG_FAILED') {
          materializerCalls += 1
          fs.rmSync(finalMotionDir, { recursive: true, force: true })
          fs.symlinkSync(outside, finalMotionDir, linkType)
          fs.writeFileSync(args.at(-1), 'materialized-motion')
          return ''
        }
        return JSON.stringify(rawMotionProbe())
      },
    })

    await assert.rejects(
      () => adapter.prepareEpisode({ package: item.pkg, state_dir: item.stateDir, mode: 'materialize' }),
      { code: 'FUMIN_EPISODE_STATE_PATH_UNSAFE' },
    )
    assert.equal(materializerCalls, 1)
    assert.equal(httpCalls, 0)
    assert.deepEqual(fs.readdirSync(outside), [])
    assert.equal(fs.existsSync(receipt), false)
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('prepareEpisode gives the materializer only an unpredictable staging file in the canonical state root', async (t) => {
  const item = prepareFixture()
  const outside = path.join(item.root, 'outside')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  let materializerParent = null
  let swappedChildDirectory = false
  try {
    fs.mkdirSync(outside)
    const linkProbe = path.join(item.root, 'link-probe')
    try {
      fs.symlinkSync(outside, linkProbe, linkType)
      fs.rmSync(linkProbe)
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
        t.skip('directory symlink/junction creation is not permitted on this host')
        return
      }
      throw error
    }
    const { createFuminEpisodeProviderAdapter } = await import('./fuminEpisodeProviderAdapter.mjs')
    const adapter = createFuminEpisodeProviderAdapter({
      apiKey: 'test-key',
      fetchImpl: async () => { throw new Error('provider HTTP forbidden') },
      ffmpegPath: 'ffmpeg-test',
      ffprobePath: 'ffprobe-test',
      runProcess: (_command, args, code) => {
        if (code === 'FUMIN_EXECUTION_MOTION_FFMPEG_FAILED') {
          materializerParent = path.dirname(args.at(-1))
          const canonicalState = fs.realpathSync(item.stateDir)
          if (path.resolve(materializerParent) !== path.resolve(canonicalState)) {
            fs.rmSync(materializerParent, { recursive: true, force: true })
            fs.symlinkSync(outside, materializerParent, linkType)
            swappedChildDirectory = true
          }
          fs.writeFileSync(args.at(-1), 'materialized-motion')
          return ''
        }
        return JSON.stringify(rawMotionProbe())
      },
    })

    await adapter.prepareEpisode({ package: item.pkg, state_dir: item.stateDir, mode: 'materialize' })
    assert.equal(path.resolve(materializerParent), path.resolve(fs.realpathSync(item.stateDir)))
    assert.equal(swappedChildDirectory, false)
    assert.deepEqual(fs.readdirSync(outside), [])
    assert.equal(fs.existsSync(path.join(item.stateDir, 'provider', 'fumin', '.staging')), false)
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true })
  }
})

test('inspectArtifact accepts runner planned raw_path parameters and validates the unit contract', async () => {
  const { createFuminEpisodeProviderAdapter } = await import('./fuminEpisodeProviderAdapter.mjs')
  const adapter = createFuminEpisodeProviderAdapter({
    apiKey: 'test-key',
    fetchImpl: async () => { throw new Error('network forbidden') },
    runProcess: () => JSON.stringify({
      streams: [
        { codec_type: 'video', width: 480, height: 864, codec_name: 'h264' },
        { codec_type: 'audio', channels: 2, codec_name: 'aac' },
      ],
      format: { duration: '5.000' },
    }),
    transcribeConsensus: async () => transcriptPair('Unit line.'),
  })
  const inspected = await adapter.inspectArtifact({
    raw_path: 'raw-unit.mp4',
    unit: plannedUnit(),
    parent_pack: { dialogue: [{ text: 'Forbidden parent line.' }] },
  })
  assert.equal(inspected.media.media_passed, true)
  assert.deepEqual(inspected.dialogue.target_dialogue, ['Unit line.'])
  await assert.rejects(
    () => adapter.inspectArtifact({
      raw_path: 'raw-unit.mp4',
      unit: plannedUnit(),
      parent_pack: { audio_contract: { locale: 'fr-FR' } },
    }),
    { code: 'FUMIN_EPISODE_TARGET_LOCALE_FAILED' },
  )
})

test('inspectArtifact distinguishes five-second raw media from a keep-duration canonical final while retaining unit ASR', async () => {
  const { createFuminEpisodeProviderAdapter } = await import('./fuminEpisodeProviderAdapter.mjs')
  const probes = []
  const adapter = createFuminEpisodeProviderAdapter({
    apiKey: 'test-key',
    fetchImpl: async () => { throw new Error('network forbidden') },
    runProcess: (_command, args) => {
      const filePath = args.at(-1)
      const final = /[\\/]outputs[\\/]units[\\/]/.test(filePath)
      probes.push(final ? 'final' : 'raw')
      return JSON.stringify({
        streams: [
          {
            codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 480, height: 864,
            avg_frame_rate: '24/1', duration: final ? '1.266' : '5.000', start_time: '0.000',
          },
          {
            codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2,
            duration: final ? '1.266' : '5.000', start_time: '0.000',
          },
        ],
        format: { duration: final ? '1.266' : '5.000' },
      })
    },
    transcribeConsensus: async () => transcriptPair('Unit line.'),
  })
  const unit = plannedUnit({ keep_duration_ms: 1266 })
  const raw = await adapter.inspectArtifact({ output_path: 'C:/state/outputs/raw/shot.part-01.mp4', unit })
  const final = await adapter.inspectArtifact({ output_path: 'C:/state/outputs/units/shot.part-01.mp4', unit })
  assert.equal(raw.media.duration_seconds, 5)
  assert.equal(final.media.duration_seconds, 1.266)
  assert.equal(final.media.pixel_format, 'yuv420p')
  assert.equal(final.dialogue.exact_dialogue_present, true)
  assert.deepEqual(probes, ['raw', 'final'])
})

test('finalizeArtifact delegates exact raw, final, and keep-duration inputs to the local pipeline', async () => {
  const { createFuminEpisodeProviderAdapter } = await import('./fuminEpisodeProviderAdapter.mjs')
  const calls = []
  const adapter = createFuminEpisodeProviderAdapter({
    apiKey: 'test-key',
    fetchImpl: async () => { throw new Error('network forbidden') },
    normalizeUnitArtifact: (input) => {
      calls.push(input)
      return { path: input.outputPath, sha256: 'a'.repeat(64), media: { media_passed: true } }
    },
    ffmpegPath: 'ffmpeg-local',
    ffprobePath: 'ffprobe-local',
  })
  const result = await adapter.finalizeArtifact({
    raw_path: 'C:/state/outputs/raw/shot.part-01.mp4',
    output_path: 'C:/state/outputs/units/shot.part-01.mp4',
    unit: plannedUnit({ keep_duration_ms: 1266 }),
  })
  assert.deepEqual(result, { path: 'C:/state/outputs/units/shot.part-01.mp4', sha256: 'a'.repeat(64) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].keepDurationMs, 1266)
  assert.equal(calls[0].outputRoot, path.resolve('C:/state/outputs'))
  assert.equal(calls[0].ffmpegPath, 'ffmpeg-local')
  assert.equal(calls[0].ffprobePath, 'ffprobe-local')
})

test('runProcess injection never removes the mandatory finalizeArtifact hook', async () => {
  const { createFuminEpisodeProviderAdapter } = await import('./fuminEpisodeProviderAdapter.mjs')
  const adapter = createFuminEpisodeProviderAdapter({
    apiKey: 'test-key',
    fetchImpl: async () => { throw new Error('network forbidden') },
    runProcess: () => JSON.stringify({ streams: [], format: {} }),
  })
  assert.equal(typeof adapter.finalizeArtifact, 'function')
})

test('planned assemble passes normalized unit paths in execution-plan order and returns the exact episode artifact', async () => {
  const { createFuminEpisodeProviderAdapter } = await import('./fuminEpisodeProviderAdapter.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-planned-assemble-'))
  try {
    const outputPath = path.join(root, 'outputs', 'episode.mp4')
    const units = [
      plannedUnit({ unit_id: 'shot-1.part-01', parent_shot_id: 'shot-1', part_index: 1, part_count: 2, keep_duration_ms: 1200 }),
      plannedUnit({ unit_id: 'shot-1.part-02', parent_shot_id: 'shot-1', part_index: 2, part_count: 2, keep_duration_ms: 1300 }),
    ]
    const unitPaths = units.map((unit) => path.join(root, 'outputs', 'units', `${unit.unit_id}.mp4`))
    for (const [index, unitPath] of unitPaths.entries()) {
      fs.mkdirSync(path.dirname(unitPath), { recursive: true })
      fs.writeFileSync(unitPath, `normalized-${index}`)
    }
    const calls = []
    const adapter = createFuminEpisodeProviderAdapter({
      apiKey: 'test-key',
      fetchImpl: async () => { throw new Error('network forbidden') },
      assembleNormalizedEpisode: (input) => {
        calls.push(input)
        return { episode: { path: input.episodeOutputPath, sha256: 'b'.repeat(64), media: {} }, parent_shots: [] }
      },
    })
    const result = await adapter.assembleEpisode({
      unit_paths: unitPaths,
      execution_plan: { units },
      output_path: outputPath,
    })
    assert.deepEqual(result, { path: outputPath, sha256: 'b'.repeat(64) })
    assert.deepEqual(calls[0].unitArtifacts, unitPaths.map((unitPath, index) => ({
      unit_id: units[index].unit_id,
      path: unitPath,
      sha256: sha256(fs.readFileSync(unitPath)),
    })))
    assert.deepEqual(calls[0].units.map((unit) => unit.unit_id), units.map((unit) => unit.unit_id))
    assert.equal(calls[0].episodeOutputPath, outputPath)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Fumin adapter assembles two verified shots with ffmpeg concat instead of raw byte concatenation', async () => {
  const { createFuminEpisodeProviderAdapter } = await import('./fuminEpisodeProviderAdapter.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-assemble-'))
  try {
    const shot1 = path.join(root, 'shot 1.mp4')
    const shot2 = path.join(root, "shot'2.mp4")
    const output = path.join(root, 'out', 'episode.mp4')
    fs.writeFileSync(shot1, 'mp4-a')
    fs.writeFileSync(shot2, 'mp4-b')
    const calls = []
    const adapter = createFuminEpisodeProviderAdapter({
      apiKey: 'test-key',
      fetchImpl: async () => { throw new Error('network must not be used') },
      runProcess: (command, args, code) => {
        calls.push({ command, args, code })
        assert.equal(command, 'ffmpeg-test-bin')
        assert.deepEqual(args.slice(0, 4), ['-hide_banner', '-loglevel', 'error', '-f'])
        assert.equal(args.includes('-safe'), true)
        assert.equal(args.includes('-c'), true)
        assert.equal(args.at(-1), output)
        const listPath = args[args.indexOf('-i') + 1]
        const list = fs.readFileSync(listPath, 'utf8')
        assert.match(list, /^file '/m)
        assert.match(list, /shot'\\''2\.mp4/)
        fs.mkdirSync(path.dirname(output), { recursive: true })
        fs.writeFileSync(output, 'ffmpeg-output')
        return ''
      },
      ffmpegPath: 'ffmpeg-test-bin',
    })
    const result = await adapter.assembleEpisode({ shot_paths: [shot1, shot2], output_path: output })
    assert.equal(calls.length, 1)
    assert.equal(fs.readFileSync(output, 'utf8'), 'ffmpeg-output')
    assert.notEqual(fs.readFileSync(output, 'utf8'), 'mp4-amp4-b')
    assert.equal(result.sha256, sha256(Buffer.from('ffmpeg-output')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Fumin adapter rejects concat output that ffmpeg did not create', async () => {
  const { createFuminEpisodeProviderAdapter } = await import('./fuminEpisodeProviderAdapter.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-assemble-missing-'))
  try {
    const shot1 = path.join(root, 'shot-1.mp4')
    const shot2 = path.join(root, 'shot-2.mp4')
    const output = path.join(root, 'out', 'episode.mp4')
    fs.writeFileSync(shot1, 'mp4-a')
    fs.writeFileSync(shot2, 'mp4-b')
    const adapter = createFuminEpisodeProviderAdapter({
      apiKey: 'test-key',
      fetchImpl: async () => { throw new Error('network must not be used') },
      runProcess: () => '',
      ffmpegPath: 'ffmpeg-test-bin',
    })
    await assert.rejects(
      () => adapter.assembleEpisode({ shot_paths: [shot1, shot2], output_path: output }),
      /FUMIN_EPISODE_ASSEMBLE_OUTPUT_MISSING/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
