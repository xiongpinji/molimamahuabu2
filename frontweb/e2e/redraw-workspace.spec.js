import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { handleMotionFixture, motionFixtureState, motionCandidate, nextMotionBytes } from './helpers/redrawMotionFixtures.js'

const fixtureVideoPath = fileURLToPath(new URL('../../项目截图/1.mp4', import.meta.url))
const actorPreviewBytes = readFileSync(new URL('./fixtures/redraw-latin-american-case/actor-cast-reference.png', import.meta.url))
const neutralPreviewBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

const readyIdentityPack = {
  schema_version: 'target-actor-identity-v1',
  source_character_key: 'source-character-maya',
  target_actor_label: 'Maya Rivera',
  confirmed_views: ['front', 'profile', 'full_body'],
  live_action_human_confirmed: true,
  adult_status: 'verified_18_plus',
  identity_consistency_confirmed: true,
  pack_sha256: 'a'.repeat(64),
  ready: true,
}
const readyIdentityStatus = {
  ready: true,
  missing_views: [],
  missing_confirmations: [],
  hash_valid: true,
}

const project = {
  id: 41,
  title: '转绘输入验收项目',
  status: 'draft',
  default_locale: 'zh-CN',
  default_market: 'CN',
  updated_at: '2026-08-06T08:00:00.000Z',
}

const workBase = {
  id: 710,
  project_id: project.id,
  source_asset_id: 910,
  source_fingerprint: 'a'.repeat(64),
  status: 'draft',
  current_step: 1,
  task_id: '',
  task_status: '',
  task_progress: 0,
}

const processingWork = {
  ...workBase,
  status: 'processing',
  task_id: 'task-redraw-710',
  task_status: 'processing',
  task_progress: 68,
  task_message: '正在分析源片',
  analysis_quote: { credits: 6 },
}

const redrawAssets = [
  {
    id: 1201,
    version_id: 812,
    kind: 'character',
    localized_name: '林夏',
    localized_description: '主角，保留原片服装事实。',
    status: 'generated',
    approval_status: 'pending',
    asset_id: 2201,
    identity_pack: { ...readyIdentityPack },
    identity_pack_status: { ...readyIdentityStatus },
    updated_at: '2026-08-06T08:10:00.000Z',
  },
  {
    id: 1202,
    version_id: 812,
    kind: 'scene',
    localized_name: '旧城天台',
    localized_description: '本地化场景与去人净景已生成。',
    status: 'generated',
    approval_status: 'pending',
    clean_plate_asset_id: 2202,
    updated_at: '2026-08-06T08:10:00.000Z',
  },
  {
    id: 1203,
    version_id: 812,
    kind: 'prop',
    localized_name: '铜钥匙',
    localized_description: '关键道具，保持金属钥匙设定。',
    status: 'generated',
    approval_status: 'pending',
    asset_id: 2203,
    updated_at: '2026-08-06T08:10:00.000Z',
  },
]

const localizationQuote = {
  priced: true,
  credits: 9,
  model: 'verified-text-model',
  input_hash: 'f'.repeat(64),
  quote_hash: 'e'.repeat(64),
}

function blueprintReviewRecord({
  workId = workBase.id,
  status = 'draft',
  storySummary = '雨夜订单把男主重新带回旧案。',
} = {}) {
  return {
    id: 901,
    work_id: workId,
    revision: 1,
    status,
    blueprint_hash: 'c'.repeat(64),
    updated_at: '2026-09-03T10:00:00.000Z',
    blueprint: {
      schema_version: 'episode-blueprint-v1',
      source: {
        asset_id: 910,
        sha256: 'a'.repeat(64),
        duration_ms: 6_000,
        width: 1080,
        height: 1920,
        fps: 25,
        video_codec: 'h264',
        audio_codec: 'aac',
        audio_sample_rate_hz: 48_000,
        audio_channels: 2,
      },
      evidence_manifest: {
        items: [
          { id: 'evidence-audio-1', kind: 'audio_transcript', asset_id: 'audio-1', sha256: 'b'.repeat(64), tool: 'local-asr', tool_version: '1.0' },
          { id: 'evidence-visual-1', kind: 'visual', asset_id: 'visual-1', sha256: 'd'.repeat(64), tool: 'local-vision', tool_version: '1.0' },
        ],
      },
      story: {
        summary: storySummary,
        beats: ['男主送达订单', '旧案编号重新出现'],
        evidence_refs: ['evidence-visual-1'],
        confidence: 0.88,
      },
      characters: [{
        id: 'character-lead',
        source_name: '男主',
        display_name: '男主',
        relationship: '骑手',
        relationships: ['与旧案有关'],
        face_track_ids: ['face-track-1'],
        evidence_refs: ['evidence-visual-1'],
        confidence: 0.92,
        review_status: 'approved',
      }],
      scenes: [{
        id: 'scene-storefront', location: '便利店门口', time: '雨夜',
        source_ranges: [{ start_ms: 0, end_ms: 6_000 }],
        evidence_refs: ['evidence-visual-1'], confidence: 0.91,
      }],
      props: [{
        id: 'prop-order-bag', name: '密封餐袋',
        evidence_ranges: [{ start_ms: 0, end_ms: 6_000 }],
        evidence_refs: ['evidence-visual-1'], confidence: 0.87,
      }],
      shots: [{
        id: 'shot-1', index: 1, start_ms: 0, end_ms: 6_000,
        composition: '男主站在便利店门口。', camera_movement: '缓慢前推',
        opening_state: '男主抱着餐袋。', continuous_action: '男主抬头望向路边。', ending_state: '男主停在车旁。',
        visible_character_ids: ['character-lead'],
        dialogue: [{
          id: 'dialogue-1', speaker_id: 'speaker-cluster-1', speaker_kind: 'voice_cluster', off_screen: false,
          start_ms: 500, end_ms: 1_800, source_text: '尾号八七的订单到了。', source_language: 'zh-CN', emotion: '克制',
          evidence_refs: ['evidence-audio-1'], confidence: 0.73, review_status: 'needs_review',
        }],
        text_regions: [{
          id: 'text-region-1', kind: 'screen_text', polygon: [[0.2, 0.3], [0.8, 0.3], [0.8, 0.5], [0.2, 0.5]],
          source_text: 'A-87', evidence_refs: ['evidence-visual-1'], confidence: 0.9,
        }],
        audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
        confidence: { character_mapping: 0.91, speaker_mapping: 0.82, text_regions: 0.73, shot_boundary: 0.96 },
        evidence_refs: ['evidence-visual-1'],
      }],
      causal_chain: [{ id: 'causal-1', cause: '男主送达订单。', effect: '旧案编号重新出现。', evidence_refs: ['evidence-visual-1'], confidence: 0.84 }],
      locked_facts: [{ id: 'fact-1', text: '男主在雨夜送达密封餐袋。', evidence_refs: ['evidence-visual-1'], confidence: 0.95 }],
      reversals: [{ id: 'reversal-1', text: '普通订单与旧案有关。', evidence_refs: ['evidence-visual-1'], confidence: 0.8 }],
      episode_hook: { text: '封条露出旧案编号。', evidence_refs: ['evidence-visual-1'], confidence: 0.9 },
      review: { status: 'needs_review' },
      blueprint_hash: 'c'.repeat(64),
    },
  }
}

function blueprintReviewRecordWithShots(count) {
  const record = blueprintReviewRecord()
  const sourceShot = record.blueprint.shots[0]
  record.blueprint.shots = Array.from({ length: count }, (_, index) => ({
    ...structuredClone(sourceShot),
    id: `shot-${index + 1}`,
    index: index + 1,
    start_ms: index * 1_000,
    end_ms: (index + 1) * 1_000,
    dialogue: index === 0 ? structuredClone(sourceShot.dialogue) : [],
    text_regions: index === 0 ? structuredClone(sourceShot.text_regions) : [],
  }))
  record.blueprint.source.duration_ms = count * 1_000
  return record
}

function speakerCorrectionRecord(count = 25) {
  const record = blueprintReviewRecordWithShots(count)
  const dialogue = record.blueprint.shots[0].dialogue[0]
  record.blueprint.characters.push({
    ...structuredClone(record.blueprint.characters[0]),
    id: 'character-dispatcher', source_name: '调度员', display_name: '调度员',
  })
  record.blueprint.shots.forEach((shot, index) => {
    shot.dialogue = [{
      ...structuredClone(dialogue), id: `dialogue-${index + 1}`,
      start_ms: shot.start_ms + 100, end_ms: shot.end_ms - 100,
      source_text: `第 ${index + 1} 条原对白。`,
      speaker_id: index === 2 ? 'character-dispatcher' : 'character-lead',
      speaker_kind: index === 2 ? 'off_screen' : 'character',
      off_screen: index === 2, review_status: 'approved',
    }]
  })
  record.blueprint.review = { status: 'approved', reviewer: 'original-reviewer' }
  return record
}

function boundaryCorrectionRecord(count = 3) {
  const record = blueprintReviewRecordWithShots(count)
  const line = record.blueprint.shots[0].dialogue[0]
  Object.assign(line, { start_ms: 500, end_ms: 1000, speaker_id: 'character-lead', speaker_kind: 'character', review_status: 'approved' })
  record.blueprint.shots.forEach((shot) => { shot.audio_contract.dialogue_mode = shot.dialogue.length ? 'spoken' : 'silent' })
  record.blueprint.scenes[0].source_ranges = [{ start_ms: 0, end_ms: count * 1000 }]
  record.blueprint.review = { status: 'approved', reviewer: 'original-reviewer' }
  record.source_dialogue = [{ dialogue_id: line.id, shot_id: 'shot-1', status: 'resolved', source_text: line.source_text,
    source_language: line.source_language, source_start_ms: 500, source_end_ms: count * 1000 - 100,
    projection_start_ms: 500, projection_end_ms: 1000, evidence_ref: 'evidence-audio-1', evidence_sha256: 'b'.repeat(64) }]
  return record
}

function deferredResponse() {
  let resolve
  const promise = new Promise((complete) => { resolve = complete })
  return { promise, resolve }
}

async function chooseSpeakerCorrectionOption(page, label, value, optionLabel) {
  const select = page.getByRole('combobox', { name: label })
  if (await select.evaluate((element) => element.tagName === 'SELECT')) {
    await select.selectOption(value)
  } else {
    await select.focus()
    await select.press('Enter')
    await page.getByRole('option', { name: optionLabel, exact: true }).click()
  }
}

async function switchBlueprintWork(page, workId, summary) {
  await page.evaluate((id) => {
    void document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(
      `/redraw/projects/41/works/${id}?step=1`,
    )
  }, workId)
  await expect(page).toHaveURL(new RegExp(`/redraw/projects/41/works/${workId}\\?step=1`))
  await expect(page.getByText(summary, { exact: true })).toBeVisible()
}

function localizationReviewRecord() {
  return {
    version_id: 812,
    work_id: workBase.id,
    version: 1,
    status: 'review',
    blueprint_hash: 'c'.repeat(64),
    localization_hash: 'b'.repeat(64),
    locale: 'en-US',
    market: 'US',
    updated_at: '2026-09-03T10:03:00.000Z',
    localization: {
      schema_version: 'episode-localization-v1',
      blueprint_hash: 'c'.repeat(64),
      locale: 'en-US',
      market: 'US',
      character_name_map: {
        'character-lead': 'Mateo',
        'offscreen-dispatcher': 'Avery',
      },
      dialogue_map: [{
        source_dialogue_id: 'dialogue-1',
        shot_id: 'shot-1',
        speaker_id: 'character-lead',
        speaker_kind: 'character',
        source_text: '尾号八七的订单到了。',
        target_text: 'Order A-87 is here.',
        start_ms: 500,
        end_ms: 1_800,
        estimated_duration_ms: 1_100,
        estimated_speech_rate: 10.77,
        emotion: '克制',
        pronunciation_hint: 'A eighty-seven',
      }],
      text_region_map: [{
        text_region_id: 'text-region-1', shot_id: 'shot-1', source_text: 'A-87', target_text: 'A-87',
      }],
      cultural_adaptations: [{ id: 'culture-1', source: '尾号', target: 'Order number', note: 'US delivery wording' }],
      glossary: [{ source_term: '餐袋', target_term: 'delivery bag', note: 'Keep consistent' }],
      locked_terms: ['A-87'],
      review: {
        status: 'review',
        updated_at: '2026-09-03T10:03:00.000Z',
        character_name_map: { 'character-lead': false, 'offscreen-dispatcher': false },
        dialogue_map: { 'dialogue-1': false },
        text_region_map: { 'text-region-1': false },
        cultural_adaptations: { 'culture-1': false },
        glossary: { '餐袋': false },
        locked_terms: { 'A-87': false },
      },
      localization_hash: 'b'.repeat(64),
    },
  }
}

const assetBatchQuote = {
  priced: true,
  total_credits: 18,
  quote_hash: 'd'.repeat(64),
  blocking: [],
  items: redrawAssets.map((asset) => ({
    asset_id: asset.id,
    kind: asset.kind,
    model: asset.kind === 'voice' ? 'verified-tts' : 'verified-image',
    credits: 6,
  })),
}

const materializedDraftAssets = redrawAssets.map((asset) => {
  const {
    asset_id,
    clean_plate_asset_id,
    voice_asset_id,
    ...draft
  } = asset
  return {
    ...draft,
    status: 'draft',
    approval_status: 'pending',
    prompt: `${asset.localized_name} faithful localized ${asset.kind} draft`,
    source_facts: {
      localized_name: asset.localized_name,
      localized_description: asset.localized_description,
    },
  }
})

const approvedRedrawAssets = [
  {
    id: 1201,
    version_id: 812,
    version_number: 3,
    kind: 'character',
    localized_name: 'Maya',
    status: 'generated',
    approval_status: 'approved',
    asset_id: 2201,
    identity_pack: { ...readyIdentityPack },
    identity_pack_status: { ...readyIdentityStatus },
    updated_at: '2026-08-06T08:20:00.000Z',
  },
  {
    id: 1202,
    version_id: 812,
    version_number: 3,
    kind: 'scene',
    localized_name: 'Brooklyn Loft',
    status: 'generated',
    approval_status: 'approved',
    clean_plate_asset_id: 2202,
    updated_at: '2026-08-06T08:20:00.000Z',
  },
  {
    id: 1203,
    version_id: 812,
    version_number: 3,
    kind: 'prop',
    localized_name: 'Brass Key',
    status: 'generated',
    approval_status: 'approved',
    asset_id: 2203,
    updated_at: '2026-08-06T08:20:00.000Z',
  },
]

const redrawShots = [
  {
    id: 1301,
    version_id: 812,
    batch_index: 1,
    shot_index: 1,
    start_ms: 0,
    end_ms: 12000,
    duration_ms: 12000,
    opening_state: 'Maya waits outside the door.',
    continuous_action: 'She turns the key and pushes the door.',
    ending_state: 'The door opens into the loft.',
    source_dialogue: ['你终于来了。'],
    localized_dialogue: [{
      speaker_id: 'source-character-maya',
      source_text: '你终于来了。',
      localized_text: 'You finally made it.',
      start_ms: 0,
      end_ms: 12000,
    }],
    prompt: '@Maya enters @Brooklyn Loft with @Brass Key',
    negative_prompt: 'blurred face',
    references: [{ asset_id: 1201, kind: 'character', version_number: 3, approval_status: 'approved', name: 'Maya' }],
    model: 'fixture-video-model-from-backend',
    duration: 12,
    resolution: '720p',
    count: 1,
    quote: { amount: 4 },
    quote_snapshot: { amount: 4 },
    generation_availability: { ok: true },
    source_video_ref: { asset_id: 910, url: 'https://fixtures.example/source.mp4', thumbnail_url: '', start_ms: 0, end_ms: 12000 },
    new_video_ref: null,
    status: 'draft',
    updated_at: '2026-08-06T08:30:00.000Z',
    generation: { task_id: null, status: null, progress: null, message: null },
    billing: { held: 0, charged: 0, released: 0, quote: { amount: 4 } },
  },
  {
    id: 1302,
    version_id: 812,
    batch_index: 1,
    shot_index: 2,
    start_ms: 12000,
    end_ms: 24000,
    duration_ms: 12000,
    opening_state: 'Maya stands at the threshold.',
    continuous_action: 'She scans the empty room.',
    ending_state: 'She notices a light upstairs.',
    source_dialogue: [],
    localized_dialogue: [],
    prompt: '@Maya scans @Brooklyn Loft',
    negative_prompt: '',
    references: [{ asset_id: 1201, kind: 'character', version_number: 3, approval_status: 'approved', name: 'Maya' }],
    model: 'fixture-video-model-from-backend',
    duration: 12,
    resolution: '720p',
    count: 1,
    quote: { amount: 6 },
    quote_snapshot: { amount: 6 },
    generation_availability: { ok: true },
    source_video_ref: { asset_id: 910, url: 'https://fixtures.example/source.mp4', start_ms: 12000, end_ms: 24000 },
    new_video_ref: null,
    status: 'failed',
    error_code: 'PROVIDER_FAILED',
    error_message: '供应商明确失败，可修改后独立重试',
    updated_at: '2026-08-06T08:31:00.000Z',
    generation: { task_id: 'task-failed-1302', status: 'failed', progress: 22, message: '供应商失败' },
    billing: { held: 0, charged: 0, released: 6, quote: { amount: 6 } },
  },
  {
    id: 1303,
    version_id: 812,
    batch_index: 2,
    shot_index: 3,
    start_ms: 24000,
    end_ms: 36000,
    duration_ms: 12000,
    opening_state: 'Maya reaches the staircase.',
    continuous_action: 'She walks up without looking back.',
    ending_state: 'She disappears above the landing.',
    source_dialogue: ['别回头。'],
    localized_dialogue: [{
      speaker_id: 'source-character-maya',
      source_text: '别回头。',
      localized_text: "Don't look back.",
      start_ms: 24000,
      end_ms: 36000,
    }],
    prompt: '@Maya climbs the staircase',
    negative_prompt: '',
    references: [{ asset_id: 1201, kind: 'character', version_number: 3, approval_status: 'approved', name: 'Maya' }],
    model: 'fixture-video-model-from-backend',
    duration: 12,
    resolution: '720p',
    count: 1,
    quote: { amount: 8 },
    quote_snapshot: { amount: 8 },
    generation_availability: { ok: true },
    source_video_ref: { asset_id: 910, url: 'https://fixtures.example/source.mp4', start_ms: 24000, end_ms: 36000 },
    new_video_ref: { video_url: 'https://fixtures.example/generated.mp4' },
    status: 'completed',
    updated_at: '2026-08-06T08:32:00.000Z',
    generation: { task_id: 'task-completed-1303', status: 'completed', progress: 100, message: '完成' },
    billing: { held: 0, charged: 8, released: 0, quote: { amount: 8 } },
  },
]

function shotBatches(shots) {
  return [1, 2].map((batchIndex) => {
    const items = shots.filter((shot) => shot.batch_index === batchIndex)
    return {
      batch_index: batchIndex,
      duration_ms: items.reduce((total, shot) => total + shot.duration_ms, 0),
      shots: items,
    }
  }).filter((batch) => batch.shots.length)
}

const stylePresets = [
  { id: 11, name: '二维清透', category: 'two_dimensional', preview_url: '' },
  { id: 12, name: '三维质感', category: 'three_dimensional', preview_url: '' },
  { id: 13, name: '真人电影', category: 'live_action', preview_url: '' },
  { id: 14, name: '二维厚涂', category: 'two_dimensional', preview_url: '' },
]

const localeOptions = [
  { locale: 'zh-CN', market: 'CN', status: 'full_output', blocking: [] },
  { locale: 'en-US', market: 'US', status: 'full_output', blocking: [] },
]
const browserErrorsByPage = new WeakMap()
const fixtureStatesByPage = new WeakMap()
const strictApiStatesByPage = new WeakMap()

function apiData(data) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  }
}

function executionReviewDocument(state) {
  const record = state.localization
  const ready = Boolean(state.executionPlanReady)
  const preview = {
    schema_version: 'redraw-execution-plan-preview-v1', status: ready ? 'ready' : 'blocked', executable: false,
    plan_hash: state.executionPlanHash || '7'.repeat(64),
    bindings: { version_id: record?.version_id || 812, blueprint_hash: record?.blueprint_hash,
      localization_hash: record?.localization_hash, localization_updated_at: record?.updated_at,
      locale: record?.locale, market: record?.market },
    capability: ready ? { model: 'fixture-planning-only', audio_mode: 'native', resolutions: ['480p'], aspect_ratios: ['9:16'] } : null,
    blocking_reasons: ready ? [] : [{code:'VIDEO_CAPABILITY_UNAVAILABLE'}],
    execution_blockers: ['PREVIEW_ONLY', 'SOURCE_MEDIA_NOT_RECHECKED', 'REFERENCE_ASSETS_NOT_VERIFIED',
      'CREDENTIAL_READINESS_NOT_CHECKED', 'DYNAMIC_EXECUTOR_NOT_CONNECTED', 'TARGET_REGION_AUDIO_NOT_VERIFIED'],
    units: ready ? [{id:'unit-1', source_start_ms:0, source_end_ms:12000, retained_duration_ms:12000,
      generated_duration_ms:15000, padding_ms:3000, parent_shots:[{id:'shot-1'},{id:'shot-2'}],
      dialogues:[{id:'dialogue-1',start_ms:2500,end_ms:4700,source_text:'等等我。',target_text:'Wait for me.'}],
      reference_requirements:[{id:'identity-lead',kind:'image',requirement_hash:'8'.repeat(64)},
        {id:'motion-shot-1',kind:'video',requirement_hash:'9'.repeat(64)}]}] : [],
  }
  const saved = state.executionReviews?.find(item=>item.plan_hash === preview.plan_hash) || state.executionReviews?.at(-1)
  return {preview,saved_review:saved ? {...saved,status:ready && saved.plan_hash===preview.plan_hash ? 'current':'stale'} : null}
}

