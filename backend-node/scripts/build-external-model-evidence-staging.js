#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_CONTRACT = 'external-model-release-evidence-manifest-v1';
const PRIVATE_CONTRACT = 'toapis-private-avatar-video-verification-v1';
const WAN3_CONTRACT = 'toapis-wan3-video-real-verification-v1';
const CONTRACT_FILES = Object.freeze({
  'toapis-video-real-verification-v1': 'toapis-video-verification.json',
  [PRIVATE_CONTRACT]: 'toapis-private-avatar-verification.json',
  [WAN3_CONTRACT]: 'toapis-wan3-video-verification.json',
  'usmercari-image-real-verification-v1': 'usmercari-image-verification.json',
  'lingjing-video-real-verification-v1': 'lingjing-video-verification.json',
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function safeBasename(value, label) {
  const name = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(name) || path.basename(name) !== name) {
    throw new Error(`${label} 不是安全文件名`);
  }
  return name;
}

function requireDirectory(value, label) {
  const input = String(value || '');
  if (!path.isAbsolute(input)) throw new Error(`${label} 必须是绝对目录`);
  const stat = fs.lstatSync(input);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} 必须是真实目录`);
  return fs.realpathSync(input);
}

function assertPlainTree(root, label) {
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) throw new Error(`${label} 禁止符号链接: ${entry.name}`);
      if (stat.isDirectory()) visit(filePath);
      else if (!stat.isFile()) throw new Error(`${label} 只允许普通文件与目录: ${entry.name}`);
    }
  };
  visit(root);
}

function readJsonFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} 必须是普通文件`);
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {
    throw new Error(`${label} 不是有效 JSON`);
  }
}

function readManifest(root, label) {
  const manifest = readJsonFile(path.join(root, 'manifest.json'), `${label} manifest`);
  if (manifest?.contract_version !== MANIFEST_CONTRACT
      || !manifest.evidence || typeof manifest.evidence !== 'object'
      || Array.isArray(manifest.evidence)) {
    throw new Error(`${label} manifest 合同无效`);
  }
  for (const [contract, record] of Object.entries(manifest.evidence)) {
    const expectedFile = CONTRACT_FILES[contract];
    if (!expectedFile) throw new Error(`${label} manifest 包含未知 contract: ${contract}`);
    if (!record || record.file !== expectedFile || !/^[a-f0-9]{64}$/.test(String(record.sha256 || ''))) {
      throw new Error(`${label} manifest 记录无效: ${contract}`);
    }
    const bytes = fs.readFileSync(path.join(root, expectedFile));
    if (sha256(bytes) !== record.sha256) throw new Error(`${label} manifest SHA 不匹配: ${contract}`);
  }
  return manifest;
}

