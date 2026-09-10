import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import * as review from '../src/utils/redrawBlueprintReviewState.js'

// Synthetic API receipts matching Workflow.mapRow and SourceDialogueService's resolved DTO.
// No backend import, ASR execution, real media, provider call or production proof is involved.
const V2 = 'redraw-source-audio-evidence-v2'
const AUDIO_REF = 'aggregate-audio-1'
const AUDIO_SHA = 'c'.repeat(64)
const FIRST_CLUSTER = 'aw000001-speaker-cluster-1'
const SECOND_CLUSTER = 'aw000002-speaker-cluster-1'
const CORRECTION_FIELDS = ['evidence_ref', 'evidence_sha256', 'original_source_text',
  'original_start_ms', 'original_end_ms', 'source_start_ms', 'source_end_ms'].sort()
const clone = (value) => JSON.parse(JSON.stringify(value))
const entries = (blueprint) => blueprint.shots.flatMap((shot) => shot.dialogue.map((line) => ({ shot, line })))
const lineIn = (blueprint, id = 'line-1') => entries(blueprint).find(({ line }) => line.id === id).line

function fixture() {
  const meta = { evidence_refs: ['visual-1'], confidence: 0.9, review_status: 'approved' }
  const blueprint = {
    schema_version: 'episode-blueprint-v1',
    source: { asset_id: 3, sha256: 'a'.repeat(64), duration_ms: 1800000,
      width: 1920, height: 1080, fps: 25, video_codec: 'h264', audio_codec: 'aac' },
    evidence_manifest: { items: [
      { id: 'visual-1', kind: 'visual', asset_id: 901, sha256: 'd'.repeat(64), tool: 'synthetic-visual', tool_version: '1' },
      { id: AUDIO_REF, kind: 'audio_transcript', asset_id: 902, sha256: AUDIO_SHA, tool: 'synthetic-window-aggregate', tool_version: '2' },
    ] },
    story: { summary: '她保留整句线索。', beats: ['发现信封', '听到画外声音'], ...meta },
    characters: [{ id: 'character-1', source_name: '林娜', display_name: '林娜', relationship: '主人公',
      relationships: [], face_track_ids: [], ...meta }],
    scenes: [{ id: 'scene-1', location: '客厅', time: '白天', source_ranges: [{ start_ms: 0, end_ms: 1800000 }], ...meta }],
    props: [{ id: 'prop-1', name: '信封', evidence_ranges: [{ start_ms: 0, end_ms: 1800000 }], ...meta }],
    shots: [0, 1500000].map((start_ms, index) => ({ id: `shot-${index + 1}`, index: index + 1,
      start_ms, end_ms: index === 0 ? 1500000 : 1800000, scene_id: 'scene-1',
      visible_character_ids: ['character-1'], causal_previous_shot_id: index ? 'shot-1' : null,
      composition: '信封特写', camera_movement: '固定', opening_state: '信封在桌上',
      continuous_action: '伸手取信', ending_state: '拿起信封', text_regions: [], manual_boundary: true,
      confidence: { shot_boundary: 0.9 }, evidence_refs: ['visual-1'],
      audio_contract: { dialogue_mode: index ? 'spoken' : 'silent', preserve_music: true }, dialogue: [] })),
    causal_chain: [{ id: 'cause-1', cause: '发现信封', effect: '拿起信封', ...meta }],
    locked_facts: [{ id: 'fact-1', text: '信封在桌上', ...meta }],
    reversals: [{ id: 'reverse-1', text: '信里藏着秘密', ...meta }],
    episode_hook: { text: '信里写了什么？', ...meta },
    review: { status: 'needs_review' }, blueprint_hash: 'b'.repeat(64),
  }
  blueprint.shots[1].dialogue = [
    { id: 'line-1', source_text: '保留这一整句，不能自动裁剪。 Full original sentence.',
      source_language: 'zh', start_ms: 1500000, end_ms: 1502125.6, speaker_id: FIRST_CLUSTER },
    { id: 'line-2', source_text: '另一窗口同编号不代表同一人。',
      source_language: 'zh', start_ms: 1620125.4, end_ms: 1621125.6, speaker_id: SECOND_CLUSTER },
  ].map((line) => ({ ...line, speaker_kind: 'voice_cluster', off_screen: false,
    emotion: 'calm', evidence_refs: [AUDIO_REF], confidence: 0.92, review_status: 'needs_review' }))
  return {
    id: 5, work_id: 2, tenant_id: 'synthetic-tenant', user_id: 'synthetic-user', revision: 1,
    status: 'draft', blueprint_hash: blueprint.blueprint_hash, blueprint,
    evidence_manifest: clone(blueprint.evidence_manifest), reviewed_by: null, reviewed_at: null,
    created_at: '2026-09-09T02:03:04.000Z', updated_at: '2026-09-09T02:03:04.000Z',
    source_dialogue: blueprint.shots[1].dialogue.map((line, index) => ({
      shot_id: 'shot-2', dialogue_id: line.id, status: 'resolved', reason: 'SOURCE_DIALOGUE_RESOLVED',
      source_start_ms: index ? 1620125.4 : 1499125.4, source_end_ms: line.end_ms,
      source_text: line.source_text, source_language: line.source_language,
      projection_start_ms: line.start_ms, projection_end_ms: line.end_ms, cross_shot: index === 0,
      evidence_ref: AUDIO_REF, evidence_sha256: AUDIO_SHA, audio_evidence_schema_version: V2,
    })),
  }
}

