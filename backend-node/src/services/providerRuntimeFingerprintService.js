'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CANARY_RUNTIME_FILES = Object.freeze([
  'src/middleware/resourceOwnership.js',
  'src/services/providerAssetUrlService.js',
  'src/services/providerCanaryArtifactService.js',
  'src/services/providerCanaryFixtureService.js',
  'src/services/userAuthService.js',
  'src/utils/ffmpegPath.js',
]);

const COMMON_FILES = Object.freeze({
  text: ['src/services/aiClient.js', ...CANARY_RUNTIME_FILES, 'src/services/providerErrorClassifier.js'],
  image: ['src/services/imageClient.js', ...CANARY_RUNTIME_FILES, 'src/services/providerErrorClassifier.js'],
  video: ['src/services/videoClient.js', ...CANARY_RUNTIME_FILES, 'src/services/providerErrorClassifier.js'],
  tts: [
    'src/services/ttsConfigSelectionService.js',
    'src/services/ttsService.js',
    ...CANARY_RUNTIME_FILES,
    'src/services/providerErrorClassifier.js',
  ],
});

const PROTOCOL_ADAPTERS = Object.freeze({
  text: Object.freeze({
    openai: [],
    responses: [],
  }),
  image: Object.freeze({
    openai: [],
    aihubcc: ['src/services/aihubccClient.js'],
    agnes: [],
    dashscope: [],
    gemini: [],
    kling: ['src/services/klingJwt.js'],
    nano_banana: [],
    token6688: ['src/services/token6688Client.js'],
    usmercari_image: ['src/services/usmercariVideoClient.js'],
    volcengine: [],
  }),
  video: Object.freeze({
    openai: [],
    agnes: [],
    aihubcc: ['src/services/aihubccClient.js'],
    dashscope: [],
    deepwl_grok: [],
    djpsd: [],
    feituo_open: ['src/services/feituoVideoClient.js'],
    fumin_video: ['src/services/fuminVideoClient.js'],
    gemini: [],
    icreat_task: [],
    jimeng_ai_api: [],
    kling: ['src/services/klingJwt.js'],
    kling_omni: ['src/services/klingJwt.js'],
    sora: [],
    toapis_video: [
      'src/services/providerAssetUrlService.js',
      'src/services/toapisVideoClient.js',
    ],
    toapis_wan3_video: ['src/services/toapisWan3VideoClient.js'],
    usmercari_media: ['src/services/usmercariVideoClient.js'],
    veo3: [],
    vidu: [],
    volcengine: [],
    volcengine_omni: [],
    xai: [],
  }),
  tts: Object.freeze({
    minimax: [],
    openai: [],
  }),
});

const PROVIDER_PROTOCOLS = Object.freeze({
  text: Object.freeze({}),
  image: Object.freeze({
    aihubcc: 'aihubcc',
    aihubcc_image: 'aihubcc',
    agnes: 'agnes',
    dashscope: 'dashscope',
    fumin_image: 'openai',
    gemini: 'gemini',
    google: 'gemini',
    kling: 'kling',
    klingai: 'kling',
    nano_banana: 'nano_banana',
    qwen_image: 'dashscope',
    volc: 'volcengine',
    volces: 'volcengine',
    volcengine: 'volcengine',
  }),
  video: Object.freeze({
    agnes: 'agnes',
    aihubcc: 'aihubcc',
    aihubcc_video: 'aihubcc',
    dashscope: 'dashscope',
    deepwl: 'deepwl_grok',
    'deepwl-grok': 'deepwl_grok',
    deepwl_grok: 'deepwl_grok',
    djpsd: 'djpsd',
    feituo: 'feituo_open',
    feituo_open: 'feituo_open',
    ffir: 'kling_omni',
    fumin: 'fumin_video',
    fumin_video: 'fumin_video',
    gemini: 'gemini',
    google: 'gemini',
    grok: 'xai',
    icreat: 'icreat_task',
    'icreat-seedance': 'icreat_task',
    icreat_ai: 'icreat_task',
    jimeng_ai_api: 'jimeng_ai_api',
    kling: 'kling',
    klingai: 'kling',
    toapis: 'toapis_video',
    toapis_video: 'toapis_video',
    toapis_wan3_video: 'toapis_wan3_video',
    usmercari: 'usmercari_media',
    usmercari_media: 'usmercari_media',
    vidu: 'vidu',
    volc: 'volcengine',
    volces: 'volcengine',
    volcengine: 'volcengine',
    xai: 'xai',
  }),
  tts: Object.freeze({
    minimax: 'minimax',
    openai: 'openai',
  }),
});

const PROVIDER_EXTRA_FILES = Object.freeze({
  image: Object.freeze({
    fumin_image: ['src/services/fuminImageClient.js'],
  }),
  video: Object.freeze({}),
  text: Object.freeze({}),
  tts: Object.freeze({}),
});

