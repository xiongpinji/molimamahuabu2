'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CONTRACT,
  auditCanvasReferenceSequenceContract,
} = require('../scripts/verify-canvas-reference-sequence-contract');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const protectedFiles = [
  'frontweb/src/utils/freeCanvasGeneration.js',
  'frontweb/src/views/DramaCanvas.vue',
  'frontweb/src/views/HomeCanvas.vue',
  'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue',
];

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-reference-sequence-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relativePath of protectedFiles) {
    const target = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, ...relativePath.split('/')), target);
  }
  return root;
}

test('当前源码满足 canvas-reference-numbered-mentions-v1', () => {
  const report = auditCanvasReferenceSequenceContract({ releaseRoot: repositoryRoot });

  assert.equal(CONTRACT, 'canvas-reference-numbered-mentions-v1');
  assert.equal(report.ready, true);
  assert.equal(report.contract, CONTRACT);
  assert.deepEqual(report.protectedFiles, protectedFiles);
});

test('门禁拒绝删除统一的图片序号和 mention token 构造', (t) => {
  const root = createFixture(t);
  const target = path.join(root, 'frontweb/src/utils/freeCanvasGeneration.js');
  const source = fs.readFileSync(target, 'utf8')
    .replace('mentionToken: `@图片${index + 1}`', 'mentionToken: `@${reference.title}`');
  fs.writeFileSync(target, source);

  assert.throws(
    () => auditCanvasReferenceSequenceContract({ releaseRoot: root }),
    (error) => error.code === 'PROTECTED_REFERENCE_SEQUENCE_CONTRACT_FAILED'
      && error.message.includes('mention token'),
  );
});

test('门禁拒绝编辑器退回 @原始图片标题', (t) => {
  const root = createFixture(t);
  const target = path.join(root, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue');
  const source = fs.readFileSync(target, 'utf8')
    .replace('${mentionToken} ', '@${candidate.title} ');
  fs.writeFileSync(target, source);

  assert.throws(
    () => auditCanvasReferenceSequenceContract({ releaseRoot: root }),
    (error) => error.code === 'PROTECTED_REFERENCE_SEQUENCE_CONTRACT_FAILED'
      && error.message.includes('原始标题'),
  );
});

test('门禁拒绝任一画布入口绕过统一候选构造器', (t) => {
  const root = createFixture(t);
  const target = path.join(root, 'frontweb/src/views/HomeCanvas.vue');
  const source = fs.readFileSync(target, 'utf8')
    .replace('return buildFreeCanvasReferenceMentionCandidates(', 'return (');
  fs.writeFileSync(target, source);

  assert.throws(
    () => auditCanvasReferenceSequenceContract({ releaseRoot: root }),
    (error) => error.code === 'PROTECTED_REFERENCE_SEQUENCE_CONTRACT_FAILED'
      && error.message.includes('HomeCanvas.vue'),
  );
});

test('门禁拒绝视频节点为模型未采用的参考图生成 mention token', (t) => {
  const root = createFixture(t);
  const target = path.join(root, 'frontweb/src/views/DramaCanvas.vue');
  const source = fs.readFileSync(target, 'utf8')
    .replace('buildFreeCanvasReferenceMentionCandidates(\n    adoptedReferences(', 'buildFreeCanvasReferenceMentionCandidates(\n    ((references) => references)(');
  fs.writeFileSync(target, source);

  assert.throws(
    () => auditCanvasReferenceSequenceContract({ releaseRoot: root }),
    (error) => error.code === 'PROTECTED_REFERENCE_SEQUENCE_CONTRACT_FAILED'
      && error.message.includes('实际采用'),
  );
});
