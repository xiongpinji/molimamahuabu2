'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  PROVIDERS,
  TOAPIS_WAN3_CASE,
  auditToapisWan3Evidence,
  auditToapisWan3Runtime,
  freshnessRequirements,
} = require('../../deploy/release-guard/verify-external-model-release');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONTRACT = 'toapis-wan3-video-real-verification-v1';
const EVIDENCE_FILE = 'toapis-wan3-video-verification.json';

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function withTrustedFixtureOwnership(root, callback) {
  const fixtureRoot = path.resolve(root);
  const originalStatSync = fs.statSync;
  fs.statSync = function trustedFixtureStatSync(target, ...args) {
    const stat = originalStatSync.call(fs, target, ...args);
    const resolved = path.resolve(String(target));
    const relative = path.relative(fixtureRoot, resolved);
    const insideFixture = relative === ''
      || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    if (!insideFixture) return stat;
    return new Proxy(stat, {
      get(value, property, receiver) {
        if (property === 'uid' || property === 'gid') return 0;
        return Reflect.get(value, property, receiver);
      },
    });
  };
  try {
    return callback();
  } finally {
    fs.statSync = originalStatSync;
  }
}

function auditEvidenceFixture(item, now = item.now, requireRecent = true) {
  return withTrustedFixtureOwnership(item.root, () => auditToapisWan3Evidence(
    item.root,
    { evidence: item.evidence, sha256: 'a'.repeat(64) },
    now,
    requireRecent,
  ));
}

function evidenceFixture(mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-wan3-guard-'));
  const fileName = 'wan3-t2v-480p-2s-no-audio-wan-task-1.mp4';
  const asset = Buffer.from('synthetic-wan3-video-artifact');
  write(root, path.join('public', 'toapis', fileName), asset);
  const generatedAt = '2026-08-29T00:01:05.000Z';
  const request = {
    model: 'wan3.0-video',
    prompt: 'A calm two-second cinematic shot of sunlight moving across an empty studio table, no text, no logos.',
    duration: 2,
    ratio: '16:9',
    resolution: '480p',
    audio: false,
    client_business_id: 'wan3-verify-run-1',
  };
  const evidence = {
    contract_version: CONTRACT,
    provider_origin: 'https://toapis.xyz',
    generated_at: generatedAt,
    run_id: '2db64e31-ff48-451c-9da8-b014a2ad92ec',
    results: [{
      id: 'wan3-t2v-480p-2s-no-audio',
      model: 'wan3.0-video',
      mode: 't2v',
      requested_resolution: '480p',
      requested_ratio: '16:9',
      requested_duration: 2,
      requested_audio: false,
      status: 'completed',
      submission_state: 'accepted',
      provider_task_id: 'wan-task-1',
      recovery_task_id: 'wan3-verify-run-1',
      post_count: 1,
      config_id: 'wan-config-1',
      config_fingerprint: 'c'.repeat(64),
      request,
      request_sha256: sha256(JSON.stringify(request)),
      started_at: '2026-08-29T00:00:01.000Z',
      accepted_at: '2026-08-29T00:00:02.000Z',
      completed_at: '2026-08-29T00:01:00.000Z',
      artifact: {
        public_url: `https://molimama.vip/verification-assets/toapis/${fileName}`,
        output_file: fileName,
        content_type: 'video/mp4',
        bytes: asset.length,
        sha256: sha256(asset),
        ffprobe: {
          format: 'mov,mp4,m4a,3gp,3g2,mj2',
          width: 854,
          height: 480,
          duration_seconds: 2,
          video_codec: 'h264',
          has_audio: false,
          audio_codec: null,
        },
      },
      billing: {
        expected_cost_yuan: 0.9,
        hard_cap_yuan: 1,
        before: { used_balance: 10, used_credits: 100, captured_at: '2026-08-29T00:00:00.000Z' },
        after: { used_balance: 10.1, used_credits: 187.5, captured_at: '2026-08-29T00:01:01.000Z' },
        debited_balance: 0.1,
        debited_credits: 87.5,
        provider_currency: 'USD',
        usd_cny_rate: 7,
        cost_yuan: 0.7,
      },
    }],
    verified_capabilities: {
      model: 'wan3.0-video',
      text_to_video: true,
      resolutions: ['480p'],
      durations: [2],
      ratios: ['16:9'],
      audio_values: [false],
    },
  };
  mutate(evidence);
  return { root, evidence, now: Date.parse(generatedAt) + 1_000 };
}

