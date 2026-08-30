'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SCRIPT = path.resolve(__dirname, '../scripts/build-external-model-evidence-staging.js');
const MANIFEST_CONTRACT = 'external-model-release-evidence-manifest-v1';
const PRIVATE_CONTRACT = 'toapis-private-avatar-video-verification-v1';
const WAN3_CONTRACT = 'toapis-wan3-video-real-verification-v1';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeEvidence(root, contract, file, payload) {
  const bytes = Buffer.from(`${JSON.stringify({ contract_version: contract, ...payload }, null, 2)}\n`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, file), bytes);
  return { file, sha256: sha256(bytes) };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-evidence-merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = path.join(root, 'current');
  const privateOutput = path.join(root, 'private-output');
  const wan3 = path.join(root, 'wan3');
  const output = path.join(root, 'merged');
  const publicToapis = path.join(current, 'public', 'toapis');
  fs.mkdirSync(publicToapis, { recursive: true });

  const evidence = {
    'toapis-video-real-verification-v1': writeEvidence(
      current,
      'toapis-video-real-verification-v1',
      'toapis-video-verification.json',
      { results: [{ artifact: { output_file: 'standard-old.mp4' } }] },
    ),
    [PRIVATE_CONTRACT]: writeEvidence(
      current,
      PRIVATE_CONTRACT,
      'toapis-private-avatar-verification.json',
      { cases: [
        { artifact: { output_file: 'private-fast-old.mp4', sha256: sha256('private-fast-old') } },
        { artifact: { output_file: 'private-mini-old.mp4', sha256: sha256('private-mini-old') } },
      ] },
    ),
    'usmercari-image-real-verification-v1': writeEvidence(
      current,
      'usmercari-image-real-verification-v1',
      'usmercari-image-verification.json',
      { results: [{ output_file: 'image-old.jpg' }] },
    ),
    'lingjing-video-real-verification-v1': writeEvidence(
      current,
      'lingjing-video-real-verification-v1',
      'lingjing-video-verification.json',
      { results: [{ artifact: { output_file: 'lingjing-old.mp4' } }] },
    ),
  };
  writeJson(path.join(current, 'manifest.json'), { contract_version: MANIFEST_CONTRACT, evidence });
  for (const [name, bytes] of [
    ['standard-old.mp4', 'standard-old'],
    ['private-fast-old.mp4', 'private-fast-old'],
    ['private-mini-old.mp4', 'private-mini-old'],
  ]) fs.writeFileSync(path.join(publicToapis, name), bytes);
  fs.mkdirSync(path.join(current, 'public', 'usmercari'), { recursive: true });
  fs.writeFileSync(path.join(current, 'public', 'usmercari', 'image-old.jpg'), 'image-old');
  fs.mkdirSync(path.join(current, 'public', 'lingjing'), { recursive: true });
  fs.writeFileSync(path.join(current, 'public', 'lingjing', 'lingjing-old.mp4'), 'lingjing-old');

  fs.mkdirSync(privateOutput, { recursive: true });
  const privateArtifacts = [
    ['fast-avatar-480-4s.mp4', Buffer.from('private-fast-new')],
    ['mini-avatar-480-4s.mp4', Buffer.from('private-mini-new')],
  ];
  const privateEvidence = {
    contract_version: PRIVATE_CONTRACT,
    generated_at: '2026-08-30T12:16:50.398Z',
    cases: privateArtifacts.map(([name, bytes]) => ({
      artifact: { output_file: name, bytes: bytes.length, sha256: sha256(bytes) },
    })),
  };
  writeJson(path.join(privateOutput, 'toapis-private-avatar-verification.json'), privateEvidence);
  for (const [name, bytes] of privateArtifacts) fs.writeFileSync(path.join(privateOutput, name), bytes);

  const wanPublic = path.join(wan3, 'public', 'toapis');
  fs.mkdirSync(wanPublic, { recursive: true });
  const wanBytes = Buffer.from('wan3-new-artifact');
  const wanFile = 'wan3-t2v-480p-2s-no-audio-task.mp4';
  fs.writeFileSync(path.join(wanPublic, wanFile), wanBytes);
  const wanRecord = writeEvidence(wan3, WAN3_CONTRACT, 'toapis-wan3-video-verification.json', {
    results: [{ artifact: { output_file: wanFile, bytes: wanBytes.length, sha256: sha256(wanBytes) } }],
  });
  writeJson(path.join(wan3, 'manifest.json'), {
    contract_version: MANIFEST_CONTRACT,
    evidence: { [WAN3_CONTRACT]: wanRecord },
  });
  return { root, current, privateOutput, wan3, output, originalEvidence: evidence };
}

