import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import * as review from '../src/utils/redrawBlueprintReviewState.js'

function fixture() {
  const line = { id: 'line-1', source_text: 'Original sentence.', source_language: 'en', start_ms: 3000, end_ms: 4500,
    evidence_refs: ['asr-4'], speaker_id: 'lead', speaker_kind: 'character', off_screen: false, review_status: 'approved' }
  const blueprint = { source: { asset_id: 3, sha256: 'a'.repeat(64), duration_ms: 6000 }, blueprint_hash: 'b'.repeat(64),
    characters: [{ id: 'lead', review_status: 'approved' }], review: { status: 'approved', reviewer: 'first' },
    evidence_manifest: { items: [{ id: 'asr-4', kind: 'asr', asset_id: 4, sha256: 'c'.repeat(64) }] },
    shots: [{ id: 'shot-2', start_ms: 3000, end_ms: 6000, visible_character_ids: ['lead'], dialogue: [line,
      { ...line, id: 'line-2', source_text: 'Untouched.' }] }] }
  return { id: 5, revision: 1, work_id: 2, status: 'draft', updated_at: 'initial', blueprint_hash: blueprint.blueprint_hash, blueprint,
    source_dialogue: [{ shot_id: 'shot-2', dialogue_id: 'line-1', status: 'resolved', source_text: line.source_text,
      source_language: 'en', source_start_ms: 2500, source_end_ms: 4500, projection_start_ms: 3000, projection_end_ms: 4500,
      evidence_ref: 'asr-4', evidence_sha256: 'c'.repeat(64) }] }
}
const turn = (blueprint) => blueprint.shots[0].dialogue[0]
const values = { source_text: 'Correct sentence.', source_start_ms: 2401, source_end_ms: 4802 }
function apply(record, blueprint = record.blueprint, input = values) {
  assert.equal(typeof review.applyDialogueSourceCorrection, 'function', 'manual source correction helper exists')
  return review.applyDialogueSourceCorrection(record, blueprint, 'shot-2', 'line-1', input)
}
function restore(record, blueprint) {
  assert.equal(typeof review.restoreDialogueSourceCorrection, 'function')
  return review.restoreDialogueSourceCorrection(record, blueprint, 'shot-2', 'line-1')
}
function savedFixture(blueprint) {
  const record = fixture(), correction = turn(blueprint).source_correction
  record.blueprint = blueprint
  Object.assign(record.source_dialogue[0], { source_origin: 'manual_correction', source_text: turn(blueprint).source_text,
    projection_start_ms: turn(blueprint).start_ms, projection_end_ms: turn(blueprint).end_ms,
    ...correction })
  return record
}

test('single source edit preserves original evidence, unselected fields and inputs, with full cross-shot timing', () => {
  const record = fixture(), before = structuredClone(record)
  const next = apply(record)
  assert.deepEqual(record, before)
  const { source_text, start_ms, end_ms, source_correction, review_status, ...unchanged } = turn(next)
  const { source_text: a, start_ms: b, end_ms: c, review_status: d, ...originalFields } = turn(before.blueprint)
  assert.deepEqual(unchanged, originalFields)
  assert.deepEqual([source_text, start_ms, end_ms, review_status], ['Correct sentence.', 3000, 4802, 'needs_review'])
  assert.deepEqual(source_correction, { evidence_ref: 'asr-4', evidence_sha256: 'c'.repeat(64),
    original_source_text: 'Original sentence.', original_start_ms: 2500, original_end_ms: 4500,
    source_start_ms: 2401, source_end_ms: 4802 })
  assert.deepEqual(next.shots[0].dialogue[1], before.blueprint.shots[0].dialogue[1])
  for (const key of ['source', 'evidence_manifest', 'characters', 'blueprint_hash']) assert.deepEqual(next[key], before.blueprint[key])
  assert.deepEqual(next.review, { status: 'needs_review' })
  assert.equal(review.dialogueSourceForReview(record, next, 'shot-2', 'line-1').status, 'unresolved')
})