function responseFor(blueprint, previous = fixture(), updatedAt = 'saved-v2') {
  const next = clone(blueprint)
  const { blueprint_hash: _hash, ...canonical } = next
  next.blueprint_hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
  return { ...clone(previous), blueprint: next, blueprint_hash: next.blueprint_hash, updated_at: updatedAt,
    evidence_manifest: clone(next.evidence_manifest),
    source_dialogue: entries(next).map(({ shot, line }) => {
      const prior = previous.source_dialogue.find((item) => item.dialogue_id === line.id)
      assert.ok(prior, 'synthetic response requires the same previously bound dialogue ID')
      const original = prior.source_origin === 'manual_correction'
        ? { text: prior.original_source_text, start: prior.original_start_ms, end: prior.original_end_ms }
        : { text: prior.source_text, start: prior.source_start_ms, end: prior.source_end_ms }
      const correction = line.source_correction
      const start = correction?.source_start_ms ?? original.start
      const end = correction?.source_end_ms ?? original.end
      return { shot_id: shot.id, dialogue_id: line.id, status: 'resolved',
        reason: correction ? 'SOURCE_DIALOGUE_MANUAL_CORRECTION_RESOLVED' : 'SOURCE_DIALOGUE_RESOLVED',
        ...(correction ? { source_origin: 'manual_correction', original_source_text: original.text,
          original_start_ms: original.start, original_end_ms: original.end } : {}),
        source_start_ms: start, source_end_ms: end, source_text: line.source_text, source_language: line.source_language,
        projection_start_ms: line.start_ms, projection_end_ms: line.end_ms,
        cross_shot: start < shot.start_ms || end > shot.end_ms,
        evidence_ref: prior.evidence_ref, evidence_sha256: prior.evidence_sha256,
        ...(prior.audio_evidence_schema_version ? { audio_evidence_schema_version: prior.audio_evidence_schema_version } : {}),
      }
    }) }
}

function mappedRecord() {
  const record = fixture()
  for (const { line } of entries(record.blueprint)) {
    Object.assign(line, { speaker_id: 'character-1', speaker_kind: 'character', review_status: 'approved' })
  }
  record.blueprint.review = { status: 'approved', reviewer: 'synthetic-human-reviewer' }
  return record
}

function legacyRecord() {
  const record = mappedRecord()
  for (const dto of record.source_dialogue) {
    delete dto.audio_evidence_schema_version
    for (const key of ['source_start_ms', 'source_end_ms', 'projection_start_ms', 'projection_end_ms']) dto[key] = Math.round(dto[key])
    const line = lineIn(record.blueprint, dto.dialogue_id)
    Object.assign(line, { start_ms: dto.projection_start_ms, end_ms: dto.projection_end_ms })
  }
  return record
}

const correctedValues = { source_text: '人工确认的完整一句。', source_start_ms: 1499125.525, source_end_ms: 1502225.85 }
const correct = (record, draft = record.blueprint, values = correctedValues, shot = 'shot-2', id = 'line-1') =>
  review.applyDialogueSourceCorrection(record, draft, shot, id, values)
const source = (record, draft = record.blueprint, shot = 'shot-2', id = 'line-1') =>
  review.dialogueSourceForReview(record, draft, shot, id)
const original = (record, draft = record.blueprint, shot = 'shot-2', id = 'line-1') =>
  review.dialogueOriginalForReview(record, draft, shot, id)
const parseSeconds = (value, record, draft = record.blueprint, shot = 'shot-2', id = 'line-1') =>
  review.dialogueSecondsToMilliseconds(value, record, draft, shot, id)

test('bound v2 DTO retains complete fractional source and clipped projection without mutating the saved receipt', () => {
  const record = fixture(), before = clone(record)
  assert.equal(record.blueprint.schema_version, 'episode-blueprint-v1')
  assert.equal(source(record).status, 'resolved')
  assert.deepEqual([source(record).source_start_ms, source(record).source_end_ms], [1499125.4, 1502125.6])
  assert.deepEqual([source(record).projection_start_ms, source(record).projection_end_ms], [1500000, 1502125.6])
  assert.equal(source(record).source_text, lineIn(record.blueprint).source_text)
  assert.equal(source(record).cross_shot, true)
  assert.equal(source(record).evidence_ref, AUDIO_REF)
  assert.equal(source(record).evidence_sha256, AUDIO_SHA)
  assert.equal(source(record).audio_evidence_schema_version, V2)
  const second = source(record, record.blueprint, 'shot-2', 'line-2')
  assert.deepEqual([second.source_start_ms, second.source_end_ms], [1620125.4, 1621125.6])
  assert.equal(second.cross_shot, false)
  assert.equal(original(record).original_start_ms, 1499125.4)
  assert.deepEqual(record, before)
})

const recordFaults = {
  'missing DTO': (record) => { delete record.source_dialogue },
  'unresolved DTO': (record) => { record.source_dialogue[0].status = 'unresolved' },
  'missing version': (record) => { delete record.source_dialogue[0].audio_evidence_schema_version },
  'wrong version': (record) => { record.source_dialogue[0].audio_evidence_schema_version = 'redraw-source-audio-evidence-v1' },
  'duplicate DTO in original shot': (record) => { record.source_dialogue.push(clone(record.source_dialogue[0])) },
  'duplicate DTO in another shot': (record) => { record.source_dialogue.push({ ...record.source_dialogue[0], shot_id: 'shot-1' }) },
  'DTO wrong original shot': (record) => { record.source_dialogue[0].shot_id = 'shot-1' },
  'duplicate saved dialogue ID': (record) => { record.blueprint.shots[0].dialogue.push(clone(lineIn(record.blueprint))) },
  'duplicate saved shot ID': (record) => { record.blueprint.shots.push(clone(record.blueprint.shots[1])) },
  'stale DTO text': (record) => { record.source_dialogue[0].source_text = 'stale' },
  'stale DTO language': (record) => { record.source_dialogue[0].source_language = 'fr' },
  'stale DTO projection': (record) => { record.source_dialogue[0].projection_end_ms += 0.1 },
  'stale DTO evidence SHA': (record) => { record.source_dialogue[0].evidence_sha256 = 'e'.repeat(64) },
  'invalid manifest asset': (record) => { record.blueprint.evidence_manifest.items[1].asset_id = 0 },
  'duplicate manifest ref': (record) => { record.blueprint.evidence_manifest.items.push(clone(record.blueprint.evidence_manifest.items[1])) },
  'non-audio manifest': (record) => { record.blueprint.evidence_manifest.items[1].kind = 'ocr' },
  'fractional source duration': (record) => { record.blueprint.source.duration_ms += 0.5 },
  'fractional shot cut': (record) => { record.blueprint.shots[1].start_ms += 0.5; lineIn(record.blueprint).start_ms += 0.5; record.source_dialogue[0].projection_start_ms += 0.5 },
}
for (const [name, mutate] of Object.entries(recordFaults)) {
  test(`v2 precision is not granted by ${name}`, () => {
    const record = fixture(); mutate(record)
    assert.notEqual(source(record).status, 'resolved')
    assert.notEqual(original(record).status, 'resolved')
    assert.throws(() => correct(record), /输入无效/)
    assert.throws(() => parseSeconds('1499.1254', record), /输入无效/)
  })
}

