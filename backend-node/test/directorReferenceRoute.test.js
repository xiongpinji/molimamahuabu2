const test = require('node:test');
const assert = require('node:assert/strict');

const routes = require('../src/routes/directorReference');

function createResponse() {
  return {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('validates drama id and image reference before billing', async () => {
  const billingCalls = [];
  const handlers = routes(null, { error() {} }, {
    billingEnabled: true,
    billing: { begin: () => billingCalls.push('begin') },
  });
  const res = createResponse();

  await handlers.analyze({ params: { id: 'bad' }, body: { image_url: '' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(billingCalls.length, 0);
});

test('settles completed director reference analysis with audit-friendly resource semantics', async () => {
  const events = [];
  const handlers = routes({ db: true }, { error() {} }, {
    billingEnabled: true,
    service: {
      analyzeDirectorReference: async (_db, _log, imageUrl, model) => ({
        imageUrl,
        model,
        people: [{ name: '甲' }],
        props: [],
        cameras: [],
      }),
    },
    billing: {
      begin(_db, input) {
        events.push(['begin', input]);
        return { model: 'mock-model', reservationId: 'r1', operation: input.operation, resourceType: input.resourceType, resourceId: String(input.resourceId) };
      },
      settle(_db, _log, billing, outcome) {
        events.push(['settle', billing, outcome]);
      },
      respondError() {
        return false;
      },
    },
  });
  const res = createResponse();

  await handlers.analyze({
    params: { id: '42' },
    body: { image_url: 'data:image/png;base64,abc', model: 'mock-model' },
    tenant: { id: 'tenant-1' },
    user: { id: 'user-1' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.model, 'mock-model');
  assert.equal(events[0][1].sceneKey, 'director_reference');
  assert.equal(events[0][1].resourceType, 'director_reference');
  assert.equal(events[0][1].operation, 'director_reference_analysis');
  assert.equal(events[1][2], 'completed');
});

test('settles failed analysis and returns upstream error message', async () => {
  const outcomes = [];
  const handlers = routes(null, { error() {} }, {
    billingEnabled: false,
    service: {
      analyzeDirectorReference: async () => {
        throw new Error('mock provider rejected request');
      },
    },
    billing: {
      begin() {
        return { model: null };
      },
      settle(_db, _log, _billing, outcome, message) {
        outcomes.push([outcome, message]);
      },
      respondError() {
        return false;
      },
    },
  });
  const res = createResponse();

  await handlers.analyze({ params: { id: '5' }, body: { image_url: 'https://cdn.example/ref.png' } }, res);

  assert.equal(res.statusCode, 502);
  assert.match(res.body.error.message, /mock provider rejected request/);
  assert.deepEqual(outcomes, [['failed', 'mock provider rejected request']]);
});