test('unsaved and saved repeated edits keep the original ASR anchor; restore removes only the correction and requires review', () => {
  const record = fixture(), first = apply(record), repeated = apply(record, first, { ...values, source_text: 'Again.' })
  assert.deepEqual(turn(repeated).source_correction, turn(first).source_correction)
  const persisted = savedFixture(first)
  assert.equal(review.dialogueSourceForReview(persisted, first, 'shot-2', 'line-1').status, 'resolved')
  const afterSave = apply(persisted, first, { ...values, source_text: 'After save.' })
  assert.equal(turn(afterSave).source_correction.original_source_text, 'Original sentence.')
  const restored = restore(persisted, afterSave)
  assert.deepEqual(turn(restored), { ...turn(record.blueprint), review_status: 'needs_review' })
  assert.deepEqual(restored.review, { status: 'needs_review' })
  assert.equal(review.dialogueSourceForReview(persisted, restored, 'shot-2', 'line-1').status, 'unresolved')
})

test('changing only the full range invalidates a saved DTO even when text and shot projection are unchanged', () => {
  const record = fixture(), first = apply(record, record.blueprint, { source_text: 'Original sentence.', source_start_ms: 2000, source_end_ms: 4500 })
  const saved = savedFixture(first), second = apply(saved, first, { source_text: 'Original sentence.', source_start_ms: 2200, source_end_ms: 4500 })
  assert.equal(turn(second).start_ms, turn(first).start_ms)
  assert.equal(review.dialogueSourceForReview(saved, second, 'shot-2', 'line-1').status, 'unresolved')
})

test('invalid text, ranges, unknown targets and unsafe objects fail atomically before reading getters', () => {
  const record = fixture(), before = structuredClone(record)
  for (const input of [{ ...values, source_text: '' }, { ...values, source_text: ' '.repeat(5) }, { ...values, source_text: 'a'.repeat(501) },
    { ...values, source_text: 1 }, { ...values, extra: true }, Object.create(values),
    ...[-1, 1.5, NaN, Infinity, '2000', true, Number.MAX_SAFE_INTEGER + 1].map((source_start_ms) => ({ ...values, source_start_ms })),
    ...[2401, 2000, 6001, '4000'].map((source_end_ms) => ({ ...values, source_end_ms })),
    { ...values, source_start_ms: 0, source_end_ms: 3000 }]) {
    assert.throws(() => apply(record, record.blueprint, input), /输入无效/)
    assert.deepEqual(record, before)
  }
  assert.throws(() => review.applyDialogueSourceCorrection(record, record.blueprint, 'missing', 'line-1', values), /输入无效/)
  assert.throws(() => review.applyDialogueSourceCorrection(record, record.blueprint, 'shot-2', 'missing', values), /输入无效/)
  let reads = 0
  const hostile = { ...values }; Object.defineProperty(hostile, 'source_text', { get() { reads++; return 'Injected' } })
  assert.throws(() => apply(record, record.blueprint, hostile), /访问器/)
  const hostileRecord = { ...record }; Object.defineProperty(hostileRecord, 'source_dialogue', { get() { reads++; return [] } })
  assert.throws(() => apply(hostileRecord), /访问器/)
  const poisoned = JSON.parse('{"__proto__":{}}')
  assert.throws(() => apply(record, { ...record.blueprint, poisoned }), /危险字段/)
  assert.equal(reads, 0)
})

