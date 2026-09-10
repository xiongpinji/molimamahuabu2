import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import * as reviewState from '../src/utils/redrawBlueprintReviewState.js'

function fixture(workId = 2, revision = 1) {
  const line = (id, start) => ({ id, speaker_id: 'role-a', speaker_kind: 'character', off_screen: false,
    start_ms: start, end_ms: start + 1000, source_text: `Original ${id}`, source_language: 'en',
    emotion: 'calm', evidence_refs: ['asr-4'], confidence: 0.8, review_status: 'approved' })
  const blueprint = {
    source: { asset_id: 3, sha256: 'a'.repeat(64), duration_ms: 6000 }, blueprint_hash: 'b'.repeat(64),
    evidence_manifest: { items: [{ id: 'asr-4', kind: 'asr', asset_id: 4, sha256: 'c'.repeat(64) }] },
    characters: ['role-a', 'role-b'].map((id) => ({ id, source_name: id, display_name: id,
      evidence_refs: ['asr-4'], confidence: 0.8, review_status: 'approved' })),
    shots: [
      { id: 'shot-1', index: 1, start_ms: 0, end_ms: 3000, visible_character_ids: ['role-a', 'role-b'], dialogue: [line('line-1', 0), line('line-2', 1000)] },
      { id: 'shot-2', index: 2, start_ms: 3000, end_ms: 6000, visible_character_ids: ['role-a'], dialogue: [line('line-3', 3000)] },
    ], review: { status: 'approved', reviewer: 'original-reviewer' },
  }
  return { id: revision + 4, revision, work_id: workId, status: 'draft', updated_at: `revision-${revision}`,
    blueprint_hash: blueprint.blueprint_hash, blueprint,
    source_dialogue: blueprint.shots.flatMap((shot) => shot.dialogue.map((line) => ({
      shot_id: shot.id, dialogue_id: line.id, status: 'resolved', source_text: line.source_text,
      source_language: line.source_language, source_start_ms: line.start_ms, source_end_ms: line.end_ms,
      projection_start_ms: line.start_ms, projection_end_ms: line.end_ms,
      evidence_ref: 'asr-4', evidence_sha256: 'c'.repeat(64),
    }))),
  }
}

function assign(blueprint, ids, options) {
  assert.equal(typeof reviewState.assignDialogueSpeakers, 'function', 'subset assignment helper must exist')
  return reviewState.assignDialogueSpeakers(blueprint, ids, options)
}
function create(blueprint, ids, options) {
  assert.equal(typeof reviewState.createOffScreenCharacterForDialogues, 'function', 'name-only creation helper must exist')
  return reviewState.createOffScreenCharacterForDialogues(blueprint, ids, options)
}
const turns = (blueprint) => blueprint.shots.flatMap((shot) => shot.dialogue)
function preservedTurn(turn) {
  const { speaker_id, speaker_kind, off_screen, review_status, ...preserved } = turn
  return preserved
}
function deepFreeze(value) {
  Object.values(value).forEach((item) => { if (item && typeof item === 'object') deepFreeze(item) })
  return Object.freeze(value)
}

test('subset remap changes only selected speaker fields and reviews, preserving immutable original evidence', () => {
  const record = fixture()
  const original = structuredClone(record.blueprint)
  deepFreeze(record.blueprint)
  const next = assign(record.blueprint, ['line-2'], { character_id: 'role-b', off_screen: false })
  assert.deepEqual(record.blueprint, original)
  assert.notEqual(next, record.blueprint)
  assert.deepEqual(turns(next)[1], { ...turns(original)[1], speaker_id: 'role-b', review_status: 'needs_review' })
  assert.deepEqual(turns(next)[0], turns(original)[0])
  assert.deepEqual(turns(next)[2], turns(original)[2])
  for (const field of ['source', 'evidence_manifest', 'characters', 'blueprint_hash']) assert.deepEqual(next[field], original[field])
  assert.deepEqual(next.review, { status: 'needs_review' })
  assert.deepEqual(preservedTurn(turns(next)[1]), preservedTurn(turns(original)[1]))
  assert.equal(reviewState.dialogueSourceForReview(record, next, 'shot-1', 'line-2').status, 'resolved')
  assert.ok(reviewState.blueprintLockBlockers(next).includes('仍有对白未审核通过'))
  assert.throws(() => reviewState.approveBlueprintReview(next, 'reviewer'), /对白/)
  const approved = reviewState.approveBlueprintReview(reviewState.approveDialogueReview(next, 'line-2'), 'reviewer')
  assert.deepEqual(reviewState.blueprintLockBlockers(approved), [])
})

