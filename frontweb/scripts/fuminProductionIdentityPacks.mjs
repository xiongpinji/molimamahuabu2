import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MANIFEST_NAME = 'production-identity-pack-manifest.json'
const HEX_64 = /^[a-f0-9]{64}$/
const REQUIRED_VIEWS = ['front', 'profile', 'full_body']

function fail(code, message = code) {
  throw Object.assign(new Error(`${code}: ${message}`), { code })
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes.subarray(1, 4).toString('ascii') !== 'PNG') {
    fail('FUMIN_PRODUCTION_IDENTITY_PACK_ARTIFACT_INVALID')
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function packFingerprint(pack) {
  return sha256(JSON.stringify({
    schema_version: pack.schema_version,
    source_character_key: pack.source_character_key,
    target_actor_label: pack.target_actor_label,
    artifact: {
      sha256: pack.artifact.sha256,
      width: pack.artifact.width,
      height: pack.artifact.height,
      mime_type: pack.artifact.mime_type,
    },
    confirmed_views: pack.confirmed_views,
    live_action_human_confirmed: pack.live_action_human_confirmed,
    adult_status: pack.adult_status,
    identity_consistency_confirmed: pack.identity_consistency_confirmed,
    persona_origin: pack.persona_origin,
    target_country: pack.target_country,
  }))
}

export function loadProductionIdentityPacks(root, testCase) {
  const manifestPath = path.join(root, MANIFEST_NAME)
  if (!fs.existsSync(manifestPath)) fail('FUMIN_PRODUCTION_IDENTITY_PACK_MANIFEST_MISSING')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.schema_version !== 'redraw-production-identity-pack-set-v1'
    || manifest.case_id !== testCase?.id
    || manifest.review_status !== 'approved'
    || !manifest.reviewed_by
    || !Number.isFinite(Date.parse(manifest.reviewed_at))
    || !Array.isArray(manifest.characters)
    || manifest.characters.length !== testCase?.cast?.length) {
    fail('FUMIN_PRODUCTION_IDENTITY_PACK_SET_NOT_APPROVED')
  }
  return testCase.cast.map((actor, index) => {
    const pack = manifest.characters[index]
    const artifact = pack?.artifact
    if (pack?.schema_version !== 'target-actor-identity-v1'
      || pack.source_character_key !== actor.id
      || pack.target_actor_label !== actor.target_name
      || pack.live_action_human_confirmed !== true
      || pack.adult_status !== 'verified_18_plus'
      || pack.identity_consistency_confirmed !== true
      || pack.persona_origin !== 'fictional_ai_generated'
      || pack.target_country !== 'US'
      || pack.ready !== true
      || JSON.stringify(pack.confirmed_views) !== JSON.stringify(REQUIRED_VIEWS)
      || artifact?.mime_type !== 'image/png'
      || path.basename(String(artifact?.artifact_id || '')) !== artifact?.artifact_id
      || !HEX_64.test(String(artifact?.sha256 || ''))) {
      fail('FUMIN_PRODUCTION_IDENTITY_PACK_INVALID', actor.id)
    }
    const artifactPath = path.join(root, artifact.artifact_id)
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
      fail('FUMIN_PRODUCTION_IDENTITY_PACK_ARTIFACT_MISSING', actor.id)
    }
    const bytes = fs.readFileSync(artifactPath)
    const dimensions = pngDimensions(bytes)
    if (sha256(bytes) !== artifact.sha256
      || dimensions.width !== artifact.width
      || dimensions.height !== artifact.height) {
      fail('FUMIN_PRODUCTION_IDENTITY_PACK_ARTIFACT_DRIFT', actor.id)
    }
    return {
      ...pack,
      artifact: { ...artifact, path: artifactPath, bytes: bytes.length },
      pack_sha256: packFingerprint(pack),
      review_status: 'approved',
      reviewed_by: manifest.reviewed_by,
      reviewed_at: manifest.reviewed_at,
    }
  })
}

const SHOT_CAST = Object.freeze({
  'shot-1': ['mateo', 'diego', 'lucas'],
  'shot-2': ['mateo', 'lucas'],
  'shot-3': ['mateo'],
  'shot-4': ['mateo'],
  'shot-5': ['mateo'],
  'shot-6': ['mateo', 'elena', 'rafael'],
  'shot-7': ['mateo'],
  'shot-8': ['mateo'],
  'shot-9': ['mateo'],
})

export function shotCharacterIds(testCase, shotNumber) {
  const shot = testCase?.sourceFacts?.shots?.[Number(shotNumber) - 1]
  const ids = SHOT_CAST[shot?.id]
  if (!ids || ids.some((id) => !testCase.cast.some((actor) => actor.id === id))) {
    fail('FUMIN_PRODUCTION_IDENTITY_SHOT_CAST_INVALID', String(shotNumber))
  }
  return [...ids]
}

