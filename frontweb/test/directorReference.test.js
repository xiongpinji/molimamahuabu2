import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { applyDirectorReferenceAnalysis } from '../src/utils/directorReference.js';

const stageSource = fs.readFileSync(
  path.join(import.meta.dirname, '../src/components/dramaCanvas/CanvasDirectorStage.vue'),
  'utf8',
);
const apiSource = fs.readFileSync(
  path.join(import.meta.dirname, '../src/api/directorReference.js'),
  'utf8',
);

test('director reference API posts to the guarded drama route', () => {
  assert.match(apiSource, /request\.post\(`\/dramas\/\$\{dramaId\}\/director\/reference-analysis`, payload\)/);
});

test('applies director reference analysis without removing existing lights in override mode', () => {
  const next = applyDirectorReferenceAnalysis({
    objects: [
      { id: 'keep-light', type: 'light', name: '主光', light: { type: 'soft' } },
      { id: 'old-prop', type: 'box', name: '旧道具' },
    ],
    cameras: [{ id: 'old-camera', name: '旧机位' }],
  }, {
    people: [{ name: '演员甲', bodyType: 'female', color: '#f472b6', position: [1, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1] }],
    props: [{ name: '桌子', type: 'box', color: '#999999', position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [2, 1, 1] }],
    cameras: [{ name: '正面', position: [0, 1.6, 5], target: [0, 1, 0], fov: 45, roll: 0 }],
  }, 'override');

  assert.equal(next.objects.some((object) => object.id === 'keep-light'), true);
  assert.equal(next.objects.some((object) => object.id === 'old-prop'), false);
  assert.equal(next.objects.some((object) => object.name === '演员甲' && object.type === 'humanoid'), true);
  assert.equal(next.cameras.some((camera) => camera.name === '正面' && camera.lookAtMode === 'manual'), true);
});

test('CanvasDirectorStage exposes AI placement reference through mutateTimeline', () => {
  assert.match(stageSource, /AI站位参考/);
  assert.match(stageSource, /directorReferenceAPI\.analyze/);
  assert.match(stageSource, /applyDirectorReferenceAnalysis\(timeline\.value/);
  assert.match(stageSource, /mutateTimeline\(next\)/);
  assert.doesNotMatch(stageSource, /timeline\.value\s*=\s*applyDirectorReferenceAnalysis/);
});
