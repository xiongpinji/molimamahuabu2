const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const { spawnSync } = require('node:child_process');

const GUARD = path.resolve(__dirname, '../../deploy/release-guard/verify-external-model-release.js');
const TOAPIS_CONTRACT = 'toapis-video-real-verification-v1';
const USMERCARI_CONTRACT = 'usmercari-image-real-verification-v1';
const TOAPIS_FILE = 'toapis-video-verification.json';
const USMERCARI_FILE = 'usmercari-image-verification.json';

function describeRootEvidence(name, fn) {
  const requiresRootFixture = process.platform !== 'win32'
    && typeof process.getuid === 'function'
    && process.getuid() !== 0;
  return describe(name, requiresRootFixture
    ? { skip: 'requires a root-owned release evidence fixture' }
    : {}, fn);
}

const TOAPIS_CASES = Object.freeze([
  { id: 'fast-t2v-480', model: 'seedance-2-fast', mode: 't2v', resolution: '480p', duration: 5, audio: true },
  { id: 'fast-t2v-720', model: 'seedance-2-fast', mode: 't2v', resolution: '720p', duration: 5, audio: false },
  { id: 'mini-t2v-480', model: 'seedance-2-mini', mode: 't2v', resolution: '480p', duration: 4, audio: true },
  { id: 'mini-t2v-720', model: 'seedance-2-mini', mode: 't2v', resolution: '720p', duration: 4, audio: false },
  { id: 'fast-first-last-480', model: 'seedance-2-fast', mode: 'first-last', resolution: '480p', duration: 4, audio: false },
  { id: 'mini-first-last-480', model: 'seedance-2-mini', mode: 'first-last', resolution: '480p', duration: 4, audio: false },
  { id: 'fast-omni-480', model: 'seedance-2-fast', mode: 'omni', resolution: '480p', duration: 4, audio: false },
  { id: 'mini-omni-480', model: 'seedance-2-mini', mode: 'omni', resolution: '480p', duration: 4, audio: false },
]);

const USMERCARI_CASES = Object.freeze([
  ['gpt-image-2-2-4k', 'text-to-image', '1k'],
  ['gpt-image-2-2-4k', 'text-to-image', '2k'],
  ['gpt-image-2-2-4k', 'image-to-image', '1k'],
  ['nano-banana-2', 'text-to-image', '1k'],
  ['nano-banana-2', 'text-to-image', '2k'],
  ['nano-banana-2', 'text-to-image', '4k'],
  ['nano-banana-2', 'image-to-image', '1k'],
]);

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function jpegSegment(marker, data) {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, data]);
}

const jpegCache = new Map();
function validJpeg(width, height, marker) {
  const key = `${width}x${height}:${marker}`;
  if (jpegCache.has(key)) return jpegCache.get(key);
  const quantization = Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]);
  const frame = Buffer.alloc(9);
  frame[0] = 8;
  frame.writeUInt16BE(height, 1);
  frame.writeUInt16BE(width, 3);
  frame[5] = 1;
  frame[6] = 1;
  frame[7] = 0x11;
  frame[8] = 0;
  const huffmanCounts = Buffer.concat([Buffer.from([1]), Buffer.alloc(15)]);
  const huffman = Buffer.concat([
    Buffer.from([0x00]), huffmanCounts, Buffer.from([0]),
    Buffer.from([0x10]), huffmanCounts, Buffer.from([0]),
  ]);
  const scan = Buffer.from([1, 1, 0x00, 0, 63, 0]);
  const blockCount = Math.ceil(width / 8) * Math.ceil(height / 8);
  const entropy = Buffer.alloc(Math.ceil((blockCount * 2) / 8));
  const usedBits = (blockCount * 2) % 8;
  if (usedBits) entropy[entropy.length - 1] |= (1 << (8 - usedBits)) - 1;
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xfe, Buffer.from([marker])),
    jpegSegment(0xdb, quantization),
    jpegSegment(0xc0, frame),
    jpegSegment(0xc4, huffman),
    jpegSegment(0xda, scan),
    entropy,
    Buffer.from([0xff, 0xd9]),
  ]);
  jpegCache.set(key, bytes);
  return bytes;
}

function cleanEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/evidence.*(?:path|root)|(?:path|root).*evidence|verify.*output.*dir/i.test(name)) delete env[name];
  }
  return { ...env, ...overrides };
}

function runGuard(candidate, evidenceRoot, options = {}) {
  const args = options.args || [candidate, evidenceRoot];
  return spawnSync(process.execPath, [GUARD, ...args], {
    encoding: 'utf8',
    env: cleanEnvironment(options.env),
    windowsHide: true,
  });
}

function assertPass(result) {
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /EXTERNAL_MODEL_RELEASE_OK/);
}