test('missing, duplicate or drifted original evidence and forged manual anchors prohibit source correction', () => {
  for (const mutate of [
    (r) => { delete r.source_dialogue }, (r) => { r.status = 'locked' },
    (r) => { r.source_dialogue[0].status = 'unresolved' }, (r) => { r.source_dialogue.push({ ...r.source_dialogue[0] }) },
    (r) => { r.blueprint.evidence_manifest.items[0].sha256 = 'd'.repeat(64) },
    (r) => { r.source_dialogue[0].source_origin = 'manual_correction' },
    (r) => { r.blueprint.shots.push(structuredClone(r.blueprint.shots[0])) },
  ]) { const record = fixture(); mutate(record); assert.throws(() => apply(record), /输入无效/) }
  for (const mutate of [
    (b) => { b.source.asset_id = 9 }, (b) => { b.source.sha256 = 'd'.repeat(64) },
    (b) => { b.source.duration_ms = 7000 }, (b) => { b.blueprint_hash = 'd'.repeat(64) },
    (b) => { b.evidence_manifest.items[0].sha256 = 'd'.repeat(64) },
    (b) => { turn(b).evidence_refs = ['unrelated'] }, (b) => { turn(b).source_language = 'fr' },
    (b) => { b.shots[0].start_ms = 3500 },
  ]) { const record = fixture(), draft = structuredClone(record.blueprint); mutate(draft); assert.throws(() => apply(record, draft), /输入无效/) }
  for (const mutate of [
    (r) => { r.source_dialogue[0].original_source_text = 'Forged' },
    (r) => { delete r.source_dialogue[0].original_start_ms },
    (r) => { turn(r.blueprint).source_correction.extra = true },
    (r) => { r.source_dialogue[0].source_origin = 'asr' },
  ]) { const record = savedFixture(apply(fixture())); mutate(record); assert.throws(() => apply(record), /输入无效/) }
})

test('decimal seconds preserve exact millisecond input and reject coercion or silent rounding', () => {
  assert.equal(typeof review.dialogueSecondsToMilliseconds, 'function')
  for (const [value, result] of [['0', 0], ['2.401', 2401], ['4.80', 4800], ['12.001', 12001], ['1.005', 1005]]) {
    assert.equal(review.dialogueSecondsToMilliseconds(value), result)
  }
  for (const value of ['', ' ', '-1', '1.0001', '1e3', 'Infinity', '0x10', '.5', '1.', true, 1, '9007199254741.999']) {
    assert.throws(() => review.dialogueSecondsToMilliseconds(value), /输入无效/)
  }
})

test('source correction accepts every backend audio evidence kind, rejects non-audio and NUL text', () => {
  for (const kind of ['asr', 'audio', 'audio_transcript', 'transcript']) {
    const record = fixture(); record.blueprint.evidence_manifest.items[0].kind = kind
    assert.equal(turn(apply(record)).source_text, values.source_text)
  }
  const record = fixture(); record.blueprint.evidence_manifest.items[0].kind = 'ocr'
  assert.throws(() => apply(record), /输入无效/)
  assert.throws(() => apply(fixture(), fixture().blueprint, { ...values, source_text: 'bad\0text' }), /输入无效/)
})

test('saved short correction retains a long original ASR anchor and rejects restoring it beyond the effective text limit', () => {
  const record = savedFixture(apply(fixture()))
  const long = 'Original '.repeat(200)
  record.source_dialogue[0].original_source_text = long
  turn(record.blueprint).source_correction.original_source_text = long
  const edited = apply(record)
  assert.equal(turn(edited).source_correction.original_source_text, long)
  assert.throws(() => restore(record, edited), /过长/)
  record.source_dialogue[0].original_source_text = 'bad\0original'
  turn(record.blueprint).source_correction.original_source_text = 'bad\0original'
  assert.throws(() => apply(record), /输入无效/)
  record.source_dialogue[0].original_source_text = 'a' + ' '.repeat(16384)
  turn(record.blueprint).source_correction.original_source_text = record.source_dialogue[0].original_source_text
  assert.throws(() => apply(record), /输入无效/)
})

