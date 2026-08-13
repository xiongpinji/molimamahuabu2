const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const {
  buildTextCleanPlateManifest,
} = require('../src/services/redrawTextCleanPlateLocalCaseService');
const {
  main,
  MANIFEST_FILENAME: LOCAL_MANIFEST_FILENAME,
  CONTACT_SHEET_FILENAME: LOCAL_CONTACT_SHEET_FILENAME,
} = require('../scripts/run-redraw-text-clean-plate-local-case');

const SHOT_IDS = ['shot-4', 'shot-8'];
const TEXT_KINDS = ['text_subtitle', 'text_screen'];
const IMAGE_EVIDENCE_FIELDS = [
  { entry: 'representative_frame', manifest: 'source', label: 'source' },
  { entry: 'mask_asset', manifest: 'mask', label: 'mask' },
  { entry: 'clean_plate', manifest: 'text_clean', label: 'text-clean' },
];
const IMAGE_WIDTH = 1280;
const IMAGE_HEIGHT = 720;

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function createPng(root, relativePath, {
  width = IMAGE_WIDTH,
  height = IMAGE_HEIGHT,
  background = '#808080',
} = {}) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background,
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

function assertCanonicalTwoShots(entries) {
  assert.equal(entries.length, SHOT_IDS.length, '测试变体必须保持两镜数量不变量');
  assert.deepEqual(entries.map((entry) => entry.shot_id), SHOT_IDS);
  assert.deepEqual(entries.map((entry) => entry.text_kind), TEXT_KINDS);
}

function mutateTwoShotEntries(entries, mutation, { preserveShotIds = true } = {}) {
  assertCanonicalTwoShots(entries);
  const mutated = structuredClone(entries);
  mutation(mutated);
  assert.equal(mutated.length, SHOT_IDS.length, '测试变体不得意外改变两镜数量');
  assert.deepEqual(
    mutated.map((entry) => entry.text_kind),
    TEXT_KINDS,
    '测试变体不得意外改变两镜文字类型',
  );
  if (preserveShotIds) {
    assert.deepEqual(
      mutated.map((entry) => entry.shot_id),
      SHOT_IDS,
      '非镜头集合测试不得意外改变镜头编号',
    );
  }
  return mutated;
}

function mutateShot(entries, shotId, mutation, options) {
  return mutateTwoShotEntries(entries, (mutated) => {
    const entry = mutated.find((candidate) => candidate.shot_id === shotId);
    assert.ok(entry, `缺少测试镜头 ${shotId}`);
    mutation(entry);
  }, options);
}

async function makeFixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'redraw-text-clean-plate-case-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));

  const entries = [];
  for (const [index, shotId] of SHOT_IDS.entries()) {
    const directory = `shots/${shotId}`;
    const source = await createPng(root, `${directory}/source.png`, { background: '#707070' });
    const mask = await createPng(root, `${directory}/mask.png`, { background: '#ffffff' });
    const textClean = await createPng(root, `${directory}/text-clean.png`, { background: '#606060' });
    const textKind = TEXT_KINDS[index];
    const polygon = index === 0
      ? [
        { x: 120, y: 590 },
        { x: 1160, y: 590 },
        { x: 1160, y: 690 },
        { x: 120, y: 690 },
      ]
      : [
        { x: 720, y: 120 },
        { x: 1160, y: 120 },
        { x: 1160, y: 420 },
        { x: 720, y: 420 },
      ];

    entries.push({
      shot_id: shotId,
      text_kind: textKind,
      source_asset_id: 401 + index,
      representative_frame: source,
      mask_asset_id: 501 + index,
      mask_asset: mask,
      text_clean_asset_id: 601 + index,
      clean_plate: textClean,
      region: {
        kind: textKind,
        polygon,
      },
      quality: {
        width: IMAGE_WIDTH,
        height: IMAGE_HEIGHT,
        mask_area_changed: true,
        non_mask_similarity: 0.98,
        text_residual: false,
      },
      review: { status: 'pending' },
    });
  }

  assertCanonicalTwoShots(entries);
  return { root, entries };
}

async function assertRejectedCode(root, entries, code) {
  await assert.rejects(
    () => buildTextCleanPlateManifest({ root, entries }),
    { code },
  );
}