const draftFaults = {
  'source asset': (draft) => { draft.source.asset_id = 99 },
  'source SHA': (draft) => { draft.source.sha256 = 'e'.repeat(64) },
  'source duration': (draft) => { draft.source.duration_ms++ },
  'blueprint SHA': (draft) => { draft.blueprint_hash = 'e'.repeat(64) },
  'manifest asset identity': (draft) => { draft.evidence_manifest.items[1].asset_id = 903 },
  'manifest SHA': (draft) => { draft.evidence_manifest.items[1].sha256 = 'e'.repeat(64) },
  'manifest ref': (draft) => { draft.evidence_manifest.items[1].id = 'other-audio' },
  'dialogue evidence': (draft) => { lineIn(draft).evidence_refs = ['visual-1'] },
  'dialogue language': (draft) => { lineIn(draft).source_language = 'fr' },
  'duplicate current ID': (draft) => { draft.shots[0].dialogue.push(clone(lineIn(draft))) },
}
for (const [name, mutate] of Object.entries(draftFaults)) {
  test(`v2 original anchor rejects changed ${name} atomically`, () => {
    const record = fixture(), draft = clone(record.blueprint); mutate(draft)
    const before = clone(draft)
    assert.notEqual(source(record, draft).status, 'resolved')
    assert.notEqual(original(record, draft).status, 'resolved')
    assert.throws(() => correct(record, draft), /输入无效/)
    assert.throws(() => parseSeconds('1499.1254', record, draft), /输入无效/)
    assert.deepEqual(draft, before)
  })
}

test('draft version flags, window prefixes and another dialogue DTO cannot authorize fractional correction', () => {
  const record = fixture(), draft = clone(record.blueprint)
  delete record.source_dialogue[0].audio_evidence_schema_version
  draft.audio_evidence_schema_version = V2
  lineIn(draft).audio_evidence_schema_version = V2
  assert.throws(() => correct(record, draft), /输入无效/)
  assert.throws(() => parseSeconds('1499.1254', record, draft), /输入无效/)
  assert.throws(() => review.dialogueSecondsToMilliseconds('1499.1254', true), /输入无效/)
  assert.throws(() => review.dialogueSecondsToMilliseconds('1499.1254', { audio_evidence_schema_version: V2 }), /输入无效/)
  assert.throws(() => review.unresolvedVoiceClusters(draft, record), /输入无效/)
})

test('decimal formatter and context parser preserve original JS Numbers including exponent notation without multiply-divide drift', () => {
  const record = fixture()
  assert.equal(typeof review.dialogueMillisecondsToSeconds, 'function')
  for (const value of [0, 1001, 1000.0000000000001, 1499125.4, 1502125.6, 1620125.4, 1621125.6,
    1499125.4000000001, 1e-7, 1.0000000000000002e-7, 1e-20]) {
    const seconds = review.dialogueMillisecondsToSeconds(value)
    assert.match(seconds, /^(0|[1-9][0-9]*)(\.[0-9]+)?$/)
    assert.equal(parseSeconds(seconds, record), value, `exact Number round trip: ${value}`)
  }
  assert.equal(review.dialogueMillisecondsToSeconds(1499125.4), '1499.1254')
  assert.equal(review.dialogueMillisecondsToSeconds(1e-7), '0.0000000001')
  assert.equal(parseSeconds('1499.1254', record), 1499125.4)
})

test('legacy and missing-context seconds stay at three decimals and all contexts reject coercion or non-decimal input', () => {
  const record = fixture(), legacy = legacyRecord()
  for (const [value, expected] of [['0', 0], ['1.005', 1005], ['1499.125', 1499125]]) {
    assert.equal(review.dialogueSecondsToMilliseconds(value), expected)
    assert.equal(parseSeconds(value, legacy), expected)
  }
  for (const value of ['1499.1254', '0.0001']) {
    assert.throws(() => review.dialogueSecondsToMilliseconds(value), /输入无效/)
    assert.throws(() => parseSeconds(value, legacy), /输入无效/)
    assert.throws(() => review.dialogueSecondsToMilliseconds(value, record), /输入无效/)
  }
  for (const value of ['', ' ', '-1', '1e3', 'Infinity', 'NaN', '0x10', '.5', '1.', true, 1,
    '9007199254741.999', '99999999999999999999999.9999']) {
    assert.throws(() => review.dialogueSecondsToMilliseconds(value), /输入无效/)
    assert.throws(() => parseSeconds(value, record), /输入无效/)
  }
  assert.throws(() => correct(legacy), /输入无效/, 'the same fractional correction remains invalid for v1')
})

test('v2 corrections retain exactly the seven original anchor fields through edit, save, re-read and restore', () => {
  const record = fixture(), before = clone(record), first = correct(record)
  const anchor = lineIn(first).source_correction
  assert.deepEqual(Object.keys(anchor).sort(), CORRECTION_FIELDS)
  assert.deepEqual(anchor, { evidence_ref: AUDIO_REF, evidence_sha256: AUDIO_SHA,
    original_source_text: lineIn(record.blueprint).source_text, original_start_ms: 1499125.4, original_end_ms: 1502125.6,
    source_start_ms: correctedValues.source_start_ms, source_end_ms: correctedValues.source_end_ms })
  assert.deepEqual([lineIn(first).start_ms, lineIn(first).end_ms], [1500000, 1502225.85])
  assert.equal(source(record, first).status, 'unresolved', 'unsaved projection is not a resolved server DTO')
  assert.equal(original(record, first).status, 'resolved', 'editing may keep the original saved anchor')
  const second = correct(record, first, { ...correctedValues, source_text: '再次修订。' })
  assert.deepEqual(lineIn(second).source_correction, anchor)
  const saved = responseFor(second, record), reread = clone(saved)
  assert.equal(source(reread).status, 'resolved')
  assert.equal(source(reread).audio_evidence_schema_version, V2)
  const third = correct(reread, reread.blueprint, { ...correctedValues, source_start_ms: 1499125.6500000001 })
  assert.equal(lineIn(third).source_correction.original_start_ms, 1499125.4)
  const restored = review.restoreDialogueSourceCorrection(reread, third, 'shot-2', 'line-1')
  assert.equal(lineIn(restored).source_correction, undefined)
  assert.deepEqual([lineIn(restored).source_text, lineIn(restored).start_ms, lineIn(restored).end_ms],
    [lineIn(record.blueprint).source_text, 1500000, 1502125.6])
  assert.equal(lineIn(restored).review_status, 'needs_review')
  assert.equal(source(reread, restored).status, 'unresolved')
  const savedRestored = responseFor(restored, reread, 'restored')
  assert.equal(source(savedRestored).status, 'resolved')
  assert.equal(source(savedRestored).source_start_ms, 1499125.4)
  assert.deepEqual(lineIn(first, 'line-2'), lineIn(record.blueprint, 'line-2'))
  assert.deepEqual(record, before)
})

