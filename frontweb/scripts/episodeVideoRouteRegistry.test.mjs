import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EPISODE_VIDEO_ROUTES,
  episodeVideoRoute,
} from './episodeVideoRouteRegistry.mjs'

test('episode video fallback routes are immutable and locked in approved order', () => {
  assert.deepEqual(
    EPISODE_VIDEO_ROUTES.map(({ id, provider, model }) => ({ id, provider, model })),
    [
      { id: 'fumin-fast', provider: 'fumin', model: 'fumin-seedance-2.0-fast' },
      { id: 'toapis-fast', provider: 'toapis', model: 'seedance-2-fast' },
      { id: 'toapis-wan3', provider: 'toapis-wan3', model: 'wan3.0-video' },
      { id: 'feituo-seedance-2.5', provider: 'feituo', model: 'xuan-seedance-2.5' },
    ],
  )
  assert.equal(Object.isFrozen(EPISODE_VIDEO_ROUTES), true)
  assert.equal(EPISODE_VIDEO_ROUTES.every(Object.isFrozen), true)
})

test('every route is locked to the full-episode media contract', () => {
  for (const route of EPISODE_VIDEO_ROUTES) {
    assert.equal(route.resolution, '480p')
    assert.equal(route.aspect_ratio, '9:16')
    assert.equal(route.duration_seconds, 5)
    assert.equal(route.gate_unit_id, 'shot-01.part-01')
    assert.equal(route.requires_reference_transport, true)
  }
  assert.deepEqual(
    EPISODE_VIDEO_ROUTES.map((route) => route.output_audio_contract),
    ['explicit', 'explicit', 'explicit', 'artifact-required'],
  )
})

test('route lookup rejects unapproved dynamic models', () => {
  assert.equal(episodeVideoRoute('toapis-fast'), EPISODE_VIDEO_ROUTES[1])
  assert.throws(
    () => episodeVideoRoute('seedance-2-mini'),
    /REDRAW_EPISODE_VIDEO_ROUTE_NOT_APPROVED/u,
  )
})
