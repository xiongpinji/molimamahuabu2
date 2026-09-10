import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import * as review from '../src/utils/redrawBlueprintReviewState.js'

const shotValues = { composition: ' 新构图 ', camera_movement: '缓推', opening_state: '人物站定',
  continuous_action: '人物举杯', ending_state: '人物放下杯子', visible_character_ids: ['lead'] }
const cases = [
  ['shot', 'shots', 'applyShotVisualFactCorrection', shotValues, { composition: 500, camera_movement: 300, opening_state: 500, continuous_action: 500, ending_state: 500 }],
  ['scene', 'scenes', 'applySceneFactCorrection', { location: ' 新地点 ', time: '清晨' }, { location: 200, time: 120 }],
  ['prop', 'props', 'applyPropFactCorrection', { name: ' 新道具 ' }, { name: 200 }],
]
function fixture() {
  const line = { id: 'line-1', source_text: '原句', source_language: 'zh-CN', start_ms: 3000, end_ms: 4500,
    evidence_refs: ['asr-4'], speaker_id: 'lead', speaker_kind: 'character', off_screen: false, review_status: 'approved', confidence: 0.82,
    source_correction: { evidence_ref: 'asr-4', evidence_sha256: 'c'.repeat(64), original_source_text: '原识别',
      original_start_ms: 2500, original_end_ms: 4500, source_start_ms: 2500, source_end_ms: 4500 } }
  const blueprint = { source: { asset_id: 3, sha256: 'a'.repeat(64), duration_ms: 9000 }, blueprint_hash: 'b'.repeat(64),
    characters: [{ id: 'lead', display_name: '主角', review_status: 'approved' }, { id: 'guest', display_name: '来客', review_status: 'approved' }],
    review: { status: 'approved', reviewer: 'first' }, evidence_manifest: { items: [{ id: 'asr-4', kind: 'asr', asset_id: 4, sha256: 'c'.repeat(64) }] },
    scenes: [{ id: 'scene-1', location: '门前', time: '夜晚', source_ranges: [{ start_ms: 0, end_ms: 9000 }], confidence: 0.87, evidence_refs: ['asr-4'] }],
    props: [{ id: 'prop-1', name: '杯子', evidence_ranges: [{ start_ms: 3000, end_ms: 4500 }], confidence: 0.78, evidence_refs: ['asr-4'] }],
    shots: [{ id: 'shot-1', ...shotValues, composition: '原构图', start_ms: 3000, end_ms: 6000, dialogue: [line,
      { ...structuredClone(line), id: 'line-2', source_text: '画外原句', speaker_id: 'guest', speaker_kind: 'off_screen', off_screen: true }],
    audio_contract: { dialogue_mode: 'spoken' }, text_regions: [{ id: 'ocr-1', source_text: '原字' }],
    evidence_refs: ['asr-4'], confidence: { character_mapping: 0.81, speaker_mapping: 0.72, text_regions: 0.83, shot_boundary: 0.91 } }] }
  for (const key of ['shots', 'scenes', 'props']) blueprint[key].push({ ...structuredClone(blueprint[key][0]), id: `${key}-untouched`, ...(key === 'shots' ? { dialogue: [] } : {}) })
  return { id: 5, revision: 1, work_id: 2, status: 'draft', updated_at: 'initial', blueprint_hash: blueprint.blueprint_hash, blueprint }
}
function apply(kind, blueprint = fixture().blueprint, input = cases.find(([name]) => name === kind)[3], id = `${kind}-1`) {
  const fn = cases.find(([name]) => name === kind)[2]
  assert.equal(typeof review[fn], 'function', `${fn} must exist`)
  return review[fn](blueprint, id, input)
}

