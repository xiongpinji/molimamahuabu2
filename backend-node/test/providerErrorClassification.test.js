const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyProviderFailure,
  toSafeErrorSummary,
} = require('../src/services/providerErrorClassifier');

function assertDecision(input, expected) {
  const actual = classifyProviderFailure(input);
  assert.deepEqual(
    {
      category: actual.category,
      definitiveNotAccepted: actual.definitiveNotAccepted,
      affectsHealth: actual.affectsHealth,
      mayFailover: actual.mayFailover,
      disableConfig: actual.disableConfig,
    },
    { disableConfig: false, ...expected },
  );
}

test('connection failure may fail over only when the adapter proves the body was not sent', () => {
  assertDecision({ phase: 'connect', requestBodySent: false, transportCode: 'ECONNREFUSED' }, {
    category: 'transport_not_sent',
    definitiveNotAccepted: true,
    affectsHealth: true,
    mayFailover: true,
  });
  assertDecision({ phase: 'connect', requestBodySent: true, transportCode: 'ECONNRESET' }, {
    category: 'submission_unknown',
    definitiveNotAccepted: false,
    affectsHealth: true,
    mayFailover: false,
  });
});

test('known no-channel and rate-limit responses may fail over without a provider task', () => {
  assertDecision({ httpStatus: 503, providerCode: 'NO_AVAILABLE_CHANNEL' }, {
    category: 'provider_unavailable',
    definitiveNotAccepted: true,
    affectsHealth: true,
    mayFailover: true,
  });
  assertDecision({ httpStatus: 429 }, {
    category: 'rate_limited',
    definitiveNotAccepted: true,
    affectsHealth: true,
    mayFailover: true,
  });
});

test('generic server errors remain submission-unknown without explicit rejection evidence', () => {
  assertDecision({ httpStatus: 500 }, {
    category: 'submission_unknown',
    definitiveNotAccepted: false,
    affectsHealth: true,
    mayFailover: false,
  });
  assertDecision({ httpStatus: 503, explicitlyRejected: true }, {
    category: 'provider_unavailable',
    definitiveNotAccepted: true,
    affectsHealth: true,
    mayFailover: true,
  });
});

test('policy validation and ambiguous forbidden responses never affect provider health or fail over', () => {
  assertDecision({ httpStatus: 400, providerCode: 'CONTENT_POLICY' }, {
    category: 'policy_rejected',
    definitiveNotAccepted: true,
    affectsHealth: false,
    mayFailover: false,
  });
  assertDecision({ httpStatus: 422, providerCode: 'INVALID_ARGUMENT' }, {
    category: 'validation_error',
    definitiveNotAccepted: true,
    affectsHealth: false,
    mayFailover: false,
  });
  assertDecision({ httpStatus: 403 }, {
    category: 'forbidden_unknown',
    definitiveNotAccepted: false,
    affectsHealth: false,
    mayFailover: false,
  });
});

test('structured authentication failures disable the config and may use a verified backup', () => {
  assertDecision({ httpStatus: 401 }, {
    category: 'auth_unavailable',
    definitiveNotAccepted: true,
    affectsHealth: true,
    mayFailover: true,
    disableConfig: true,
  });
  assertDecision({ httpStatus: 403, providerCode: 'INSUFFICIENT_BALANCE', explicitlyRejected: true }, {
    category: 'auth_unavailable',
    definitiveNotAccepted: true,
    affectsHealth: true,
    mayFailover: true,
    disableConfig: true,
  });
});

test('a provider task id always prevents another submission', () => {
  assertDecision({
    httpStatus: 429,
    providerCode: 'RATE_LIMITED',
    providerTaskId: 'upstream-task-1',
  }, {
    category: 'result_unknown',
    definitiveNotAccepted: false,
    affectsHealth: true,
    mayFailover: false,
  });
});

test('successful protocol responses without a readable artifact require review', () => {
  assertDecision({ httpStatus: 200, artifactReadable: false }, {
    category: 'artifact_unreadable',
    definitiveNotAccepted: false,
    affectsHealth: true,
    mayFailover: false,
  });
});

test('unclassified failures default to submission unknown', () => {
  assertDecision({}, {
    category: 'submission_unknown',
    definitiveNotAccepted: false,
    affectsHealth: false,
    mayFailover: false,
  });
});

test('safe summaries contain classifications but never provider secrets or user content', () => {
  const summary = toSafeErrorSummary({
    category: 'provider_unavailable',
    httpStatus: 503,
    providerCode: 'NO_AVAILABLE_CHANNEL',
    message: 'Bearer secret-token sk-live-secret https://relay.example/result?signature=private',
    prompt: '用户的完整提示词不能写入稳定性日志',
    raw: 'a'.repeat(400),
  });

  assert.equal(summary, 'category=provider_unavailable status=503 code=NO_AVAILABLE_CHANNEL');
  for (const forbidden of ['Bearer', 'sk-live', 'relay.example', 'signature', '完整提示词', 'aaaa']) {
    assert.equal(summary.includes(forbidden), false);
  }
});

test('safe summaries reject unsafe provider codes instead of copying them', () => {
  assert.equal(toSafeErrorSummary({
    category: 'validation_error',
    httpStatus: 400,
    providerCode: 'sk-secret https://relay.example',
  }), 'category=validation_error status=400');
});
