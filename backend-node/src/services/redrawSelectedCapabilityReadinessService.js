'use strict';

const { createHash } = require('node:crypto');
const { stableStringify } = require('./redrawEpisodeFactsService');
const { inspectSelectedCapabilityMetadata } = require('./redrawExecutionPlanPreviewService');
const { resolveVideoProtocol } = require('./videoClient');
const { resolveFuminApiKey, buildFuminCreateUrl, buildFuminQueryUrl, buildFuminUploadUrl } = require('./fuminVideoClient');
const { resolveToapisApiKey, normalizeToapisBaseUrl } = require('./toapisVideoClient');
const { normalizeFeituoBaseUrl, buildFeituoStatusUrl } = require('./feituoVideoClient');
const { resolveTtsConnection } = require('./ttsService');

const hash = (value) => createHash('sha256').update(stableStringify(value)).digest('hex');
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const safeCodes = new Set(['SELECTED_CAPABILITY_INVALID', 'SELECTED_CAPABILITY_STALE',
  'CREDENTIAL_BINDING_NOT_CHECKED', 'SELECTED_TTS_CARRIER_UNSUPPORTED',
  'SELECTED_CONNECTION_UNSUPPORTED', 'SELECTED_CREDENTIAL_MISSING']);

// Connections are read only after metadata/evidence validation. No full settings,
// default selector, config loader, credential registry or provider call is involved.
function connectionRow(db, identity) {
  const row = db.prepare(`SELECT id, provider, api_key, base_url${identity.protocol ? ', api_protocol, endpoint, query_endpoint' : ''}
    FROM ai_service_configs WHERE id = ? AND updated_at = ? AND is_active = 1
      AND deleted_at IS NULL AND COALESCE(canary_paused, 0) = 0`).get(identity.config_id, identity.config_updated_at);
  if (!row || row.provider !== identity.provider) fail('SELECTED_CAPABILITY_STALE');
  return row;
}

function checkedUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) fail('SELECTED_CONNECTION_UNSUPPORTED');
  return url.href;
}

function videoConnection(config, identity, env) {
  if (resolveVideoProtocol(config, identity.model) !== identity.protocol) fail('SELECTED_CAPABILITY_STALE');
  let credential; let urls;
  if (identity.protocol === 'fumin_video') {
    credential = resolveFuminApiKey(config, env);
    urls = { submit: buildFuminCreateUrl(config), query: buildFuminQueryUrl(config, '__redraw_task__'),
      upload: buildFuminUploadUrl(config) };
  } else if (identity.protocol === 'toapis_video') {
    credential = resolveToapisApiKey(config, env);
    const base = normalizeToapisBaseUrl(config.base_url);
    urls = { submit: `${base}/v1/videos/generations`, query: `${base}/v1/videos/generations/__redraw_task__` };
  } else if (identity.protocol === 'feituo_open') {
    credential = config.api_key || '';
    urls = { submit: `${normalizeFeituoBaseUrl(config.base_url)}/api/open/v1/video/generate`,
      query: buildFeituoStatusUrl(config.base_url, '__redraw_task__', 0) };
  } else fail('SELECTED_CONNECTION_UNSUPPORTED');
  return { fingerprint: hash({ urls: Object.fromEntries(Object.entries(urls).map(([key, url]) => [key, checkedUrl(url)])),
    authorization: `Bearer ${credential}` }), presence: String(credential).trim() ? 'present' : 'missing',
  config: { base_url: config.base_url, api_key: credential, endpoint: config.endpoint || '', query_endpoint: config.query_endpoint || '' } };
}

function audioConnection(config) {
  const connection = resolveTtsConnection(config);
  if (!connection) fail('SELECTED_CONNECTION_UNSUPPORTED');
  const present = Boolean(String(config.api_key || '').trim());
  return { fingerprint: hash({ kind: connection.kind, url: checkedUrl(connection.url), authorization: connection.authorization }),
    presence: present ? 'present' : connection.kind === 'minimax' ? 'missing' : 'absent_optional' };
}

