import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FUMIN_PROVIDER_DURATION_SECONDS,
  buildFuminEpisodeExecutionPlan,
} from './fuminEpisodeExecutionPlan.mjs'

const LOCKED_DURATIONS_MS = [
  1200, 2433, 7134, 866, 2200, 1567, 967, 1066, 1800, 7367, 7700, 933,
  734, 733, 933, 4134, 4966, 7967, 3633, 2234, 1266, 1734, 1400, 3766,
]

function makePack({
  shot_id = 'shot-01',
  start_ms = 0,
  end_ms = 5000,
  characters = [],
  dialogue = [],
  visual_contract = {},
  prompt = `Shot ${shot_id}.`,
  production_pack_hash = 'a'.repeat(64),
} = {}) {
  return {
    shot_id,
    start_ms,
    end_ms,
    duration_ms: end_ms - start_ms,
    production_pack_hash,
    characters,
    dialogue,
    visual_contract,
    audio_contract: { locale: 'en-US' },
    prompt,
  }
}

function makePackage(production_packs, overrides = {}) {
  return {
    production_packs,
    identity_references: [],
    motion_references: [],
    ...overrides,
  }
}

function makeLockedPackage() {
  let cursor = 0
  const productionPacks = LOCKED_DURATIONS_MS.map((duration, index) => {
    const start = cursor
    cursor += duration
    return makePack({
      shot_id: `shot-${String(index + 1).padStart(2, '0')}`,
      start_ms: start,
      end_ms: cursor,
      production_pack_hash: String(index + 1).padStart(64, '0'),
      prompt: `Shot ${index + 1}.\nCamera: Preserve the locked camera.`,
    })
  })
  return makePackage(productionPacks)
}

test('24 locked shots become 28 fixed-five-second units without timeline loss', () => {
  const pkg = makeLockedPackage()
  const plan = buildFuminEpisodeExecutionPlan(pkg)

  assert.equal(FUMIN_PROVIDER_DURATION_SECONDS, 5)
  assert.equal(plan.schema_version, 'redraw-provider-execution-plan-v1')
  assert.equal(plan.provider, 'fumin')
  assert.match(plan.execution_plan_hash, /^[a-f0-9]{64}$/)
  assert.equal(plan.units.length, 28)
  assert.ok(plan.units.every((unit) => unit.provider_duration_seconds === 5))
  assert.ok(plan.units.every((unit) => unit.keep_duration_ms > 0 && unit.keep_duration_ms <= 5000))
  assert.equal(plan.units.reduce((sum, unit) => sum + unit.keep_duration_ms, 0), 68_733)

  for (const pack of pkg.production_packs) {
    const units = plan.units.filter((unit) => unit.parent_shot_id === pack.shot_id)
    assert.equal(units[0].source_start_ms, pack.start_ms)
    assert.equal(units.at(-1).source_end_ms, pack.end_ms)
    assert.equal(units.length, Math.ceil(pack.duration_ms / 5000))
    units.forEach((unit, index) => {
      assert.equal(unit.schema_version, 'fumin-episode-execution-unit-v1')
      assert.equal(unit.unit_id, `${pack.shot_id}.part-${String(index + 1).padStart(2, '0')}`)
      assert.equal(unit.part_index, index + 1)
      assert.equal(unit.part_count, units.length)
      assert.equal(unit.parent_production_pack_hash, pack.production_pack_hash)
      assert.equal(unit.keep_duration_ms, unit.source_end_ms - unit.source_start_ms)
      if (index > 0) assert.equal(unit.source_start_ms, units[index - 1].source_end_ms)
    })
  }

  plan.units.slice(1).forEach((unit, index) => {
    assert.equal(unit.source_start_ms, plan.units[index].source_end_ms)
  })
})

