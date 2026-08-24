'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const zlib = require('node:zlib');

const repoRoot = path.resolve(__dirname, '..', '..');
const activatorPath = path.join(repoRoot, 'deploy', 'release-guard', 'activate-protected-release.sh');
const rotationPath = path.join(repoRoot, 'deploy', 'rotate-external-model-release-guard.sh');
const externalVerifierPath = path.join(repoRoot, 'deploy', 'release-guard', 'verify-external-model-release.js');
const uiVerifierPath = path.join(repoRoot, 'backend-node', 'src', 'services', 'canvasCreditReleaseContract.js');

const OLD_ACTIVATOR_SHA256 = 'ddd106c9f3e5d66537687e45d98d89b8c9112dd0038ab5d2e1daad61e5de0cf4';
const OLD_UI_VERIFIER_SHA256 = '6ba3d9c34bebd27e96f7c431cc1eeb606bb9c624982e687632d16eccf6609b8b';
const OLD_SEQUENCE_VERIFIER_SHA256 = 'b0fce00c3155cb14c59962239abea8bdf6eb876b7f3b490458fc018be3c6adfe';
const INSTALLED_UI_VERIFIER_SHA256 = '71058262a6098d636777cbbcd41a68c87d3a28d909c2bd98abac6e86e98a577b';
const INSTALLED_EXTERNAL_VERIFIER_SHA256 = 'fc58e3e7c94e3215b43406793fb974a4804cebc69617855e5a550bb86806ee35';

// Exact production guard inputs are compressed so the rotation transaction can
// exercise the hard-coded old-file CAS without adding a production bypass.
const OLD_GUARD_GZIP = {
  activator: 'H4sIAAAAAAACCq1WYW/bNhD9zl9xYY2hKUDL9pYEseEAhqNiRt24c5xhRVEItHSKuMiUS1JugtT/faAsKZLlLA22bzHIu3vv3ntU3hw5qVbOUkgH5QaWXEdEowGGaQJrscaQi5gQEcKXL0BbbygwidCDr18HYCKUBAD9KAGaan6LfWh1YDy6upxcjhauN3en7ujaBfevT+544V5645v53L1aULj4pWcr74WB099IKAjJ715789lsMaStx4+z6cS7nI8+jrzaWZ85ydo4qyQWLFB8xR2FMXKNektJPsCbTq4+7DWpHjV7+KlSKM2WkuvfR3P38hCMykmzgY64wuCp/k93Pnk/cedD2qrUFVjZbcpV4GxQifCBrVVi0DcYsPy4/bem5Nr948a9GruvauVzueGaKQxRofSRafyWZn/4iTSK+ybrPZ2NP3jvJ1N3r2eA6zh5aMeJf0dz0Y+AIdBWl8KPH8WPHm0awOcyEAE3CFwGgPfrjBHki4VVqg0sExNZ1bWpW+DUWqD0zZC23irk8ZqbCBjLhh9Tsu+i5rWevUZ8ri3Gsh0FYVHSVs1G1Hl3DIMBAXh33GCwA4sgpBYBwl6lhT7IkZ/YHqi5X4xtev0npz+zsdeBIHiPPpxf0FapcKbjEYRWU2ASzvd04zIxESpYqyRIfSMSCbmzQGgQ0h7cKtS6JtnZSZba0XhxM5ruKRLEQt4BC60IldBZcYp3pF5H4Wh4cHVNk+W7KRD6EZe3GPRLvw0bXYD7JuXxsDGzyuZXy6b0u0W+F+MDWHaJhzK8JagsigKV3d9KaC3kbd3u581p+1l/fl4ZbSii/ZMDiUwCPMSslhXGFH5LhUK2TEUclEVNgNWyUtjHT/PZYrf/3K+7is/e7Gr6uc86WwrDIdDuAYLlJr18k15OLBhWR+WkOk9LrBGw3Rta/x+ziErieMn9u7fH8EgAYglMh/LANNp6rBp/2y4qbcPVBtgi/Jc7+7EhAFmC9YM2uPJNDAq14crA0+enrVFthI8ly9I0D6ssjbY7BmAHgElgDzIsUwN5i7K7/fJjUBgJQKFJlYQuAQgF2RLytIDK+hu8JN4bSp5jnZ02GL+eb7E9+5EyKsVS6CKUdVaDFxZSfx128kfIYxM9DDskTBR49ml87Lbbvc52AEGyU8lPVQyM2SHAmBaxfawY01HynaFSiYLImHXfcbq9s3an3Wl3+yenZ+fOrjdcOAFuHJnGcUXIYm43+7VUyO92EgDoGHENXRIkEsss5Pd3/6l1q9Z/cUk5DD9C/+4/bOq5iOnvwvgRBl6oklXjQX65zCS1cP4Dg380CbwKAAA=',
  uiVerifier: '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',
  sequenceVerifier: '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',
};

function oldGuardFile(name) {
  return zlib.gunzipSync(Buffer.from(OLD_GUARD_GZIP[name], 'base64'));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function runLinux(command, args = [], { env = {}, input, root = false } = {}) {
  if (process.platform === 'win32') {
    const wslArgs = [
      ...(root ? ['-u', 'root'] : []),
      '--exec',
      'env',
      ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      command,
      ...args,
    ];
    return spawnSync('wsl.exe', wslArgs, { encoding: 'utf8', input });
  }
  if (root && typeof process.getuid === 'function' && process.getuid() !== 0) {
    return { status: 126, stdout: '', stderr: 'root test execution unavailable' };
  }
  return spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input,
  });
}

function linuxPath(filePath) {
  if (process.platform !== 'win32') return filePath;
  const result = spawnSync('wsl.exe', ['--exec', 'wslpath', '-a', filePath], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'wslpath failed');
  return result.stdout.trim();
}

const bashProbe = runLinux('bash', ['-lc', 'command -v flock >/dev/null && command -v sha256sum >/dev/null && command -v node >/dev/null && test -x /usr/bin/python3']);
const bashAvailable = bashProbe.status === 0;
const nodeProbe = bashAvailable ? runLinux('bash', ['-lc', 'command -v node']) : { status: 1, stdout: '' };
const linuxNodeBinary = nodeProbe.status === 0 ? nodeProbe.stdout.trim() : '';
const linuxRuntimePath = nodeProbe.status === 0
  ? `${path.posix.dirname(nodeProbe.stdout.trim())}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
  : '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const rootProbe = bashAvailable ? runLinux('id', ['-u'], { root: true }) : { status: 1, stdout: '' };
const rootBashAvailable = rootProbe.status === 0 && rootProbe.stdout.trim() === '0';

function makeActivatorFixture(t) {
  const temp = runLinux('mktemp', ['-d', '/tmp/shared-release-activator.XXXXXX'], { root: true });
  assert.equal(temp.status, 0, temp.stderr);
  const root = temp.stdout.trim();
  t.after(() => {
    assert.match(root, /^\/tmp\/shared-release-activator\.[A-Za-z0-9]+$/);
    runLinux('rm', ['-rf', '--', root], { root: true });
  });
  const releasesRoot = `${root}/releases`;
  const expected = `${releasesRoot}/expected`;
  const candidate = `${releasesRoot}/candidate`;
  const sharedRoot = `${root}/shared`;
  const guardRoot = `${sharedRoot}/release-guard`;
  const evidenceRoot = `${sharedRoot}/release-evidence/external-models-v1`;
  const currentLink = `${root}/current`;
  const trustedNode = `${root}/trusted-node`;
  const testActivator = `${root}/activate-protected-release.sh`;
  const setup = runLinux('bash', ['-s'], {
    root: true,
    input: [
      'set -euo pipefail',
      `install -d -o root -g root -m 0755 ${shellQuote(expected)} ${shellQuote(candidate)} ${shellQuote(guardRoot)} ${shellQuote(evidenceRoot)}`,
      `printf '%s\\n' candidate-v1 > ${shellQuote(candidate + '/payload.txt')}`,
      `printf '%s\\n' expected-v1 > ${shellQuote(expected + '/payload.txt')}`,
      `ln -s ${shellQuote(expected)} ${shellQuote(currentLink)}`,
      `chown -R root:root ${shellQuote(root)}`,
    ].join('\n'),
  });
  assert.equal(setup.status, 0, setup.stderr);
  writeLinuxFile(`${guardRoot}/verify-protected-release.js`, 'process.exit(0);\n', '0555');
  writeLinuxFile(`${guardRoot}/verify-canvas-reference-sequence-contract.js`, 'process.exit(0);\n', '0555');
  writeLinuxFile(`${guardRoot}/verify-external-model-release.js`, 'process.exit(0);\n', '0555');
  writeLinuxFile(trustedNode, `#!/bin/sh\nexec /usr/bin/env -u PWD ${shellQuote(linuxNodeBinary)} "$@"\n`, '0555');
  const materializeActivator = (commandOverrides = {}) => {
    const replacements = {
      '/usr/bin/node': trustedNode,
      '/opt/moli-drama/releases': releasesRoot,
      '/opt/moli-drama/current': currentLink,
      '/opt/moli-drama/shared': sharedRoot,
      ...commandOverrides,
    };
    let activatorSource = fs.readFileSync(activatorPath, 'utf8');
    for (const [productionPath, testPath] of Object.entries(replacements)) {
      activatorSource = activatorSource.replaceAll(productionPath, testPath);
    }
    writeLinuxFile(testActivator, activatorSource, '0555');
  };
  materializeActivator();
  const linux = { root, releasesRoot, expected, candidate, sharedRoot, guardRoot, evidenceRoot, currentLink, trustedNode, testActivator };
  return { root, releasesRoot, expected, candidate, sharedRoot, guardRoot, evidenceRoot, currentLink, trustedNode, testActivator, materializeActivator, linux };
}

