'use strict';

const RESOURCE_TYPES = new Set(['project', 'version', 'shot', 'asset', 'candidate', 'release']);
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FORMAT_OR_CONTROL = /[\p{Cf}\p{Cc}]/gu;
const URL_VALUE = /\b(?:https?:\/\/|file:\/\/)/i;
const ABSOLUTE_PATH_VALUE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;
const SENSITIVE_VALUE_COMPACT = ['authorization', 'apikey', 'token', 'secret', 'password', 'credential', 'bearer', 'providerresponse'];
const SENSITIVE_KEY_TOKENS = new Set(['token', 'secret', 'password', 'credential', 'bearer', 'url', 'path']);

function invalid(message) {
  const error = new Error(message);
  error.code = 'REDRAW_WORKFLOW_EVENT_INVALID';
  return error;
}

function normalizeForScan(value) {
  return String(value).normalize('NFKC').replace(FORMAT_OR_CONTROL, '');
}

function keyTokens(value) {
  return normalizeForScan(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function assertSafeKey(value) {
  const tokens = keyTokens(value);
  const compact = tokens.join('');
  if (['raw', 'rawresponse', 'responsebody', 'providerresponse'].includes(compact)) {
    throw invalid('workflow event metadata contains sensitive key');
  }
  if (compact === 'apikey' || tokens.some((token) => SENSITIVE_KEY_TOKENS.has(token))) {
    throw invalid('workflow event metadata contains sensitive key');
  }
  if (tokens[0] === 'auth' || tokens[0] === 'authorization') {
    throw invalid('workflow event metadata contains sensitive key');
  }
}

function assertNoSensitiveText(value, label) {
  const normalized = normalizeForScan(value);
  if (label === 'key') {
    assertSafeKey(value);
  }
  const compact = normalized.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_VALUE_COMPACT.some((term) => compact.includes(term))) {
    throw invalid(`workflow event metadata contains sensitive ${label}`);
  }
  if (URL_VALUE.test(normalized) || ABSOLUTE_PATH_VALUE.test(normalized.trim())) {
    throw invalid(`workflow event metadata contains sensitive ${label}`);
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeMetadataValue(value, seen) {
  if (value == null) return null;
  const type = typeof value;
  if (type === 'string') {
    assertNoSensitiveText(value, 'value');
    return value;
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) throw invalid('workflow event metadata number invalid');
    return value;
  }
  if (type === 'boolean') return value;
  if (type === 'function' || type === 'symbol' || type === 'bigint' || type === 'undefined') {
    throw invalid('workflow event metadata type invalid');
  }
  if (seen.has(value)) throw invalid('workflow event metadata is not serializable');
  if (Buffer.isBuffer(value)
    || value instanceof ArrayBuffer
    || ArrayBuffer.isView(value)
    || value instanceof Date
    || value instanceof Map
    || value instanceof Set) {
    throw invalid('workflow event metadata type invalid');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => assertSafeMetadataValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!isPlainObject(value)) throw invalid('workflow event metadata type invalid');
  const result = {};
  for (const key of Object.keys(value)) {
    assertNoSensitiveText(key, 'key');
    result[key] = assertSafeMetadataValue(value[key], seen);
  }
  seen.delete(value);
  return result;
}

function assertSafeMetadata(value) {
  if (value == null) return {};
  const metadata = assertSafeMetadataValue(value, new WeakSet());
  if (!isPlainObject(metadata)) throw invalid('workflow event metadata must be an object');
  return metadata;
}

function normalizeEventInput(input = {}) {
  const resourceType = String(input.resourceType || '').trim();
  if (!RESOURCE_TYPES.has(resourceType)) throw invalid('workflow event resource_type invalid');
  const reasonCode = String(input.reasonCode || '').trim();
  if (!REASON_CODE.test(reasonCode)) throw invalid('workflow event reason_code invalid');
  const evidenceHash = input.evidenceHash == null || input.evidenceHash === ''
    ? null
    : String(input.evidenceHash).trim();
  if (evidenceHash != null && !SHA256.test(evidenceHash)) {
    throw invalid('workflow event evidence_hash invalid');
  }
  const metadata = assertSafeMetadata(input.metadata || {});
  return {
    tenantId: String(input.tenantId || ''),
    userId: String(input.userId || ''),
    projectId: Number(input.projectId),
    resourceType,
    resourceId: String(input.resourceId || ''),
    fromState: input.fromState == null ? null : String(input.fromState),
    toState: String(input.toState || ''),
    reasonCode,
    evidenceHash,
    metadata,
    createdAt: String(input.createdAt || new Date().toISOString()),
  };
}

function appendWorkflowEvent(db, input = {}) {
  const event = normalizeEventInput(input);
  if (!event.tenantId || !event.userId || !Number.isInteger(event.projectId) || event.projectId <= 0
    || !event.resourceId || !event.toState || !event.createdAt) {
    throw invalid('workflow event required fields missing');
  }
  const result = db.prepare(`
    INSERT INTO redraw_workflow_events
      (tenant_id, user_id, project_id, resource_type, resource_id, from_state, to_state,
       reason_code, evidence_hash, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.tenantId,
    event.userId,
    event.projectId,
    event.resourceType,
    event.resourceId,
    event.fromState,
    event.toState,
    event.reasonCode,
    event.evidenceHash,
    JSON.stringify(event.metadata),
    event.createdAt,
  );
  return result.lastInsertRowid;
}

function mapEvent(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    from_state: row.from_state,
    to_state: row.to_state,
    reason_code: row.reason_code,
    evidence_hash: row.evidence_hash,
    created_at: row.created_at,
  };
}

function listProjectWorkflowEvents(db, input = {}) {
  const tenantId = String(input.tenantId || '');
  const userId = String(input.userId || '');
  const projectId = Number(input.projectId);
  if (!tenantId || !userId || !Number.isInteger(projectId) || projectId <= 0) return [];
  return db.prepare(`
    SELECT e.id, e.project_id, e.resource_type, e.resource_id, e.from_state, e.to_state,
           e.reason_code, e.evidence_hash, e.created_at
    FROM redraw_workflow_events e
    JOIN redraw_projects p
      ON p.id = e.project_id
     AND p.tenant_id = e.tenant_id
     AND p.user_id = e.user_id
     AND p.deleted_at IS NULL
    WHERE e.tenant_id = ?
      AND e.user_id = ?
      AND e.project_id = ?
    ORDER BY e.id ASC
  `).all(tenantId, userId, projectId).map(mapEvent);
}

module.exports = {
  appendWorkflowEvent,
  listProjectWorkflowEvents,
};