test('moves a split away from dialogue and rebases complete turns', () => {
  const pack = makePack({
    shot_id: 'shot-03',
    start_ms: 3633,
    end_ms: 10_767,
    dialogue: [
      { id: 'a', speaker_id: 'lucas', speaker_name: 'Lucas', start_ms: 6330, end_ms: 7670, text: 'That is Lucas.' },
      { id: 'b', speaker_id: 'mateo', speaker_name: 'Mateo', start_ms: 7670, end_ms: 9390, text: 'It is just rejection.' },
    ],
  })

  const plan = buildFuminEpisodeExecutionPlan(makePackage([pack]))

  assert.deepEqual(plan.units.map((unit) => unit.keep_duration_ms), [4037, 3097])
  assert.deepEqual(plan.units[0].dialogue.map((turn) => [turn.id, turn.start_ms, turn.end_ms]), [
    ['a', 2697, 4037],
  ])
  assert.deepEqual(plan.units[1].dialogue.map((turn) => [turn.id, turn.start_ms, turn.end_ms]), [
    ['b', 0, 1720],
  ])
})

test('fails closed when no dialogue-safe split boundary exists', () => {
  const pack = makePack({
    shot_id: 'shot-long',
    start_ms: 0,
    end_ms: 8000,
    dialogue: [
      { id: 'a', speaker_id: 'lead', speaker_name: 'Lead', start_ms: 1000, end_ms: 7000, text: 'One continuous line.' },
    ],
  })

  assert.throws(
    () => buildFuminEpisodeExecutionPlan(makePackage([pack])),
    (error) => error.code === 'FUMIN_EXECUTION_DIALOGUE_SPLIT_UNSAFE',
  )
})

test('uses a deterministic lower-bound tie-break for equally near safe dialogue endpoints', () => {
  const pack = makePack({
    shot_id: 'shot-tie',
    start_ms: 100,
    end_ms: 8100,
    dialogue: [
      { id: 'a', start_ms: 4100, end_ms: 6100, text: 'A centered line.' },
    ],
  })

  const plan = buildFuminEpisodeExecutionPlan(makePackage([pack]))

  assert.deepEqual(plan.units.map((unit) => unit.keep_duration_ms), [4000, 4000])
})

test('binds identity references by parent characters and one exact motion reference by shot', () => {
  const identityAHash = '1'.repeat(64)
  const identityBHash = '2'.repeat(64)
  const motionHash = '3'.repeat(64)
  const pack = makePack({
    characters: [
      { id: 'bravo', assets: [{ kind: 'identity', sha256: identityBHash }] },
      { id: 'alpha', assets: [{ kind: 'identity', sha256: identityAHash }] },
    ],
    visual_contract: { references: [{ kind: 'motion', sha256: motionHash }] },
  })
  const plan = buildFuminEpisodeExecutionPlan(makePackage([pack], {
    identity_references: [
      { id: 'identity-bravo', character_id: 'bravo', sha256: identityBHash },
      { id: 'identity-unused', character_id: 'unused', sha256: '4'.repeat(64) },
      { id: 'identity-alpha', source_character_key: 'alpha', sha256: identityAHash },
    ],
    motion_references: [
      { id: 'motion-shot-01', shot_id: 'shot-01', sha256: motionHash },
    ],
  }))

  assert.deepEqual(plan.units[0].identity_reference_ids, ['identity-alpha', 'identity-bravo'])
  assert.equal(plan.units[0].motion_reference_id, 'motion-shot-01')
})

test('rewrites the parent Dialogue block with only the complete dialogue in each unit', () => {
  const pack = makePack({
    shot_id: 'shot-dialogue',
    start_ms: 0,
    end_ms: 8000,
    dialogue: [
      { id: 'first', speaker_name: 'Ava', start_ms: 1000, end_ms: 4000, text: 'First line.' },
      { id: 'second', speaker_name: 'Ben', start_ms: 5000, end_ms: 7000, text: 'Second line.' },
    ],
    prompt: [
      'Shot shot-dialogue.',
      'Dialogue:',
      '- Ava: stale first line.',
      '- Ben: stale second line.',
      'Audio locale: en-US.',
    ].join('\n'),
  })

  const plan = buildFuminEpisodeExecutionPlan(makePackage([pack]))

  assert.match(plan.units[0].prompt, /Dialogue: Ava: First line\./)
  assert.doesNotMatch(plan.units[0].prompt, /Second line|stale/)
  assert.match(plan.units[1].prompt, /Dialogue: Ben: Second line\./)
  assert.doesNotMatch(plan.units[1].prompt, /First line|stale/)
  assert.ok(plan.units.every((unit) => !/[\u3400-\u9fff]/u.test(unit.prompt)))
})