test('v2 corrections reject a forged saved manual anchor and never serialize schema or context into source_correction', () => {
  const saved = responseFor(correct(fixture()))
  for (const mutate of [
    (record) => { record.source_dialogue[0].original_start_ms += 0.1 },
    (record) => { record.source_dialogue[0].original_source_text = 'forged' },
    (record) => { delete record.source_dialogue[0].original_end_ms },
    (record) => { lineIn(record.blueprint).source_correction.audio_evidence_schema_version = V2 },
    (record) => { lineIn(record.blueprint).source_correction.context = {} },
  ]) {
    const record = clone(saved); mutate(record)
    assert.throws(() => correct(record), /输入无效/)
  }
})

test('v2 original anchor remains usable after legal cross-shot migration and another unsaved correction', () => {
  const record = fixture(), corrected = correct(record)
  const moved = review.applyAdjacentBoundaryCorrection(record, corrected, 'shot-1', 'shot-2', {
    boundary_ms: 1499500, assignments: [
      { dialogue_id: 'line-1', target_shot_id: 'shot-1' }, { dialogue_id: 'line-2', target_shot_id: 'shot-2' },
    ],
  })
  assert.equal(source(record, moved, 'shot-1').status, 'unresolved')
  assert.equal(original(record, moved, 'shot-1').status, 'resolved')
  assert.equal(parseSeconds('1499.125525', record, moved, 'shot-1'), 1499125.525)
  assert.deepEqual([lineIn(moved).start_ms, lineIn(moved).end_ms], [1499125.525, 1499500])
  const again = correct(record, moved, { ...correctedValues, source_text: '迁移后仍可修订。' }, 'shot-1')
  assert.deepEqual(lineIn(again).source_correction, lineIn(corrected).source_correction)
  const saved = responseFor(again, record)
  assert.equal(source(saved, saved.blueprint, 'shot-1').status, 'resolved')
  const restored = review.restoreDialogueSourceCorrection(saved, saved.blueprint, 'shot-1', 'line-1')
  assert.deepEqual([lineIn(restored).start_ms, lineIn(restored).end_ms], [1499125.4, 1499500])
  assert.equal(lineIn(restored).source_correction, undefined)
  for (const shot of restored.shots) {
    assert.equal(Number.isSafeInteger(shot.start_ms), true)
    assert.equal(Number.isSafeInteger(shot.end_ms), true)
  }
  assert.deepEqual(restored.scenes, record.blueprint.scenes)
  assert.deepEqual(restored.source, record.blueprint.source)
})

test('v2 context never permits fractional shared shot cuts', () => {
  const record = fixture()
  assert.throws(() => review.applyAdjacentBoundaryCorrection(record, record.blueprint, 'shot-1', 'shot-2', {
    boundary_ms: 1499500.4, assignments: [
      { dialogue_id: 'line-1', target_shot_id: 'shot-2' }, { dialogue_id: 'line-2', target_shot_id: 'shot-2' },
    ],
  }), /输入无效/)
})

function preservedSpeakerFields(line) {
  const { speaker_id, speaker_kind, off_screen, review_status, ...preserved } = line
  return preserved
}

test('two window-local cluster-1 identities remain distinct and map independently without changing source evidence', () => {
  const record = fixture(), before = clone(record)
  assert.deepEqual(review.unresolvedVoiceClusters(record.blueprint, record), [
    { id: FIRST_CLUSTER, dialogue_count: 1 }, { id: SECOND_CLUSTER, dialogue_count: 1 },
  ])
  const mapped = review.mapVoiceClusterToCharacter(record.blueprint, FIRST_CLUSTER, 'character-1', record)
  assert.equal(lineIn(mapped).speaker_id, 'character-1')
  assert.equal(lineIn(mapped, 'line-2').speaker_id, SECOND_CLUSTER)
  assert.equal(source(record, mapped).status, 'resolved')
  assert.deepEqual(review.unresolvedVoiceClusters(mapped, record), [{ id: SECOND_CLUSTER, dialogue_count: 1 }])
  const created = review.createOffScreenCharacterForCluster(mapped, SECOND_CLUSTER, { id: 'narrator-2', name: '画外讲述人' }, record)
  assert.deepEqual(review.unresolvedVoiceClusters(created, record), [])
  assert.deepEqual([lineIn(created, 'line-2').speaker_id, lineIn(created, 'line-2').speaker_kind, lineIn(created, 'line-2').off_screen],
    ['narrator-2', 'off_screen', true])
  assert.equal(created.characters.at(-1).display_name, '画外讲述人')
  for (const id of ['line-1', 'line-2']) {
    assert.deepEqual(preservedSpeakerFields(lineIn(created, id)), preservedSpeakerFields(lineIn(record.blueprint, id)))
    assert.equal(source(record, created, 'shot-2', id).status, 'resolved')
  }
  for (const key of ['source', 'evidence_manifest', 'scenes', 'blueprint_hash']) assert.deepEqual(created[key], record.blueprint[key])
  assert.deepEqual(record, before)
})

