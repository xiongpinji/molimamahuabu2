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