function readArtifact(root, artifact, label) {
  const name = safeBasename(artifact?.output_file, `${label}.output_file`);
  const filePath = path.join(root, name);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} 必须是普通文件`);
  const bytes = fs.readFileSync(filePath);
  if (Number(artifact?.bytes) !== bytes.length || String(artifact?.sha256 || '') !== sha256(bytes)) {
    throw new Error(`${label} 字节或 SHA-256 不匹配`);
  }
  return { name, filePath };
}

function artifactNames(evidence) {
  const names = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'output_file')) {
      names.add(safeBasename(value.output_file, 'existing artifact.output_file'));
    }
    Object.values(value).forEach(walk);
  };
  walk(evidence);
  return names;
}

function removeReplacedArtifacts(tempRoot, currentManifest, replacingContract) {
  const record = currentManifest.evidence[replacingContract];
  if (!record) return;
  const oldEvidence = readJsonFile(path.join(tempRoot, record.file), `${replacingContract} evidence`);
  const protectedNames = new Set();
  for (const [contract, otherRecord] of Object.entries(currentManifest.evidence)) {
    if (contract === replacingContract) continue;
    for (const name of artifactNames(readJsonFile(path.join(tempRoot, otherRecord.file), `${contract} evidence`))) {
      protectedNames.add(name);
    }
  }
  for (const name of artifactNames(oldEvidence)) {
    if (!protectedNames.has(name)) fs.rmSync(path.join(tempRoot, 'public', 'toapis', name), { force: true });
  }
}

function buildExternalModelEvidenceStaging(options) {
  const currentRoot = requireDirectory(options.currentRoot, 'currentRoot');
  const privateAvatarOutputDir = requireDirectory(options.privateAvatarOutputDir, 'privateAvatarOutputDir');
  const wan3EvidenceRoot = requireDirectory(options.wan3EvidenceRoot, 'wan3EvidenceRoot');
  const outputRoot = path.resolve(String(options.outputRoot || ''));
  if (!path.isAbsolute(String(options.outputRoot || ''))) throw new Error('outputRoot 必须是绝对路径');
  if (fs.existsSync(outputRoot)) throw new Error('outputRoot 必须不存在');
  assertPlainTree(currentRoot, 'currentRoot');
  assertPlainTree(privateAvatarOutputDir, 'privateAvatarOutputDir');
  assertPlainTree(wan3EvidenceRoot, 'wan3EvidenceRoot');

  const currentManifest = readManifest(currentRoot, 'current');
  const privatePath = path.join(privateAvatarOutputDir, CONTRACT_FILES[PRIVATE_CONTRACT]);
  const privateBytes = fs.readFileSync(privatePath);
  const privateEvidence = readJsonFile(privatePath, 'private-avatar evidence');
  if (privateEvidence?.contract_version !== PRIVATE_CONTRACT
      || !Array.isArray(privateEvidence.cases) || privateEvidence.cases.length !== 2) {
    throw new Error('private-avatar evidence 合同或用例数无效');
  }
  const privateArtifacts = privateEvidence.cases.map((entry, index) => readArtifact(
    privateAvatarOutputDir, entry.artifact, `private-avatar case ${index + 1}`,
  ));

  const wanManifest = readManifest(wan3EvidenceRoot, 'Wan3 update');
  if (Object.keys(wanManifest.evidence).length !== 1 || !wanManifest.evidence[WAN3_CONTRACT]) {
    throw new Error('Wan3 update manifest 必须只包含 Wan3 contract');
  }
  const wanPath = path.join(wan3EvidenceRoot, CONTRACT_FILES[WAN3_CONTRACT]);
  const wanBytes = fs.readFileSync(wanPath);
  const wanEvidence = readJsonFile(wanPath, 'Wan3 evidence');
  if (wanEvidence?.contract_version !== WAN3_CONTRACT
      || !Array.isArray(wanEvidence.results) || wanEvidence.results.length !== 1) {
    throw new Error('Wan3 evidence 合同或用例数无效');
  }
  const wanArtifact = readArtifact(
    path.join(wan3EvidenceRoot, 'public', 'toapis'),
    wanEvidence.results[0].artifact,
    'Wan3 artifact',
  );

  const parent = path.dirname(outputRoot);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(outputRoot)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.cpSync(currentRoot, temporary, { recursive: true, errorOnExist: true, force: false });
    removeReplacedArtifacts(temporary, currentManifest, PRIVATE_CONTRACT);
    removeReplacedArtifacts(temporary, currentManifest, WAN3_CONTRACT);
    const publicToapis = path.join(temporary, 'public', 'toapis');
    fs.mkdirSync(publicToapis, { recursive: true });
    fs.writeFileSync(path.join(temporary, CONTRACT_FILES[PRIVATE_CONTRACT]), privateBytes, { flag: 'w' });
    for (const artifact of privateArtifacts) fs.copyFileSync(artifact.filePath, path.join(publicToapis, artifact.name));
    fs.writeFileSync(path.join(temporary, CONTRACT_FILES[WAN3_CONTRACT]), wanBytes, { flag: 'w' });
    fs.copyFileSync(wanArtifact.filePath, path.join(publicToapis, wanArtifact.name));

    const mergedManifest = {
      contract_version: MANIFEST_CONTRACT,
      evidence: {
        ...currentManifest.evidence,
        [PRIVATE_CONTRACT]: { file: CONTRACT_FILES[PRIVATE_CONTRACT], sha256: sha256(privateBytes) },
        [WAN3_CONTRACT]: { file: CONTRACT_FILES[WAN3_CONTRACT], sha256: sha256(wanBytes) },
      },
    };
    fs.writeFileSync(path.join(temporary, 'manifest.json'), `${JSON.stringify(mergedManifest, null, 2)}\n`);
    readManifest(temporary, 'merged');
    assertPlainTree(temporary, 'merged output');
    fs.renameSync(temporary, outputRoot);
    return mergedManifest;
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

if (require.main === module) {
  if (process.argv.length !== 6) {
    process.stderr.write('Usage: build-external-model-evidence-staging.js CURRENT_ROOT PRIVATE_AVATAR_OUTPUT WAN3_ROOT OUTPUT_ROOT\n');
    process.exitCode = 64;
  } else {
    try {
      const manifest = buildExternalModelEvidenceStaging({
        currentRoot: process.argv[2],
        privateAvatarOutputDir: process.argv[3],
        wan3EvidenceRoot: process.argv[4],
        outputRoot: process.argv[5],
      });
      process.stdout.write(`EXTERNAL_MODEL_EVIDENCE_STAGED contracts=${Object.keys(manifest.evidence).length}\n`);
    } catch (error) {
      process.stderr.write(`EXTERNAL_MODEL_EVIDENCE_STAGING_FAILED: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = { buildExternalModelEvidenceStaging };
