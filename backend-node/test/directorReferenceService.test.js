const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDirectorReferenceService,
  normalizeDirectorReference,
} = require('../src/services/directorReferenceService');

test('normalizes director reference output and clamps unsafe values', () => {
  const result = normalizeDirectorReference({
    summary: '  构图参考  ',
    people: [{
      name: '主演',
      body_type: 'female',
      color: '#F472B6',
      position: [120, -3, 2],
      rotation_degrees: [0, 180, 'bad'],
      scale: 2,
    }],
    props: [{ name: '桌子', shape: 'sphere', position: [1, 0.4, 3], scale: [2, 0.5, 1] }],
    cameras: [{ name: '低角度', position: [0, 1.2, 5], target: [0, 1, 0], fov: 200, roll: -250 }],
  });

  assert.equal(result.summary, '构图参考');
  assert.deepEqual(result.people[0].position, [50, 0, 2]);
  assert.deepEqual(result.people[0].rotation, [0, Math.PI, 0]);
  assert.deepEqual(result.people[0].scale, [2, 2, 2]);
  assert.equal(result.people[0].color, '#f472b6');
  assert.equal(result.props[0].type, 'sphere');
  assert.equal(result.cameras[0].fov, 100);
  assert.equal(result.cameras[0].roll, -180);
});

test('uses injected vision generator without network side effects', async () => {
  const calls = [];
  const service = createDirectorReferenceService({
    generateTextWithVision: async (...args) => {
      calls.push(args);
      return JSON.stringify({
        people: [{ name: '甲', body_type: 'male', position: [0, 0, 0] }],
      });
    },
  });

  const result = await service.analyzeDirectorReference(
    { db: true },
    { error() {} },
    'data:image/png;base64,abc',
    'mock-vision',
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0][5].imageUrl, 'data:image/png;base64,abc');
  assert.equal(calls[0][6].model, 'mock-vision');
  assert.equal(result.people[0].name, '甲');
});

test('rejects invalid references before invoking the generator', async () => {
  let invoked = false;
  const service = createDirectorReferenceService({
    generateTextWithVision: async () => {
      invoked = true;
      return '{}';
    },
  });

  await assert.rejects(
    () => service.analyzeDirectorReference(null, null, 'file:///tmp/a.png'),
    /HTTP 地址或 PNG\/JPEG\/WebP data URL/,
  );
  assert.equal(invoked, false);
});