test('hashes the canonical plan deterministically', () => {
  const pkg = makeLockedPackage()
  const first = buildFuminEpisodeExecutionPlan(pkg)
  const second = buildFuminEpisodeExecutionPlan(structuredClone(pkg))
  const changed = structuredClone(pkg)
  changed.production_packs[0].prompt = 'Changed shot prompt.'

  assert.deepEqual(second, first)
  assert.notEqual(buildFuminEpisodeExecutionPlan(changed).execution_plan_hash, first.execution_plan_hash)
})

test('rejects runtime-sensitive field names recursively without scanning dialogue text', () => {
  const sensitiveFields = [
    'key', 'apiKey', 'api_key', 'secret', 'token', 'credential', 'password', 'model',
    'url', 'uri', 'endpoint', 'baseUrl', 'base_url', 'audioUrl', 'sourceUrl', 'callbackUrl',
    'endpointUrl', 'assetURL', 'sourceUri', 'callbackURI', 'secretToken', 'accessToken',
    'apiSecret', 'secretKey', 'modelName', 'modelId', 'credentialId', 'passwordHash',
  ]
  for (const field of sensitiveFields) {
    const pkg = makeLockedPackage()
    pkg.production_packs[0].dialogue = [{
      id: 'turn-1',
      start_ms: 100,
      end_ms: 900,
      text: 'The URL label and https://example.test are ordinary dialogue text.',
      metadata: { nested: { [field]: 'must-not-leak' } },
    }]
    assert.throws(
      () => buildFuminEpisodeExecutionPlan(pkg),
      (error) => error.code === 'FUMIN_EXECUTION_RUNTIME_CONFIG_FORBIDDEN',
      field,
    )
  }

  const rootNested = makeLockedPackage()
  rootNested.runtime = { nested: { secretToken: 'must-not-leak' } }
  assert.throws(
    () => buildFuminEpisodeExecutionPlan(rootNested),
    (error) => error.code === 'FUMIN_EXECUTION_RUNTIME_CONFIG_FORBIDDEN',
  )

  const safe = makeLockedPackage()
  safe.production_packs[0].dialogue = [{
    id: 'turn-1',
    start_ms: 100,
    end_ms: 900,
    text: 'The URL label and https://example.test are ordinary dialogue text.',
    metadata: { monkey: 'animal', keyframe: 24, modeling: 'clay' },
  }]
  assert.match(
    buildFuminEpisodeExecutionPlan(safe).units[0].dialogue[0].text,
    /URL label.*https:\/\/example\.test/,
  )
})

test('fails closed for malformed packs, references, dialogue and non-contiguous timelines', () => {
  const valid = makePack()
  const cases = [
    makePackage([{ ...valid, production_pack_hash: 'not-a-hash' }]),
    makePackage([{ ...valid, duration_ms: 4999 }]),
    makePackage([valid, makePack({ shot_id: 'shot-02', start_ms: 5001, end_ms: 6000 })]),
    makePackage([{ ...valid, dialogue: [{ id: 'outside', start_ms: -1, end_ms: 100, text: 'No.' }] }]),
    makePackage([{ ...valid, characters: [{ id: 'lead', assets: [{ kind: 'identity', sha256: '1'.repeat(64) }] }] }]),
    makePackage([valid], {
      motion_references: [
        { id: 'motion-a', shot_id: 'shot-01', sha256: '2'.repeat(64) },
        { id: 'motion-b', shot_id: 'shot-01', sha256: '3'.repeat(64) },
      ],
    }),
    makePackage([valid], {
      identity_references: [
        { id: 'duplicate', character_id: 'lead', sha256: '2'.repeat(64) },
        { id: 'duplicate', character_id: 'other', sha256: '3'.repeat(64) },
      ],
    }),
  ]

  for (const pkg of cases) {
    assert.throws(() => buildFuminEpisodeExecutionPlan(pkg), /FUMIN_EXECUTION_/)
  }
})