async function installFixtures(page, state) {
  state.expectedBrowserStatuses = []
  fixtureStatesByPage.set(page, state)
  if (state.strictApi) {
    state.unexpectedApiRequests = []
    strictApiStatesByPage.set(page, state)
  }
  await page.addInitScript((role) => {
    window.localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'e2e-redraw-token',
      user: { id: 'user-redraw-e2e', email: 'redraw-e2e@example.test', role },
    }))
  }, state.userRole || 'admin')
  await page.route('https://fixtures.example/*.mp4', async (route) => {
    await route.fulfill({ path: fixtureVideoPath, contentType: 'video/mp4' })
  })
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url
    const method = request.method()
    if (await handleMotionFixture(route, state, apiData)) return
    if (state.identityUploadOnly) {
      state.identityTraffic ||= []
      state.identityTraffic.push({ method, pathname })
      if (method !== 'GET' && !(
        (method === 'POST' && pathname === '/api/v1/redraw/assets/1201/reference-artifact')
        || (method === 'PUT' && pathname === '/api/v1/redraw/assets/1201/identity-pack')
        || (method === 'POST' && pathname === '/api/v1/redraw/assets/1201/review')
        || (method === 'POST' && pathname === '/api/v1/redraw/versions/812/assets/batch-quote' && !state.identityUploadStarted)
      )) {
        state.unexpectedApiRequests.push({ method, pathname })
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false }) })
        return
      }
    }
    const boundaryPostLockQuote = state.boundaryOnly && state.boundaryQuotePostLock
      && method === 'POST' && pathname === '/api/v1/redraw/works/710/localization-quote'
      && state.blueprint?.status === 'locked' && state.successfulBlueprintLocks === 1
      && requestCount(state, 'POST', '/localization-quote') === 0
      && Object.keys(request.postDataJSON()).sort().join(',') === 'locale,localization_level,market'
      && request.postDataJSON().locale === 'zh-CN' && request.postDataJSON().market === 'CN'
      && request.postDataJSON().localization_level === 'faithful'
    if (state.boundaryOnly && method !== 'GET'
      && !(method === 'PUT' && pathname === '/api/v1/redraw/works/710/blueprint')
      && !(method === 'POST' && pathname === '/api/v1/redraw/works/710/blueprint/lock') && !boundaryPostLockQuote) {
      state.unexpectedApiRequests.push({ method, pathname })
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false }) })
      return
    }

    if (pathname === '/api/v1/redraw/versions/812/execution-plan/review' && ['GET','POST'].includes(method)) {
      if (method === 'POST') {
        const body=request.postDataJSON(); state.requests.push({method,pathname,body})
        const current=executionReviewDocument(state)
        if (!state.executionPlanReady || body.expected_plan_hash !== current.preview.plan_hash) {
          state.expectedBrowserStatuses.push('409 (Conflict)')
          await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({success:false,error:{code:'EXECUTION_PLAN_CONFLICT'}})})
          return
        }
        state.executionReviews ||= []
        if (!state.executionReviews.some(item=>item.plan_hash===current.preview.plan_hash)) {
          state.executionReviews.push({id:state.executionReviews.length+1,plan_hash:current.preview.plan_hash,
            saved_at:'2026-09-05T12:00:00.000Z',plan:structuredClone(current.preview)})
        }
      }
      await route.fulfill(apiData(executionReviewDocument(state)))
      return
    }

    if (pathname === '/api/v1/redraw/versions/812/execution-queue' && ['GET','POST'].includes(method)) {
      const current = executionReviewDocument(state)
      state.executionQueues ||= []
      if (method === 'POST') {
        const body = request.postDataJSON(); state.requests.push({method,pathname,body})
        if (current.saved_review?.status !== 'current' || body.expected_plan_hash !== current.preview.plan_hash
          || Object.keys(body).length !== 1) {
          state.expectedBrowserStatuses.push('409 (Conflict)')
          await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({success:false,error:{code:'EXECUTION_QUEUE_CONFLICT'}})})
          return
        }
        if (!state.executionQueues.some(item=>item.plan_hash===current.preview.plan_hash)) {
          state.executionQueues.push({id:state.executionQueues.length+1,version_id:812,work_id:710,
            plan_hash:current.preview.plan_hash,status:'waiting_readiness',executable:false,created_at:'2026-09-05T13:00:00.000Z',
            units:current.preview.units.map((unit,ordinal)=>({id:unit.id,ordinal,status:'pending',unit_hash:'a'.repeat(64),plan_unit:structuredClone(unit)})),
            execution_blockers:[...current.preview.execution_blockers]})
        }
      } else state.executionQueueReads = (state.executionQueueReads || 0) + 1
      const selected = state.executionQueues.find(item=>item.plan_hash===current.preview.plan_hash) || state.executionQueues.at(-1)
      const queue = selected ? {...selected,status:current.preview.status==='ready' && selected.plan_hash===current.preview.plan_hash?'waiting_readiness':'stale'} : null
      await route.fulfill(apiData({...current,queue}))
      return
    }

    if (method === 'GET' && pathname === '/api/v1/redraw/projects') {
      await route.fulfill(apiData(state.projects))
      return
    }
    if (method === 'POST' && pathname === '/api/v1/redraw/projects') {
      state.projects = [project]
      state.requests.push({ method, pathname, body: request.postDataJSON() })
      await route.fulfill(apiData(project))
      return
    }
    if (method === 'GET' && pathname === `/api/v1/redraw/projects/${project.id}`) {
      const selectedProject = state.projects?.find((item) => Number(item.id) === Number(project.id)) || project
      await route.fulfill(apiData(selectedProject))
      return
    }
    if (method === 'GET' && pathname === `/api/v1/redraw/projects/${project.id}/events`) {
      await route.fulfill(apiData([]))
      return
    }
    if (method === 'GET' && pathname === '/api/v1/redraw/style-presets') {
      await route.fulfill(apiData(stylePresets))
      return
    }
    if (method === 'GET' && pathname === '/api/v1/redraw/locales') {
      await route.fulfill(apiData(localeOptions))
      return
    }
    if (method === 'POST' && pathname === `/api/v1/redraw/projects/${project.id}/works`) {
      state.requests.push({
        method,
        pathname,
        bodyText: request.postDataBuffer().toString('utf8'),
      })
      state.work = { ...workBase, analysis_quote: state.quoteReady ? { credits: 6 } : null }
      await route.fulfill(apiData({ items: [state.work] }))
      return
    }
    const workGetMatch = /^\/api\/v1\/redraw\/works\/(\d+)$/.exec(pathname)
    if (method === 'GET' && workGetMatch) {
      const requestedWorkId = Number(workGetMatch[1])
      state.workGetsStarted = [...(state.workGetsStarted || []), requestedWorkId]
      const workDelay = Number(state.workDelays?.[requestedWorkId] || 0)
      if (workDelay > 0) await new Promise((resolve) => setTimeout(resolve, workDelay))
      state.workGets = (state.workGets || 0) + 1
      if (typeof state.onGetWork === 'function') state.onGetWork(state)
      const selectedWork = state.works?.[requestedWorkId]
        || (requestedWorkId === workBase.id ? (state.work || workBase) : null)
      if (!selectedWork) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ success: false }) })
        return
      }
      const responseWork = {
        ...selectedWork,
        ...(state.quoteReady ? { analysis_quote: { credits: 6 } } : { analysis_quote: null }),
      }
      if (requestedWorkId === workBase.id) state.work = responseWork
      if (state.works?.[requestedWorkId]) state.works[requestedWorkId] = responseWork
      await route.fulfill(apiData(responseWork))
      return
    }
    const blueprintGetMatch = /^\/api\/v1\/redraw\/works\/(\d+)\/blueprint$/.exec(pathname)
    if (method === 'GET' && blueprintGetMatch) {
      const requestedWorkId = Number(blueprintGetMatch[1])
      state.blueprintGetsStarted = [...(state.blueprintGetsStarted || []), requestedWorkId]
      if (state.blueprintGetResponse) await state.blueprintGetResponse.promise
      const blueprintDelay = Number(state.blueprintDelays?.[requestedWorkId] || state.blueprintDelay || 0)
      if (blueprintDelay > 0) await new Promise((resolve) => setTimeout(resolve, blueprintDelay))
      const responseStatus = Number(state.blueprintStatuses?.[requestedWorkId] || state.blueprintStatus || 0)
      if (responseStatus && responseStatus !== 200) {
        await route.fulfill({
          status: responseStatus,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: {
              code: responseStatus === 404 ? 'REDRAW_BLUEPRINT_NOT_FOUND' : 'REDRAW_BLUEPRINT_READ_FAILED',
              message: `读取母本蓝图失败 (${responseStatus})`,
            },
          }),
        })
        return
      }
      const selectedBlueprint = state.blueprints?.[requestedWorkId]
        || (requestedWorkId === workBase.id ? state.blueprint : null)
      if (!selectedBlueprint) {
        state.expectedBrowserStatuses.push('404 (Not Found)')
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: { code: 'REDRAW_BLUEPRINT_NOT_FOUND', message: '母本蓝图不存在' } }),
        })
        return
      }
      await route.fulfill(apiData(structuredClone(selectedBlueprint)))
      return
    }
    if (method === 'GET' && /^\/api\/v1\/redraw\/works\/\d+\/source-video$/.test(pathname)) {
      const requestedWorkId = Number(pathname.split('/')[5])
      const selectedWork = state.works?.[requestedWorkId] || state.work
      expect(request.headers().authorization).toBe('Bearer e2e-redraw-token')
      expect([...url.searchParams.keys()].sort()).toEqual(['expected_source_asset_id', 'expected_source_sha256'])
      expect(url.searchParams.get('expected_source_asset_id')).toBe(String(selectedWork.source_asset_id))
      expect(url.searchParams.get('expected_source_sha256')).toBe(selectedWork.source_fingerprint)
      state.mediaRequests ||= []
      state.mediaRequests.push({ method, pathname, query: Object.fromEntries(url.searchParams) })
      if (state.sourceVideoConflict) {
        state.expectedBrowserStatuses.push('409 (Conflict)')
        await route.fulfill({ status: 409, contentType: 'application/json',
          body: JSON.stringify({ success: false, error: { code: 'REDRAW_SOURCE_VIDEO_CONFLICT' } }) })
        return
      }
      await route.fulfill({ path: fixtureVideoPath, contentType: 'video/mp4' })
      return
    }
    if (method === 'PUT' && pathname === `/api/v1/redraw/works/${workBase.id}/blueprint`) {
      const body = request.postDataJSON()
      state.requests.push({ method, pathname, body })
      if (state.blueprintConflict) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: { code: 'REDRAW_BLUEPRINT_CAS_CONFLICT', message: '母本蓝图已变化，请刷新后重试' } }),
        })
        return
      }
      const previousShots = state.blueprint.blueprint.shots
      const changedShots = new Set()
      for (const shot of body.blueprint.shots) {
        const previous = previousShots.find((item) => item.id === shot.id)
        if (previous && (previous.start_ms !== shot.start_ms || previous.end_ms !== shot.end_ms)) changedShots.add(shot.id)
        for (const line of shot.dialogue) {
          const origin = previousShots.find((item) => item.dialogue.some((turn) => turn.id === line.id))
          if (origin && origin.id !== shot.id) { changedShots.add(origin.id); changedShots.add(shot.id) }
        }
      }
      if (changedShots.size) {
        body.blueprint.review = { status: 'needs_review' }
        for (const shot of body.blueprint.shots) if (changedShots.has(shot.id)) {
          shot.manual_boundary = true
          shot.dialogue.forEach((line) => { line.review_status = 'needs_review' })
        }
      }
      state.blueprint = {
        ...state.blueprint,
        blueprint: structuredClone(body.blueprint),
        blueprint_hash: 'e'.repeat(64),
        updated_at: '2026-09-03T10:01:00.000Z',
      }
      state.blueprint.blueprint.blueprint_hash = state.blueprint.blueprint_hash
      if (state.blueprint.source_dialogue) {
        state.blueprint.source_dialogue = state.blueprint.source_dialogue.map((source) => {
          const matches = state.blueprint.blueprint.shots.flatMap((shot) => shot.dialogue
            .filter((turn) => turn.id === source.dialogue_id).map((line) => ({ shot, line })))
          expect(matches).toHaveLength(1)
          const { shot, line } = matches[0]
          const correction = line?.source_correction
          const { source_origin, original_source_text, original_start_ms, original_end_ms, ...base } = source
          base.shot_id = shot.id
          return correction ? { ...base, ...correction, source_origin: 'manual_correction', source_text: line.source_text,
            projection_start_ms: line.start_ms, projection_end_ms: line.end_ms }
            : { ...base, source_text: original_source_text ?? source.source_text,
              source_start_ms: original_start_ms ?? source.source_start_ms, source_end_ms: original_end_ms ?? source.source_end_ms,
              projection_start_ms: line.start_ms, projection_end_ms: line.end_ms }
        })
      }
      const responseBlueprint = structuredClone(state.blueprint)
      if (state.blueprintPutResponse) await state.blueprintPutResponse.promise
      await route.fulfill(apiData(responseBlueprint))
      return
    }
    if (method === 'POST' && pathname === `/api/v1/redraw/works/${workBase.id}/blueprint/lock`) {
      const body = request.postDataJSON()
      state.requests.push({ method, pathname, body })
      if (state.blueprint.blueprint.review.status !== 'approved'
        || state.blueprint.blueprint.characters.some((item) => item.review_status !== 'approved')
        || state.blueprint.blueprint.shots.some((shot) => shot.dialogue.some((line) => line.review_status !== 'approved' || line.speaker_kind === 'voice_cluster'))) {
        await route.fulfill({ status: 400, contentType: 'application/json',
          body: JSON.stringify({ success: false, error: { code: 'REDRAW_BLUEPRINT_REVIEW_REQUIRED', message: '请重新审核' } }) })
        return
      }
      state.blueprint = {
        ...state.blueprint,
        status: 'locked',
        updated_at: '2026-09-03T10:02:00.000Z',
      }
      const responseBlueprint = structuredClone(state.blueprint)
      if (state.blueprintLockResponse) await state.blueprintLockResponse.promise
      state.successfulBlueprintLocks = (state.successfulBlueprintLocks || 0) + 1
      await route.fulfill(apiData(responseBlueprint))
      return
    }
    if (method === 'POST' && pathname === `/api/v1/redraw/works/${workBase.id}/localization-quote`) {
      const body = request.postDataJSON()
      state.requests.push({ method, pathname, body })
      await route.fulfill(apiData({ ...localizationQuote }))
      return
    }
    if (method === 'POST' && pathname === `/api/v1/redraw/works/${workBase.id}/versions`) {
      const body = request.postDataJSON()
      state.requests.push({ method, pathname, body })
      state.work = state.episodeLocalization ? {
        ...(state.work || analysisReviewWork()),
        status: 'needs_review',
        workflow_phase: 'localization_review',
        localization_review_status: 'review',
        current_step: 1,
        version_id: 812,
        current_version: 1,
        localization_quote: { ...localizationQuote },
        localization_task: {
          id: 'task-localization-812', status: 'completed', progress: 100, message: '等待人工审核',
        },
        localization_billing: { held: 0, charged: 9, released: 0, quote: { ...localizationQuote } },
      } : {
        ...(state.work || analysisReviewWork()),
        status: 'localizing',
        workflow_phase: 'localizing',
        current_step: 1,
        version_id: null,
        current_version: 0,
        localization_quote: { ...localizationQuote },
        localization_task: {
          id: 'task-localization-812',
          status: 'processing',
          progress: 33,
          message: '英文 1:1 本地化处理中',
        },
        localization_billing: { held: 9, charged: 0, released: 0, quote: { ...localizationQuote } },
      }
      await route.fulfill(apiData({
        task_id: 'task-localization-812',
        version_id: state.episodeLocalization ? 812 : null,
        status: state.episodeLocalization ? 'completed' : 'processing',
        progress: state.episodeLocalization ? 100 : 33,
        billing: state.work.localization_billing,
      }))
      return
    }
    if (method === 'GET' && pathname === '/api/v1/redraw/versions/812/localization') {
      state.requests.push({ method, pathname })
      await route.fulfill(apiData(structuredClone(state.localization)))
      return
    }
    if (method === 'PUT' && pathname === '/api/v1/redraw/versions/812/localization') {
      const body = request.postDataJSON()
      state.requests.push({ method, pathname, body })
      if (state.localizationConflict) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: { code: 'LOCALIZATION_CAS_CONFLICT', message: '本地化已变化，请刷新后重试' } }),
        })
        return
      }
      state.localization = {
        ...state.localization,
        localization: structuredClone(body.localization),
        localization_hash: 'd'.repeat(64),
        updated_at: '2026-09-03T10:04:00.000Z',
      }
      state.localization.localization.localization_hash = state.localization.localization_hash
      state.localization.localization.review.updated_at = state.localization.updated_at
      await route.fulfill(apiData(structuredClone(state.localization)))
      return
    }
    if (method === 'POST' && pathname === '/api/v1/redraw/versions/812/localization/lock') {
      const body = request.postDataJSON()
      state.requests.push({ method, pathname, body })
      state.localization = {
        ...state.localization,
        status: 'locked',
        localization_hash: 'e'.repeat(64),
        updated_at: '2026-09-03T10:05:00.000Z',
        localization: {
          ...state.localization.localization,
          localization_hash: 'e'.repeat(64),
          review: { ...state.localization.localization.review, status: 'locked', updated_at: '2026-09-03T10:05:00.000Z' },
        },
      }
      state.work = {
        ...state.work,
        status: 'asset_review',
        workflow_phase: 'asset_review',
        localization_review_status: 'locked',
        current_step: 2,
        version_id: 812,
        current_version: 1,
      }
      await route.fulfill(apiData(structuredClone(state.localization)))
      return
    }
    if (method === 'PUT' && /^\/api\/v1\/redraw\/shots\/\d+$/.test(pathname)) {
      const shotId = Number(pathname.split('/').at(-1))
      const body = request.postDataJSON()
      const shot = state.work?.shots?.find((item) => item.id === shotId)
      if (!shot) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ success: false }) })
        return
      }
      Object.assign(shot, body, {
        count: 1,
        references: body.references,
        updated_at: `2026-08-06T08:4${state.requests.length}:00.000Z`,
      })
      state.work.batches = shotBatches(state.work.shots)
      state.requests.push({ method, pathname, body })
      await route.fulfill(apiData(shot))
      return
    }
    if (method === 'POST' && /^\/api\/v1\/redraw\/shots\/\d+\/generate$/.test(pathname)) {
      const shotId = Number(pathname.split('/')[5])
      const body = request.postDataJSON()
      const shot = state.work?.shots?.find((item) => item.id === shotId)
      shot.status = 'processing'
      shot.generation = { task_id: `task-shot-${shotId}`, status: 'processing', progress: 12, message: '供应商处理中' }
      shot.billing = { held: shot.billing.quote.amount, charged: 0, released: 0, quote: shot.billing.quote }
      state.work.batches = shotBatches(state.work.shots)
      state.requests.push({ method, pathname, body })
      await route.fulfill(apiData({ shot_id: shotId, task_id: shot.generation.task_id, status: 'processing' }))
      return
    }
    if (method === 'POST' && pathname === `/api/v1/redraw/works/${workBase.id}/generate-batch`) {
      const body = request.postDataJSON()
      for (const shot of state.work?.shots || []) {
        if (!body.shot_ids.includes(shot.id)) continue
        shot.status = 'processing'
        shot.generation = { task_id: `task-batch-${shot.id}`, status: 'processing', progress: 5, message: '批量任务已提交' }
      }
      state.work.batches = shotBatches(state.work.shots)
      state.requests.push({ method, pathname, body })
      await route.fulfill(apiData({ status: 'processing', items: body.shot_ids.map((shotId) => ({ shot_id: shotId })) }))
      return
    }
    if (method === 'GET' && pathname === '/api/v1/redraw/versions/812/assets') {
      state.requests.push({ method, pathname })
      if (state.identityUploadStarted && state.identityRefreshFailure) {
        state.expectedBrowserStatuses.push('503 (Service Unavailable)')
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: '资产刷新失败' } }) })
        return
      }
      await route.fulfill(apiData(state.assets))
      return
    }
    if (method === 'GET' && pathname === '/api/v1/redraw/versions/812/character-plan') {
      state.requests.push({ method, pathname })
      await route.fulfill(apiData(null))
      return
    }
    if (method === 'POST' && pathname === '/api/v1/redraw/assets/1201/reference-artifact' && state.identityUploadOnly) {
      state.identityUploadStarted = true
      const contentType = request.headers()['content-type'] || ''
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)
      expect(contentType).toMatch(/^multipart\/form-data;/)
      expect(boundary).not.toBeNull()
      expect(request.headers()['idempotency-key']).toMatch(/^[\w-]{20,}$/)
      expect(request.headers().authorization).toBe('Bearer e2e-redraw-token')
      const parts = request.postDataBuffer().toString('latin1').split(`--${boundary[1] || boundary[2]}`)
        .filter(part => part.includes('Content-Disposition:'))
      expect(parts.map(part => /name="([^"]+)"/.exec(part)[1]).sort()).toEqual(['expected_updated_at', 'file', 'purpose'])
      const field = name => parts.find(part => part.includes(`name="${name}"`)).split('\r\n\r\n')[1].replace(/\r\n$/, '')
      expect(field('purpose')).toBe('identity')
      const character = state.assets.find(item => item.id === 1201)
      expect(field('expected_updated_at')).toBe(character.updated_at)
      expect(parts.find(part => part.includes('name="file"'))).toContain('filename="identity.png"')
      expect(Buffer.from(field('file'), 'latin1')).toEqual(actorPreviewBytes)
      state.requests.push({ method, pathname, idempotencyKey: request.headers()['idempotency-key'] })
      if (state.identityUploadResponse) await state.identityUploadResponse.promise
      if (state.identityUploadError) {
        const status = state.identityUploadError
        state.expectedBrowserStatuses.push(`${status} (${status === 409 ? 'Conflict' : status === 403 ? 'Forbidden' : 'Bad Request'})`)
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: '身份图上传未确认，请刷新核对' } }) })
        return
      }
      Object.assign(character, { asset_id: 2301, status: 'generated', approval_status: 'pending', updated_at: '2026-09-06T10:01:00.000Z',
        identity_pack: null, identity_pack_status: { has_identity_pack: false, ready: false, hash_valid: false,
          missing_views: ['front', 'profile', 'full_body'], missing_confirmations: ['live_action_human_confirmed', 'adult_status', 'identity_consistency_confirmed', 'wardrobe'] } })
      state.gate = buildAssetGate(state.assets)
      await route.fulfill(apiData({ purpose: 'identity', asset: { id: 2301, type: 'image', mime_type: 'image/png', sha256: 'a'.repeat(64),
        width: 640, height: 360, file_size: actorPreviewBytes.length }, redraw_asset: { id: character.id, asset_id: character.asset_id,
        status: character.status, approval_status: character.approval_status, approved_by: null, approved_at: null,
        error_code: null, updated_at: character.updated_at }, billing: { credits: 0, held: 0, charged: 0 } }))
      return
    }
    if (method === 'PUT' && /^\/api\/v1\/redraw\/assets\/\d+\/identity-pack$/.test(pathname)) {
      const assetId = Number(pathname.split('/')[5])
      const body = request.postDataJSON()
      const asset = state.assets.find((item) => Number(item.id) === assetId)
      if (!asset || asset.kind !== 'character') {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ success: false }) })
        return
      }
      state.requests.push({ method, pathname, body })
      asset.identity_pack = {
        ...readyIdentityPack,
        ...(state.identityUploadOnly ? { artifact: { asset_id: asset.asset_id }, wardrobe: {
          reference_asset_id: body.wardrobe_reference_asset_id, reference_sha256: 'd'.repeat(64), consistency_confirmed: body.wardrobe_consistency_confirmed,
        } } : {}),
        target_actor_label: body.target_actor_label,
        confirmed_views: body.confirmed_views,
        live_action_human_confirmed: body.live_action_human_confirmed,
        adult_status: body.adult_status,
        identity_consistency_confirmed: body.identity_consistency_confirmed,
        ready: body.confirmed_views?.length === 3
          && body.live_action_human_confirmed === true
          && body.adult_status === 'verified_18_plus'
          && body.identity_consistency_confirmed === true,
      }
      asset.identity_pack_status = {
        ready: asset.identity_pack.ready,
        missing_views: asset.identity_pack.ready ? [] : ['profile', 'full_body'],
        missing_confirmations: asset.identity_pack.ready ? [] : ['live_action_human_confirmed', 'adult_status', 'identity_consistency_confirmed'],
        hash_valid: true,
      }
      asset.approval_status = 'pending'
      asset.updated_at = '2026-08-06T08:13:00.000Z'
      await route.fulfill(apiData({
        asset,
        identity_pack: asset.identity_pack,
        identity_pack_status: asset.identity_pack_status,
        version_id: 812,
        status: 'asset_review',
        current_step: 2,
      }))
      return
    }
    if (method === 'GET' && /^\/api\/v1\/redraw\/assets\/\d+\/preview\/primary$/.test(pathname)) {
      const assetId = Number(pathname.split('/')[5])
      const asset = state.assets.find((item) => Number(item.id) === assetId)
      if (asset?.asset_id) {
        if (state.identityUploadOnly) {
          expect(request.headers().authorization).toBe('Bearer e2e-redraw-token')
          state.identityPreviews ||= []
          state.identityPreviews.push({ id: assetId, assetId: asset.asset_id })
        }
        const body = asset.kind === 'character' ? actorPreviewBytes : neutralPreviewBytes
        await route.fulfill({ status: 200, contentType: 'image/png', body })
      } else {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ success: false }) })
      }
      return
    }
    if (method === 'GET' && pathname === '/api/v1/redraw/versions/812/generation-gate') {
      state.requests.push({ method, pathname })
      await route.fulfill(apiData(state.gate))
      return
    }
    if (method === 'POST' && pathname === '/api/v1/redraw/versions/812/assets/batch-quote') {
      const body = request.postDataJSON()
      const assetIds = Array.isArray(body?.asset_ids) ? body.asset_ids.map(Number) : []
      const items = assetBatchQuote.items.filter((item) => !assetIds.length || assetIds.includes(item.asset_id))
      const quote = {
        ...assetBatchQuote,
        total_credits: items.reduce((sum, item) => sum + item.credits, 0),
        quote_hash: assetIds.length && state.nextAssetBatchQuoteHash ? state.nextAssetBatchQuoteHash : assetBatchQuote.quote_hash,
        items,
      }
      state.assetBatchQuotes = [...(state.assetBatchQuotes || []), { body, quote }]
      state.requests.push({ method, pathname, body })
      await route.fulfill(apiData(quote))
      return
    }
    if (method === 'POST' && pathname === '/api/v1/redraw/versions/812/assets/batches') {
      const body = request.postDataJSON()
      const assetIds = Array.isArray(body?.asset_ids) ? body.asset_ids.map(Number) : state.assets.map((asset) => asset.id)
      const batch = {
        id: body.asset_ids?.length ? 502 : 501,
        status: 'processing',
        total_count: assetIds.length,
        success_count: 0,
        failed_count: 0,
      }
      state.work = {
        ...(state.work || workBase),
        asset_batch: batch,
        workflow_phase: 'asset_generating',
        current_step: 2,
        version_id: 812,
      }
      state.requests.push({ method, pathname, body })
      await route.fulfill(apiData({
        batch,
        task_id: body.asset_ids?.length ? 'task-asset-batch-retry' : 'task-asset-batch-all',
        status: 'processing',
        billing: { held: assetIds.length * 6, charged: 0, released: 0, quote_hash: body.quote_hash },
      }))
      return
    }
    if (method === 'GET' && pathname.startsWith('/api/v1/redraw/assets/') && pathname.endsWith('/quote')) {
      await route.fulfill(apiData({
        asset_id: Number(pathname.split('/')[5]),
        model: 'fixture-redraw-model',
        credits: state.assetQuoteReady ? 8 : null,
        priced: state.assetQuoteReady,
      }))
      return
    }
    if (method === 'POST' && pathname.startsWith('/api/v1/redraw/assets/') && pathname.endsWith('/review')) {
      const assetId = Number(pathname.split('/')[5])
      const body = request.postDataJSON()
      const asset = state.assets.find((item) => item.id === assetId)
      if (!asset) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ success: false }) })
        return
      }
      asset.approval_status = body.action
      asset.updated_at = body.action === 'approved' ? '2026-08-06T08:11:00.000Z' : '2026-08-06T08:12:00.000Z'
      state.gate = buildAssetGate(state.assets)
      state.work = {
        ...(state.work || workBase),
        status: state.gate.ok ? 'ready_to_generate' : 'asset_review',
        current_step: state.gate.current_step,
        workflow_phase: state.gate.ok ? 'video_generation' : 'asset_review',
      }
      state.requests.push({ method, pathname, body })
      await route.fulfill(apiData({
        asset,
        gate: state.gate,
        version_id: 812,
        status: state.gate.ok ? 'ready_to_generate' : 'asset_review',
        current_step: state.gate.current_step,
        updated_at: asset.updated_at,
      }))
      return
    }
    if (method === 'POST' && pathname === '/api/v1/redraw/versions/812/dialogue/quote') {
      const body = request.postDataJSON()
      state.requests.push({ method, pathname, body })
      await route.fulfill(apiData({
        status: 'ready',
        priced: true,
        total_credits: 7,
        quote_hash: 'b'.repeat(64),
      }))
      return
    }
    if (method === 'POST' && pathname === '/api/v1/redraw/versions/812/dialogue/start') {
      const body = request.postDataJSON()
      state.requests.push({ method, pathname, body })
      state.dialogueTask = {
        id: 'task-dialogue-812',
        status: 'completed',
        progress: 100,
        message: '英文配音完成',
      }
      await route.fulfill(apiData({ task: state.dialogueTask }))
      return
    }
    if (method === 'GET' && pathname === '/api/v1/redraw/versions/812/dialogue/tasks/task-dialogue-812') {
      await route.fulfill(apiData(state.dialogueTask || { id: 'task-dialogue-812', status: 'completed' }))
      return
    }
    if (method === 'POST' && pathname === '/api/v1/redraw/versions/812/compose') {
      const body = request.postDataJSON()
      state.requests.push({ method, pathname, body })
      state.compositionPolls = 0
      state.compositionTask = {
        id: 'task-compose-812',
        status: 'processing',
        progress: 40,
        message: '合成处理中',
        export_id: 901,
      }
      await route.fulfill(apiData({ task: state.compositionTask, export_id: 901 }))
      return
    }
    if (method === 'GET' && pathname === '/api/v1/redraw/versions/812/exports') {
      state.exportGets = (state.exportGets || 0) + 1
      if (state.compositionTask?.status === 'processing') {
        state.compositionPolls = (state.compositionPolls || 0) + 1
        state.compositionTask = { ...state.compositionTask, status: 'completed', progress: 100 }
        state.exports = [
          {
            id: 901,
            status: 'completed',
            hashes: {
              mp4: '1'.repeat(64),
              srt: '2'.repeat(64),
              vtt: '3'.repeat(64),
            },
          },
        ]
      }
      await route.fulfill(apiData(state.exports || []))
      return
    }
    if (method === 'GET' && /^\/api\/v1\/redraw\/exports\/\d+$/.test(pathname)) {
      const exportId = Number(pathname.split('/').at(-1))
      await route.fulfill(apiData((state.exports || []).find((item) => item.id === exportId) || null))
      return
    }
    if (method === 'GET' && /^\/api\/v1\/redraw\/exports\/\d+\/download\/(?:mp4|srt|vtt)$/.test(pathname)) {
      state.requests.push({ method, pathname })
      const parts = pathname.split('/')
      const exportId = Number(parts.at(-3))
      const kind = parts.at(-1)
      if (exportId === 901 && kind === 'mp4') {
        await route.fulfill({ path: fixtureVideoPath, contentType: 'video/mp4' })
      } else {
        await route.fulfill({ body: 'WEBVTT\n\n00:00.000 --> 00:01.000\nYou finally made it.', contentType: 'text/vtt' })
      }
      return
    }
    if (method === 'POST' && pathname === `/api/v1/redraw/works/${workBase.id}/analyze`) {
      const contentType = request.headers()['content-type'] || ''
      const bodyText = request.postDataBuffer().toString('utf8')
      state.requests.push({ method, pathname, contentType, bodyText })
      state.work = { ...processingWork }
      await route.fulfill(apiData({ task_id: processingWork.task_id, status: 'processing' }))
      return
    }

    if (state.strictApi) {
      state.unexpectedApiRequests.push({ method, pathname })
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: { code: 'UNEXPECTED_FIXTURE_API', message: `${method} ${pathname}` } }),
      })
      return
    }
    await route.fulfill(apiData({ items: [] }))
  })
}

