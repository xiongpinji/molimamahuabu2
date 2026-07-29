'use strict';

const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const lockfiles = [
  'backend-node/package-lock.json',
  'frontweb/package-lock.json',
];
const missingLicenseOverrides = new Map([
  ['backend-node/package-lock.json:node_modules/busboy@1.6.0', {
    license: 'MIT',
    source: 'https://github.com/mscdex/busboy/blob/v1.6.0/LICENSE',
  }],
  ['backend-node/package-lock.json:node_modules/streamsearch@1.1.0', {
    license: 'MIT',
    source: 'https://github.com/mscdex/streamsearch/blob/v1.1.0/LICENSE',
  }],
  ['frontweb/package-lock.json:node_modules/@types/three@0.163.10003', {
    license: 'MIT',
    source: 'https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/LICENSE',
  }],
]);
const forbiddenLicense = /\b(?:AGPL|GPL|SSPL|BUSL)(?:-\d(?:\.\d)?(?:-only|-or-later)?)?\b|CC-BY-NC|NONCOMMERCIAL|NON-COMMERCIAL|UNLICENSED/i;

let auditedPackages = 0;
for (const lockfile of lockfiles) {
  const lock = JSON.parse(fs.readFileSync(path.join(repositoryRoot, lockfile), 'utf8'));
  for (const [packagePath, metadata] of Object.entries(lock.packages || {})) {
    if (!packagePath || metadata.dev === true) continue;
    const key = `${lockfile}:${packagePath}@${metadata.version || ''}`;
    const override = missingLicenseOverrides.get(key);
    const license = String(metadata.license || override?.license || '').trim();
    if (!license) {
      throw new Error(`生产依赖缺少许可证审计记录: ${key}`);
    }
    if (override && !override.source.startsWith('https://')) {
      throw new Error(`许可证覆盖记录缺少 HTTPS 来源: ${key}`);
    }
    if (forbiddenLicense.test(license)) {
      throw new Error(`生产依赖包含禁止许可证: ${key} (${license})`);
    }
    auditedPackages += 1;
  }
}

const unusedOverrides = [...missingLicenseOverrides.keys()].filter((key) => {
  const separator = key.indexOf(':');
  const lockfile = key.slice(0, separator);
  const packageKey = key.slice(separator + 1);
  const at = packageKey.lastIndexOf('@');
  const packagePath = packageKey.slice(0, at);
  const version = packageKey.slice(at + 1);
  const lock = JSON.parse(fs.readFileSync(path.join(repositoryRoot, lockfile), 'utf8'));
  const metadata = lock.packages?.[packagePath];
  return !metadata || metadata.version !== version || metadata.license;
});
if (unusedOverrides.length) {
  throw new Error(`许可证覆盖记录已过期: ${unusedOverrides.join(', ')}`);
}

process.stdout.write(`production_license_audit=passed packages=${auditedPackages}\n`);