test('window and local cluster indices use numeric order rather than local suffix collisions or lexicographic order', () => {
  const record = fixture(), base = clone(lineIn(record.blueprint)), dto = clone(record.source_dialogue[0])
  const ids = ['aw000010-speaker-cluster-1', 'aw000002-speaker-cluster-10', 'aw000002-speaker-cluster-2', FIRST_CLUSTER]
  record.blueprint.shots[1].dialogue = ids.map((speaker_id, index) => ({ ...base, id: `ordered-${index}`, speaker_id }))
  record.source_dialogue = ids.map((_id, index) => ({ ...dto, dialogue_id: `ordered-${index}` }))
  assert.deepEqual(review.unresolvedVoiceClusters(record.blueprint, record).map((item) => item.id),
    [FIRST_CLUSTER, 'aw000002-speaker-cluster-2', 'aw000002-speaker-cluster-10', 'aw000010-speaker-cluster-1'])
})

test('namespaced clusters require their own saved record and cannot borrow another dialogue authorization', () => {
  const record = fixture()
  assert.throws(() => review.unresolvedVoiceClusters(record.blueprint), /输入无效/)
  assert.throws(() => review.mapVoiceClusterToCharacter(record.blueprint, FIRST_CLUSTER, 'character-1'), /输入无效/)
  assert.throws(() => review.createOffScreenCharacterForCluster(record.blueprint, FIRST_CLUSTER, { id: 'n', name: 'N' }), /输入无效/)
  const draft = clone(record.blueprint)
  lineIn(draft).speaker_id = SECOND_CLUSTER
  assert.throws(() => review.unresolvedVoiceClusters(draft, record), /输入无效/)
  assert.throws(() => review.mapVoiceClusterToCharacter(draft, SECOND_CLUSTER, 'character-1', record), /输入无效/)
  assert.throws(() => review.createOffScreenCharacterForCluster(draft, SECOND_CLUSTER, { id: 'n', name: 'N' }, record), /输入无效/)
  const mapped = mappedRecord()
  lineIn(mapped.blueprint).speaker_kind = 'character'
  const forged = clone(mapped.blueprint)
  Object.assign(lineIn(forged), { speaker_kind: 'voice_cluster', speaker_id: FIRST_CLUSTER })
  assert.throws(() => review.unresolvedVoiceClusters(forged, mapped), /输入无效/)
})

test('v1 helpers remain callable with their old signatures and do not acquire a v2 review-only blocker', () => {
  const record = legacyRecord(), blueprint = clone(record.blueprint)
  Object.assign(lineIn(blueprint), { speaker_kind: 'voice_cluster', speaker_id: 'speaker-cluster-2' })
  Object.assign(lineIn(blueprint, 'line-2'), { speaker_kind: 'voice_cluster', speaker_id: 'speaker-cluster-1' })
  assert.deepEqual(review.unresolvedVoiceClusters(blueprint).map((item) => item.id), ['speaker-cluster-1', 'speaker-cluster-2'])
  const mapped = review.mapVoiceClusterToCharacter(blueprint, 'speaker-cluster-1', 'character-1')
  const created = review.createOffScreenCharacterForCluster(mapped, 'speaker-cluster-2', { id: 'legacy-narrator', name: 'Legacy' })
  const approved = review.approveBlueprintReview(created, 'legacy-reviewer')
  assert.deepEqual(review.blueprintLockBlockers(approved), [])
  assert.equal(review.canStartLocalization({ ...record, blueprint: approved, status: 'draft' }), false)
  assert.equal(review.canStartLocalization({ ...record, blueprint: approved, status: 'locked' }), true)
})

test('mapped and approved v2 is lockable while localization still waits for the locked receipt', () => {
  const record = mappedRecord()
  record.blueprint.review = { status: 'needs_review' }
  const approved = review.approveBlueprintReview(record.blueprint, 'v2-reviewer', record)
  assert.deepEqual(approved.review, { status: 'approved', reviewer: 'v2-reviewer' })
  assert.deepEqual(review.blueprintLockBlockers(approved, record), [])
  const saved = responseFor(approved, record)
  assert.deepEqual(review.buildBlueprintSavePayload(saved).blueprint, saved.blueprint)
  assert.equal(review.canStartLocalization(saved), false)
})

const panelSource = readFileSync(new URL('../src/components/redraw/RedrawBlueprintReviewPanel.vue', import.meta.url), 'utf8')
const descriptor = parse(panelSource).descriptor
const compiled = compileScript(descriptor, { id: 'audio-v2-review-runtime' })
const script = compiled.content.replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '').replace('export default', 'return')
const templateCode = compileTemplate({ source: descriptor.template.content, filename: 'RedrawBlueprintReviewPanel.vue',
  id: 'audio-v2-review-runtime', compilerOptions: { bindingMetadata: compiled.bindings } }).code
  .replace(/import\s*\{([^}]+)\}\s*from\s*["']vue["']/g, (_match, imports) =>
    `const { ${imports.replace(/\bas\b/g, ':')} } = Vue`)
  .replace('export function render', 'return function render')
