'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const installerPath = path.join(repoRoot, 'deploy', 'install-external-model-evidence-only.sh');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runLinux(command, args = [], { env = {}, input, root = false } = {}) {
  if (process.platform === 'win32') {
    return spawnSync('wsl.exe', [
      ...(root ? ['-u', 'root'] : []), '--exec', 'env',
      ...Object.entries(env).map(([key, value]) => `${key}=${value}`), command, ...args,
    ], { encoding: 'utf8', input });
  }
  if (root && typeof process.getuid === 'function' && process.getuid() !== 0) {
    return { status: 126, stdout: '', stderr: 'root test execution unavailable' };
  }
  return spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env }, input });
}

function writeLinuxFile(filePath, content, mode = '0644') {
  const result = runLinux('bash', ['-s'], {
    root: true,
    input: [
      'set -euo pipefail',
      `install -d -o root -g root -m 0755 ${shellQuote(path.posix.dirname(filePath))}`,
      `base64 -d > ${shellQuote(filePath)} <<'EXTERNAL_ONLY_TEST_EOF'`,
      Buffer.from(content).toString('base64'),
      'EXTERNAL_ONLY_TEST_EOF',
      `chown root:root ${shellQuote(filePath)}`,
      `chmod ${mode} ${shellQuote(filePath)}`,
    ].join('\n'),
  });
  assert.equal(result.status, 0, result.stderr);
}

function readLinuxFile(filePath) {
  const result = runLinux('cat', [filePath], { root: true });
  assert.equal(result.status, 0, result.stderr);
  return Buffer.from(result.stdout);
}

const bashProbe = runLinux('bash', ['-lc', 'command -v flock >/dev/null && command -v sha256sum >/dev/null && command -v node >/dev/null && test -x /usr/bin/python3']);
const nodeProbe = bashProbe.status === 0 ? runLinux('bash', ['-lc', 'command -v node']) : { status: 1, stdout: '' };
const linuxNodeBinary = nodeProbe.status === 0 ? nodeProbe.stdout.trim() : '';
const rootProbe = bashProbe.status === 0 ? runLinux('id', ['-u'], { root: true }) : { status: 1, stdout: '' };
const available = bashProbe.status === 0 && nodeProbe.status === 0
  && rootProbe.status === 0 && rootProbe.stdout.trim() === '0';

