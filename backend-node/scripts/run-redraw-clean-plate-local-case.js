#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { buildLocalCleanPlateManifest } = require('../src/services/redrawCleanPlateLocalCaseService');

const DEFAULT_OUTPUT_DIR = path.join(os.tmpdir(), 'redraw-clean-plate-four-shots');
const MANIFEST_FILENAME = 'redraw-clean-plate-local-manifest.json';
const CONTACT_SHEET_FILENAME = 'redraw-clean-plate-contact-sheet.jpg';
const SHOT_IDS = Object.freeze(['shot-1', 'shot-6', 'shot-7', 'shot-8']);
const IMAGE_WIDTH = 1280;
const IMAGE_HEIGHT = 720;

function codedError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function readFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value == null || String(value).startsWith('--')) {
    throw codedError('REDRAW_CLEAN_PLATE_LOCAL_CLI_INVALID', `${flag} 缺少参数值`);
  }
  return String(value);
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    fixture: false,
    manifest: null,
    outputDir: DEFAULT_OUTPUT_DIR,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--fixture') {
      options.fixture = true;
      continue;
    }
    if (argument === '--manifest') {
      options.manifest = path.resolve(readFlagValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (argument === '--output-dir') {
      options.outputDir = path.resolve(readFlagValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    throw codedError('REDRAW_CLEAN_PLATE_LOCAL_CLI_INVALID', `未知参数: ${argument}`);
  }

  if (!options.help && options.fixture && options.manifest) {
    throw codedError('REDRAW_CLEAN_PLATE_LOCAL_CLI_INVALID', '--fixture 与 --manifest 不能同时使用');
  }
  if (!options.help && !options.fixture && !options.manifest) {
    throw codedError('REDRAW_CLEAN_PLATE_LOCAL_CLI_INVALID', '必须提供 --fixture 或 --manifest');
  }
  return options;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function createFixtureImage(root, relativePath) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await sharp({
    create: {
      width: IMAGE_WIDTH,
      height: IMAGE_HEIGHT,
      channels: 4,
      background: '#808080',
    },
  }).png().toFile(filePath);
  return {
    path: relativePath,
    sha256: sha256File(filePath),
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
    mime_type: 'image/png',
  };
}

async function createFixture() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'redraw-clean-plate-four-shots-'));
  const entries = [];
  try {
    for (const [index, shotId] of SHOT_IDS.entries()) {
      const directory = `shots/${shotId}`;
      const representativeFrame = await createFixtureImage(root, `${directory}/source.png`);
      const mask = await createFixtureImage(root, `${directory}/mask.png`);
      const cleanPlate = await createFixtureImage(root, `${directory}/clean-plate.png`);
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
        review: { status: 'pending' },
      });
    }
    return { root, entries };
  } catch (error) {
    await fs.promises.rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function readManifest(manifestPath) {
  let payload;
  try {
    payload = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw codedError('REDRAW_CLEAN_PLATE_LOCAL_MANIFEST_INVALID', 'manifest 文件不可读取或不是有效 JSON', error);
  }

  const entries = Array.isArray(payload) ? payload : payload?.entries;
  const manifestRootValue = Array.isArray(payload) ? null : payload?.root;
  let root = path.dirname(manifestPath);
  if (manifestRootValue != null) {
    if (typeof manifestRootValue !== 'string' || path.isAbsolute(manifestRootValue)
      || path.win32.isAbsolute(manifestRootValue) || path.posix.isAbsolute(manifestRootValue)) {
      throw codedError('REDRAW_CLEAN_PLATE_LOCAL_MANIFEST_INVALID', 'manifest root 必须是相对路径');
    }
    root = path.resolve(path.dirname(manifestPath), manifestRootValue);
  }
  return { root, entries };
}

async function ensureOutputDirectory(outputDir) {
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const stat = await fs.promises.stat(outputDir);
    if (!stat.isDirectory()) throw new Error('output path is not a directory');
    await fs.promises.access(outputDir, fs.constants.W_OK);
  } catch (error) {
    throw codedError('REDRAW_CLEAN_PLATE_LOCAL_OUTPUT_INVALID', '输出目录不可写', error);
  }
}

