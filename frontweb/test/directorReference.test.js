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

test('director reference analysis persists running, completed, and failed asset metadata', () => {
  assert.match(stageSource, /uploadAPI\.uploadImage\(file,\s*\{\s*dramaId\s*\}\)/);
  assert.match(stageSource, /assetsAPI\.create\(\{[\s\S]*category:\s*'director-ai-reference'[\s\S]*metadata:\s*\{[\s\S]*status:\s*'running'[\s\S]*source:\s*'director_reference_analysis'[\s\S]*mode:\s*directorReferenceMode\.value/);
  assert.match(stageSource, /directorReferenceAPI\.analyze\(dramaId,\s*\{\s*image_url:\s*imageUrl\s*\}\)/);
  assert.match(stageSource, /assetsAPI\.update\(referenceAsset\.id,\s*\{\s*metadata:\s*\{[\s\S]*status:\s*'completed'[\s\S]*source:\s*DIRECTOR_REFERENCE_SOURCE[\s\S]*mode:\s*referenceMode[\s\S]*analysis[\s\S]*model/);
  assert.match(stageSource, /assetsAPI\.update\(referenceAsset\.id,\s*\{\s*metadata:\s*\{[\s\S]*status:\s*'failed'[\s\S]*source:\s*DIRECTOR_REFERENCE_SOURCE[\s\S]*mode:\s*referenceMode[\s\S]*error:/);
});

test('director reference history reloads only completed metadata analysis assets and applies through mutateTimeline', () => {
  assert.match(stageSource, /async function loadDirectorReferenceHistory\(\)/);
  assert.match(stageSource, /assetsAPI\.list\(\{\s*drama_id:\s*dramaId,\s*type:\s*'image',\s*category:\s*'director-ai-reference',\s*page_size:\s*100\s*\}\)/);
  assert.match(stageSource, /asset\?\.metadata\?\.status === 'completed'[\s\S]*asset\?\.metadata\?\.source === DIRECTOR_REFERENCE_SOURCE[\s\S]*asset\?\.metadata\?\.analysis/);
  assert.match(stageSource, /@click="selectDirectorReferenceHistory\(item\)"/);
  assert.match(stageSource, /directorReferenceAnalysis\.value = item\.metadata\.analysis/);
  assert.match(stageSource, /if \(open\) void loadDirectorReferenceHistory\(\)/);
  assert.match(stageSource, /function applyDirectorReference\(\)[\s\S]*applyDirectorReferenceAnalysis\(timeline\.value,\s*directorReferenceAnalysis\.value,\s*directorReferenceMode\.value\)[\s\S]*mutateTimeline\(next\)/);
});