test('两镜文字净景 manifest 固定排序、脱敏并绑定本地图片哈希', async (t) => {
  const { root, entries: canonicalEntries } = await makeFixture(t);
  const result = await buildTextCleanPlateManifest({
    root,
    entries: canonicalEntries.slice().reverse(),
    now: '2026-08-13T00:00:00.000Z',
  });

  assert.equal(result.mode, 'text_clean_plate');
  assert.deepEqual(result.shots.map((shot) => shot.shot_id), SHOT_IDS);
  assert.deepEqual(result.shots.map((shot) => shot.text_kind), TEXT_KINDS);
  assert.equal(JSON.stringify(result).includes(root), false);

  for (const shot of result.shots) {
    const declaredEntry = canonicalEntries.find((entry) => entry.shot_id === shot.shot_id);
    assert.ok(declaredEntry);
    assert.equal(shot.region.kind, shot.text_kind);
    assert.deepEqual(shot.region.polygon, declaredEntry.region.polygon);
    assert.equal(Object.prototype.hasOwnProperty.call(shot.region, 'ocr_text'), false);
    assert.equal(shot.review.status, 'pending');
    assert.equal(shot.ready_for_reference, false);

    for (const field of IMAGE_EVIDENCE_FIELDS) {
      const file = shot[field.manifest];
      assert.equal(file.sha256, declaredEntry[field.entry].sha256);
      assert.equal(file.sha256, sha256File(path.join(root, file.path)));
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.equal(path.isAbsolute(file.path), false);
      assert.equal(file.path.split(/[\\/]+/).includes('..'), false);
    }
  }
});

test('缺镜、未知 shot-5 或重复镜头时拒绝生成文字净景 manifest', async (t) => {
  const { root, entries } = await makeFixture(t);

  const missingShotEntries = entries.slice(0, 1);
  assert.equal(missingShotEntries.length, 1);
  await assertRejectedCode(root, missingShotEntries, 'REDRAW_TEXT_CLEAN_PLATE_SHOTS_INVALID');

  const unknownShotEntries = mutateShot(entries, 'shot-4', (entry) => {
    entry.shot_id = 'shot-5';
  }, { preserveShotIds: false });
  await assertRejectedCode(root, unknownShotEntries, 'REDRAW_TEXT_CLEAN_PLATE_SHOTS_INVALID');

  const duplicateShotEntries = mutateShot(entries, 'shot-8', (entry) => {
    entry.shot_id = 'shot-4';
  }, { preserveShotIds: false });
  await assertRejectedCode(root, duplicateShotEntries, 'REDRAW_TEXT_CLEAN_PLATE_SHOTS_INVALID');
});

test('非法文字区域或文字类型时拒绝生成文字净景 manifest', async (t) => {
  const { root, entries } = await makeFixture(t);
  const cases = [
    {
      name: 'polygon 少于三个点',
      mutate(entry) {
        entry.region.polygon = entry.region.polygon.slice(0, 2);
      },
    },
    {
      name: 'polygon 含负坐标',
      mutate(entry) {
        entry.region.polygon[0].x = -1;
      },
    },
    {
      name: 'polygon 坐标越界',
      mutate(entry) {
        entry.region.polygon[1].x = IMAGE_WIDTH + 1;
      },
    },
    {
      name: 'region kind 与 entry text_kind 不一致',
      mutate(entry) {
        entry.region.kind = 'text_screen';
      },
    },
    {
      name: '未知 region.kind',
      shotId: 'shot-8',
      mutate(entry) {
        assert.equal(entry.text_kind, 'text_screen');
        entry.region.kind = 'text_unknown';
      },
    },
    {
      name: 'region 混入 ocr_text',
      mutate(entry) {
        entry.region.ocr_text = '不得进入净景清单的识别文字';
      },
    },
    {
      name: 'region 混入绝对路径字段',
      mutate(entry, fixtureRoot) {
        entry.region.ocr_artifact_path = path.join(fixtureRoot, 'ocr-result.json');
      },
    },
  ];

  for (const invalidCase of cases) {
    await t.test(invalidCase.name, async () => {
      const invalidEntries = mutateShot(entries, invalidCase.shotId || 'shot-4', (entry) => {
        invalidCase.mutate(entry, root);
      });
      await assertRejectedCode(root, invalidEntries, 'REDRAW_TEXT_CLEAN_PLATE_REGION_INVALID');
    });
  }
});

