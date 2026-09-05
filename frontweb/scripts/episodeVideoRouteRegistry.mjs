const common = Object.freeze({
  resolution: '480p',
  aspect_ratio: '9:16',
  duration_seconds: 5,
  gate_unit_id: 'shot-01.part-01',
  requires_reference_transport: true,
})

function route(value) {
  return Object.freeze({ ...common, ...value })
}

export const EPISODE_VIDEO_ROUTES = Object.freeze([
  route({
    id: 'fumin-fast',
    provider: 'fumin',
    model: 'fumin-seedance-2.0-fast',
    provider_model: 'seedance-2.0-fast',
    key_id: 'fumin',
    output_audio_contract: 'explicit',
  }),
  route({
    id: 'toapis-fast',
    provider: 'toapis',
    model: 'seedance-2-fast',
    provider_model: 'seedance-2-fast',
    key_id: 'toapis',
    output_audio_contract: 'explicit',
  }),
  route({
    id: 'toapis-wan3',
    provider: 'toapis-wan3',
    model: 'wan3.0-video',
    provider_model: 'wan3.0-video',
    key_id: 'toapis',
    output_audio_contract: 'explicit',
  }),
  route({
    id: 'feituo-seedance-2.5',
    provider: 'feituo',
    model: 'xuan-seedance-2.5',
    provider_model: 'xuan-seedance-2.5',
    key_id: 'feituo',
    output_audio_contract: 'artifact-required',
  }),
])

export function episodeVideoRoute(id) {
  const found = EPISODE_VIDEO_ROUTES.find((item) => item.id === id)
  if (!found) throw new Error(`REDRAW_EPISODE_VIDEO_ROUTE_NOT_APPROVED: ${id}`)
  return found
}
