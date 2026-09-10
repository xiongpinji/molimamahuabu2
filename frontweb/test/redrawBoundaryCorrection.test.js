import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import * as review from '../src/utils/redrawBlueprintReviewState.js'

function fixture(count = 3) {
  const line = { id: 'line-1', source_text: '完整跨镜原句', source_language: 'zh-CN', start_ms: 500, end_ms: 3000,
    evidence_refs: ['asr-4'], speaker_id: 'lead', speaker_kind: 'character', off_screen: false, review_status: 'approved', confidence: 0.8 }
  const blueprint = { source: { asset_id: 3, sha256: 'a'.repeat(64), duration_ms: count * 3000 }, blueprint_hash: 'b'.repeat(64),
    characters: [{ id: 'lead', display_name: '主角', review_status: 'approved' }], review: { status: 'approved', reviewer: 'first' },
    evidence_manifest: { items: [{ id: 'asr-4', kind: 'asr', asset_id: 4, sha256: 'c'.repeat(64) }] },
    scenes: [{ id: 'scene-1', source_ranges: [{ start_ms: 0, end_ms: count * 3000 }] }], props: [],
    shots: Array.from({ length: count }, (_, i) => ({ id: `shot-${i + 1}`, index: i + 1, start_ms: i * 3000, end_ms: (i + 1) * 3000,
      visible_character_ids: ['lead'], scene_id: 'scene-1', causal_previous_shot_id: i ? `shot-${i}` : null,
      composition: '原构图', camera_movement: '固定', opening_state: '站定', continuous_action: '说话', ending_state: '站定',
      text_regions: [{ id: `ocr-${i + 1}`, source_text: '原字', bounding_box: { x: 0.2, y: 0.3, width: 0.4, height: 0.1 } }],
      confidence: { shot_boundary: 0.9 }, evidence_refs: ['asr-4'], manual_boundary: true,
      audio_contract: { dialogue_mode: i === 0 ? 'spoken' : 'silent', preserve_music: true }, dialogue: i === 0 ? [line] : [] })) }
  return { id: 5, revision: 1, work_id: 2, status: 'draft', updated_at: 'initial', blueprint_hash: blueprint.blueprint_hash, blueprint,
    source_dialogue: [{ shot_id: 'shot-1', dialogue_id: 'line-1', status: 'resolved', source_text: line.source_text,
      source_language: line.source_language, source_start_ms: 500, source_end_ms: 7500, projection_start_ms: 500,
      projection_end_ms: 3000, evidence_ref: 'asr-4', evidence_sha256: 'c'.repeat(64) }] }
}
const options = (boundary_ms = 2000, target_shot_id = 'shot-2') => ({ boundary_ms, assignments: [{ dialogue_id: 'line-1', target_shot_id }] })
function apply(record, draft = record.blueprint, input = options(), left = 'shot-1', right = 'shot-2') {
  assert.equal(typeof review.applyAdjacentBoundaryCorrection, 'function', 'atomic adjacent boundary helper exists')
  return review.applyAdjacentBoundaryCorrection(record, draft, left, right, input)
}
function preview(record, draft = record.blueprint, boundary = 2000, left = 'shot-1', right = 'shot-2') {
  assert.equal(typeof review.boundaryCorrectionForReview, 'function', 'boundary preview helper exists')
  return review.boundaryCorrectionForReview(record, draft, left, right, boundary)
}

test('atomic cut and full-sentence ownership preserve every unrelated field, all IDs and original evidence without mutating inputs', () => {
  const record = fixture(), before = structuredClone(record), expected = structuredClone(record.blueprint)
  const next = apply(record)
  expected.shots[0].end_ms = 2000; expected.shots[1].start_ms = 2000
  const line = expected.shots[0].dialogue.pop()
  Object.assign(line, { start_ms: 2000, end_ms: 6000, review_status: 'needs_review' })
  expected.shots[1].dialogue.push(line)
  expected.shots[0].audio_contract.dialogue_mode = 'silent'; expected.shots[1].audio_contract.dialogue_mode = 'spoken'
  expected.review = { status: 'needs_review' }
  assert.deepEqual(next, expected); assert.deepEqual(record, before)
  assert.equal(review.dialogueSourceForReview(record, next, 'shot-2', 'line-1').status, 'unresolved', 'new projection is not server resolved')
})