test('绝对路径或 .. 路径时拒绝生成文字净景 manifest', async (t) => {
  const { root, entries } = await makeFixture(t);

  for (const field of IMAGE_EVIDENCE_FIELDS) {
    await t.test(`${field.entry} 使用绝对路径`, async () => {
      const invalidEntries = mutateShot(entries, 'shot-4', (entry) => {
        entry[field.entry].path = path.join(root, entry[field.entry].path);
      });
      await assertRejectedCode(root, invalidEntries, 'REDRAW_TEXT_CLEAN_PLATE_PATH_INVALID');
    });

    await t.test(`${field.entry} 使用 .. 路径`, async () => {
      const invalidEntries = mutateShot(entries, 'shot-8', (entry) => {
        entry[field.entry].path = '../outside.png';
      });
      await assertRejectedCode(root, invalidEntries, 'REDRAW_TEXT_CLEAN_PLATE_PATH_INVALID');
    });
  }
});

test('source、mask 或 text-clean 哈希漂移时拒绝生成文字净景 manifest', async (t) => {
  const { root, entries } = await makeFixture(t);

  for (const [index, field] of IMAGE_EVIDENCE_FIELDS.entries()) {
    await t.test(`${field.label} 哈希漂移`, async () => {
      const invalidEntries = mutateShot(entries, 'shot-4', (entry) => {
        entry[field.entry].sha256 = String(index).repeat(64);
      });
      await assertRejectedCode(root, invalidEntries, 'REDRAW_TEXT_CLEAN_PLATE_HASH_MISMATCH');
    });
  }
});

test('source、mask 或 text-clean 尺寸不一致时拒绝生成文字净景 manifest', async (t) => {
  const { root, entries } = await makeFixture(t);

  for (const [index, field] of IMAGE_EVIDENCE_FIELDS.entries()) {
    await t.test(`${field.label} 尺寸不一致`, async () => {
      const relativePath = `shots/shot-4/${field.entry}-small.png`;
      const wrongSizeEvidence = await createPng(root, relativePath, {
        width: IMAGE_WIDTH - 1 - index,
        background: '#505050',
      });
      const invalidEntries = mutateShot(entries, 'shot-4', (entry) => {
        entry[field.entry] = wrongSizeEvidence;
      });
      await assertRejectedCode(root, invalidEntries, 'REDRAW_TEXT_CLEAN_PLATE_DIMENSIONS_INVALID');
    });
  }
});

test('source、mask 或 text-clean MIME 不一致时拒绝生成文字净景 manifest', async (t) => {
  const { root, entries } = await makeFixture(t);

  for (const field of IMAGE_EVIDENCE_FIELDS) {
    await t.test(`${field.label} MIME 不一致`, async () => {
      const invalidEntries = mutateShot(entries, 'shot-8', (entry) => {
        entry[field.entry].mime_type = 'image/jpeg';
      });
      await assertRejectedCode(root, invalidEntries, 'REDRAW_TEXT_CLEAN_PLATE_DIMENSIONS_INVALID');
    });
  }
});

test('图片证据打开后发现 symlink 目标切换时拒绝并且错误序列化不泄露根目录', async (t) => {
  const { root, entries } = await makeFixture(t);
  const sourcePath = path.resolve(root, entries[0].representative_frame.path);
  const swappedRelativePath = 'shots/shot-4/swapped.png';
  await createPng(root, swappedRelativePath, { background: '#505050' });

  const originalRealpath = fs.realpathSync.native;
  let sourceRealpathCalls = 0;
  fs.realpathSync.native = (candidatePath) => {
    const resolved = originalRealpath(candidatePath);
    if (path.resolve(candidatePath) === sourcePath) {
      sourceRealpathCalls += 1;
      if (sourceRealpathCalls > 1) {
        return originalRealpath(path.join(root, swappedRelativePath));
      }
    }
    return resolved;
  };

  try {
    await assert.rejects(
      () => buildTextCleanPlateManifest({ root, entries }),
      (error) => {
        assert.equal(error.code, 'REDRAW_TEXT_CLEAN_PLATE_PATH_INVALID');
        assert.equal(JSON.stringify(error).includes(root), false);
        return true;
      },
    );
  } finally {
    fs.realpathSync.native = originalRealpath;
  }
  assert.ok(sourceRealpathCalls >= 2, '应在打开证据后复核 realpath');
});