test('selected lines split a voice cluster without changing unselected lines or inferring visibility', () => {
  const blueprint = fixture().blueprint
  for (const line of turns(blueprint)) Object.assign(line, { speaker_kind: 'voice_cluster', speaker_id: 'speaker-cluster-1' })
  const next = assign(blueprint, ['line-1', 'line-3'], { character_id: 'role-b', off_screen: true })
  for (const line of [turns(next)[0], turns(next)[2]]) assert.deepEqual(
    [line.speaker_id, line.speaker_kind, line.off_screen, line.review_status], ['role-b', 'off_screen', true, 'needs_review'])
  assert.deepEqual(turns(next)[1], turns(blueprint)[1])
  assert.deepEqual(reviewState.unresolvedVoiceClusters(next), [{ id: 'speaker-cluster-1', dialogue_count: 1 }])
  assert.deepEqual(next.shots.map((shot) => shot.visible_character_ids), blueprint.shots.map((shot) => shot.visible_character_ids))
})

test('onscreen assignment requires visibility in every selected shot and resets an old offscreen flag', () => {
  const blueprint = fixture().blueprint
  const before = structuredClone(blueprint)
  assert.throws(() => assign(blueprint, ['line-1', 'line-3'], { character_id: 'role-b', off_screen: false }), /可见|画内/)
  assert.deepEqual(blueprint, before)
  turns(blueprint)[0].off_screen = true
  const next = assign(blueprint, ['line-1'], { character_id: 'role-b', off_screen: false })
  assert.equal(turns(next)[0].off_screen, false)
  assert.equal(turns(next)[0].speaker_kind, 'character')
})

test('name-only offscreen creation allocates a collision-free role and selected evidence union with new review gates', () => {
  const blueprint = fixture().blueprint
  blueprint.characters.push({ ...blueprint.characters[0], id: 'manual-character-1' }, { ...blueprint.characters[0], id: 'manual-character-3' })
  turns(blueprint)[2].evidence_refs = ['asr-5', 'asr-4']
  const original = structuredClone(blueprint)
  const next = create(deepFreeze(blueprint), ['line-1', 'line-3'], { name: '  New Narrator  ' })
  assert.deepEqual(next.characters.at(-1), { id: 'manual-character-2', source_name: 'New Narrator', display_name: 'New Narrator',
    relationship: '画外角色', relationships: [], face_track_ids: [], evidence_refs: ['asr-4', 'asr-5'], confidence: 0, review_status: 'needs_review' })
  for (const index of [0, 2]) {
    assert.deepEqual(preservedTurn(turns(next)[index]), preservedTurn(turns(original)[index]))
    assert.deepEqual([turns(next)[index].speaker_id, turns(next)[index].speaker_kind, turns(next)[index].off_screen, turns(next)[index].review_status],
      ['manual-character-2', 'off_screen', true, 'needs_review'])
  }
  assert.deepEqual(turns(next)[1], turns(original)[1])
  assert.deepEqual(blueprint, original)
  assert.deepEqual(next.review, { status: 'needs_review' })
  assert.ok(reviewState.blueprintLockBlockers(next).includes('仍有角色未审核通过'))
})