const VIDEO_FORCED_PROVIDER_PROTOCOLS = new Set([
  'aihubcc', 'aihubcc_video',
  'deepwl', 'deepwl-grok', 'deepwl_grok',
  'feituo', 'feituo_open',
  'fumin', 'fumin_video',
  'icreat', 'icreat-seedance', 'icreat_ai',
  'toapis', 'toapis_video', 'toapis_wan3_video',
  'usmercari', 'usmercari_media',
]);

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveProtocol(config, serviceType) {
  const provider = normalizeName(config.provider);
  const explicit = normalizeName(config.api_protocol ?? config.apiProtocol ?? config.protocol);
  if (serviceType === 'video' && explicit === 'toapis_wan3_video') return explicit;
  if (serviceType === 'video' && VIDEO_FORCED_PROVIDER_PROTOCOLS.has(provider)) {
    return PROVIDER_PROTOCOLS.video[provider];
  }
  if (explicit) return explicit;
  if (PROVIDER_PROTOCOLS[serviceType]?.[provider]) return PROVIDER_PROTOCOLS[serviceType][provider];
  if (serviceType === 'text') {
    const endpoint = normalizeName(config.endpoint ?? config.base_url ?? config.baseUrl);
    if (/\/responses(?:\?|$)/.test(endpoint)) return 'responses';
  }
  if (serviceType === 'image') {
    const model = normalizeName(config.default_model ?? config.model);
    if (/seedream|doubao/.test(model)) return 'volcengine';
    if (/^kling-/.test(model)) return 'kling';
    if (/agnes-image|apihub\.agnes-ai\.com/.test(model)) return 'agnes';
  }
  if (serviceType === 'video') {
    const baseUrl = normalizeName(config.base_url ?? config.baseUrl);
    const model = normalizeName(config.default_model ?? config.model);
    if (/api\.x\.ai(\/|$)/.test(baseUrl) || /grok-imagine|grok.*video/.test(model)) return 'xai';
    if (provider === 'agnes' || /agnes-video|apihub\.agnes-ai\.com/.test(baseUrl)) return 'agnes';
  }
  return 'openai';
}

function missingMapping(serviceType, protocol) {
  return {
    ok: false,
    code: 'missing_runtime_mapping',
    serviceType,
    protocol,
    fingerprint: null,
    files: [],
  };
}

function resolveRuntimeFiles(config, options = {}) {
  if (!config || typeof config !== 'object') {
    return missingMapping('', '');
  }
  const serviceType = normalizeName(config.service_type ?? config.serviceType);
  const protocol = resolveProtocol(config, serviceType);
  const common = COMMON_FILES[serviceType];
  const adapters = PROTOCOL_ADAPTERS[serviceType]?.[protocol];
  if (!common || !adapters) return missingMapping(serviceType, protocol);
  const provider = normalizeName(config.provider);
  const files = [...new Set([
    ...common,
    ...adapters,
    ...(PROVIDER_EXTRA_FILES[serviceType]?.[provider] || []),
  ])].sort();
  const repoRoot = path.resolve(options.repoRoot || path.resolve(__dirname, '..', '..'));
  const missingFiles = files.filter((relativePath) => {
    const absolutePath = path.resolve(repoRoot, ...relativePath.split('/'));
    const relative = path.relative(repoRoot, absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return true;
    try { return !fs.statSync(absolutePath).isFile(); } catch (_) { return true; }
  });
  if (missingFiles.length > 0) {
    return {
      ok: false,
      code: 'missing_runtime_file',
      serviceType,
      protocol,
      fingerprint: null,
      files,
      missingFiles,
    };
  }
  return { ok: true, serviceType, protocol, files };
}

function runtimeFingerprintForConfig(config, options = {}) {
  const resolved = resolveRuntimeFiles(config, options);
  if (!resolved.ok) return resolved;
  const repoRoot = path.resolve(options.repoRoot || path.resolve(__dirname, '..', '..'));
  const fileHashes = resolved.files.map((relativePath) => ({
    path: relativePath,
    sha256: crypto.createHash('sha256')
      .update(fs.readFileSync(path.resolve(repoRoot, ...relativePath.split('/'))))
      .digest('hex'),
  }));
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    serviceType: resolved.serviceType,
    protocol: resolved.protocol,
    files: fileHashes,
  })).digest('hex');
  return { ...resolved, fingerprint };
}

function buildRuntimeFingerprints(configs, options = {}) {
  if (!Array.isArray(configs)) throw new TypeError('configs must be an array');
  const result = {};
  configs.forEach((config, index) => {
    const key = config?.id == null ? String(index) : String(config.id);
    result[key] = runtimeFingerprintForConfig(config, options);
  });
  return result;
}

module.exports = {
  COMMON_FILES,
  PROTOCOL_ADAPTERS,
  buildRuntimeFingerprints,
  resolveRuntimeFiles,
  runtimeFingerprintForConfig,
};
