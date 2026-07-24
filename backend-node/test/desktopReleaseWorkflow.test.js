const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

function readDesktopPackage() {
  return JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'));
}

function readWorkflow(name) {
  return fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8');
}

function readDesktopScript(name) {
  return fs.readFileSync(path.join(root, 'desktop', 'scripts', name), 'utf8');
}

test('Windows 桌面包使用茉莉妈妈品牌元数据并保留资源编辑', () => {
  const packageJson = readDesktopPackage();
  const build = packageJson.build;

  assert.equal(packageJson.name, 'molimama-short-drama-desktop');
  assert.equal(packageJson.description, '茉莉妈妈短剧制作平台桌面客户端');
  assert.equal(packageJson.author, '茉莉妈妈');
  assert.equal(build.appId, 'com.localminidrama.desktop');
  assert.equal(build.productName, '茉莉妈妈短剧制作平台');
  assert.equal(build.copyright, 'Copyright © 2026 茉莉妈妈');
  assert.equal(build.win.icon, 'build/icon.ico');
  assert.equal(build.win.signAndEditExecutable, true);
  assert.equal(build.nsis.deleteAppDataOnUninstall, false);
  assert.match(build.nsis.artifactName, /^茉莉妈妈短剧制作平台 /);
  assert.match(build.portable.artifactName, /^茉莉妈妈短剧制作平台 /);
});

test('Windows 品牌资源包含原始 PNG 和多尺寸 ICO', () => {
  const png = fs.readFileSync(path.join(root, 'desktop', 'build', 'icon.png'));
  const ico = fs.readFileSync(path.join(root, 'desktop', 'build', 'icon.ico'));

  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.ok(ico.readUInt16LE(4) >= 6, 'ICO 至少应包含 6 个尺寸');
  assert.ok([...ico.subarray(6, 6 + ico.readUInt16LE(4) * 16)]
    .filter((_, index) => index % 16 === 0)
    .includes(0), 'ICO 应包含 256×256 图层');
});

test('PR 与主分支变更会构建明确未签名的 Windows 验证包', () => {
  const workflow = readWorkflow('windows-desktop-build.yml');

  assert.match(workflow, /\bpull_request:/);
  assert.match(workflow, /\bpush:\s*\n\s+branches:\s*\[main\]/);
  assert.match(workflow, /\bworkflow_dispatch:/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /node-version: ['"]24['"]/);
  assert.match(workflow, /npm --prefix desktop run dist/);
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY: ['"]false['"]/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /validate-windows-installer\.ps1/);
  assert.doesNotMatch(workflow, /WIN_CSC_(?:LINK|KEY_PASSWORD)/);
  assert.doesNotMatch(workflow, /action-gh-release/);
});

test('Windows 安装器回归脚本覆盖安装、重复覆盖和卸载后数据保留', () => {
  const script = readDesktopScript('validate-windows-installer.ps1');

  assert.match(script, /Start-Process[\s\S]*\/S/);
  assert.match(script, /Start-Process[\s\S]*\/D=/);
  assert.ok((script.match(/Invoke-Installer/g) || []).length >= 3);
  assert.match(script, /BaselineInstallerPath/);
  assert.match(script, /firstInstaller/);
  assert.match(script, /localminidrama-desktop/);
  assert.match(script, /user-data-sentinel/);
  assert.match(script, /Cover install removed user data/);
  assert.match(script, /FileDescription/);
  assert.match(script, /Uninstall.*\.exe/);
  assert.match(script, /Wait-UntilMissing -Path \$uninstallerPath/);
  assert.match(script, /Test-Path[\s\S]*userDataSentinel/);
  assert.match(
    script,
    /finally[\s\S]*Test-Path -LiteralPath \$installDir[\s\S]*Invoke-Uninstaller/,
  );
});

test('正式发布验证脚本强制校验签名、时间戳、版本和校验和', () => {
  const script = readDesktopScript('verify-signed-release.ps1');

  assert.match(script, /Get-AuthenticodeSignature/);
  assert.match(script, /\.Status -ne ['"]Valid['"]/);
  assert.match(script, /TimeStamperCertificate/);
  assert.match(script, /SignerCertificate/);
  assert.match(script, /Get-ChildItem[\s\S]*-Filter ['"]\*\.exe['"]/);
  assert.match(script, /\.Count -ne \$expectedNames\.Count/);
  assert.match(script, /FileVersion -ne \$version/);
  assert.match(script, /SHA256SUMS\.txt/);
  assert.match(script, /release-verification\.json/);
  assert.match(script, /Get-FileHash[\s\S]*SHA256/);
});

test('标签发布强制 Windows 签名、签名安装回归、校验和与产物证明', () => {
  const workflow = readWorkflow('release.yml');

  assert.match(workflow, /tags:\s*\n\s+- ['"]v\*\.\*\.\*['"]/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /WIN_CSC_LINK: \$\{\{ secrets\.WIN_CSC_LINK \}\}/);
  assert.match(workflow, /WIN_CSC_KEY_PASSWORD: \$\{\{ secrets\.WIN_CSC_KEY_PASSWORD \}\}/);
  assert.match(workflow, /GITHUB_REF_NAME: \$\{\{ github\.ref_name \}\}/);
  assert.match(workflow, /Get-Content desktop\/package\.json/);
  assert.match(workflow, /\$env:GITHUB_REF_NAME -ne "v\$version"/);
  assert.match(workflow, /--config\.win\.forceCodeSigning=true/);
  assert.match(workflow, /verify-signed-release\.ps1/);
  assert.match(workflow, /validate-windows-installer\.ps1/);
  assert.match(workflow, /-RequireValidSignature/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /release-verification\.json/);
  assert.match(workflow, /actions\/attest@v4/);
  assert.match(workflow, /subject-path: desktop\/release\/\*\.exe/);
  assert.match(workflow, /softprops\/action-gh-release@v2/);
  assert.match(workflow, /desktop\/release\/SHA256SUMS\.txt/);
  assert.match(workflow, /desktop\/release\/release-verification\.json/);
});
