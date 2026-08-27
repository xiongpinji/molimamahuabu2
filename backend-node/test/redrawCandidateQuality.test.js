'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  verifyCandidateQuality,
} = require('../src/services/redrawCandidateQualityService');

const CANDIDATE_SHA256 = 'a'.repeat(64);
const DEPENDENCY_HASH = 'b'.repeat(64);
const AUDIO_EVIDENCE_HASH = 'c'.repeat(64);

function candidateInput(overrides = {}) {
  return {
    version_id: 11,
    shot_id: 22,
    video_generation_id: 33,
    candidate_sha256: CANDIDATE_SHA256,
    dependency_hash: DEPENDENCY_HASH,
    ...overrides,
  };
}

function qualityDeps(overrides = {}) {
  return {
    async probeMedia() {
      return {
        readable: true,
        duration_matches: true,
        dimensions_match: true,
        candidate_sha256: CANDIDATE_SHA256,
      };
    },
    async verifyFullFrameCoverage() {
      return {
        dependency_hash: DEPENDENCY_HASH,
        dependencies_current: true,
        original_person_residual: false,
        original_text_residual: false,
        identity: {
          all_bound: true,
          stable: true,
          person_count_matches: true,
          relationships_match: true,
        },
      };
    },
    async verifyLocale() {
      return {
        language: 'en-US',
        target_language_matches: true,
      };
    },
    async verifyNativeAudio() {
      return {
        has_audio: true,
        dialogue_mode: 'dialogue',
        language: 'en-US',
        exact_target_text: true,
        speaker_voice_matches: true,
        ambient_audio_safe: true,
        evidence_hash: AUDIO_EVIDENCE_HASH,
      };
    },
    async verifySubtitles() {
      return { present: true, within_shot: true };
    },
    async verifyLipSync() {
      return { evidence_available: true, passed: true };
    },
    ...overrides,
  };
}

async function verifyWith(overrides = {}) {
  return verifyCandidateQuality(
    { tenantId: 'tenant-a', userId: 'user-a' },
    candidateInput(),
    qualityDeps(overrides),
  );
}

test('候选只有全部当前证据通过时可自动批准', async () => {
  const calls = [];
  const deps = qualityDeps();
  for (const name of Object.keys(deps)) {
    const original = deps[name];
    deps[name] = async (...args) => {
      calls.push(name);
      assert.deepEqual(args[1], candidateInput());
      return original(...args);
    };
  }

  const result = await verifyCandidateQuality(
    { tenantId: 'tenant-a', userId: 'user-a' },
    candidateInput(),
    deps,
  );

  assert.equal(result.decision, 'approved');
  assert.deepEqual(result.reason_codes, []);
  assert.equal(result.metrics.media.readable, true);
  assert.equal(result.metrics.media.hash_matches, true);
  assert.equal(result.metrics.identity.all_bound, true);
  assert.equal(result.metrics.dialogue.exact_target_text, true);
  assert.equal(result.metrics.lip_sync.passed, true);
  assert.deepEqual(calls, [
    'probeMedia',
    'verifyFullFrameCoverage',
    'verifyLocale',
    'verifyNativeAudio',
    'verifySubtitles',
    'verifyLipSync',
  ]);
});

test('严格输入只接受服务端解析后的候选 ID 与哈希，客户端指标或批准结论在调用验证器前被拒绝', async () => {
  for (const forged of [
    { metrics: { media: { readable: true } } },
    { approval: 'approved' },
    { decision: 'approved' },
    { provider: 'forged' },
  ]) {
    let calls = 0;
    const deps = qualityDeps({
      async probeMedia() {
        calls += 1;
        return {};
      },
    });
    await assert.rejects(
      () => verifyCandidateQuality({}, candidateInput(forged), deps),
      { code: 'REDRAW_CANDIDATE_QUALITY_INPUT_INVALID' },
    );
    assert.equal(calls, 0);
  }

  for (const invalid of [
    candidateInput({ shot_id: 0 }),
    candidateInput({ video_generation_id: '33' }),
    candidateInput({ candidate_sha256: 'not-a-sha' }),
    candidateInput({ dependency_hash: null }),
  ]) {
    await assert.rejects(
      () => verifyCandidateQuality({}, invalid, qualityDeps()),
      { code: 'REDRAW_CANDIDATE_QUALITY_INPUT_INVALID' },
    );
  }
});