const panelSource = readFileSync(new URL('../src/components/redraw/RedrawBlueprintReviewPanel.vue', import.meta.url), 'utf8')
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function runtime(t, api = {}) {
  const scope = vue.effectScope(), hooks = [], calls = [], urls = [], revoked = [], emitted = []
  const bindings = { ...review, computed: vue.computed, defineComponent: vue.defineComponent, h: vue.h,
    reactive: vue.reactive, ref: vue.ref, watch: vue.watch, ElButton: {}, ElInput: {},
    URL: { createObjectURL(blob) { assert.ok(blob instanceof Blob); const url = `blob:owned-${urls.length}`; urls.push(url); return url },
      revokeObjectURL(url) { revoked.push(url) } }, onBeforeUnmount(fn) { hooks.push(fn) },
    redrawAPI: { getSourceVideo: async (...args) => { calls.push(['media', ...args]); return new Blob(['bytes'], { type: 'video/mp4' }) },
      saveBlueprint: async (workId, body) => { calls.push(['save', workId, body]); return { ...savedFixture(body.blueprint), updated_at: 'saved' } },
      lockBlueprint: async () => { calls.push(['lock']); }, ...api } }
  const script = compileScript(parse(panelSource).descriptor, { id: 'dialogue-correction-test' }).content
    .replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '').replace('export default', 'return')
  const component = new Function(...Object.keys(bindings), script)(...Object.values(bindings))
  const props = vue.reactive({ record: fixture(), work: { id: 2, source_asset_id: 3, source_fingerprint: 'a'.repeat(64), url: 'https://hostile.invalid/video' } })
  const state = scope.run(() => component.setup(props, { expose() {}, emit(...args) { emitted.push(args) } }))
  let closed = false
  const dispose = () => { if (!closed) { closed = true; hooks.forEach((fn) => fn()); scope.stop() } }
  t.after(dispose)
  return { state, props, calls, urls, revoked, emitted, dispose }
}

