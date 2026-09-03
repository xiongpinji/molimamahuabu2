import test from 'node:test'
import assert from 'node:assert/strict'

import {
  approveCharacterReview,
  approveDialogueReview,
  approveBlueprintReview,
  blueprintLockBlockers,
  buildBlueprintLockPayload,
  buildBlueprintSavePayload,
  canStartLocalization,
  createOffScreenCharacterForCluster,
  mapVoiceClusterToCharacter,
  unresolvedVoiceClusters,
} from './redrawBlueprintReviewState.js'
import {
  canConfirmLocalization,
  redrawWorkflowPhase,
} from './redrawWorkspaceState.js'

function fixtureBlueprint() {
  return {
    schema_version: 'episode-blueprint-v1',
    source: { sha256: 'a'.repeat(64) },
    evidence_manifest: {
      items: [{ id: 'evidence-audio-1', kind: 'audio_transcript', sha256: 'b'.repeat(64) }],
    },
    story: { summary: '雨夜送达一份订单。' },
    characters: [{
      id: 'character-lead',
      source_name: '男主',
      display_name: '男主',
      relationship: '骑手',
      relationships: [],
      face_track_ids: ['face-track-1'],
      evidence_refs: ['evidence-visual-1'],
      confidence: 0.9,
      review_status: 'approved',
    }],
    shots: [{
      id: 'shot-1',
      visible_character_ids: ['character-lead'],
      dialogue: [{
        id: 'dialogue-1',
        speaker_id: 'speaker-cluster-10',
        speaker_kind: 'voice_cluster',
        off_screen: false,
        source_text: '订单到了。',
        evidence_refs: ['evidence-audio-1'],
        confidence: 0.72,
        review_status: 'needs_review',
      }],
    }, {
      id: 'shot-2',
      visible_character_ids: [],
      dialogue: [{
        id: 'dialogue-2',
        speaker_id: 'speaker-cluster-2',
        speaker_kind: 'voice_cluster',
        off_screen: true,
        source_text: '她以为结束了。',
        evidence_refs: ['evidence-audio-1'],
        confidence: 0.61,
        review_status: 'needs_review',
      }],
    }, {
      id: 'shot-3',
      visible_character_ids: [],
      dialogue: [{
        id: 'dialogue-3',
        speaker_id: 'speaker-cluster-10',
        speaker_kind: 'voice_cluster',
        off_screen: false,
        source_text: '不要开门。',
        evidence_refs: ['evidence-audio-1'],
        confidence: 0.68,
        review_status: 'needs_review',
      }],
    }],
    review: { status: 'needs_review' },
    blueprint_hash: 'c'.repeat(64),
  }
}

test('blocks localization until and unless the persisted blueprint status is locked', () => {
  assert.equal(canStartLocalization({ status: 'locked' }), true)
  assert.equal(canStartLocalization({ blueprint: { status: 'locked' } }), true)
  assert.equal(canStartLocalization({ status: 'review', blueprint: { status: 'locked' } }), false)
  assert.equal(canStartLocalization({ status: 'draft' }), false)
  assert.equal(canStartLocalization({ blueprint: { review: { status: 'locked' } } }), false)
  assert.equal(canStartLocalization(null), false)
})

test('derives explicit blueprint review phases while preserving legacy works without a blueprint', () => {
  const work = {
    id: 710,
    current_step: 2,
    workflow_phase: 'analysis_review',
    analysis_task: { status: 'completed' },
    localization_quote: { priced: true, credits: 9, quote_hash: 'q'.repeat(64) },
  }
  assert.equal(redrawWorkflowPhase(work), 'analysis_review')
  assert.equal(redrawWorkflowPhase(work, null), 'analysis_review')
  assert.equal(redrawWorkflowPhase(work, { status: 'draft' }), 'blueprint_review')
  assert.equal(redrawWorkflowPhase(work, { status: 'locked' }), 'blueprint_locked')
  assert.equal(canConfirmLocalization(work, undefined, { status: 'draft' }), false)
  assert.equal(canConfirmLocalization(work, undefined, { status: 'locked' }), true)
})

test('builds exact CAS-safe save and lock payloads without retaining mutable references', () => {
  const record = {
    updated_at: '2026-09-03T10:00:00.000Z',
    blueprint_hash: 'd'.repeat(64),
    blueprint: fixtureBlueprint(),
  }
  const save = buildBlueprintSavePayload(record)
  const lock = buildBlueprintLockPayload(record)

  assert.deepEqual(save, {
    expected_updated_at: record.updated_at,
    blueprint: record.blueprint,
  })
  assert.notEqual(save.blueprint, record.blueprint)
  assert.deepEqual(lock, {
    expected_blueprint_hash: record.blueprint_hash,
    expected_updated_at: record.updated_at,
  })
  assert.throws(() => buildBlueprintSavePayload({ blueprint: {} }), /updated_at/)
  assert.throws(() => buildBlueprintLockPayload({ updated_at: record.updated_at, blueprint_hash: 'bad' }), /blueprint_hash/)
})

test('lists unresolved voice clusters in deterministic numeric order with dialogue counts', () => {
  assert.deepEqual(unresolvedVoiceClusters(fixtureBlueprint()), [
    { id: 'speaker-cluster-2', dialogue_count: 1 },
    { id: 'speaker-cluster-10', dialogue_count: 2 },
  ])
})