test('媒体不可读、时长错误、尺寸错误和候选哈希漂移逐项拒绝', async (t) => {
  const cases = [
    ['文件不可读', { readable: false }, 'media_unreadable'],
    ['时长错误', { duration_matches: false }, 'media_duration_mismatch'],
    ['尺寸错误', { dimensions_match: false }, 'media_dimensions_mismatch'],
    ['哈希漂移', { candidate_sha256: 'd'.repeat(64) }, 'candidate_hash_mismatch'],
  ];

  for (const [name, patch, reason] of cases) {
    await t.test(name, async () => {
      const result = await verifyWith({
        async probeMedia() {
          return {
            readable: true,
            duration_matches: true,
            dimensions_match: true,
            candidate_sha256: CANDIDATE_SHA256,
            ...patch,
          };
        },
      });
      assert.equal(result.decision, 'rejected');
      assert.equal(result.reason_codes.includes(reason), true);
    });
  }
});

test('当前角色或服装依赖哈希变化以及依赖非当前态都会阻止批准', async (t) => {
  for (const [name, patch] of [
    ['角色哈希变化', { dependency_hash: 'e'.repeat(64) }],
    ['服装哈希变化', { dependency_hash: 'f'.repeat(64) }],
    ['依赖已失效', { dependencies_current: false }],
  ]) {
    await t.test(name, async () => {
      const result = await verifyWith({
        async verifyFullFrameCoverage() {
          return {
            dependency_hash: DEPENDENCY_HASH,
            dependencies_current: true,
            original_person_residual: false,
            original_text_residual: false,
            identity: {
              all_bound: true,
              stable: true,
              person_count_matches: true,
              relationships_match: true,
            },
            ...patch,
          };
        },
      });
      assert.equal(result.decision, 'rejected');
      assert.equal(result.reason_codes.includes('dependency_hash_stale'), true);
    });
  }
});

test('原人物或原文字残留逐项拒绝', async (t) => {
  for (const [name, patch, reason] of [
    ['原人物残留', { original_person_residual: true }, 'original_person_residual'],
    ['原文字残留', { original_text_residual: true }, 'original_text_residual'],
  ]) {
    await t.test(name, async () => {
      const deps = qualityDeps();
      const baseline = await deps.verifyFullFrameCoverage();
      const result = await verifyWith({
        async verifyFullFrameCoverage() { return { ...baseline, ...patch }; },
      });
      assert.equal(result.decision, 'rejected');
      assert.equal(result.reason_codes.includes(reason), true);
    });
  }
});

test('身份漂移、人物数量错误和关系错误逐项拒绝', async (t) => {
  for (const [name, patch, reason] of [
    ['身份漂移', { stable: false }, 'identity_drift'],
    ['人物数量错误', { person_count_matches: false }, 'person_count_mismatch'],
    ['人物关系错误', { relationships_match: false }, 'relationship_mismatch'],
    ['身份未全部绑定', { all_bound: false }, 'identity_not_all_bound'],
  ]) {
    await t.test(name, async () => {
      const deps = qualityDeps();
      const baseline = await deps.verifyFullFrameCoverage();
      const result = await verifyWith({
        async verifyFullFrameCoverage() {
          return { ...baseline, identity: { ...baseline.identity, ...patch } };
        },
      });
      assert.equal(result.decision, 'rejected');
      assert.equal(result.reason_codes.includes(reason), true);
    });
  }
});

test('有声镜头无音轨与静默镜头出现对白分别拒绝', async (t) => {
  await t.test('有声镜头无音轨', async () => {
    const deps = qualityDeps();
    const baseline = await deps.verifyNativeAudio();
    const result = await verifyWith({
      async verifyNativeAudio() { return { ...baseline, has_audio: false }; },
    });
    assert.equal(result.decision, 'rejected');
    assert.equal(result.reason_codes.includes('audio_track_missing'), true);
  });

  await t.test('静默镜头出现对白', async () => {
    const deps = qualityDeps();
    const baseline = await deps.verifyNativeAudio();
    const result = await verifyWith({
      async verifyNativeAudio() {
        return {
          ...baseline,
          dialogue_mode: 'silent',
          exact_target_text: true,
        };
      },
    });
    assert.equal(result.decision, 'rejected');
    assert.equal(result.reason_codes.includes('silent_shot_dialogue_detected'), true);
  });
});