function runActivator(fixture, extraEnv = {}) {
  return runLinux('/bin/bash', ['-p', fixture.linux.testActivator, fixture.linux.candidate, fixture.linux.expected], {
    root: true,
    env: {
      MOLI_DRAMA_RELEASES_ROOT: fixture.linux.releasesRoot,
      MOLI_DRAMA_CURRENT_LINK: fixture.linux.currentLink,
      MOLI_DRAMA_SHARED_ROOT: fixture.linux.sharedRoot,
      PATH: linuxRuntimePath,
      ...extraEnv,
    },
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function writeLinuxFile(filePath, content, mode = '0644') {
  const script = [
    `install -d -o root -g root -m 0755 ${shellQuote(path.posix.dirname(filePath))}`,
    `base64 -d > ${shellQuote(filePath)} <<'GUARD_TEST_EOF'`,
    Buffer.from(content).toString('base64'),
    'GUARD_TEST_EOF',
    `chown root:root ${shellQuote(filePath)}`,
    `chmod ${mode} ${shellQuote(filePath)}`,
  ].join('\n');
  const result = runLinux('bash', ['-s'], { root: true, input: script });
  assert.equal(result.status, 0, result.stderr);
}

function makeRotationFixture(t) {
  const temp = runLinux('mktemp', ['-d', '/tmp/shared-release-rotation.XXXXXX'], { root: true });
  assert.equal(temp.status, 0, temp.stderr);
  const root = temp.stdout.trim();
  t.after(() => {
    assert.match(root, /^\/tmp\/shared-release-rotation\.[A-Za-z0-9]+$/);
    runLinux('rm', ['-rf', '--', root], { root: true });
  });

  const releasesRoot = `${root}/releases`;
  const candidate = `${releasesRoot}/candidate`;
  const source = candidate;
  const expected = `${releasesRoot}/expected`;
  const sharedRoot = `${root}/shared`;
  const guardRoot = `${sharedRoot}/release-guard`;
  const evidenceStaging = `${sharedRoot}/release-evidence-staging/reviewed`;
  const currentLink = `${root}/current`;
  const trustedNode = `${root}/trusted-node`;
  const testRotation = `${root}/rotate-external-model-release-guard.sh`;
  const setup = runLinux('bash', ['-s'], {
    root: true,
    input: [
      'set -euo pipefail',
      `install -d -o root -g root -m 0755 ${shellQuote(candidate + '/deploy/release-guard')} ${shellQuote(candidate + '/backend-node/src/services')} ${shellQuote(expected)} ${shellQuote(guardRoot)} ${shellQuote(evidenceStaging + '/assets')}`,
      `printf '%s\\n' candidate > ${shellQuote(candidate + '/payload.txt')}`,
      `printf '%s\\n' expected > ${shellQuote(expected + '/payload.txt')}`,
      `ln -s ${shellQuote(expected)} ${shellQuote(currentLink)}`,
      `printf '%s\\n' '{}' > ${shellQuote(evidenceStaging + '/manifest.json')}`,
      `printf '%s\\n' '{}' > ${shellQuote(evidenceStaging + '/toapis-video-verification.json')}`,
      `printf '%s\\n' '{}' > ${shellQuote(evidenceStaging + '/usmercari-image-verification.json')}`,
      `printf '%s\\n' artifact > ${shellQuote(evidenceStaging + '/assets/result.bin')}`,
      `chown -R root:root ${shellQuote(root)}`,
      `find ${shellQuote(root)} -type d -exec chmod 0755 {} +`,
      `find ${shellQuote(root)} -type f -exec chmod 0644 {} +`,
    ].join('\n'),
  });
  assert.equal(setup.status, 0, setup.stderr);

  writeLinuxFile(`${guardRoot}/activate-protected-release.sh`, oldGuardFile('activator'), '0555');
  writeLinuxFile(`${guardRoot}/verify-protected-release.js`, oldGuardFile('uiVerifier'), '0555');
  writeLinuxFile(`${guardRoot}/verify-canvas-reference-sequence-contract.js`, oldGuardFile('sequenceVerifier'), '0555');
  writeLinuxFile(`${candidate}/frontweb/src/utils/freeCanvasGeneration.js`, [
    'export function buildFreeCanvasReferenceMentionCandidates(references = []) {',
    '  return references.map((reference, index) => ({',
    '    ...reference,',
    '    label: `图片${index + 1}`,',
    '    mentionToken: `@图片${index + 1}`,',
    '  })).filter((reference) => reference.ready && reference.enabled !== false)',
    '}',
  ].join('\n'));
  for (const view of ['DramaCanvas.vue', 'HomeCanvas.vue']) {
    writeLinuxFile(`${candidate}/frontweb/src/views/${view}`, [
      'function freeCanvasReferenceCandidates() {',
      '  return buildFreeCanvasReferenceMentionCandidates(',
      '    collectDirectUpstreamImageReferences()',
      '  )',
      '}',
    ].join('\n'));
  }
  writeLinuxFile(`${candidate}/frontweb/src/components/dramaCanvas/HomeCanvasNode.vue`, [
    '<template>',
    '  <div class="billing-cost" aria-live="polite">',
    '    本次预计扣除 <strong>{{ estimatedCredits }}</strong> 积分',
    '    <span>积分待管理员配置</span>',
    '    <span>{{ candidate.label }}</span>',
    '  </div>',
    '</template>',
    '<script setup>',
    "const contract = 'canvas-reference-numbered-mentions-v1'",
    'const mentionToken = candidate?.mentionToken',
    'const inserted = `${mentionToken} `',
    '</script>',
    '<style>',
    '.billing-cost { border: 1px solid; background: red; font-weight: 800; }',
    '.billing-cost strong { font-weight: 900; }',
    '</style>',
  ].join('\n'));
  writeLinuxFile(`${candidate}/frontweb/dist/assets/app.js`, '本次预计扣除 billing-cost 积分待管理员配置\n');
  writeLinuxFile(`${candidate}/frontweb/dist/assets/app.css`, [
    '.billing-cost{background:red;border:1px solid;font-weight:800}',
    '.billing-cost strong{font-weight:900}',
  ].join('\n'));
  writeLinuxFile(trustedNode, `#!/bin/sh\nexec /usr/bin/env -u PWD ${shellQuote(linuxNodeBinary)} "$@"\n`, '0555');
  const testActivatorSource = fs.readFileSync(activatorPath, 'utf8').replaceAll('/usr/bin/node', trustedNode);
  writeLinuxFile(`${source}/deploy/release-guard/activate-protected-release.sh`, testActivatorSource, '0555');
  const externalVerifierSource = `
    const fs = require('node:fs');
    if (process.argv.length !== 5) process.exit(64);
    if (process.env.NODE_OPTIONS || process.env.NODE_PATH || process.env.PATH !== '/usr/sbin:/usr/bin:/sbin:/bin') process.exit(90);
    fs.accessSync(process.argv[2]);
    fs.accessSync(process.argv[3]);
    fs.accessSync(process.argv[4]);
  `;
  writeLinuxFile(`${source}/deploy/release-guard/verify-external-model-release.js`, externalVerifierSource, '0555');
  writeLinuxFile(`${source}/backend-node/src/services/canvasCreditReleaseContract.js`, 'process.exit(0); // reviewed new UI verifier\n', '0555');

  const materializeRotation = ({ failAfterActivatorInstall = false } = {}) => {
    const candidateActivator = readLinuxFile(`${source}/deploy/release-guard/activate-protected-release.sh`);
    const candidateExternalVerifier = readLinuxFile(`${source}/deploy/release-guard/verify-external-model-release.js`);
    const candidateUiVerifier = readLinuxFile(`${source}/backend-node/src/services/canvasCreditReleaseContract.js`);
    let rotationSource = fs.readFileSync(rotationPath, 'utf8')
      .replaceAll('/usr/bin/node', trustedNode)
      .replace(/^RELEASES_ROOT='\/opt\/moli-drama\/releases'$/m, `RELEASES_ROOT='${releasesRoot}'`)
      .replace(/^CURRENT_LINK='\/opt\/moli-drama\/current'$/m, `CURRENT_LINK='${currentLink}'`)
      .replace(/^SHARED_ROOT='\/opt\/moli-drama\/shared'$/m, `SHARED_ROOT='${sharedRoot}'`);
    rotationSource = rotationSource.replace(
      /EXPECTED_NEW_ACTIVATOR_SHA256='[a-f0-9]{64}'/,
      `EXPECTED_NEW_ACTIVATOR_SHA256='${sha256(candidateActivator)}'`,
    );
    rotationSource = rotationSource.replace(
      /EXPECTED_INSTALLED_ACTIVATOR_SHA256='[a-f0-9]{64}'/,
      `EXPECTED_INSTALLED_ACTIVATOR_SHA256='${sha256(candidateActivator)}'`,
    );
    rotationSource = rotationSource.replace(
      /EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256='[a-f0-9]{64}'/,
      `EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256='${sha256(candidateExternalVerifier)}'`,
    );
    const installedExternalPath = `${guardRoot}/verify-external-model-release.js`;
    const installedExternalExists = runLinux('test', ['-f', installedExternalPath], { root: true }).status === 0;
    const installedExternalHash = installedExternalExists
      ? sha256(readLinuxFile(installedExternalPath))
      : sha256(candidateExternalVerifier);
    rotationSource = rotationSource.replace(
      /EXPECTED_INSTALLED_EXTERNAL_VERIFIER_SHA256='[a-f0-9]{64}'/,
      `EXPECTED_INSTALLED_EXTERNAL_VERIFIER_SHA256='${installedExternalHash}'`,
    );
    rotationSource = rotationSource.replace(
      /EXPECTED_INSTALLED_UI_VERIFIER_SHA256='[a-f0-9]{64}'/,
      `EXPECTED_INSTALLED_UI_VERIFIER_SHA256='${sha256(candidateUiVerifier)}'`,
    );
    rotationSource = rotationSource.replace(
      /EXPECTED_NEW_UI_VERIFIER_SHA256='[a-f0-9]{64}'/,
      `EXPECTED_NEW_UI_VERIFIER_SHA256='${sha256(candidateUiVerifier)}'`,
    );
    if (failAfterActivatorInstall) {
      rotationSource = rotationSource.replace(
        'mv -Tf "$ACTIVATOR_NEXT" "$OLD_ACTIVATOR"',
        'mv -Tf "$ACTIVATOR_NEXT" "$OLD_ACTIVATOR"\nfalse # test-only failure after activator install',
      );
    }
    writeLinuxFile(testRotation, rotationSource, '0555');
  };
  materializeRotation();

  return {
    root,
    releasesRoot,
    source,
    candidate,
    expected,
    sharedRoot,
    guardRoot,
    evidenceStaging,
    currentLink,
    trustedNode,
    testRotation,
    materializeRotation,
  };
}

function runRotation(fixture, extraEnv = {}) {
  return runLinux('/bin/bash', [
    '-p',
    fixture.testRotation,
    fixture.source,
    fixture.candidate,
    fixture.expected,
    fixture.evidenceStaging,
  ], {
    root: true,
    env: {
      MOLI_DRAMA_RELEASES_ROOT: fixture.releasesRoot,
      MOLI_DRAMA_CURRENT_LINK: fixture.currentLink,
      MOLI_DRAMA_SHARED_ROOT: fixture.sharedRoot,
      PATH: linuxRuntimePath,
      ...extraEnv,
    },
  });
}

function readLinuxFile(filePath) {
  const result = runLinux('base64', ['-w0', filePath], { root: true });
  assert.equal(result.status, 0, result.stderr);
  return Buffer.from(result.stdout, 'base64');
}

function configureActualActivation(fixture, options = {}) {
  const operationsRoot = `${fixture.root}/operations`;
  const databasePath = `${operationsRoot}/production.sqlite`;
  const backupDir = `${operationsRoot}/backups`;
  const processState = `${operationsRoot}/music-processes.txt`;
  const serviceLog = `${operationsRoot}/systemctl.log`;
  const candidateBackupMarker = `${operationsRoot}/candidate-backup-executed`;
  const candidateModuleMarker = `${operationsRoot}/candidate-module-loaded`;
  const systemctl = `${operationsRoot}/systemctl`;
  const curl = `${operationsRoot}/curl`;
  const journalctl = `${operationsRoot}/journalctl`;
  const ps = `${operationsRoot}/ps`;
  const sleep = `${operationsRoot}/sleep`;
  const postStopPendingFlag = `${operationsRoot}/post-stop-pending`;
  const mutateCandidateFlag = `${operationsRoot}/mutate-candidate`;
  const musicDriftFlag = `${operationsRoot}/music-drift`;
  const fatalJournalFlag = `${operationsRoot}/fatal-journal`;
  const healthFailureFlag = `${operationsRoot}/health-failure`;
  const healthCallCount = `${operationsRoot}/health-call-count`;
  const stopFailureFlag = `${operationsRoot}/stop-failure`;
  const currentDriftFlag = `${operationsRoot}/current-drift`;

  const setup = runLinux('/bin/bash', ['-s'], {
    root: true,
    input: [
      'set -euo pipefail',
      `install -d -o root -g root -m 0755 ${shellQuote(operationsRoot)} ${shellQuote(fixture.candidate + '/backend-node/scripts')} ${shellQuote(fixture.candidate + '/backend-node/node_modules/better-sqlite3')}`,
      `printf '%s\n' 'ubuntu 101 Mon Aug 7 10:00:00 2026 /usr/bin/node /opt/moli-mama/server/server.js' 'ubuntu 201 Mon Aug 7 10:00:00 2026 /usr/bin/node /opt/moli-mama/server/worker.js' > ${shellQuote(processState)}`,
      `chown -R root:root ${shellQuote(operationsRoot)} ${shellQuote(fixture.candidate + '/backend-node')}`,
      `find ${shellQuote(operationsRoot)} ${shellQuote(fixture.candidate + '/backend-node')} -type d -exec chmod 0755 {} +`,
      `find ${shellQuote(operationsRoot)} ${shellQuote(fixture.candidate + '/backend-node')} -type f -exec chmod 0644 {} +`,
    ].join('\n'),
  });
  assert.equal(setup.status, 0, setup.stderr);

  const databaseSetup = runLinux('/usr/bin/python3', ['-c', [
    'import sqlite3, sys',
    'database = sqlite3.connect(sys.argv[1])',
    'for table in ("async_tasks", "image_generations", "video_generations"):',
    '    database.execute(f\'CREATE TABLE "{table}" (id INTEGER PRIMARY KEY, status TEXT NOT NULL)\')',
    'database.commit()',
    'database.close()',
  ].join('\n'), databasePath], { root: true });
  assert.equal(databaseSetup.status, 0, databaseSetup.stderr);
  const databasePermissions = runLinux('chmod', ['0600', databasePath], { root: true });
  assert.equal(databasePermissions.status, 0, databasePermissions.stderr);

  writeLinuxFile(`${fixture.sharedRoot}/production.env`, [
    `DATABASE_PATH=${databasePath}`,
    `DATA_BACKUP_DIR=${backupDir}`,
    'DATA_BACKUP_RETENTION=3',
    `DATA_BACKUP_MIN_FREE_BYTES=${options.backupFails ? '9007199254740991' : '0'}`,
    'PROVIDER_SECRET=must-not-reach-child',
    '',
  ].join('\n'), '0400');

  writeLinuxFile(`${fixture.candidate}/backend-node/node_modules/better-sqlite3/index.js`, `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(candidateModuleMarker)}, 'candidate module executed');
    throw new Error('candidate better-sqlite3 must never execute as root');
  `, '0444');

  writeLinuxFile(`${fixture.candidate}/backend-node/scripts/database-backup.js`, `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(candidateBackupMarker)}, 'candidate backup executed');
    throw new Error('candidate backup helper must never execute as root');
  `, '0444');

  writeLinuxFile(systemctl, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${shellQuote(serviceLog)}
if [ "$1" = stop ] && [ -f ${shellQuote(postStopPendingFlag)} ]; then
  /usr/bin/python3 - ${shellQuote(databasePath)} <<'PYTHON'
import sqlite3
import sys
database = sqlite3.connect(sys.argv[1])
database.execute("INSERT INTO image_generations(status) VALUES ('pending')")
database.commit()
database.close()
PYTHON
fi
if [ "$1" = stop ] && [ -f ${shellQuote(stopFailureFlag)} ]; then
  exit 93
fi
if [ "$1" = stop ] && [ -f ${shellQuote(currentDriftFlag)} ]; then
  rm -f -- ${shellQuote(fixture.currentLink)}
  ln -s -- ${shellQuote(fixture.candidate)} ${shellQuote(fixture.currentLink)}
fi
if [ "$1" = restart ] && [ -f ${shellQuote(mutateCandidateFlag)} ]; then
  printf '%s\\n' post-health-mutation >> ${shellQuote(fixture.candidate + '/payload.txt')}
fi
if [ "$1" = restart ] && [ -f ${shellQuote(musicDriftFlag)} ]; then
  printf '%s\\n' 'ubuntu 999 Mon Aug 7 10:01:00 2026 /usr/bin/node /opt/moli-mama/server/server.js' > ${shellQuote(processState)}
fi
`, '0555');
  writeLinuxFile(curl, `#!/bin/sh
if [ -f ${shellQuote(healthFailureFlag)} ]; then
  count=0
  [ ! -f ${shellQuote(healthCallCount)} ] || count="$(cat ${shellQuote(healthCallCount)})"
  count=$((count + 1))
  printf '%s\n' "$count" > ${shellQuote(healthCallCount)}
  [ "$count" -gt 20 ]
fi
`, '0555');
  writeLinuxFile(journalctl, `#!/bin/sh
if [ -f ${shellQuote(fatalJournalFlag)} ]; then
  printf '%s\\n' 'FATAL startup contract failure'
else
  printf '%s\\n' 'moli-drama startup healthy'
fi
`, '0555');
  writeLinuxFile(ps, `#!/bin/sh
exec /bin/cat ${shellQuote(processState)}
`, '0555');
  writeLinuxFile(sleep, '#!/bin/sh\nexit 0\n', '0555');

  for (const [enabled, flag] of [
    [options.postStopPending, postStopPendingFlag],
    [options.mutateCandidate, mutateCandidateFlag],
    [options.musicDrift, musicDriftFlag],
    [options.fatalJournal, fatalJournalFlag],
    [options.healthFails, healthFailureFlag],
    [options.stopFails, stopFailureFlag],
    [options.currentDrifts, currentDriftFlag],
  ]) {
    if (enabled) writeLinuxFile(flag, 'enabled\n', '0444');
  }

  fixture.materializeActivator({
    '/usr/bin/systemctl': systemctl,
    '/usr/bin/curl': curl,
    '/usr/bin/journalctl': journalctl,
    '/usr/bin/ps': ps,
    '/usr/bin/sleep': sleep,
  });

  return {
    operationsRoot,
    databasePath,
    backupDir,
    processState,
    serviceLog,
    candidateBackupMarker,
    candidateModuleMarker,
  };
}

function insertPendingTask(databasePath, table) {
  assert.ok(['async_tasks', 'image_generations', 'video_generations'].includes(table));
  const result = runLinux('/usr/bin/python3', ['-c', [
    'import sqlite3, sys',
    'database = sqlite3.connect(sys.argv[1])',
    'database.execute(f\'INSERT INTO "{sys.argv[2]}"(status) VALUES (?)\', ("pending",))',
    'database.commit()',
    'database.close()',
  ].join('\n'), databasePath, table], { root: true });
  assert.equal(result.status, 0, result.stderr);
}

test('fixture embeds the exact three live guard CAS inputs', () => {
  assert.equal(sha256(oldGuardFile('activator')), OLD_ACTIVATOR_SHA256);
  assert.equal(sha256(oldGuardFile('uiVerifier')), OLD_UI_VERIFIER_SHA256);
  assert.equal(sha256(oldGuardFile('sequenceVerifier')), OLD_SEQUENCE_VERIFIER_SHA256);
});

test('activator preserves the live baseline and adds fixed external evidence plus TOCTOU checks', () => {
  const source = fs.readFileSync(activatorPath, 'utf8');
  assert.match(source, /^#!\/bin\/bash -p\nset -euo pipefail\n\nreadonly SAFE_PATH='\/usr\/sbin:\/usr\/bin:\/sbin:\/bin'/);
  assert.match(source, /readonly NODE_BINARY='\/usr\/bin\/node'/);
  assert.match(source, /stat .*'0:0'.*NODE_BINARY|NODE_BINARY.*root:root/s);
  assert.match(source, /unset NODE_OPTIONS NODE_PATH/);
  assert.match(source, /VERIFY_ONLY_REQUESTED/);
  assert.match(source, /RELEASES_ROOT='\/opt\/moli-drama\/releases'/);
  assert.match(source, /CURRENT_LINK='\/opt\/moli-drama\/current'/);
  assert.match(source, /SHARED_ROOT='\/opt\/moli-drama\/shared'/);
  assert.doesNotMatch(source, /MOLI_DRAMA_(?:RELEASES_ROOT|CURRENT_LINK|SHARED_ROOT)/);
  assert.match(source, /verify-protected-release\.js/);
  assert.match(source, /verify-canvas-reference-sequence-contract\.js/);
  assert.match(source, /verify-external-model-release\.js/);
  assert.match(source, /release-evidence\/external-models-v1/);
  assert.match(source, /env -i[\s\\]+PATH="\$SAFE_PATH"[\s\\]+LC_ALL=C[\s\\]+"\$NODE_BINARY" "\$EXTERNAL_MODEL_VERIFIER" "\$CANDIDATE" "\$EXTERNAL_MODEL_EVIDENCE_ROOT" "\$EXPECTED_CURRENT"/);
  assert.doesNotMatch(source, /\bnode "\$[^\n]*VERIFIER/);
  assert.doesNotMatch(source, /EXTERNAL_MODEL_(?:RELEASE_)?EVIDENCE(?:_ROOT)?[:-]/);
  assert.match(source, /find -P .* -type l/);
  assert.match(source, /candidate_tree_hash/);
  assert.match(source, /candidate tree changed during protected release verification/i);
  assert.ok((source.match(/assert_root_owned_evidence_tree/g) || []).length >= 4);
  assert.ok((source.match(/current release changed:/g) || []).length >= 1);
  assert.match(source, /PROTECTED_RELEASE_VERIFY_ONLY/);
  assert.match(source, /mv -Tf -- "\$temporary_link" "\$CURRENT_LINK"/);
  assert.match(source, /rollback_on_failure\(\)/);
  assert.match(source, /"\$SYSTEMCTL_BINARY" restart moli-drama\.service/);
  assert.match(source, /127\.0\.0\.1:5679\/health/);
});

test('actual activation has backup, quiescence, music isolation, audit, and three-snapshot rollback contracts', () => {
  const source = fs.readFileSync(activatorPath, 'utf8');
  assert.match(source, /readonly PYTHON_BINARY='\/usr\/bin\/python3'/);
  assert.ok((source.match(/assert_trusted_python/g) || []).length >= 2);
  assert.match(source, /PRODUCTION_ENV="\$SHARED_ROOT\/production\.env"/);
  for (const key of ['DATABASE_PATH', 'DATA_BACKUP_DIR', 'DATA_BACKUP_RETENTION', 'DATA_BACKUP_MIN_FREE_BYTES']) {
    assert.match(source, new RegExp(key));
  }
  assert.doesNotMatch(source, /(?:^|[;\s])(?:source|\.)\s+["']?\$?PRODUCTION_ENV/m);
  assert.match(source, /quick_check/);
  assert.match(source, /sha256/i);
  assert.doesNotMatch(source, /hashlib\.file_digest/);
  assert.match(source, /"\$PYTHON_BINARY" -I -S -/);
  assert.doesNotMatch(source, /\$CANDIDATE\/backend-node\/(?:scripts\/database-backup\.js|node_modules\/better-sqlite3)/);
  for (const table of ['async_tasks', 'image_generations', 'video_generations']) {
    assert.match(source, new RegExp(table));
  }
  assert.ok((source.match(/assert_no_active_generation_tasks/g) || []).length >= 3);
  assert.match(source, /SYSTEMCTL_BINARY[^\n]*stop[^\n]*moli-drama\.service/);
  assert.match(source, /\/opt\/moli-mama\/server\/server\.js/);
  assert.match(source, /\/opt\/moli-mama\/server\/worker\.js/);
  assert.match(source, /journalctl/);
  assert.match(source, /fatal|unhandled|EADDRINUSE|SyntaxError/i);
  assert.match(source, /release-audit/);
  assert.match(source, /chmod 0600/);
  assert.ok((source.match(/candidate_tree_hash/g) || []).length >= 4);
  assert.match(source, /post-health candidate tree changed/i);
  assert.match(source, /rollback.*health|health.*rollback/is);
});

test('full candidate hashes remain four while the downtime window contains only fast checks', () => {
  const source = fs.readFileSync(activatorPath, 'utf8');
  const requiredIndex = (needle, fromIndex = 0) => {
    const index = source.indexOf(needle, fromIndex);
    assert.notEqual(index, -1, `missing required activator marker: ${needle}`);
    return index;
  };
  const initialHash = requiredIndex('INITIAL_CANDIDATE_TREE_HASH="$(candidate_tree_hash)"');
  const postVerificationHash = requiredIndex('POST_VERIFICATION_CANDIDATE_TREE_HASH="$(candidate_tree_hash)"');
  const preSwitchHash = requiredIndex('PRE_SWITCH_CANDIDATE_TREE_HASH="$(candidate_tree_hash)"');
  const stop = requiredIndex('"$SYSTEMCTL_BINARY" stop moli-drama.service');
  const restart = requiredIndex('"$SYSTEMCTL_BINARY" restart moli-drama.service', stop + 1);
  const postHealthHash = requiredIndex('POST_HEALTH_CANDIDATE_TREE_HASH="$(candidate_tree_hash)"');

  assert.ok(initialHash < postVerificationHash);
  assert.ok(postVerificationHash < preSwitchHash);
  assert.ok(preSwitchHash < stop);
  assert.ok(stop < restart);
  assert.ok(restart < postHealthHash);

  const downtimeSource = source.slice(stop, restart);
  assert.doesNotMatch(downtimeSource, /candidate_tree_hash|find\s+[^\n]*-type\s+f|sha256sum\s+[^\n]*candidate/i);
  assert.match(downtimeSource, /assert_no_active_generation_tasks/);
  assert.match(downtimeSource, /assert_current_matches/);
  assert.match(downtimeSource, /assert_root_owned_evidence_tree/);
  assert.match(downtimeSource, /assert_candidate_lock_state/);
  assert.match(downtimeSource, /assert_production_env_unchanged/);
});

test('activation audit records monotonic phase timings without environment values', () => {
  const source = fs.readFileSync(activatorPath, 'utf8');
  assert.match(source, /monotonic_ms\(\)/);
  assert.match(source, /\/proc\/uptime/);
  for (const field of [
    'preflight_verification_ms', 'database_backup_ms', 'pre_switch_hash_ms',
    'service_stop_ms', 'post_stop_checks_ms', 'service_restart_ms',
    'health_wait_ms', 'post_health_hash_ms', 'downtime_window_ms',
  ]) assert.match(source, new RegExp(`audit_phase_timing ${field} `));
  assert.doesNotMatch(source, /audit_event[^\n]*(?:PROVIDER_SECRET|DATABASE_URL|API_KEY|TOKEN)=/);
});

test('activator rejects a candidate symlink that resolves outside releases root', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  const outside = `${fixture.root}/outside.txt`;
  const link = `${fixture.candidate}/outside-link`;
  writeLinuxFile(outside, 'outside\n');
  const linked = runLinux('ln', ['-s', outside, link], { root: true });
  assert.equal(linked.status, 0, linked.stderr);

  const result = runActivator(fixture, { PROTECTED_RELEASE_VERIFY_ONLY: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink.*outside/i);
});

test('activator fails closed when a shared verifier fails', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  writeLinuxFile(`${fixture.guardRoot}/verify-protected-release.js`, 'process.exit(41);\n', '0555');

  const result = runActivator(fixture, { PROTECTED_RELEASE_VERIFY_ONLY: '1' });
  assert.equal(result.status, 41, result.stderr);
  const current = runLinux('readlink', ['-f', fixture.linux.currentLink], { root: true });
  assert.equal(current.stdout.trim(), fixture.linux.expected);
});

test('activator ignores evidence-path env overrides and passes only the fixed shared root', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  const invocationLog = `${fixture.root}/external-verifier-args.json`;
  writeLinuxFile(`${fixture.guardRoot}/verify-external-model-release.js`, `
    require('node:fs').writeFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({
      args: process.argv.slice(2),
      env: process.env,
    }));
  `, '0555');

  const result = runActivator(fixture, {
    PROTECTED_RELEASE_VERIFY_ONLY: '1',
    EXTERNAL_MODEL_RELEASE_EVIDENCE_ROOT: `${fixture.root}/attacker-evidence`,
    NODE_OPTIONS: '--require=/attacker/preload.js',
    NODE_PATH: '/attacker/modules',
    PATH: '/attacker/bin',
    MOLI_DRAMA_RELEASES_ROOT: '/attacker/releases',
    MOLI_DRAMA_CURRENT_LINK: '/attacker/current',
    MOLI_DRAMA_SHARED_ROOT: '/attacker/shared',
  });
  assert.equal(result.status, 0, result.stderr);
  const logged = runLinux('cat', [invocationLog], { root: true });
  assert.equal(logged.status, 0, logged.stderr);
  const invocation = JSON.parse(logged.stdout);
  assert.deepEqual(invocation.args, [
    fixture.linux.candidate,
    fixture.linux.evidenceRoot,
    fixture.linux.expected,
  ]);
  assert.deepEqual(invocation.env, {
    LC_ALL: 'C',
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  });
});

test('verify-only performs no database backup, service operation, audit, or switch', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  const result = runActivator(fixture, { PROTECTED_RELEASE_VERIFY_ONLY: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(runLinux('test', ['-e', `${fixture.sharedRoot}/production.env`], { root: true }).status, 1);
  assert.equal(runLinux('test', ['-e', `${fixture.sharedRoot}/release-audit`], { root: true }).status, 1);
  const current = runLinux('readlink', ['-f', fixture.currentLink], { root: true });
  assert.equal(current.stdout.trim(), fixture.expected);
});

test('invalid verify-only mode fails closed without switching', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  const result = runActivator(fixture, { PROTECTED_RELEASE_VERIFY_ONLY: 'true' });
  assert.equal(result.status, 64, result.stderr);
  assert.match(result.stderr, /must be exactly 0 or 1/i);
  const current = runLinux('readlink', ['-f', fixture.currentLink], { root: true });
  assert.equal(current.stdout.trim(), fixture.expected);
});

test('activator rejects a writable resolved symlink target even when it stays in releases root', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  const target = `${fixture.releasesRoot}/shared-target.txt`;
  writeLinuxFile(target, 'reviewed\n', '0666');
  const linked = runLinux('ln', ['-s', target, `${fixture.candidate}/inside-link`], { root: true });
  assert.equal(linked.status, 0, linked.stderr);

  const result = runActivator(fixture, { PROTECTED_RELEASE_VERIFY_ONLY: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /resolved entry.*writable|resolved tree.*writable/i);
});

test('activator repeats current CAS after all verifiers', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  writeLinuxFile(`${fixture.guardRoot}/verify-external-model-release.js`, `
    const fs = require('node:fs');
    fs.unlinkSync(${JSON.stringify(fixture.linux.currentLink)});
    fs.symlinkSync(${JSON.stringify(fixture.linux.candidate)}, ${JSON.stringify(fixture.linux.currentLink)});
  `, '0555');

  const result = runActivator(fixture);
  assert.equal(result.status, 73, result.stderr);
  assert.match(result.stderr, /current release changed:/);
});

test('activator rejects candidate mutation performed after the initial snapshot audit', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  writeLinuxFile(`${fixture.guardRoot}/verify-external-model-release.js`, `
    require('node:fs').appendFileSync(${JSON.stringify(fixture.linux.candidate + '/payload.txt')}, 'mutated\\n');
  `, '0555');

  const result = runActivator(fixture);
  assert.equal(result.status, 74, result.stderr);
  assert.match(result.stderr, /candidate tree changed during protected release verification/i);
  const current = runLinux('readlink', ['-f', fixture.linux.currentLink], { root: true });
  assert.equal(current.stdout.trim(), fixture.linux.expected);
});

test('actual activation backs up, checks twice, preserves music processes, and writes root-only audit evidence', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  const operations = configureActualActivation(fixture);
  const result = runActivator(fixture, {
    NODE_OPTIONS: '--require=/attacker/preload.js',
    NODE_PATH: '/attacker/modules',
    DATABASE_PATH: '/attacker/database.sqlite',
    DATA_BACKUP_DIR: '/attacker/backups',
    DATA_BACKUP_RETENTION: '999',
    DATA_BACKUP_MIN_FREE_BYTES: '999999999',
    MOLI_DRAMA_RELEASES_ROOT: '/attacker/releases',
    MOLI_DRAMA_CURRENT_LINK: '/attacker/current',
    MOLI_DRAMA_SHARED_ROOT: '/attacker/shared',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /protected_release_switched_to=/);
  assert.match(result.stdout, /protected_release_database_backup=/);

  const current = runLinux('readlink', ['-f', fixture.currentLink], { root: true });
  assert.equal(current.stdout.trim(), fixture.candidate);
  const serviceCalls = runLinux('cat', [operations.serviceLog], { root: true });
  assert.equal(serviceCalls.stdout, 'stop moli-drama.service\nrestart moli-drama.service\n');
  const backups = runLinux('find', [operations.backupDir, '-maxdepth', '1', '-type', 'f', '-name', 'database-release-guard-*.sqlite', '-print'], { root: true });
  assert.equal(backups.status, 0, backups.stderr);
  assert.equal(backups.stdout.trim().split('\n').filter(Boolean).length, 1);
  assert.equal(runLinux('test', ['-e', operations.candidateBackupMarker], { root: true }).status, 1);
  assert.equal(runLinux('test', ['-e', operations.candidateModuleMarker], { root: true }).status, 1);
  const createLog = runLinux('find', [`${fixture.sharedRoot}/release-audit`, '-maxdepth', '1', '-name', '.database-backup-*.create.json', '-print'], { root: true });
  const createLogPaths = createLog.stdout.trim().split('\n').filter(Boolean);
  assert.equal(createLogPaths.length, 1, createLog.stdout);
  const createEvidence = JSON.parse(readLinuxFile(createLogPaths[0]).toString('utf8'));
  assert.deepEqual(createEvidence.environment_keys, ['LC_ALL', 'PATH']);
  const verifyLog = runLinux('find', [`${fixture.sharedRoot}/release-audit`, '-maxdepth', '1', '-name', '.database-backup-*.verify.json', '-print'], { root: true });
  const verifyLogPaths = verifyLog.stdout.trim().split('\n').filter(Boolean);
  assert.equal(verifyLogPaths.length, 1, verifyLog.stdout);
  assert.match(readLinuxFile(verifyLogPaths[0]).toString('utf8'), /^sha256=[a-f0-9]{64}\nquick_check=ok\nenvironment_keys=LC_ALL,PATH\n$/);
  const auditModes = runLinux('find', [`${fixture.sharedRoot}/release-audit`, '-type', 'f', '-exec', 'stat', '-c', '%u:%g %a %n', '{}', '+'], { root: true });
  assert.equal(auditModes.status, 0, auditModes.stderr);
  for (const line of auditModes.stdout.trim().split('\n')) assert.match(line, /^0:0 600 /);
});

test('post-stop pending work restarts and health-confirms the old release without switching', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  const operations = configureActualActivation(fixture, { postStopPending: true });
  const result = runActivator(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pending or processing generation tasks.*after-stop/i);
  const current = runLinux('readlink', ['-f', fixture.currentLink], { root: true });
  assert.equal(current.stdout.trim(), fixture.expected);
  const serviceCalls = runLinux('cat', [operations.serviceLog], { root: true });
  assert.equal(serviceCalls.stdout, 'stop moli-drama.service\nrestart moli-drama.service\n');
  const audit = runLinux('/bin/bash', ['-lc', `cat ${shellQuote(fixture.sharedRoot + '/release-audit')}/*.audit`], { root: true });
  assert.match(audit.stdout, /rollback result=healthy/);
});

test('pre-stop pending work aborts before any service operation', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  const operations = configureActualActivation(fixture);
  insertPendingTask(operations.databasePath, 'async_tasks');
  const result = runActivator(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pending or processing generation tasks.*before-stop/i);
  assert.equal(runLinux('test', ['-e', operations.serviceLog], { root: true }).status, 1);
  const current = runLinux('readlink', ['-f', fixture.currentLink], { root: true });
  assert.equal(current.stdout.trim(), fixture.expected);
});

test('database backup failure aborts before stopping the production service', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  const operations = configureActualActivation(fixture, { backupFails: true });
  const result = runActivator(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /database backup creation or quick_check failed/i);
  assert.equal(runLinux('test', ['-e', operations.serviceLog], { root: true }).status, 1);
  const partialBackups = runLinux('find', [operations.backupDir, '-mindepth', '1', '-print', '-quit'], { root: true });
  assert.equal(partialBackups.stdout.trim(), '');
  const current = runLinux('readlink', ['-f', fixture.currentLink], { root: true });
  assert.equal(current.stdout.trim(), fixture.expected);
});

test('corrupt production database fails backup integrity before stopping the service', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  const operations = configureActualActivation(fixture);
  writeLinuxFile(operations.databasePath, 'not-a-sqlite-database\n', '0600');
  const result = runActivator(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /database backup creation or quick_check failed/i);
  assert.equal(runLinux('test', ['-e', operations.serviceLog], { root: true }).status, 1);
  const current = runLinux('readlink', ['-f', fixture.currentLink], { root: true });
  assert.equal(current.stdout.trim(), fixture.expected);
});

test('service stop failure restarts and health-confirms the unchanged old release', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  const operations = configureActualActivation(fixture, { stopFails: true });
  const result = runActivator(fixture);
  assert.notEqual(result.status, 0);
  const current = runLinux('readlink', ['-f', fixture.currentLink], { root: true });
  assert.equal(current.stdout.trim(), fixture.expected);
  const serviceCalls = runLinux('cat', [operations.serviceLog], { root: true });
  assert.equal(serviceCalls.stdout, 'stop moli-drama.service\nrestart moli-drama.service\n');
  const audit = runLinux('/bin/bash', ['-lc', `cat ${shellQuote(fixture.sharedRoot + '/release-audit')}/*.audit`], { root: true });
  assert.match(audit.stdout, /rollback result=healthy/);
});

test('current CAS drift after service stop restores and health-confirms the expected release', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  const operations = configureActualActivation(fixture, { currentDrifts: true });
  const result = runActivator(fixture);
  assert.equal(result.status, 73, result.stderr);
  assert.match(result.stderr, /current release changed:/i);
  const current = runLinux('readlink', ['-f', fixture.currentLink], { root: true });
  assert.equal(current.stdout.trim(), fixture.expected);
  const serviceCalls = runLinux('cat', [operations.serviceLog], { root: true });
  assert.equal(serviceCalls.stdout, 'stop moli-drama.service\nrestart moli-drama.service\n');
});

test('new-release health failure restores old current and confirms old-release health', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  const operations = configureActualActivation(fixture, { healthFails: true });
  const result = runActivator(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /health check failed; rollback required/i);
  const current = runLinux('readlink', ['-f', fixture.currentLink], { root: true });
  assert.equal(current.stdout.trim(), fixture.expected);
  const serviceCalls = runLinux('cat', [operations.serviceLog], { root: true });
  assert.equal(serviceCalls.stdout, 'stop moli-drama.service\nrestart moli-drama.service\nrestart moli-drama.service\n');
  const audit = runLinux('/bin/bash', ['-lc', `cat ${shellQuote(fixture.sharedRoot + '/release-audit')}/*.audit`], { root: true });
  assert.match(audit.stdout, /rollback result=healthy/);
});

test('production.env rejects duplicate keys and non-absolute database paths without sourcing secrets', { skip: !rootBashAvailable }, async (t) => {
  await t.test('duplicate key', (duplicateTest) => {
    const fixture = makeActivatorFixture(duplicateTest);
    configureActualActivation(fixture);
    writeLinuxFile(`${fixture.sharedRoot}/production.env`, [
      `DATABASE_PATH=${fixture.root}/first.sqlite`,
      `DATABASE_PATH=${fixture.root}/second.sqlite`,
      `DATA_BACKUP_DIR=${fixture.root}/backups`,
      'DATA_BACKUP_RETENTION=3',
      'DATA_BACKUP_MIN_FREE_BYTES=0',
    ].join('\n'), '0400');
    const result = runActivator(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate production\.env key: DATABASE_PATH/i);
  });

  await t.test('relative path', (relativeTest) => {
    const fixture = makeActivatorFixture(relativeTest);
    configureActualActivation(fixture);
    writeLinuxFile(`${fixture.sharedRoot}/production.env`, [
      'DATABASE_PATH=relative.sqlite',
      `DATA_BACKUP_DIR=${fixture.root}/backups`,
      'DATA_BACKUP_RETENTION=3',
      'DATA_BACKUP_MIN_FREE_BYTES=0',
    ].join('\n'), '0400');
    const result = runActivator(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /normalized absolute paths/i);
  });

  await t.test('group-writable file', (writableTest) => {
    const fixture = makeActivatorFixture(writableTest);
    const operations = configureActualActivation(fixture);
    const changed = runLinux('chmod', ['0660', `${fixture.sharedRoot}/production.env`], { root: true });
    assert.equal(changed.status, 0, changed.stderr);
    const result = runActivator(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /production\.env.*must not be group\/other writable/i);
    assert.equal(runLinux('test', ['-e', operations.serviceLog], { root: true }).status, 1);
  });
});

test('post-health candidate mutation triggers old-current restart and healthy rollback', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  const operations = configureActualActivation(fixture, { mutateCandidate: true });
  const result = runActivator(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /post-health candidate tree changed/i);
  const current = runLinux('readlink', ['-f', fixture.currentLink], { root: true });
  assert.equal(current.stdout.trim(), fixture.expected);
  const serviceCalls = runLinux('cat', [operations.serviceLog], { root: true });
  assert.equal(serviceCalls.stdout, 'stop moli-drama.service\nrestart moli-drama.service\nrestart moli-drama.service\n');
});

test('AI music process drift is detected without operating on the music service and rolls back', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  const operations = configureActualActivation(fixture, { musicDrift: true });
  const result = runActivator(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AI music process snapshot changed/i);
  const current = runLinux('readlink', ['-f', fixture.currentLink], { root: true });
  assert.equal(current.stdout.trim(), fixture.expected);
  const serviceCalls = runLinux('cat', [operations.serviceLog], { root: true });
  assert.doesNotMatch(serviceCalls.stdout, /moli-mama|music|server\.js|worker\.js/i);
});

test('fatal startup journal entry rolls the switched release back', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeActivatorFixture(t);
  configureActualActivation(fixture, { fatalJournal: true });
  const result = runActivator(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fatal startup error/i);
  const current = runLinux('readlink', ['-f', fixture.currentLink], { root: true });
  assert.equal(current.stdout.trim(), fixture.expected);
});

test('manual rotation hard-codes old guard hashes and root-owned staged evidence transaction', () => {
  const source = fs.readFileSync(rotationPath, 'utf8');
  const activatorHash = sha256(fs.readFileSync(activatorPath));
  const externalVerifierHash = sha256(fs.readFileSync(externalVerifierPath));
  for (const expected of [OLD_ACTIVATOR_SHA256, OLD_UI_VERIFIER_SHA256, OLD_SEQUENCE_VERIFIER_SHA256]) {
    assert.match(source, new RegExp(expected));
  }
  assert.match(source, /^#!\/bin\/bash -p\nset -euo pipefail/);
  assert.match(source, /"\$#" -ne 4/);
  assert.match(source, /id -u/);
  assert.match(source, /readonly SAFE_PATH='\/usr\/sbin:\/usr\/bin:\/sbin:\/bin'/);
  assert.match(source, /readonly NODE_BINARY='\/usr\/bin\/node'/);
  assert.match(source, /unset NODE_OPTIONS NODE_PATH/);
  assert.match(source, /^RELEASES_ROOT='\/opt\/moli-drama\/releases'$/m);
  assert.match(source, /^CURRENT_LINK='\/opt\/moli-drama\/current'$/m);
  assert.match(source, /^SHARED_ROOT='\/opt\/moli-drama\/shared'$/m);
  assert.doesNotMatch(source, /(?:RELEASES_ROOT|CURRENT_LINK|SHARED_ROOT)="\$\{MOLI_DRAMA_/);
  assert.doesNotMatch(source, /MOLI_DRAMA_(?:RELEASES_ROOT|CURRENT_LINK|SHARED_ROOT)/);
  assert.match(source, new RegExp(`EXPECTED_NEW_EXTERNAL_VERIFIER_SHA256='${externalVerifierHash}'`));
  assert.match(source, new RegExp(`EXPECTED_INSTALLED_EXTERNAL_VERIFIER_SHA256='${INSTALLED_EXTERNAL_VERIFIER_SHA256}'`));
  assert.match(source, new RegExp(`EXPECTED_NEW_ACTIVATOR_SHA256='${activatorHash}'`));
  assert.match(source, new RegExp(`EXPECTED_NEW_UI_VERIFIER_SHA256='${INSTALLED_UI_VERIFIER_SHA256}'`));
  assert.match(source, /NEW_UI_VERIFIER_SOURCE=.*canvasCreditReleaseContract\.js/);
  assert.match(source, /SOURCE_RELEASE.*CANDIDATE|CANDIDATE.*SOURCE_RELEASE/s);
  assert.match(source, /source release must equal candidate/i);
  assert.match(source, /deploy\.lock/);
  assert.match(source, /flock -n/);
  assert.match(source, /release-evidence-staging/);
  assert.match(source, /find -P .* -type l/);
  assert.match(source, /root:root|chown -R root:root/);
  assert.match(source, /PROTECTED_RELEASE_VERIFY_ONLY=1/);
  assert.match(source, /ACTIVATOR_HARNESS/);
  assert.match(source, /release-evidence\/external-models-v1/);
  assert.match(source, /install .*0555/);
  assert.match(source, /verify-external-model-release\.js/);
  assert.match(source, /activate-protected-release\.sh/);
  assert.match(source, /EVIDENCE_BACKUP/);
  assert.match(source, /EVIDENCE_OLD_HASH|OLD_EVIDENCE_HASH/);
  assert.match(source, /rollback.*evidence|evidence.*rollback/is);
  assert.match(source, /env -i[\s\\]+PATH="\$SAFE_PATH"/);
  assert.doesNotMatch(source, /command -v node/);
});

test('manual rotation refuses an unknown old guard hash before replacement', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeRotationFixture(t);
  const tamper = runLinux('bash', ['-lc', `printf '%s\\n' tamper >> ${shellQuote(fixture.guardRoot + '/activate-protected-release.sh')}`], { root: true });
  assert.equal(tamper.status, 0, tamper.stderr);

  const result = runRotation(fixture, {
    NODE_OPTIONS: '--require=/attacker/preload.js',
    NODE_PATH: '/attacker/modules',
    PATH: '/attacker/bin',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /activate-protected-release\.sh.*hash mismatch/i);
  const external = runLinux('test', ['-e', `${fixture.guardRoot}/verify-external-model-release.js`], { root: true });
  assert.notEqual(external.status, 0);
});

test('manual rotation passes expected current to the external verifier', () => {
  const source = fs.readFileSync(rotationPath, 'utf8');
  assert.match(source, /"\$EXTERNAL_MODEL_VERIFIER" "\$CANDIDATE" "\$EVIDENCE_TARGET" "\$EXPECTED_CURRENT"/);
});

test('manual rotation refuses an unknown installed external verifier before replacement', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeRotationFixture(t);
  const unexpected = 'process.exit(0); // unreviewed installed external verifier\n';
  writeLinuxFile(`${fixture.guardRoot}/verify-external-model-release.js`, unexpected, '0555');

  const result = runRotation(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /installed external model verifier hash mismatch/i);
  assert.equal(readLinuxFile(`${fixture.guardRoot}/verify-external-model-release.js`).toString(), unexpected);
});

test('manual rotation refuses a distinct source release and candidate', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeRotationFixture(t);
  const otherSource = `${fixture.releasesRoot}/other-source`;
  const made = runLinux('install', ['-d', '-o', 'root', '-g', 'root', '-m', '0755', otherSource], { root: true });
  assert.equal(made.status, 0, made.stderr);
  fixture.source = otherSource;
  const result = runRotation(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source release must equal candidate/i);
});

test('manual rotation refuses a new activator that does not match its reviewed hard-coded SHA', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeRotationFixture(t);
  const tamper = runLinux('/bin/bash', ['-lc', `printf '%s\n' tamper >> ${shellQuote(fixture.source + '/deploy/release-guard/activate-protected-release.sh')}`], { root: true });
  assert.equal(tamper.status, 0, tamper.stderr);
  const result = runRotation(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reviewed new activator hash mismatch/i);
});

test('manual rotation refuses a new UI verifier that does not match its reviewed hard-coded SHA', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeRotationFixture(t);
  const tamper = runLinux('/bin/bash', ['-lc', `printf '%s\n' tamper >> ${shellQuote(fixture.source + '/backend-node/src/services/canvasCreditReleaseContract.js')}`], { root: true });
  assert.equal(tamper.status, 0, tamper.stderr);
  const result = runRotation(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reviewed new UI verifier hash mismatch/i);
});

test('manual rotation atomically replaces existing evidence and retains its exact backup', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeRotationFixture(t);
  const installedEvidence = `${fixture.sharedRoot}/release-evidence/external-models-v1`;
  writeLinuxFile(`${installedEvidence}/old-marker.txt`, 'old-reviewed-evidence\n', '0444');
  const result = runRotation(fixture, {
    NODE_OPTIONS: '--require=/attacker/preload.js',
    NODE_PATH: '/attacker/modules',
    PATH: '/attacker/bin',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(runLinux('test', ['-f', `${installedEvidence}/manifest.json`], { root: true }).status, 0);
  assert.equal(runLinux('test', ['-e', `${installedEvidence}/old-marker.txt`], { root: true }).status, 1);
  const backupRoot = result.stdout.match(/external_model_release_guard_backup=(.+)/)?.[1]?.trim();
  assert.ok(backupRoot, result.stdout);
  const oldMarker = runLinux('cat', [`${backupRoot}/external-models-v1/old-marker.txt`], { root: true });
  assert.equal(oldMarker.stdout, 'old-reviewed-evidence\n');
  const installedActivator = readLinuxFile(`${fixture.guardRoot}/activate-protected-release.sh`);
  const reviewedActivator = readLinuxFile(`${fixture.source}/deploy/release-guard/activate-protected-release.sh`);
  const installedUiVerifier = readLinuxFile(`${fixture.guardRoot}/verify-protected-release.js`);
  const reviewedUiVerifier = readLinuxFile(`${fixture.source}/backend-node/src/services/canvasCreditReleaseContract.js`);
  assert.equal(sha256(installedActivator), sha256(reviewedActivator));
  assert.equal(sha256(installedUiVerifier), sha256(reviewedUiVerifier));
  assert.doesNotMatch(installedActivator.toString('utf8'), /verify-only-harness|\.external-model-release-guard-rotation\./);
  const leakedStaging = runLinux('find', [fixture.sharedRoot, '-maxdepth', '1', '-name', '.external-model-release-guard-rotation.*', '-print'], { root: true });
  assert.equal(leakedStaging.stdout.trim(), '');
});

test('manual rotation refreshes evidence when the reviewed activator is already installed', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeRotationFixture(t);
  const installedEvidence = `${fixture.sharedRoot}/release-evidence/external-models-v1`;
  const reviewedActivator = readLinuxFile(`${fixture.source}/deploy/release-guard/activate-protected-release.sh`);
  const reviewedExternal = readLinuxFile(`${fixture.source}/deploy/release-guard/verify-external-model-release.js`);
  const reviewedUi = readLinuxFile(`${fixture.source}/backend-node/src/services/canvasCreditReleaseContract.js`);
  writeLinuxFile(`${fixture.guardRoot}/activate-protected-release.sh`, reviewedActivator, '0555');
  writeLinuxFile(`${fixture.guardRoot}/verify-external-model-release.js`, reviewedExternal, '0555');
  writeLinuxFile(`${fixture.guardRoot}/verify-protected-release.js`, reviewedUi, '0555');
  writeLinuxFile(`${installedEvidence}/old-marker.txt`, 'previous-reviewed-evidence\n', '0444');

  const result = runRotation(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(runLinux('test', ['-f', `${installedEvidence}/manifest.json`], { root: true }).status, 0);
  assert.equal(runLinux('test', ['-e', `${installedEvidence}/old-marker.txt`], { root: true }).status, 1);
  const backupRoot = result.stdout.match(/external_model_release_guard_backup=(.+)/)?.[1]?.trim();
  assert.ok(backupRoot, result.stdout);
  assert.equal(
    sha256(readLinuxFile(`${backupRoot}/activate-protected-release.sh`)),
    sha256(reviewedActivator),
  );
});

test('manual rotation rolls back a partial install and leaves the old activator exact', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeRotationFixture(t);
  const installedEvidence = `${fixture.sharedRoot}/release-evidence/external-models-v1`;
  const oldExternal = 'process.exit(0); // old external verifier\n';
  writeLinuxFile(`${fixture.guardRoot}/verify-external-model-release.js`, oldExternal, '0555');
  writeLinuxFile(`${installedEvidence}/old-marker.txt`, 'old-evidence-must-return\n', '0444');
  writeLinuxFile(`${fixture.source}/deploy/release-guard/verify-external-model-release.js`, `
    const fs = require('node:fs');
    if (process.argv.length !== 5) process.exit(64);
    fs.accessSync(process.argv[2]);
    fs.accessSync(process.argv[3]);
    fs.accessSync(process.argv[4]);
    if (process.argv[3] === ${JSON.stringify(installedEvidence)}) process.exit(42);
  `, '0555');
  fixture.materializeRotation();
  const result = runRotation(fixture);
  assert.equal(result.status, 42, result.stderr);

  const actualHash = runLinux('sha256sum', [`${fixture.guardRoot}/activate-protected-release.sh`], { root: true });
  assert.equal(actualHash.status, 0, actualHash.stderr);
  assert.equal(actualHash.stdout.trim().split(/\s+/)[0], OLD_ACTIVATOR_SHA256);
  const restoredExternal = runLinux('sha256sum', [`${fixture.guardRoot}/verify-external-model-release.js`], { root: true });
  assert.equal(restoredExternal.stdout.trim().split(/\s+/)[0], sha256(oldExternal));
  const restoredUi = runLinux('sha256sum', [`${fixture.guardRoot}/verify-protected-release.js`], { root: true });
  assert.equal(restoredUi.stdout.trim().split(/\s+/)[0], OLD_UI_VERIFIER_SHA256);
  const restoredEvidence = runLinux('cat', [`${installedEvidence}/old-marker.txt`], { root: true });
  assert.equal(restoredEvidence.stdout, 'old-evidence-must-return\n');
  assert.equal(runLinux('test', ['-e', `${installedEvidence}/manifest.json`], { root: true }).status, 1);

  const leakedStaging = runLinux('find', [fixture.sharedRoot, '-maxdepth', '1', '-name', '.external-model-release-guard-rotation.*', '-print'], { root: true });
  assert.equal(leakedStaging.stdout.trim(), '');
});

test('manual rotation rolls back verifier, activator, and evidence after the activator move', { skip: !rootBashAvailable }, (t) => {
  const fixture = makeRotationFixture(t);
  const installedEvidence = `${fixture.sharedRoot}/release-evidence/external-models-v1`;
  const oldExternal = 'process.exit(0); // old external verifier after-move test\n';
  writeLinuxFile(`${fixture.guardRoot}/verify-external-model-release.js`, oldExternal, '0555');
  writeLinuxFile(`${installedEvidence}/old-marker.txt`, 'old-evidence-after-move\n', '0444');
  fixture.materializeRotation({ failAfterActivatorInstall: true });

  const result = runRotation(fixture);
  assert.notEqual(result.status, 0);
  const restoredActivator = runLinux('sha256sum', [`${fixture.guardRoot}/activate-protected-release.sh`], { root: true });
  assert.equal(restoredActivator.stdout.trim().split(/\s+/)[0], OLD_ACTIVATOR_SHA256);
  const restoredExternal = runLinux('sha256sum', [`${fixture.guardRoot}/verify-external-model-release.js`], { root: true });
  assert.equal(restoredExternal.stdout.trim().split(/\s+/)[0], sha256(oldExternal));
  const restoredUi = runLinux('sha256sum', [`${fixture.guardRoot}/verify-protected-release.js`], { root: true });
  assert.equal(restoredUi.stdout.trim().split(/\s+/)[0], OLD_UI_VERIFIER_SHA256);
  const restoredEvidence = runLinux('cat', [`${installedEvidence}/old-marker.txt`], { root: true });
  assert.equal(restoredEvidence.stdout, 'old-evidence-after-move\n');
  assert.equal(runLinux('test', ['-e', `${installedEvidence}/manifest.json`], { root: true }).status, 1);
});
