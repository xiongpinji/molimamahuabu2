import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { redrawLatinAmericanCase } from '../e2e/fixtures/redraw-latin-american-case.js'
import {
  loadProductionIdentityPacks,
  shotCharacterIds,
} from './fuminProductionIdentityPacks.mjs'

function identityFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-identity-packs-'))
  const characters = redrawLatinAmericanCase.cast.map((actor, index) => {
    const bytes = Buffer.alloc(24)
    bytes.write('PNG', 1, 'ascii')
    bytes.writeUInt32BE(1536 + index, 16)
    bytes.writeUInt32BE(1024 + index, 20)
    const artifactId = `${actor.id}-v1.png`
    fs.writeFileSync(path.join(root, artifactId), bytes)
    return {
      schema_version: 'target-actor-identity-v1',
      source_character_key: actor.id,
      target_actor_label: actor.target_name,
      artifact: {
        artifact_id: artifactId,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        width: 1536 + index,
        height: 1024 + index,
        mime_type: 'image/png',
      },
      confirmed_views: ['front', 'profile', 'full_body'],
      live_action_human_confirmed: true,
      adult_status: 'verified_18_plus',
      identity_consistency_confirmed: true,
      persona_origin: 'fictional_ai_generated',
      target_country: 'US',
      ready: true,
    }
  })
  fs.writeFileSync(path.join(root, 'production-identity-pack-manifest.json'), JSON.stringify({
    schema_version: 'redraw-production-identity-pack-set-v1',
    case_id: redrawLatinAmericanCase.id,
    review_status: 'approved',
    reviewed_by: 'fixture-reviewer',
    reviewed_at: '2026-08-25T02:28:00.000Z',
    characters,
  }))
  return root
}

test('五名角色逐人三视图身份包通过文件哈希、角色映射和人工审核门禁', () => {
  const root = identityFixture()
  try {
    const packs = loadProductionIdentityPacks(root, redrawLatinAmericanCase)
    assert.deepEqual(packs.map((pack) => pack.source_character_key), [
      'mateo', 'diego', 'lucas', 'elena', 'rafael',
    ])
    assert.ok(packs.every((pack) => (
      pack.schema_version === 'target-actor-identity-v1'
        && pack.pack_sha256.length === 64
        && pack.artifact.sha256.length === 64
        && pack.confirmed_views.join(',') === 'front,profile,full_body'
        && pack.persona_origin === 'fictional_ai_generated'
        && pack.target_country === 'US'
        && pack.adult_status === 'verified_18_plus'
        && pack.ready === true
    )))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('每镜只投影该镜实际出现的角色身份图', () => {
  assert.deepEqual(shotCharacterIds(redrawLatinAmericanCase, 1), ['mateo', 'diego', 'lucas'])
  assert.deepEqual(shotCharacterIds(redrawLatinAmericanCase, 3), ['mateo'])
  assert.deepEqual(shotCharacterIds(redrawLatinAmericanCase, 6), ['mateo', 'elena', 'rafael'])
  assert.deepEqual(shotCharacterIds(redrawLatinAmericanCase, 8), ['mateo'])
})

test('群体选角示意图不能替代五个逐角色正式身份包', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fumin-identity-reject-'))
  try {
    assert.throws(
      () => loadProductionIdentityPacks(root, redrawLatinAmericanCase),
      /FUMIN_PRODUCTION_IDENTITY_PACK_MANIFEST_MISSING/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