test('shared external-model guard registers Wan 3.0 as an isolated provider contract', () => {
  assert.deepEqual(PROVIDERS.toapisWan3, {
    label: 'ToAPIs Wan 3.0 video',
    contract: CONTRACT,
    evidenceFile: EVIDENCE_FILE,
    clientFile: 'backend-node/src/services/toapisWan3VideoClient.js',
    markers: PROVIDERS.toapisWan3.markers,
    surfaceFiles: PROVIDERS.toapisWan3.surfaceFiles,
  });
  assert.deepEqual(TOAPIS_WAN3_CASE, {
    id: 'wan3-t2v-480p-2s-no-audio',
    model: 'wan3.0-video',
    mode: 't2v',
    resolution: '480p',
    ratio: '16:9',
    duration: 2,
    audio: false,
  });
});

test('shared guard audits the real Wan 3.0 client and paid verifier independently', () => {
  assert.doesNotThrow(() => auditToapisWan3Runtime(REPO_ROOT, { auditEvidenceProducer: true }));
});

test('changing only the Wan 3.0 surface does not require fresh legacy FAST/MINI evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-wan3-freshness-'));
  const candidate = path.join(root, 'candidate');
  const current = path.join(root, 'current');
  fs.mkdirSync(candidate);
  fs.mkdirSync(current);
  try {
    for (const relative of [
      'backend-node/src/services/toapisVideoClient.js',
      'backend-node/scripts/verify-toapis-video-models.js',
      'backend-node/src/services/toapisWan3VideoClient.js',
      'backend-node/scripts/verify-toapis-wan3-video.js',
    ]) {
      const source = fs.readFileSync(path.join(REPO_ROOT, relative));
      write(candidate, relative, source);
      write(current, relative, source);
    }
    fs.appendFileSync(
      path.join(candidate, 'backend-node/src/services/toapisWan3VideoClient.js'),
      '\n// reviewed Wan-only provider-wire change\n',
    );
    const result = freshnessRequirements(candidate, current, {
      toapis: true,
      toapisWan3: true,
      usmercari: false,
      lingjing: false,
    });
    assert.equal(result.toapis, false);
    assert.equal(result.toapisPrivateAvatar, false);
    assert.equal(result.toapisWan3, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shared guard accepts a fresh successful Wan 3.0 paid evidence envelope', () => {
  const item = evidenceFixture();
  try {
    assert.doesNotThrow(() => auditEvidenceFixture(item));
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

for (const [label, mutate, expected] of [
  ['invalid audit run id', (value) => { value.run_id = '-'.repeat(36); }, /run id/i],
  ['unknown submission state', (value) => { value.results[0].submission_state = 'indeterminate'; }, /submission|accepted/i],
  ['duplicate POST count', (value) => { value.results[0].post_count = 2; }, /post|submit/i],
  ['task-to-artifact binding drift', (value) => { value.results[0].provider_task_id = 'another-task'; }, /task|artifact/i],
  ['request digest drift', (value) => { value.results[0].request.prompt += ' changed'; }, /request|digest/i],
  ['missing readable artifact', (value) => { value.results[0].artifact.output_file = 'missing.mp4'; }, /artifact|missing|file/i],
  ['billing drift', (value) => { value.results[0].billing.cost_yuan = 0.6; }, /billing|cost/i],
  ['unverified capability expansion', (value) => { value.verified_capabilities.resolutions.push('1080p'); }, /capabilit/i],
]) test(`shared guard rejects Wan 3.0 ${label}`, () => {
  const item = evidenceFixture(mutate);
  try {
    assert.throws(() => auditEvidenceFixture(item), expected);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('Wan 3.0 evidence freshness is enforced only when its own surface changed', () => {
  const item = evidenceFixture();
  const staleNow = item.now + (2 * 24 * 60 * 60 * 1_000);
  try {
    assert.doesNotThrow(() => auditEvidenceFixture(item, staleNow, false));
    assert.throws(() => auditEvidenceFixture(item, staleNow, true), /stale/i);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