function makeFixture(t, { failFinal = false } = {}) {
  const temp = runLinux('mktemp', ['-d', '/tmp/external-evidence-only.XXXXXX'], { root: true });
  assert.equal(temp.status, 0, temp.stderr);
  const root = temp.stdout.trim();
  t.after(() => runLinux('rm', ['-rf', '--', root], { root: true }));
  const releasesRoot = `${root}/releases`;
  const expected = `${releasesRoot}/expected`;
  const candidate = `${releasesRoot}/candidate`;
  const sharedRoot = `${root}/shared`;
  const guardRoot = `${sharedRoot}/release-guard`;
  const evidenceRoot = `${sharedRoot}/release-evidence/external-models-v1`;
  const staging = `${sharedRoot}/release-evidence-staging/reviewed`;
  const currentLink = `${root}/current`;
  const database = `${root}/production.sqlite`;
  const trustedNode = `${root}/trusted-node`;
  const testInstaller = `${root}/install-external-model-evidence-only.sh`;
  const setup = runLinux('bash', ['-s'], {
    root: true,
    input: [
      'set -euo pipefail',
      `install -d -o root -g root -m 0755 ${shellQuote(expected)} ${shellQuote(candidate + '/deploy/release-guard')} ${shellQuote(guardRoot)} ${shellQuote(evidenceRoot)} ${shellQuote(staging)}`,
      `ln -s ${shellQuote(expected)} ${shellQuote(currentLink)}`,
      `printf '%s\n' database-unchanged > ${shellQuote(database)}`,
      `printf '%s\n' '{"contract_version":"external-model-release-evidence-manifest-v1","evidence":{"toapis-video-real-verification-v1":{"file":"toapis-video-verification.json","sha256":"old"},"toapis-private-avatar-video-verification-v1":{"file":"toapis-private-avatar-verification.json","sha256":"private-old"}}}' > ${shellQuote(evidenceRoot + '/manifest.json')}`,
      `printf '%s\n' old-evidence > ${shellQuote(evidenceRoot + '/toapis-video-verification.json')}`,
      `printf '%s\n' private-old-evidence > ${shellQuote(evidenceRoot + '/toapis-private-avatar-verification.json')}`,
      `printf '%s\n' '{"contract_version":"external-model-release-evidence-manifest-v1","evidence":{"toapis-video-real-verification-v1":{"file":"toapis-video-verification.json","sha256":"old"},"toapis-private-avatar-video-verification-v1":{"file":"toapis-private-avatar-verification.json","sha256":"private-new"},"toapis-wan3-video-real-verification-v1":{"file":"toapis-wan3-video-verification.json","sha256":"new"}}}' > ${shellQuote(staging + '/manifest.json')}`,
      `printf '%s\n' old-evidence > ${shellQuote(staging + '/toapis-video-verification.json')}`,
      `printf '%s\n' private-new-evidence > ${shellQuote(staging + '/toapis-private-avatar-verification.json')}`,
      `printf '%s\n' wan3-evidence > ${shellQuote(staging + '/toapis-wan3-video-verification.json')}`,
      `chown -R root:root ${shellQuote(root)}`,
      `find -P ${shellQuote(root)} -type d -exec chmod 0755 {} +`,
      `find -P ${shellQuote(root)} -type f -exec chmod 0644 {} +`,
    ].join('\n'),
  });
  assert.equal(setup.status, 0, setup.stderr);

  for (const [name, content] of [
    ['activate-protected-release.sh', '#!/bin/sh\nexit 0\n'],
    ['verify-protected-release.js', 'process.exit(0); // ui\n'],
    ['verify-canvas-reference-sequence-contract.js', 'process.exit(0); // sequence\n'],
  ]) writeLinuxFile(`${guardRoot}/${name}`, content, '0555');
  writeLinuxFile(trustedNode, `#!/bin/sh\nexec /usr/bin/env -u PWD ${shellQuote(linuxNodeBinary)} "$@"\n`, '0555');
  const oldExternal = 'process.exit(0); // reviewed-old-external\n';
  writeLinuxFile(`${guardRoot}/verify-external-model-release.js`, oldExternal, '0555');
  const candidateExternal = failFinal
    ? `const path=require('node:path'); process.exit(path.resolve(process.argv[3]) === ${JSON.stringify(evidenceRoot)} ? 91 : 0);\n`
    : 'process.exit(process.argv.length === 5 ? 0 : 64); // reviewed-new-external\n';
  writeLinuxFile(`${candidate}/deploy/release-guard/verify-external-model-release.js`, candidateExternal, '0555');

  let source = fs.readFileSync(installerPath, 'utf8')
    .replaceAll('/usr/bin/node', trustedNode)
    .replace(/^RELEASES_ROOT='\/opt\/moli-drama\/releases'$/m, `RELEASES_ROOT='${releasesRoot}'`)
    .replace(/^CURRENT_LINK='\/opt\/moli-drama\/current'$/m, `CURRENT_LINK='${currentLink}'`)
    .replace(/^SHARED_ROOT='\/opt\/moli-drama\/shared'$/m, `SHARED_ROOT='${sharedRoot}'`)
    .replace(/EXPECTED_INSTALLED_EXTERNAL_VERIFIER_SHA256='[a-f0-9]{64}'/, `EXPECTED_INSTALLED_EXTERNAL_VERIFIER_SHA256='${sha256(oldExternal)}'`)
    .replace(/EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256='[a-f0-9]{64}'/, `EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256='${sha256(candidateExternal)}'`);
  writeLinuxFile(testInstaller, source, '0555');
  return {
    root, candidate, expected, sharedRoot, guardRoot, evidenceRoot, staging,
    currentLink, database, testInstaller, oldExternal,
  };
}