test('evidence staging merge preserves existing contracts and updates only private-avatar and Wan3', (t) => {
  assert.equal(fs.existsSync(SCRIPT), true, 'missing evidence staging builder');
  const { buildExternalModelEvidenceStaging } = require(SCRIPT);
  const current = fixture(t);
  buildExternalModelEvidenceStaging({
    currentRoot: current.current,
    privateAvatarOutputDir: current.privateOutput,
    wan3EvidenceRoot: current.wan3,
    outputRoot: current.output,
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(current.output, 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.evidence).sort(), [
    'lingjing-video-real-verification-v1',
    PRIVATE_CONTRACT,
    'toapis-video-real-verification-v1',
    WAN3_CONTRACT,
    'usmercari-image-real-verification-v1',
  ].sort());
  for (const contract of [
    'toapis-video-real-verification-v1',
    'usmercari-image-real-verification-v1',
    'lingjing-video-real-verification-v1',
  ]) assert.deepEqual(manifest.evidence[contract], current.originalEvidence[contract]);
  assert.notDeepEqual(manifest.evidence[PRIVATE_CONTRACT], current.originalEvidence[PRIVATE_CONTRACT]);
  assert.equal(fs.existsSync(path.join(current.output, 'public', 'toapis', 'private-fast-old.mp4')), false);
  assert.equal(fs.existsSync(path.join(current.output, 'public', 'toapis', 'private-mini-old.mp4')), false);
  for (const file of [
    'fast-avatar-480-4s.mp4',
    'mini-avatar-480-4s.mp4',
    'wan3-t2v-480p-2s-no-audio-task.mp4',
    'standard-old.mp4',
  ]) assert.equal(fs.existsSync(path.join(current.output, 'public', 'toapis', file)), true, file);
});

test('evidence staging merge rejects unsafe or incomplete updates without leaving output', (t) => {
  assert.equal(fs.existsSync(SCRIPT), true, 'missing evidence staging builder');
  const { buildExternalModelEvidenceStaging } = require(SCRIPT);
  const mutations = [
    (current) => {
      const manifestPath = path.join(current.wan3, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.evidence['fake-contract-v1'] = manifest.evidence[WAN3_CONTRACT];
      writeJson(manifestPath, manifest);
    },
    (current) => {
      const evidencePath = path.join(current.privateOutput, 'toapis-private-avatar-verification.json');
      const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
      evidence.cases[0].artifact.output_file = '../escape.mp4';
      writeJson(evidencePath, evidence);
    },
    (current) => {
      const evidencePath = path.join(current.current, 'toapis-video-verification.json');
      const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
      evidence.results[0].artifact.output_file = '../unsafe-existing.mp4';
      writeJson(evidencePath, evidence);
      const manifestPath = path.join(current.current, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const bytes = fs.readFileSync(evidencePath);
      manifest.evidence['toapis-video-real-verification-v1'].sha256 = sha256(bytes);
      writeJson(manifestPath, manifest);
    },
  ];
  if (process.platform !== 'win32') mutations.push((current) => fs.symlinkSync(
      path.join(current.privateOutput, 'fast-avatar-480-4s.mp4'),
      path.join(current.privateOutput, 'linked.mp4'),
    ));
  for (const mutate of mutations) {
    const current = fixture(t);
    mutate(current);
    assert.throws(() => buildExternalModelEvidenceStaging({
      currentRoot: current.current,
      privateAvatarOutputDir: current.privateOutput,
      wan3EvidenceRoot: current.wan3,
      outputRoot: current.output,
    }), /contract|unsafe|安全|symlink|符号链接|manifest/i);
    assert.equal(fs.existsSync(current.output), false);
  }
});