test('preview uses full verified sentence across all shots and shares validation with apply', () => {
  const record = fixture(25), result = preview(record)
  assert.equal(result.status, 'resolved')
  assert.deepEqual(result.turns[0], { dialogue_id: 'line-1', current_shot_id: 'shot-1', source_start_ms: 500, source_end_ms: 7500,
    source_text: '完整跨镜原句', target_shots: ['shot-1', 'shot-2', 'shot-3'] })
  record.source_dialogue[0].source_end_ms = 75000
  assert.ok(preview(record).turns[0].target_shots.includes('shot-25'))
  const moved = apply(record, record.blueprint, options(2000, 'shot-25'))
  assert.equal(moved.shots[24].dialogue[0].start_ms, 72000)
})

test('atomic necessary migration succeeds even when old ownership would have zero intersection; endpoints are not targets', () => {
  const record = fixture(); record.source_dialogue[0].source_start_ms = 2500; record.source_dialogue[0].projection_start_ms = 2500; record.blueprint.shots[0].dialogue[0].start_ms = 2500
  assert.deepEqual(preview(record, record.blueprint, 2500).turns[0].target_shots, ['shot-2', 'shot-3'])
  assert.throws(() => apply(record, record.blueprint, options(2500, 'shot-1')), /相交|归属/)
  assert.equal(apply(record, record.blueprint, options(2000)).shots[1].dialogue[0].start_ms, 2500)
})

test('ownership-only changes and repeated unsaved corrections preserve full original anchors; noop retains renewed approval', () => {
  const record = fixture(), moved = apply(record, record.blueprint, options(3000))
  const repeated = apply(record, moved, options(4000, 'shot-1'))
  assert.deepEqual([repeated.shots[0].dialogue[0].start_ms, repeated.shots[0].dialogue[0].end_ms], [500, 4000])
  const approved = structuredClone(repeated); approved.review = { status: 'approved', reviewer: 'new' }; approved.shots[0].dialogue[0].review_status = 'approved'
  assert.deepEqual(apply(record, approved, options(4000, 'shot-1')), approved)
})

test('unsaved manual text/time correction uses its effective complete range and preserves the ASR anchor', () => {
  const record = fixture(), corrected = review.applyDialogueSourceCorrection(record, record.blueprint, 'shot-1', 'line-1', {
    source_text: '修订后的完整句子', source_start_ms: 1000, source_end_ms: 8500 })
  const next = apply(record, corrected, options(2000, 'shot-3'))
  assert.equal(next.shots[2].dialogue[0].source_text, '修订后的完整句子')
  assert.equal(next.shots[2].dialogue[0].end_ms, 8500)
  assert.deepEqual(next.shots[2].dialogue[0].source_correction, corrected.shots[0].dialogue[0].source_correction)
  const movedAgain = apply(record, next, { boundary_ms: 7000, assignments: [{ dialogue_id: 'line-1', target_shot_id: 'shot-2' }] }, 'shot-2', 'shot-3')
  assert.equal(movedAgain.shots[1].dialogue[0].start_ms, 2000)
})