test('maps a voice cluster to an existing character immutably without changing source evidence text', () => {
  const original = fixtureBlueprint()
  const originalSnapshot = structuredClone(original)
  const next = mapVoiceClusterToCharacter(original, 'speaker-cluster-10', 'character-lead')

  assert.deepEqual(original, originalSnapshot)
  assert.notEqual(next, original)
  assert.equal(next.shots[0].dialogue[0].speaker_id, 'character-lead')
  assert.equal(next.shots[0].dialogue[0].speaker_kind, 'character')
  assert.equal(next.shots[0].dialogue[0].off_screen, false)
  assert.equal(next.shots[2].dialogue[0].off_screen, true)
  assert.equal(next.shots[0].dialogue[0].review_status, 'approved')
  assert.equal(next.shots[0].dialogue[0].source_text, original.shots[0].dialogue[0].source_text)
  assert.deepEqual(next.shots[0].dialogue[0].evidence_refs, original.shots[0].dialogue[0].evidence_refs)
  assert.throws(
    () => mapVoiceClusterToCharacter(original, 'speaker-cluster-99', 'character-lead'),
    /未知声音聚类/,
  )
  assert.throws(
    () => mapVoiceClusterToCharacter(original, 'speaker-cluster-10', 'character-missing'),
    /未知角色/,
  )
})

test('creates only an explicitly named off-screen character and resolves every related dialogue', () => {
  const original = fixtureBlueprint()
  const next = createOffScreenCharacterForCluster(original, 'speaker-cluster-2', {
    id: 'character-narrator',
    name: '旁白',
  })

  assert.equal(original.characters.length, 1)
  assert.deepEqual(next.characters.at(-1), {
    id: 'character-narrator',
    source_name: '旁白',
    display_name: '旁白',
    relationship: '画外角色',
    relationships: [],
    face_track_ids: [],
    evidence_refs: ['evidence-audio-1'],
    confidence: 0,
    review_status: 'approved',
  })
  assert.equal(next.shots[1].dialogue[0].speaker_id, 'character-narrator')
  assert.equal(next.shots[1].dialogue[0].speaker_kind, 'off_screen')
  assert.equal(next.shots[1].dialogue[0].off_screen, true)
  assert.equal(next.shots[1].dialogue[0].review_status, 'approved')
  assert.equal(next.shots[1].dialogue[0].source_text, original.shots[1].dialogue[0].source_text)
  assert.deepEqual(next.shots[1].dialogue[0].evidence_refs, original.shots[1].dialogue[0].evidence_refs)
  assert.throws(
    () => createOffScreenCharacterForCluster(original, 'speaker-cluster-2', { id: '', name: '' }),
    /角色标识|角色名称/,
  )
  assert.throws(
    () => createOffScreenCharacterForCluster(original, 'speaker-cluster-2', {
      id: 'character-lead',
      name: '旁白',
    }),
    /角色标识重复/,
  )
})

test('approves a selected character review immutably and rejects unknown character ids', () => {
  const original = fixtureBlueprint()
  original.characters[0].review_status = 'needs_review'
  const next = approveCharacterReview(original, 'character-lead')
  assert.equal(original.characters[0].review_status, 'needs_review')
  assert.equal(next.characters[0].review_status, 'approved')
  assert.throws(() => approveCharacterReview(original, 'character-missing'), /未知角色/)
})

test('approves only an already resolved dialogue and never approves a voice cluster', () => {
  let blueprint = mapVoiceClusterToCharacter(fixtureBlueprint(), 'speaker-cluster-10', 'character-lead')
  blueprint.shots[0].dialogue[0].review_status = 'needs_review'
  const next = approveDialogueReview(blueprint, 'dialogue-1')
  assert.equal(blueprint.shots[0].dialogue[0].review_status, 'needs_review')
  assert.equal(next.shots[0].dialogue[0].review_status, 'approved')
  assert.throws(() => approveDialogueReview(fixtureBlueprint(), 'dialogue-1'), /声音聚类/)
  assert.throws(() => approveDialogueReview(blueprint, 'dialogue-missing'), /未知对白/)
})

test('rejects duplicate role ids and inherited or dangerous blueprint data', () => {
  const duplicate = fixtureBlueprint()
  duplicate.characters.push({ ...duplicate.characters[0] })
  assert.throws(() => unresolvedVoiceClusters(duplicate), /角色标识重复/)

  const inheritedCharacter = Object.create({ polluted: true })
  Object.assign(inheritedCharacter, fixtureBlueprint().characters[0])
  const inherited = fixtureBlueprint()
  inherited.characters = [inheritedCharacter]
  assert.throws(
    () => mapVoiceClusterToCharacter(inherited, 'speaker-cluster-10', 'character-lead'),
    /继承|原型/,
  )

  const dangerous = fixtureBlueprint()
  Object.defineProperty(dangerous.shots[0].dialogue[0], '__proto__', {
    value: { polluted: true },
    enumerable: true,
  })
  assert.throws(() => unresolvedVoiceClusters(dangerous), /危险字段/)
  assert.equal({}.polluted, undefined)
})

test('mirrors backend review blockers before allowing a blueprint lock', () => {
  let blueprint = fixtureBlueprint()
  assert.deepEqual(blueprintLockBlockers(blueprint), [
    '仍有未解决声音聚类',
    '仍有对白未审核通过',
    '母本事实尚未审核通过',
  ])

  blueprint = mapVoiceClusterToCharacter(blueprint, 'speaker-cluster-10', 'character-lead')
  blueprint = createOffScreenCharacterForCluster(blueprint, 'speaker-cluster-2', {
    id: 'character-narrator',
    name: '旁白',
  })
  assert.deepEqual(blueprintLockBlockers(blueprint), ['母本事实尚未审核通过'])

  blueprint = approveBlueprintReview(blueprint, 'reviewer-1')
  assert.deepEqual(blueprintLockBlockers(blueprint), [])
  assert.equal(blueprint.review.status, 'approved')
  assert.equal(blueprint.review.reviewer, 'reviewer-1')
  assert.throws(() => approveBlueprintReview(fixtureBlueprint(), 'reviewer-1'), /未解决声音聚类/)
})
