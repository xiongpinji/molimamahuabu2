const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  auditReleaseContract,
  REQUIRED_CASE_IDS,
} = require('../scripts/verify-toapis-video-release-contract');

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function completeEvidence() {
  const modelFor = (id) => id.startsWith('fast-') ? 'seedance-2-fast' : 'seedance-2-mini';
  const modeFor = (id) => id.includes('first-last') ? 'first-last' : id.includes('omni') ? 'omni' : 't2v';
  return {
    contract_version: 'toapis-video-real-verification-v1',
    provider_origin: 'https://toapis.com',
    results: REQUIRED_CASE_IDS.map((id, index) => {
      const generateAudio = id === 'fast-t2v-480' || id === 'mini-t2v-480';
      const resolution = id.endsWith('-720') ? '720p' : '480p';
      const duration = id.startsWith('fast-t2v-') ? 5 : 4;
      return ({
      id,
      model: modelFor(id),
      mode: modeFor(id),
      requested_resolution: resolution,
      requested_duration: duration,
      status: 'completed',
      provider_task_id: `tsk-${id}`,
      request: {
        model: modelFor(id),
        resolution,
        duration,
        aspect_ratio: '16:9',
        generate_audio: generateAudio,
        ...(modeFor(id) === 'first-last' ? {
          image_with_roles: [
            { url: 'https://assets.example/first.png', role: 'first_frame' },
            { url: 'https://assets.example/last.png', role: 'last_frame' },
          ],
        } : {}),
        ...(modeFor(id) === 'omni' ? {
          image_with_roles: [{ url: 'https://assets.example/ref.png', role: 'reference_image' }],
          video_with_roles: [{ url: 'https://assets.example/ref.mp4', role: 'reference_video' }],
          audio_with_roles: [{ url: 'https://assets.example/ref.mp3', role: 'reference_audio' }],
        } : {}),
      },
      artifact: {
        public_url: `https://molimama.vip/static/verification/${id}.mp4`,
        output_file: `${id}.mp4`,
        bytes: 1024,
        sha256: crypto.createHash('sha256').update(id).digest('hex'),
        ffprobe: {
          width: id.endsWith('-720') ? 1280 : 864,
          height: id.endsWith('-720') ? 720 : 496,
          duration_seconds: duration,
          video_codec: 'h264',
          has_audio: generateAudio,
        },
      },
      billing: {
        before: {
          used_balance: Number((2.3 + index * 0.1).toFixed(1)),
          used_credits: 460 + index * 20,
          credits_per_usd: 200,
          captured_at: new Date(Date.UTC(2026, 7, 7, 0, index * 2)).toISOString(),
        },
        after: {
          used_balance: Number((2.4 + index * 0.1).toFixed(1)),
          used_credits: 480 + index * 20,
          credits_per_usd: 200,
          captured_at: new Date(Date.UTC(2026, 7, 7, 0, index * 2 + 1)).toISOString(),
        },
        debited_balance: 0.1,
        debited_credits: 20,
        usd_cny_rate: 7.2,
        cost_yuan: 0.72,
        reviewed: true,
        review_run_id: 'review-run-1',
        reviewed_at: '2026-08-07T01:00:00.000Z',
      },
      });
    }),
    cost_review: {
      run_id: 'review-run-1',
      reviewed_at: '2026-08-07T01:00:00.000Z',
      completed_before_run: [...REQUIRED_CASE_IDS],
      submitted_case_ids: [],
    },
    pricing: [
      ['seedance-2-fast', '480p'], ['seedance-2-fast', '720p'],
      ['seedance-2-mini', '480p'], ['seedance-2-mini', '720p'],
    ].map(([model, resolution]) => {
      const cost = model === 'seedance-2-fast' ? 0.584 : resolution === '480p' ? 0.3358 : 0.6789;
      return {
        model,
        resolution,
        credits_per_second: Math.ceil(Number((cost * 875).toFixed(6))),
        cost_yuan_per_second: cost,
        reviewed: true,
      };
    }),
  };
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toapis-release-contract-'));
  write(root, 'backend-node/src/services/toapisVideoClient.js', `
    const TOAPIS_VIDEO_MODELS = {
      'seedance-2-fast': { resolutions: ['480p', '720p'] },
      'seedance-2-mini': { resolutions: ['480p', '720p'] },
    };
    function buildToapisVideoBody() { return { image_with_roles: [], video_with_roles: [], audio_with_roles: [] }; }
  `);
  write(root, 'backend-node/src/services/videoClient.js', `
    if (protocol === 'toapis_video') return toapisVideoClient.callToapisVideoApi(config, log, opts);
  `);
  write(root, 'backend-node/src/services/videoService.js', `
    function gate() { return toapisReadyState(db, model) && requireVerifiedToapisReferenceCapabilities(state, refs); }
  `);
  write(root, 'backend-node/src/services/canvasModelCatalogService.js', `
    const STRICT_VERIFIED_PROTOCOLS = new Set(['usmercari_image', 'toapis_video']);
    if (config.verification_status !== 'verified' || !hasConnectionCredential(config)) return false;
    const verified_capabilities = config.verified_capabilities;
  `);
  write(root, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue', '<strong class="canvas-credit-callout-v1">本次预计扣除</strong>');
  write(root, 'frontweb/src/views/FilmCreate.vue', '<strong class="canvas-credit-callout-v1">本次预计扣除</strong>');
  const evidencePath = path.join(root, 'docs/evidence/toapis-video-verification.json');
  write(root, 'docs/evidence/toapis-video-verification.json', JSON.stringify(completeEvidence()));
  return { root, evidencePath };
}

describe('ToAPIs protected release contract', () => {
  it('accepts the complete synthetic protected contract', () => {
    const fixture = makeFixture();
    try {
      assert.deepEqual(auditReleaseContract(fixture), []);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  for (const [name, mutate, expected] of [
    ['protocol branch', ({ root }) => write(root, 'backend-node/src/services/videoClient.js', 'module.exports = {}'), '协议'],
    ['Mini 720 evidence', ({ evidencePath }) => {
      const data = JSON.parse(fs.readFileSync(evidencePath));
      data.results = data.results.filter((item) => item.id !== 'mini-t2v-720');
      fs.writeFileSync(evidencePath, JSON.stringify(data));
    }, 'mini-t2v-720'],
    ['reference evidence', ({ evidencePath }) => {
      const data = JSON.parse(fs.readFileSync(evidencePath));
      data.results.find((item) => item.id === 'fast-omni-480').request.audio_with_roles = [];
      fs.writeFileSync(evidencePath, JSON.stringify(data));
    }, '参考'],
    ['request model binding', ({ evidencePath }) => {
      const data = JSON.parse(fs.readFileSync(evidencePath));
      data.results.find((item) => item.id === 'mini-t2v-720').request.model = 'seedance-2-fast';
      fs.writeFileSync(evidencePath, JSON.stringify(data));
    }, 'mini-t2v-720'],
    ['request duration binding', ({ evidencePath }) => {
      const data = JSON.parse(fs.readFileSync(evidencePath));
      data.results.find((item) => item.id === 'fast-t2v-480').request.duration = 15;
      fs.writeFileSync(evidencePath, JSON.stringify(data));
    }, 'fast-t2v-480'],
    ['720 media band', ({ evidencePath }) => {
      const data = JSON.parse(fs.readFileSync(evidencePath));
      data.results.find((item) => item.id === 'fast-t2v-720').artifact.ffprobe = {
        ...data.results.find((item) => item.id === 'fast-t2v-720').artifact.ffprobe,
        width: 864,
        height: 496,
      };
      fs.writeFileSync(evidencePath, JSON.stringify(data));
    }, 'fast-t2v-720'],
    ['unique provider task binding', ({ evidencePath }) => {
      const data = JSON.parse(fs.readFileSync(evidencePath));
      data.results[1].provider_task_id = data.results[0].provider_task_id;
      fs.writeFileSync(evidencePath, JSON.stringify(data));
    }, '重复'],
    ['balance delta binding', ({ evidencePath }) => {
      const data = JSON.parse(fs.readFileSync(evidencePath));
      data.results[0].billing.debited_balance = 99;
      fs.writeFileSync(evidencePath, JSON.stringify(data));
    }, 'fast-t2v-480'],
    ['same-run cost confirmation', ({ evidencePath }) => {
      const data = JSON.parse(fs.readFileSync(evidencePath));
      data.cost_review.submitted_case_ids = ['fast-t2v-480'];
      fs.writeFileSync(evidencePath, JSON.stringify(data));
    }, '零 POST'],
    ['non-overlapping balance windows', ({ evidencePath }) => {
      const data = JSON.parse(fs.readFileSync(evidencePath));
      data.results[1].billing = JSON.parse(JSON.stringify(data.results[0].billing));
      fs.writeFileSync(evidencePath, JSON.stringify(data));
    }, '余额|完整发布矩阵'],
    ['two resolution prices', ({ evidencePath }) => {
      const data = JSON.parse(fs.readFileSync(evidencePath));
      data.pricing = data.pricing.filter((item) => item.resolution !== '720p');
      fs.writeFileSync(evidencePath, JSON.stringify(data));
    }, '价格'],
    ['public price floor', ({ evidencePath }) => {
      const data = JSON.parse(fs.readFileSync(evidencePath));
      data.pricing.find((item) => item.model === 'seedance-2-mini' && item.resolution === '720p').cost_yuan_per_second = 0.1;
      fs.writeFileSync(evidencePath, JSON.stringify(data));
    }, '价格'],
    ['exact reviewed price', ({ evidencePath }) => {
      const data = JSON.parse(fs.readFileSync(evidencePath));
      const price = data.pricing.find((item) => item.model === 'seedance-2-fast' && item.resolution === '480p');
      price.cost_yuan_per_second = 1000;
      price.credits_per_second = 875000;
      fs.writeFileSync(evidencePath, JSON.stringify(data));
    }, '价格'],
    ['strict catalog gate', ({ root }) => write(root, 'backend-node/src/services/canvasModelCatalogService.js', 'module.exports = {}'), '目录'],
    ['canvas credit contract', ({ root }) => {
      write(root, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue', '<span>cost</span>');
      write(root, 'frontweb/src/views/FilmCreate.vue', '<span>cost</span>');
    }, 'canvas-credit-callout-v1'],
  ]) it(`rejects removal of ${name}`, () => {
    const fixture = makeFixture();
    try {
      mutate(fixture);
      assert.match(auditReleaseContract(fixture).join('\n'), new RegExp(expected, 'i'));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects leaked bearer credentials in audited source or evidence', () => {
    const fixture = makeFixture();
    try {
      const leakedTestValue = ['sk', 'example', 'leaked', 'secret', 'value'].join('-');
      write(fixture.root, 'backend-node/src/leaked.js', `const key = '${leakedTestValue}';`);
      assert.match(auditReleaseContract(fixture).join('\n'), /疑似 Key/);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