// Internal server-to-server result. A ready result is presence/identity evidence only:
// the future claim must recheck owner/plan/materials/price and recompute these private
// fingerprints, then submit with the same effective values. This is not a POST lock.
function inspectSelectedCapabilityReadiness(ctx, selected) {
  const publicReadiness = { schema_version: 'redraw-selected-capability-readiness-v1',
    capability_hash: typeof selected?.capability_hash === 'string' && /^[a-f0-9]{64}$/.test(selected.capability_hash)
      ? selected.capability_hash : null,
    status: 'blocked', reason_codes: [], credential_presence: { video: 'not_checked', audio: 'not_checked' },
    credential_evidence_scope: 'presence_only_not_generation_verified', executable: false };
  let stage = 'metadata';
  try {
    const checked = inspectSelectedCapabilityMetadata(ctx, selected);
    const capability = checked.capability;
    if (checked.audio_identity && checked.audio_identity.service_type !== 'tts') fail('SELECTED_TTS_CARRIER_UNSUPPORTED');
    const videoIdentity = { config_id: capability.config_id, config_updated_at: capability.config_updated_at,
      provider: capability.provider, protocol: capability.protocol, model: capability.model };
    stage = 'connection';
    const video = videoConnection(connectionRow(ctx.db, videoIdentity), videoIdentity, ctx.env ?? process.env);
    publicReadiness.credential_presence.video = video.presence;
    if (video.presence === 'missing') fail('SELECTED_CREDENTIAL_MISSING');
    let audioBinding = null;
    if (checked.audio_identity) {
      const { service_type, ...audioIdentity } = checked.audio_identity;
      const audio = audioConnection(connectionRow(ctx.db, audioIdentity));
      publicReadiness.credential_presence.audio = audio.presence;
      if (audio.presence === 'missing') fail('SELECTED_CREDENTIAL_MISSING');
      audioBinding = { ...audioIdentity, connection_fingerprint: audio.fingerprint };
    } else publicReadiness.credential_presence.audio = 'not_required';
    publicReadiness.status = 'ready';
    return { public_readiness: publicReadiness,
      private_binding: { schema_version: 'redraw-selected-capability-binding-v1', capability_hash: capability.capability_hash,
        video: { ...videoIdentity, connection_fingerprint: video.fingerprint }, audio: audioBinding } };
  } catch (error) {
    publicReadiness.reason_codes = [safeCodes.has(error?.code) ? error.code
      : stage === 'connection' ? 'SELECTED_CONNECTION_UNSUPPORTED' : 'SELECTED_CAPABILITY_CHECK_FAILED'];
    return { public_readiness: publicReadiness };
  }
}

// Server-only credential snapshot: never attach this result to a task or public DTO.
// Reuse the same resolver/fingerprint as readiness, including the effective Key.
function resolveSelectedVideoConnection(ctx, selected) {
  const checked = inspectSelectedCapabilityReadiness(ctx, selected);
  if (checked.public_readiness.status !== 'ready') fail(checked.public_readiness.reason_codes[0]);
  const identity = checked.private_binding.video;
  const connection = videoConnection(connectionRow(ctx.db, identity), identity, ctx.env ?? process.env);
  if (connection.presence !== 'present' || connection.fingerprint !== identity.connection_fingerprint) fail('SELECTED_CAPABILITY_STALE');
  return { protocol: identity.protocol, config: connection.config, binding: checked.private_binding };
}

function resolveSubmittedVideoConnection(ctx, identity) {
  const connection = videoConnection(connectionRow(ctx.db, identity), identity, ctx.env ?? process.env);
  if (connection.presence !== 'present' || connection.fingerprint !== identity.connection_fingerprint) fail('SELECTED_CAPABILITY_STALE');
  return { protocol: identity.protocol, config: connection.config };
}

module.exports = { inspectSelectedCapabilityReadiness, resolveSelectedVideoConnection, resolveSubmittedVideoConnection };
