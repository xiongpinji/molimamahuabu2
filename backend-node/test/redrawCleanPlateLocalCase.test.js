const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { buildLocalCleanPlateManifest } = require('../src/services/redrawCleanPlateLocalCaseService');

const SHOT_IDS = ['shot-1', 'shot-6', 'shot-7', 'shot-8'];
const IMAGE_WIDTH = 1280;
const IMAGE_HEIGHT = 720;

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function createPng(root, relativePath, width = IMAGE_WIDTH, height = IMAGE_HEIGHT) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: '#808080',
    },
  }).png().toFile(filePath);
  return {
    path: relativePath,
    sha256: sha256File(filePath),
    width,
    height,
    mime_type: 'image/png',
  };
}

function cloneEntries(entries) {
  return structuredClone(entries);
}

async function makeFixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'redraw-clean-plate-case-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));

  const entries = [];
  for (const [index, shotId] of SHOT_IDS.entries()) {
    const directory = `shots/${shotId}`;
    const representativeFrame = await createPng(root, `${directory}/source.png`);
    const mask = await createPng(root, `${directory}/mask.png`);
    const cleanPlate = await createPng(root, `${directory}/clean.png`);
    entries.push({
      shot_id: shotId,
      source_asset_id: 101 + index,
      representative_frame: representativeFrame,
      mask_asset_id: 201 + index,
      mask,
      clean_plate_asset_id: 301 + index,
      clean_plate: cleanPlate,
      target: '人物去除',
      quality: {
        width: IMAGE_WIDTH,
        height: IMAGE_HEIGHT,
        mask_area_changed: true,
        non_mask_similarity: 0.98,
      },
      review: { status: 'approved' },
    });
  }

  return { root, entries };
}

test('四镜 clean-plate manifest 按固定镜头排序并脱敏文件根路径', async (t) => {
  const { root, entries: canonicalEntries } = await makeFixture(t);
  const entries = canonicalEntries.slice().reverse();

  const result = await buildLocalCleanPlateManifest({
    root,
    entries,
    now: '2026-08-13T00:00:00.000Z',
  });

  assert.deepEqual(result.shots.map((shot) => shot.shot_id), SHOT_IDS);
  assert.match(result.shots[0].source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(root), false);
});

test('缺镜头或重复镜头时拒绝生成 clean-plate manifest', async (t) => {
  const { root, entries } = await makeFixture(t);

  await assert.rejects(
    () => buildLocalCleanPlateManifest({ root, entries: entries.slice(0, 3) }),
    { code: 'REDRAW_CLEAN_PLATE_SHOTS_INVALID' },
  );

  const duplicateShotEntries = cloneEntries(entries);
  duplicateShotEntries[3].shot_id = duplicateShotEntries[0].shot_id;
  await assert.rejects(
    () => buildLocalCleanPlateManifest({ root, entries: duplicateShotEntries }),
    { code: 'REDRAW_CLEAN_PLATE_SHOTS_INVALID' },
  );
});

test('绝对路径或 .. 逃逸路径时拒绝生成 clean-plate manifest', async (t) => {
  const { root, entries } = await makeFixture(t);

  const parentEscapeEntries = cloneEntries(entries);
  parentEscapeEntries[0].representative_frame.path = '../outside.png';
  await assert.rejects(
    () => buildLocalCleanPlateManifest({ root, entries: parentEscapeEntries }),
    { code: 'REDRAW_CLEAN_PLATE_PATH_INVALID' },
  );

  const absoluteEscapeEntries = cloneEntries(entries);
  absoluteEscapeEntries[0].representative_frame.path = path.join(root, '..', 'outside.png');
  await assert.rejects(
    () => buildLocalCleanPlateManifest({ root, entries: absoluteEscapeEntries }),
    { code: 'REDRAW_CLEAN_PLATE_PATH_INVALID' },
  );
});

test('源帧哈希漂移时拒绝生成 clean-plate manifest', async (t) => {
  const { root, entries } = await makeFixture(t);
  const wrongHashEntries = cloneEntries(entries);
  wrongHashEntries[0].representative_frame.sha256 = '0'.repeat(64);

  await assert.rejects(
    () => buildLocalCleanPlateManifest({ root, entries: wrongHashEntries }),
    { code: 'REDRAW_CLEAN_PLATE_HASH_MISMATCH' },
  );
});

test('源帧、遮罩和净景尺寸不一致时拒绝生成 clean-plate manifest', async (t) => {
  const { root, entries } = await makeFixture(t);
  const wrongSizeRelativePath = 'shots/shot-6/mask-small.png';
  const wrongSizeEvidence = await createPng(root, wrongSizeRelativePath, 640, IMAGE_HEIGHT);
  const wrongSizeEntries = cloneEntries(entries);
  wrongSizeEntries[1].mask = wrongSizeEvidence;

  await assert.rejects(
    () => buildLocalCleanPlateManifest({ root, entries: wrongSizeEntries }),
    { code: 'REDRAW_CLEAN_PLATE_DIMENSIONS_INVALID' },
  );
});

test('mask_area_changed=false 时拒绝生成 clean-plate manifest', async (t) => {
  const { root, entries } = await makeFixture(t);
  const lowQualityEntries = cloneEntries(entries);
  lowQualityEntries[0].quality.mask_area_changed = false;

  await assert.rejects(
    () => buildLocalCleanPlateManifest({ root, entries: lowQualityEntries }),
    { code: 'REDRAW_CLEAN_PLATE_QUALITY_FAILED' },
  );
});

test('non_mask_similarity 低于 0.97 时拒绝生成 clean-plate manifest', async (t) => {
  const { root, entries } = await makeFixture(t);
  const lowQualityEntries = cloneEntries(entries);
  lowQualityEntries[0].quality.non_mask_similarity = 0.969;

  await assert.rejects(
    () => buildLocalCleanPlateManifest({ root, entries: lowQualityEntries }),
    { code: 'REDRAW_CLEAN_PLATE_QUALITY_FAILED' },
  );
});
