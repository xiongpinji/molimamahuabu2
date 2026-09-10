import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import * as reviewState from '../src/utils/redrawBlueprintReviewState.js'

function fixture() {
  const blueprint = {
    source: { asset_id: 3, sha256: 'a'.repeat(64), duration_ms: 6000 },
    blueprint_hash: 'b'.repeat(64),
    characters: [],
    evidence_manifest: { items: [{ id: 'asr-4', kind: 'asr', asset_id: 4, sha256: 'c'.repeat(64) }] },
    shots: [{ id: 'shot-2', start_ms: 3000, end_ms: 6000, visible_character_ids: [], dialogue: [{
      id: 'line-1', start_ms: 3000, end_ms: 4500, source_text: 'Do not open that door.',
      source_language: 'en', evidence_refs: ['asr-4'], speaker_kind: 'character', speaker_id: 'lead',
    }] }],
  }
  return {
    id: 5, work_id: 2, status: 'draft', updated_at: '2026-09-05T09:00:00Z',
    blueprint_hash: blueprint.blueprint_hash, blueprint,
    source_dialogue: [{
      dialogue_id: 'line-1', shot_id: 'shot-2', status: 'resolved', reason: 'SOURCE_DIALOGUE_RESOLVED',
      source_start_ms: 2500, source_end_ms: 4500, source_text: 'Do not open that door.', source_language: 'en',
      projection_start_ms: 3000, projection_end_ms: 4500, cross_shot: true,
      evidence_ref: 'asr-4', evidence_sha256: 'c'.repeat(64),
    }],
  }
}

function resolve(record, blueprint = record.blueprint) {
  assert.equal(typeof reviewState.dialogueSourceForReview, 'function')
  return reviewState.dialogueSourceForReview(record, blueprint, 'shot-2', 'line-1')
}

test('review uses the whole sentence range, not its clipped shot projection', () => {
  const record = fixture()
  const before = JSON.stringify(record)
  const source = resolve(record)
  assert.equal(source.status, 'resolved')
  assert.deepEqual([source.source_start_ms, source.source_end_ms], [2500, 4500])
  assert.equal(source.cross_shot, true)
  assert.equal(JSON.stringify(record), before)
})

test('legacy and unresolved evidence never invent a full source range', () => {
  const record = fixture()
  delete record.source_dialogue
  assert.equal(resolve(record).status, 'not_available')
  record.source_dialogue = [{ dialogue_id: 'line-1', shot_id: 'shot-2', status: 'unresolved', reason: 'SOURCE_DIALOGUE_HASH_MISMATCH' }]
  assert.equal(resolve(record).status, 'unresolved')
  assert.equal(resolve(record).source_start_ms, undefined)
})

test('source edits, changed evidence and a changed blueprint invalidate the read-only source binding', () => {
  for (const mutate of [
    (draft) => { draft.shots[0].dialogue[0].source_text = 'A corrected sentence.' },
    (draft) => { draft.shots[0].dialogue[0].start_ms = 3100 },
    (draft) => { draft.shots[0].dialogue[0].evidence_refs = ['other'] },
    (draft) => { draft.evidence_manifest.items[0].sha256 = 'd'.repeat(64) },
    (draft) => { draft.source.sha256 = 'd'.repeat(64) },
    (draft) => { delete draft.source.sha256 },
    (draft) => { draft.source.asset_id = 33 },
    (draft) => { draft.blueprint_hash = 'd'.repeat(64) },
  ]) {
    const record = fixture()
    const draft = structuredClone(record.blueprint)
    mutate(draft)
    assert.equal(resolve(record, draft).status, 'unresolved')
  }
})

test('duplicate or invalid resolved spans cannot enable source playback', () => {
  for (const mutate of [
    (record) => { record.source_dialogue.push({ ...record.source_dialogue[0] }) },
    (record) => { record.source_dialogue[0].source_start_ms = -1 },
    (record) => { record.source_dialogue[0].source_end_ms = 6001 },
    (record) => { record.source_dialogue[0].source_end_ms = 2500 },
    (record) => { record.source_dialogue[0].projection_start_ms = 3200 },
    (record) => { record.source_dialogue[0].source_language = 'fr' },
  ]) {
    const record = fixture()
    mutate(record)
    assert.equal(resolve(record).status, 'unresolved')
  }
})

const panelSource = readFileSync(new URL('../src/components/redraw/RedrawBlueprintReviewPanel.vue', import.meta.url), 'utf8')

function panelRuntime(t) {
  const scope = vue.effectScope()
  const unmount = []
  const runtime = {
    computed: vue.computed, defineComponent: vue.defineComponent, h: vue.h,
    reactive: vue.reactive, ref: vue.ref, watch: vue.watch,
    ...reviewState, redrawAPI: { getSourceVideo: async () => new Blob(['video'], { type: 'video/mp4' }) }, ElButton: {}, ElInput: {},
    onBeforeUnmount(fn) { unmount.push(fn) },
  }
  const { descriptor } = parse(panelSource)
  const script = compileScript(descriptor, { id: 'dialogue-source-review-test' }).content
    .replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g, '')
    .replace('export default', 'return')
  const component = new Function(...Object.keys(runtime), script)(...Object.values(runtime))
  const props = vue.reactive({ record: fixture(), work: {
    id: 2, source_asset_id: 3, source_fingerprint: 'a'.repeat(64), url: '/api/v1/redraw/works/2/source-video',
  } })
  const state = scope.run(() => component.setup(props, { expose() {}, emit() {} }))
  t.after(() => { unmount.forEach((fn) => fn()); scope.stop() })
  return { state, props, unmount }
}

