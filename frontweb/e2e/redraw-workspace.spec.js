import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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

function blueprintReviewRecord() {
  return {
    id: 901,
    work_id: workBase.id,
    revision: 1,
    status: 'draft',
    blueprint_hash: 'c'.repeat(64),
    updated_at: '2026-09-03T10:00:00.000Z',
    blueprint: {
      schema_version: 'episode-blueprint-v1',
      source: {
        asset_id: 'source-910',
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
        summary: '雨夜订单把男主重新带回旧案。',
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
        confidence: { character_mapping: 0.9, speaker_mapping: 0.73, text_regions: 0.9, shot_boundary: 0.94 },
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
    localized_dialogue: ['You finally made it.'],
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
    localized_dialogue: ["Don't look back."],
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
  { locale: 'zh-CN', market: 'CN' },
  { locale: 'en-US', market: 'US' },
]
const browserErrorsByPage = new WeakMap()

function apiData(data) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  }
}

async function installFixtures(page, state) {
  await page.addInitScript(() => {
    window.localStorage.setItem('moli_mama_session', JSON.stringify({
      token: 'e2e-redraw-token',
      user: { id: 'user-redraw-e2e', email: 'redraw-e2e@example.test', role: 'admin' },
    }))
  })
  await page.route('https://fixtures.example/*.mp4', async (route) => {
    await route.fulfill({ path: fixtureVideoPath, contentType: 'video/mp4' })
  })
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url
    const method = request.method()

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
      await route.fulfill(apiData(project))
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
    if (method === 'GET' && pathname === `/api/v1/redraw/works/${workBase.id}`) {
      state.workGets = (state.workGets || 0) + 1
      if (typeof state.onGetWork === 'function') state.onGetWork(state)
      state.work = {
        ...(state.work || workBase),
        ...(state.quoteReady ? { analysis_quote: { credits: 6 } } : { analysis_quote: null }),
      }
      await route.fulfill(apiData(state.work))
      return
    }
    if (method === 'GET' && pathname === `/api/v1/redraw/works/${workBase.id}/blueprint`) {
      if (!state.blueprint) {
        await route.fulfill(apiData(null))
        return
      }
      await route.fulfill(apiData(structuredClone(state.blueprint)))
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
      state.blueprint = {
        ...state.blueprint,
        blueprint: structuredClone(body.blueprint),
        blueprint_hash: 'e'.repeat(64),
        updated_at: '2026-09-03T10:01:00.000Z',
      }
      state.blueprint.blueprint.blueprint_hash = state.blueprint.blueprint_hash
      await route.fulfill(apiData(structuredClone(state.blueprint)))
      return
    }
    if (method === 'POST' && pathname === `/api/v1/redraw/works/${workBase.id}/blueprint/lock`) {
      const body = request.postDataJSON()
      state.requests.push({ method, pathname, body })
      state.blueprint = {
        ...state.blueprint,
        status: 'locked',
        updated_at: '2026-09-03T10:02:00.000Z',
      }
      await route.fulfill(apiData(structuredClone(state.blueprint)))
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
      state.work = {
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
        status: 'processing',
        progress: 33,
        billing: state.work.localization_billing,
      }))
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
      await route.fulfill(apiData(state.assets))
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
        priced: true,
        credits: 7,
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
    projects: [project],
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
    expect(browserErrorsByPage.get(page) || []).toEqual([])
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
      projects: [project],
      quoteReady: true,
      work: { ...analysisReviewWork(), url: 'https://fixtures.example/source.mp4' },
      blueprint: blueprintReviewRecord(),
      requests: [],
    }
    await installFixtures(page, state)
    await page.goto('/redraw/projects/41/works/710?step=1')

    await expect(page.getByRole('heading', { name: '母本反推审核' })).toBeVisible()
    await expect(page.getByText('speaker-cluster-1', { exact: true })).toBeVisible()
    await expect(page.getByText('尾号八七的订单到了。')).toBeVisible()
    await expect(page.getByText('evidence-audio-1', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: '开始本地化' })).toBeDisabled()
    await expect(page.getByText('本地化报价 9 积分')).toHaveCount(0)

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
  })

  test('母本蓝图保存 CAS 冲突时要求刷新且不静默覆盖或继续锁定', async ({ page }) => {
    const original = blueprintReviewRecord()
    const state = {
      projects: [project],
      quoteReady: true,
      work: { ...analysisReviewWork(), url: 'https://fixtures.example/source.mp4' },
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
    const browserErrors = browserErrorsByPage.get(page) || []
    expect(browserErrors.some((message) => message.includes('409 (Conflict)'))).toBe(true)
    browserErrorsByPage.set(page, browserErrors.filter((message) => !message.includes('409 (Conflict)')))
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

    await page.getByRole('button', { name: '确认英文 1:1 本地化' }).click()
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
    await expect(page.getByText('建议保持 10–15 秒')).toBeVisible()
    await assertNoPageHorizontalScroll(page)
    await assertTextFits(page, '本次预计扣除 4 积分')
  })

  test('第四步英文配音后合成并通过鉴权 blob 下载交付文件', async ({ page }) => {
    const state = editFixtureState()
    await installFixtures(page, state)
    await page.setViewportSize({ width: 1440, height: 1000 })

    await page.goto('/redraw/projects/41/works/710?step=4')
    await expect(page.getByRole('heading', { name: '英文配音、合成预览与下载' })).toBeVisible()
    await expect(page.getByText('固定源片顺序')).toBeVisible()
    await expect(page.getByText('本次预计扣除 7 积分')).toBeVisible()
    await expect(page.getByRole('button', { name: /镜头 1/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /镜头 2/ })).toBeVisible()

    await page.getByRole('button', { name: '生成英文配音' }).click()
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