const renderTemplate = new Function('Vue', templateCode)(vue)
const shell = (tag) => ({ inheritAttrs: false, setup(_props, { attrs, slots }) { return () => vue.h(tag, attrs, slots.default?.()) } })
const tick = async () => { await vue.nextTick(); await Promise.resolve(); await vue.nextTick() }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function runtime(t, record = fixture(), api = {}) {
  const scope = vue.effectScope(), hooks = [], calls = [], emitted = [], urls = [], revoked = []
  let lastRecord = clone(record)
  const bindings = { ...review, computed: vue.computed, defineComponent: vue.defineComponent, h: vue.h,
    reactive: vue.reactive, ref: vue.ref, watch: vue.watch, ElButton: shell('button'), ElInput: shell('input'),
    onBeforeUnmount(fn) { hooks.push(fn) },
    URL: { createObjectURL(blob) { assert.ok(blob instanceof Blob); const url = `blob:v2-synthetic-${urls.length}`; urls.push(url); return url },
      revokeObjectURL(url) { revoked.push(url) } },
    redrawAPI: {
      getSourceVideo: async (...args) => { calls.push(['media', ...args]); return new Blob(['synthetic-video'], { type: 'video/mp4' }) },
      saveBlueprint: async (id, body) => {
        calls.push(['save', id, clone(body)])
        lastRecord = responseFor(body.blueprint, lastRecord, `saved-${calls.filter(([name]) => name === 'save').length}`)
        return clone(lastRecord)
      },
      lockBlueprint: async (...args) => {
        calls.push(['lock', ...args])
        lastRecord = { ...clone(lastRecord), status: 'locked', blueprint: { ...clone(lastRecord.blueprint), review: {
          ...clone(lastRecord.blueprint.review), status: 'locked' } } }
        return clone(lastRecord)
      },
      generate: async (...args) => { calls.push(['generate', ...args]); throw new Error('review cannot generate') },
      ...api,
    },
  }
  const component = new Function(...Object.keys(bindings), script)(...Object.values(bindings))
  const props = vue.reactive({ record, work: { id: record.work_id, source_asset_id: 3, source_fingerprint: 'a'.repeat(64),
    url: 'https://not-used.invalid/source.mp4' }, loading: false, error: '' })
  const state = scope.run(() => component.setup(props, { expose() {}, emit(...args) { emitted.push(args) } }))
  let app, closed = false, restoreDocument = () => {}
  const dispose = () => {
    if (!closed) {
      closed = true
      try { app?.unmount(); hooks.forEach((fn) => fn()); scope.stop() }
      finally { restoreDocument() }
    }
  }
  t.after(dispose)
  function render() {
    assert.equal(app, undefined, 'mount the real compiled template only once per runtime')
    // Vue's real v-model directives require DOM events/value and document.activeElement.
    if (typeof globalThis.document === 'undefined') {
      const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
      Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { activeElement: null } })
      restoreDocument = () => {
        if (previous) Object.defineProperty(globalThis, 'document', previous)
        else delete globalThis.document
      }
    }
    const node = (kind, text = '') => {
      const item = Object.assign(new EventTarget(), {
        kind, tagName: kind.toUpperCase(), text, props: {}, children: [], parent: null,
        value: '', type: '', checked: false, selected: false, multiple: false,
      })
      Object.defineProperties(item, {
        options: { get() { return this.children.flatMap((child) => child.kind === 'option' ? [child] : child.kind === 'optgroup' ? child.options : []) } },
        selectedIndex: {
          get() { return this.options.findIndex((option) => option.selected) },
          set(index) { this.options.forEach((option, position) => { option.selected = position === index }) },
        },
      })
      return item
    }
    const detach = (child) => { if (child.parent) { const list = child.parent.children; list.splice(list.indexOf(child), 1); child.parent = null } }
    const renderer = vue.createRenderer({
      createElement: (tag) => node(tag), createText: (text) => node('text', text), createComment: (text) => node('comment', text),
      setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
      patchProp(item, key, _old, value) {
        item.props[key] = value
        if (['value', 'type', 'checked', 'selected'].includes(key)) item[key] = value
        if (key === 'multiple') item.multiple = value === '' || Boolean(value)
        if (key === 'value') item._value = value
      },
      insert(child, parent, anchor = null) { detach(child); child.parent = parent; const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, child) },
      remove: detach, parentNode: (item) => item.parent,
      nextSibling: (item) => item.parent?.children[item.parent.children.indexOf(item) + 1] || null,
    })
    const context = vue.proxyRefs({ ...state, ...props }), cache = []
    app = renderer.createApp({ setup: () => () => renderTemplate(context, cache, props, context) })
    for (const name of ['el-tag', 'el-alert', 'el-empty', 'el-select', 'el-option']) app.component(name, shell('div'))
    const root = node('root'); app.mount(root)
    const textOf = (item) => item.kind === 'comment' ? '' : `${item.text}${item.children.map(textOf).join('')}`
    const all = (item) => [item, ...item.children.flatMap(all)]
    return { text: () => textOf(root), nodes: () => all(root), button: (label) => all(root).find((item) => item.kind === 'button' && textOf(item) === label) }
  }
  return { state, props, calls, emitted, urls, revoked, dispose, render }
}

test('actual SFC loads v2 into the ordinary review and renders full and projected fractional timing with two independent clusters', (t) => {
  const { state, calls, render } = runtime(t), view = render()
  assert.equal(state.canEdit.value, true)
  assert.equal(state.sourceDialogue('shot-2', 'line-1').status, 'resolved')
  assert.deepEqual(state.unresolved.value.map((item) => item.id), [FIRST_CLUSTER, SECOND_CLUSTER])
  assert.match(view.text(), /整句源范围：24:59\.1254\s*–\s*25:02\.1256/)
  assert.match(view.text(), /镜头内显示范围：25:00\s*–\s*25:02\.1256/)
  assert.match(view.text(), /27:00\.1254\s*–\s*27:01\.1256/)
  assert.match(view.text(), /保留这一整句，不能自动裁剪。 Full original sentence\./)
  assert.ok(view.text().includes(FIRST_CLUSTER)); assert.ok(view.text().includes(SECOND_CLUSTER))
  assert.equal(view.button('锁定母本蓝图').props.disabled, true)
  assert.deepEqual(calls, [])
})

test('actual SFC begin and unchanged apply preserve fractional Numbers instead of rounding to milliseconds', async (t) => {
  const { state, calls, render } = runtime(t), view = render()
  state.beginDialogueEdit('shot-2', 'line-1')
  assert.equal(state.dialogueEdit.value.start_seconds, '1499.1254')
  assert.equal(state.dialogueEdit.value.end_seconds, '1502.1256')
  await tick()
  assert.doesNotMatch(view.text(), /精确到\s*0\.001\s*秒/, 'v2 decimal guidance must not promise integer-millisecond precision only')
  state.applyDialogueEdit()
  assert.equal(state.localError.value, '')
  assert.equal(state.dialogueEdit.value, null)
  assert.deepEqual([lineIn(state.draftBlueprint.value).source_correction.source_start_ms,
    lineIn(state.draftBlueprint.value).source_correction.source_end_ms], [1499125.4, 1502125.6])
  assert.deepEqual(Object.keys(lineIn(state.draftBlueprint.value).source_correction).sort(), CORRECTION_FIELDS)
  assert.equal(state.originalDialogue('shot-2', 'line-1').status, 'resolved')
  assert.deepEqual(calls, [])
})