function buildAssetGate(assets) {
  const missing = assets
    .filter((asset) => asset.approval_status !== 'approved')
    .map((asset) => ({
      kind: asset.kind,
      asset_id: asset.id,
      shot_ids: asset.kind === 'character' ? ['shot-01'] : ['shot-02'],
      anchor: `asset-${asset.id}-${asset.kind}`,
    }))
  return { ok: missing.length === 0, missing, current_step: missing.length === 0 ? 3 : 2 }
}

async function assertNoPageHorizontalScroll(page) {
  await expect.poll(() => page.evaluate(() => ({
    html: document.documentElement.scrollWidth <= window.innerWidth + 1,
    body: document.body.scrollWidth <= window.innerWidth + 1,
  }))).toEqual({ html: true, body: true })
}

async function assertTextFits(page, text) {
  const locator = page.getByText(text, { exact: false }).first()
  await expect(locator).toBeVisible()
  await expect.poll(() => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      visible: rect.width > 0 && rect.height > 0,
      fits: element.scrollWidth <= Math.ceil(element.clientWidth) + 1,
    }
  })).toEqual({ visible: true, fits: true })
}

async function assertMotionVideoDecoded(locator) {
  await expect(locator).toBeVisible()
  await locator.evaluate(async (video) => {
    video.muted = true
    await video.play()
    video.pause()
  })
  await expect.poll(() => locator.evaluate(video => video.readyState >= 2 && video.videoWidth === 320)).toBe(true)
}

async function createProjectFromGlobalEntry(page) {
  await page.goto('/')
  await page.getByRole('link', { name: '一键转绘' }).click()
  await expect(page).toHaveURL(/\/redraw$/)
  await expect(page.getByRole('heading', { name: '一键转绘项目' })).toBeVisible()
  await page.getByRole('button', { name: '新建转绘项目' }).click()
  const dialog = page.getByRole('dialog', { name: '新建转绘项目' })
  await expect(dialog).toBeVisible()
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v1/redraw/projects'
  ))
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await responsePromise
  await expect(page).toHaveURL(/\/redraw\/projects\/41\/works\/new\?step=1/)
  await expect(page.getByText('一键转绘工作台')).toBeVisible()
}

async function uploadSource(page) {
  await page.locator('input[type="file"][accept*="video/mp4"]').setInputFiles({
    name: 'redraw-source.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('ui-fixture-only-not-real-video'),
  })
  await page.getByRole('button', { name: '上传源片', exact: true }).click()
  await expect(page).toHaveURL(/\/redraw\/projects\/41\/works\/710\?step=1/)
  await expect(page.getByText('作品 710')).toBeVisible()
}

async function selectFreeStyleWithReference(page) {
  await page.getByText('自由风格').click()
  await page.getByPlaceholder('描述目标画面风格').fill('赛博苗寨实验影像')
  await page.getByPlaceholder('不希望出现的内容').fill('模糊、错字')
  await page.locator('.free-style-panel input[type="file"]').setInputFiles({
    name: 'reference.png',
    mimeType: 'image/png',
    buffer: Buffer.from('reference-image-fixture'),
  })
}

function generationFixtureState() {
  const shots = structuredClone(redrawShots)
  return {
    projects: [project],
    quoteReady: true,
    assetQuoteReady: true,
    work: {
      ...workBase,
      current_step: 3,
      current_version: 1,
      version_id: 812,
      status: 'ready_to_generate',
      shots,
      batches: shotBatches(shots),
    },
    assets: structuredClone(approvedRedrawAssets),
    gate: { ok: true, missing: [], current_step: 3 },
    requests: [],
  }
}

function editFixtureState() {
  const shots = structuredClone(redrawShots).map((shot) => ({
    ...shot,
    status: 'completed',
    generation: { task_id: `task-completed-${shot.id}`, status: 'completed', progress: 100, message: '完成' },
    new_video_ref: { video_url: 'https://fixtures.example/generated.mp4' },
  }))
  return {
    projects: [{ ...project, default_locale: 'en-US', default_market: 'US' }],
    quoteReady: true,
    assetQuoteReady: true,
    work: {
      ...workBase,
      current_step: 4,
      current_version: 1,
      version_id: 812,
      status: 'ready_to_export',
      source_video_ref: { url: 'https://fixtures.example/source.mp4' },
      shots,
      batches: shotBatches(shots),
    },
    assets: structuredClone(approvedRedrawAssets),
    gate: { ok: true, missing: [], current_step: 4 },
    exports: [],
    requests: [],
  }
}

function analysisReviewWork() {
  return {
    ...workBase,
    status: 'analysis_review',
    workflow_phase: 'analysis_review',
    current_step: 1,
    analysis_quote: { credits: 6 },
    analysis_task: {
      id: 'task-analysis-completed-710',
      status: 'completed',
      progress: 100,
      message: '分析已完成',
    },
    localization_task: null,
    localization_billing: { held: 0, charged: 0, released: 0, quote: null },
  }
}

function forbiddenClientFields(body) {
  const text = JSON.stringify(body)
  return ['model', 'provider', 'credits', 'credit_amount', 'dialogue', 'localized_dialogue', 'characters', 'maps']
    .filter((field) => text.includes(`"${field}"`))
}

function expectOnlyKeys(body, keys) {
  expect(Object.keys(body).sort()).toEqual([...keys].sort())
}

function requestCount(state, method, suffix) {
  return state.requests.filter((entry) => entry.method === method && entry.pathname.endsWith(suffix)).length
}

function ignoreExpectedBrowserStatus(page, statusText) {
  const browserErrors = browserErrorsByPage.get(page) || []
  browserErrorsByPage.set(page, browserErrors.filter((message) => !message.includes(statusText)))
}

