import test from 'node:test'
import assert from 'node:assert/strict'

import { episodeVideoRoute } from './episodeVideoRouteRegistry.mjs'
import { createEpisodeVideoProviderAdapter } from './episodeVideoProviderAdapter.mjs'

function commonAdapter() {
  return {
    name: 'fumin',
    async prepareEpisode() {
      return {
        schema_version: 'redraw-provider-execution-plan-v1',
        provider: 'fumin',
        units: [],
        execution_plan_hash: '0'.repeat(64),
      }
    },
    async uploadReference(value) { return value },
    async downloadResult(value) { return value },
    async finalizeArtifact(value) { return value },
    async inspectArtifact() { return { passed: true } },
    async assembleEpisode(value) { return value },
    async inspectEpisode() { return { passed: true } },
  }
}

function unit() {
  return {
    unit_id: 'shot-01.part-01',
    unit_hash: 'a'.repeat(64),
    provider_duration_seconds: 5,
    keep_duration_ms: 5000,
    prompt: 'Mateo speaks natural American English.',
    dialogue: [{ text: 'We leave tonight.', start_ms: 0, end_ms: 1200 }],
  }
}

const uploadedReferences = [
  { url: 'https://assets.example/identity.png', mime_type: 'image/png' },
  { url: 'https://assets.example/motion.mp4', mime_type: 'video/mp4', duration_seconds: 5 },
  { url: 'https://assets.example/voice.wav', mime_type: 'audio/wav', duration_seconds: 3 },
]

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload) },
  }
}

test('ToAPIs Fast adapter submits the approved vertical five-second audio contract', async () => {
  const bodies = []
  let beforeCalls = 0
  const adapter = createEpisodeVideoProviderAdapter({
    route: episodeVideoRoute('toapis-fast'),
    providerApiKey: 'toapis-test-key',
    referenceApiKey: 'fumin-test-key',
    commonAdapter: commonAdapter(),
    beforeGenerationSubmit: async ({ route_id, unit_id }) => {
      beforeCalls += 1
      assert.deepEqual([route_id, unit_id], ['toapis-fast', 'shot-01.part-01'])
    },
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body))
      return response({ id: 'task-fast' })
    },
  })

  assert.deepEqual(
    await adapter.submitGeneration({ unit: unit(), uploaded_references: uploadedReferences }),
    { task_id: 'task-fast' },
  )
  assert.equal(beforeCalls, 1)
  assert.equal(bodies[0].model, 'seedance-2-fast')
  assert.equal(bodies[0].duration, 5)
  assert.equal(bodies[0].resolution, '480p')
  assert.equal(bodies[0].aspect_ratio, '9:16')
  assert.equal(bodies[0].generate_audio, true)
  assert.equal(bodies[0].image_with_roles[0].role, 'reference_image')
  assert.equal(bodies[0].video_with_roles[0].role, 'reference_video')
  assert.equal(bodies[0].audio_with_roles[0].role, 'reference_audio')
})

test('ToAPIs Wan3 and Feituo adapters keep their distinct verified request shapes', async () => {
  for (const routeId of ['toapis-wan3', 'feituo-seedance-2.5']) {
    let body
    const adapter = createEpisodeVideoProviderAdapter({
      route: episodeVideoRoute(routeId),
      providerApiKey: 'provider-test-key',
      referenceApiKey: 'fumin-test-key',
      commonAdapter: commonAdapter(),
      beforeGenerationSubmit: async () => {},
      fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body)
        return response(routeId === 'toapis-wan3' ? { id: 'task-wan3' } : { jobId: 'task-feituo' })
      },
    })
    const created = await adapter.submitGeneration({ unit: unit(), uploaded_references: uploadedReferences })
    assert.ok(created.task_id)
    assert.equal(body.duration, 5)
    assert.equal(body.resolution, '480p')
    if (routeId === 'toapis-wan3') {
      assert.equal(body.model, 'wan3.0-video')
      assert.equal(body.ratio, '9:16')
      assert.equal(body.audio, true)
      assert.deepEqual(body.reference_images, ['https://assets.example/identity.png'])
      assert.deepEqual(body.video_list, [{ video_url: 'https://assets.example/motion.mp4' }])
    } else {
      assert.equal(body.model, 'xuan-seedance-2.5')
      assert.equal(body.ratio, '9:16')
      assert.deepEqual(body.imageUrls, ['https://assets.example/identity.png'])
      assert.deepEqual(body.videoUrls, ['https://assets.example/motion.mp4'])
      assert.deepEqual(body.audioUrls, ['https://assets.example/voice.wav'])
      assert.equal('generate_audio' in body, false)
    }
  }
})