test('third-shot destination preserves and verifies existing dialogue rather than replacing it', () => {
  const record = fixture(), existing = structuredClone(record.blueprint.shots[0].dialogue[0])
  Object.assign(existing, { id: 'line-2', start_ms: 7000, end_ms: 8000, source_text: '第三镜原句' })
  record.blueprint.shots[2].dialogue.push(existing); record.blueprint.shots[2].audio_contract.dialogue_mode = 'spoken'
  record.source_dialogue.push({ ...record.source_dialogue[0], dialogue_id: 'line-2', shot_id: 'shot-3', source_text: existing.source_text,
    source_start_ms: 7000, source_end_ms: 8000, projection_start_ms: 7000, projection_end_ms: 8000 })
  const next = apply(record, record.blueprint, options(2000, 'shot-3'))
  assert.deepEqual(next.shots[2].dialogue[0], { ...existing, review_status: 'needs_review' })
  assert.equal(next.shots[2].dialogue.length, 2)
  record.source_dialogue.pop()
  assert.throws(() => apply(record, record.blueprint, options(2000, 'shot-3')), /证据|原句/)
})

test('empty adjacent shots allow only empty mapping as a server-pending draft, never inventing no-audio evidence', () => {
  const record = fixture(); record.blueprint.shots[0].dialogue = []; delete record.source_dialogue
  const before = structuredClone(record)
  assert.deepEqual(preview(record).turns, [])
  const next = apply(record, record.blueprint, { boundary_ms: 2000, assignments: [] })
  assert.deepEqual(next.evidence_manifest, before.blueprint.evidence_manifest)
  assert.equal(Object.hasOwn(next, 'source_dialogue'), false); assert.deepEqual(record, before)
})

test('two-shot and saved manual-correction DTOs retain the same original anchors through repeat boundaries', () => {
  const record = fixture(2); record.source_dialogue[0].source_end_ms = 5500
  const corrected = review.applyDialogueSourceCorrection(record, record.blueprint, 'shot-1', 'line-1', {
    source_text: '人工修订全文', source_start_ms: 2500, source_end_ms: 5900 })
  record.blueprint = corrected
  const line = corrected.shots[0].dialogue[0]
  Object.assign(record.source_dialogue[0], { ...line.source_correction, source_text: line.source_text,
    source_origin: 'manual_correction', projection_start_ms: line.start_ms, projection_end_ms: line.end_ms })
  const next = apply(record, corrected, options(2000))
  assert.deepEqual(next.shots[1].dialogue[0].source_correction, line.source_correction)
  assert.deepEqual([next.shots[1].dialogue[0].start_ms, next.shots[1].dialogue[0].end_ms], [2500, 5900])
})