function statIdentity(filePath) {
  const result = runLinux('stat', ['-c', '%i|%Y|%s|%a|%u:%g', '--', filePath], { root: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runInstaller(current) {
  return runLinux('/bin/bash', ['-p', current.testInstaller, current.candidate, current.expected, current.staging], { root: true });
}

test('external-only installer source cannot mutate unrelated production surfaces', () => {
  assert.equal(fs.existsSync(installerPath), true, 'missing external-only installer');
  const source = fs.readFileSync(installerPath, 'utf8');
  for (const forbidden of ['systemctl', 'sqlite3', 'ln -sfn', 'verify-protected-release.js.next',
    'verify-canvas-reference-sequence-contract.js.next', 'activate-protected-release.sh.next',
    'mv -T "$EVIDENCE_TARGET"']) {
    assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), forbidden);
  }
  assert.match(source, /RENAME_EXCHANGE = 2/);
});

test('external-only transaction updates only external verifier and evidence', { skip: !available }, (t) => {
  assert.equal(fs.existsSync(installerPath), true, 'missing external-only installer');
  const current = makeFixture(t);
  const untouched = [
    `${current.guardRoot}/activate-protected-release.sh`,
    `${current.guardRoot}/verify-protected-release.js`,
    `${current.guardRoot}/verify-canvas-reference-sequence-contract.js`,
    current.database,
  ];
  const before = new Map(untouched.map((file) => [file, [sha256(readLinuxFile(file)), statIdentity(file)]]));
  const currentBefore = runLinux('readlink', ['-f', '--', current.currentLink], { root: true }).stdout.trim();
  const result = runInstaller(current);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(sha256(readLinuxFile(`${current.guardRoot}/verify-external-model-release.js`)),
    sha256(readLinuxFile(`${current.candidate}/deploy/release-guard/verify-external-model-release.js`)));
  assert.match(readLinuxFile(`${current.evidenceRoot}/manifest.json`).toString(), /toapis-wan3-video-real-verification-v1/);
  for (const file of untouched) assert.deepEqual([sha256(readLinuxFile(file)), statIdentity(file)], before.get(file), file);
  assert.equal(runLinux('readlink', ['-f', '--', current.currentLink], { root: true }).stdout.trim(), currentBefore);
});

test('external-only transaction rejects an unknown installed verifier before writes', { skip: !available }, (t) => {
  assert.equal(fs.existsSync(installerPath), true, 'missing external-only installer');
  const current = makeFixture(t);
  writeLinuxFile(`${current.guardRoot}/verify-external-model-release.js`, 'process.exit(0); // unknown\n', '0555');
  const evidenceBefore = sha256(readLinuxFile(`${current.evidenceRoot}/manifest.json`));
  const backupBefore = runLinux('find', [`${current.guardRoot}/backups`, '-mindepth', '1', '-maxdepth', '1'], { root: true });
  const result = runInstaller(current);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hash mismatch|reviewed/i);
  assert.equal(sha256(readLinuxFile(`${current.evidenceRoot}/manifest.json`)), evidenceBefore);
  const backupAfter = runLinux('find', [`${current.guardRoot}/backups`, '-mindepth', '1', '-maxdepth', '1'], { root: true });
  assert.equal(backupAfter.stdout, backupBefore.stdout);
});

test('external-only transaction rolls back verifier and evidence after final verification failure', { skip: !available }, (t) => {
  assert.equal(fs.existsSync(installerPath), true, 'missing external-only installer');
  const current = makeFixture(t, { failFinal: true });
  const oldExternalSha = sha256(readLinuxFile(`${current.guardRoot}/verify-external-model-release.js`));
  const oldEvidenceSha = sha256(readLinuxFile(`${current.evidenceRoot}/manifest.json`));
  const result = runInstaller(current);
  assert.notEqual(result.status, 0);
  assert.equal(sha256(readLinuxFile(`${current.guardRoot}/verify-external-model-release.js`)), oldExternalSha);
  assert.equal(sha256(readLinuxFile(`${current.evidenceRoot}/manifest.json`)), oldEvidenceSha);
  assert.doesNotMatch(readLinuxFile(`${current.evidenceRoot}/manifest.json`).toString(), /toapis-wan3/);
});
