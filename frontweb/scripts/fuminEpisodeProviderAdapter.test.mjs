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
        streams: [{ codec_type: 'video', width: 496, height: 864, codec_name: 'h264' }, { codec_type: 'audio', channels: 2, codec_name: 'aac' }],
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
    () => verifyTranscriptConsensusForPack({ ...pack, audio_contract: { speech_required: false } }, transcripts),
    /FUMIN_EPISODE_SILENT_SHOT_HAS_SPEECH/,
  )
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