test('invalid, duplicate, unknown, hostile and inherited inputs reject atomically without running accessors', () => {
  const blueprint = fixture().blueprint
  const original = structuredClone(blueprint)
  const good = { character_id: 'role-b', off_screen: true }
  const cases = [
    () => assign(blueprint, [], good), () => assign(blueprint, ['line-1', 'line-1'], good),
    () => assign(blueprint, ['line-1', 'missing'], good), () => assign(blueprint, ['__proto__'], good),
    () => assign(blueprint, ['constructor'], good), () => assign(blueprint, [' line-1 '], good),
    () => assign(blueprint, ['line-1'], { ...good, character_id: 'missing' }),
    ...[undefined, null, 0, 1, 'false'].map((off_screen) => () => assign(blueprint, ['line-1'], { character_id: 'role-b', off_screen })),
    () => assign(blueprint, ['line-1'], Object.create(good)),
    () => assign(blueprint, ['line-1'], { ...good, ignored: true }),
    () => create(blueprint, ['line-1'], { name: '' }), () => create(blueprint, ['line-1'], { name: 'N', id: 'manual' }),
    () => create(blueprint, ['line-1'], Object.create({ name: 'N' })),
    () => assign(Object.create(blueprint), ['line-1'], good),
  ]
  let getterReads = 0
  const options = { off_screen: true }
  Object.defineProperty(options, 'character_id', { enumerable: true, get() { getterReads++; return 'role-b' } })
  cases.push(() => assign(blueprint, ['line-1'], options))
  const ids = ['line-1']
  Object.defineProperty(ids, '0', { enumerable: true, get() { getterReads++; return 'line-1' } })
  cases.push(() => assign(blueprint, ids, good))
  const inheritedIds = ['line-1']; Object.setPrototypeOf(inheritedIds, Object.create(Array.prototype))
  cases.push(() => assign(blueprint, inheritedIds, good))
  for (const run of cases) { assert.throws(run, /输入无效/); assert.deepEqual(blueprint, original) }
  assert.equal(getterReads, 0)
})

test('global duplicate dialogue ids and hostile blueprint array accessors reject before any selected mutation', () => {
  for (const helper of [assign, create]) {
    const options = helper === assign ? { character_id: 'role-a', off_screen: false } : { name: 'N' }
    const blueprint = fixture().blueprint
    blueprint.shots[1].dialogue[0].id = 'line-2'
    const before = structuredClone(blueprint)
    assert.throws(() => helper(blueprint, ['line-1'], options), /重复/)
    assert.deepEqual(blueprint, before)
    let reads = 0
    Object.defineProperty(blueprint.shots, '0', { enumerable: true, get() { reads++; return fixture().blueprint.shots[0] } })
    assert.throws(() => helper(blueprint, ['line-1'], options), /访问器/)
    assert.equal(reads, 0)
  }
})

const panelSource = readFileSync(new URL('../src/components/redraw/RedrawBlueprintReviewPanel.vue', import.meta.url), 'utf8')
function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = async () => { await vue.nextTick(); await Promise.resolve(); await vue.nextTick() }
function runtime(t, api = {}) {
  const scope = vue.effectScope(), hooks = [], emitted = [], calls = []
  const bindings = { computed: vue.computed, defineComponent: vue.defineComponent, h: vue.h,
    reactive: vue.reactive, ref: vue.ref, watch: vue.watch, ...reviewState, ElButton: {}, ElInput: {},
    onBeforeUnmount(fn) { hooks.push(fn) }, redrawAPI: {
      saveBlueprint: async (workId, body) => { calls.push(['save', workId, body]); return { ...fixture(workId), updated_at: 'saved', blueprint: body.blueprint } },
      lockBlueprint: async (workId, body) => { calls.push(['lock', workId, body]); return { ...fixture(workId), status: 'locked', updated_at: 'locked' } }, ...api,
    } }
  const script = compileScript(parse(panelSource).descriptor, { id: 'speaker-correction-test' }).content
    .replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '').replace('export default', 'return')
  const component = new Function(...Object.keys(bindings), script)(...Object.values(bindings))
  const props = vue.reactive({ record: fixture(), work: { id: 2, source_asset_id: 3, source_fingerprint: 'a'.repeat(64), url: '/api/v1/redraw/works/2/source-video' } })
  const state = scope.run(() => component.setup(props, { expose() {}, emit(...args) { emitted.push(args) } }))
  let disposed = false
  const dispose = () => { if (!disposed) { disposed = true; hooks.forEach((fn) => fn()); scope.stop() } }
  t.after(dispose)
  return { state, props, emitted, calls, dispose }
}
function edit(state) { state.replaceDraft(structuredClone(vue.toRaw(state.draftBlueprint.value))) }
function correctionState(state) {
  assert.equal(typeof state.toggleDialogueSelection, 'function', 'actual panel supports subset selection')
  assert.equal(typeof state.applySelectedCharacter, 'function')
  assert.equal(typeof state.createSelectedOffScreen, 'function')
}