test('actual API only GETs the fixed authenticated source endpoint with exact query and returns the Blob', async () => {
  const source = readFileSync(new URL('../src/api/redraw.js', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/gm, '').replace(/export /g, '')
  const calls = [], blob = new Blob(['bytes'], { type: 'video/mp4' })
  const api = new Function('request', `${source}; return redrawAPI`)({ get: async (...args) => { calls.push(args); return blob } })
  assert.equal(typeof api.getSourceVideo, 'function')
  const controller = new AbortController()
  assert.equal(await api.getSourceVideo(2, { asset_id: 3, sha256: 'a'.repeat(64), url: 'https://hostile.invalid' }, { signal: controller.signal }), blob)
  assert.deepEqual(calls, [['/redraw/works/2/source-video', { params: { expected_source_asset_id: 3, expected_source_sha256: 'a'.repeat(64) },
    responseType: 'blob', silentError: true, signal: controller.signal }]])
})

test('actual panel edits/cancels/applies exact text and full time as a draft, compares original and restores after save', async (t) => {
  const { state, calls, props } = runtime(t)
  assert.equal(typeof state.beginDialogueEdit, 'function')
  const original = JSON.stringify(state.draftBlueprint.value)
  state.beginDialogueEdit('shot-2', 'line-1')
  state.dialogueEdit.value.source_text = 'Cancelled'
  state.cancelDialogueEdit()
  assert.equal(JSON.stringify(state.draftBlueprint.value), original); assert.equal(state.dirty.value, false)
  state.beginDialogueEdit('shot-2', 'line-1')
  Object.assign(state.dialogueEdit.value, { source_text: 'Correct sentence.', start_seconds: '2.401', end_seconds: '4.802' })
  props.work = { ...props.work, progress: 90 }
  assert.equal(state.dialogueEdit.value.source_text, 'Correct sentence.')
  state.applyDialogueEdit()
  assert.equal(turn(state.draftBlueprint.value).source_correction.original_start_ms, 2500)
  assert.equal(state.sourceDialogue('shot-2', 'line-1').status, 'unresolved')
  assert.equal(state.originalDialogue('shot-2', 'line-1').original_source_text, 'Original sentence.')
  assert.equal(calls.length, 0)
  await state.saveDraft()
  assert.equal(calls.length, 1)
  assert.equal(state.sourceDialogue('shot-2', 'line-1').status, 'resolved')
  state.restoreDialogue('shot-2', 'line-1')
  assert.equal(turn(state.draftBlueprint.value).source_correction, undefined)
  assert.equal(turn(state.draftBlueprint.value).source_text, 'Original sentence.')
})

test('actual editor rejects invalid decimals without dirtying and is cleared/blocked by lock, conflict, identity change and unmount', (t) => {
  const { state, props, dispose, calls } = runtime(t)
  assert.equal(typeof state.beginDialogueEdit, 'function')
  state.beginDialogueEdit('shot-2', 'line-1'); state.dialogueEdit.value.start_seconds = '2.4001'; state.applyDialogueEdit()
  assert.equal(state.dirty.value, false); assert.match(state.localError.value, /输入无效/)
  for (const change of [() => { state.conflict.value = true }, () => { props.work.source_asset_id = 99 },
    () => { props.record = { ...fixture(), status: 'locked' } }, dispose]) {
    state.dialogueEdit.value = { shot_id: 'shot-2', dialogue_id: 'line-1', source_text: 'Bad', start_seconds: '2', end_seconds: '4' }
    change(); state.applyDialogueEdit(); state.restoreDialogue('shot-2', 'line-1')
    assert.equal(state.dialogueEdit.value, null)
    assert.equal(state.dirty.value, false)
  }
  assert.equal(calls.length, 0)
})

test('actual media is explicit, identity-bound Blob only; progress refresh reuses it, decode errors revoke it and allow explicit retry', async (t) => {
  const { state, props, calls, urls, revoked } = runtime(t)
  assert.equal(typeof state.loadSourceVideo, 'function')
  assert.equal(state.sourceUrl.value, ''); assert.equal(calls.length, 0)
  await state.loadSourceVideo()
  assert.equal(state.sourceUrl.value, urls[0]); assert.equal(state.sourcePlaybackReady.value, true)
  assert.deepEqual(calls[0].slice(0, 3), ['media', 2, { asset_id: 3, sha256: 'a'.repeat(64) }])
  props.work = { ...props.work, progress: 50 }; await vue.nextTick(); await state.loadSourceVideo()
  assert.equal(calls.length, 1)
  let pauses = 0; state.sourcePlayer.value = { pause() { pauses++ }, removeAttribute() {}, load() {} }
  state.onSourceMediaError()
  assert.equal(state.sourceUrl.value, ''); assert.equal(state.mediaStatus.value, 'undecodable'); assert.deepEqual(revoked, [urls[0]])
  assert.ok(pauses > 0); assert.equal(calls.length, 1)
  await state.loadSourceVideo(); assert.equal(calls.length, 2)
})

for (const transition of ['work-cycle', 'source', 'revision', 'conflict', 'unmount']) {
  test(`late Blob cannot attach after ${transition}; its independent request is aborted`, async (t) => {
    const late = defer(); let signal
    const { state, props, urls, dispose } = runtime(t, { getSourceVideo: (_id, _source, options) => { signal = options.signal; return late.promise } })
    assert.equal(typeof state.loadSourceVideo, 'function')
    const pending = state.loadSourceVideo()
    if (transition === 'work-cycle') { props.work.id = 99; props.work.id = 2 }
    if (transition === 'source') props.work.source_fingerprint = 'd'.repeat(64)
    if (transition === 'revision') props.record = { ...fixture(), revision: 2 }
    if (transition === 'conflict') state.conflict.value = true
    if (transition === 'unmount') dispose()
    assert.equal(signal.aborted, true)
    late.resolve(new Blob(['late'], { type: 'video/mp4' })); await pending
    assert.equal(state.sourceUrl.value, ''); assert.equal(urls.length, 0)
  })
}

test('media loading does not occupy saving request and a current 409 freezes editing without automatic retry', async (t) => {
  const late = defer(), { state, calls } = runtime(t, { getSourceVideo: () => late.promise })
  assert.equal(typeof state.loadSourceVideo, 'function')
  const pending = state.loadSourceVideo()
  state.beginDialogueEdit('shot-2', 'line-1'); state.applyDialogueEdit(); await state.saveDraft()
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'save')
  late.resolve(new Blob(['late'], { type: 'video/mp4' })); await pending
  const failing = runtime(t, { getSourceVideo: async () => { throw { response: { status: 409 } } } })
  await failing.state.loadSourceVideo()
  assert.equal(failing.state.conflict.value, true); assert.equal(failing.state.sourceUrl.value, '')
  assert.equal(failing.state.canEdit.value, false)
})

