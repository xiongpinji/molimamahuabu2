const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { buildLocalCleanPlateManifest } = require('../src/services/redrawCleanPlateLocalCaseService');
const { main } = require('../scripts/run-redraw-clean-plate-local-case');

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
  for (const shot of result.shots) {
    for (const file of [shot.source, shot.mask, shot.clean_plate]) {
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.equal(file.sha256, sha256File(path.join(root, file.path)));
    }
  }
  assert.equal(JSON.stringify(result).includes(root), false);
});

test('缺镜头或重复镜头时拒绝生成 clean-plate manifest', async (t) => {
  const { root, entries } = await makeFixture(t);

  await assert.rejects(
    () => buildLocalCleanPlateManifest({ root, entries: entries.slice(0, 3) }),
    { code: 'REDRAW_CLEAN_PLATE_SHOTS_INVALID' },
  );

  const duplicateShotEntries = cloneEntries(entries);
  duplicateShotEntries[1].shot_id = duplicateShotEntries[0].shot_id;
  await assert.rejects(
    () => buildLocalCleanPlateManifest({ root, entries: duplicateShotEntries }),
    { code: 'REDRAW_CLEAN_PLATE_SHOTS_INVALID' },
  );
});

test('包含未允许的 shot-5 时拒绝生成 clean-plate manifest', async (t) => {
  const { root, entries } = await makeFixture(t);
  const unsupportedShotEntries = cloneEntries(entries);
  unsupportedShotEntries[0].shot_id = 'shot-5';

  await assert.rejects(
    () => buildLocalCleanPlateManifest({ root, entries: unsupportedShotEntries }),
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

test('遮罩或净景哈希漂移时拒绝生成 clean-plate manifest', async (t) => {
  const { root, entries } = await makeFixture(t);

  const wrongMaskHashEntries = cloneEntries(entries);
  wrongMaskHashEntries[0].mask.sha256 = '1'.repeat(64);
  await assert.rejects(
    () => buildLocalCleanPlateManifest({ root, entries: wrongMaskHashEntries }),
    { code: 'REDRAW_CLEAN_PLATE_HASH_MISMATCH' },
  );

  const wrongCleanPlateHashEntries = cloneEntries(entries);
  wrongCleanPlateHashEntries[0].clean_plate.sha256 = '2'.repeat(64);
  await assert.rejects(
    () => buildLocalCleanPlateManifest({ root, entries: wrongCleanPlateHashEntries }),
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

test('源帧尺寸不一致时拒绝生成 clean-plate manifest', async (t) => {
  const { root, entries } = await makeFixture(t);
  const wrongSizeRelativePath = 'shots/shot-1/source-small.png';
  const wrongSizeEvidence = await createPng(root, wrongSizeRelativePath, 640, IMAGE_HEIGHT);
  const wrongSizeEntries = cloneEntries(entries);
  wrongSizeEntries[0].representative_frame = wrongSizeEvidence;

  await assert.rejects(
    () => buildLocalCleanPlateManifest({ root, entries: wrongSizeEntries }),
    { code: 'REDRAW_CLEAN_PLATE_DIMENSIONS_INVALID' },
  );
});

test('净景尺寸不一致时拒绝生成 clean-plate manifest', async (t) => {
  const { root, entries } = await makeFixture(t);
  const wrongSizeRelativePath = 'shots/shot-8/clean-small.png';
  const wrongSizeEvidence = await createPng(root, wrongSizeRelativePath, 640, IMAGE_HEIGHT);
  const wrongSizeEntries = cloneEntries(entries);
  wrongSizeEntries[3].clean_plate = wrongSizeEvidence;

  await assert.rejects(
    () => buildLocalCleanPlateManifest({ root, entries: wrongSizeEntries }),
    { code: 'REDRAW_CLEAN_PLATE_DIMENSIONS_INVALID' },
  );
});

test('源帧、遮罩和净景 MIME 不一致时拒绝生成 clean-plate manifest', async (t) => {
  const { root, entries } = await makeFixture(t);
  const wrongMimeEntries = cloneEntries(entries);
  wrongMimeEntries[3].clean_plate.mime_type = 'image/jpeg';

  await assert.rejects(
    () => buildLocalCleanPlateManifest({ root, entries: wrongMimeEntries }),
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

function streamCapture() {
  const chunks = [];
  return {
    stream: { write(value) { chunks.push(String(value)); } },
    text() { return chunks.join(''); },
  };
}

test('CLI fixture dry-run 生成脱敏 manifest 和四镜 contact sheet', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'redraw-clean-plate-cli-output-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, 'output');
  const stdout = streamCapture();
  const stderr = streamCapture();

  const exitCode = await main(['--fixture', '--output-dir', outputDir], {
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.text(), /REDRAW_CLEAN_PLATE_LOCAL_OK/);
  assert.equal(stderr.text(), '');

  const manifestPath = path.join(outputDir, 'redraw-clean-plate-local-manifest.json');
  const contactSheetPath = path.join(outputDir, 'redraw-clean-plate-contact-sheet.jpg');
  assert.ok(fs.existsSync(manifestPath));
  assert.ok(fs.existsSync(contactSheetPath));
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  assert.deepEqual(manifest.shots.map((shot) => shot.shot_id), SHOT_IDS);
  assert.equal(manifest.shots.every((shot) => shot.review.status === 'pending'), true);
  assert.equal(manifest.shots.every((shot) => shot.ready_for_reference === false), true);
  assert.equal(JSON.stringify(manifest).includes(root), false);

  const contactSheetMetadata = await sharp(contactSheetPath).metadata();
  assert.equal(contactSheetMetadata.width, 960);
  assert.equal(contactSheetMetadata.height, 720);

  const scriptSource = await fs.promises.readFile(
    path.join(__dirname, '..', 'scripts', 'run-redraw-clean-plate-local-case.js'),
    'utf8',
  );
  assert.doesNotMatch(scriptSource, /(?:https?:|fetch\s*\(|process\.env|api[_-]?key)/i);
});

test('CLI 未知参数返回稳定错误码', async () => {
  const stdout = streamCapture();
  const stderr = streamCapture();
  const exitCode = await main(['--unknown'], { stdout: stdout.stream, stderr: stderr.stream });

  assert.equal(exitCode, 2);
  assert.match(stderr.text(), /error_code=REDRAW_CLEAN_PLATE_LOCAL_CLI_INVALID/);
});

test('CLI manifest 缺少四镜时返回 service 错误码', async (t) => {
  const { root, entries } = await makeFixture(t);
  const manifestRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'redraw-clean-plate-cli-manifest-'));
  t.after(() => fs.promises.rm(manifestRoot, { recursive: true, force: true }));
  const manifestPath = path.join(manifestRoot, 'input.json');
  await fs.promises.writeFile(manifestPath, JSON.stringify({ entries: entries.slice(0, 3) }), 'utf8');
  const outputDir = path.join(manifestRoot, 'output');
  const stdout = streamCapture();
  const stderr = streamCapture();

  const exitCode = await main(['--manifest', manifestPath, '--output-dir', outputDir], {
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.text(), /error_code=REDRAW_CLEAN_PLATE_SHOTS_INVALID/);
  assert.equal(fs.existsSync(path.join(outputDir, 'redraw-clean-plate-local-manifest.json')), false);
});

test('CLI 输出目录不可写时返回稳定错误码', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'redraw-clean-plate-cli-output-file-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const outputPath = path.join(root, 'output-file');
  await fs.promises.writeFile(outputPath, 'not a directory', 'utf8');
  const stdout = streamCapture();
  const stderr = streamCapture();

  const exitCode = await main(['--fixture', '--output-dir', outputPath], {
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.text(), /error_code=REDRAW_CLEAN_PLATE_LOCAL_OUTPUT_INVALID/);
});