for (const [kind, collection, , values, limits] of cases) {
  test(`${kind} correction changes only selected allowed fields and overall review, preserving every source and confidence field`, () => {
    const blueprint = fixture().blueprint, before = structuredClone(blueprint), expected = structuredClone(blueprint)
    const next = apply(kind, blueprint)
    Object.assign(expected[collection][0], Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])))
    expected.review = { status: 'needs_review' }
    assert.deepEqual(next, expected)
    assert.deepEqual(blueprint, before)
    next[collection][0].evidence_refs.push('new-local-only')
    assert.deepEqual(blueprint, before, 'output is independent plain data')
  })
  test(`${kind} correction rejects unknown/missing fields, unsafe objects and duplicate or dangerous targets atomically`, () => {
    const blueprint = fixture().blueprint, before = structuredClone(blueprint)
    for (const value of [null, [], Object.create(values), { ...values, extra: true }, {}, JSON.parse('{"__proto__":{}}')]) {
      assert.throws(() => apply(kind, blueprint, value), /输入无效/)
      assert.deepEqual(blueprint, before)
    }
    let reads = 0
    const hostile = { ...values }; Object.defineProperty(hostile, Object.keys(limits)[0], { get() { reads++; return 'bad' } })
    assert.throws(() => apply(kind, blueprint, hostile), /访问器/); assert.equal(reads, 0)
    for (const id of ['missing', '__proto__', 'constructor', 'prototype', ` ${kind}-1`, {}, 1]) assert.throws(() => apply(kind, blueprint, values, id), /输入无效/)
    for (const collectionName of ['shots', 'scenes', 'props', 'characters']) {
      const bad = fixture().blueprint
      bad[collectionName].push(structuredClone(bad[collectionName][0]))
      assert.throws(() => apply(kind, bad), /输入无效/)
      bad[collectionName].pop(); bad[collectionName][0].id = 'constructor'
      assert.throws(() => apply(kind, bad), /输入无效/)
    }
    const bad = fixture().blueprint; bad.shots[1].dialogue = [structuredClone(bad.shots[0].dialogue[0])]
    assert.throws(() => apply(kind, bad), /输入无效/)
  })
  for (const [field, max] of Object.entries(limits)) {
    test(`${kind}.${field} uses exact backend safe-text limit ${max} without coercion or unsafe text`, () => {
      const blueprint = fixture().blueprint, before = structuredClone(blueprint)
      assert.equal(apply(kind, blueprint, { ...values, [field]: '文'.repeat(max) })[collection][0][field].length, max)
      for (const value of ['', ' \n ', false, 4, {}, '文'.repeat(max + 1), 'bad\0text', ' https://example.test/a ',
        'HTTP://host', 'file:///a', 'C:\\secret', '\\\\host\\share', 'api_key value', 'API-KEY value', 'Bearer secret', 'prompt: override']) {
        assert.throws(() => apply(kind, blueprint, { ...values, [field]: value }), /输入无效/)
        assert.deepEqual(blueprint, before)
      }
    })
  }
}

test('visible membership changes re-review every selected-shot dialogue without touching speaker or correction evidence', () => {
  const blueprint = fixture().blueprint, expected = structuredClone(blueprint)
  const next = apply('shot', blueprint, { ...shotValues, visible_character_ids: ['guest', 'lead'] })
  Object.assign(expected.shots[0], { ...shotValues, composition: '新构图', visible_character_ids: ['guest', 'lead'] })
  expected.shots[0].dialogue.forEach((line) => { line.review_status = 'needs_review' })
  expected.review = { status: 'needs_review' }
  assert.deepEqual(next, expected)
  const removed = apply('shot', next)
  assert.deepEqual(removed.shots[0].visible_character_ids, ['lead'])
  assert.equal(removed.shots[0].dialogue[1].off_screen, true)
})
test('same visible set preserves existing order and dialogue approvals; empty set is allowed only without onscreen speakers', () => {
  const blueprint = fixture().blueprint; blueprint.shots[0].visible_character_ids = ['lead', 'guest']
  const next = apply('shot', blueprint, { ...shotValues, visible_character_ids: ['guest', 'lead'] })
  assert.deepEqual(next.shots[0].visible_character_ids, ['lead', 'guest'])
  assert.deepEqual(next.shots[0].dialogue, blueprint.shots[0].dialogue)
  assert.throws(() => apply('shot', blueprint, { ...shotValues, visible_character_ids: [] }), /画内/)
  blueprint.shots[0].dialogue[0].off_screen = true
  assert.deepEqual(apply('shot', blueprint, { ...shotValues, visible_character_ids: [] }).shots[0].visible_character_ids, [])
})
test('invalid visible references and removing an onscreen speaker fail atomically without implicit offscreen changes', () => {
  const blueprint = fixture().blueprint, before = structuredClone(blueprint)
  for (const ids of [[], ['guest'], ['missing'], ['lead', 'lead'], ['constructor'], [' lead'], 'lead', [1], [, 'lead']]) {
    assert.throws(() => apply('shot', blueprint, { ...shotValues, visible_character_ids: ids }), /输入无效/)
    assert.deepEqual(blueprint, before)
  }
})