test('actual panel applies only explicitly selected mapped lines as a draft, reapproves and preserves source playback binding', async (t) => {
  const { state, calls } = runtime(t)
  correctionState(state)
  state.toggleDialogueSelection('line-2', true)
  state.selectedCharacterId.value = 'role-b'
  state.selectedSpeakerKind.value = 'onscreen'
  assert.equal(state.dirty.value, false)
  state.applySelectedCharacter()
  assert.equal(state.dirty.value, true)
  assert.equal(state.draftBlueprint.value.shots[0].dialogue[1].speaker_id, 'role-b')
  assert.equal(state.draftBlueprint.value.shots[0].dialogue[0].speaker_id, 'role-a')
  assert.equal(state.sourceDialogue('shot-1', 'line-2').status, 'resolved')
  assert.equal(calls.length, 0)
  state.approveDialogue('line-2'); state.reviewer.value = 'new-reviewer'; state.approveReview()
  assert.deepEqual(state.lockBlockers.value, [])
  await state.saveDraft()
  assert.equal(calls.length, 1)
})

test('actual selection includes more loaded shots, clears explicitly and clears on record/work/conflict/lock/unmount', async (t) => {
  const { state, props, dispose } = runtime(t)
  correctionState(state)
  state.toggleDialogueSelection('line-1', true); state.toggleDialogueSelection('line-3', true)
  state.loadMoreShots()
  assert.deepEqual([...state.selectedDialogueIds.value], ['line-1', 'line-3'])
  state.clearDialogueSelection()
  assert.equal(state.selectedDialogueIds.value.length, 0)
  for (const change of [
    () => { props.record = fixture(2, 2) },
    () => { props.work = { ...props.work, id: 3 } },
    () => { state.conflict.value = true },
    () => { state.conflict.value = false; props.work = { ...props.work, id: 2 }; props.record = { ...fixture(), status: 'locked' } },
  ]) {
    state.selectedDialogueIds.value = ['line-1']; state.selectedOffScreenName.value = 'stale name'
    change(); await tick()
    assert.equal(state.selectedDialogueIds.value.length, 0)
    assert.equal(state.selectedOffScreenName.value, '')
  }
  state.selectedDialogueIds.value = ['line-1']; dispose()
  assert.equal(state.selectedDialogueIds.value.length, 0)
})

test('actual panel name-only creation requires new role and changed lines to be reviewed again', (t) => {
  const { state, calls } = runtime(t)
  correctionState(state)
  state.toggleDialogueSelection('line-3', true); state.selectedOffScreenName.value = 'Aunt Rosa'
  state.createSelectedOffScreen()
  const role = state.draftBlueprint.value.characters.at(-1)
  assert.equal(role.display_name, 'Aunt Rosa'); assert.equal(role.review_status, 'needs_review')
  assert.ok(state.lockBlockers.value.includes('仍有角色未审核通过'))
  state.approveCharacter(role.id); state.approveDialogue('line-3'); state.reviewer.value = 'editor'; state.approveReview()
  assert.deepEqual(state.lockBlockers.value, []); assert.equal(calls.length, 0)
})

test('benign same-work progress refresh preserves dirty corrections, selection, and a current pending save', async (t) => {
  const response = deferred()
  const { state, props, emitted } = runtime(t, { saveBlueprint: () => response.promise })
  state.toggleDialogueSelection('line-2', true); state.selectedCharacterId.value = 'role-b'; state.applySelectedCharacter()
  const before = JSON.stringify(state.draftBlueprint.value)
  props.work = { ...props.work, title: 'renamed', task_progress: 83 }; await tick()
  assert.equal(state.dirty.value, true)
  assert.equal(JSON.stringify(state.draftBlueprint.value), before)
  assert.deepEqual([...state.selectedDialogueIds.value], ['line-2'])
  const pending = state.saveDraft()
  props.work = { ...props.work, task_progress: 90 }; await tick()
  assert.equal(state.saving.value, true)
  response.resolve({ ...fixture(), updated_at: 'saved-after-progress', blueprint: JSON.parse(before) }); await pending
  assert.equal(state.recordState.value.updated_at, 'saved-after-progress')
  assert.deepEqual(emitted.map(([name]) => name), ['updated'])
})

