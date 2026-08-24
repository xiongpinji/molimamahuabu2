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
  wardrobe: '服装参考与一致性确认',
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
  const wardrobe = pack?.wardrobe && typeof pack.wardrobe === 'object' ? pack.wardrobe : {}
  const wardrobeReferenceAssetId = Number(wardrobe.reference_asset_id)
  const wardrobeConsistencyConfirmed = wardrobe.consistency_confirmed === true
  const wardrobeReady = Number.isSafeInteger(wardrobeReferenceAssetId)
    && wardrobeReferenceAssetId > 0
    && Boolean(normalizeHash(wardrobe.reference_sha256))
    && wardrobeConsistencyConfirmed
  const ready = status.ready === true
    || Boolean(
      normalizeText(pack.schema_version) === IDENTITY_PACK_SCHEMA_VERSION
      && normalizeText(pack.source_character_key)
      && targetActorLabel
      && confirmedViews.length === IDENTITY_PACK_VIEWS.length
      && pack.live_action_human_confirmed === true
      && pack.adult_status === 'verified_18_plus'
      && pack.identity_consistency_confirmed === true
      && wardrobeReady
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
    wardrobeReferenceAssetId: Number.isSafeInteger(wardrobeReferenceAssetId) && wardrobeReferenceAssetId > 0
      ? wardrobeReferenceAssetId
      : null,
    wardrobeConsistencyConfirmed,
    wardrobeReady,
    hashValid: Boolean(status.hash_valid === true || hash),
    shortHash: shortHash(hash),
    ready,
  }
}

export function isRedrawCharacterIdentityPackReady(asset = {}) {
  return projectRedrawCharacterIdentityPack(asset).ready
}

export function projectRedrawCharacterPlan(plan = {}) {
  const characters = (Array.isArray(plan?.characters) ? plan.characters : []).map((character) => {
    const voice = character?.voice && typeof character.voice === 'object' ? character.voice : {}
    const wardrobe = character?.wardrobe && typeof character.wardrobe === 'object' ? character.wardrobe : {}
    const adult = normalizeText(character?.adult_status) === 'verified_18_plus'
    return {
      sourceCharacterKey: normalizeText(character?.source_character_key),
      name: normalizeText(character?.target_name),
      identity: {
        label: adult ? '成年虚构角色' : '身份待确认',
        ready: adult && Boolean(normalizeHash(character?.identity_pack_sha256)),
        shortHash: shortHash(character?.identity_pack_sha256),
      },
      voice: {
        assetId: Number.isSafeInteger(Number(voice.asset_id)) ? Number(voice.asset_id) : null,
        label: normalizeText(voice.language) || '声音待绑定',
        ready: voice.ready === true,
        shortHash: shortHash(voice.sha256),
      },
      wardrobe: {
        assetId: Number.isSafeInteger(Number(wardrobe.asset_id)) ? Number(wardrobe.asset_id) : null,
        label: normalizeText(wardrobe.label) || '服装待绑定',
        ready: wardrobe.ready === true,
        shortHash: shortHash(wardrobe.sha256),
      },
    }
  })
  return {
    versionId: Number(plan?.version_id) || null,
    ready: plan?.ready === true,
    planHash: normalizeHash(plan?.plan_hash),
    missing: Array.isArray(plan?.missing) ? plan.missing.map(normalizeText).filter(Boolean) : [],
    characters,
  }
}
