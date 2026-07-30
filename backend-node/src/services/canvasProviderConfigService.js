'use strict';

const DEFINITIONS = {
  text: {
    key: 'CANVAS_TEXT',
    defaultBaseUrl: 'https://rehdasu.cn/v1',
    defaultModel: 'gpt-5.6-sol',
    provider: 'canvas_responses',
    apiProtocol: 'responses',
    endpoint: '/responses',
    capabilities: {},
  },
  image: {
    key: 'CANVAS_IMAGE',
    defaultBaseUrl: 'https://aihubcc.cc/v1',
    defaultModel: 'gpt-image-2-2k',
    provider: 'aihubcc',
    apiProtocol: 'aihubcc',
    endpoint: '/chat/completions',
    capabilities: {
      aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
      resolutions: ['2K'],
      maxReferences: 6,
      quantities: [1, 2, 3, 4],
    },
  },
  video: {
    key: 'CANVAS_VIDEO',
    defaultBaseUrl: 'https://seed.alimyun.xyz/api/open/v1',
    defaultModel: 'lingjing-video-v1',
    provider: 'aihubcc_video',
    apiProtocol: 'aihubcc',
    endpoint: '/videos',
    queryEndpoint: '/videos/{taskId}',
    capabilities: {
      aspectRatios: ['16:9', '9:16', '1:1', '21:9'],
      durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      resolutions: [],
      maxReferences: 12,
      quantities: [1],
      supportsFirstFrame: true,
      supportsLastFrame: false,
      supportsAudio: false,
    },
  },
};

function getConfig(kind, preferredModel, env = process.env) {
  const definition = DEFINITIONS[kind];
  if (!definition) return null;
  const apiKey = String(env[`${definition.key}_API_KEY`] || '').trim();
  if (!apiKey) return null;
  const model = String(env[`${definition.key}_MODEL`] || definition.defaultModel).trim();
  if (preferredModel && String(preferredModel).trim() !== model) return null;
  return {
    service_type: kind,
    provider: definition.provider,
    api_protocol: definition.apiProtocol,
    base_url: String(env[`${definition.key}_BASE_URL`] || definition.defaultBaseUrl).trim().replace(/\/+$/, ''),
    api_key: apiKey,
    endpoint: definition.endpoint,
    ...(definition.queryEndpoint ? { query_endpoint: definition.queryEndpoint } : {}),
    model: [model],
    default_model: model,
    is_active: true,
    is_default: false,
    settings: definition.capabilities && Object.keys(definition.capabilities).length
      ? { canvas_capabilities: definition.capabilities }
      : {},
  };
}

function listSafe(env = process.env) {
  return Object.keys(DEFINITIONS)
    .map((kind) => {
      const config = getConfig(kind, null, env);
      if (!config) return null;
      return {
        kind,
        model: config.default_model,
        label: config.default_model,
        credits: null,
        capabilities: config.settings.canvas_capabilities || {},
      };
    })
    .filter(Boolean);
}

module.exports = { getConfig, listSafe };