test('invalid ownership mappings, unsafe cut values, adjacent IDs and malformed object graphs fail without touching inputs or invoking getters', () => {
  const record = fixture(), before = structuredClone(record)
  for (const input of [null, [], {}, Object.create(options()), { ...options(), extra: 1 },
    ...[0, 6000, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2000', true].map((boundary_ms) => options(boundary_ms)),
    ...[[], [{ dialogue_id: 'missing', target_shot_id: 'shot-1' }], [...options().assignments, ...options().assignments],
      [{ dialogue_id: 'line-1', target_shot_id: 'missing' }], [{ dialogue_id: 'line-1', target_shot_id: 'shot-2', extra: true }]].map((assignments) => ({ boundary_ms: 2000, assignments }))]) {
    assert.throws(() => apply(record, record.blueprint, input), /输入无效/); assert.deepEqual(record, before)
  }
  for (const [left, right] of [['shot-2', 'shot-1'], ['shot-1', 'shot-3'], ['shot-1', 'shot-1'], ['constructor', 'shot-2'], [{}, 'shot-2']]) {
    assert.throws(() => apply(record, record.blueprint, options(), left, right), /输入无效/)
  }
  let reads = 0; const hostile = options(); Object.defineProperty(hostile, 'boundary_ms', { get() { reads++; return 2000 } })
  assert.throws(() => apply(record, record.blueprint, hostile), /访问器/); assert.equal(reads, 0)
})

test('empty-dialogue boundary drafts still reject invalid source asset IDs and malformed audio contracts', () => {
  for (const asset of [true, false, {}, [], -1, 1.5, 'garbage', Number.MAX_SAFE_INTEGER + 1]) {
    const record = fixture(); record.blueprint.shots[0].dialogue = []; record.blueprint.source.asset_id = asset
    const before = structuredClone(record)
    assert.throws(() => apply(record, record.blueprint, { boundary_ms: 2000, assignments: [] }), /输入无效/)
    assert.deepEqual(record, before)
  }
  for (const audio of [null, [], 'spoken']) {
    const record = fixture(); record.blueprint.shots[1].audio_contract = audio
    assert.throws(() => apply(record), /输入无效/)
  }
})

for (const fault of ['missing-dto', 'unresolved', 'source-hash', 'record-hash', 'duration', 'evidence', 'original-text', 'anchor', 'duplicate-turn', 'renamed-turn', 'shot-order', 'gap', 'projection', 'locked', 'invisible']) {
  test(`boundary correction rejects ${fault} atomically`, () => {
    const record = fixture(), draft = structuredClone(record.blueprint)
    if (fault === 'missing-dto') delete record.source_dialogue
    if (fault === 'unresolved') record.source_dialogue[0].status = 'unresolved'
    if (fault === 'source-hash') draft.source.sha256 = 'd'.repeat(64)
    if (fault === 'record-hash') draft.blueprint_hash = 'e'.repeat(64)
    if (fault === 'duration') draft.source.duration_ms++
    if (fault === 'evidence') draft.evidence_manifest.items[0].sha256 = 'e'.repeat(64)
    if (fault === 'original-text') draft.shots[0].dialogue[0].source_text = 'unanchored edit'
    if (fault === 'anchor') draft.shots[0].dialogue[0].source_correction = { evidence_ref: 'asr-4' }
    if (fault === 'duplicate-turn') draft.shots[2].dialogue.push(structuredClone(draft.shots[0].dialogue[0]))
    if (fault === 'renamed-turn') draft.shots[0].dialogue[0].id = 'renamed'
    if (fault === 'shot-order') draft.shots.reverse()
    if (fault === 'gap') draft.shots[1].start_ms++
    if (fault === 'projection') draft.shots[0].dialogue[0].start_ms++
    if (fault === 'locked') record.status = 'locked'
    if (fault === 'invisible') draft.shots[1].visible_character_ids = []
    const before = structuredClone(draft)
    assert.throws(() => apply(record, draft), /输入无效/); assert.deepEqual(draft, before)
    if (fault !== 'invisible') assert.notEqual(preview(record, draft).status, 'resolved')
    else assert.ok(!preview(record, draft).turns[0].target_shots.includes('shot-2'))
  })
}

const panelSource = readFileSync(new URL('../src/components/redraw/RedrawBlueprintReviewPanel.vue', import.meta.url), 'utf8')
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
function runtime(t, api = {}) {
  const scope = vue.effectScope(), hooks = [], calls = [], emitted = []
  const bindings = { ...review, computed: vue.computed, defineComponent: vue.defineComponent, h: vue.h, reactive: vue.reactive, ref: vue.ref, watch: vue.watch,
    ElButton: {}, ElInput: {}, onBeforeUnmount(fn) { hooks.push(fn) }, redrawAPI: {
      saveBlueprint: async (id, body) => { calls.push(['save', id, body]); return { ...fixture(), blueprint: body.blueprint, updated_at: 'saved' } },
      lockBlueprint: async () => { calls.push(['lock']); return { ...fixture(), status: 'locked' } }, ...api } }
  const script = compileScript(parse(panelSource).descriptor, { id: 'boundary-test' }).content
    .replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '').replace('export default', 'return')
  const component = new Function(...Object.keys(bindings), script)(...Object.values(bindings))
  const props = vue.reactive({ record: fixture(), work: { id: 2, source_asset_id: 3, source_fingerprint: 'a'.repeat(64) } })
  const state = scope.run(() => component.setup(props, { expose() {}, emit(...args) { emitted.push(args) } }))
  let closed = false
  const dispose = () => { if (!closed) { closed = true; hooks.forEach((fn) => fn()); scope.stop() } }
  t.after(dispose)
  return { state, props, calls, emitted, dispose }
}
function begin(state) {
  assert.equal(typeof state.beginBoundaryEdit, 'function', 'actual SFC exposes boundary editor')
  state.beginBoundaryEdit('shot-1'); assert.equal(state.boundaryEdit.value.left_shot_id, 'shot-1')
}
test('actual SFC cancels without changes, atomically applies only draft, keeps same-identity progress and mutually excludes other editors', async (t) => {
  const { state, props, calls } = runtime(t), before = JSON.stringify(state.draftBlueprint.value)
  begin(state); state.boundaryEdit.value.boundary_seconds = '2'; state.cancelBoundaryEdit()
  assert.equal(JSON.stringify(state.draftBlueprint.value), before); assert.equal(state.dirty.value, false)
  state.factEdit.value = { kind: 'shot' }; state.dialogueEdit.value = { dialogue_id: 'old' }; begin(state)
  assert.equal(state.factEdit.value, null); assert.equal(state.dialogueEdit.value, null)
  props.work = { ...props.work, progress: 80 }; await vue.nextTick()
  assert.equal(state.boundaryEdit.value.left_shot_id, 'shot-1')
  state.boundaryEdit.value.boundary_seconds = '2'; state.boundaryEdit.value.assignments[0].target_shot_id = 'shot-2'; state.applyBoundaryEdit()
  assert.equal(state.boundaryEdit.value, null); assert.equal(state.dirty.value, true); assert.equal(state.reviewer.value, '')
  assert.equal(state.draftBlueprint.value.shots[1].dialogue[0].id, 'line-1'); assert.equal(calls.length, 0)
  begin(state); state.beginFactEdit('shot', 'shot-1'); assert.equal(state.boundaryEdit.value, null)
})
test('actual SFC invalidated selected target is not silently replaced and validation keeps draft and editor', (t) => {
  const { state, props } = runtime(t)
  props.record.source_dialogue[0].source_start_ms = 2500; props.record.source_dialogue[0].projection_start_ms = 2500; props.record.blueprint.shots[0].dialogue[0].start_ms = 2500
  state.syncRecord(props.record); begin(state)
  const before = JSON.stringify(state.draftBlueprint.value)
  state.boundaryEdit.value.boundary_seconds = '2'
  assert.equal(state.boundaryEdit.value.assignments[0].target_shot_id, 'shot-1')
  state.applyBoundaryEdit(); assert.match(state.localError.value, /选择|归属|相交/)
  assert.equal(JSON.stringify(state.draftBlueprint.value), before); assert.ok(state.boundaryEdit.value)
})
for (const transition of ['locked', 'conflict', 'saving', 'locking', 'work-cycle', 'revision', 'source', 'unmount']) {
  test(`actual SFC ${transition} prevents boundary apply and identity changes clear editor`, (t) => {
    const { state, props, calls, dispose } = runtime(t); begin(state); state.boundaryEdit.value.boundary_seconds = '2'
    if (transition === 'locked') props.record = { ...fixture(), status: 'locked' }
    if (transition === 'conflict') state.conflict.value = true
    if (transition === 'saving') state.saving.value = true
    if (transition === 'locking') state.locking.value = true
    if (transition === 'work-cycle') { props.work.id = 99; props.work.id = 2 }
    if (transition === 'revision') props.record.revision = 2
    if (transition === 'source') props.work.source_fingerprint = 'd'.repeat(64)
    if (transition === 'unmount') dispose()
    state.applyBoundaryEdit(); assert.equal(state.draftBlueprint.value.shots[0].end_ms, 3000); assert.equal(calls.length, 0)
    if (!['saving', 'locking'].includes(transition)) assert.equal(state.boundaryEdit.value, null)
  })
}
test('actual SFC boundary seek never requests or plays media and requires owned ready Blob metadata', (t) => {
  const { state, calls } = runtime(t); begin(state)
  assert.equal(typeof state.seekBoundary, 'function')
  let pauses = 0, plays = 0
  const player = { pause() { pauses++ }, play() { plays++ }, currentTime: 0, duration: 9, readyState: 1 }
  state.sourcePlayer.value = player; state.seekBoundary(); assert.equal(player.currentTime, 0)
  state.sourceUrl.value = 'blob:unit-owned'; state.mediaBoundIdentity.value = state.mediaIdentity.value
  state.boundaryEdit.value.boundary_seconds = '2.123'; state.seekBoundary(); assert.equal(player.currentTime, 2.123)
  for (const [readyState, duration] of [[0, 9], [1, NaN], [1, 2], [1, Infinity]]) {
    Object.assign(player, { currentTime: 0, readyState, duration }); state.seekBoundary(); assert.equal(player.currentTime, 0)
  }
  assert.equal(plays, 0); assert.equal(calls.length, 0)
})
test('actual SFC saved server re-review receipt stops lock and emits saved result without retry', async (t) => {
  const { state, calls, emitted } = runtime(t, { saveBlueprint: async () => {
    calls.push(['save']); const saved = fixture(); saved.updated_at = 'saved'; saved.blueprint.review = { status: 'needs_review' }; return saved
  } })
  state.dirty.value = true; await state.lockDraft()
  assert.deepEqual(calls.map(([kind]) => kind), ['save'], 'must recheck saved review before sending lock')
  assert.equal(state.recordState.value.updated_at, 'saved'); assert.equal(state.dirty.value, false)
  assert.deepEqual(emitted.map(([kind]) => kind), ['updated']); assert.match(state.localError.value, /重新审核|复审/)
  assert.equal(state.locking.value, false)
})
test('actual SFC opening boundary editor stops old complete-sentence playback; dialogue edit also closes boundary editor', async (t) => {
  const { state } = runtime(t); let pauses = 0
  state.sourcePlayer.value = { pause() { pauses++ }, play: async () => {}, duration: 9, readyState: 1, currentTime: 0 }
  state.sourceUrl.value = 'blob:unit-owned'; state.mediaBoundIdentity.value = state.mediaIdentity.value
  await state.playSourceDialogue('shot-1', 'line-1'); begin(state)
  assert.equal(pauses, 1)
  state.beginDialogueEdit('shot-1', 'line-1'); assert.equal(state.boundaryEdit.value, null)
})
test('actual SFC save conflict clears open boundary editor and preserves no-retry semantics until explicit refresh', async (t) => {
  const { state, props, calls } = runtime(t, { saveBlueprint: async () => { calls.push(['save']); throw { response: { status: 409 } } } })
  begin(state); state.boundaryEdit.value.boundary_seconds = '2'; state.applyBoundaryEdit(); begin(state)
  await state.saveDraft(); assert.equal(state.boundaryEdit.value, null); assert.equal(state.conflict.value, true)
  await state.saveDraft(); assert.equal(calls.length, 1)
  props.record = { ...fixture(), updated_at: 'refreshed' }; begin(state); assert.equal(state.conflict.value, false)
})
test('actual SFC legal dirty save-lock remains valid; stale save and wrong-owner receipt never lock', async (t) => {
  const legal = runtime(t); legal.state.dirty.value = true; await legal.state.lockDraft()
  assert.deepEqual(legal.calls.map(([kind]) => kind), ['save', 'lock'])
  const late = defer(), pending = runtime(t, { saveBlueprint: () => late.promise })
  pending.state.dirty.value = true; const done = pending.state.lockDraft(); pending.props.work.id = 99; pending.props.work.id = 2
  late.resolve({ ...fixture(), updated_at: 'late' }); await done
  assert.deepEqual(pending.calls, []); assert.deepEqual(pending.emitted, []); assert.equal(pending.state.recordState.value.updated_at, 'initial')
  const wrong = runtime(t, { saveBlueprint: async () => ({ ...fixture(), work_id: 99 }) })
  wrong.state.dirty.value = true; await wrong.state.lockDraft(); assert.deepEqual(wrong.calls, []); assert.match(wrong.state.localError.value, /不属于/)
})