test('adapter distinguishes explicit provider failure, unknown query and completed task without artifact', async () => {
  for (const scenario of ['terminal', 'query-unknown', 'artifact-invalid']) {
    const adapter = createEpisodeVideoProviderAdapter({
      route: episodeVideoRoute('toapis-fast'),
      providerApiKey: 'toapis-test-key',
      referenceApiKey: 'fumin-test-key',
      commonAdapter: commonAdapter(),
      sleep: async () => {},
      pollAttempts: 1,
      fetchImpl: async () => {
        if (scenario === 'terminal') return response({ status: 'failed', error: { message: 'bad reference' } })
        if (scenario === 'artifact-invalid') return response({ status: 'completed' })
        return response({ message: 'gateway unavailable' }, 502)
      },
    })
    if (scenario === 'terminal') {
      await assert.rejects(
        () => adapter.pollGeneration({ task_id: 'task-1' }),
        (error) => error.provider_terminal_failure === true
          && error.provider_reason === 'bad reference',
      )
    } else if (scenario === 'query-unknown') {
      await assert.rejects(
        () => adapter.pollGeneration({ task_id: 'task-1' }),
        (error) => error.indeterminate === true
          && error.code === 'REDRAW_EPISODE_PROVIDER_STATUS_UNKNOWN',
      )
    } else {
      await assert.rejects(
        () => adapter.pollGeneration({ task_id: 'task-1' }),
        (error) => error.provider_terminal_failure !== true
          && error.indeterminate !== true
          && error.code === 'REDRAW_EPISODE_PROVIDER_RESULT_INVALID',
      )
    }
  }
})

test('Feituo separates explicit rejection from a completed task with no readable artifact', async () => {
  const rejected = createEpisodeVideoProviderAdapter({
    route: episodeVideoRoute('feituo-seedance-2.5'),
    providerApiKey: 'feituo-test-key',
    referenceApiKey: 'fumin-test-key',
    commonAdapter: commonAdapter(),
    fetchImpl: async () => response({ message: 'reference rejected' }, 400),
  })
  await assert.rejects(
    () => rejected.submitGeneration({ unit: unit(), uploaded_references: uploadedReferences }),
    (error) => error.provider_terminal_failure === true
      && error.provider_reason.includes('reference rejected'),
  )

  for (const [status, terminal] of [['failed', true], ['completed', false]]) {
    const adapter = createEpisodeVideoProviderAdapter({
      route: episodeVideoRoute('feituo-seedance-2.5'),
      providerApiKey: 'feituo-test-key',
      referenceApiKey: 'fumin-test-key',
      commonAdapter: commonAdapter(),
      sleep: async () => {},
      pollAttempts: 1,
      fetchImpl: async () => response({ status, message: `${status} result` }),
    })
    await assert.rejects(
      () => adapter.pollGeneration({ task_id: 'task-feituo' }),
      (error) => (error.provider_terminal_failure === true) === terminal,
    )
  }
})

test('adapter delegates media operations and rewrites the execution plan provider to the route id', async () => {
  const common = commonAdapter()
  const calls = []
  common.downloadResult = async (value) => { calls.push(['download', value]); return value }
  const adapter = createEpisodeVideoProviderAdapter({
    route: episodeVideoRoute('toapis-fast'),
    providerApiKey: 'toapis-test-key',
    referenceApiKey: 'fumin-test-key',
    commonAdapter: common,
  })
  const plan = await adapter.prepareEpisode({})
  assert.equal(adapter.name, 'toapis-fast')
  assert.equal(plan.provider, 'toapis-fast')
  assert.match(plan.execution_plan_hash, /^[a-f0-9]{64}$/u)
  await adapter.downloadResult({ output_path: 'local.mp4' })
  assert.deepEqual(calls, [['download', { output_path: 'local.mp4' }]])
})