test('current media 409 exposes the existing visible refresh alert and only a refreshed record permits explicit reload', async (t) => {
  let gets = 0
  const { state, props, calls } = runtime(t, { getSourceVideo: async () => {
    if (++gets === 1) throw { response: { status: 409 } }
    return new Blob(['video'], { type: 'video/mp4' })
  } })
  assert.equal(state.localError.value, '')
  assert.equal(Boolean(state.visibleError.value), false)
  await state.loadSourceVideo()
  assert.equal(state.conflict.value, true)
  assert.equal(state.canEdit.value, false)
  assert.equal(state.sourceUrl.value, '')
  assert.equal(state.visibleError.value, '母本蓝图已变化，请刷新后重试', 'existing refresh button is inside the visibleError alert')
  await state.loadSourceVideo(); await state.saveDraft(); await state.lockDraft()
  assert.equal(gets, 1); assert.deepEqual(calls, [])
  props.record = { ...fixture(), updated_at: 'explicitly-refreshed' }
  await vue.nextTick()
  assert.equal(state.conflict.value, false); assert.equal(state.canEdit.value, true)
  assert.equal(state.localError.value, '')
  assert.equal(gets, 1, 'refresh must not automatically download media')
  await state.loadSourceVideo()
  assert.equal(gets, 2); assert.equal(state.sourcePlaybackReady.value, true)
})

test('invalid source/work IDs never enable a media GET through boolean or numeric string coercion', async (t) => {
  for (const value of [true, '3.0', '03', '3e0', ' 3 ', 'source-3', 0, -1]) {
    const { state, props, calls } = runtime(t)
    props.record.blueprint.source.asset_id = value
    props.work.source_asset_id = value
    props.record = structuredClone(vue.toRaw(props.record))
    await state.loadSourceVideo()
    assert.equal(state.sourceUrl.value, '')
    assert.equal(calls.length, 0, 'no coerced source ID: ' + value)
  }
})

for (const change of ['source', 'work', 'revision', 'conflict', 'unmount']) {
  test('a loaded URL is stopped and revoked on ' + change, async (t) => {
    const { state, props, urls, revoked, dispose } = runtime(t)
    await state.loadSourceVideo()
    let paused = 0
    state.sourcePlayer.value = { pause() { paused++ }, removeAttribute() {}, load() {} }
    if (change === 'source') props.work.source_asset_id = 4
    if (change === 'work') props.work.id = 99
    if (change === 'revision') props.record = { ...fixture(), updated_at: 'next' }
    if (change === 'conflict') state.conflict.value = true
    if (change === 'unmount') dispose()
    assert.equal(state.sourceUrl.value, '')
    assert.deepEqual(revoked, [urls[0]])
    assert.ok(paused > 0)
  })
}

test('a late media failure cannot replace a new loaded URL, and non-video/failed responses never retry themselves', async (t) => {
  const late = defer(); let requests = 0
  const { state, props, urls } = runtime(t, { getSourceVideo: () => ++requests === 1 ? late.promise : new Blob(['new'], { type: 'video/mp4' }) })
  const pending = state.loadSourceVideo()
  props.record = { ...fixture(), updated_at: 'next' }
  await state.loadSourceVideo()
  late.reject({ response: { status: 409 } }); await pending
  assert.equal(state.sourceUrl.value, urls[0])
  assert.equal(state.conflict.value, false)
  assert.equal(state.localError.value, '')
  assert.equal(Boolean(state.visibleError.value), false)
  for (const invalid of [new Blob(['json'], { type: 'application/json' }), new Blob([], { type: 'video/mp4' }), { data: new Blob(['video']) }]) {
    let gets = 0
    const failed = runtime(t, { getSourceVideo: async () => { gets++; return invalid } })
    await failed.state.loadSourceVideo(); await vue.nextTick()
    assert.equal(failed.state.sourceUrl.value, '')
    assert.equal(failed.state.mediaStatus.value, 'error')
    assert.equal(gets, 1)
  }
})