test('文字净景质量未达门禁时拒绝生成 manifest', async (t) => {
  const { root, entries } = await makeFixture(t);
  const cases = [
    {
      name: 'mask_area_changed=false',
      mutate(quality) {
        quality.mask_area_changed = false;
      },
    },
    {
      name: 'non_mask_similarity=.969',
      mutate(quality) {
        quality.non_mask_similarity = 0.969;
      },
    },
    {
      name: 'text_residual=true',
      mutate(quality) {
        quality.text_residual = true;
      },
    },
  ];

  for (const invalidCase of cases) {
    await t.test(invalidCase.name, async () => {
      const invalidEntries = mutateShot(entries, 'shot-8', (entry) => {
        invalidCase.mutate(entry.quality);
      });
      await assertRejectedCode(root, invalidEntries, 'REDRAW_TEXT_CLEAN_PLATE_QUALITY_FAILED');
    });
  }
});

function captureStreams() {
  let stdout = '';
  let stderr = '';
  return {
    streams: {
      stdout: { write(value) { stdout += String(value); } },
      stderr: { write(value) { stderr += String(value); } },
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

test('本地 CLI fixture 生成两镜 manifest 与三列 contact sheet', async (t) => {
  const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'redraw-text-clean-plate-cli-'));
  t.after(() => fs.promises.rm(outputDir, { recursive: true, force: true }));
  const captured = captureStreams();

  const exitCode = await main(['--fixture', '--output-dir', outputDir], captured.streams);

  assert.equal(exitCode, 0);
  assert.equal(captured.stdout, 'REDRAW_TEXT_CLEAN_PLATE_LOCAL_OK\n');
  assert.equal(captured.stderr, '');

  const manifestPath = path.join(outputDir, LOCAL_MANIFEST_FILENAME);
  const contactSheetPath = path.join(outputDir, LOCAL_CONTACT_SHEET_FILENAME);
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  assert.deepEqual(manifest.shots.map((shot) => shot.shot_id), SHOT_IDS);
  assert.deepEqual(manifest.shots.map((shot) => shot.text_kind), TEXT_KINDS);
  assert.equal(JSON.stringify(manifest).includes(path.resolve(outputDir)), false);
  assert.equal(JSON.stringify(manifest).includes('ocr_text'), false);

  const metadata = await sharp(contactSheetPath).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 960);
  assert.equal(metadata.height, 360);
});

test('本地 CLI 拒绝未知参数', async () => {
  const unknown = captureStreams();
  assert.equal(await main(['--unknown'], unknown.streams), 2);
  assert.match(unknown.stderr, /error_code=REDRAW_TEXT_CLEAN_PLATE_LOCAL_CLI_INVALID/);
});

test('本地 CLI 缺两镜时返回 service 错误且失败不写 manifest', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'redraw-text-clean-plate-cli-invalid-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));

  const invalidManifestPath = path.join(root, 'missing-shot.json');
  await fs.promises.writeFile(invalidManifestPath, JSON.stringify({
    root: '.',
    entries: [{ shot_id: 'shot-4' }],
  }));
  const missingShotsOutput = path.join(root, 'missing-shots-output');
  const missingShots = captureStreams();
  assert.equal(
    await main(['--manifest', invalidManifestPath, '--output-dir', missingShotsOutput], missingShots.streams),
    1,
  );
  assert.match(missingShots.stderr, /error_code=REDRAW_TEXT_CLEAN_PLATE_SHOTS_INVALID/);
  assert.equal(fs.existsSync(path.join(missingShotsOutput, LOCAL_MANIFEST_FILENAME)), false);
});

test('本地 CLI 输出路径为普通文件时返回稳定错误且失败不写 manifest', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'redraw-text-clean-plate-cli-output-invalid-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const outputFile = path.join(root, 'output-file');
  await fs.promises.writeFile(outputFile, 'not-a-directory');
  const outputInvalid = captureStreams();
  assert.equal(await main(['--fixture', '--output-dir', outputFile], outputInvalid.streams), 1);
  assert.match(outputInvalid.stderr, /error_code=REDRAW_TEXT_CLEAN_PLATE_LOCAL_OUTPUT_INVALID/);
  assert.equal(fs.existsSync(path.join(outputFile, LOCAL_MANIFEST_FILENAME)), false);
});
