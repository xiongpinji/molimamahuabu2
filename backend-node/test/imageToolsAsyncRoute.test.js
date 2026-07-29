const test = require('node:test');
const assert = require('node:assert/strict');

const imageToolService = require('../src/services/imageToolService');
const imageToolBilling = require('../src/services/imageToolBillingService');
const createImageToolRoutes = require('../src/routes/imageTools');

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test('远程图片工具立即返回 202，处理器在后台继续完成', async (t) => {
  const originalCreateOperation = imageToolService.createOperation;
  let finishOperation;
  let operationFinished = false;
  imageToolService.createOperation = (_db, _log, request, context) => {
    context.onTaskCreated({ id: 'image-task-1' });
    return new Promise((resolve) => {
      finishOperation = () => {
        operationFinished = true;
        resolve({
          taskId: 'image-task-1',
          status: 'success',
          operation: request.operation,
          resultAssetId: 2,
          resultUrl: '/static/result.png',
        });
      };
    });
  };
  t.after(() => {
    imageToolService.createOperation = originalCreateOperation;
  });

  const handlers = createImageToolRoutes(
    {},
    { info() {}, warn() {}, error() {} },
    {
      backgroundOperations: true,
      referenceImageTool: {
        engine: 'provider-image-edit',
        provider: 'aihubcc',
        protocol: 'aihubcc',
        model: 'gpt-image-2-3.5k',
        operations: ['outpaint'],
        async generate() {},
      },
    },
  );
  const res = responseRecorder();

  await handlers.createOperation({
    body: {
      assetId: 1,
      sourceNodeId: 'image-node-1',
      operation: 'outpaint',
      parameters: {},
    },
  }, res);

  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.payload.data, {
    taskId: 'image-task-1',
    status: 'processing',
    operation: 'outpaint',
  });
  assert.equal(operationFinished, false);

  finishOperation();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(operationFinished, true);
});

test('远程图片工具失败后在后台结算预扣并保留任务关联', async (t) => {
  const originals = {
    createOperation: imageToolService.createOperation,
    availability: imageToolBilling.availability,
    begin: imageToolBilling.begin,
    settle: imageToolBilling.settle,
  };
  let rejectOperation;
  const settlements = [];
  const taskLinks = [];
  const referenceImageTool = {
    engine: 'provider-image-edit',
    provider: 'aihubcc',
    protocol: 'aihubcc',
    model: 'gpt-image-2-3.5k',
    operations: ['outpaint'],
    async generate() {},
  };
  imageToolBilling.availability = () => ({ tool: referenceImageTool });
  imageToolBilling.begin = () => ({
    reservationId: 'reservation-1',
    model: 'gpt-image-2-3.5k',
    operation: 'outpaint',
    resourceId: '1',
  });
  imageToolBilling.settle = (_db, _log, billing, outcome, message) => {
    settlements.push({ billing, outcome, message });
  };
  imageToolService.createOperation = (_db, _log, _request, context) => {
    context.onTaskCreated({ id: 'image-task-failed' });
    return new Promise((_resolve, reject) => {
      rejectOperation = reject;
    });
  };
  t.after(() => {
    imageToolService.createOperation = originals.createOperation;
    imageToolBilling.availability = originals.availability;
    imageToolBilling.begin = originals.begin;
    imageToolBilling.settle = originals.settle;
  });

  const db = {
    prepare() {
      return {
        run(reservationId, model, taskId) {
          taskLinks.push({ reservationId, model, taskId });
        },
      };
    },
  };
  const handlers = createImageToolRoutes(
    db,
    { info() {}, warn() {}, error() {} },
    {
      backgroundOperations: true,
      publicPlatformEnabled: true,
      referenceImageTool,
    },
  );
  const res = responseRecorder();

  await handlers.createOperation({
    tenant: { id: 'tenant-1' },
    user: { id: 'user-1' },
    body: {
      assetId: 1,
      sourceNodeId: 'image-node-1',
      operation: 'outpaint',
      parameters: {},
    },
  }, res);

  assert.equal(res.statusCode, 202);
  assert.deepEqual(taskLinks, [{
    reservationId: 'reservation-1',
    model: 'gpt-image-2-3.5k',
    taskId: 'image-task-failed',
  }]);
  assert.deepEqual(settlements, []);

  rejectOperation(new Error('provider failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].outcome, 'failed');
  assert.equal(settlements[0].message, 'provider failed');
});