test('an invalid new record cannot leave the preceding revision editable or allow saving its stale draft', async (t) => {
  const { state, props, calls } = runtime(t)
  edit(state)
  props.record = { ...fixture(2, 2), blueprint: { invalid: true } }; await tick()
  assert.equal(state.recordState.value, null)
  assert.equal(state.draftBlueprint.value, null)
  assert.equal(state.canEdit.value, false)
  assert.match(state.localError.value, /无效/)
  await state.saveDraft(); await state.lockDraft()
  assert.equal(calls.length, 0)
})

for (const operation of ['save', 'lock', 'save-lock']) {
  for (const outcome of ['success', 'error']) {
    for (const transition of ['work-cycle', 'revision', 'unmount']) {
      test(`actual ${operation} ignores late ${outcome} after ${transition} without touching new request state`, async (t) => {
        const old = deferred(), current = deferred()
        let saves = 0, locks = 0
        const api = {
          saveBlueprint: () => { saves++; return saves === 1 && operation !== 'lock' ? old.promise : current.promise },
          lockBlueprint: () => { locks++; return old.promise },
        }
        const { state, props, emitted, dispose } = runtime(t, api)
        if (operation !== 'lock') edit(state)
        const pending = operation === 'save' ? state.saveDraft() : state.lockDraft()
        if (transition === 'work-cycle') {
          const originalWork = props.work, originalRecord = props.record
          props.work = { ...originalWork, id: 3 }; props.record = fixture(3)
          // No nextTick: A -> B -> A must not resurrect the first request.
          props.work = originalWork; props.record = originalRecord
        } else if (transition === 'revision') props.record = fixture(2, 2)
        else dispose()
        await tick()
        let newPending
        if (transition !== 'unmount') { edit(state); newPending = state.saveDraft(); assert.equal(state.saving.value, true) }
        const before = JSON.stringify(state.draftBlueprint.value)
        if (outcome === 'success') old.resolve({ ...fixture(), updated_at: 'late', status: operation === 'lock' ? 'locked' : 'draft' })
        else old.reject({ response: { status: 409 }, message: 'late conflict' })
        await pending
        assert.equal(JSON.stringify(state.draftBlueprint.value), before)
        assert.equal(emitted.length, 0)
        assert.equal(state.conflict.value, false)
        assert.equal(state.localError.value, '')
        if (operation === 'save-lock') assert.equal(locks, 0, 'old successful save cannot continue to lock')
        if (transition !== 'unmount') {
          assert.equal(state.saving.value, true, 'old finally cannot clear a new save')
          current.resolve({ ...fixture(2, transition === 'revision' ? 2 : 1), updated_at: 'new-save' })
          await newPending
          assert.equal(state.recordState.value.updated_at, 'new-save')
        }
      })
    }
  }
}

test('actual component blocks duplicate save/lock clicks and preserves a valid dirty save-to-lock sequence', async (t) => {
  const pendingSave = deferred(), pendingLock = deferred(), calls = []
  const { state, emitted } = runtime(t, {
    saveBlueprint: (id, body) => { calls.push(['save', id, body]); return pendingSave.promise },
    lockBlueprint: (id, body) => { calls.push(['lock', id, body]); return pendingLock.promise },
  })
  edit(state)
  const pending = state.lockDraft()
  const duplicateSave = state.saveDraft(), duplicateLock = state.lockDraft()
  assert.equal(calls.length, 1)
  const saved = { ...fixture(), updated_at: 'new-cas', blueprint_hash: 'e'.repeat(64) }
  pendingSave.resolve(saved); await tick()
  assert.deepEqual(calls[1], ['lock', 2, { expected_updated_at: 'new-cas', expected_blueprint_hash: 'e'.repeat(64) }])
  pendingLock.resolve({ ...saved, status: 'locked' }); await pending; await duplicateSave; await duplicateLock
  assert.equal(state.isLocked.value, true)
  assert.deepEqual(emitted.map(([name]) => name), ['updated', 'locked'])
  assert.equal(state.saving.value, false); assert.equal(state.locking.value, false)
})