test.describe('一键转绘输入与分析流程', () => {
  test.beforeEach(async ({ page }) => {
    const browserErrors = []
    browserErrorsByPage.set(page, browserErrors)
    page.on('pageerror', (error) => browserErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
  })

  test.afterEach(async ({ page }) => {
    const strictState = strictApiStatesByPage.get(page)
    if (strictState) expect(strictState.unexpectedApiRequests).toEqual([])
    const browserErrors = [...(browserErrorsByPage.get(page) || [])]
    for (const expectedStatus of fixtureStatesByPage.get(page)?.expectedBrowserStatuses || []) {
      const index = browserErrors.findIndex((message) => message.includes(expectedStatus))
      if (index >= 0) browserErrors.splice(index, 1)
    }
    expect(browserErrors).toEqual([])
  })

  test('桌面端覆盖入口、上传、四类风格、报价门禁、payload 与刷新恢复', async ({ page }) => {
    const state = { projects: [], quoteReady: false, work: null, requests: [] }
    await installFixtures(page, state)
    await page.setViewportSize({ width: 1440, height: 900 })

    await createProjectFromGlobalEntry(page)
    await expect(page.locator('.el-segmented').getByText('二维动漫风')).toBeVisible()
    await expect(page.locator('.el-segmented').getByText('三维动漫风')).toBeVisible()
    await expect(page.locator('.el-segmented').getByText('真人写实风格')).toBeVisible()
    await expect(page.locator('.el-segmented').getByText('自由风格')).toBeVisible()

    await page.getByText('二维清透').click()
    await expect(page.locator('.preset-card.active').filter({ hasText: '二维清透' })).toBeVisible()
    await selectFreeStyleWithReference(page)
    await expect(page.locator('.preset-card.active')).toHaveCount(0)

    await uploadSource(page)
    const startButton = page.getByRole('button', { name: '开始分析' })
    await expect(page.getByText('积分待管理员配置')).toBeVisible()
    await expect(startButton).toBeDisabled()

    state.quoteReady = true
    await page.reload()
    await expect(page.getByText('本次预计扣除 6 积分')).toBeVisible()
    await selectFreeStyleWithReference(page)
    await expect(startButton).toBeEnabled()
    await startButton.click()

    await expect(page.getByText('分析任务 task-redraw-710')).toBeVisible()
    await expect(page.locator('.task-card')).toContainText('processing')
    await expect(page.locator('.task-card')).toContainText('68%')

    const analyze = state.requests.find((entry) => entry.pathname === '/api/v1/redraw/works/710/analyze')
    expect(analyze).toBeTruthy()
    expect(analyze.contentType).toContain('multipart/form-data')
    expect(analyze.bodyText).toContain('name="locale"')
    expect(analyze.bodyText).toContain('zh-CN')
    expect(analyze.bodyText).toContain('name="market"')
    expect(analyze.bodyText).toContain('CN')
    expect(analyze.bodyText).toContain('name="aspect_ratio"')
    expect(analyze.bodyText).toContain('16:9')
    expect(analyze.bodyText).toContain('name="free_style"')
    expect(analyze.bodyText).toContain('赛博苗寨实验影像')
    expect(analyze.bodyText).toContain('reference.png')
    expect(analyze.bodyText).not.toContain('style_preset_id')

    await page.reload()
    await expect(page.getByText('分析任务 task-redraw-710')).toBeVisible()
    await expect(page.locator('.task-card')).toContainText('68%')
    await assertNoPageHorizontalScroll(page)
    await assertTextFits(page, '本次预计扣除 6 积分')
  })

  test('移动端工作台关键文字不溢出且无横向页面滚动', async ({ page }) => {
    const state = {
      projects: [project],
      quoteReady: true,
      work: { ...processingWork },
      requests: [],
    }
    await installFixtures(page, state)
    await page.setViewportSize({ width: 390, height: 844 })

    await page.goto('/redraw/projects/41/works/710?step=1')
    await expect(page).toHaveURL(/\/redraw\/projects\/41\/works\/710\?step=1/)
    await expect(page.getByText('上传源片并锁定转绘基础设置')).toBeVisible()
    await expect(page.getByText('源片与风格')).toBeVisible()
    await expect(page.getByText('分析任务 task-redraw-710')).toBeVisible()
    await expect(page.locator('.task-card')).toContainText('68%')
    await assertNoPageHorizontalScroll(page)
    await assertTextFits(page, '上传源片并锁定转绘基础设置')
  })

  test('母本蓝图审核映射声音聚类后以 CAS 保存并锁定，再开放本地化', async ({ page }) => {
    const state = {
      strictApi: true,
      projects: [project],
      quoteReady: true,
      work: { ...analysisReviewWork(), url: '/api/v1/redraw/works/710/source-video' },
      blueprint: blueprintReviewRecord(),
      requests: [],
    }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1')

    await expect(page.getByRole('heading', { name: '母本反推审核' })).toBeVisible()
    await page.getByRole('button', { name: '加载母本', exact: true }).click()
    await expect(page.locator('.blueprint-review-panel video')).toHaveAttribute('referrerpolicy', 'no-referrer')
    await expect(page.getByText('speaker-cluster-1', { exact: true })).toBeVisible()
    await expect(page.getByText('尾号八七的订单到了。')).toBeVisible()
    await expect(page.getByText('evidence-audio-1', { exact: true }).first()).toBeVisible()
    const confidenceDetails = page.getByLabel('镜头置信度明细')
    await expect(confidenceDetails.getByText('人物映射 91%', { exact: true })).toBeVisible()
    await expect(confidenceDetails.getByText('说话人映射 82%', { exact: true })).toBeVisible()
    await expect(confidenceDetails.getByText('文字区域 73%', { exact: true })).toBeVisible()
    await expect(confidenceDetails.getByText('镜头边界 96%', { exact: true })).toBeVisible()
    await expect(page.getByText('置信度 88%', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '开始本地化' })).toBeDisabled()
    await expect(page.getByText('本地化报价 9 积分')).toHaveCount(0)
    expect(requestCount(state, 'POST', '/localization-quote')).toBe(0)
    expect(requestCount(state, 'POST', '/versions')).toBe(0)

    const clusterSelect = page.getByRole('combobox', { name: 'speaker-cluster-1 映射角色' })
    await clusterSelect.focus()
    await clusterSelect.press('Enter')
    await clusterSelect.press('ArrowDown')
    await clusterSelect.press('Enter')
    await page.getByLabel('审核人标识').fill('reviewer-e2e')
    await page.getByRole('button', { name: '确认母本事实审核' }).click()
    await page.getByRole('button', { name: '锁定母本蓝图' }).click()

    await expect(page.getByText('蓝图已锁定，只读展示')).toBeVisible()
    await expect(page.getByRole('button', { name: '开始本地化' })).toBeEnabled()
    await expect(page.getByText('本地化报价 9 积分')).toBeVisible()
    await expect.poll(() => requestCount(state, 'POST', '/localization-quote')).toBe(1)
    expect(requestCount(state, 'POST', '/versions')).toBe(0)
    const save = state.requests.find((entry) => entry.method === 'PUT' && entry.pathname.endsWith('/blueprint'))
    expectOnlyKeys(save.body, ['expected_updated_at', 'blueprint'])
    expect(save.body.expected_updated_at).toBe('2026-09-03T10:00:00.000Z')
    expect(save.body.blueprint.shots[0].dialogue[0]).toMatchObject({
      speaker_id: 'character-lead', speaker_kind: 'character', off_screen: false, review_status: 'approved',
    })
    expect(save.body.blueprint.shots[0].dialogue[0].source_text).toBe('尾号八七的订单到了。')
    expect(save.body.blueprint.shots[0].dialogue[0].evidence_refs).toEqual(['evidence-audio-1'])
    const lock = state.requests.find((entry) => entry.method === 'POST' && entry.pathname.endsWith('/blueprint/lock'))
    expectOnlyKeys(lock.body, ['expected_blueprint_hash', 'expected_updated_at'])
    expect(lock.body).toEqual({
      expected_blueprint_hash: 'e'.repeat(64),
      expected_updated_at: '2026-09-03T10:01:00.000Z',
    })
    await page.getByRole('button', { name: '开始本地化' }).click()
    await expect.poll(() => requestCount(state, 'POST', '/versions')).toBe(1)
    expect(requestCount(state, 'POST', '/localization-quote')).toBe(2)
  })

  test('R2a 选中跨分页对白明确应用已有角色，保留未选对白并复审保存刷新', async ({ page }) => {
    const original = speakerCorrectionRecord()
    for (const index of [0, 1]) Object.assign(original.blueprint.shots[index].dialogue[0], {
      speaker_id: 'speaker-cluster-1', speaker_kind: 'voice_cluster', review_status: 'needs_review',
    })
    original.blueprint.review = { status: 'needs_review' }
    const state = {
      strictApi: true, projects: [project], quoteReady: true, requests: [],
      work: analysisReviewWork(), blueprint: structuredClone(original),
    }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1')
    const card = (id) => page.locator('.dialogue-card').filter({ has: page.getByLabel(`${id} 选择对白`) })
    await expect(page.getByRole('button', { name: '应用已有角色到选中对白' })).toBeDisabled()
    await page.getByLabel('dialogue-1 选择对白').check()
    await page.getByRole('button', { name: '加载更多镜头' }).click()
    await page.getByLabel('dialogue-21 选择对白').check()
    await expect(page.getByText('已选择 2 条对白', { exact: true })).toBeVisible()
    await chooseSpeakerCorrectionOption(page, '选中对白目标角色', 'character-dispatcher', '调度员')
    await chooseSpeakerCorrectionOption(page, '选中对白画面状态', 'offscreen', '画外')
    await expect(card('dialogue-1')).toContainText('speaker-cluster-1')
    await expect(card('dialogue-21')).toContainText('character-lead')
    expect(requestCount(state, 'PUT', '/blueprint')).toBe(0)
    await page.getByRole('button', { name: '应用已有角色到选中对白' }).click()
    for (const id of ['dialogue-1', 'dialogue-21']) {
      await expect(card(id)).toContainText('character-dispatcher')
      await expect(card(id)).toContainText('needs_review')
      await expect(card(id)).toContainText('画外')
    }
    await expect(card('dialogue-2')).toContainText('speaker-cluster-1')
    await expect(card('dialogue-3')).toContainText('approved')
    await expect(page.getByRole('button', { name: '锁定母本蓝图' })).toBeDisabled()
    expect(state.blueprint).toEqual(original)
    expect(requestCount(state, 'PUT', '/blueprint')).toBe(0)
    await page.getByRole('button', { name: '清空对白选择' }).click()
    await expect(page.getByText('已选择 0 条对白', { exact: true })).toBeVisible()
    await chooseSpeakerCorrectionOption(page, 'speaker-cluster-1 映射角色', 'character-lead', '男主')
    for (const id of ['dialogue-1', 'dialogue-21']) {
      await card(id).getByRole('button', { name: '确认对白审核' }).click()
    }
    await page.getByLabel('审核人标识').fill('r2a-reviewer')
    await page.getByRole('button', { name: '确认母本事实审核' }).click()
    await page.getByRole('button', { name: '保存审核修改' }).click()
    await expect(page.getByRole('button', { name: '保存审核修改' })).toBeDisabled()
    expect(requestCount(state, 'PUT', '/blueprint')).toBe(1)
    const saved = state.requests.find((entry) => entry.method === 'PUT' && entry.pathname.endsWith('/blueprint'))
    expect(saved.body.expected_updated_at).toBe(original.updated_at)
    expect(saved.body.blueprint.review).toMatchObject({ status: 'approved', reviewer: 'r2a-reviewer' })
    for (const index of [0, 20]) expect(saved.body.blueprint.shots[index].dialogue[0]).toMatchObject({
      speaker_id: 'character-dispatcher', off_screen: true, review_status: 'approved',
    })
    for (const [index, shot] of saved.body.blueprint.shots.entries()) {
      const { speaker_id, speaker_kind, off_screen, review_status, ...facts } = shot.dialogue[0]
      const { speaker_id: oldId, speaker_kind: oldKind, off_screen: oldOffScreen, review_status: oldReview, ...originalFacts } = original.blueprint.shots[index].dialogue[0]
      expect(facts).toEqual(originalFacts)
      if (![0, 1, 20].includes(index)) expect(shot).toEqual(original.blueprint.shots[index])
    }
    await page.reload()
    await expect(page.getByText('已选择 0 条对白', { exact: true })).toBeVisible()
    await expect(card('dialogue-1')).toContainText('character-dispatcher')
    await page.getByRole('button', { name: '加载更多镜头' }).click()
    await expect(card('dialogue-21')).toContainText('character-dispatcher')
    await expect(card('dialogue-21')).toContainText('第 21 条原对白。')
    await expect(card('dialogue-21')).toContainText('evidence-audio-1')
    await expect(page.getByRole('button', { name: '锁定母本蓝图' })).toBeEnabled()
    expect(requestCount(state, 'POST', '/localization-quote')).toBe(0)
    expect(requestCount(state, 'POST', '/versions')).toBe(0)
  })

  test('R2a 已映射及画外对白可局部新建画外角色，修改必须重新审核', async ({ page }) => {
    const original = speakerCorrectionRecord(3)
    const state = {
      strictApi: true, projects: [project], quoteReady: true, requests: [],
      work: analysisReviewWork(), blueprint: structuredClone(original),
    }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1')
    const card = (id) => page.locator('.dialogue-card').filter({ has: page.getByLabel(`${id} 选择对白`) })
    await page.getByLabel('dialogue-1 选择对白').check()
    await page.getByLabel('dialogue-3 选择对白').check()
    await expect(page.getByRole('button', { name: '为选中对白创建画外角色' })).toBeDisabled()
    await page.getByLabel('选中对白新画外角色名称').fill('电台女声')
    await expect(card('dialogue-1')).toContainText('character-lead')
    await expect(card('dialogue-3')).toContainText('character-dispatcher')
    await page.getByRole('button', { name: '为选中对白创建画外角色' }).click()
    const newCharacter = page.locator('.fact-card').filter({ has: page.getByText('电台女声', { exact: true }) })
    await expect(newCharacter).toContainText('needs_review')
    await expect(page.getByLabel('蓝图锁定阻断项')).toContainText('母本事实尚未审核通过')
    for (const id of ['dialogue-1', 'dialogue-3']) {
      await expect(card(id)).toContainText('needs_review')
      await expect(card(id)).toContainText('画外')
    }
    await expect(card('dialogue-2')).toContainText('character-lead')
    await expect(card('dialogue-2')).toContainText('approved')
    expect(state.blueprint).toEqual(original)
    expect(requestCount(state, 'PUT', '/blueprint')).toBe(0)
    await page.getByRole('button', { name: '保存审核修改' }).click()
    await expect(page.getByRole('button', { name: '保存审核修改' })).toBeDisabled()
    const draft = state.blueprint.blueprint
    const created = draft.characters.find((item) => item.display_name === '电台女声')
    expect(created).toMatchObject({ review_status: 'needs_review', evidence_refs: ['evidence-audio-1'] })
    expect(draft.review.status).toBe('needs_review')
    expect(draft.shots[1]).toEqual(original.blueprint.shots[1])
    for (const index of [0, 2]) expect(draft.shots[index].dialogue[0]).toEqual({
      ...original.blueprint.shots[index].dialogue[0], speaker_id: created.id,
      speaker_kind: 'off_screen', off_screen: true, review_status: 'needs_review',
    })
    await page.reload()
    await expect(page.getByRole('button', { name: '锁定母本蓝图' })).toBeDisabled()
    await newCharacter.getByRole('button', { name: '确认角色审核' }).click()
    for (const id of ['dialogue-1', 'dialogue-3']) await card(id).getByRole('button', { name: '确认对白审核' }).click()
    await page.getByLabel('审核人标识').fill('r2a-reviewer')
    await page.getByRole('button', { name: '确认母本事实审核' }).click()
    await page.getByRole('button', { name: '保存审核修改' }).click()
    await expect(page.getByRole('button', { name: '保存审核修改' })).toBeDisabled()
    await page.reload()
    await expect(card('dialogue-3')).toContainText(created.id)
    await expect(card('dialogue-3')).toContainText('第 3 条原对白。')
    await expect(card('dialogue-3')).toContainText('evidence-audio-1')
    await expect(page.getByRole('button', { name: '锁定母本蓝图' })).toBeEnabled()
    expect(requestCount(state, 'POST', '/localization-quote')).toBe(0)
    expect(requestCount(state, 'POST', '/versions')).toBe(0)
  })

  for (const operation of ['PUT', 'lock']) {
    test(`R2a 迟到 ${operation} 响应在作品 A→B→A 后不覆盖新会话`, async ({ page }) => {
      const pending = deferredResponse()
      const original = speakerCorrectionRecord(3)
      original.blueprint.story.summary = '作品 A 旧会话。'
      const fresh = structuredClone(original)
      fresh.blueprint.story.summary = '作品 A 新会话。'
      fresh.blueprint.review.reviewer = 'fresh-reviewer'
      fresh.updated_at = '2026-09-05T10:03:00.000Z'
      const other = blueprintReviewRecord({ workId: 711, storySummary: '作品 B 母本。' })
      const state = {
        strictApi: true, projects: [project], quoteReady: true, requests: [],
        works: { 710: analysisReviewWork(), 711: { ...analysisReviewWork(), id: 711 } },
        blueprint: structuredClone(original), blueprints: { 710: structuredClone(original), 711: other },
        ...(operation === 'PUT' ? { blueprintPutResponse: pending } : { blueprintLockResponse: pending }),
      }
      await installFixtures(page, state)
      await page.goto('/redraw/projects/41/works/710?step=1')
      await expect(page.getByText('作品 A 旧会话。', { exact: true })).toBeVisible()
      const method = operation === 'PUT' ? 'PUT' : 'POST'
      const suffix = operation === 'PUT' ? '/blueprint' : '/blueprint/lock'
      if (operation === 'PUT') {
        await page.getByLabel('审核人标识').fill('old-reviewer')
        await page.getByRole('button', { name: '确认母本事实审核' }).click()
        await page.getByRole('button', { name: '保存审核修改' }).click()
      } else await page.getByRole('button', { name: '锁定母本蓝图' }).click()
      await expect.poll(() => requestCount(state, method, suffix)).toBe(1)
      try {
        await switchBlueprintWork(page, 711, '作品 B 母本。')
        state.blueprints[710] = fresh
        await switchBlueprintWork(page, 710, '作品 A 新会话。')
        await expect(page.getByLabel('审核人标识')).toHaveValue('fresh-reviewer')
        const response = page.waitForResponse((item) => item.request().method() === method && new URL(item.url()).pathname.endsWith(suffix))
        pending.resolve()
        await (await response).finished()
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await expect(page.getByText('作品 A 新会话。', { exact: true })).toBeVisible()
        await expect(page.getByText('作品 A 旧会话。', { exact: true })).toHaveCount(0)
        await expect(page.getByLabel('审核人标识')).toHaveValue('fresh-reviewer')
        await expect(page.getByText('蓝图已锁定，只读展示')).toHaveCount(0)
        await expect(page.getByRole('button', { name: '锁定母本蓝图' })).toBeEnabled()
        expect(requestCount(state, 'POST', '/localization-quote')).toBe(0)
        expect(requestCount(state, 'POST', '/versions')).toBe(0)
      } finally {
        pending.resolve()
      }
    })
  }

  test('R2c.2 普通用户原子调整切点整句归属，取消、已加载切点定位、保存刷新重审锁定', async ({ page }, testInfo) => {
    const record = boundaryCorrectionRecord(), original = structuredClone(record)
    const state = { strictApi: true, boundaryOnly: true, boundaryQuotePostLock: true, userRole: 'user', projects: [project], quoteReady: true,
      requests: [], blueprint: record, work: analysisReviewWork() }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1')
    const button = page.getByRole('button', { name: '调整与下一镜切点', exact: true }).first()
    await expect(button).toBeVisible()
    await button.click()
    const editor = page.getByRole('form', { name: '相邻镜头切点纠错' })
    await editor.getByLabel('公共切点（秒）', { exact: true }).fill('0.4')
    await expect(editor.getByRole('button', { name: '定位到切点' })).toBeDisabled()
    await editor.getByRole('button', { name: '取消切点调整' }).click()
    await expect(page.getByRole('button', { name: '保存审核修改' })).toBeDisabled()
    await page.getByRole('button', { name: '加载母本', exact: true }).click()
    const player = page.locator('.blueprint-review-panel video')
    await expect.poll(() => player.evaluate((video) => video.readyState)).toBeGreaterThanOrEqual(1)
    expect(state.mediaRequests).toHaveLength(1)
    await button.click(); await editor.getByLabel('公共切点（秒）', { exact: true }).fill('0.4')
    await expect(editor).toContainText('画面文字区域不会自动迁移')
    await editor.getByRole('button', { name: '定位到切点' }).click()
    await expect.poll(() => player.evaluate((video) => Math.abs(video.currentTime - 0.4) < 0.05 && video.paused)).toBe(true)
    expect(state.mediaRequests).toHaveLength(1)
    await editor.getByRole('button', { name: '应用切点与整句归属' }).click()
    await expect(editor).toBeVisible()
    await expect(page.getByRole('alert')).toContainText(/归属|相交|选择/)
    await editor.getByLabel('整句归属 dialogue-1', { exact: true }).selectOption('shot-2')
    await page.screenshot({ path: testInfo.outputPath('boundary-editor-ordinary-user.png'), fullPage: true })
    await editor.getByRole('button', { name: '应用切点与整句归属' }).click()
    await expect(editor).toHaveCount(0)
    expect(requestCount(state, 'PUT', '/blueprint')).toBe(0)
    await page.getByRole('button', { name: '保存审核修改' }).click()
    await expect(page.getByRole('button', { name: '保存审核修改' })).toBeDisabled()
    expect(state.blueprint.blueprint.shots.map((shot) => [shot.start_ms, shot.end_ms])).toEqual([[0, 400], [400, 2000], [2000, 3000]])
    expect(state.blueprint.blueprint.shots[0].dialogue).toEqual([])
    expect(state.blueprint.source_dialogue[0]).toMatchObject({ shot_id: 'shot-2', source_start_ms: 500, source_end_ms: 2900, projection_start_ms: 500, projection_end_ms: 2000 })
    expect(state.blueprint.blueprint.shots.map((shot) => shot.text_regions)).toEqual(original.blueprint.shots.map((shot) => shot.text_regions))
    expect(state.blueprint.blueprint.evidence_manifest).toEqual(original.blueprint.evidence_manifest)
    expect(state.blueprint.blueprint.scenes).toEqual(original.blueprint.scenes)
    await page.reload()
    await expect(page.getByRole('button', { name: '锁定母本蓝图' })).toBeDisabled()
    await page.getByRole('button', { name: '确认对白审核' }).click()
    await page.getByLabel('审核人标识', { exact: true }).fill('ordinary-boundary-reviewer')
    await page.getByRole('button', { name: '确认母本事实审核', exact: true }).click()
    expect(requestCount(state, 'POST', '/localization-quote')).toBe(0)
    await page.getByRole('button', { name: '锁定母本蓝图' }).click()
    await expect(page.getByText('已锁定', { exact: true })).toBeVisible()
    expect(requestCount(state, 'POST', '/blueprint/lock')).toBe(1)
    await expect.poll(() => requestCount(state, 'POST', '/localization-quote')).toBe(1)
    expect(requestCount(state, 'POST', '/versions')).toBe(0)
    expect(state.requests.filter((entry) => entry.method !== 'GET').every((entry) => entry.method === 'PUT' && entry.pathname.endsWith('/blueprint')
      || entry.method === 'POST' && (entry.pathname.endsWith('/blueprint/lock') || entry.pathname.endsWith('/localization-quote')))).toBe(true)
    await assertNoPageHorizontalScroll(page)
  })

  test('R2c.2 整句目标可跨分页且只改归属，保存前重复切镜不复制对白', async ({ page }) => {
    const record = boundaryCorrectionRecord(25), original = structuredClone(record.blueprint)
    const state = { strictApi: true, boundaryOnly: true, userRole: 'user', projects: [project], quoteReady: true,
      requests: [], blueprint: record, work: analysisReviewWork() }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1')
    await expect(page.locator('.shot-card')).toHaveCount(20)
    await page.getByRole('button', { name: '调整与下一镜切点', exact: true }).first().click()
    const editor = page.getByRole('form', { name: '相邻镜头切点纠错' })
    await expect(editor.getByLabel('整句归属 dialogue-1', { exact: true }).locator('option[value="shot-25"]')).toContainText('镜头 25')
    await editor.getByLabel('整句归属 dialogue-1', { exact: true }).selectOption('shot-25')
    await editor.getByRole('button', { name: '应用切点与整句归属' }).click()
    await page.getByRole('button', { name: '加载更多镜头', exact: true }).click()
    await expect(page.locator('.shot-card')).toHaveCount(25)
    const beforeLast = page.locator('.shot-card').nth(23)
    await beforeLast.getByRole('button', { name: '调整与下一镜切点', exact: true }).click()
    await editor.getByLabel('公共切点（秒）', { exact: true }).fill('23.8')
    await editor.getByLabel('整句归属 dialogue-1', { exact: true }).selectOption('shot-24')
    await editor.getByRole('button', { name: '应用切点与整句归属' }).click()
    expect(requestCount(state, 'PUT', '/blueprint')).toBe(0)
    await page.getByRole('button', { name: '保存审核修改' }).click()
    await expect(page.getByRole('button', { name: '保存审核修改' })).toBeDisabled()
    const shots = state.blueprint.blueprint.shots
    expect(shots.flatMap((shot) => shot.dialogue).map((line) => line.id)).toEqual(['dialogue-1'])
    expect(shots[23].dialogue[0]).toMatchObject({ start_ms: 23000, end_ms: 23800 })
    expect(state.blueprint.source_dialogue[0]).toMatchObject({ shot_id: 'shot-24', source_start_ms: 500, source_end_ms: 24900 })
    expect(shots.map((shot) => shot.text_regions)).toEqual(original.shots.map((shot) => shot.text_regions))
    expect(state.mediaRequests || []).toHaveLength(0)
    expect(requestCount(state, 'POST', '/blueprint/lock')).toBe(0)
    expect(requestCount(state, 'POST', '/localization-quote')).toBe(0)
  })

  test('R2b 普通用户鉴权回放跨镜整句，取消/应用文字时间修订、保存刷新并重新审核', async ({ page }) => {
    const record = blueprintReviewRecord()
    record.blueprint.source.asset_id = 910
    const originalShot = record.blueprint.shots[0]
    originalShot.start_ms = 1000
    originalShot.index = 2
    originalShot.dialogue[0].start_ms = 1000
    Object.assign(originalShot.dialogue[0], { speaker_kind: 'character', speaker_id: 'character-lead', review_status: 'approved' })
    record.blueprint.review = { status: 'approved', reviewer: 'original-reviewer' }
    record.blueprint.shots.unshift({ ...structuredClone(originalShot), id: 'shot-before', index: 1, start_ms: 0, end_ms: 1000, dialogue: [] })
    record.source_dialogue = [{
      dialogue_id: 'dialogue-1', shot_id: 'shot-1', status: 'resolved', reason: 'SOURCE_DIALOGUE_RESOLVED',
      source_start_ms: 250, source_end_ms: 1800, projection_start_ms: 1000, projection_end_ms: 1800,
      source_text: originalShot.dialogue[0].source_text, source_language: originalShot.dialogue[0].source_language,
      cross_shot: true, evidence_ref: 'evidence-audio-1', evidence_sha256: 'b'.repeat(64),
    }]
    const state = {
      strictApi: true, userRole: 'user', projects: [project], quoteReady: true, requests: [], blueprint: record,
      work: { ...analysisReviewWork(), source_fingerprint: record.blueprint.source.sha256,
        url: '/api/v1/redraw/works/710/source-video' },
    }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1')
    await expect(page.getByText(/整句源范围：/)).toContainText('跨镜对白')
    await expect(page.getByText(/镜头内显示范围：/)).toContainText('00:01')
    const player = page.locator('.blueprint-review-panel video')
    await expect(player).toHaveCount(0)
    await page.getByRole('button', { name: '加载母本', exact: true }).click()
    await expect(page.locator('.blueprint-review-panel .media-empty')).toHaveCount(0)
    await expect.poll(() => player.evaluate((video) => video.readyState)).toBeGreaterThanOrEqual(1)
    await player.evaluate((video) => {
      video.addEventListener('play', () => { video.dataset.playStartedAt = String(video.currentTime) }, { once: true })
    })
    await page.getByRole('button', { name: '播放整句原声' }).click()
    await expect.poll(() => player.getAttribute('data-play-started-at')).not.toBeNull()
    expect(Number(await player.getAttribute('data-play-started-at'))).toBeLessThan(0.6)
    await expect.poll(() => player.evaluate((video) => video.paused && video.currentTime >= 1.8)).toBe(true)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moli_mama_session')).user.role)).toBe('user')
    expect(state.mediaRequests).toHaveLength(1)
    const card = page.locator('.dialogue-card').filter({ has: page.getByLabel('dialogue-1 选择对白') })
    await card.getByRole('button', { name: '编辑对白文字与时间' }).click()
    await page.getByLabel('dialogue-1 修订文字').fill('取消的文字不进草稿')
    await page.getByRole('button', { name: '取消单句编辑' }).click()
    await expect(card).not.toContainText('取消的文字不进草稿')
    await expect(page.getByRole('button', { name: '保存审核修改' })).toBeDisabled()
    await card.getByRole('button', { name: '编辑对白文字与时间' }).click()
    await page.getByLabel('dialogue-1 修订文字').fill('尾号八七的外卖订单到了。')
    await page.getByLabel('dialogue-1 完整开始秒').fill('0.201')
    await page.getByLabel('dialogue-1 完整结束秒').fill('1.901')
    await page.getByRole('button', { name: '应用单句修订' }).click()
    await expect(card).toContainText('原始识别：尾号八七的订单到了。')
    await expect(card).toContainText('当前人工修订：尾号八七的外卖订单到了。')
    await expect(card).toContainText('00:00.201')
    await expect(card.getByRole('button', { name: '播放整句原声' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '锁定母本蓝图' })).toBeDisabled()
    expect(requestCount(state, 'PUT', '/blueprint')).toBe(0)
    await card.getByRole('button', { name: '编辑对白文字与时间' }).click()
    await page.getByLabel('dialogue-1 完整开始秒').fill('0.301')
    await page.getByRole('button', { name: '应用单句修订' }).click()
    await page.getByRole('button', { name: '保存审核修改' }).click()
    await expect(page.getByRole('button', { name: '保存审核修改' })).toBeDisabled()
    const corrected = state.blueprint.blueprint.shots[1].dialogue[0]
    expect(corrected.source_correction).toEqual({
      evidence_ref: 'evidence-audio-1', evidence_sha256: 'b'.repeat(64),
      original_source_text: '尾号八七的订单到了。', original_start_ms: 250, original_end_ms: 1800,
      source_start_ms: 301, source_end_ms: 1901,
    })
    expect(corrected.start_ms).toBe(1000)
    expect(corrected.end_ms).toBe(1901)
    expect(corrected.review_status).toBe('needs_review')
    expect(state.blueprint.blueprint.review.status).toBe('needs_review')
    await page.reload()
    await expect(card).toContainText('当前人工修订：尾号八七的外卖订单到了。')
    await expect(card).toContainText('原始识别：尾号八七的订单到了。')
    await expect(player).toHaveCount(0)
    await expect(card.getByRole('button', { name: '播放整句原声' })).toBeDisabled()
    await card.getByRole('button', { name: '确认对白审核' }).click()
    await page.getByLabel('审核人标识').fill('ordinary-user-reviewer')
    await page.getByRole('button', { name: '确认母本事实审核' }).click()
    await page.getByRole('button', { name: '保存审核修改' }).click()
    await expect(page.getByRole('button', { name: '保存审核修改' })).toBeDisabled()
    await page.reload()
    await expect(page.getByRole('button', { name: '锁定母本蓝图' })).toBeEnabled()
    await card.getByRole('button', { name: '恢复原始识别' }).click()
    await expect(card).not.toContainText('当前人工修订')
    await expect(card).toContainText('原对白 · 尾号八七的订单到了。')
    await expect(page.getByRole('button', { name: '锁定母本蓝图' })).toBeDisabled()
    expect(state.requests.filter((entry) => entry.method !== 'GET').every((entry) => entry.method === 'PUT' && entry.pathname.endsWith('/blueprint'))).toBe(true)
    expect(requestCount(state, 'POST', '/versions')).toBe(0)
    expect(requestCount(state, 'POST', '/localization-quote')).toBe(0)
    await assertNoPageHorizontalScroll(page)
  })

  test('R2c 普通用户编辑镜头场景道具和可见人物，阻止非法删除，保存刷新重新审核且零生成', async ({ page }) => {
    const record = blueprintReviewRecord()
    const shot = record.blueprint.shots[0]
    Object.assign(shot.dialogue[0], { speaker_id: 'character-lead', speaker_kind: 'character', review_status: 'approved' })
    record.blueprint.characters.push({ ...structuredClone(record.blueprint.characters[0]), id: 'character-guest', source_name: '店员', display_name: '店员' })
    record.blueprint.review = { status: 'approved', reviewer: 'original-reviewer' }
    const original = structuredClone(record.blueprint)
    const state = { strictApi: true, userRole: 'user', projects: [project], quoteReady: true, requests: [],
      blueprint: record, work: analysisReviewWork() }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1')
    const shotCard = page.locator('.shot-card').filter({ hasText: 'shot-1' })
    await expect(shotCard.getByRole('button', { name: '编辑镜头事实' })).toBeVisible()
    await shotCard.getByRole('button', { name: '编辑镜头事实' }).click()
    await page.getByLabel('shot-1 构图', { exact: true }).fill('取消的构图')
    await page.getByRole('button', { name: '取消事实编辑' }).click()
    await expect(shotCard).not.toContainText('取消的构图')
    await expect(page.getByRole('button', { name: '保存审核修改' })).toBeDisabled()
    await shotCard.getByRole('button', { name: '编辑镜头事实' }).click()
    await page.getByRole('checkbox', { name: '画面可见 · 男主', exact: true }).uncheck()
    await page.getByRole('button', { name: '应用事实修订' }).click()
    await expect(page.getByText(/画内对白/).first()).toBeVisible()
    await expect(page.getByRole('button', { name: '保存审核修改' })).toBeDisabled()
    await page.getByRole('checkbox', { name: '画面可见 · 男主', exact: true }).check()
    await page.getByRole('checkbox', { name: '画面可见 · 店员', exact: true }).check()
    for (const [label, value] of [['构图', '双人中景'], ['运镜', '固定机位'], ['起始状态', '男主站在柜台前'], ['连续动作', '店员接过餐袋'], ['结束状态', '两人看向门外']]) {
      await page.getByLabel(`shot-1 ${label}`, { exact: true }).fill(value)
    }
    await page.getByRole('button', { name: '应用事实修订' }).click()
    await expect(shotCard).toContainText('画面可见：男主、店员')
    await expect(page.getByLabel('审核人标识')).toHaveValue('')
    await expect(page.getByRole('button', { name: '锁定母本蓝图' })).toBeDisabled()
    await shotCard.getByRole('button', { name: '编辑镜头事实' }).click()
    await page.getByLabel('shot-1 构图', { exact: true }).fill('双人全景')
    await page.getByRole('button', { name: '应用事实修订' }).click()
    await page.getByRole('button', { name: '编辑场景事实' }).click()
    await page.getByLabel('scene-storefront 地点', { exact: true }).fill('便利店柜台前')
    await page.getByLabel('scene-storefront 时间', { exact: true }).fill('黎明')
    await page.getByRole('button', { name: '应用事实修订' }).click()
    await page.getByRole('button', { name: '编辑道具事实' }).click()
    await page.getByLabel('prop-order-bag 名称', { exact: true }).fill('牛皮纸餐袋')
    await page.getByRole('button', { name: '应用事实修订' }).click()
    expect(state.requests).toEqual([])
    await page.getByRole('button', { name: '保存审核修改' }).click()
    await expect(page.getByRole('button', { name: '保存审核修改' })).toBeDisabled()
    const saved = state.blueprint.blueprint
    expect(saved.source).toEqual(original.source)
    expect(saved.evidence_manifest).toEqual(original.evidence_manifest)
    expect(saved.shots[0].dialogue).toEqual(original.shots[0].dialogue.map((line) => ({ ...line, review_status: 'needs_review' })))
    expect(saved.shots[0].confidence).toEqual(original.shots[0].confidence)
    expect(saved.scenes[0].source_ranges).toEqual(original.scenes[0].source_ranges)
    expect(saved.props[0].evidence_ranges).toEqual(original.props[0].evidence_ranges)
    expect(saved.review).toEqual({ status: 'needs_review' })
    await page.reload()
    await expect(shotCard).toContainText('构图：双人全景')
    await expect(shotCard).toContainText('画面可见：男主、店员')
    await expect(page.getByText('场景 · 便利店柜台前', { exact: true })).toBeVisible()
    await expect(page.getByText('道具 · 牛皮纸餐袋', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '确认对白审核' }).click()
    await page.getByLabel('审核人标识').fill('ordinary-fact-reviewer')
    await page.getByRole('button', { name: '确认母本事实审核' }).click()
    await page.getByRole('button', { name: '保存审核修改' }).click()
    await expect(page.getByRole('button', { name: '保存审核修改' })).toBeDisabled()
    await page.reload()
    await expect(page.getByRole('button', { name: '锁定母本蓝图' })).toBeEnabled()
    expect(state.requests.every((entry) => entry.method === 'PUT' && entry.pathname.endsWith('/blueprint'))).toBe(true)
    expect(requestCount(state, 'POST', '/versions')).toBe(0)
    expect(requestCount(state, 'POST', '/localization-quote')).toBe(0)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moli_mama_session')).user.role)).toBe('user')
    await assertNoPageHorizontalScroll(page)
  })

  test('R2b 普通用户母本媒体 409 显示页内刷新入口，显式刷新后才可重新加载且零生成', async ({ page }) => {
    const state = { strictApi: true, userRole: 'user', projects: [project], quoteReady: true,
      work: analysisReviewWork(), blueprint: blueprintReviewRecord(), sourceVideoConflict: true, requests: [] }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1')
    const load = page.getByRole('button', { name: '加载母本', exact: true })
    const refresh = page.getByRole('button', { name: '刷新母本蓝图', exact: true })
    await expect(refresh).toHaveCount(0)
    await load.click()
    await expect.poll(() => state.mediaRequests?.length).toBe(1)
    await expect(refresh).toBeVisible()
    await expect(load).toBeDisabled()
    await expect(page.getByLabel('dialogue-1 选择对白')).toBeDisabled()
    await expect(page.locator('.blueprint-review-panel video')).toHaveCount(0)
    expect(state.requests).toEqual([])
    const readsBeforeRefresh = state.blueprintGetsStarted.length
    state.sourceVideoConflict = false
    await refresh.click()
    await expect.poll(() => state.blueprintGetsStarted.length).toBe(readsBeforeRefresh + 1)
    await expect(refresh).toHaveCount(0)
    await expect(load).toBeEnabled()
    await expect(page.getByLabel('dialogue-1 选择对白')).toBeEnabled()
    expect(state.mediaRequests).toHaveLength(1)
    await load.click()
    const player = page.locator('.blueprint-review-panel video')
    await expect(player).toHaveAttribute('src', /^blob:/)
    await expect.poll(() => player.evaluate((video) => video.readyState)).toBeGreaterThanOrEqual(1)
    expect(state.mediaRequests).toHaveLength(2)
    expect(state.requests).toEqual([])
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('moli_mama_session')).user.role)).toBe('user')
  })

  test('母本蓝图保存 CAS 冲突时要求刷新且不静默覆盖或继续锁定', async ({ page }) => {
    const original = blueprintReviewRecord()
    const state = {
      strictApi: true,
      projects: [project],
      quoteReady: true,
      work: { ...analysisReviewWork(), url: '/api/v1/redraw/works/710/source-video' },
      blueprint: structuredClone(original),
      blueprintConflict: true,
      requests: [],
    }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1')
    const clusterSelect = page.getByRole('combobox', { name: 'speaker-cluster-1 映射角色' })
    await clusterSelect.focus()
    await clusterSelect.press('Enter')
    await clusterSelect.press('ArrowDown')
    await clusterSelect.press('Enter')
    await page.getByLabel('审核人标识').fill('reviewer-e2e')
    await page.getByRole('button', { name: '确认母本事实审核' }).click()
    await page.getByRole('button', { name: '锁定母本蓝图' }).click()

    await expect(page.getByText('母本蓝图已变化，请刷新后重试')).toBeVisible()
    expect(state.blueprint).toEqual(original)
    expect(state.requests.some((entry) => entry.pathname.endsWith('/blueprint/lock'))).toBe(false)
    await expect(page.getByRole('button', { name: '开始本地化' })).toBeDisabled()
    expect(requestCount(state, 'POST', '/localization-quote')).toBe(0)
    expect(requestCount(state, 'POST', '/versions')).toBe(0)
    expect((browserErrorsByPage.get(page) || []).some((message) => message.includes('409 (Conflict)'))).toBe(true)
    ignoreExpectedBrowserStatus(page, '409 (Conflict)')
  })

  test('锁定母本后审核全剧姓名对白与 OCR，全部确认才可锁定并进入资产审核', async ({ page }) => {
    const blueprint = blueprintReviewRecord({ status: 'locked' })
    blueprint.blueprint.characters.push({
      id: 'offscreen-dispatcher', source_name: '调度员', display_name: '调度员',
      relationship: '画外音', relationships: [], face_track_ids: [], evidence_refs: ['evidence-audio-1'],
      confidence: 1, review_status: 'approved',
    })
    Object.assign(blueprint.blueprint.shots[0].dialogue[0], {
      speaker_id: 'character-lead', speaker_kind: 'character', review_status: 'approved',
    })
    const state = {
      strictApi: true,
      episodeLocalization: true,
      projects: [project],
      quoteReady: true,
      work: analysisReviewWork(),
      blueprint,
      localization: localizationReviewRecord(),
      assets: [],
      gate: { ok: false, missing: [], current_step: 2 },
      requests: [],
    }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1')

    await expect(page.getByRole('button', { name: '开始本地化' })).toBeEnabled()
    await page.getByRole('button', { name: '开始本地化' }).click()
    await expect(page.getByRole('heading', { name: '全剧本地化审核' })).toBeVisible()
    await expect(page.getByText('character-lead', { exact: true })).toBeVisible()
    await expect(page.getByText('男主', { exact: true })).toBeVisible()
    await expect(page.getByLabel('character-lead 目标姓名')).toHaveValue('Mateo')
    await expect(page.getByText('尾号八七的订单到了。', { exact: true })).toBeVisible()
    await expect(page.getByLabel('dialogue-1 目标对白')).toHaveValue('Order A-87 is here.')
    await expect(page.getByText('说话人 character-lead')).toBeVisible()
    await expect(page.getByText('00:00.500–00:01.800')).toBeVisible()
    await expect(page.getByText('预计语速 10.77 字符/秒')).toBeVisible()
    await expect(page.getByText('情绪 克制')).toBeVisible()
    await expect(page.getByRole('button', { name: '02 资产审核' })).toBeDisabled()
    expect(state.requests.some((entry) => entry.pathname.includes('/assets'))).toBe(false)
    expect(state.requests.some((entry) => entry.pathname.includes('/generate'))).toBe(false)

    const targetName = page.getByLabel('character-lead 目标姓名')
    await targetName.fill('Avery')
    await expect(page.getByText('目标姓名不能重复')).toBeVisible()
    await expect(page.getByRole('button', { name: '锁定本地化' })).toBeDisabled()
    await targetName.fill('男主')
    await expect(page.getByText('目标内容不能残留源角色名')).toBeVisible()
    await targetName.fill('Marcus')
    const targetDialogue = page.getByLabel('dialogue-1 目标对白')
    await targetDialogue.fill('男主 returns with the order.')
    await expect(page.getByText('目标内容不能残留源角色名')).toBeVisible()
    await targetDialogue.fill('Marcus returns with the order.')

    for (const name of [
      'character-lead 姓名已审核', 'offscreen-dispatcher 姓名已审核', 'dialogue-1 对白已审核',
      'text-region-1 OCR 已审核', 'culture-1 文化适配已审核', '餐袋 glossary 已审核', 'A-87 locked term 已审核',
    ]) {
      await page.getByRole('checkbox', { name }).check()
    }
    await expect(page.getByRole('button', { name: '锁定本地化' })).toBeDisabled()
    await page.getByRole('button', { name: '保存本地化审核' }).click()
    const save = state.requests.find((entry) => entry.method === 'PUT' && entry.pathname.endsWith('/localization'))
    expectOnlyKeys(save.body, ['expected_updated_at', 'localization'])
    expect(save.body.expected_updated_at).toBe('2026-09-03T10:03:00.000Z')
    expect(save.body.localization.character_name_map['character-lead']).toBe('Marcus')
    expect(save.body.localization.dialogue_map[0].target_text).toBe('Marcus returns with the order.')

    await expect(page.getByRole('button', { name: '锁定本地化' })).toBeEnabled()
    await page.getByRole('button', { name: '锁定本地化' }).click()
    const lock = state.requests.find((entry) => entry.method === 'POST' && entry.pathname.endsWith('/localization/lock'))
    expectOnlyKeys(lock.body, ['blueprint_hash', 'expected_localization_hash', 'expected_updated_at'])
    expect(lock.body).toEqual({
      blueprint_hash: 'c'.repeat(64),
      expected_localization_hash: 'd'.repeat(64),
      expected_updated_at: '2026-09-03T10:04:00.000Z',
    })
    expect(state.localization.localization_hash).toBe('e'.repeat(64))
    expect(state.localization.localization.localization_hash).toBe('e'.repeat(64))
    expect(state.work.localization_review_status).toBe('locked')
    await expect(page).toHaveURL(/step=2/)
    await expect(page.getByText('确认本地化资产后再进入批量转绘')).toBeVisible()
  })

  test('计划审核只保存快照，刷新恢复；草稿修改及上游漂移必须重新确认', async ({ page }, testInfo) => {
    const state = { strictApi:true,projects:[project],quoteReady:true,blueprint:blueprintReviewRecord({status:'locked'}),
      work:{...analysisReviewWork(),status:'needs_review',workflow_phase:'localization_review',
        localization_review_status:'review',version_id:812,current_version:1,
        localization_task:{id:'localization-812',status:'completed',progress:100}},
      localization:localizationReviewRecord(),executionPlanReady:true,requests:[] }
    await installFixtures(page,state)
    await page.goto('/redraw/projects/41/works/710?step=1')
    const panel=page.getByRole('region',{name:'动态执行计划审核'})
    const save=panel.getByRole('button',{name:'保存计划审核'})
    const check=panel.getByRole('checkbox',{name:'我已检查完整对白、时间范围和参考需求'})
    await expect(panel.getByText('目标对白：Wait for me.')).toBeVisible()
    await expect(panel.getByText('整句源范围 0:02.500—0:04.700')).toBeVisible()
    await expect(panel.getByText('保留 12 秒 · 生成 15 秒 · 尾部余量 3 秒')).toBeVisible()
    await expect(save).toBeDisabled()
    await check.check(); await save.click()
    await expect(panel.getByText('计划审核已保存；仍不可执行')).toBeVisible()
    expect(state.requests).toEqual([{method:'GET',pathname:'/api/v1/redraw/versions/812/localization'},
      {method:'POST',pathname:'/api/v1/redraw/versions/812/execution-plan/review',body:{expected_plan_hash:'7'.repeat(64)}}])
    await page.reload()
    await expect(panel.getByText('计划审核已保存；仍不可执行')).toBeVisible()
    await expect(save).toBeDisabled()
    const input=page.getByLabel('character-lead 目标姓名')
    await input.fill('Marcus')
    await expect(panel.getByText('本地化有未保存修改或正在保存，请完成后重新检查计划。')).toBeVisible()
    await expect(save).toHaveCount(0)
    await input.fill('Mateo')
    await expect(panel.getByText('计划审核已保存；仍不可执行')).toBeVisible()
    state.executionPlanHash='6'.repeat(64)
    await panel.getByRole('button',{name:'刷新计划'}).click()
    await expect(panel.getByText('旧审核已过期，请检查当前计划')).toBeVisible()
    await check.check()
    state.executionPlanHash='5'.repeat(64)
    await save.click()
    await expect(panel.getByRole('alert')).toContainText('未自动重试保存')
    expect(state.requests.filter(item=>item.method!=='GET')).toHaveLength(2)
    await panel.getByRole('button',{name:'刷新计划'}).click()
    await expect(check).not.toBeChecked(); await expect(save).toBeDisabled()
    await check.check(); await save.click()
    await expect(panel.getByText('计划审核已保存；仍不可执行')).toBeVisible()
    expect(state.executionReviews).toHaveLength(2)
    expect(state.work.current_step).toBe(1)
    expect(state.requests.every(item=>(item.method==='GET' && item.pathname==='/api/v1/redraw/versions/812/localization')
      || (item.method==='POST' && item.pathname==='/api/v1/redraw/versions/812/execution-plan/review'))).toBe(true)
    await panel.locator('summary').first().click()
    await expect(panel.getByText('目标地区声音尚未验收')).toBeVisible()
    await panel.screenshot({path:testInfo.outputPath('execution-plan-desktop.png')})
    await page.setViewportSize({width:390,height:844})
    await expect(save).toBeVisible()
    expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
    const confirmationBounds = await panel.locator('footer label').evaluate(el => {
      const bounds = el.getBoundingClientRect()
      const range = document.createRange(); range.selectNodeContents(el)
      return { left: bounds.left, right: bounds.right,
        fragments: [...range.getClientRects()].map(rect => ({left:rect.left,right:rect.right})) }
    })
    expect(confirmationBounds.fragments.every(rect=>rect.left>=confirmationBounds.left-1 && rect.right<=confirmationBounds.right+1)).toBe(true)
    await panel.screenshot({path:testInfo.outputPath('execution-plan-mobile.png')})
  })

  test('计划队列显式登记一次、刷新恢复、修改失效且零生成', async ({page})=>{
    const state={strictApi:true,projects:[project],quoteReady:true,blueprint:blueprintReviewRecord({status:'locked'}),
      work:{...analysisReviewWork(),status:'needs_review',workflow_phase:'localization_review',localization_review_status:'review',version_id:812,
        localization_task:{id:'localization-812',status:'completed',progress:100}},
      localization:localizationReviewRecord(),executionPlanReady:true,requests:[]}
    await installFixtures(page,state);await page.goto('/redraw/projects/41/works/710?step=1')
    const panel=page.getByRole('region',{name:'动态执行计划审核'})
    const register=panel.getByRole('button',{name:'登记执行队列（不生成）'})
    await expect(register).toBeDisabled()
    await panel.getByRole('checkbox',{name:'我已检查完整对白、时间范围和参考需求'}).check()
    await panel.getByRole('button',{name:'保存计划审核'}).click()
    await expect(register).toBeEnabled()
    expect(state.executionQueues).toHaveLength(0)
    await register.click()
    await expect(panel.getByText('等待素材与执行条件就绪；尚未生成')).toBeVisible()
    await expect(register).toBeDisabled()
    expect(state.executionQueues).toHaveLength(1)
    const registered=structuredClone(state.executionQueues[0])
    await page.reload()
    await expect(panel.getByText('等待素材与执行条件就绪；尚未生成')).toBeVisible()
    await expect(register).toBeDisabled()
    expect(state.executionQueues[0]).toEqual(registered)
    expect(state.executionQueueReads).toBeGreaterThanOrEqual(2)
    await page.getByLabel('character-lead 目标姓名').fill('Marcus')
    await expect(register).toHaveCount(0)
    await page.getByLabel('character-lead 目标姓名').fill('Mateo')
    state.executionPlanHash='6'.repeat(64)
    await panel.getByRole('button',{name:'刷新计划'}).click()
    await expect(panel.getByText('历史队列已过期，不能执行；当前计划需重新登记')).toBeVisible()
    await expect(register).toBeDisabled()
    const readsBeforeBlocked=state.executionQueueReads
    state.executionPlanReady=false;state.executionPlanHash='7'.repeat(64)
    await panel.getByRole('button',{name:'刷新计划'}).click()
    await expect(panel.getByText('缺少已验证的视频规划能力')).toBeVisible()
    await expect(panel.getByText('历史队列已过期，不能执行；当前计划需重新登记')).toBeVisible()
    await expect(panel.locator('.execution-queue').getByText('父镜头 shot-1、shot-2',{exact:false})).toBeVisible()
    await expect(register).toBeDisabled()
    expect(state.executionQueueReads).toBeGreaterThan(readsBeforeBlocked)
    expect(state.requests.filter(item=>item.method==='POST' && item.pathname.endsWith('/execution-queue')))
      .toEqual([{method:'POST',pathname:'/api/v1/redraw/versions/812/execution-queue',body:{expected_plan_hash:'7'.repeat(64)}}])
    expect(state.requests.every(item=>item.method==='GET' || (item.method==='POST' &&
      ['/api/v1/redraw/versions/812/execution-plan/review','/api/v1/redraw/versions/812/execution-queue'].includes(item.pathname)))).toBe(true)
    await page.setViewportSize({width:390,height:844});await assertNoPageHorizontalScroll(page)
  })

  test('规划能力缺失只显示阻断，不开放保存或生成', async ({page})=>{
    const state={strictApi:true,projects:[project],quoteReady:true,blueprint:blueprintReviewRecord({status:'locked'}),
      work:{...analysisReviewWork(),status:'needs_review',workflow_phase:'localization_review',localization_review_status:'review',version_id:812,
        localization_task:{id:'localization-812',status:'completed',progress:100}},
      localization:localizationReviewRecord(),requests:[]}
    await installFixtures(page,state); await page.goto('/redraw/projects/41/works/710?step=1')
    const panel=page.getByRole('region',{name:'动态执行计划审核'})
    await expect(panel.getByText('缺少已验证的视频规划能力')).toBeVisible()
    await expect(panel.getByRole('button',{name:'保存计划审核'})).toHaveCount(0)
    expect(state.requests).toEqual([{method:'GET',pathname:'/api/v1/redraw/versions/812/localization'}])
  })

  test('本地化保存 CAS 409 要求刷新且不覆盖当前编辑', async ({ page }) => {
    const blueprint = blueprintReviewRecord({ status: 'locked' })
    blueprint.blueprint.characters.push({ id: 'offscreen-dispatcher', source_name: '调度员', display_name: '调度员' })
    const state = {
      strictApi: true,
      episodeLocalization: true,
      projects: [project],
      quoteReady: true,
      work: {
        ...analysisReviewWork(), status: 'needs_review', workflow_phase: 'localization_review',
        localization_review_status: 'review', version_id: 812, current_version: 1,
        localization_task: { id: 'task-localization-812', status: 'completed', progress: 100, message: '等待人工审核' },
      },
      blueprint,
      localization: localizationReviewRecord(),
      localizationConflict: true,
      requests: [],
    }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1')
    await expect(page.getByRole('heading', { name: '全剧本地化审核' })).toBeVisible()
    await page.getByLabel('character-lead 目标姓名').fill('Marcus')
    await page.getByRole('button', { name: '保存本地化审核' }).click()

    await expect(page.getByText('本地化已变化，请刷新后重试').first()).toBeVisible()
    await expect(page.getByLabel('character-lead 目标姓名')).toHaveValue('Marcus')
    expect(state.localization.localization.character_name_map['character-lead']).toBe('Mateo')
    expect(state.requests.filter((entry) => entry.method === 'PUT' && entry.pathname.endsWith('/localization'))).toHaveLength(1)
    expect(state.requests.some((entry) => entry.pathname.endsWith('/localization/lock'))).toBe(false)
    ignoreExpectedBrowserStatus(page, '409 (Conflict)')
  })

  test('母本蓝图读取完成前保持本地化门禁且不提前报价', async ({ page }) => {
    const pendingBlueprint = deferredResponse()
    const state = {
      strictApi: true,
      projects: [project],
      quoteReady: true,
      work: analysisReviewWork(),
      blueprint: blueprintReviewRecord({ status: 'locked' }),
      blueprintGetResponse: pendingBlueprint,
      requests: [],
    }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1')
    await expect.poll(() => state.blueprintGetsStarted?.length || 0).toBe(1)

    try {
      await expect(page.getByRole('button', { name: '开始本地化' })).toBeDisabled()
      expect(requestCount(state, 'POST', '/localization-quote')).toBe(0)
      expect(requestCount(state, 'POST', '/versions')).toBe(0)
    } finally {
      pendingBlueprint.resolve()
    }
    await expect(page.getByRole('button', { name: '开始本地化' })).toBeEnabled()
    await expect.poll(() => requestCount(state, 'POST', '/localization-quote')).toBe(1)
    expect(requestCount(state, 'POST', '/versions')).toBe(0)
  })

  for (const status of [401, 500]) {
    test(`母本蓝图 GET ${status} 时失败关闭且不报价或创建本地化版本`, async ({ page }) => {
      const state = {
        strictApi: true,
        projects: [project],
        quoteReady: true,
        work: analysisReviewWork(),
        blueprintStatus: status,
        requests: [],
      }
      await installFixtures(page, state)
      await page.goto('/redraw/projects/41/works/710?step=1')

      await expect(page.getByText(`读取母本蓝图失败 (${status})`).first()).toBeVisible()
      await expect(page.getByRole('button', { name: '开始本地化' })).toBeDisabled()
      expect(requestCount(state, 'POST', '/localization-quote')).toBe(0)
      expect(requestCount(state, 'POST', '/versions')).toBe(0)
      ignoreExpectedBrowserStatus(page, `${status} (`)
    })
  }

  test('母本蓝图明确 404 时保留旧作品本地化流程', async ({ page }) => {
    const state = {
      strictApi: true,
      projects: [project],
      quoteReady: true,
      work: analysisReviewWork(),
      requests: [],
    }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1')

    await expect(page.getByText('服务端分析摘要')).toBeVisible()
    await expect(page.getByRole('button', { name: '确认本地化' })).toBeEnabled()
    await expect.poll(() => requestCount(state, 'POST', '/localization-quote')).toBe(1)
    expect(requestCount(state, 'POST', '/versions')).toBe(0)
    ignoreExpectedBrowserStatus(page, '404 (Not Found)')

    await page.getByRole('button', { name: '确认本地化' }).click()
    await expect.poll(() => requestCount(state, 'POST', '/versions')).toBe(1)
    expect(requestCount(state, 'POST', '/localization-quote')).toBe(2)
  })

  test('母本源片播放器忽略外部 hostile URL，只鉴权 GET 固定端点取得 Blob', async ({ page }) => {
    const state = {
      strictApi: true,
      projects: [project],
      quoteReady: true,
      work: { ...analysisReviewWork(), url: 'https://attacker.example/source.mp4' },
      blueprint: blueprintReviewRecord(),
      requests: [],
      externalRequests: [],
    }
    page.on('request', (request) => {
      if (new URL(request.url()).hostname === 'attacker.example') state.externalRequests.push(request.url())
    })
    await page.route('https://attacker.example/**', (route) => route.fulfill({ path: fixtureVideoPath, contentType: 'video/mp4' }))
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1')

    await expect(page.getByRole('heading', { name: '母本反推审核' })).toBeVisible()
    await expect(page.locator('.blueprint-review-panel video')).toHaveCount(0)
    await page.getByRole('button', { name: '加载母本', exact: true }).click()
    await expect(page.locator('.blueprint-review-panel video')).toHaveAttribute('src', /^blob:/)
    expect(state.mediaRequests).toHaveLength(1)
    expect(state.mediaRequests[0].pathname).toBe('/api/v1/redraw/works/710/source-video')
    expect(state.externalRequests).toEqual([])
  })

  test('长母本蓝图镜头首屏 20 条并按需加载剩余镜头', async ({ page }) => {
    const state = {
      strictApi: true,
      projects: [project],
      quoteReady: true,
      work: analysisReviewWork(),
      blueprint: blueprintReviewRecordWithShots(25),
      requests: [],
    }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1')

    const shotCards = page.locator('.blueprint-review-panel .shot-card')
    await expect(shotCards).toHaveCount(20)
    await expect(page.getByText('已显示 20 / 25 个镜头')).toBeVisible()
    await page.getByRole('button', { name: '加载更多镜头' }).click()
    await expect(shotCards).toHaveCount(25)
    await expect(page.getByText('已显示 25 / 25 个镜头')).toBeVisible()
  })

  test('切换作品时忽略迟到的旧工作区与母本响应', async ({ page }) => {
    const work711 = { ...analysisReviewWork(), id: 711 }
    const blueprint710 = blueprintReviewRecord({ status: 'locked', storySummary: '旧作品 710 的母本摘要。' })
    const blueprint711 = blueprintReviewRecord({ workId: 711, storySummary: '新作品 711 的母本摘要。' })
    const state = {
      strictApi: true,
      projects: [project],
      quoteReady: true,
      works: { 710: analysisReviewWork(), 711: work711 },
      blueprints: { 710: blueprint710, 711: blueprint711 },
      workDelays: { 710: 1_500 },
      requests: [],
    }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1', { waitUntil: 'domcontentloaded' })
    await expect.poll(() => state.workGetsStarted?.includes(710) || false).toBe(true)

    await page.evaluate(() => {
      void document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(
        '/redraw/projects/41/works/711?step=1',
      )
    })
    await expect(page).toHaveURL(/\/redraw\/projects\/41\/works\/711\?step=1/)
    await expect(page.getByText('新作品 711 的母本摘要。')).toBeVisible()
    await expect.poll(() => state.workGets || 0).toBe(2)
    await expect(page.getByText('新作品 711 的母本摘要。')).toBeVisible()
    await expect(page.getByText('旧作品 710 的母本摘要。')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '开始本地化' })).toBeDisabled()
    expect(requestCount(state, 'POST', '/localization-quote')).toBe(0)
    expect(requestCount(state, 'POST', '/versions')).toBe(0)
  })

  test('本地化确认后资产批次部分失败只重试失败项并开放第三步', async ({ page }) => {
    const state = {
      projects: [project],
      quoteReady: true,
      assetQuoteReady: true,
      work: analysisReviewWork(),
      assets: structuredClone(materializedDraftAssets),
      gate: buildAssetGate(materializedDraftAssets),
      requests: [],
    }
    expect(state.assets.every((asset) => asset.status === 'draft')).toBe(true)
    expect(state.assets.every((asset) => !asset.asset_id && !asset.clean_plate_asset_id && !asset.voice_asset_id)).toBe(true)
    await installFixtures(page, state)
    await page.setViewportSize({ width: 1440, height: 900 })

    await page.goto('/redraw/projects/41/works/710?step=1')
    await expect(page.getByText('服务端分析摘要')).toBeVisible()
    await expect(page.getByRole('button', { name: '02 资产审核' })).toBeDisabled()
    await expect(page.getByText('本地化报价 9 积分')).toBeVisible()

    await page.getByRole('button', { name: '确认本地化' }).click()
    await expect.poll(() => state.requests.some((entry) => entry.pathname === '/api/v1/redraw/works/710/versions')).toBe(true)
    const versionCreate = state.requests.find((entry) => entry.pathname === '/api/v1/redraw/works/710/versions')
    expectOnlyKeys(versionCreate.body, ['locale', 'market', 'localization_level', 'quote_hash', 'idempotency_key'])
    expect(versionCreate.body.quote_hash).toBe(localizationQuote.quote_hash)
    expect(forbiddenClientFields(versionCreate.body)).toEqual([])
    expect(state.work.version_id).toBeNull()
    expect(state.work.current_version).toBe(0)
    expect(state.work.current_step).toBe(1)
    expect(state.requests.some((entry) => entry.pathname === '/api/v1/redraw/versions/812/assets')).toBe(false)
    expect(state.requests.some((entry) => entry.pathname === '/api/v1/redraw/versions/812/generation-gate')).toBe(false)
    await expect(page.getByText('本地化任务 task-localization-812')).toBeVisible()
    await expect(page.locator('.task-card')).toContainText('processing')
    await expect(page.locator('.task-card')).toContainText('33%')

    await page.reload()
    await expect(page.getByText('本地化任务 task-localization-812')).toBeVisible()

    state.work = {
      ...state.work,
      status: 'asset_review',
      workflow_phase: 'asset_review',
      current_step: 2,
      version_id: 812,
      current_version: 2,
      localization_task: {
        id: 'task-localization-812',
        status: 'completed',
        progress: 100,
        message: '完成',
      },
      localization_billing: { held: 0, charged: 9, released: 0, quote: localizationQuote },
      asset_batch: null,
    }
    await expect(page.getByText('确认本地化资产后再进入批量转绘')).toBeVisible()
    await expect(page.getByText('本次预计扣除 18 积分')).toBeVisible()
    const fullQuote = state.assetBatchQuotes.find((entry) => !Array.isArray(entry.body?.asset_ids))
    expect(fullQuote.quote.items.map((item) => item.asset_id).sort()).toEqual([1201, 1202, 1203])
    expect(state.assets.every((asset) => asset.status === 'draft')).toBe(true)
    expect(state.assets.every((asset) => !asset.asset_id && !asset.clean_plate_asset_id && !asset.voice_asset_id)).toBe(true)

    await page.getByRole('button', { name: '一键批量生成全部资产' }).click()
    await expect.poll(() => state.requests.filter((entry) => entry.pathname === '/api/v1/redraw/versions/812/assets/batches').length).toBe(1)
    const firstBatch = state.requests.find((entry) => entry.pathname === '/api/v1/redraw/versions/812/assets/batches')
    expectOnlyKeys(firstBatch.body, ['quote_hash', 'idempotency_key'])
    expect(firstBatch.body.quote_hash).toBe(assetBatchQuote.quote_hash)
    expect(forbiddenClientFields(firstBatch.body)).toEqual([])

    const beforePartialWorkGets = state.workGets || 0
    state.work.asset_batch = { id: 501, status: 'partial_failed', total_count: 3, success_count: 2, failed_count: 1 }
    state.assets = state.assets.map((asset) => asset.id === 1202
      ? { ...asset, status: 'failed', approval_status: 'pending', error_message: '净景失败' }
      : { ...asset, status: 'generated', approval_status: 'pending', asset_id: asset.id === 1201 ? 2201 : 2203 })
    await expect.poll(() => state.workGets || 0, { timeout: 8000 }).toBeGreaterThan(beforePartialWorkGets)
    await expect(page.getByText('2 成功 / 1 失败 / 3 总数')).toBeVisible()
    await expect(page.getByRole('button', { name: '一键重试失败项' })).toBeVisible()

    state.nextAssetBatchQuoteHash = 'c'.repeat(64)
    await page.getByRole('button', { name: '一键重试失败项' }).click()
    const retryQuote = state.assetBatchQuotes.at(-1)
    expect(retryQuote.body.asset_ids).toEqual([1202])
    expect(retryQuote.quote.items.map((item) => item.asset_id)).toEqual([1202])
    await expect(page.getByRole('button', { name: '一键重试失败项' })).toBeEnabled()
    await page.getByRole('button', { name: '一键重试失败项' }).click()
    await expect.poll(() => state.requests.filter((entry) => entry.pathname === '/api/v1/redraw/versions/812/assets/batches').length).toBe(2)
    const retryBatch = state.requests.filter((entry) => entry.pathname === '/api/v1/redraw/versions/812/assets/batches').at(-1)
    expectOnlyKeys(retryBatch.body, ['quote_hash', 'idempotency_key', 'asset_ids'])
    expect(retryBatch.body.asset_ids).toEqual([1202])
    expect(retryBatch.body.asset_ids).not.toContain(1201)
    expect(retryBatch.body.asset_ids).not.toContain(1203)
    expect(retryBatch.body.quote_hash).toBe('c'.repeat(64))
    expect(forbiddenClientFields(retryBatch.body)).toEqual([])

    const beforeRetryWorkGets = state.workGets || 0
    state.work.asset_batch = { id: 502, status: 'completed', total_count: 1, success_count: 1, failed_count: 0 }
    state.assets = state.assets.map((asset) => asset.id === 1202
      ? { ...asset, status: 'generated', approval_status: 'pending', clean_plate_asset_id: 2202 }
      : { ...asset, status: 'generated', approval_status: 'pending' })
    await expect.poll(() => state.workGets || 0, { timeout: 8000 }).toBeGreaterThan(beforeRetryWorkGets)
    for (const kind of ['角色', '场景', '物品']) {
      await page.getByRole('button', { name: kind }).click()
      await page.getByRole('button', { name: '批准' }).click()
    }
    await expect(page.getByRole('button', { name: '03 批量转绘' })).toBeEnabled()
    await expect(page.getByRole('heading', { name: '按分镜生成并从后端恢复真实进度' })).toBeVisible()
    await assertNoPageHorizontalScroll(page)
  })

  test('第二步资产审核批准后开放门禁，退回后重新关闭', async ({ page }) => {
    const state = {
      projects: [project],
      quoteReady: true,
      assetQuoteReady: true,
      work: { ...workBase, current_step: 2, status: 'asset_review', version_id: 812 },
      assets: redrawAssets.map((asset) => ({ ...asset })),
      gate: buildAssetGate(redrawAssets),
      requests: [],
    }
    await installFixtures(page, state)
    await page.setViewportSize({ width: 1440, height: 900 })

    await page.goto('/redraw/projects/41/works/710?step=2')
    await expect(page.getByText('确认本地化资产后再进入批量转绘')).toBeVisible()
    await expect(page.getByText('还有资产需要确认')).toBeVisible()
    await expect(page.getByText('3 项待处理')).toBeVisible()
    await expect.poll(async () => page.locator('[aria-label="角色身份包预览"] img').evaluate((image) => image.naturalWidth)).toBeGreaterThan(0)

    await page.getByRole('button', { name: '批准' }).first().click()
    await expect(page.getByText('2 项待处理')).toBeVisible()
    await page.getByRole('button', { name: '场景' }).click()
    await page.getByRole('button', { name: '批准' }).click()
    await expect(page.getByText('1 项待处理')).toBeVisible()
    await page.getByRole('button', { name: '物品' }).click()
    await page.getByRole('button', { name: '批准' }).click()
    await expect(page.getByRole('button', { name: '03 批量转绘' })).toBeEnabled()
    await expect(page.getByRole('heading', { name: '按分镜生成并从后端恢复真实进度' })).toBeVisible()

    await page.getByRole('button', { name: '02 资产审核' }).click()
    await page.getByRole('button', { name: '角色' }).click()
    await page.getByRole('button', { name: '退回' }).click()
    await expect(page.getByText('还有资产需要确认')).toBeVisible()
    await expect(page.getByText('1 项待处理')).toBeVisible()
    await expect(page.getByText('已开放')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '03 批量转绘' })).toBeDisabled()
    expect(state.requests.filter((entry) => entry.pathname.endsWith('/review'))).toHaveLength(4)
  })

  test('第二步门禁安全渲染资产镜头与 V2 全局缺项', async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error))
    const state = {
      projects: [project],
      quoteReady: true,
      assetQuoteReady: true,
      work: { ...workBase, current_step: 2, status: 'asset_review', version_id: 812 },
      assets: redrawAssets.map((asset) => ({ ...asset })),
      gate: {
        ok: false,
        current_step: 2,
        missing: [
          { kind: 'character', asset_id: 1201, shot_ids: ['shot-01'], anchor: 'asset-1201-character' },
          { kind: 'scene', asset_id: 1202, shot_id: 'shot-02', anchor: 'asset-1202-scene' },
          {
            kind: 'prop',
            asset_id: 1203,
            shot_id: 1302,
            shot_ids: [1302, 'shot-03', 1302, { secret: 'RAW_SECRET_VALUE' }],
            anchor: 'asset-1203-prop',
          },
          {
            resource_type: 'character_plan',
            resource_id: '812',
            reason_code: 'character_plan_not_ready',
            anchor: 'version-812-character-plan',
          },
          {
            resource_type: { secret: 'RAW_SECRET_VALUE' },
            resource_id: { secret: 'RAW_SECRET_VALUE' },
            reason_code: { secret: 'RAW_SECRET_VALUE' },
            shot_ids: { secret: 'RAW_SECRET_VALUE' },
          },
        ],
      },
      requests: [],
    }
    await installFixtures(page, state)

    await page.goto('/redraw/projects/41/works/710?step=2')

    await expect(page.getByText('5 项待处理')).toBeVisible()
    await expect(page.getByText('character #1201')).toBeVisible()
    await expect(page.getByText('镜头 shot-01')).toBeVisible()
    await expect(page.getByText('镜头 shot-02', { exact: true })).toBeVisible()
    await expect(page.getByText('镜头 1302、shot-03', { exact: true })).toBeVisible()
    await expect(page.getByText('镜头 1302、shot-03、1302')).toHaveCount(0)
    await expect(page.getByText('角色方案 #812')).toBeVisible()
    await expect(page.getByText('角色方案尚未就绪')).toBeVisible()
    await expect(page.getByText('门禁检查项', { exact: true })).toBeVisible()
    await expect(page.getByText('需要重新确认', { exact: true })).toBeVisible()
    await expect(page.getByText('RAW_SECRET_VALUE')).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('[object Object]')
    expect(pageErrors).toEqual([])
  })

  test('R2d 普通角色身份图：选择取消零上传、显式 multipart、鉴权预览、人工确认保存后批准', async ({ page }) => {
    const uploadResponse = {}; uploadResponse.promise = new Promise(resolve => { uploadResponse.resolve = resolve })
    const state = { strictApi: true, identityUploadOnly: true, identityUploadResponse: uploadResponse, projects: [project], quoteReady: true, assetQuoteReady: true,
      work: { ...workBase, current_step: 2, status: 'asset_review', version_id: 812 },
      assets: [{ ...structuredClone(redrawAssets[0]), asset_id: null, status: 'pending', identity_pack: undefined, identity_pack_status: undefined }, structuredClone(redrawAssets[2])],
      gate: { ok: false, missing: [] }, requests: [] }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=2')
    const card = page.locator('#asset-1201-character'), chooser = card.getByLabel('选择身份图片', { exact: true })
    await expect(chooser).toBeVisible()
    await expect(card.getByText(/PNG.*JPEG.*WebP.*20/)).toBeVisible()
    const chosen = { name: 'identity.png', mimeType: 'image/png', buffer: actorPreviewBytes }
    await chooser.setInputFiles(chosen)
    await expect(card.getByText('identity.png', { exact: true })).toBeVisible()
    await card.getByRole('button', { name: '取消选择' }).click()
    expect(state.requests.filter(item => item.pathname.endsWith('/reference-artifact'))).toHaveLength(0)
    await chooser.setInputFiles(chosen)
    await card.getByRole('button', { name: '上传身份图片', exact: true }).click()
    await expect.poll(() => state.requests.filter(item => item.pathname.endsWith('/reference-artifact')).length).toBe(1)
    for (const name of ['重绘', '保存身份包', '批准', '退回']) await expect(card.getByRole('button', { name, exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '一键批量生成全部资产' })).toBeDisabled()
    uploadResponse.resolve()
    await expect(card.getByRole('button', { name: '保存身份包' })).toBeEnabled()
    await expect(card.getByRole('img', { name: '林夏真人参考图' })).toHaveAttribute('src', /^blob:/)
    await expect.poll(() => card.getByRole('img', { name: '林夏真人参考图' }).evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true)
    expect(state.identityPreviews).toContainEqual({ id: 1201, assetId: 2301 })
    await expect(card.getByRole('button', { name: '批准', exact: true })).toBeDisabled()
    for (const checkbox of await card.locator('input[type="checkbox"]').all()) await expect(checkbox).not.toBeChecked()
    const afterUpload = state.identityTraffic.slice(state.identityTraffic.findIndex(item => item.pathname.endsWith('/reference-artifact')) + 1)
    expect(afterUpload.every(item => item.method === 'GET' && !item.pathname.endsWith('/quote'))).toBe(true)
    expect(state.requests.filter(item => item.pathname.endsWith('/review') || item.pathname.endsWith('/identity-pack'))).toHaveLength(0)
    await card.getByPlaceholder('填写目标演员').fill('Maya Rivera')
    for (const view of ['front', 'profile', 'full_body']) await card.getByText(view, { exact: true }).click()
    for (const label of ['真人确认', '18+确认', '一致性确认', '服装一致性确认']) await card.getByText(label, { exact: true }).click()
    await card.getByText('选择当前版本已有图片资产', { exact: true }).click()
    await page.getByRole('option', { name: /铜钥匙/ }).click()
    await card.getByRole('button', { name: '保存身份包' }).click()
    await expect(card.getByText('服务端已确认')).toBeVisible()
    await card.getByRole('button', { name: '批准', exact: true }).click()
    await expect.poll(() => state.requests.filter(item => item.pathname.endsWith('/review')).length).toBe(1)
    expect(state.requests.filter(item => item.pathname.endsWith('/reference-artifact'))).toHaveLength(1)
    expect(state.identityTraffic.some(item => /generate|\/batches$/.test(item.pathname))).toBe(false)
  })

  test('R2d 普通角色身份图：上传冲突加刷新失败保持冻结，只读重查后才能重新操作', async ({ page }) => {
    const state = { strictApi: true, identityUploadOnly: true, identityUploadError: 409, identityRefreshFailure: true, projects: [project], quoteReady: true, assetQuoteReady: true,
      work: { ...workBase, current_step: 2, status: 'asset_review', version_id: 812 },
      assets: [{ ...structuredClone(redrawAssets[0]), asset_id: null, identity_pack: undefined, identity_pack_status: undefined }], gate: { ok: false, missing: [] }, requests: [] }
    await installFixtures(page, state); await page.goto('/redraw/projects/41/works/710?step=2')
    const card = page.locator('#asset-1201-character')
    await expect(card.getByLabel('选择身份图片', { exact: true })).toBeVisible()
    await card.getByLabel('选择身份图片', { exact: true }).setInputFiles({ name: 'identity.png', mimeType: 'image/png', buffer: actorPreviewBytes })
    await card.getByRole('button', { name: '上传身份图片', exact: true }).click()
    await expect(card.getByText(/刷新失败.*冻结/)).toBeVisible()
    for (const name of ['重绘', '保存身份包', '批准', '退回', '上传身份图片']) await expect(card.getByRole('button', { name, exact: true })).toBeDisabled()
    state.identityRefreshFailure = false
    await card.getByRole('button', { name: '刷新当前角色状态' }).click()
    await expect(card.getByRole('button', { name: '保存身份包' })).toBeEnabled()
    expect(state.requests.filter(item => item.pathname.endsWith('/reference-artifact'))).toHaveLength(1)
    expect(state.requests.filter(item => item.pathname.endsWith('/review') || item.pathname.endsWith('/identity-pack'))).toHaveLength(0)
    expect(state.identityTraffic.some(item => /generate|\/batches$/.test(item.pathname))).toBe(false)
  })

  test('角色身份包未确认时禁止批准，补齐人工确认后保存并显示逐镜映射', async ({ page }) => {
    const state = {
      projects: [project],
      quoteReady: true,
      assetQuoteReady: true,
      work: { ...workBase, current_step: 2, status: 'asset_review', version_id: 812 },
      assets: [{ ...structuredClone(redrawAssets[0]), identity_pack: undefined, identity_pack_status: undefined }],
      gate: { ok: false, missing: [{ kind: 'character', asset_id: 1201, shot_ids: ['shot-01'], anchor: 'asset-1201-character' }], current_step: 2 },
      requests: [],
    }
    await installFixtures(page, state)
    await page.setViewportSize({ width: 1440, height: 900 })

    await page.goto('/redraw/projects/41/works/710?step=2')
    await expect(page.getByText('服务端未确认')).toBeVisible()
    await expect(page.getByText(/缺项：正面、侧面、全身/)).toBeVisible()
    await expect(page.getByRole('button', { name: '批准' })).toBeDisabled()

    await page.getByPlaceholder('填写目标演员').fill('Maya Rivera')
    for (const view of ['front', 'profile', 'full_body']) await page.getByText(view, { exact: true }).click()
    await page.getByText('真人确认', { exact: true }).click()
    await page.getByText('18+确认', { exact: true }).click()
    await page.getByText('一致性确认', { exact: true }).click()
    await page.getByRole('button', { name: '保存身份包' }).click()

    await expect.poll(() => state.requests.filter((entry) => entry.method === 'PUT' && entry.pathname === '/api/v1/redraw/assets/1201/identity-pack').length).toBe(1)
    const identitySave = state.requests.find((entry) => entry.pathname === '/api/v1/redraw/assets/1201/identity-pack')
    expectOnlyKeys(identitySave.body, [
      'target_actor_label', 'confirmed_views', 'live_action_human_confirmed',
      'adult_status', 'identity_consistency_confirmed', 'expected_updated_at',
    ])
    expect(identitySave.body.confirmed_views).toEqual(['front', 'profile', 'full_body'])
    expect(forbiddenClientFields(identitySave.body)).toEqual([])
    expect(JSON.stringify(identitySave.body)).not.toContain('source_character_key')
    await expect(page.getByText('服务端已确认')).toBeVisible()

    await page.getByRole('button', { name: '批准' }).click()
    await expect.poll(() => state.requests.filter((entry) => entry.pathname.endsWith('/review')).length).toBe(1)
  })

  test('第二步资产审核移动端无横向页面滚动', async ({ page }) => {
    const state = {
      projects: [project],
      quoteReady: true,
      assetQuoteReady: true,
      work: { ...workBase, current_step: 2, status: 'asset_review', version_id: 812 },
      assets: redrawAssets.map((asset) => ({ ...asset })),
      gate: buildAssetGate(redrawAssets),
      requests: [],
    }
    await installFixtures(page, state)
    await page.setViewportSize({ width: 390, height: 844 })

    await page.goto('/redraw/projects/41/works/710?step=2')
    await expect(page.getByText('确认本地化资产后再进入批量转绘')).toBeVisible()
    await expect(page.getByText('本次预计扣除 8 积分')).toBeVisible()
    await assertNoPageHorizontalScroll(page)
    await assertTextFits(page, '确认本地化资产后再进入批量转绘')
  })

  test('第三步按后端快照编辑、单镜提交、失败重试并切换已完成新片', async ({ page }) => {
    const state = generationFixtureState()
    await installFixtures(page, state)
    await page.setViewportSize({ width: 1440, height: 1000 })

    await page.goto('/redraw/projects/41/works/710?step=3')
    await expect(page.getByRole('heading', { name: '按分镜生成并从后端恢复真实进度' })).toBeVisible()
    await expect(page.getByText('本次预计扣除 10 积分')).toBeVisible()
    await expect(page.getByText('批量总价 10 积分')).toBeVisible()
    await expect(page.getByText('分镜价格明细')).toBeVisible()
    await expect(page.getByText('本次预计扣除 4 积分')).toBeVisible()
    await expect(page.getByText('@角色 Maya · v3')).toBeVisible()
    await expect(page.locator('.shot-preview video')).toHaveAttribute('src', /source\.mp4#t=0/)

    const referenceInput = page.locator('.reference-select input').first()
    await referenceInput.click()
    await referenceInput.fill('@Brooklyn')
    await page.getByRole('option', { name: /Brooklyn Loft/ }).click()
    await referenceInput.click()
    await referenceInput.fill('@Brass')
    await page.getByRole('option', { name: /Brass Key/ }).click()
    await expect(page.getByText('@场景 Brooklyn Loft · v3')).toBeVisible()
    await expect(page.getByText('@物品 Brass Key · v3')).toBeVisible()

    await page.getByRole('textbox', { name: '连续动作' }).fill('She unlocks the door, enters, and keeps moving forward.')
    await page.getByRole('button', { name: '保存镜头' }).click()
    await expect.poll(() => state.requests.filter((entry) => entry.method === 'PUT' && entry.pathname === '/api/v1/redraw/shots/1301').length).toBe(1)
    const saved = state.requests.find((entry) => entry.method === 'PUT' && entry.pathname === '/api/v1/redraw/shots/1301')
    expect(saved.body.updated_at).toBe('2026-08-06T08:30:00.000Z')
    expect(saved.body.count).toBe(1)
    expect(saved.body.references).toEqual([
      { redraw_asset_id: 1201, kind: 'character', version_number: 3 },
      { redraw_asset_id: 1202, kind: 'scene', version_number: 3 },
      { redraw_asset_id: 1203, kind: 'prop', version_number: 3 },
    ])

    await page.getByRole('button', { name: '生成本镜头' }).click()
    await expect.poll(() => state.requests.some((entry) => entry.pathname === '/api/v1/redraw/shots/1301/generate')).toBe(true)
    const generated = state.requests.find((entry) => entry.pathname === '/api/v1/redraw/shots/1301/generate')
    expect(generated.body).toEqual({
      model: 'fixture-video-model-from-backend',
      duration: 12,
      resolution: '720p',
    })
    expect(generated.body).not.toHaveProperty('count')
    expect(generated.body).not.toHaveProperty('credit_amount')
    expect(generated.body).not.toHaveProperty('new_video_ref')

    await page.getByRole('button', { name: /镜头 2/ }).click()
    await expect(page.getByText('供应商明确失败，可修改后独立重试')).toBeVisible()
    await page.getByRole('button', { name: '独立重试' }).click()
    await expect.poll(() => state.requests.some((entry) => entry.pathname === '/api/v1/redraw/shots/1302/generate')).toBe(true)
    const retried = state.requests.find((entry) => entry.pathname === '/api/v1/redraw/shots/1302/generate')
    expect(retried.body.retry).toBe(true)
    expect(retried.body).not.toHaveProperty('count')

    await page.getByRole('button', { name: '已完成', exact: true }).click()
    await page.getByRole('button', { name: /镜头 3/ }).click()
    await expect(page.getByRole('button', { name: '新片' })).toBeEnabled()
    await page.getByRole('button', { name: '新片' }).click()
    await expect(page.locator('.shot-preview video')).toHaveAttribute('src', /generated\.mp4#t=24/)
    await assertNoPageHorizontalScroll(page)
  })

  test('R2d2c 动作素材：普通用户预览静音草稿、选择取消始终零上传', async ({ page }, testInfo) => {
    const state = motionFixtureState(generationFixtureState())
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=3')
    await expect(page.getByTestId('motion-draft-preview')).toBeVisible()
    await expect(page.getByText('高级参考包绑定', { exact: true })).toBeVisible()
    await expect(page.getByText('无原音运动参考资产 ID', { exact: true })).not.toBeVisible()
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeEnabled()
    await expect(page.getByRole('button', { name: '批量生成 2 镜' })).toBeEnabled()
    await expect(page.getByRole('button', { name: '下一次尝试 2' })).toBeEnabled()
    const initialPosts = state.motionTraffic.filter(item => item.method === 'POST').length
    await page.getByTestId('motion-draft-preview').click()
    await expect(page.getByText(/仅裁片静音、人物和文字未遮除/)).toBeVisible()
    await assertMotionVideoDecoded(page.getByTestId('motion-draft-video'))
    for (const id of ['full-frame-reviewed', 'source-identity-obscured', 'source-text-obscured', 'motion-preserved']) {
      await expect(page.getByTestId(`motion-confirm-${id}`)).not.toBeChecked()
    }
    await expect(page.getByTestId('motion-upload')).toBeDisabled()
    await page.getByTestId('motion-processed-file').setInputFiles({ name: 'processed-motion.mp4', mimeType: 'video/mp4', buffer: nextMotionBytes })
    await assertMotionVideoDecoded(page.getByTestId('motion-local-video'))
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '批量生成 2 镜' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '下一次尝试 2' })).toBeDisabled()
    await page.getByTestId('motion-confirm-full-frame-reviewed').check()
    await expect(page.getByTestId('motion-upload')).toBeDisabled()
    await page.getByTestId('motion-cancel').click()
    await expect(page.getByTestId('motion-local-video')).toHaveCount(0)
    await expect(page.getByTestId('motion-confirm-full-frame-reviewed')).not.toBeChecked()
    expect(state.requests.filter(item => item.pathname.endsWith('/motion-reference') && item.method === 'POST')).toHaveLength(0)
    expect(state.motionTraffic.filter(item => item.method === 'POST')).toHaveLength(initialPosts)
    await assertNoPageHorizontalScroll(page)
    await page.screenshot({ path: testInfo.outputPath('motion-draft-ordinary-user.png'), fullPage: true })
  })

  test('R2d2c 动作素材：四确认仅一次上传，完整 GET 刷新期间冻结且旧 ready 不放行', async ({ page }) => {
    let releaseUpload, releaseBundle
    const state = motionFixtureState(generationFixtureState())
    state.motionUploadWait = { promise: new Promise(resolve => { releaseUpload = resolve }) }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=3')
    await expect(page.getByTestId('motion-candidate-video')).toBeVisible()
    await assertMotionVideoDecoded(page.getByTestId('motion-candidate-video'))
    await page.getByTestId('motion-processed-file').setInputFiles({ name: 'processed-motion.mp4', mimeType: 'video/mp4', buffer: nextMotionBytes })
    for (const id of ['full-frame-reviewed', 'source-identity-obscured', 'source-text-obscured', 'motion-preserved']) await page.getByTestId(`motion-confirm-${id}`).check()
    await page.getByTestId('motion-upload').click()
    await expect.poll(() => state.requests.filter(item => item.method === 'POST' && item.pathname.endsWith('/motion-reference')).length).toBe(1)
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '批量生成 2 镜' })).toBeDisabled()
    await expect(page.getByTestId('motion-upload')).toBeDisabled()
    state.motionBundleWait = { promise: new Promise(resolve => { releaseBundle = resolve }) }
    releaseUpload()
    await expect.poll(() => state.motionTraffic.slice(state.motionTraffic.findIndex(item => item.method === 'POST' && item.pathname.endsWith('/motion-reference')) + 1)
      .some(item => item.pathname.endsWith('/reference-bundle'))).toBe(true)
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    releaseBundle()
    await expect.poll(() => state.motionMediaRequests.some(item => item.importId === '4901')).toBe(true)
    await assertMotionVideoDecoded(page.getByTestId('motion-candidate-video'))
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    const afterUpload = state.motionTraffic.slice(state.motionTraffic.findIndex(item => item.method === 'POST' && item.pathname.endsWith('/motion-reference')) + 1)
    const workIndex = afterUpload.findIndex(item => item.pathname === '/api/v1/redraw/works/710')
    const candidateIndex = afterUpload.findIndex(item => item.pathname === '/api/v1/redraw/shots/1301/motion-reference')
    const bundleIndex = afterUpload.findIndex(item => item.pathname === '/api/v1/redraw/shots/1301/reference-bundle')
    const mediaIndex = afterUpload.findIndex(item => item.pathname === '/api/v1/redraw/shots/1301/motion-reference/media')
    expect(workIndex).toBeGreaterThanOrEqual(0)
    expect(candidateIndex).toBeGreaterThan(workIndex)
    expect(bundleIndex).toBeGreaterThan(candidateIndex)
    expect(mediaIndex).toBeGreaterThan(bundleIndex)
    expect(afterUpload.every(item => item.method === 'GET')).toBe(true)
    await page.getByTestId('motion-refresh').click()
    await page.reload()
    await expect(page.getByTestId('motion-candidate-video')).toBeVisible()
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    expect(state.requests.filter(item => item.method === 'POST' && item.pathname.endsWith('/motion-reference'))).toHaveLength(1)
    expect(state.motionTraffic.slice(state.motionTraffic.findIndex(item => item.method === 'POST' && item.pathname.endsWith('/motion-reference')) + 1).every(item => item.method === 'GET')).toBe(true)
  })

  test('R2d2c 动作素材：上传未知后旧候选 GET、切镜和页面刷新都不能解除防重', async ({ page }) => {
    const state = motionFixtureState(generationFixtureState())
    state.motionUploadError = 503
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=3')
    await page.getByTestId('motion-processed-file').setInputFiles({ name: 'processed-motion.mp4', mimeType: 'video/mp4', buffer: nextMotionBytes })
    for (const id of ['full-frame-reviewed', 'source-identity-obscured', 'source-text-obscured', 'motion-preserved']) await page.getByTestId(`motion-confirm-${id}`).check()
    await page.getByTestId('motion-upload').click()
    await expect.poll(() => state.requests.filter(item => item.method === 'POST' && item.pathname.endsWith('/motion-reference')).length).toBe(1)
    await expect(page.getByTestId('motion-upload')).toBeDisabled()
    await page.getByTestId('motion-refresh').click()
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    await page.getByRole('button', { name: /镜头 2/ }).click()
    await expect(page.getByTestId('motion-processed-file')).toBeDisabled()
    await expect(page.getByTestId('motion-upload')).toBeDisabled()
    await expect(page.getByRole('button', { name: '独立重试' })).toBeDisabled()
    await page.getByRole('button', { name: /镜头 1/ }).click()
    await page.reload()
    await expect(page.getByTestId('motion-upload')).toBeDisabled()
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '批量生成 2 镜' })).toBeDisabled()
    expect(state.requests.filter(item => item.method === 'POST' && item.pathname.endsWith('/motion-reference'))).toHaveLength(1)
  })

  for (const candidateStatus of ['missing', 'unavailable']) test(`R2d2c 动作素材：${candidateStatus} 不复用旧 ready 或更早候选`, async ({ page }) => {
    const state = motionFixtureState(generationFixtureState())
    if (candidateStatus === 'missing') state.motionCandidates[1301] = null
    else state.motionUnavailable = [1301]
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=3')
    await expect(page.getByTestId('motion-status')).toBeVisible()
    await expect(page.getByTestId('motion-candidate-video')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    expect(state.motionMediaRequests?.some(item => item.shotId === 1301) || false).toBe(false)
  })

  test('R2d2c 动作素材：同 CAS 媒体 409 清除旧预览并禁止旧 ready 放行', async ({ page }) => {
    const state = motionFixtureState(generationFixtureState())
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=3')
    await assertMotionVideoDecoded(page.getByTestId('motion-candidate-video'))
    state.motionMediaConflict = true
    const trafficStart = state.motionTraffic.length
    await page.getByTestId('motion-refresh').click()
    await expect(page.getByTestId('motion-status')).toContainText(/409|MOTION_CANDIDATE_CHANGED/)
    await expect(page.getByTestId('motion-candidate-video')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    expect(state.motionTraffic.slice(trafficStart).every(item => item.method === 'GET')).toBe(true)
  })

  test('R2d2c 动作素材：上传接受后 work 刷新失败保留阻断且不自动再次上传', async ({ page }) => {
    const state = motionFixtureState(generationFixtureState())
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=3')
    await page.getByTestId('motion-processed-file').setInputFiles({ name: 'processed-motion.mp4', mimeType: 'video/mp4', buffer: nextMotionBytes })
    for (const id of ['full-frame-reviewed', 'source-identity-obscured', 'source-text-obscured', 'motion-preserved']) await page.getByTestId(`motion-confirm-${id}`).check()
    state.motionWorkError = true
    await page.getByTestId('motion-upload').click()
    await expect(page.getByTestId('motion-status')).toContainText('MOTION_WORK_REFRESH_FAILED')
    await expect(page.getByTestId('motion-upload')).toBeDisabled()
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    state.motionWorkError = false
    await page.getByTestId('motion-refresh').click()
    await assertMotionVideoDecoded(page.getByTestId('motion-candidate-video'))
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    expect(state.requests.filter(item => item.method === 'POST' && item.pathname.endsWith('/motion-reference'))).toHaveLength(1)
  })

  test('R2d2c 动作素材：A-B-A 切镜忽略旧候选响应，卸载释放媒体', async ({ page }) => {
    const state = motionFixtureState(generationFixtureState())
    await page.addInitScript(() => {
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
      window.__motionObjectUrls = { created: [], revoked: [] }
      URL.createObjectURL = value => { const result = create(value); window.__motionObjectUrls.created.push(result); return result }
      URL.revokeObjectURL = value => { window.__motionObjectUrls.revoked.push(value); return revoke(value) }
    })
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=3')
    await assertMotionVideoDecoded(page.getByTestId('motion-candidate-video'))
    let releaseCandidate
    state.motionNextCandidateWait = { promise: new Promise(resolve => { releaseCandidate = resolve }) }
    await page.getByTestId('motion-refresh').click()
    await expect.poll(() => state.motionHeldCandidates).toBe(1)
    state.motionCandidates[1301] = motionCandidate(4901, 5901, nextMotionBytes)
    await page.getByRole('button', { name: /镜头 2/ }).click()
    await expect(page.locator('.shot-editor__heading').getByText('镜头 2')).toBeVisible()
    await page.getByRole('button', { name: /镜头 1/ }).click()
    await expect.poll(() => state.motionMediaRequests.some(item => item.importId === '4901')).toBe(true)
    await assertMotionVideoDecoded(page.getByTestId('motion-candidate-video'))
    const currentBlob = await page.getByTestId('motion-candidate-video').getAttribute('src')
    releaseCandidate()
    await expect.poll(() => state.motionReleasedCandidates).toBe(1)
    await expect(page.getByTestId('motion-candidate-video')).toHaveAttribute('src', currentBlob)
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    // Client-side navigation unmounts ShotStep without replacing this JS context.
    await page.getByRole('button', { name: '返回项目' }).click()
    await expect(page.getByTestId('motion-candidate-video')).toHaveCount(0)
    await expect.poll(() => page.evaluate(url => window.__motionObjectUrls.revoked.includes(url), currentBlob)).toBe(true)
  })

  test('R2d2c 动作素材：移动端本地预览与四项确认不横向溢出', async ({ page }, testInfo) => {
    const state = motionFixtureState(generationFixtureState())
    await installFixtures(page, state)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/redraw/projects/41/works/710?step=3')
    await page.getByTestId('motion-processed-file').setInputFiles({ name: 'processed-motion.mp4', mimeType: 'video/mp4', buffer: nextMotionBytes })
    await assertMotionVideoDecoded(page.getByTestId('motion-local-video'))
    await assertNoPageHorizontalScroll(page)
    await page.getByTestId('motion-local-video').scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath('motion-mobile-user.png') })
    expect(state.requests.filter(item => item.method === 'POST' && item.pathname.endsWith('/motion-reference'))).toHaveLength(0)
  })

  test('R2d2c 动作素材：候选读取未终态时单镜、批次和队列按钮均冻结', async ({ page }) => {
    const state = motionFixtureState(generationFixtureState())
    state.motionUnavailable = [1301]
    let releaseCandidate
    state.motionNextCandidateWait = { promise: new Promise(resolve => { releaseCandidate = resolve }) }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=3')
    try {
      await expect.poll(() => state.motionHeldCandidates).toBe(1)
      await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
      await expect(page.getByRole('button', { name: '批量生成 2 镜' })).toBeDisabled()
      await expect(page.getByRole('button', { name: '下一次尝试 2' })).toBeDisabled()
    } finally {
      releaseCandidate()
    }
    await expect.poll(() => state.motionReleasedCandidates).toBe(1)
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    expect(state.motionTraffic.filter(item => /generate|\/reference-preparations$/.test(item.pathname))).toHaveLength(0)
  })

  test('R2d2c 动作素材：选中镜已确定不可用不锁住其它已就绪镜头', async ({ page }) => {
    const state = motionFixtureState(generationFixtureState())
    state.motionUnavailable = [1301]
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=3')
    await expect(page.getByTestId('motion-status')).toBeVisible()
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '下一次尝试 2' })).toBeEnabled()
    await expect(page.getByRole('button', { name: /批量生成/ })).toBeEnabled()
    expect(state.motionTraffic.filter(item => /\/generate$|\/reference-preparations$/.test(item.pathname))).toHaveLength(0)
  })

  test('第三步 pricing_unconfigured 时禁用提交并显示后端原因', async ({ page }) => {
    const state = generationFixtureState()
    state.work.shots[0].quote = null
    state.work.shots[0].quote_snapshot = null
    state.work.shots[0].billing = { held: 0, charged: 0, released: 0, quote: null }
    state.work.shots[0].generation_availability = {
      ok: false,
      code: 'pricing_unconfigured',
      reason: '视频模型尚未配置积分价格',
    }
    await installFixtures(page, state)

    await page.goto('/redraw/projects/41/works/710?step=3')
    await expect(page.getByText('视频模型尚未配置积分价格')).toHaveCount(2)
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '批量生成 2 镜' })).toBeDisabled()
  })

  test('第三步无生成能力时禁用提交并显示后端原因', async ({ page }) => {
    const state = generationFixtureState()
    state.work.shots[0].quote = null
    state.work.shots[0].quote_snapshot = null
    state.work.shots[0].billing = { held: 0, charged: 0, released: 0, quote: null }
    state.work.shots[0].generation_availability = {
      ok: false,
      code: 'no_verified_video_model',
      reason: '当前语言市场没有已验证可读的视频生成能力',
    }
    await installFixtures(page, state)

    await page.goto('/redraw/projects/41/works/710?step=3')
    await expect(page.getByText('当前语言市场没有已验证可读的视频生成能力')).toHaveCount(2)
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '批量生成 2 镜' })).toBeDisabled()
  })

  test('第三步资产 gate 关闭时单镜和批量都禁用', async ({ page }) => {
    const state = generationFixtureState()
    state.gate = {
      ok: false,
      missing: [{ kind: 'character', asset_id: 1201, shot_ids: ['shot-01'], anchor: 'asset-1201-character' }],
      current_step: 2,
    }
    await installFixtures(page, state)

    await page.goto('/redraw/projects/41/works/710?step=3')
    await expect(page.getByText('资产门禁未开放，请先完成资产审核')).toHaveCount(2)
    await expect(page.getByRole('button', { name: '生成本镜头' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '批量生成 2 镜' })).toBeDisabled()
  })

  test('第三步先选非首镜后轮询从处理中到完成，停止且保留选中镜头', async ({ page }) => {
    const state = generationFixtureState()
    Object.assign(state.work.shots[1], {
      status: 'draft',
      error_code: null,
      error_message: null,
      generation: { task_id: null, status: null, progress: null, message: null },
      billing: { held: 0, charged: 0, released: 0, quote: { amount: 6 } },
    })
    state.onGetWork = (fixtureState) => {
      const shot = fixtureState.work?.shots?.find((item) => item.id === 1302)
      if (!shot || shot.status !== 'processing' || fixtureState.workGets < 3) return
      shot.status = 'completed'
      shot.generation = { task_id: 'task-shot-1302', status: 'completed', progress: 100, message: '完成' }
      shot.billing = { held: 0, charged: 6, released: 0, quote: { amount: 6 } }
      shot.new_video_ref = { video_url: 'https://fixtures.example/generated.mp4' }
      fixtureState.work.batches = shotBatches(fixtureState.work.shots)
    }
    await installFixtures(page, state)

    await page.goto('/redraw/projects/41/works/710?step=3')
    await page.getByRole('button', { name: /镜头 2/ }).click()
    await page.getByRole('button', { name: '生成本镜头' }).click()
    await expect(page.getByRole('button', { name: /镜头 2/ })).toHaveClass(/active/)
    await expect(page.getByRole('button', { name: '新片' })).toBeEnabled({ timeout: 8000 })
    await expect(page.locator('.shot-editor__heading').getByText('镜头 2')).toBeVisible()
    await page.getByRole('button', { name: '新片' }).click()
    await expect(page.locator('.shot-preview video')).toHaveAttribute('src', /generated\.mp4#t=12/)
    const getCountAfterCompletion = state.workGets
    await page.waitForTimeout(3200)
    expect(state.workGets).toBeLessThanOrEqual(getCountAfterCompletion + 1)
  })

  test('第三步批量提交仅发送当前版本和复数镜头 ID', async ({ page }) => {
    const state = generationFixtureState()
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=3')

    await page.getByRole('button', { name: '批量生成 2 镜' }).click()
    await expect.poll(() => state.requests.some((entry) => entry.pathname === '/api/v1/redraw/works/710/generate-batch')).toBe(true)
    const batch = state.requests.find((entry) => entry.pathname === '/api/v1/redraw/works/710/generate-batch')
    expect(batch.body).toEqual({ version_id: 812, shot_ids: [1301, 1302] })
    expect(batch.body).not.toHaveProperty('shot_id')
    expect(batch.body).not.toHaveProperty('count')
  })

  test('第三步移动端批次、预览、编辑和积分合同无横向溢出', async ({ page }) => {
    const state = generationFixtureState()
    await installFixtures(page, state)
    await page.setViewportSize({ width: 390, height: 844 })

    await page.goto('/redraw/projects/41/works/710?step=3')
    await expect(page.getByText('按分镜生成并从后端恢复真实进度')).toBeVisible()
    await expect(page.getByText('本次预计扣除 10 积分')).toBeVisible()
    await expect(page.getByText('本次预计扣除 4 积分')).toBeVisible()
    await expect(page.getByText('建议保持 5–15 秒')).toBeVisible()
    await assertNoPageHorizontalScroll(page)
    await assertTextFits(page, '本次预计扣除 4 积分')
  })

  test('第四步 en-US 配音后合成并通过鉴权 blob 下载交付文件', async ({ page }) => {
    const state = editFixtureState()
    await installFixtures(page, state)
    await page.setViewportSize({ width: 1440, height: 1000 })

    await page.goto('/redraw/projects/41/works/710?step=4')
    await expect(page.getByRole('heading', { name: 'en-US 配音、合成预览与下载' })).toBeVisible()
    await expect(page.getByText('固定源片顺序')).toBeVisible()
    await expect(page.getByText('本次预计扣除 7 积分')).toBeVisible()
    await expect(page.getByRole('button', { name: /镜头 1/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /镜头 2/ })).toBeVisible()

    await page.getByRole('button', { name: '生成en-US 配音' }).click()
    await expect.poll(() => state.requests.some((entry) => entry.pathname === '/api/v1/redraw/versions/812/dialogue/start')).toBe(true)
    const dialogue = state.requests.find((entry) => entry.pathname === '/api/v1/redraw/versions/812/dialogue/start')
    expectOnlyKeys(dialogue.body, ['quote_hash', 'idempotency_key'])
    expect(forbiddenClientFields(dialogue.body)).toEqual([])
    await expect(page.getByText('任务 task-dialogue-812 · 完成')).toBeVisible()

    await page.getByRole('button', { name: '合成成片' }).click()
    await expect.poll(() => state.requests.some((entry) => entry.pathname === '/api/v1/redraw/versions/812/compose')).toBe(true)
    const compose = state.requests.find((entry) => entry.pathname === '/api/v1/redraw/versions/812/compose')
    expectOnlyKeys(compose.body, ['idempotency_key', 'audio_mode'])
    expect(compose.body.audio_mode).toBe('replace')
    expect(forbiddenClientFields(compose.body)).toEqual([])

    await expect(page.getByText('MP4')).toBeVisible({ timeout: 8000 })
    await expect(page.getByText('1111111111111111111111111111111111111111111111111111111111111111')).toBeVisible()
    await expect(page.getByRole('button', { name: '剪映导入不可用' })).toBeDisabled()
    await expect(page.getByRole('button', { name: '工厂导入不可用' })).toBeDisabled()

    await page.getByRole('button', { name: '新成片' }).click()
    await expect.poll(() => state.requests.some((entry) => entry.pathname === '/api/v1/redraw/exports/901/download/mp4')).toBe(true)
    await assertNoPageHorizontalScroll(page)
  })
})