function assertFail(result, expected) {
  assert.notEqual(result.status, 0, `unexpected pass:\n${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, expected);
}

function protectedRuntimeSources(candidate) {
  write(candidate, 'backend-node/src/services/externalModelEvidenceService.js', `
    const MANIFEST_CONTRACT = 'external-model-release-evidence-manifest-v1';
    const EVIDENCE_ROOT = '/opt/moli-drama/shared/release-evidence/external-models-v1';
    const MANIFEST_FILE = 'manifest.json';
    const CONTRACT_BY_MODEL = Object.freeze({
      'seedance-2-fast': 'toapis-video-real-verification-v1',
      'seedance-2-mini': 'toapis-video-real-verification-v1',
      'gpt-image-2-2-4k': 'usmercari-image-real-verification-v1',
      'nano-banana-2': 'usmercari-image-real-verification-v1',
    });
    function hasTrustedEvidenceBinding(model, capabilities) {
      const trusted = readTrustedEvidence(model);
      return Boolean(trusted && capabilities
        && String(capabilities.evidence_contract || '') === trusted.contract
        && String(capabilities.evidence_sha256 || '').toLowerCase() === trusted.sha256);
    }
  `);
  write(candidate, 'backend-node/src/services/toapisVideoClient.js', `
    const TOAPIS_VIDEO_MODELS = Object.freeze({
      'seedance-2-fast': Object.freeze({ durations: Object.freeze([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]), resolutions: Object.freeze(['480p', '720p']) }),
      'seedance-2-mini': Object.freeze({ durations: Object.freeze([4, 8, 10, 12, 15]), resolutions: Object.freeze(['480p', '720p']) }),
    });
    function normalizeToapisBaseUrl(value) {
      const parsed = new URL(value || 'https://toapis.com');
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'toapis.com' || parsed.username || parsed.password) throw new Error('official only');
      return 'https://toapis.com';
    }
    function validateToapisVideoOptions(opts) {
      const first = opts.first_frame_url;
      const last = opts.last_frame_url;
      const images = opts.reference_urls || [];
      const videos = opts.reference_video_urls || [];
      const audio = opts.reference_audio_urls || [];
      if ((first || last) && (images.length || videos.length || audio.length)) throw new Error('mutually exclusive');
      if (last && !first) throw new Error('last frame needs first frame');
      return opts;
    }
    function buildToapisVideoBody(opts) {
      const checked = validateToapisVideoOptions(opts);
      const image_with_roles = [];
      if (checked.first_frame_url) image_with_roles.push({ url: checked.first_frame_url, role: 'first_frame' });
      if (checked.last_frame_url) image_with_roles.push({ url: checked.last_frame_url, role: 'last_frame' });
      for (const url of checked.reference_urls || []) image_with_roles.push({ url, role: 'reference_image' });
      const video_with_roles = (checked.reference_video_urls || []).map((url) => ({ url, role: 'reference_video' }));
      const audio_with_roles = (checked.reference_audio_urls || []).map((url) => ({ url, role: 'reference_audio' }));
      return { image_with_roles, video_with_roles, audio_with_roles };
    }
  `);
  write(candidate, 'backend-node/src/services/videoClient.js', `
    function getDefaultVideoConfig(configs, preferredModel) {
      const config = configs.find((item) => item.api_protocol === 'toapis_video');
      const capabilities = config && config.verified_capabilities && config.verified_capabilities[preferredModel];
      if (!config || config.verification_status !== 'verified' || !hasConnectionCredential(config)
          || !hasTrustedEvidenceBinding(preferredModel, capabilities)) return null;
      return config;
    }
    async function callVideoApi(protocol, config, log, opts) {
      if (protocol === 'toapis_video') {
        return toapisVideoClient.callToapisVideoApi(config, log, opts);
      }
      return null;
    }
  `);
  write(candidate, 'backend-node/src/services/videoService.js', `
    function toapisReadyState(db, model) {
      const config = matchingToapisConfigs(db, model)[0];
      const capabilities = config && config.verified_capabilities && config.verified_capabilities[model];
      if (!config || !config.is_active || config.verification_status !== 'verified' || !hasConnectionCredential(config)
          || !capabilities || !hasTrustedEvidenceBinding(model, capabilities)
          || !capabilities.durations.length || !capabilities.resolutions.length) {
        throw videoRequestError('MODEL_NOT_VERIFIED');
      }
      return { config, capabilities, model };
    }
    function requireVerifiedToapisReferenceCapabilities(state, refs) {
      if (refs.generateAudio && state.capabilities.supportsAudio !== true) throw videoRequestError('MODEL_NOT_VERIFIED');
      if (refs.referenceAudioUrls.length && state.capabilities.supportsAudioReference !== true) throw videoRequestError('MODEL_NOT_VERIFIED');
    }
    function requireToapisResolutionPrice(db, model, resolution) {
      const price = findModelPrice(db, model);
      if (!price || !price.resolution_prices[resolution]) throw videoRequestError('MODEL_RESOLUTION_PRICE_REQUIRED');
    }
    function createVideo(db, body) {
      const state = toapisReadyState(db, body.model);
      requireVerifiedToapisReferenceCapabilities(state, body);
      requireToapisResolutionPrice(db, body.model, body.resolution);
      return reserveCredits(db, body);
    }
  `);
  write(candidate, 'backend-node/src/services/usmercariImageClient.js', `
    const USMERCARI_IMAGE_ORIGIN = 'https://chat-ai.mercarimx.com';
    const USMERCARI_IMAGE_MODELS = Object.freeze({
      'gpt-image-2-2-4k': Object.freeze({ resolutions: Object.freeze(['1k', '2k']), maxReferences: 6 }),
      'nano-banana-2': Object.freeze({ resolutions: Object.freeze(['1k', '2k', '4k']), maxReferences: 6 }),
    });
    function normalizeUsmercariImageBaseUrl(value) {
      const parsed = new URL(value || USMERCARI_IMAGE_ORIGIN);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'chat-ai.mercarimx.com' || parsed.username || parsed.password) throw new Error('official only');
      return USMERCARI_IMAGE_ORIGIN;
    }
    async function callUsmercariImageApi(config) {
      const baseUrl = normalizeUsmercariImageBaseUrl(config?.base_url);
      return fetch(baseUrl + '/v1/images/generations', { method: 'POST' });
    }
    module.exports = { USMERCARI_IMAGE_ORIGIN, USMERCARI_IMAGE_MODELS, normalizeUsmercariImageBaseUrl, callUsmercariImageApi };
  `);
  write(candidate, 'backend-node/src/services/imageClient.js', `
    function assertUsmercariImageSubmitReady(db, config, model, payload) {
      if (config.verification_status !== 'verified') throw imageRequestError('MODEL_NOT_VERIFIED');
      if (!hasConnectionCredential(config)) throw imageRequestError('MODEL_CREDENTIAL_MISSING');
      const capabilities = config.verified_capabilities && config.verified_capabilities[model];
      if (!capabilities || !hasTrustedEvidenceBinding(model, capabilities)) throw imageRequestError('MODEL_NOT_VERIFIED');
      if (capabilities.supportsTextToImage !== true) throw imageRequestError('MODEL_NOT_VERIFIED');
      if (payload.reference_image_urls.length && capabilities.supportsImageReference !== true) throw imageRequestError('IMAGE_REFERENCE_NOT_VERIFIED');
      if (payload.reference_image_urls.length > capabilities.maxReferences) throw imageRequestError('IMAGE_REFERENCE_LIMIT_EXCEEDED');
      if (!capabilities.resolutions.includes(payload.resolution)) throw imageRequestError('IMAGE_RESOLUTION_NOT_VERIFIED');
      if (!requireImageResolutionPrice(db, model, payload.resolution)) throw imageRequestError('MODEL_RESOLUTION_PRICE_REQUIRED');
    }
    function callImageApi(protocol, config, log, payload) {
      if (protocol === 'usmercari_image') {
        assertUsmercariImageSubmitReady(db, config, payload.model, payload);
        return usmercariImageClient.callUsmercariImageApi(config, log, payload);
      }
      return null;
    }
  `);
  write(candidate, 'backend-node/src/services/imageService.js', `
    function prepareImageRequest(config, selectedModel, req, price) {
      const strictUsmercari = config.provider === 'usmercari_image' || config.api_protocol === 'usmercari_image';
      if (strictUsmercari && (!config || config.verification_status !== 'verified')) throw imageRequestError('MODEL_NOT_VERIFIED');
      if (strictUsmercari && !resolveUsmercariApiKey(config)) throw imageRequestError('MODEL_CREDENTIAL_MISSING');
      const capabilities = config.verified_capabilities && config.verified_capabilities[selectedModel];
      if (strictUsmercari && (!capabilities || capabilities.supportsTextToImage !== true)) throw imageRequestError('MODEL_NOT_VERIFIED');
      if (strictUsmercari && !hasTrustedEvidenceBinding(selectedModel, capabilities)) throw imageRequestError('MODEL_NOT_VERIFIED');
      if (req.reference_images.length && capabilities.supportsImageReference !== true) throw imageRequestError('IMAGE_REFERENCE_NOT_VERIFIED');
      if (!price.resolution_prices[req.resolution]) throw imageRequestError('MODEL_RESOLUTION_PRICE_REQUIRED');
      return reserveCredits(config, req);
    }
  `);
  write(candidate, 'backend-node/src/services/canvasModelCatalogService.js', `
    const STRICT_VERIFIED_PROTOCOLS = new Set(['usmercari_image', 'toapis_video']);
    function visible(config, price, model) {
      const protocol = config.api_protocol;
      if (STRICT_VERIFIED_PROTOCOLS.has(protocol)
          && (config.verification_status !== 'verified' || !hasConnectionCredential(config))) return false;
      const capabilities = config.verified_capabilities && config.verified_capabilities[model];
      if (!capabilities || !hasTrustedEvidenceBinding(model, capabilities) || !capabilities.resolutions.length) return false;
      return capabilities.resolutions.every((resolution) => Number.isSafeInteger(price.resolution_prices[resolution].credits)
        && price.resolution_prices[resolution].credits > 0);
    }
  `);
  write(candidate, 'backend-node/src/services/modelPriceService.js', `
    const STRICT_VERIFIED_PROTOCOLS = new Set(['usmercari_image', 'toapis_video']);
    function isPublicConfigReady(config, price) {
      const protocol = config.api_protocol;
      if (!STRICT_VERIFIED_PROTOCOLS.has(protocol)) return true;
      if (config.verification_status !== 'verified' || !hasConnectionCredential(config)) return false;
      const capabilities = config.verified_capabilities && config.verified_capabilities[price.model];
      if (!capabilities || !hasTrustedEvidenceBinding(price.model, capabilities) || !capabilities.resolutions.length) return false;
      return capabilities.resolutions.every((resolution) => Number.isSafeInteger(price.resolution_prices[resolution].credits)
        && price.resolution_prices[resolution].credits > 0);
    }
  `);
  write(candidate, 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue', `
    <template>
      <span v-if="canGenerate" class="billing-cost" aria-live="polite">
        <template v-if="estimatedCredits">本次预计扣除 <strong>{{ estimatedCredits }}</strong> 积分</template>
        <template v-else>积分待管理员配置</template>
      </span>
    </template>
  `);
  write(candidate, 'frontweb/src/views/FilmCreate.vue', `
    <template>
      <span class="billing-cost canvas-credit-callout-v1" aria-live="polite">
        <strong v-if="imageGenerationCredits">本次预计扣除 {{ imageGenerationCredits }} 积分</strong>
        <strong v-else>积分待管理员配置</strong>
      </span>
      <span class="billing-cost canvas-credit-callout-v1" aria-live="polite">
        <strong v-if="selectedVideoGenerationCredits">本次预计扣除 {{ selectedVideoGenerationCredits }} 积分</strong>
        <strong v-else>积分待管理员配置</strong>
      </span>
    </template>
  `);
}

function timeWindow() {
  const now = Date.now();
  return {
    generatedAt: new Date(now - 60_000).toISOString(),
    validUntil: new Date(now + 86_400_000).toISOString(),
    billingStart: now - 3_600_000,
    reviewedAt: new Date(now - 120_000).toISOString(),
  };
}

function toapisEvidence(evidenceRoot, times) {
  const results = TOAPIS_CASES.map((item, index) => {
    const outputFile = `${item.id}.mp4`;
    const bytes = Buffer.from(`synthetic-video-${item.id}`);
    write(evidenceRoot, path.join('public', 'toapis', outputFile), bytes);
    const beforeBalance = Number((2.3 + index * 0.1).toFixed(1));
    const afterBalance = Number((beforeBalance + 0.1).toFixed(1));
    const beforeCredits = 460 + index * 20;
    const afterCredits = beforeCredits + 20;
    const startedAt = new Date(times.billingStart + index * 120_000).toISOString();
    const generationElapsedSeconds = 60 + index;
    const completedAt = new Date(Date.parse(startedAt) + generationElapsedSeconds * 1000).toISOString();
    const request = {
      model: item.model,
      resolution: item.resolution,
      duration: item.duration,
      aspect_ratio: '16:9',
      generate_audio: item.audio,
    };
    if (item.mode === 'first-last') {
      request.image_with_roles = [
        { url: 'https://assets.molimama.vip/first.png', role: 'first_frame' },
        { url: 'https://assets.molimama.vip/last.png', role: 'last_frame' },
      ];
    } else if (item.mode === 'omni') {
      request.image_with_roles = [{ url: 'https://assets.molimama.vip/ref.png', role: 'reference_image' }];
      request.video_with_roles = [{ url: 'https://assets.molimama.vip/ref.mp4', role: 'reference_video' }];
      request.audio_with_roles = [{ url: 'https://assets.molimama.vip/ref.mp3', role: 'reference_audio' }];
    }
    return {
      id: item.id,
      model: item.model,
      mode: item.mode,
      requested_resolution: item.resolution,
      requested_duration: item.duration,
      status: 'completed',
      provider_task_id: `tsk-${item.id}`,
      speed: {
        submit_latency_ms: 120 + index,
        generation_elapsed_seconds: generationElapsedSeconds,
      },
      started_at: startedAt,
      completed_at: completedAt,
      request,
      artifact: {
        public_url: `https://molimama.vip/verification-assets/toapis/${outputFile}`,
        output_file: outputFile,
        bytes: bytes.length,
        sha256: sha256(bytes),
        ffprobe: {
          format: 'mov,mp4,m4a,3gp,3g2,mj2',
          width: item.resolution === '720p' ? 1280 : 864,
          height: item.resolution === '720p' ? 720 : 496,
          duration_seconds: item.duration,
          video_codec: 'h264',
          has_audio: item.audio,
          audio_codec: item.audio ? 'aac' : null,
        },
      },
      billing: {
        before: {
          used_balance: beforeBalance,
          used_credits: beforeCredits,
          credits_per_usd: 200,
          captured_at: new Date(times.billingStart + index * 120_000).toISOString(),
        },
        after: {
          used_balance: afterBalance,
          used_credits: afterCredits,
          credits_per_usd: 200,
          captured_at: new Date(times.billingStart + index * 120_000 + 60_000).toISOString(),
        },
        debited_balance: 0.1,
        debited_credits: 20,
        usd_cny_rate: 7.2,
        cost_yuan: 0.72,
        reviewed: true,
        review_run_id: 'review-run-2',
        reviewed_at: times.reviewedAt,
      },
    };
  });
  return {
    contract_version: TOAPIS_CONTRACT,
    provider_origin: 'https://toapis.com',
    generated_at: times.generatedAt,
    valid_until: times.validUntil,
    results,
    speed_evidence: {
      measurement_basis: 'actual_verification_run_not_provider_sla',
      cases: results.map((result) => ({
        id: result.id,
        model: result.model,
        resolution: result.requested_resolution,
        mode: result.mode,
        submit_latency_ms: result.speed.submit_latency_ms,
        generation_elapsed_seconds: result.speed.generation_elapsed_seconds,
        started_at: result.started_at,
        completed_at: result.completed_at,
      })),
      model_summary: Object.fromEntries(['seedance-2-fast', 'seedance-2-mini'].map((model) => {
        const values = results
          .filter((result) => result.model === model)
          .map((result) => result.speed.generation_elapsed_seconds);
        return [model, {
          sample_count: values.length,
          min_generation_elapsed_seconds: Math.min(...values),
          max_generation_elapsed_seconds: Math.max(...values),
          avg_generation_elapsed_seconds: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)),
        }];
      })),
    },
    pricing: [
      ['seedance-2-fast', '480p', 0.584, 511],
      ['seedance-2-fast', '720p', 0.584, 511],
      ['seedance-2-mini', '480p', 0.3358, 294],
      ['seedance-2-mini', '720p', 0.6789, 595],
    ].map(([model, resolution, cost, credits]) => ({
      model,
      resolution,
      cost_yuan_per_second: cost,
      credits_per_second: credits,
      reviewed: true,
    })),
    cost_review: {
      run_id: 'review-run-2',
      reviewed_at: times.reviewedAt,
      completed_before_run: TOAPIS_CASES.map((item) => item.id),
      submitted_case_ids: [],
    },
  };
}

