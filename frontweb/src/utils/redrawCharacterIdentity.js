const IDENTITY_PACK_SCHEMA_VERSION = 'target-actor-identity-v1'
const IDENTITY_PACK_VIEWS = ['front', 'profile', 'full_body']
const IDENTITY_PACK_VIEW_LABELS = {
  front: '正面',
  profile: '侧面',
  full_body: '全身',
}
const IDENTITY_PACK_CONFIRMATION_LABELS = {
  live_action_human_confirmed: '真人确认',
  adult_status: '18+确认',
  identity_consistency_confirmed: '一致性确认',
}

function normalizeText(value) {
  return String(value || '').trim()
}

function normalizeViews(value) {
  const items = Array.isArray(value) ? value : []
  const seen = new Set()
  const views = []
  for (const item of items) {
    const view = normalizeText(item).toLowerCase()
    if (!IDENTITY_PACK_VIEWS.includes(view) || seen.has(view)) continue
    seen.add(view)
    views.push(view)
  }
  return views
}

function normalizeHash(value) {
  const hash = normalizeText(value).toLowerCase()
  return /^[0-9a-f]{64}$/.test(hash) ? hash : ''
}

function shortHash(value) {
  const hash = normalizeHash(value)
  return hash ? hash.slice(0, 8) : ''
}

function viewLabels(views) {
  return (Array.isArray(views) ? views : [])
    .map((view) => IDENTITY_PACK_VIEW_LABELS[view])
    .filter(Boolean)
}

function missingLabels(missingViews, missingConfirmations) {
  return [
    ...(Array.isArray(missingViews) ? missingViews : []),
    ...(Array.isArray(missingConfirmations) ? missingConfirmations : []),
  ].map((item) => IDENTITY_PACK_VIEW_LABELS[item] || IDENTITY_PACK_CONFIRMATION_LABELS[item] || normalizeText(item))
    .filter(Boolean)
}

export function shortIdentityPackHash(value) {
  return shortHash(value)
}

export function projectRedrawCharacterIdentityPack(asset = {}) {
  const pack = asset?.identity_pack && typeof asset.identity_pack === 'object' ? asset.identity_pack : {}
  const status = asset?.identity_pack_status && typeof asset.identity_pack_status === 'object' ? asset.identity_pack_status : {}
  const confirmedViews = normalizeViews(pack.confirmed_views)
  const hash = normalizeHash(pack.pack_sha256)
  const missingViews = Array.isArray(status.missing_views)
    ? status.missing_views.filter((view) => IDENTITY_PACK_VIEW_LABELS[view])
    : IDENTITY_PACK_VIEWS.filter((view) => !confirmedViews.includes(view))
  const missingConfirmations = Array.isArray(status.missing_confirmations)
    ? status.missing_confirmations.filter((item) => IDENTITY_PACK_CONFIRMATION_LABELS[item])
    : Object.keys(IDENTITY_PACK_CONFIRMATION_LABELS).filter((item) => {
      if (item === 'adult_status') return pack.adult_status !== 'verified_18_plus'
      return pack[item] !== true
    })
  const targetActorLabel = normalizeText(pack.target_actor_label)
  const sourceLabel = normalizeText(asset.localized_name || asset.display_name || asset.name || asset.source_character_key || asset.id)
  const ready = status.ready === true
    || Boolean(
      normalizeText(pack.schema_version) === IDENTITY_PACK_SCHEMA_VERSION
      && normalizeText(pack.source_character_key)
      && targetActorLabel
      && confirmedViews.length === IDENTITY_PACK_VIEWS.length
      && pack.live_action_human_confirmed === true
      && pack.adult_status === 'verified_18_plus'
      && pack.identity_consistency_confirmed === true
      && hash
    )
  return {
    sourceLabel,
    targetActorLabel,
    confirmedViews,
    confirmedViewLabels: viewLabels(confirmedViews),
    missingViews,
    missingViewLabels: viewLabels(missingViews),
    missingConfirmations,
    missingConfirmationLabels: missingLabels([], missingConfirmations),
    missingLabels: missingLabels(missingViews, missingConfirmations),
    missing: [...missingViews, ...missingConfirmations],
    liveActionHumanConfirmed: pack.live_action_human_confirmed === true,
    adultStatus: normalizeText(pack.adult_status) === 'verified_18_plus' ? 'verified_18_plus' : 'unverified',
    identityConsistencyConfirmed: pack.identity_consistency_confirmed === true,
    hashValid: Boolean(status.hash_valid === true || hash),
    shortHash: shortHash(hash),
    ready,
  }
}

export function isRedrawCharacterIdentityPackReady(asset = {}) {
  return projectRedrawCharacterIdentityPack(asset).ready
}