test('actual SFC preserves a floating-point round-trip trap when the original decimal editor is submitted unchanged', (t) => {
  const record = fixture()
  record.source_dialogue[0].source_start_ms = 1499125.4000000001
  const { state } = runtime(t, record)
  state.beginDialogueEdit('shot-2', 'line-1')
  assert.ok(state.dialogueEdit.value)
  state.applyDialogueEdit()
  assert.equal(lineIn(state.draftBlueprint.value).source_correction.source_start_ms, 1499125.4000000001)
})

test('actual SFC edits, saves a current resolved receipt, re-reads, restores and saves the untouched original fractional range', async (t) => {
  const { state, props, calls, emitted, render } = runtime(t), view = render()
  state.beginDialogueEdit('shot-2', 'line-1')
  Object.assign(state.dialogueEdit.value, { source_text: correctedValues.source_text, start_seconds: '1499.125525', end_seconds: '1502.22585' })
  props.work = { ...props.work, progress: 80 }; await tick()
  assert.equal(state.dialogueEdit.value.source_text, correctedValues.source_text)
  state.applyDialogueEdit(); await tick()
  assert.equal(state.sourceDialogue('shot-2', 'line-1').status, 'unresolved')
  assert.match(view.text(), /人工确认的完整一句。/)
  assert.match(view.text(), /24:59\.125525\s*–\s*25:02\.22585/)
  const saved = await state.saveDraft()
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'save')
  assert.equal(calls[0][2].expected_updated_at, fixture().updated_at)
  assert.deepEqual(Object.keys(lineIn(calls[0][2].blueprint).source_correction).sort(), CORRECTION_FIELDS)
  assert.equal(state.dirty.value, false)
  assert.equal(state.sourceDialogue('shot-2', 'line-1').status, 'resolved')
  assert.equal(state.recordState.value.blueprint_hash, saved.blueprint_hash)
  props.record = clone(saved); await tick()
  state.beginDialogueEdit('shot-2', 'line-1')
  assert.equal(state.dialogueEdit.value.start_seconds, '1499.125525')
  state.cancelDialogueEdit(); state.restoreDialogue('shot-2', 'line-1')
  assert.equal(lineIn(state.draftBlueprint.value).source_correction, undefined)
  assert.equal(lineIn(state.draftBlueprint.value).end_ms, 1502125.6)
  await state.saveDraft()
  assert.equal(state.sourceDialogue('shot-2', 'line-1').source_start_ms, 1499125.4)
  assert.equal(calls[1][2].expected_updated_at, saved.updated_at)
  assert.deepEqual(emitted.map(([name]) => name), ['updated', 'updated'])
  assert.ok(calls.every(([name]) => name === 'save'))
})

test('actual SFC maps each window, creates an offscreen role, approves, saves and locks v2 into Facts eligibility', async (t) => {
  const { state, calls, render } = runtime(t), view = render()
  const before = clone(state.draftBlueprint.value)
  state.mapCluster(FIRST_CLUSTER, 'character-1')
  assert.equal(state.localError.value, '')
  assert.deepEqual(state.unresolved.value.map((item) => item.id), [SECOND_CLUSTER])
  state.toggleOffScreen(SECOND_CLUSTER)
  Object.assign(state.offScreenDrafts[SECOND_CLUSTER], { id: 'narrator-2', name: '第二窗画外人物' })
  state.createOffScreen(SECOND_CLUSTER)
  assert.equal(state.unresolved.value.length, 0)
  for (const id of ['line-1', 'line-2']) {
    assert.deepEqual(preservedSpeakerFields(lineIn(state.draftBlueprint.value, id)), preservedSpeakerFields(lineIn(before, id)))
    assert.equal(state.sourceDialogue('shot-2', id).status, 'resolved')
  }
  state.reviewer.value = 'human-v2-reviewer'; await tick()
  assert.equal(view.button('确认母本事实审核').props.disabled, false, 'review-only must not disable the real human approval control')
  state.approveReview()
  assert.equal(state.localError.value, '')
  assert.equal(state.draftBlueprint.value.review.status, 'approved')
  assert.deepEqual(state.lockBlockers.value, [])
  await tick()
  assert.equal(view.button('锁定母本蓝图').props.disabled, false)
  await state.lockDraft()
  assert.deepEqual(calls.map(([name]) => name), ['save', 'lock'])
  assert.equal(state.sourceDialogue('shot-2', 'line-1').status, 'resolved')
  assert.equal(review.canStartLocalization(state.recordState.value), true)
})

test('actual SFC uses the newly saved v2 DTO in the pre-lock recheck and continues to lock', async (t) => {
  const record = legacyRecord()
  const { state, calls, emitted } = runtime(t, record, { saveBlueprint: async (id, body) => {
    calls.push(['save', id, clone(body)])
    const saved = responseFor(body.blueprint, record, 'new-v2-cas')
    for (const dto of saved.source_dialogue) dto.audio_evidence_schema_version = V2
    return saved
  } })
  state.replaceDraft(clone(state.draftBlueprint.value))
  assert.deepEqual(state.lockBlockers.value, [])
  await state.lockDraft()
  assert.deepEqual(calls.map(([name]) => name), ['save', 'lock'])
  assert.equal(state.dirty.value, false)
  assert.equal(state.recordState.value.status, 'locked')
  assert.deepEqual(emitted.map(([name]) => name), ['updated', 'locked'])
  assert.equal(state.locking.value, false)
})

test('actual SFC permits v2 migration then editing in the new shot, but keeps the shared cut integer-only', (t) => {
  const { state, calls } = runtime(t)
  state.beginBoundaryEdit('shot-1')
  state.boundaryEdit.value.boundary_seconds = '1499.5004'
  state.applyBoundaryEdit()
  assert.match(state.localError.value, /输入无效/)
  assert.equal(state.dirty.value, false)
  state.boundaryEdit.value.boundary_seconds = '1499.5'
  state.boundaryEdit.value.assignments.find((item) => item.dialogue_id === 'line-1').target_shot_id = 'shot-1'
  state.applyBoundaryEdit()
  assert.equal(state.localError.value, '')
  assert.equal(state.draftBlueprint.value.shots[0].dialogue[0].id, 'line-1')
  state.beginDialogueEdit('shot-1', 'line-1')
  assert.equal(state.dialogueEdit.value.start_seconds, '1499.1254')
  state.dialogueEdit.value.source_text = '移镜后编辑。'; state.applyDialogueEdit()
  assert.equal(lineIn(state.draftBlueprint.value).source_text, '移镜后编辑。')
  assert.equal(lineIn(state.draftBlueprint.value).end_ms, 1499500)
  assert.deepEqual(calls, [])
})