function usmercariEvidence(evidenceRoot, times) {
  return {
    contract_version: USMERCARI_CONTRACT,
    provider_origin: 'https://chat-ai.mercarimx.com',
    generated_at: times.generatedAt,
    valid_until: times.validUntil,
    results: USMERCARI_CASES.map(([model, capability, resolution], index) => {
      const id = `${model}|${capability}|${resolution}`;
      const outputFile = `${model}-${capability}-${resolution}.jpg`;
      const edge = resolution === '4k' ? 4096 : resolution === '2k' ? 2048 : 1024;
      const bytes = validJpeg(edge, edge, index + 1);
      write(evidenceRoot, path.join('public', 'usmercari', outputFile), bytes);
      return {
        marker: `${id}|verified`,
        model,
        capability,
        requested_resolution: resolution,
        requested_aspect_ratio: '1:1',
        quantity: 1,
        reference_count: capability === 'image-to-image' ? 1 : 0,
        started_at: times.generatedAt,
        completed_at: times.generatedAt,
        provider_model_id: model === 'gpt-image-2-2-4k'
          ? '135b2740-7f18-477a-a514-f153aeeac763'
          : 'nano-banana-2',
        public_url: `https://molimama.vip/verification-assets/usmercari/${outputFile}`,
        output_file: outputFile,
        content_type: 'image/jpeg',
        bytes: bytes.length,
        width: edge,
        height: edge,
        format: 'jpeg',
        sha256: sha256(bytes),
      };
    }),
    rejected_capabilities: [{
      marker: 'gpt-image-2-2-4k|text-to-image|4k|failed',
      attempts: 2,
      http_status: 400,
      error_code: 'PROVIDER_INVALID_REQUEST',
    }],
    pricing: [
      ['gpt-image-2-2-4k', '1k', 0.08, 70],
      ['gpt-image-2-2-4k', '2k', 0.10, 87],
      ['nano-banana-2', '1k', 0.08, 70],
      ['nano-banana-2', '2k', 0.10, 87],
      ['nano-banana-2', '4k', 0.12, 105],
    ].map(([model, resolution, cost, credits]) => ({
      model,
      resolution,
      cost_yuan_per_image: cost,
      credits_per_image: credits,
      reviewed: true,
    })),
  };
}