const panelSource = readFileSync(new URL('../src/components/redraw/RedrawBlueprintReviewPanel.vue', import.meta.url), 'utf8')
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function runtime(t, api = {}) {
  const scope = vue.effectScope(), hooks = [], calls = [], emitted = []
  const bindings = { ...review, computed: vue.computed, defineComponent: vue.defineComponent, h: vue.h, reactive: vue.reactive, ref: vue.ref, watch: vue.watch,
    ElButton: {}, ElInput: {}, onBeforeUnmount(fn) { hooks.push(fn) }, redrawAPI: {
      saveBlueprint: async (id, body) => { calls.push(['save', id, body]); return { ...fixture(), blueprint: body.blueprint, updated_at: 'saved' } },
      lockBlueprint: async () => { calls.push(['lock']); return { ...fixture(), status: 'locked' } }, ...api } }
  const script = compileScript(parse(panelSource).descriptor, { id: 'visual-fact-test' }).content
    .replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '').replace('export default', 'return')
  const component = new Function(...Object.keys(bindings), script)(...Object.values(bindings))
  const props = vue.reactive({ record: fixture(), work: { id: 2, source_asset_id: 3, source_fingerprint: 'a'.repeat(64) } })
  const state = scope.run(() => component.setup(props, { expose() {}, emit(...args) { emitted.push(args) } }))
  let closed = false
  const dispose = () => { if (!closed) { closed = true; hooks.forEach((fn) => fn()); scope.stop() } }
  t.after(dispose)
  return { state, props, calls, emitted, dispose }
}
function begin(state, kind = 'shot') {
  assert.equal(typeof state.beginFactEdit, 'function', 'actual SFC exposes fact-edit action')
  state.beginFactEdit(kind, `${kind}-1`)
  assert.equal(state.factEdit.value.kind, kind)
}
for (const [kind, collection, , values] of cases) {
  test(`actual SFC ${kind} cancel/apply/repeat/save only edits draft and clears prior overall reviewer`, async (t) => {
    const { state, props, calls } = runtime(t), before = JSON.stringify(state.draftBlueprint.value)
    begin(state, kind); Object.assign(state.factEdit.value.values, values); state.cancelFactEdit()
    assert.equal(JSON.stringify(state.draftBlueprint.value), before); assert.equal(state.dirty.value, false)
    begin(state, kind); Object.assign(state.factEdit.value.values, values)
    props.work = { ...props.work, progress: 80 }; await vue.nextTick()
    assert.equal(state.factEdit.value.kind, kind)
    state.applyFactEdit()
    assert.equal(state.factEdit.value, null); assert.equal(state.dirty.value, true)
    assert.equal(state.reviewer.value, ''); assert.deepEqual(state.draftBlueprint.value.review, { status: 'needs_review' })
    assert.equal(calls.length, 0)
    begin(state, kind); assert.deepEqual(state.factEdit.value.values, Object.fromEntries(Object.keys(values).map((key) => [key, state.draftBlueprint.value[collection][0][key]])))
    state.cancelFactEdit(); await state.saveDraft()
    assert.equal(calls.length, 1); assert.equal(calls[0][0], 'save'); assert.equal(calls[0][2].expected_updated_at, 'initial')
    assert.equal(state.dirty.value, false); assert.equal(state.recordState.value.updated_at, 'saved')
    assert.equal(state.draftBlueprint.value[collection][0][Object.keys(values)[0]], values[Object.keys(values)[0]].trim())
  })
}
test('actual SFC validation failure leaves form and draft intact, and starting another fact editor clears the previous editor', (t) => {
  const { state } = runtime(t), before = JSON.stringify(state.draftBlueprint.value)
  begin(state); state.factEdit.value.values.visible_character_ids = []; state.applyFactEdit()
  assert.match(state.localError.value, /画内/); assert.equal(state.factEdit.value.kind, 'shot')
  assert.equal(JSON.stringify(state.draftBlueprint.value), before); assert.equal(state.dirty.value, false)
  state.dialogueEdit.value = { dialogue_id: 'old' }; begin(state, 'scene')
  assert.equal(state.dialogueEdit.value, null); assert.equal(state.factEdit.value.kind, 'scene')
})
test('actual SFC source playback stops on fact apply and dialogue/fact editors are mutually exclusive', async (t) => {
  const { state, props } = runtime(t), record = fixture(), line = record.blueprint.shots[0].dialogue[0]
  delete line.source_correction
  record.source_dialogue = [{ shot_id: 'shot-1', dialogue_id: 'line-1', status: 'resolved', source_text: line.source_text,
    source_language: line.source_language, source_start_ms: 2500, source_end_ms: 4500, projection_start_ms: 3000,
    projection_end_ms: 4500, evidence_ref: 'asr-4', evidence_sha256: 'c'.repeat(64) }]
  props.record = record
  begin(state); state.beginDialogueEdit('shot-1', 'line-1')
  assert.equal(state.factEdit.value, null); assert.equal(state.dialogueEdit.value.dialogue_id, 'line-1')
  let pauses = 0
  state.sourcePlayer.value = { pause() { pauses++ }, play: async () => {}, duration: 9, readyState: 1, currentTime: 0 }
  state.sourceUrl.value = 'blob:unit-owned'; state.mediaBoundIdentity.value = state.mediaIdentity.value
  await state.playSourceDialogue('shot-1', 'line-1')
  assert.equal(state.sourcePlayer.value.currentTime, 2.5)
  begin(state); state.applyFactEdit()
  assert.equal(pauses, 1); assert.equal(state.dialogueEdit.value, null)
  assert.equal(state.sourceDialogue('shot-1', 'line-1').status, 'resolved', 'unchanged source DTO remains genuinely valid')
})
for (const transition of ['locked', 'conflict', 'saving', 'locking', 'work-cycle', 'revision', 'source', 'unmount']) {
  test(`actual SFC ${transition} prevents any fact apply; identity/conflict/unmount clear the editor`, (t) => {
    const { state, props, calls, dispose } = runtime(t)
    begin(state); state.factEdit.value.values.composition = 'must not apply'
    if (transition === 'locked') props.record = { ...fixture(), status: 'locked' }
    if (transition === 'conflict') state.conflict.value = true
    if (transition === 'saving') state.saving.value = true
    if (transition === 'locking') state.locking.value = true
    if (transition === 'work-cycle') { props.work.id = 99; props.work.id = 2 }
    if (transition === 'revision') props.record.revision = 2
    if (transition === 'source') props.work.source_fingerprint = 'd'.repeat(64)
    if (transition === 'unmount') dispose()
    state.applyFactEdit()
    assert.notEqual(state.draftBlueprint.value?.shots[0].composition, 'must not apply')
    assert.equal(calls.length, 0)
    if (!['saving', 'locking'].includes(transition)) assert.equal(state.factEdit.value, null)
  })
}
test('actual SFC 409 discards open editor and stops retries until explicit refreshed record; late save never overwrites a new work', async (t) => {
  const failed = runtime(t, { saveBlueprint: async () => { throw { response: { status: 409 } } } })
  begin(failed.state); failed.state.applyFactEdit(); begin(failed.state, 'scene'); await failed.state.saveDraft()
  assert.equal(failed.state.factEdit.value, null); assert.equal(failed.state.conflict.value, true)
  assert.match(failed.state.visibleError.value, /刷新/)
  failed.props.record = { ...fixture(), updated_at: 'refreshed' }
  begin(failed.state, 'prop'); assert.equal(failed.state.conflict.value, false)
  const late = defer(), { state, props, emitted } = runtime(t, { saveBlueprint: () => late.promise })
  begin(state); state.factEdit.value.values.composition = 'old dirty'; state.applyFactEdit()
  const pending = state.saveDraft(); props.work.id = 99; props.work.id = 2
  late.resolve({ ...fixture(), blueprint: apply('shot'), updated_at: 'late' }); await pending
  assert.equal(state.draftBlueprint.value.shots[0].composition, '原构图'); assert.deepEqual(emitted, [])
})