test('actual SFC source playback uses the full v2 range and stops at the full fractional endpoint', async (t) => {
  const { state, calls, urls } = runtime(t)
  await state.loadSourceVideo()
  assert.equal(state.sourceUrl.value, urls[0])
  let plays = 0, pauses = 0
  const player = { currentTime: 0, readyState: 1, duration: 1800, play: async () => { plays++ }, pause() { pauses++ } }
  state.sourcePlayer.value = player
  await state.playSourceDialogue('shot-2', 'line-1')
  assert.equal(plays, 1); assert.equal(player.currentTime, 1499125.4 / 1000)
  const priorPauses = pauses
  player.currentTime = 1502.125; state.onSourceTimeUpdate(); assert.equal(pauses, priorPauses)
  player.currentTime = 1502.126; state.onSourceTimeUpdate(); assert.equal(pauses, priorPauses + 1)
  assert.deepEqual(calls[0].slice(0, 3), ['media', 2, { asset_id: 3, sha256: 'a'.repeat(64) }])
  assert.equal(calls.length, 1)
})

for (const transition of ['work-cycle', 'source-asset', 'source-SHA', 'revision', 'locked', 'conflict', 'unmount']) {
  test(`actual SFC ${transition} invalidates the v2 editor, mapping and stale actions`, async (t) => {
    const { state, props, calls, dispose } = runtime(t)
    state.beginDialogueEdit('shot-2', 'line-1')
    assert.ok(state.dialogueEdit.value)
    state.dialogueEdit.value.source_text = 'Must not leak'
    state.toggleOffScreen(SECOND_CLUSTER)
    Object.assign(state.offScreenDrafts[SECOND_CLUSTER], { id: 'stale-role', name: 'Must not leak' })
    if (transition === 'work-cycle') { props.work.id = 99; props.work.id = 2 }
    if (transition === 'source-asset') props.work.source_asset_id = 99
    if (transition === 'source-SHA') props.work.source_fingerprint = 'e'.repeat(64)
    if (transition === 'revision') props.record = { ...fixture(), revision: 2, updated_at: 'revision-2' }
    if (transition === 'locked') props.record = { ...fixture(), status: 'locked' }
    if (transition === 'conflict') state.conflict.value = true
    if (transition === 'unmount') dispose()
    if (transition === 'unmount') assert.equal(state.canEdit.value, false, 'unmount invalidates the previously cached editable state')
    assert.equal(state.dialogueEdit.value, null)
    const before = clone(state.draftBlueprint.value)
    state.applyDialogueEdit()
    if (['source-asset', 'source-SHA', 'locked', 'conflict', 'unmount'].includes(transition)) {
      state.mapCluster(FIRST_CLUSTER, 'character-1'); state.createOffScreen(SECOND_CLUSTER)
      state.restoreDialogue('shot-2', 'line-1')
      await state.saveDraft(); await state.lockDraft()
    }
    assert.deepEqual(clone(state.draftBlueprint.value), before)
    assert.deepEqual(calls, [])
  })
}

for (const transition of ['work-cycle', 'source', 'revision', 'unmount']) {
  for (const outcome of ['success', '409']) {
    test(`actual v2 save ignores late ${outcome} after ${transition}`, async (t) => {
      const late = deferred(), { state, props, emitted, dispose } = runtime(t, fixture(), { saveBlueprint: () => late.promise })
      state.beginDialogueEdit('shot-2', 'line-1'); state.dialogueEdit.value.source_text = 'Old edit'; state.applyDialogueEdit()
      const pending = state.saveDraft()
      if (transition === 'work-cycle') { props.work.id = 99; props.work.id = 2 }
      if (transition === 'source') props.work.source_fingerprint = 'e'.repeat(64)
      if (transition === 'revision') props.record = { ...fixture(), revision: 2, updated_at: 'new-revision' }
      if (transition === 'unmount') dispose()
      const before = clone(state.draftBlueprint.value)
      if (outcome === 'success') late.resolve(responseFor(correct(fixture()), fixture(), 'late-save'))
      else late.reject({ response: { status: 409 } })
      await pending
      assert.deepEqual(clone(state.draftBlueprint.value), before)
      assert.equal(state.conflict.value, false)
      assert.equal(state.localError.value, '')
      assert.deepEqual(emitted, [])
    })
  }
}

test('actual current v2 save 409 retains dirty correction, freezes actions and never retries or locks', async (t) => {
  const calls = []
  const { state } = runtime(t, fixture(), { saveBlueprint: async (...args) => { calls.push(args); throw { response: { status: 409 } } } })
  state.beginDialogueEdit('shot-2', 'line-1'); state.dialogueEdit.value.source_text = 'Retain me'; state.applyDialogueEdit()
  const before = clone(state.draftBlueprint.value)
  await state.saveDraft()
  assert.equal(state.conflict.value, true); assert.equal(state.dirty.value, true)
  assert.deepEqual(clone(state.draftBlueprint.value), before)
  assert.equal(state.visibleError.value, '母本蓝图已变化，请刷新后重试')
  await state.saveDraft(); await state.lockDraft()
  assert.equal(calls.length, 1)
})

test('silent review without source DTOs does not invent a v2 version or client proof of Facts eligibility', (t) => {
  const record = legacyRecord()
  for (const shot of record.blueprint.shots) { shot.dialogue = []; shot.audio_contract.dialogue_mode = 'silent' }
  record.source_dialogue = []
  const { state } = runtime(t, record)
  assert.equal(state.canEdit.value, true)
  assert.equal(state.sourceDialogue('shot-2', 'missing').status, 'unresolved')
  assert.equal(state.lockBlockers.value.length, 0)
  assert.equal(review.canStartLocalization(state.recordState.value), false)
  assert.equal(Object.hasOwn(state.draftBlueprint.value, 'audio_evidence_schema_version'), false)
})