function refreshManifest(evidenceRoot, providers) {
  const evidence = {};
  if (providers.toapis) {
    const bytes = fs.readFileSync(path.join(evidenceRoot, TOAPIS_FILE));
    evidence[TOAPIS_CONTRACT] = { file: TOAPIS_FILE, sha256: sha256(bytes) };
  }
  if (providers.usmercari) {
    const bytes = fs.readFileSync(path.join(evidenceRoot, USMERCARI_FILE));
    evidence[USMERCARI_CONTRACT] = { file: USMERCARI_FILE, sha256: sha256(bytes) };
  }
  write(evidenceRoot, 'manifest.json', `${JSON.stringify({
    contract_version: 'external-model-release-evidence-manifest-v1',
    evidence,
  }, null, 2)}\n`);
}

function makeFixture(providers = { toapis: true, usmercari: true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-external-guard-'));
  const candidate = path.join(root, 'candidate');
  const evidenceRoot = path.join(root, 'evidence');
  fs.mkdirSync(candidate);
  fs.mkdirSync(evidenceRoot);
  protectedRuntimeSources(candidate);
  if (!providers.toapis) {
    fs.rmSync(path.join(candidate, 'backend-node/src/services/toapisVideoClient.js'));
    fs.rmSync(path.join(candidate, 'backend-node/src/services/videoClient.js'));
    fs.rmSync(path.join(candidate, 'backend-node/src/services/videoService.js'));
  }
  if (!providers.usmercari) {
    fs.rmSync(path.join(candidate, 'backend-node/src/services/usmercariImageClient.js'));
    fs.rmSync(path.join(candidate, 'backend-node/src/services/imageClient.js'));
    fs.rmSync(path.join(candidate, 'backend-node/src/services/imageService.js'));
  }
  for (const relative of [
    'backend-node/src/services/canvasModelCatalogService.js',
    'backend-node/src/services/modelPriceService.js',
  ]) {
    const target = path.join(candidate, relative);
    const protocols = [
      ...(providers.usmercari ? ['usmercari_image'] : []),
      ...(providers.toapis ? ['toapis_video'] : []),
    ];
    const source = fs.readFileSync(target, 'utf8')
      .replace("new Set(['usmercari_image', 'toapis_video'])", `new Set(${JSON.stringify(protocols)})`);
    fs.writeFileSync(target, source);
  }
  const times = timeWindow();
  if (providers.toapis) write(evidenceRoot, TOAPIS_FILE, `${JSON.stringify(toapisEvidence(evidenceRoot, times), null, 2)}\n`);
  if (providers.usmercari) write(evidenceRoot, USMERCARI_FILE, `${JSON.stringify(usmercariEvidence(evidenceRoot, times), null, 2)}\n`);
  if (providers.toapis || providers.usmercari) refreshManifest(evidenceRoot, providers);
  return { root, candidate, evidenceRoot, providers };
}

function editEvidence(fixture, file, mutate) {
  const target = path.join(fixture.evidenceRoot, file);
  const evidence = JSON.parse(fs.readFileSync(target, 'utf8'));
  mutate(evidence);
  fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`);
  refreshManifest(fixture.evidenceRoot, fixture.providers);
}

function removeSharedRuntime(candidate) {
  fs.rmSync(path.join(candidate, 'backend-node/src/services/canvasModelCatalogService.js'));
  fs.rmSync(path.join(candidate, 'backend-node/src/services/modelPriceService.js'));
  fs.rmSync(path.join(candidate, 'frontweb'), { recursive: true });
}

describeRootEvidence('shared external model release guard CLI', () => {
  it('legacy-passes only when neither protected client nor runtime surface exists', () => {
    const fixture = makeFixture({ toapis: false, usmercari: false });
    removeSharedRuntime(fixture.candidate);
    try {
      assertPass(runGuard(fixture.candidate, fixture.evidenceRoot));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('accepts complete independent ToAPIs and USMercari evidence', () => {
    const fixture = makeFixture();
    try {
      assertPass(runGuard(fixture.candidate, fixture.evidenceRoot));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('decodes evidence without executing candidate or environment-provided dependencies', () => {
    const fixture = makeFixture({ toapis: false, usmercari: true });
    const maliciousRoot = path.join(fixture.root, 'malicious-node-path');
    try {
      write(maliciousRoot, 'sharp/index.js', 'throw new Error("NODE_PATH sharp must not load");');
      assertPass(runGuard(fixture.candidate, fixture.evidenceRoot, { env: { NODE_PATH: maliciousRoot } }));
      const source = fs.readFileSync(GUARD, 'utf8');
      assert.doesNotMatch(source, /(?:require|import)(?:\.resolve)?\s*\([^)]*sharp|node_modules|NODE_PATH|child_process/);
      assert.match(source, /decodeBaselineJpeg/);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('requires only the fixed manifest entry for each detected provider surface', () => {
    for (const providers of [
      { toapis: true, usmercari: false },
      { toapis: false, usmercari: true },
    ]) {
      const fixture = makeFixture(providers);
      try {
        assertPass(runGuard(fixture.candidate, fixture.evidenceRoot));
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it('rejects missing fixed evidence even when a candidate audit script claims success', () => {
    const fixture = makeFixture({ toapis: true, usmercari: false });
    try {
      fs.rmSync(path.join(fixture.evidenceRoot, TOAPIS_FILE));
      write(fixture.candidate, 'backend-node/scripts/verify-toapis-video-release-contract.js', 'module.exports = { auditReleaseContract: () => [] };');
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /ToAPIs|toapis-video-verification|manifest/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('requires exactly CANDIDATE EVIDENCE_ROOT and rejects evidence path environment variables', () => {
    const fixture = makeFixture();
    try {
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot, { args: [fixture.candidate] }), /usage|CANDIDATE/i);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot, { args: [fixture.candidate, fixture.evidenceRoot, '--extra'] }), /usage|CANDIDATE/i);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot, {
        env: { TOAPIS_VIDEO_EVIDENCE_PATH: path.join(fixture.evidenceRoot, TOAPIS_FILE) },
      }), /environment|环境|env/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describeRootEvidence('shared evidence path and freshness safety', () => {
  it('audits root ownership and group/other write protection for every evidence layer', () => {
    const source = fs.readFileSync(GUARD, 'utf8');
    assert.match(source, /stat\.uid\s*!==\s*0/);
    assert.match(source, /stat\.gid\s*!==\s*0/);
    assert.match(source, /stat\.mode\s*&\s*0o022/);
    for (const token of ['EVIDENCE_ALLOWED_ROOT', 'EVIDENCE_ROOT', 'evidence manifest', 'evidence JSON', 'public output_file']) {
      assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('rejects group/other-writable manifest, evidence JSON and public asset on POSIX', { skip: process.platform === 'win32' }, () => {
    for (const relative of [
      '.',
      'evidence',
      path.join('evidence', 'public'),
      path.join('evidence', 'public', 'usmercari'),
      'manifest.json',
      USMERCARI_FILE,
      path.join('public', 'usmercari', `${USMERCARI_CASES[0].join('-')}.png`),
    ]) {
      const fixture = makeFixture({ toapis: false, usmercari: true });
      try {
        const target = relative === '.'
          ? fixture.root
          : relative.startsWith(`evidence${path.sep}`) || relative === 'evidence'
            ? path.join(fixture.root, relative)
            : path.join(fixture.evidenceRoot, relative);
        fs.chmodSync(target, fs.statSync(target).isDirectory() ? 0o777 : 0o666);
        assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /writable|permission|mode|权限/i);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it('rejects a candidate directory symlink', (t) => {
    const fixture = makeFixture();
    const link = path.join(fixture.root, 'candidate-link');
    try {
      try { fs.symlinkSync(fixture.candidate, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
        if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return t.skip(`symlink unavailable: ${error.code}`);
        throw error;
      }
      assertFail(runGuard(link, fixture.evidenceRoot), /symlink|符号链接|realpath/i);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked evidence JSON and output asset', (t) => {
    for (const targetKind of ['json', 'asset']) {
      const fixture = makeFixture({ toapis: true, usmercari: false });
      try {
        const target = targetKind === 'json'
          ? path.join(fixture.evidenceRoot, TOAPIS_FILE)
          : path.join(fixture.evidenceRoot, 'public', 'toapis', `${TOAPIS_CASES[0].id}.mp4`);
        const outside = path.join(fixture.root, `outside-${targetKind}`);
        fs.renameSync(target, outside);
        try { fs.symlinkSync(outside, target, 'file'); } catch (error) {
          if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return t.skip(`symlink unavailable: ${error.code}`);
          throw error;
        }
        if (targetKind === 'json') refreshManifest(fixture.evidenceRoot, fixture.providers);
        assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /symlink|符号链接|realpath/i);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it('rejects manifest hash mismatch and output_file traversal', () => {
    const fixture = makeFixture({ toapis: true, usmercari: false });
    try {
      const manifestPath = path.join(fixture.evidenceRoot, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.evidence[TOAPIS_CONTRACT].sha256 = '0'.repeat(64);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /manifest|sha/i);

      refreshManifest(fixture.evidenceRoot, fixture.providers);
      editEvidence(fixture, TOAPIS_FILE, (evidence) => {
        evidence.results[0].artifact.output_file = '../outside.mp4';
      });
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /output_file|越界|basename/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects expired and future-generated evidence', () => {
    for (const field of ['expired', 'future']) {
      const fixture = makeFixture({ toapis: true, usmercari: false });
      try {
        editEvidence(fixture, TOAPIS_FILE, (evidence) => {
          if (field === 'expired') evidence.valid_until = new Date(Date.now() - 1_000).toISOString();
          else evidence.generated_at = new Date(Date.now() + 60_000).toISOString();
        });
        assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /expired|future|过期|未来|时间/i);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  for (const [name, mutate] of [
    ['generated more than 24 hours ago', (evidence) => {
      evidence.generated_at = new Date(Date.now() - 24 * 60 * 60 * 1_000 - 1_000).toISOString();
    }],
    ['a validity window longer than seven days', (evidence) => {
      evidence.valid_until = new Date(Date.parse(evidence.generated_at) + 7 * 24 * 60 * 60 * 1_000 + 1_000).toISOString();
    }],
  ]) it(`rejects ${name}`, () => {
    const fixture = makeFixture({ toapis: false, usmercari: true });
    try {
      editEvidence(fixture, USMERCARI_FILE, mutate);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /fresh|stale|24|window|7 days|age|有效期|陈旧/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describeRootEvidence('independent ToAPIs evidence audit', () => {
  const mutations = [
    ['eight exact cases', (e) => e.results.pop(), /8|case|组合/i],
    ['model binding', (e) => { e.results[0].request.model = 'seedance-2-mini'; }, /model|模型|fast-t2v-480/i],
    ['duration binding', (e) => { e.results[0].request.duration = 15; }, /duration|时长|fast-t2v-480/i],
    ['role exclusivity', (e) => { e.results.find((item) => item.mode === 'first-last').request.audio_with_roles = [{ role: 'reference_audio', url: 'https://assets.molimama.vip/a.mp3' }]; }, /role|参考|互斥/i],
    ['synchronous audio', (e) => { e.results.find((item) => item.id === 'mini-t2v-480').artifact.ffprobe.has_audio = false; }, /audio|音频/i],
    ['unique task', (e) => { e.results[1].provider_task_id = e.results[0].provider_task_id; }, /task|任务|重复|unique/i],
    ['continuous billing', (e) => { e.results[1].billing.before.used_balance = 999; }, /billing|账单|余额|连续/i],
    ['zero POST review', (e) => { e.cost_review.submitted_case_ids = ['fast-t2v-480']; }, /POST|复核/i],
    ['exact price', (e) => { e.pricing[0].cost_yuan_per_second = 0.1; }, /price|价格/i],
    ['exact credits', (e) => { e.pricing[0].credits_per_second = 510; }, /credit|积分|价格/i],
    ['molimama public URL', (e) => { e.results[0].artifact.public_url = 'https://example.com/out.mp4'; }, /molimama|public_url|公网/i],
    ['ffprobe band', (e) => { e.results[1].artifact.ffprobe.height = 496; e.results[1].artifact.ffprobe.width = 864; }, /ffprobe|720|尺寸/i],
    ['speed evidence summary', (e) => { e.speed_evidence.model_summary['seedance-2-fast'].sample_count = 3; }, /speed|速度|summary/i],
  ];

  for (const [name, mutate, expected] of mutations) it(`rejects ${name} drift`, () => {
    const fixture = makeFixture({ toapis: true, usmercari: false });
    try {
      editEvidence(fixture, TOAPIS_FILE, mutate);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), expected);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('recomputes output bytes and SHA-256 from the fixed asset', () => {
    const fixture = makeFixture({ toapis: true, usmercari: false });
    try {
      const outputFile = `${TOAPIS_CASES[0].id}.mp4`;
      const publicAsset = path.join(fixture.evidenceRoot, 'public', 'toapis', outputFile);
      fs.copyFileSync(publicAsset, path.join(fixture.evidenceRoot, outputFile));
      fs.appendFileSync(publicAsset, 'tampered');
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /sha|bytes|成品|asset/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  for (const outputFile of ['result.txt', 'result', 'result.mp4.json']) {
    it(`rejects non-MP4 ToAPIs output_file ${outputFile}`, () => {
      const fixture = makeFixture({ toapis: true, usmercari: false });
      try {
        const original = `${TOAPIS_CASES[0].id}.mp4`;
        fs.copyFileSync(
          path.join(fixture.evidenceRoot, 'public', 'toapis', original),
          path.join(fixture.evidenceRoot, 'public', 'toapis', outputFile),
        );
        editEvidence(fixture, TOAPIS_FILE, (evidence) => {
          evidence.results[0].artifact.output_file = outputFile;
          evidence.results[0].artifact.public_url = `https://molimama.vip/verification-assets/toapis/${outputFile}`;
        });
        assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /MP4|\.mp4|output_file/i);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }

  for (const suffix of ['?download=1', '#download']) {
    it(`rejects ToAPIs public_url suffix ${suffix}`, () => {
      const fixture = makeFixture({ toapis: true, usmercari: false });
      try {
        editEvidence(fixture, TOAPIS_FILE, (evidence) => {
          evidence.results[0].artifact.public_url += suffix;
        });
        assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /public_url|protected public asset|query|hash/i);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }

  it('rejects ToAPIs public_url basename that differs from output_file', () => {
    const fixture = makeFixture({ toapis: true, usmercari: false });
    try {
      editEvidence(fixture, TOAPIS_FILE, (evidence) => {
        evidence.results[0].artifact.public_url = evidence.results[1].artifact.public_url;
      });
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /public_url|protected public asset|output_file/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a non-canonical ToAPIs public_url whose dot segment normalizes inside the provider prefix', () => {
    const fixture = makeFixture({ toapis: true, usmercari: false });
    try {
      editEvidence(fixture, TOAPIS_FILE, (evidence) => {
        const outputFile = evidence.results[0].artifact.output_file;
        evidence.results[0].artifact.public_url = `https://molimama.vip/verification-assets/toapis/sub/../${outputFile}`;
      });
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /public_url|canonical|protected public asset|path/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describeRootEvidence('independent USMercari image evidence audit', () => {
  const mutations = [
    ['seven exact cases', (e) => e.results.pop(), /7|case|组合/i],
    ['GPT 4K success', (e) => { e.results[0].requested_resolution = '4k'; }, /GPT|4K|组合/i],
    ['GPT 4K rejection proof', (e) => { e.rejected_capabilities = []; }, /GPT|4K|拒绝/i],
    ['official provider', (e) => { e.provider_origin = 'https://example.com'; }, /official|官方|mercari/i],
    ['image size band', (e) => {
      const item = e.results.find((result) => result.requested_resolution === '2k');
      item.width = 1024;
      item.height = 1024;
    }, /2K|尺寸|band/i],
    ['unique output', (e) => {
      e.results[1].output_file = e.results[0].output_file;
      e.results[1].bytes = e.results[0].bytes;
      e.results[1].sha256 = e.results[0].sha256;
      e.results[1].public_url = e.results[0].public_url;
    }, /output|唯一|重复/i],
    ['empty provider model id', (e) => { e.results[0].provider_model_id = ''; }, /provider_model_id|provider model|模型 ID/i],
    ['inconsistent provider model id for one requested model', (e) => { e.results[1].provider_model_id = 'different-provider-id'; }, /provider_model_id|consistent|一致/i],
    ['provider model id reused across requested models', (e) => {
      const gptId = e.results.find((result) => result.model === 'gpt-image-2-2-4k').provider_model_id;
      for (const result of e.results.filter((item) => item.model === 'nano-banana-2')) result.provider_model_id = gptId;
    }, /provider_model_id|reused|复用/i],
    ['exact price', (e) => { e.pricing[0].cost_yuan_per_image = 0.081; }, /price|价格/i],
    ['exact credits', (e) => { e.pricing[0].credits_per_image = 69; }, /credit|积分|价格/i],
    ['molimama public URL', (e) => { e.results[0].public_url = 'https://example.com/out.png'; }, /molimama|public_url|公网/i],
  ];

  for (const [name, mutate, expected] of mutations) it(`rejects ${name} drift`, () => {
    const fixture = makeFixture({ toapis: false, usmercari: true });
    try {
      editEvidence(fixture, USMERCARI_FILE, mutate);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), expected);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('recomputes image output bytes and SHA-256 from the fixed asset', () => {
    const fixture = makeFixture({ toapis: false, usmercari: true });
    try {
      const evidence = JSON.parse(fs.readFileSync(path.join(fixture.evidenceRoot, USMERCARI_FILE), 'utf8'));
      const outputFile = evidence.results[0].output_file;
      const publicAsset = path.join(fixture.evidenceRoot, 'public', 'usmercari', outputFile);
      fs.copyFileSync(publicAsset, path.join(fixture.evidenceRoot, outputFile));
      fs.appendFileSync(publicAsset, 'tampered');
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /sha|bytes|成品|asset/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  for (const [name, bytes] of [
    ['HTML', Buffer.from('<!doctype html><html><body>upstream error</body></html>')],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"></svg>')],
    ['random bytes', crypto.randomBytes(64)],
    ['truncated JPEG', validJpeg(1024, 1024, 99).subarray(0, -2)],
  ]) it(`rejects ${name} bytes even when size and SHA declarations are updated`, () => {
    const fixture = makeFixture({ toapis: false, usmercari: true });
    try {
      const evidencePath = path.join(fixture.evidenceRoot, USMERCARI_FILE);
      const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
      const result = evidence.results[0];
      fs.writeFileSync(path.join(fixture.evidenceRoot, 'public', 'usmercari', result.output_file), bytes);
      result.bytes = bytes.length;
      result.sha256 = sha256(bytes);
      fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      refreshManifest(fixture.evidenceRoot, fixture.providers);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /decode|image|format|图片/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  for (const [name, corrupt] of [
    ['progressive frame marker', (bytes) => {
      const marker = bytes.indexOf(Buffer.from([0xff, 0xc0]));
      assert.ok(marker >= 0);
      bytes[marker + 1] = 0xc2;
    }],
    ['invalid entropy marker', (bytes) => {
      const scan = bytes.indexOf(Buffer.from([0xff, 0xda]));
      assert.ok(scan >= 0);
      const length = bytes.readUInt16BE(scan + 2);
      const entropy = scan + 2 + length;
      bytes[entropy] = 0xff;
      bytes[entropy + 1] = 0x01;
    }],
  ]) it(`rejects ${name} after recomputing the asset declarations`, () => {
    const fixture = makeFixture({ toapis: false, usmercari: true });
    try {
      const evidencePath = path.join(fixture.evidenceRoot, USMERCARI_FILE);
      const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
      const result = evidence.results[0];
      const assetPath = path.join(fixture.evidenceRoot, 'public', 'usmercari', result.output_file);
      const bytes = Buffer.from(fs.readFileSync(assetPath));
      corrupt(bytes);
      fs.writeFileSync(assetPath, bytes);
      result.bytes = bytes.length;
      result.sha256 = sha256(bytes);
      fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      refreshManifest(fixture.evidenceRoot, fixture.providers);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /baseline JPEG|decode|progressive|entropy|image/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  for (const [name, mutate] of [
    ['declared width', (result) => { result.width -= 1; }],
    ['declared height', (result) => { result.height -= 1; }],
    ['declared format', (result) => { result.format = 'png'; }],
    ['declared MIME', (result) => { result.content_type = 'image/png'; }],
  ]) it(`rejects ${name} drift from decoded image bytes`, () => {
    const fixture = makeFixture({ toapis: false, usmercari: true });
    try {
      editEvidence(fixture, USMERCARI_FILE, (evidence) => mutate(evidence.results[0]));
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /decode|dimension|width|height|format|MIME|content.type|extension|图片/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a JPEG asset published with a PNG extension', () => {
    const fixture = makeFixture({ toapis: false, usmercari: true });
    try {
      const evidencePath = path.join(fixture.evidenceRoot, USMERCARI_FILE);
      const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
      const result = evidence.results[0];
      const prior = path.join(fixture.evidenceRoot, 'public', 'usmercari', result.output_file);
      result.output_file = result.output_file.replace(/\.jpg$/, '.png');
      result.public_url = `https://molimama.vip/verification-assets/usmercari/${result.output_file}`;
      fs.renameSync(prior, path.join(fixture.evidenceRoot, 'public', 'usmercari', result.output_file));
      fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      refreshManifest(fixture.evidenceRoot, fixture.providers);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /extension|format|MIME|PNG|JPEG/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describeRootEvidence('candidate runtime and callout audit', () => {
  for (const [name, relative, replacement, expected] of [
    ['strict catalog verification gate', 'backend-node/src/services/canvasModelCatalogService.js', 'const STRICT_VERIFIED_PROTOCOLS = new Set([]);', /catalog|目录|runtime|gate/i],
    ['ToAPIs pre-side-effect gate', 'backend-node/src/services/videoService.js', 'function createVideo() { return reserveCredits(); }', /ToAPIs|runtime|gate/i],
    ['USMercari pre-side-effect gate', 'backend-node/src/services/imageService.js', 'function prepareImageRequest() { return reserveCredits(); }', /USMercari|runtime|gate/i],
    ['manifest-to-capability binding', 'backend-node/src/services/externalModelEvidenceService.js', 'function hasTrustedEvidenceBinding() { return true; }', /evidence|证据|binding/i],
    ['semantic credit callout', 'frontweb/src/components/dramaCanvas/HomeCanvasNode.vue', '<!-- canvas-credit-callout-v1 本次预计扣除 积分待管理员配置 -->', /callout|积分/i],
  ]) it(`rejects removal of ${name}`, () => {
    const fixture = makeFixture();
    try {
      write(fixture.candidate, relative, replacement);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), expected);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects GPT image 4K exposure in the real candidate client', () => {
    const fixture = makeFixture({ toapis: false, usmercari: true });
    try {
      const target = path.join(fixture.candidate, 'backend-node/src/services/usmercariImageClient.js');
      const source = fs.readFileSync(target, 'utf8').replace("['1k', '2k']", "['1k', '2k', '4k']");
      fs.writeFileSync(target, source);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /GPT|4K|client/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a configurable non-official USMercari image origin', () => {
    const fixture = makeFixture({ toapis: false, usmercari: true });
    try {
      const target = path.join(fixture.candidate, 'backend-node/src/services/usmercariImageClient.js');
      const source = fs.readFileSync(target, 'utf8').replace("parsed.hostname !== 'chat-ai.mercarimx.com'", 'false');
      fs.writeFileSync(target, source);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /official|官方|mercari/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects an official normalizer that is not used by the USMercari request path', () => {
    const fixture = makeFixture({ toapis: false, usmercari: true });
    try {
      const target = path.join(fixture.candidate, 'backend-node/src/services/usmercariImageClient.js');
      const source = fs.readFileSync(target, 'utf8')
        .replace('normalizeUsmercariImageBaseUrl(config?.base_url)', 'config?.base_url');
      fs.writeFileSync(target, source);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /official|normalizer|request path|mercari/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects ToAPIs gates moved behind a billing side effect while all audit tokens remain', () => {
    const fixture = makeFixture({ toapis: true, usmercari: false });
    try {
      const target = path.join(fixture.candidate, 'backend-node/src/services/videoService.js');
      const source = fs.readFileSync(target, 'utf8').replace(
        /function createVideo\(db, body\) \{[\s\S]*?\n    \}/,
        `function createVideo(db, body) {
      const reservation = reserveCredits(db, body);
      const state = toapisReadyState(db, body.model);
      requireVerifiedToapisReferenceCapabilities(state, body);
      requireToapisResolutionPrice(db, body.model, body.resolution);
      return reservation;
    }`
      );
      fs.writeFileSync(target, source);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /ToAPIs|side effect|billing|gate/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects ToAPIs runtime config reselection without the exact shared evidence binding', () => {
    const fixture = makeFixture({ toapis: true, usmercari: false });
    try {
      const target = path.join(fixture.candidate, 'backend-node/src/services/videoClient.js');
      const source = fs.readFileSync(target, 'utf8')
        .replace(' || !hasTrustedEvidenceBinding(preferredModel, capabilities)', '');
      fs.writeFileSync(target, source);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /ToAPIs|video config|evidence|binding/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects candidate-controlled test evidence root hooks', () => {
    const fixture = makeFixture();
    try {
      const target = path.join(fixture.candidate, 'backend-node/src/services/externalModelEvidenceService.js');
      fs.appendFileSync(target, `
        const IS_NODE_TEST = Boolean(process.env.NODE_TEST_CONTEXT);
        let testEvidenceRoots = null;
        function configureEvidenceRootsForTest(roots) { testEvidenceRoots = roots; }
        module.exports.configureEvidenceRootsForTest = configureEvidenceRootsForTest;
      `);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /test|hook|evidence root|证据根/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  for (const [name, replacement] of [
    ['removed', `if (protocol === 'usmercari_image') {
        return usmercariImageClient.callUsmercariImageApi(config, log, payload);
      }`],
    ['moved after provider submission', `if (protocol === 'usmercari_image') {
        const result = usmercariImageClient.callUsmercariImageApi(config, log, payload);
        assertUsmercariImageSubmitReady(db, config, payload.model, payload);
        return result;
      }`],
  ]) it(`rejects the USMercari imageClient final gate when ${name}`, () => {
    const fixture = makeFixture({ toapis: false, usmercari: true });
    try {
      const target = path.join(fixture.candidate, 'backend-node/src/services/imageClient.js');
      const source = fs.readFileSync(target, 'utf8').replace(
        /if \(protocol === 'usmercari_image'\) \{[\s\S]*?\n      \}/,
        replacement,
      );
      fs.writeFileSync(target, source);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /USMercari|imageClient|submit|gate|provider/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects USMercari capability and price gates moved behind billing while evidence binding remains early', () => {
    const fixture = makeFixture({ toapis: false, usmercari: true });
    try {
      const target = path.join(fixture.candidate, 'backend-node/src/services/imageService.js');
      const source = fs.readFileSync(target, 'utf8').replace(
        /function prepareImageRequest\(config, selectedModel, req, price\) \{[\s\S]*?\n    \}/,
        `function prepareImageRequest(config, selectedModel, req, price) {
      const strictUsmercari = config.provider === 'usmercari_image' || config.api_protocol === 'usmercari_image';
      if (strictUsmercari && (!config || config.verification_status !== 'verified')) throw imageRequestError('MODEL_NOT_VERIFIED');
      if (strictUsmercari && !resolveUsmercariApiKey(config)) throw imageRequestError('MODEL_CREDENTIAL_MISSING');
      const capabilities = config.verified_capabilities && config.verified_capabilities[selectedModel];
      if (strictUsmercari && !hasTrustedEvidenceBinding(selectedModel, capabilities)) throw imageRequestError('MODEL_NOT_VERIFIED');
      const reservation = reserveCredits(config, req);
      if (strictUsmercari && (!capabilities || capabilities.supportsTextToImage !== true)) throw imageRequestError('MODEL_NOT_VERIFIED');
      if (req.reference_images.length && capabilities.supportsImageReference !== true) throw imageRequestError('IMAGE_REFERENCE_NOT_VERIFIED');
      if (!price.resolution_prices[req.resolution]) throw imageRequestError('MODEL_RESOLUTION_PRICE_REQUIRED');
      return reservation;
    }`
      );
      fs.writeFileSync(target, source);
      assertFail(runGuard(fixture.candidate, fixture.evidenceRoot), /USMercari|side effect|billing|gate/i);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