test('目标语言、精确台词和角色声音错误逐项拒绝', async (t) => {
  await t.test('目标语言错误', async () => {
    const result = await verifyWith({
      async verifyLocale() { return { language: 'zh-CN', target_language_matches: false }; },
    });
    assert.equal(result.decision, 'rejected');
    assert.equal(result.reason_codes.includes('target_language_mismatch'), true);
  });

  for (const [name, patch, reason] of [
    ['台词不完全匹配', { exact_target_text: false }, 'target_dialogue_mismatch'],
    ['声音属于错误角色', { speaker_voice_matches: false }, 'speaker_voice_mismatch'],
    ['环境声不安全', { ambient_audio_safe: false }, 'ambient_audio_unsafe'],
  ]) {
    await t.test(name, async () => {
      const deps = qualityDeps();
      const baseline = await deps.verifyNativeAudio();
      const result = await verifyWith({
        async verifyNativeAudio() { return { ...baseline, ...patch }; },
      });
      assert.equal(result.decision, 'rejected');
      assert.equal(result.reason_codes.includes(reason), true);
    });
  }
});

test('字幕缺失或超出镜头分别拒绝', async (t) => {
  for (const [name, evidence, reason] of [
    ['字幕缺失', { present: false, within_shot: true }, 'subtitle_missing'],
    ['字幕超出镜头', { present: true, within_shot: false }, 'subtitle_out_of_bounds'],
  ]) {
    await t.test(name, async () => {
      const result = await verifyWith({
        async verifySubtitles() { return evidence; },
      });
      assert.equal(result.decision, 'rejected');
      assert.equal(result.reason_codes.includes(reason), true);
    });
  }
});

test('口型证据缺失固定 needs_review，明确不通过则拒绝', async (t) => {
  await t.test('口型证据缺失', async () => {
    const result = await verifyWith({
      async verifyLipSync() { return { evidence_available: false, passed: false }; },
    });
    assert.equal(result.decision, 'needs_review');
    assert.deepEqual(result.reason_codes, ['lip_sync_evidence_missing']);
  });

  await t.test('口型明确不通过', async () => {
    const result = await verifyWith({
      async verifyLipSync() { return { evidence_available: true, passed: false }; },
    });
    assert.equal(result.decision, 'rejected');
    assert.deepEqual(result.reason_codes, ['lip_sync_failed']);
  });

  for (const [name, lipSync, decision, reason] of [
    ['静默镜头口型证据缺失', { evidence_available: false, passed: false }, 'needs_review', 'lip_sync_evidence_missing'],
    ['静默镜头口型明确不通过', { evidence_available: true, passed: false }, 'rejected', 'lip_sync_failed'],
  ]) {
    await t.test(name, async () => {
      const deps = qualityDeps();
      const baselineAudio = await deps.verifyNativeAudio();
      const result = await verifyWith({
        async verifyNativeAudio() {
          return {
            ...baselineAudio,
            dialogue_mode: 'silent',
            language: null,
            exact_target_text: null,
          };
        },
        async verifyLipSync() { return lipSync; },
      });
      assert.equal(result.decision, decision);
      assert.deepEqual(result.reason_codes, [reason]);
    });
  }
});

test('质量结果只投影白名单指标，不泄露验证器原始正文或路径', async () => {
  const deps = qualityDeps();
  const baselineAudio = await deps.verifyNativeAudio();
  const result = await verifyWith({
    async verifyNativeAudio() {
      return {
        ...baselineAudio,
        raw_response: { authorization: 'Bearer secret' },
        local_path: 'C:\\private\\candidate.mp4',
      };
    },
  });
  const serialized = JSON.stringify(result);
  assert.equal(result.decision, 'approved');
  assert.equal(serialized.includes('Bearer secret'), false);
  assert.equal(serialized.includes('C:\\private'), false);
  assert.deepEqual(Object.keys(result.metrics.dialogue), [
    'has_audio',
    'dialogue_mode',
    'language',
    'language_matches',
    'exact_target_text',
    'speaker_voice_matches',
    'ambient_audio_safe',
    'evidence_hash',
  ]);
});