async function writeAtomic(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    try { await fs.promises.rm(temporaryPath, { force: true }); } catch (_) {}
    throw codedError('REDRAW_CLEAN_PLATE_LOCAL_OUTPUT_INVALID', 'manifest 输出失败', error);
  }
}

async function writeContactSheet(root, manifest, outputPath) {
  const composites = [];
  for (const [row, shot] of manifest.shots.entries()) {
    for (const [column, key] of ['source', 'mask', 'clean_plate'].entries()) {
      const filePath = path.join(root, shot[key].path);
      let input;
      try {
        input = await sharp(filePath).resize(320, 180, { fit: 'fill' }).png().toBuffer();
      } catch (error) {
        throw codedError('REDRAW_CLEAN_PLATE_LOCAL_CONTACT_SHEET_FAILED', 'contact sheet 图片读取失败', error);
      }
      composites.push({ input, left: column * 320, top: row * 180 });
    }
  }

  const temporaryPath = `${outputPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await sharp({
      create: { width: 960, height: 720, channels: 3, background: '#ffffff' },
    }).composite(composites).jpeg({ quality: 90 }).toFile(temporaryPath);
    await fs.promises.rename(temporaryPath, outputPath);
  } catch (error) {
    try { await fs.promises.rm(temporaryPath, { force: true }); } catch (_) {}
    throw codedError('REDRAW_CLEAN_PLATE_LOCAL_CONTACT_SHEET_FAILED', 'contact sheet 输出失败', error);
  }
}

function helpText() {
  return [
    '用法: node scripts/run-redraw-clean-plate-local-case.js --fixture [--output-dir <目录>]',
    '      node scripts/run-redraw-clean-plate-local-case.js --manifest <文件> [--output-dir <目录>]',
    '选项: --fixture 生成本地四镜 fixture；--manifest 读取 manifest；--output-dir 指定输出目录；--help 查看帮助。',
  ].join('\n');
}

async function runCase(options) {
  await ensureOutputDirectory(options.outputDir);
  let fixtureRoot;
  let root;
  let entries;
  try {
    if (options.fixture) {
      const fixture = await createFixture();
      fixtureRoot = fixture.root;
      root = fixture.root;
      entries = fixture.entries;
    } else {
      ({ root, entries } = await readManifest(options.manifest));
    }

    const manifest = await buildLocalCleanPlateManifest({ root, entries });
    const manifestPath = path.join(options.outputDir, MANIFEST_FILENAME);
    const contactSheetPath = path.join(options.outputDir, CONTACT_SHEET_FILENAME);
    await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeContactSheet(root, manifest, contactSheetPath);
    return { manifestPath, contactSheetPath };
  } finally {
    if (fixtureRoot) await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function main(argv = process.argv.slice(2), streams = {}) {
  const stdout = streams.stdout || process.stdout;
  const stderr = streams.stderr || process.stderr;
  try {
    const options = parseArgs(argv);
    if (options.help) {
      stdout.write(`${helpText()}\n`);
      return 0;
    }
    await runCase(options);
    stdout.write('REDRAW_CLEAN_PLATE_LOCAL_OK\n');
    return 0;
  } catch (error) {
    const code = error?.code || 'REDRAW_CLEAN_PLATE_LOCAL_FAILED';
    stderr.write(`error_code=${code}\n`);
    stderr.write(`error=${error?.message || String(error)}\n`);
    return code === 'REDRAW_CLEAN_PLATE_LOCAL_CLI_INVALID' ? 2 : 1;
  }
}

if (require.main === module) {
  main().then((exitCode) => { process.exitCode = exitCode; });
}

module.exports = {
  DEFAULT_OUTPUT_DIR,
  CONTACT_SHEET_FILENAME,
  MANIFEST_FILENAME,
  createFixture,
  main,
  parseArgs,
  runCase,
};
