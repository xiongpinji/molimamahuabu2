const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const sharp = require('sharp');

const { parseZip } = require('../src/services/dramaImportService');
const backendPackage = require('../package.json');

function versionAtLeast(actual, expected) {
  const actualParts = actual.split('.').map(Number);
  const expectedParts = expected.split('.').map(Number);
  for (let i = 0; i < expectedParts.length; i += 1) {
    if ((actualParts[i] || 0) > expectedParts[i]) return true;
    if ((actualParts[i] || 0) < expectedParts[i]) return false;
  }
  return true;
}

test('adm-zip 达到已修复的最低版本', () => {
  const admZipVersion = require('adm-zip/package.json').version;
  assert.equal(versionAtLeast(admZipVersion, '0.6.0'), true, `adm-zip 当前版本为 ${admZipVersion}`);
});

test('sharp 达到已修复的最低版本', () => {
  assert.equal(versionAtLeast(sharp.versions.sharp, '0.35.3'), true, `sharp 当前版本为 ${sharp.versions.sharp}`);
});

test('后端声明的 Node 最低版本满足 sharp 运行时要求', () => {
  assert.equal(backendPackage.engines.node, '>=20.9.0');
});

test('项目 ZIP 升级后仍可解析 project.json 与媒体文件', () => {
  const zip = new AdmZip();
  zip.addFile('project.json', Buffer.from(JSON.stringify({ drama: { title: '兼容性测试项目' } }), 'utf8'));
  zip.addFile('characters/hero.txt', Buffer.from('hero-asset', 'utf8'));

  const result = parseZip(zip.toBuffer());

  assert.equal(result.data.drama.title, '兼容性测试项目');
  assert.equal(result.files.get('characters/hero.txt').toString('utf8'), 'hero-asset');
});

test('Sharp 升级后仍可读取元数据并完成缩放与 PNG 输出', async () => {
  const source = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6" fill="#ff69b4"/></svg>',
    'utf8'
  );

  const inputMetadata = await sharp(source).metadata();
  const output = await sharp(source).resize(4, 3, { kernel: 'lanczos3' }).png().toBuffer();
  const outputMetadata = await sharp(output).metadata();

  assert.equal(inputMetadata.width, 8);
  assert.equal(inputMetadata.height, 6);
  assert.equal(outputMetadata.format, 'png');
  assert.equal(outputMetadata.width, 4);
  assert.equal(outputMetadata.height, 3);
});