test('actual review component seeks to full source start and stops at full source end', async (t) => {
  const { state } = panelRuntime(t)
  await state.loadSourceVideo()
  assert.equal(typeof state.playSourceDialogue, 'function')
  let plays = 0
  let pauses = 0
  const player = { currentTime: 0, readyState: 1, duration: 6, play: async () => { plays++ }, pause() { pauses++ } }
  state.sourcePlayer.value = player
  await state.playSourceDialogue('shot-2', 'line-1')
  assert.equal(plays, 1)
  assert.equal(player.currentTime, 2.5)
  const beforeEnd = pauses
  player.currentTime = 4.4
  state.onSourceTimeUpdate()
  assert.equal(pauses, beforeEnd)
  player.currentTime = 4.5
  state.onSourceTimeUpdate()
  assert.equal(pauses, beforeEnd + 1)
})

test('source playback cannot use an unresolved span or a different work and stops on record changes', async (t) => {
  const { state, props } = panelRuntime(t)
  await state.loadSourceVideo()
  assert.equal(typeof state.playSourceDialogue, 'function')
  let plays = 0
  let pauses = 0
  state.sourcePlayer.value = { currentTime: 0, readyState: 1, duration: 6, play: async () => { plays++ }, pause() { pauses++ } }
  await state.playSourceDialogue('shot-2', 'line-1')
  const initialPauses = pauses
  props.record = { ...fixture(), updated_at: '2026-09-05T10:00:00Z' }
  await vue.nextTick()
  assert.ok(pauses > initialPauses)
  props.work = { id: 99, url: '/api/v1/redraw/works/99/source-video' }
  await vue.nextTick()
  await state.playSourceDialogue('shot-2', 'line-1')
  assert.equal(plays, 1)
  props.work = { id: 2, url: '/api/v1/redraw/works/2/source-video' }
  state.recordState.value.source_dialogue[0].status = 'unresolved'
  await state.playSourceDialogue('shot-2', 'line-1')
  assert.equal(plays, 1)
})

test('review template labels both full and projected timing and exposes the playback action', () => {
  assert.match(panelSource, /整句源范围/)
  assert.match(panelSource, /镜头内显示范围/)
  assert.match(panelSource, /播放整句原声/)
  assert.match(panelSource, /@timeupdate="onSourceTimeUpdate"/)
  assert.match(panelSource, /<div v-if="!sourceUrl" class="media-empty">/)
})

test('missing hashes in both persisted and draft source never count as a bound range', () => {
  const record = fixture()
  delete record.blueprint.source.sha256
  assert.equal(resolve(record).status, 'unresolved')
})

test('the actual player ignores supplied URLs and uses only its authenticated identity-bound Blob', async (t) => {
  const { state, props } = panelRuntime(t)
  let plays = 0
  state.sourcePlayer.value = { currentTime: 0, readyState: 1, duration: 6, play: async () => { plays++ }, pause() {} }
  props.work.url = '/api/v1/redraw/works/99/source-video'
  await vue.nextTick()
  await state.loadSourceVideo()
  await state.playSourceDialogue('shot-2', 'line-1')
  assert.equal(plays, 1)
  assert.match(state.sourceUrl.value, /^blob:/)
})

test('a late old play promise cannot pause the reused player after a work switch', async (t) => {
  const { state, props } = panelRuntime(t)
  await state.loadSourceVideo()
  let finishOld
  let pauses = 0
  state.sourcePlayer.value = {
    currentTime: 0, readyState: 1, duration: 6,
    play: () => new Promise((resolve) => { finishOld = resolve }), pause() { pauses++ },
  }
  const pending = state.playSourceDialogue('shot-2', 'line-1')
  props.work = { id: 99, url: '/api/v1/redraw/works/99/source-video' }
  await vue.nextTick()
  const afterSwitch = pauses
  finishOld()
  await pending
  assert.equal(pauses, afterSwitch)
})

for (const field of ['source_asset_id', 'source_fingerprint']) {
  test(`same-work ${field} replacement invalidates evidence and stops old playback`, async (t) => {
    const { state, props } = panelRuntime(t)
    await state.loadSourceVideo()
    let plays = 0
    let pauses = 0
    state.sourcePlayer.value = { currentTime: 0, readyState: 1, duration: 6,
      play: async () => { plays++ }, pause() { pauses++ } }
    await state.playSourceDialogue('shot-2', 'line-1')
    const before = pauses
    props.work[field] = field === 'source_asset_id' ? 99 : 'd'.repeat(64)
    await vue.nextTick()
    assert.equal(state.sourceDialogue('shot-2', 'line-1').status, 'unresolved')
    assert.equal(state.sourcePlaybackReady.value, false)
    assert.ok(pauses > before)
    await state.playSourceDialogue('shot-2', 'line-1')
    assert.equal(plays, 1)
  })
}