test('actual standalone saves reject repeated clicks and current 409 keeps dirty edits without retry or lock', async (t) => {
  const failed = deferred(); let saves = 0, locks = 0
  const { state } = runtime(t, { saveBlueprint: () => { saves++; return failed.promise }, lockBlueprint: () => { locks++ } })
  edit(state)
  const before = JSON.stringify(state.draftBlueprint.value)
  const pending = state.saveDraft()
  const duplicate = state.saveDraft()
  failed.reject({ response: { status: 409 } }); await pending; await duplicate
  assert.equal(saves, 1); assert.equal(state.conflict.value, true); assert.equal(state.dirty.value, true)
  assert.equal(JSON.stringify(state.draftBlueprint.value), before)
  await state.saveDraft(); await state.lockDraft()
  assert.equal(saves, 1); assert.equal(locks, 0)
})

for (const status of [409, 500]) {
  test(`save succeeded before current lock ${status} retains the new CAS and saved draft without an intermediate parent emit`, async (t) => {
    const calls = []
    const { state, emitted } = runtime(t, {
      saveBlueprint: async (id, body) => {
        calls.push(['save', id, body])
        return { ...fixture(), updated_at: 'saved-before-lock-error', blueprint_hash: 'e'.repeat(64), blueprint: body.blueprint }
      },
      lockBlueprint: async (id, body) => { calls.push(['lock', id, body]); throw { response: { status }, message: 'Lock rejected' } },
    })
    edit(state)
    const draft = JSON.stringify(state.draftBlueprint.value)
    await state.lockDraft()
    assert.equal(state.recordState.value.updated_at, 'saved-before-lock-error')
    assert.equal(JSON.stringify(state.draftBlueprint.value), draft)
    assert.equal(state.dirty.value, false)
    assert.equal(state.saving.value, false); assert.equal(state.locking.value, false)
    assert.equal(emitted.length, 0)
    assert.equal(calls.length, 2)
    assert.equal(state.conflict.value, status === 409)
    assert.ok(state.localError.value)
    await state.lockDraft()
    assert.equal(calls.length, status === 409 ? 2 : 3)
    if (status === 500) assert.deepEqual(calls[2][2], { expected_updated_at: 'saved-before-lock-error', expected_blueprint_hash: 'e'.repeat(64) })
  })
}

test('actual parent blueprint event handlers reject other work receipts before changing loading or record', () => {
  const source = readFileSync(new URL('../src/views/RedrawWorkspace.vue', import.meta.url), 'utf8')
  const start = source.indexOf('function onBlueprintUpdated(')
  const end = source.indexOf('\nfunction ', start + 1)
  const run = new Function('work', 'workId', 'blueprintRecord', 'blueprintLoading', 'blueprintError', 'loading', 'workspaceError',
    `let blueprintRequestSequence = 0; ${source.slice(start, end)}; return onBlueprintUpdated`)
  const record = vue.ref(fixture()), loading = vue.ref(true), error = vue.ref('current-error')
  const workspaceLoading = vue.ref(false), workspaceError = vue.ref('')
  const handler = run(vue.ref({ id: 2 }), vue.ref('2'), record, loading, error, workspaceLoading, workspaceError)
  handler(fixture(3))
  assert.equal(record.value.work_id, 2); assert.equal(loading.value, true); assert.equal(error.value, 'current-error')
  workspaceLoading.value = true
  handler(fixture(2, 2))
  assert.equal(record.value.revision, 1); assert.equal(loading.value, true)
  workspaceLoading.value = false; workspaceError.value = 'blocked'
  handler(fixture(2, 2))
  assert.equal(record.value.revision, 1); assert.equal(error.value, 'current-error')
  workspaceError.value = ''
  handler(fixture(2, 2))
  assert.equal(record.value.revision, 2); assert.equal(loading.value, false)
})
