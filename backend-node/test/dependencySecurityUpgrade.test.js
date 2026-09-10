const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createZipBuffer, readZipEntries } = require('../src/services/zipArchiveService');

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

test('生产 ZIP 实现不再依赖存在互斥漏洞区间的 adm-zip', () => {
  assert.equal(Object.hasOwn(backendPackage.dependencies, 'adm-zip'), false);
  assert.equal(versionAtLeast(require('fflate/package.json').version, '0.8.2'), true);
});

test('sharp 达到已修复的最低版本', () => {
  assert.equal(versionAtLeast(sharp.versions.sharp, '0.35.4'), true, `sharp 当前版本为 ${sharp.versions.sharp}`);
});

test('生产依赖达到当前安全公告要求的最低版本', () => {
  assert.equal(versionAtLeast(require('js-yaml/package.json').version, '4.3.2'), true);
  assert.equal(versionAtLeast(require('multer/package.json').version, '2.3.0'), true);
  assert.equal(versionAtLeast(require('nodemailer/package.json').version, '9.1.1'), true);
  assert.equal(versionAtLeast(require('qs/package.json').version, '6.16.0'), true);
});

test('后端声明的 Node 最低版本满足 sharp 运行时要求', () => {
  assert.equal(backendPackage.engines.node, '>=20.9.0');
});

test('项目 ZIP 升级后仍可解析 project.json 与媒体文件', () => {
  const zip = createZipBuffer([
    ['project.json', Buffer.from(JSON.stringify({ drama: { title: '兼容性测试项目' } }), 'utf8')],
    ['characters/hero.txt', Buffer.from('hero-asset', 'utf8')],
  ]);
  const result = parseZip(zip);

  assert.equal(result.data.drama.title, '兼容性测试项目');
  assert.equal(result.files.get('characters/hero.txt').toString('utf8'), 'hero-asset');
});

test('ZIP 在解压前拒绝伪造的超大展开尺寸', () => {
  const zip = createZipBombFixture();
  const centralOffset = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.notEqual(centralOffset, -1);
  zip.writeUInt32LE(0xfffffffe, centralOffset + 24);
  assert.throws(
    () => readZipEntries(zip, { maxEntryBytes: 1024, maxTotalBytes: 1024 }),
    (error) => error?.code === 'ZIP_ENTRY_TOO_LARGE',
  );
});

function createZipBombFixture() {
  return createZipBuffer([['clip.mp4', Buffer.from('safe')]]);
}

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
