const TRANSPORT_NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

const PROVIDER_UNAVAILABLE_CODES = new Set([
  'NO_AVAILABLE_CHANNEL',
  'CHANNEL_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
]);

const RATE_LIMIT_CODES = new Set([
  'RATE_LIMITED',
  'RATE_LIMIT_EXCEEDED',
  'TOO_MANY_REQUESTS',
]);

const AUTH_UNAVAILABLE_CODES = new Set([
  'AUTH_INVALID',
  'INVALID_API_KEY',
  'INSUFFICIENT_BALANCE',
  'QUOTA_EXHAUSTED',
]);

const POLICY_CODES = new Set([
  'CONTENT_POLICY',
  'CONTENT_SAFETY',
  'SAFETY_REJECTED',
]);

const VALIDATION_CODES = new Set([
  'INVALID_ARGUMENT',
  'BAD_REQUEST',
  'UNSUPPORTED_CAPABILITY',
]);

const SAFE_CATEGORIES = new Set([
  'artifact_unreadable',
  'auth_unavailable',
  'forbidden_unknown',
  'policy_rejected',
  'provider_unavailable',
  'rate_limited',
  'result_unknown',
  'submission_unknown',
  'transport_not_sent',
  'validation_error',
]);

function decision(category, options = {}) {
  return {
    category,
    definitiveNotAccepted: Boolean(options.definitiveNotAccepted),
    affectsHealth: Boolean(options.affectsHealth),
    mayFailover: Boolean(options.mayFailover),
    disableConfig: Boolean(options.disableConfig),
  };
}

function normalizedCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function isInfrastructureStatus(status) {
  return status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
}

function classifyProviderFailure(meta = {}) {
  const httpStatus = Number.isInteger(meta.httpStatus) ? meta.httpStatus : null;
  const providerCode = normalizedCode(meta.providerCode);
  const transportCode = normalizedCode(meta.transportCode);
  const hasProviderTask = String(meta.providerTaskId || '').trim().length > 0;

  if (httpStatus != null && httpStatus >= 200 && httpStatus < 300 && meta.artifactReadable === false) {
    return decision('artifact_unreadable', { affectsHealth: true });
  }

  if (hasProviderTask) {
    return decision('result_unknown', {
      affectsHealth: isInfrastructureStatus(httpStatus) || Boolean(transportCode),
    });
  }

  if (POLICY_CODES.has(providerCode)) {
    return decision('policy_rejected', { definitiveNotAccepted: true });
  }

  if (VALIDATION_CODES.has(providerCode) || [400, 413, 422].includes(httpStatus)) {
    return decision('validation_error', { definitiveNotAccepted: true });
  }

  if (
    httpStatus === 401
    || (AUTH_UNAVAILABLE_CODES.has(providerCode) && meta.explicitlyRejected === true)
  ) {
    return decision('auth_unavailable', {
      definitiveNotAccepted: true,
      affectsHealth: true,
      mayFailover: true,
      disableConfig: true,
    });
  }

  if (PROVIDER_UNAVAILABLE_CODES.has(providerCode)) {
    return decision('provider_unavailable', {
      definitiveNotAccepted: true,
      affectsHealth: true,
      mayFailover: true,
    });
  }

  if (RATE_LIMIT_CODES.has(providerCode) || httpStatus === 429) {
    return decision('rate_limited', {
      definitiveNotAccepted: true,
      affectsHealth: true,
      mayFailover: true,
    });
  }

  if (
    meta.phase === 'connect'
    && meta.requestBodySent === false
    && TRANSPORT_NOT_SENT_CODES.has(transportCode)
  ) {
    return decision('transport_not_sent', {
      definitiveNotAccepted: true,
      affectsHealth: true,
      mayFailover: true,
    });
  }

  if (httpStatus === 403) {
    return decision('forbidden_unknown');
  }

  if (httpStatus != null && httpStatus >= 500 && httpStatus <= 599) {
    if (meta.explicitlyRejected === true) {
      return decision('provider_unavailable', {
        definitiveNotAccepted: true,
        affectsHealth: true,
        mayFailover: true,
      });
    }
    return decision('submission_unknown', { affectsHealth: true });
  }

  return decision('submission_unknown', {
    affectsHealth: Boolean(transportCode),
  });
}

function safeToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token || token.length > 80) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(token)) return '';
  if (/^(?:sk-|bearer)/i.test(token)) return '';
  return token;
}

function toSafeErrorSummary(meta = {}) {
  const parts = [];
  const category = safeToken(meta.category);
  if (category && SAFE_CATEGORIES.has(category)) parts.push(`category=${category}`);
  if (Number.isInteger(meta.httpStatus) && meta.httpStatus >= 100 && meta.httpStatus <= 599) {
    parts.push(`status=${meta.httpStatus}`);
  }
  const providerCode = safeToken(meta.providerCode);
  if (providerCode) parts.push(`code=${providerCode}`);
  return parts.join(' ') || 'category=submission_unknown';
}

module.exports = {
  classifyProviderFailure,
  toSafeErrorSummary,
};
